import { ansi, padTo, takeLastColumns, truncate, visibleLength, wrapAnsi } from './ansi';
import { FeedEntry, Glyph, MigrationState, Phase } from './state';
import { RecordsViewState, renderRecords } from './records-view';
import { VERSION } from '../../version';

/**
 * What the body shows. `main` is the overlay - the question being asked, or the
 * final summary - or, with neither up, the live activity feed. `feed` is the
 * activity feed scrolled by hand under an overlay, and `records` the browser of
 * the records the run retrieved.
 */
export type BodyView = 'main' | 'feed' | 'records';

/**
 * The view Tab goes to next. Records come straight after the main view, so one
 * press always reaches them; the activity log only has a place in the round
 * when an overlay is covering it.
 */
export function nextView(view: BodyView, hasOverlay: boolean, hasRecords: boolean): BodyView {
    const order: BodyView[] = ['main'];
    if (hasRecords) order.push('records');
    if (hasOverlay) order.push('feed');
    return order[(order.indexOf(view) + 1) % order.length];
}

function viewName(view: BodyView, hasOverlay: boolean, promptActive: boolean): string {
    if (view === 'records') return 'records';
    if (view === 'main' && hasOverlay) return promptActive ? 'question' : 'summary';
    return 'activity log';
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Box-drawing characters
const B = {
    tl: '┌', tr: '┐', bl: '└', br: '┘',
    h: '─', v: '│', lt: '├', rt: '┤',
};

const TITLE = ` migr_ts v${VERSION} `;

const PHASE_COLOR: Record<Phase, (s: string) => string> = {
    Starting: ansi.cyan,
    Describing: ansi.cyan,
    Matching: ansi.cyan,
    Fetching: ansi.cyan,
    Confirm: ansi.yellow,
    Resolving: ansi.magenta,
    Saving: ansi.blue,
    Updating: ansi.blue,
    Apex: ansi.magenta,
    Complete: ansi.green,
    Aborted: ansi.red,
};

function glyphStr(glyph: Glyph, spinnerFrame: number, done: boolean): string {
    switch (glyph) {
        case 'run': return done ? ansi.gray('●') : ansi.cyan(SPINNER[spinnerFrame % SPINNER.length]);
        case 'ok': return ansi.green('✓');
        case 'err': return ansi.red('✗');
        case 'warn': return ansi.yellow('⚠');
        case 'info': return ansi.blue('●');
        case 'sub': return ansi.gray('⎿');
    }
}

/**
 * Build the complete screen as an array of exactly `height` lines, each exactly
 * `width` visible columns wide. Pure: no I/O, fully testable.
 */
/** Number of body (feed/overlay) rows for a given terminal height. */
export function bodyHeightFor(height: number): number {
    // top(1) + header(3) + sep(1) + sep(1) + input(1) + bottom(1) = 8 fixed rows.
    return Math.max(1, Math.max(10, height) - 8);
}

/** Usable text width inside the box borders. */
export function innerWidth(width: number): number {
    return Math.max(24, width) - 4;
}

/** Largest valid overlay scroll offset (0 when everything fits). */
export function maxScrollOffset(overlay: string[] | null, width: number, height: number): number {
    if (!overlay) return 0;
    const total = wrapToWidth(overlay, innerWidth(width)).length;
    return Math.max(0, total - bodyHeightFor(height));
}

/**
 * Largest valid scroll offset for the activity feed viewed under a prompt.
 * Counts *rendered* lines, since a long entry wraps onto several of them.
 */
export function maxFeedScrollOffset(feed: FeedEntry[], width: number, height: number): number {
    const total = renderFeed(feed, 0, true, innerWidth(width)).length;
    return Math.max(0, total - bodyHeightFor(height));
}

export function buildFrame(
    state: MigrationState,
    spinnerFrame: number,
    width: number,
    height: number,
    promptActive: boolean,
    awaitingExit = false,
    inputBuffer = '',
    scrollOffset = 0,
    view: BodyView = 'main',
    recordsView: RecordsViewState | null = null,
): string[] {
    const w = Math.max(24, width);
    const h = Math.max(10, height);
    const inner = w - 4; // space between "│ " and " │"
    const lines: string[] = [];

    const border = (left: string, right: string) =>
        left + B.h.repeat(w - 2) + right;

    const row = (content: string) =>
        `${B.v} ${padTo(content, inner)} ${B.v}`;

    // ── Top border with title ──────────────────────────────────────────────
    // The title carries the version, so on a narrow terminal it has to give way
    // rather than push the top border past the frame's width.
    const titleBar = B.h + ansi.boldOn(ansi.cyan(truncate(TITLE, w - 4))) + B.h;
    const titleFill = w - 2 - visibleLength(titleBar);
    lines.push(B.tl + titleBar + B.h.repeat(Math.max(0, titleFill)) + B.tr);

    // ── Header: source/target ──────────────────────────────────────────────
    // The header is a fixed single row, so long org URLs are shortened — but
    // each side gets its own budget so the target never vanishes off the edge.
    const labelsWidth = 'Source '.length + '   Target '.length;
    const half = Math.max(3, Math.floor((inner - labelsWidth) / 2));
    lines.push(row(
        `${ansi.gray('Source')} ${truncate(state.source, half)}` +
        `   ${ansi.gray('Target')} ${truncate(state.target, half)}`,
    ));

    // ── Header: phase + progress bar ────────────────────────────────────────
    const phaseLabel = PHASE_COLOR[state.phase](state.phase.padEnd(10));
    const phaseGlyph = state.done
        ? (state.phase === 'Aborted' ? ansi.red('✗') : ansi.green('✓'))
        : ansi.cyan(SPINNER[spinnerFrame % SPINNER.length]);
    const pct = progressPct(state);
    const bar = progressBar(pct, Math.min(20, Math.max(8, inner - 28)));
    lines.push(row(`${phaseGlyph} ${phaseLabel} ${bar} ${String(pct).padStart(3)}%`));

    // ── Header: counters (while fetching, the records per fetch level) ──────
    lines.push(row(state.fetchLevels ? levelLine(state, inner) : counterLine(state, inner)));

    // ── Separator ───────────────────────────────────────────────────────────
    lines.push(border(B.lt, B.rt));

    // ── Body: overlay (prompt/summary) or activity feed ─────────────────────
    const bodyHeight = bodyHeightFor(h);
    const hasRecords = state.retrieved !== null && recordsView !== null;
    const showRecords = view === 'records' && hasRecords;
    let visible: string[];
    let overflow = false;
    let winStart = 0;
    let total = 0;
    if (showRecords) {
        // The records view scrolls itself, keeping its selection in sight.
        visible = renderRecords(state.retrieved!, recordsView!, inner, bodyHeight);
    } else if (state.overlay) {
        // While prompting, the body is a scrollable window: the question overlay,
        // or — when toggled with Tab — the activity feed, so earlier output
        // stays reachable while answering.
        const bodyLines = view === 'feed'
            ? renderFeed(state.feed, spinnerFrame, state.done, inner)
            : wrapToWidth(state.overlay, inner);
        total = bodyLines.length;
        overflow = total > bodyHeight;
        const maxOffset = Math.max(0, total - bodyHeight);
        winStart = Math.max(0, Math.min(scrollOffset, maxOffset));
        visible = bodyLines.slice(winStart, winStart + bodyHeight);
    } else {
        // The activity feed auto-follows: always show the latest lines.
        visible = renderFeedTail(state.feed, spinnerFrame, state.done, inner, bodyHeight);
    }
    for (let i = 0; i < bodyHeight; i++) {
        lines.push(row(visible[i] ?? ''));
    }

    // ── Separator (scroll indicator and the view Tab goes to) ───────────────
    const hints: string[] = [];
    if (overflow) {
        const first = winStart + 1;
        const last = Math.min(winStart + bodyHeight, total);
        hints.push(`↑↓ scroll · ${first}–${last} of ${total}`);
    }
    const shownView: BodyView = showRecords ? 'records' : view === 'feed' && state.overlay ? 'feed' : 'main';
    const next = nextView(shownView, state.overlay !== null, hasRecords);
    if (next !== shownView) {
        hints.push(`Tab: ${viewName(next, state.overlay !== null, promptActive)}`);
    }
    if (shownView !== 'main') {
        hints.push(`Esc: ${viewName('main', state.overlay !== null, promptActive)}`);
    }
    if (hints.length > 0) {
        const indicator = ` ${ansi.gray(hints.join(' · '))} `;
        const fill = w - 2 - visibleLength(indicator);
        lines.push(B.lt + indicator + B.h.repeat(Math.max(0, fill)) + B.rt);
    } else {
        lines.push(border(B.lt, B.rt));
    }

    // ── Input line ──────────────────────────────────────────────────────────
    if (promptActive) {
        lines.push(row(`${ansi.green('>')} ${inputView(inputBuffer, inner)}`));
    } else {
        const hint = awaitingExit && shownView === 'records'
            // Every key the records view gets is its own, so none of them exits.
            ? ansi.gray('Esc to go back, then any key to exit')
            : awaitingExit
            // Arrows and Tab move around the summary, so they cannot also exit.
            ? ansi.boldOn(ansi.green(`Press any key to exit…${overflow ? ' (↑↓ to scroll)' : ''}`))
            : state.done
                ? ansi.gray('Done.')
                : ansi.gray(`${SPINNER[spinnerFrame % SPINNER.length]} working…`);
        lines.push(row(hint));
    }

    // ── Bottom border ───────────────────────────────────────────────────────
    lines.push(border(B.bl, B.br));

    return lines.slice(0, h);
}

/**
 * The counters row. Every record ends up in exactly one of Records (inserted),
 * Matched (already in the target), Skipped or - while it is still queued -
 * Remaining; a record that failed outright is in none of them, which is what
 * Errors reports. On a narrow terminal the outcome counters that are still zero
 * are dropped, left to right, rather than letting Remaining fall off the edge.
 */
function counterLine(state: MigrationState, inner: number): string {
    const records = `${ansi.gray('Records')} ${ansi.boldOn(String(state.created))}${ansi.gray(`/${state.total}`)}`;
    const remaining = `${ansi.gray('Remaining')} ${state.remaining}`;
    let optional = [
        { count: state.matched, text: `${ansi.gray('Matched')} ${state.matched}` },
        { count: state.errors, text: `${ansi.gray('Errors')} ${state.errors > 0 ? ansi.red(String(state.errors)) : '0'}` },
        { count: state.skipped, text: `${ansi.gray('Skipped')} ${state.skipped}` },
    ];
    const join = () => [records, ...optional.map(c => c.text), remaining].join('   ');

    let line = join();
    while (visibleLength(line) > inner && optional.some(c => c.count === 0)) {
        const drop = optional.findIndex(c => c.count === 0);
        optional = optional.filter((_, i) => i !== drop);
        line = join();
    }
    return line;
}

/**
 * The counters row while fetching runs, when every outcome counter is still zero:
 * how many records each fetch level has brought in, up to the level being fetched
 * now - which shows from the moment its wave starts, before it has any records.
 * On a narrow terminal the depth limit goes first, then the shallowest levels.
 */
function levelLine(state: MigrationState, inner: number): string {
    const { current, counts } = state.fetchLevels!;
    const fetched = `${ansi.gray('Fetched')} ${ansi.boldOn(String(state.total))}`;
    let levels: string[] = [];
    for (let depth = 1; depth <= current; depth++) {
        const count = String(counts[depth] ?? 0);
        levels.push(`${ansi.gray(`L${depth}`)} ${depth === current ? ansi.boldOn(count) : count}`);
    }
    let limit = state.depthLimit ? ansi.gray(`limit ${state.depthLimit}`) : '';
    let elided = false;
    const join = () => [
        fetched,
        (elided ? ansi.gray('… ') : '') + levels.join(ansi.gray(' · ')),
        limit,
    ].filter(Boolean).join('   ');

    let line = join();
    while (visibleLength(line) > inner && (limit || levels.length > 1)) {
        if (limit) {
            limit = '';
        } else {
            levels = levels.slice(1);
            elided = true;
        }
        line = join();
    }
    return line;
}

/**
 * Render the feed to display lines. Entries wider than the box wrap onto
 * continuation lines that hang under the first line's text, so long error
 * messages stay fully readable instead of running off the right edge.
 */
export function renderFeed(feed: FeedEntry[], spinnerFrame: number, done: boolean, inner: number): string[] {
    const out: string[] = [];
    for (const e of feed) out.push(...renderEntry(e, spinnerFrame, done, inner));
    return out;
}

/**
 * The last `count` lines renderFeed would produce, rendering only the entries
 * that reach them. The feed is repainted on every frame and holds up to
 * FEED_CAP entries, of which only the last screenful is ever shown.
 */
export function renderFeedTail(feed: FeedEntry[], spinnerFrame: number, done: boolean, inner: number, count: number): string[] {
    const blocks: string[][] = [];
    let lines = 0;
    for (let i = feed.length - 1; i >= 0 && lines < count; i--) {
        const block = renderEntry(feed[i], spinnerFrame, done, inner);
        blocks.push(block);
        lines += block.length;
    }
    return blocks.reverse().flat().slice(-count);
}

function renderEntry(e: FeedEntry, spinnerFrame: number, done: boolean, inner: number): string[] {
    const indent = '  '.repeat(e.indent);
    const g = glyphStr(e.glyph, spinnerFrame, done);
    const repeats = e.count && e.count > 1 ? ansi.gray(` ×${e.count}`) : '';
    const text = (e.glyph === 'sub' || e.glyph === 'info' ? ansi.gray(e.text) : e.text) + repeats;
    const head = `${indent}${g} `;            // glyph is always one column
    const hang = ' '.repeat(indent.length + 2);
    const textWidth = Math.max(1, inner - visibleLength(head));
    const wrapped = wrapAnsi(text, textWidth);
    return [head + wrapped[0], ...wrapped.slice(1).map(line => hang + line)];
}

/** Wrap lines wider than `inner` so nothing is silently cut horizontally. */
export function wrapToWidth(lines: string[], inner: number): string[] {
    const out: string[] = [];
    for (const raw of lines) out.push(...wrapAnsi(raw, inner));
    return out;
}

/** Reserve room after the "> " prompt for the live input. */
function inputCapacity(inner: number): number {
    return Math.max(1, inner - 2);
}

/** The portion of the input buffer that fits, scrolled horizontally to the end. */
function inputView(buffer: string, inner: number): string {
    return takeLastColumns(buffer, inputCapacity(inner));
}

/** 1-based screen column where the input cursor should sit (just past the text). */
export function inputCursorCol(buffer: string, width: number): number {
    const inner = innerWidth(width);
    const shown = visibleLength(inputView(buffer, inner));
    // "│ " (2) + "> " (2) + shown columns, then cursor sits on the next column.
    return 2 + 2 + shown + 1;
}

function progressPct(state: MigrationState): number {
    if (state.done) return state.phase === 'Aborted' ? progressFromCounts(state) : 100;
    return progressFromCounts(state);
}

function progressFromCounts(state: MigrationState): number {
    if (state.total <= 0) return 0;
    // Records matched to an existing target record are done too, so they have to
    // count here - otherwise a run against a well-populated target never fills.
    const settled = Math.min(state.total, state.created + state.matched + state.skipped);
    return Math.max(0, Math.min(100, Math.round((settled / state.total) * 100)));
}

function progressBar(pct: number, len: number): string {
    const filled = Math.round((pct / 100) * len);
    return ansi.cyan('█'.repeat(filled)) + ansi.gray('░'.repeat(Math.max(0, len - filled)));
}
