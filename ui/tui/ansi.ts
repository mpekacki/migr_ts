// Minimal ANSI helpers. We render with raw escape codes (no terminal-kit string
// markup) so that arbitrary record data containing '^', '[' etc. is never
// misinterpreted. Visible width is computed by stripping these codes.

const ESC = '\x1b[';

export const ansi = {
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    // foreground colors
    red: (s: string) => `${ESC}31m${s}${ESC}39m`,
    green: (s: string) => `${ESC}32m${s}${ESC}39m`,
    yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
    blue: (s: string) => `${ESC}34m${s}${ESC}39m`,
    magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
    cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
    gray: (s: string) => `${ESC}90m${s}${ESC}39m`,
    boldOn: (s: string) => `${ESC}1m${s}${ESC}22m`,
    dimOn: (s: string) => `${ESC}2m${s}${ESC}22m`,
};

// Screen control
export const screen = {
    enterAlt: `${ESC}?1049h`,
    exitAlt: `${ESC}?1049l`,
    hideCursor: `${ESC}?25l`,
    showCursor: `${ESC}?25h`,
    clear: `${ESC}2J`,
    eraseToLineEnd: `${ESC}K`,
    home: `${ESC}H`,
    moveTo: (col: number, row: number) => `${ESC}${row};${col}H`,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// eslint-disable-next-line no-control-regex
const ANSI_AT_START = /^\x1b\[[0-9;?]*[a-zA-Z]/;

/** Remove ANSI escape sequences, leaving only visible characters. */
export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, '');
}

/**
 * Columns occupied by one code point. Terminals draw CJK/emoji double-wide and
 * combining marks not at all; counting them as one column each would make the
 * box borders drift, so measure them properly.
 */
export function charWidth(codePoint: number): number {
    if (codePoint === 0) return 0;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0; // control
    if (
        codePoint === 0x200b ||                                  // zero-width space
        (codePoint >= 0x200c && codePoint <= 0x200f) ||          // joiners / marks
        (codePoint >= 0x0300 && codePoint <= 0x036f) ||          // combining diacritics
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f)             // variation selectors
    ) return 0;
    if (
        (codePoint >= 0x1100 && codePoint <= 0x115f) ||          // Hangul Jamo
        (codePoint >= 0x2e80 && codePoint <= 0x303e) ||          // CJK radicals … punctuation
        (codePoint >= 0x3041 && codePoint <= 0x33ff) ||          // kana, CJK compat
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||          // CJK ext A
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||          // CJK unified
        (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||          // Yi
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||          // Hangul syllables
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||          // CJK compat ideographs
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||          // CJK compat forms
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||          // fullwidth forms
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||        // emoji
        (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)           // CJK ext B+
    ) return 2;
    return 1;
}

/** Visible width of a string in terminal columns, ignoring escape sequences. */
export function visibleLength(s: string): number {
    let width = 0;
    for (const ch of stripAnsi(s)) width += charWidth(ch.codePointAt(0) ?? 0);
    return width;
}

/**
 * Split a string into printable cells, each carrying the escape sequences that
 * precede it plus the SGR state that is active going into it. Wrapping and
 * truncation both work on cells so an escape sequence is never cut in half.
 */
interface Cell {
    /** Escapes preceding this character, followed by the character itself. */
    text: string;
    /** The character alone (for whitespace/newline decisions). */
    ch: string;
    /** Columns this character occupies. */
    width: number;
    /** SGR codes still open *before* this cell, to reopen it on a new line. */
    openBefore: string;
}

const TAB_WIDTH = 4;

/** Fold one SGR sequence into the set of currently open codes. */
function applySgr(open: string[], seq: string): void {
    if (!seq.endsWith('m')) return; // cursor movement etc: not a style, ignore
    const body = seq.slice(2, -1); // strip "\x1b[" and the final "m"
    for (const part of body.split(';')) {
        const code = Number(part === '' ? '0' : part);
        if (code === 0) { open.length = 0; continue; }
        if (code === 39) { removeWhere(open, c => (c >= 30 && c <= 38) || (c >= 90 && c <= 97)); continue; }
        if (code === 49) { removeWhere(open, c => (c >= 40 && c <= 48) || (c >= 100 && c <= 107)); continue; }
        if (code === 22) { removeWhere(open, c => c === 1 || c === 2); continue; }
        if (code >= 21 && code <= 29) { removeWhere(open, c => c === code - 20); continue; }
        open.push(`${ESC}${code}m`);
    }
}

function removeWhere(open: string[], match: (code: number) => boolean): void {
    for (let i = open.length - 1; i >= 0; i--) {
        const code = Number(open[i].slice(2, -1));
        if (match(code)) open.splice(i, 1);
    }
}

