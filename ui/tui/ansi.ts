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

/** Length of a string ignoring ANSI escape sequences. */
export function visibleLength(s: string): number {
    return s.replace(ANSI_RE, '').length;
}

/** Truncate to `max` visible columns, preserving escape codes, adding an ellipsis. */
export function truncate(s: string, max: number): string {
    if (max <= 0) return '';
    if (visibleLength(s) <= max) return s;
    let out = '';
    let visible = 0;
    const limit = max - 1; // leave room for the ellipsis
    let i = 0;
    while (i < s.length && visible < limit) {
        if (s[i] === '\x1b') {
            // eslint-disable-next-line no-control-regex
            const match = s.slice(i).match(/^\x1b\[[0-9;?]*[a-zA-Z]/);
            if (match) {
                out += match[0];
                i += match[0].length;
                continue;
            }
        }
        out += s[i];
        visible++;
        i++;
    }
    return `${out}${ansi.reset}…`;
}

/** Pad with spaces on the right to exactly `width` visible columns (truncates if longer). */
export function padTo(s: string, width: number): string {
    const truncated = truncate(s, width);
    const pad = width - visibleLength(truncated);
    return pad > 0 ? truncated + ' '.repeat(pad) : truncated;
}
