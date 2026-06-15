import { ansi, padTo, visibleLength } from './ansi';
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

export function buildFrame(
    state: MigrationState,
    spinnerFrame: number,
    width: number,
    height: number,
    promptActive: boolean,
    awaitingExit = false,
    inputBuffer = '',
    scrollOffset = 0,
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
    lines.push(row(`${ansi.gray('Source')} ${state.source}   ${ansi.gray('Target')} ${state.target}`));

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
        `${ansi.gray('Records')} ${ansi.boldOn(String(state.created))}`,
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
        // Overlays (prompts/summaries) are scrolled: show a window into the
        // wrapped content so nothing is lost off the top.
        const bodyLines = wrapToWidth(state.overlay, inner);
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

    // ── Separator (carries the scroll indicator when the overlay overflows) ──
    if (overflow) {
        const first = winStart + 1;
        const last = Math.min(winStart + bodyHeight, total);
        const indicator = ` ${ansi.gray(`↑↓ scroll · ${first}–${last} of ${total}`)} `;
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

function renderFeed(feed: FeedEntry[], spinnerFrame: number, done: boolean, inner: number): string[] {
    return feed.map(e => {
        const indent = '  '.repeat(e.indent);
        const g = glyphStr(e.glyph, spinnerFrame, done);
        const text = e.glyph === 'sub' || e.glyph === 'info' ? ansi.gray(e.text) : e.text;
        // truncate happens later in padTo via row(); just assemble here
        void inner;
        return `${indent}${g} ${text}`;
    });
}

/** Wrap lines wider than `inner` so nothing is silently cut horizontally. */
export function wrapToWidth(lines: string[], inner: number): string[] {
    const out: string[] = [];
    for (const raw of lines) {
        if (visibleLength(raw) <= inner) {
            out.push(raw);
        } else {
            let rest = raw;
            while (visibleLength(rest) > inner) {
                out.push(rest.slice(0, inner));
                rest = rest.slice(inner);
            }
            out.push(rest);
        }
    }
    return out;
}

/** Reserve room after the "> " prompt for the live input. */
function inputCapacity(inner: number): number {
    return Math.max(1, inner - 2);
}

/** The portion of the input buffer that fits, scrolled horizontally to the end. */
function inputView(buffer: string, inner: number): string {
    const cap = inputCapacity(inner);
    return buffer.length <= cap ? buffer : buffer.slice(buffer.length - cap);
}

/** 1-based screen column where the input cursor should sit (just past the text). */
export function inputCursorCol(buffer: string, width: number): number {
    const inner = innerWidth(width);
    const shown = Math.min(buffer.length, inputCapacity(inner));
    // "│ " (2) + "> " (2) + shown chars, then cursor sits on the next column.
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