function toCells(s: string): Cell[] {
    const cells: Cell[] = [];
    const open: string[] = [];
    let pending = '';
    // Codes open *before* `pending` — what a continuation line has to reopen.
    let openBefore = '';
    let i = 0;
    const push = (text: string, ch: string, width: number) => {
        cells.push({ text, ch, width, openBefore });
        pending = '';
        openBefore = open.join('');
    };
    while (i < s.length) {
        if (s[i] === '\x1b') {
            const match = s.slice(i).match(ANSI_AT_START);
            if (match) {
                pending += match[0];
                applySgr(open, match[0]);
                i += match[0].length;
                continue;
            }
        }
        const ch = String.fromCodePoint(s.codePointAt(i) as number);
        i += ch.length;
        const cp = ch.codePointAt(0) as number;
        if (ch === '\t') {
            // Expand tabs so they occupy a predictable number of columns.
            for (let t = 0; t < TAB_WIDTH; t++) push((t === 0 ? pending : '') + ' ', ' ', 1);
            continue;
        }
        if (ch === '\r') continue;                       // CR is layout noise
        if (ch !== '\n' && cp < 32) continue;            // drop other control chars
        push(pending + ch, ch, ch === '\n' ? 0 : charWidth(cp));
    }
    if (pending) {
        // Trailing escapes with nothing after them: keep them so styles still close.
        push(pending, '', 0);
    }
    return cells;
}

/** Join cells back into a printable line, reopening styles and closing them. */
function renderCells(cells: Cell[]): string {
    if (cells.length === 0) return '';
    const prefix = cells[0].openBefore;
    const body = cells.map(c => c.text).join('');
    const needsReset = prefix.length > 0 || /\x1b\[/.test(body); // eslint-disable-line no-control-regex
    return prefix + body + (needsReset ? ansi.reset : '');
}

/**
 * Wrap a single string to `width` columns, breaking on spaces where possible and
 * mid-word only when a word is longer than the line. Embedded newlines become
 * hard breaks, escape sequences are preserved and reopened on continuation lines.
 */
export function wrapAnsi(s: string, width: number): string[] {
    const w = Math.max(1, width);
    const lines: string[] = [];
    let line: Cell[] = [];
    let lineWidth = 0;
    // The run of spaces between the last placed word and the one being built.
    // It is emitted with the next word, or dropped when the line breaks there.
    let gap: Cell[] = [];
    let gapWidth = 0;
    let word: Cell[] = [];
    let wordWidth = 0;
    // Leading spaces are indentation only at the start of a hard line; after a
    // soft break they are the break itself and must not indent the continuation.
    let hardStart = true;

    const flushLine = () => {
        lines.push(renderCells(line));
        line = [];
        lineWidth = 0;
    };

    const placeWord = () => {
        if (word.length === 0) return;
        if (line.length > 0 && lineWidth + gapWidth + wordWidth <= w) {
            line.push(...gap, ...word);
            lineWidth += gapWidth + wordWidth;
        } else {
            if (line.length > 0) flushLine();
            // On a line of its own; only split it if it still does not fit.
            for (const cell of word) {
                if (lineWidth + cell.width > w && line.length > 0) flushLine();
                line.push(cell);
                lineWidth += cell.width;
            }
        }
        word = []; wordWidth = 0;
        gap = []; gapWidth = 0;
        hardStart = false;
    };

    for (const cell of toCells(s)) {
        if (cell.ch === '\n') {
            placeWord();
            flushLine();
            gap = []; gapWidth = 0;
            hardStart = true;
            continue;
        }
        if (cell.ch === ' ') {
            placeWord();
            if (hardStart && line.length === 0) {
                if (lineWidth + cell.width > w) continue; // absurd indentation
                line.push(cell);
                lineWidth += cell.width;
            } else {
                gap.push(cell);
                gapWidth += cell.width;
            }
            continue;
        }
        word.push(cell);
        wordWidth += cell.width;
    }
    placeWord();
    if (line.length > 0 || lines.length === 0) flushLine();
    return lines;
}

/** Truncate to `max` visible columns, preserving escape codes, adding an ellipsis. */
export function truncate(s: string, max: number): string {
    if (max <= 0) return '';
    if (visibleLength(s) <= max) return s;
    const limit = max - 1; // leave room for the ellipsis
    const kept: Cell[] = [];
    let visible = 0;
    for (const cell of toCells(s)) {
        if (visible + cell.width > limit) break;
        kept.push(cell);
        visible += cell.width;
    }
    const body = kept.length > 0 ? kept.map(c => c.text).join('') : '';
    return `${kept[0]?.openBefore ?? ''}${body}${ansi.reset}${'…'.padStart(max - visible)}`;
}

/** Keep the last `max` columns of a plain string (used to scroll the input line). */
export function takeLastColumns(s: string, max: number): string {
    if (visibleLength(s) <= max) return s;
    const chars = [...s];
    let out = '';
    let width = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
        const cw = charWidth(chars[i].codePointAt(0) ?? 0);
        if (width + cw > max) break;
        out = chars[i] + out;
        width += cw;
    }
    return out;
}

/** Pad with spaces on the right to exactly `width` visible columns (truncates if longer). */
export function padTo(s: string, width: number): string {
    const truncated = truncate(s, width);
    const pad = width - visibleLength(truncated);
    return pad > 0 ? truncated + ' '.repeat(pad) : truncated;
}
