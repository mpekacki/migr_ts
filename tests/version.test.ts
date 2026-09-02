import fs from 'fs';
import path from 'path';
import { VERSION } from '../version';

describe('VERSION', () => {
    it('reports the version in package.json when running from source', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
        ) as { version: string };
        expect(VERSION).toBe(pkg.version);
        expect(VERSION).not.toBe('unknown');
    });
});
