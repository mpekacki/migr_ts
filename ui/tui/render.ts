import { ansi, padTo, takeLastColumns, truncate, visibleLength, wrapAnsi } from './ansi';
import { FeedEntry, Glyph, MigrationState, Phase } from './state';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Box-drawing characters
const B = {
    tl: '┌', tr: '┐', bl: '└', br: '┘',
    h: '─', v: '│', lt: '├', rt: '┤',
};

const TITLE = ' migr_ts ';

const PHASE_COLOR: Record<Phase, (s: string) => string> = {
    Starting: ansi.cyan,
    Describing: ansi.cyan,
    Matching: ansi.cyan,
    Fetching: ansi.cyan,
    Confirm: ansi.yellow,
    Resolving: ansi.magenta,
    Saving: ansi.blue,
    Updating: ansi.blue,
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
    feedView = false,
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
    const titleBar = B.h + ansi.boldOn(ansi.cyan(TITLE)) + B.h;
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

    // ── Header: counters ────────────────────────────────────────────────────
    const counters = [
        `${ansi.gray('Records')} ${ansi.boldOn(String(state.created))}${ansi.gray(`/${state.total}`)}`,
        `${ansi.gray('Errors')} ${state.errors > 0 ? ansi.red(String(state.errors)) : '0'}`,
        `${ansi.gray('Skipped')} ${state.skipped}`,
        `${ansi.gray('Remaining')} ${state.remaining}`,
    ].join('   ');
    lines.push(row(counters));

    // ── Separator ───────────────────────────────────────────────────────────
    lines.push(border(B.lt, B.rt));

    // ── Body: overlay (prompt/summary) or activity feed ─────────────────────
    const bodyHeight = bodyHeightFor(h);
    let visible: string[];
    let overflow = false;
    let winStart = 0;
    let total = 0;
    if (state.overlay) {
        // While prompting, the body is a scrollable window: the question overlay,
        // or — when toggled with Tab — the activity feed, so earlier output
        // stays reachable while answering.
        const bodyLines = feedView
            ? renderFeed(state.feed, spinnerFrame, state.done, inner)
            : wrapToWidth(state.overlay, inner);
        total = bodyLines.length;
        overflow = total > bodyHeight;
        const maxOffset = Math.max(0, total - bodyHeight);
        winStart = Math.max(0, Math.min(scrollOffset, maxOffset));
        visible = bodyLines.slice(winStart, winStart + bodyHeight);
    } else {
        // The activity feed auto-follows: always show the latest lines.
        const bodyLines = renderFeed(state.feed, spinnerFrame, state.done, inner);
        visible = bodyLines.slice(-bodyHeight);
    }
    for (let i = 0; i < bodyHeight; i++) {
        lines.push(row(visible[i] ?? ''));
    }

    // ── Separator (scroll indicator and, while prompting, the view toggle) ──
    const hints: string[] = [];
    if (overflow) {
        const first = winStart + 1;
        const last = Math.min(winStart + bodyHeight, total);
        hints.push(`↑↓ scroll · ${first}–${last} of ${total}`);
    }
    if (state.overlay) {
        hints.push(feedView ? 'Tab: question' : 'Tab: activity log');
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
        const hint = awaitingExit
            ? ansi.boldOn(ansi.green('Press any key to exit…'))
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
 * Render the feed to display lines. Entries wider than the box wrap onto
 * continuation lines that hang under the first line's text, so long error
 * messages stay fully readable instead of running off the right edge.
 */
function renderFeed(feed: FeedEntry[], spinnerFrame: number, done: boolean, inner: number): string[] {
    const out: string[] = [];
    for (const e of feed) {
        const indent = '  '.repeat(e.indent);
        const g = glyphStr(e.glyph, spinnerFrame, done);
        const text = e.glyph === 'sub' || e.glyph === 'info' ? ansi.gray(e.text) : e.text;
        const head = `${indent}${g} `;            // glyph is always one column
        const hang = ' '.repeat(indent.length + 2);
        const textWidth = Math.max(1, inner - visibleLength(head));
        const wrapped = wrapAnsi(text, textWidth);
        out.push(head + wrapped[0]);
        for (let i = 1; i < wrapped.length; i++) out.push(hang + wrapped[i]);
    }
    return out;
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
    const settled = Math.min(state.total, state.created + state.skipped);
    return Math.max(0, Math.min(100, Math.round((settled / state.total) * 100)));
}

function progressBar(pct: number, len: number): string {
    const filled = Math.round((pct / 100) * len);
    return ansi.cyan('█'.repeat(filled)) + ansi.gray('░'.repeat(Math.max(0, len - filled)));
}
