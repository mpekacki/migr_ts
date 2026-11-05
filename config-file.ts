/**
 * Reading the config file passed with -c.
 *
 * The file is JSONC rather than strict JSON: `//` line comments, `/* *\/` block
 * comments and trailing commas are accepted, so a config can carry notes and an
 * entry can be switched off by commenting it out (which leaves the comma before
 * it dangling when it was the last one). Everything that is removed is replaced
 * with spaces and newlines are kept, so a JSON.parse error still points at the
 * right line and column of the user's file.
 */
import fs from 'fs';
import { Options } from './config';

/** Blanks out a span, keeping its line breaks so positions stay put. */
function blank(text: string): string {
    return text.replace(/[^\r\n]/g, ' ');
}

/**
 * Walks `text` calling `onCode` for every character outside a string literal;
 * what it returns replaces the character (or the span it consumed). String
 * literals, escapes included, are copied unchanged.
 */
function rewriteOutsideStrings(text: string, onCode: (text: string, i: number) => { out: string; next: number }): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        const r = onCode(text, i);
        out += r.out;
        i = r.next;
    }
    return out;
}

/** Turns JSONC into plain JSON with every character at the same line and column. */
export function stripJsonComments(text: string): string {
    if (text.charCodeAt(0) === 0xFEFF) {
        text = ' ' + text.slice(1);
    }
    const withoutComments = rewriteOutsideStrings(text, (t, i) => {
        if (t.startsWith('//', i)) {
            let end = t.indexOf('\n', i);
            if (end === -1) end = t.length;
            // Leave a '\r' of a CRLF line ending where it is.
            if (t[end - 1] === '\r') end--;
            return { out: blank(t.slice(i, end)), next: end };
        }
        if (t.startsWith('/*', i)) {
            const close = t.indexOf('*/', i + 2);
            if (close === -1) {
                const line = t.slice(0, i).split('\n').length;
                throw new Error(`Unterminated /* comment starting on line ${line}`);
            }
            return { out: blank(t.slice(i, close + 2)), next: close + 2 };
        }
        return { out: t[i], next: i + 1 };
    });
    const closesNext = /\s*[}\]]/y;
    return rewriteOutsideStrings(withoutComments, (t, i) => {
        closesNext.lastIndex = i + 1;
        if (t[i] === ',' && closesNext.test(t)) {
            return { out: ' ', next: i + 1 };
        }
        return { out: t[i], next: i + 1 };
    });
}

export function parseConfigText(text: string): Options {
    return JSON.parse(stripJsonComments(text)) as Options;
}

export function loadConfigFile(path: string): Options {
    const text = fs.readFileSync(path, 'utf8');
    try {
        return parseConfigText(text);
    } catch (error) {
        throw new Error(`Invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
