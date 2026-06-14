import IOEvent, { IOEventType } from '../ioevent';
import { applyEvent, initialState, MigrationState } from '../ui/tui/state';
import { buildFrame } from '../ui/tui/render';
import { padTo, truncate, visibleLength, ansi } from '../ui/tui/ansi';

function feed(state: MigrationState, type: IOEventType, data?: unknown) {
    applyEvent(state, new IOEvent('output', type, data));
}

describe('ansi helpers', () => {
    it('ignores escape codes when measuring visible length', () => {
        expect(visibleLength(ansi.red('hello'))).toBe(5);
        expect(visibleLength('plain')).toBe(5);
    });

    it('pads to an exact visible width regardless of color codes', () => {
        expect(visibleLength(padTo(ansi.green('hi'), 10))).toBe(10);
        expect(visibleLength(padTo('hi', 10))).toBe(10);
    });

    it('truncates over-long strings with an ellipsis and preserves codes', () => {
        const t = truncate(ansi.cyan('abcdefghij'), 5);
        expect(visibleLength(t)).toBe(5); // 4 chars + ellipsis
        expect(t.endsWith('…')).toBe(true);
    });
});

describe('migration state reducer', () => {
    it('captures source and target from starting_migration', () => {
        const s = initialState();
        feed(s, 'starting_migration', { options: { sourceOrg: 'prod', targetOrg: 'sandbox' } });
        expect(s.source).toBe('prod');
        expect(s.target).toBe('sandbox');
        expect(s.phase).toBe('Starting');
    });

    it('prefers file/url over org name for source/target labels', () => {
        const s = initialState();
        feed(s, 'starting_migration', { options: { sourceFile: 'in.json', targetFile: 'out.json' } });
        expect(s.source).toBe('in.json');
        expect(s.target).toBe('out.json');
    });

    it('tracks created and error counts from saved_records', () => {
        const s = initialState();
        feed(s, 'remaining_records', { count: 10 });
        feed(s, 'saved_records', [{ success: true }, { success: true }, { success: false, errors: [] }]);
        expect(s.created).toBe(2);
        expect(s.errors).toBe(1);
        expect(s.remaining).toBe(8); // decremented by successes
    });

    it('counts skipped records from skip events and skip solvers', () => {
        const s = initialState();
        feed(s, 'skipping_record', { sObjectName: 'User', recordId: '005' });
        feed(s, 'using_solver', { recordId: '003', solver: 'x', solverAction: 'skip' });
        expect(s.skipped).toBe(2);
    });

    it('marks done on finished and aborted', () => {
        const done = initialState();
        feed(done, 'finished', {});
        expect(done.done).toBe(true);
        expect(done.phase).toBe('Complete');

        const aborted = initialState();
        feed(aborted, 'aborted');
        expect(aborted.done).toBe(true);
        expect(aborted.phase).toBe('Aborted');
    });

    it('demotes a previous running entry when a new event arrives', () => {
        const s = initialState();
        feed(s, 'fetching_record', { sObjectName: 'Account', recordId: '001' });
        feed(s, 'fetching_record', { sObjectName: 'Contact', recordId: '003' });
        const running = s.feed.filter(e => e.glyph === 'run');
        expect(running.length).toBe(1); // only the most recent stays "running"
        expect(s.feed[s.feed.length - 1].text).toContain('Contact');
    });
});

describe('frame renderer', () => {
    const build = (s: MigrationState, w = 60, h = 22) => buildFrame(s, 0, w, h, false);

    it('produces exactly `height` rows, each exactly `width` visible columns', () => {
        const s = initialState();
        feed(s, 'starting_migration', { options: { sourceOrg: 'prod', targetOrg: 'sandbox' } });
        feed(s, 'fetched_records', { count: 412 });
        const frame = build(s, 64, 20);
        expect(frame.length).toBe(20);
        for (const line of frame) {
            expect(visibleLength(line)).toBe(64);
        }
    });

    it('keeps rows full-width even at the clamped minimum size', () => {
        const s = initialState();
        const frame = buildFrame(s, 0, 5, 4, false); // below minimums -> clamped
        const width = visibleLength(frame[0]);
        expect(width).toBeGreaterThanOrEqual(24);
        for (const line of frame) {
            expect(visibleLength(line)).toBe(width);
        }
    });

    it('renders the overlay text in the body when prompting', () => {
        const s = initialState();
        s.overlay = ['Do you want to continue? (y/n)'];
        const frame = buildFrame(s, 0, 60, 22, true);
        const joined = frame.join('\n');
        expect(joined).toContain('Do you want to continue?');
    });

    it('shows a "press any key" hint when awaiting exit', () => {
        const s = initialState();
        feed(s, 'finished', {});
        const normal = buildFrame(s, 0, 60, 22, false, false).join('\n');
        expect(normal).not.toContain('Press any key');

        const awaiting = buildFrame(s, 0, 60, 22, false, true).join('\n');
        expect(awaiting).toContain('Press any key to exit');
    });

    it('draws the title and a bottom border', () => {
        const s = initialState();
        const frame = build(s);
        expect(frame[0]).toContain('migr_ts');
        expect(frame[frame.length - 1]).toContain('└');
        expect(frame[frame.length - 1]).toContain('┘');
    });
});
