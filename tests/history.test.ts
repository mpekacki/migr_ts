// The module object itself rather than a namespace import, whose properties
// cannot be redefined - and history.ts's namespace reads through to it.
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MigrationHistory from '../history';
import { Options } from '../config';

describe('MigrationHistory', () => {
    let dir: string;
    let filePath: string;

    const create = (isMigrateToFile = false) =>
        new MigrationHistory({ targetOrg: 'target', historyFilePath: filePath } as Options, isMigrateToFile);
    const onDisk = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));

    beforeEach(() => {
        jest.useFakeTimers();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migr-history-'));
        filePath = path.join(dir, 'history.json');
    });

    afterEach(() => {
        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes the first settled record at once and the ones right after it in a single later write', () => {
        const history = create();
        const writes = jest.spyOn(fs, 'writeFileSync');

        history.settle('a', '1');
        expect(onDisk()).toEqual({ a: '1' });

        history.settle('b', '2');
        history.settle('c', '3');
        expect(onDisk()).toEqual({ a: '1' });

        jest.advanceTimersByTime(1000);
        expect(onDisk()).toEqual({ a: '1', b: '2', c: '3' });
        expect(writes).toHaveBeenCalledTimes(2);
        writes.mockRestore();
    });

    it('writes pending records at once when flushed, and nothing when there are none', () => {
        const history = create();
        history.settle('a', '1');
        history.settle('b', '2');

        const writes = jest.spyOn(fs, 'writeFileSync');
        history.flush();
        expect(onDisk()).toEqual({ a: '1', b: '2' });
        history.flush();
        jest.advanceTimersByTime(1000);
        expect(writes).toHaveBeenCalledTimes(1);
        writes.mockRestore();
    });

    it('writes pending records when the process exits', () => {
        const history = create();
        const before = process.listeners('exit');
        history.settle('a', '1');
        // Written straight away, so nothing is left for an exit to write.
        expect(process.listeners('exit')).toEqual(before);

        history.settle('b', '2');
        history.settle('c', '3');
        const added = process.listeners('exit').filter(listener => !before.includes(listener));
        expect(added).toHaveLength(1);

        const exitListener = added[0] as () => void;
        exitListener();
        expect(onDisk()).toEqual({ a: '1', b: '2', c: '3' });
        // Nothing pending any more, so the listener is gone.
        expect(process.listeners('exit')).not.toContain(exitListener);
    });

    it('throws a failed timed write at the next settle', () => {
        const history = create();
        history.settle('a', '1');
        history.settle('b', '2');

        const writes = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        jest.advanceTimersByTime(1000);
        expect(() => history.settle('c', '3')).toThrow('disk full');
        writes.mockRestore();
        history.save();
        expect(onDisk()).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('never writes the file for an export', () => {
        const history = create(true);
        history.settle('a', '1');
        history.flush();
        jest.advanceTimersByTime(1000);
        expect(fs.existsSync(filePath)).toBe(false);
        expect(history.get('a')).toBe('1');
    });
});
