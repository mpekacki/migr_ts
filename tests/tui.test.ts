import IOEvent, { IOEventType } from '../ioevent';
import { applyEvent, initialState, MigrationState } from '../ui/tui/state';
import { buildFrame, maxScrollOffset, maxFeedScrollOffset, bodyHeightFor, inputCursorCol } from '../ui/tui/render';
import { padTo, stripAnsi, truncate, visibleLength, ansi } from '../ui/tui/ansi';

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

    it('uncounts errors hidden by hideError solvers', () => {
        const s = initialState();
        feed(s, 'saved_records', [{ success: false, errors: [] }, { success: false, errors: [] }]);
        expect(s.errors).toBe(2);
        feed(s, 'hidden_error', { recordId: '003' });
        expect(s.errors).toBe(1);
        feed(s, 'hidden_error', { recordId: '004' });
        feed(s, 'hidden_error', { recordId: '005' });
        expect(s.errors).toBe(0); // never goes negative
    });

    it('counts skipped records from skip events and skip solvers', () => {
        const s = initialState();
        feed(s, 'skipping_record', { sObjectName: 'User', recordId: '005' });
        feed(s, 'using_solver', { recordId: '003', solver: 'x', solverAction: 'skip' });
        expect(s.skipped).toBe(2);
    });

    it('updates the running total from records_so_far while fetching', () => {
        const s = initialState();
        feed(s, 'records_so_far', { count: 7 });
        expect(s.phase).toBe('Fetching');
        expect(s.total).toBe(7);
        feed(s, 'records_so_far', { count: 42 });
        expect(s.total).toBe(42);
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

    it('shows the growing record total in the header during fetching', () => {
        const s = initialState();
        feed(s, 'records_so_far', { count: 17 });
        const frame = stripAnsi(build(s).join('\n'));
        expect(frame).toContain('Records 0/17');
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

    it('renders the typed input after the "> " prompt', () => {
        const s = initialState();
        s.overlay = ['Continue? (y/n)'];
        const frame = buildFrame(s, 0, 60, 22, true, false, 'yes', 0);
        const inputLine = frame[frame.length - 2];
        expect(inputLine).toContain('>');
        expect(inputLine).toContain('yes');
    });
});

describe('scrollable overlay', () => {
    const tall = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);

    it('reports a non-zero max scroll only when content overflows the body', () => {
        const small = ['only one line'];
        expect(maxScrollOffset(small, 60, 22)).toBe(0);
        const max = maxScrollOffset(tall, 60, 22);
        expect(max).toBe(40 - bodyHeightFor(22));
        expect(max).toBeGreaterThan(0);
    });

    it('shows a window into the overlay and moves it with the scroll offset', () => {
        const s = initialState();
        s.overlay = tall;
        const top = buildFrame(s, 0, 60, 22, true, false, '', 0).join('\n');
        expect(top).toContain('line 1');
        expect(top).not.toContain('line 40');

        const scrolled = buildFrame(s, 0, 60, 22, true, false, '', 5).join('\n');
        expect(scrolled).not.toContain('line 5'); // offset 5 -> first visible is line 6
        expect(scrolled).toContain('line 6');
    });

    it('embeds a scroll indicator in the lower separator when overflowing', () => {
        const s = initialState();
        s.overlay = tall;
        const frame = buildFrame(s, 0, 60, 22, true, false, '', 0);
        const sep = frame.find(l => l.includes('scroll'));
        expect(sep).toBeDefined();
        expect(sep).toContain(`of ${tall.length}`);
    });

    it('clamps an out-of-range scroll offset to the last page', () => {
        const s = initialState();
        s.overlay = tall;
        const frame = buildFrame(s, 0, 60, 22, true, false, '', 9999).join('\n');
        expect(frame).toContain('line 40'); // last line visible, not blank
    });

    it('advances the cursor column as input grows', () => {
        expect(inputCursorCol('ab', 60)).toBe(inputCursorCol('', 60) + 2);
    });
});

describe('feed view during a prompt', () => {
    function promptedState(): MigrationState {
        const s = initialState();
        feed(s, 'fetched_records', { count: 3 });
        s.overlay = ['Do you want to continue? (y/n)'];
        return s;
    }

    it('shows the question by default and the activity feed when toggled', () => {
        const s = promptedState();
        const question = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0).join('\n'));
        expect(question).toContain('Do you want to continue?');
        expect(question).not.toContain('Fetched 3 records');

        const feedView = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0, true).join('\n'));
        expect(feedView).toContain('Fetched 3 records');
        expect(feedView).not.toContain('Do you want to continue?');
    });

    it('advertises the Tab toggle in the separator while prompting', () => {
        const s = promptedState();
        const question = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0).join('\n'));
        expect(question).toContain('Tab: activity log');

        const feedView = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0, true).join('\n'));
        expect(feedView).toContain('Tab: question');
    });

    it('scrolls the feed view with the scroll offset', () => {
        const s = initialState();
        for (let i = 1; i <= 40; i++) {
            feed(s, 'fetching_record', { sObjectName: 'Account', recordId: `id${i}` });
        }
        s.overlay = ['Continue?'];
        const max = maxFeedScrollOffset(s.feed.length, 22);
        expect(max).toBe(40 - bodyHeightFor(22));

        const bottom = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', max, true).join('\n'));
        expect(bottom).toContain('id40');
        expect(bottom).not.toContain('id1 '); // earliest line scrolled off

        const top = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0, true).join('\n'));
        expect(top).toContain('id1 ');
        expect(top).not.toContain('id40');
    });
});
