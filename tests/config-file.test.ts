import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigFile, parseConfigText, stripJsonComments } from '../config-file';

describe('config file comments', () => {
    it('parses plain JSON unchanged', () => {
        const json = '{"targetOrg":"t","recordIds":["001"],"relatedRecordDepthLimit":2}';
        expect(stripJsonComments(json)).toBe(json);
        expect(parseConfigText(json)).toEqual(JSON.parse(json));
    });

    it('removes line and block comments', () => {
        const text = [
            '// header',
            '{',
            '  "targetOrg": "t", // trailing note',
            '  /* a block',
            '     spanning lines */',
            '  "relatedRecordDepthLimit": /* inline */ 3',
            '}',
        ].join('\n');
        expect(parseConfigText(text)).toEqual({ targetOrg: 't', relatedRecordDepthLimit: 3 });
    });

    it('keeps every character at the same line and column', () => {
        const text = '{\r\n  // note\r\n  /* a\r\n b */ "x": 1\r\n}';
        const stripped = stripJsonComments(text);
        expect(stripped.length).toBe(text.length);
        expect(stripped.split('\n').map(l => l.length)).toEqual(text.split('\n').map(l => l.length));
        expect(stripped.indexOf('"x"')).toBe(text.indexOf('"x"'));
    });

    it('leaves comment-like text inside strings alone', () => {
        const text = '{"url": "https://example.com", "a": "/* not */", "b": "a\\"//b", "c": "x\\\\", "d": 1}';
        expect(parseConfigText(text)).toEqual({ url: 'https://example.com', a: '/* not */', b: 'a"//b', c: 'x\\', d: 1 });
    });

    it('drops trailing commas in objects and arrays', () => {
        const text = '{"a": [1, 2, ], "b": {"c": 1,}, "d": 2, // last\n}';
        expect(parseConfigText(text)).toEqual({ a: [1, 2], b: { c: 1 }, d: 2 });
    });

    it('keeps commas inside strings that look trailing', () => {
        expect(parseConfigText('{"a": ",}"}')).toEqual({ a: ',}' });
    });

    it('accepts a leading byte order mark', () => {
        expect(parseConfigText('﻿{"a": 1}')).toEqual({ a: 1 });
    });

    it('refuses an unterminated block comment', () => {
        expect(() => stripJsonComments('{\n"a": 1 /* oops\n}')).toThrow(/Unterminated \/\* comment starting on line 2/);
    });

    describe('loadConfigFile', () => {
        let dir: string;
        beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migr-config-')); });
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

        it('names the file when it cannot be parsed', () => {
            const file = path.join(dir, 'broken.json');
            fs.writeFileSync(file, '{ "a": 1 "b": 2 }');
            expect(() => loadConfigFile(file)).toThrow(`Invalid config file ${file}:`);
        });

        it('loads the example config shipped with the repo', () => {
            const options = loadConfigFile(path.join(__dirname, '..', 'config.json'));
            expect(options.targetOrg).toBe('myScratchOrg');
            expect(options.matchers!.length).toBeGreaterThan(0);
            expect('recordQueries' in options).toBe(false);
        });
    });
});
