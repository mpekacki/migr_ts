import IOEvent, { IOEventType } from '../ioevent';
import { applyEvent, buildFinalSummary, initialState, MigrationState, pushConsole } from '../ui/tui/state';
import { buildFrame, maxScrollOffset, maxFeedScrollOffset, bodyHeightFor, inputCursorCol } from '../ui/tui/render';
import { padTo, stripAnsi, truncate, visibleLength, wrapAnsi, takeLastColumns, ansi } from '../ui/tui/ansi';

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

    it('measures double-width and zero-width characters in columns', () => {
        expect(visibleLength('日本語')).toBe(6);
        expect(visibleLength('é')).toBe(1);  // combining accent adds no column
        expect(visibleLength('a​b')).toBe(2); // zero-width space
    });


    it('never cuts an escape sequence in half when truncating', () => {
        const t = truncate(`${ansi.red('abc')}${ansi.green('def')}`, 4);
        expect(visibleLength(t)).toBe(4);
        expect(stripAnsi(t)).toBe('abc…');
        // eslint-disable-next-line no-control-regex
        expect(t).not.toMatch(/\x1b\[[0-9;]*$/); // no dangling partial code
    });

    it('keeps the tail of an over-long input line, measured in columns', () => {
        expect(takeLastColumns('abcdef', 3)).toBe('def');
        expect(takeLastColumns('abc', 10)).toBe('abc');
        expect(visibleLength(takeLastColumns('日本語です', 5))).toBeLessThanOrEqual(5);
    });
});

describe('wrapAnsi', () => {
    it('breaks on spaces so words stay intact', () => {
        expect(wrapAnsi('the quick brown fox jumps', 10))
            .toEqual(['the quick', 'brown fox', 'jumps']);
    });

    it('never emits a line wider than the limit', () => {
        const text = 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id on field OwnerId';
        for (const width of [8, 13, 20, 37]) {
            for (const line of wrapAnsi(text, width)) {
                expect(visibleLength(line)).toBeLessThanOrEqual(width);
            }
        }
    });

    it('breaks mid-word only when the word itself does not fit', () => {
        expect(wrapAnsi('supercalifragilistic', 6))
            .toEqual(['superc', 'alifra', 'gilist', 'ic']);
    });

    it('preserves every visible character across the wrap', () => {
        const text = 'field Custom__c value 0035g00000ABCDEfg is not valid for the lookup';
        expect(wrapAnsi(text, 17).join(' ')).toBe(text);
    });

    it('measures color codes as zero width and reopens them on continuation lines', () => {
        const lines = wrapAnsi(ansi.red('aaaa bbbb cccc'), 9);
        expect(lines.map(stripAnsi)).toEqual(['aaaa bbbb', 'cccc']);
        for (const line of lines) {
            expect(visibleLength(line)).toBeLessThanOrEqual(9);
            expect(line).toContain('\x1b[31m'); // still red after the break
        }
    });

    it('treats embedded newlines as hard breaks and keeps their indentation', () => {
        expect(wrapAnsi('{\n  "Id": "001"\n}', 40)).toEqual(['{', '  "Id": "001"', '}']);
    });

    it('expands tabs and drops carriage returns', () => {
        expect(wrapAnsi('a\tb', 40)).toEqual(['a    b']);
        expect(wrapAnsi('a\r\nb', 40)).toEqual(['a', 'b']);
    });

    it('does not split double-width characters across lines', () => {
        for (const line of wrapAnsi('日本語のテキストです', 5)) {
            expect(visibleLength(line)).toBeLessThanOrEqual(5);
        }
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

describe('final summary', () => {
    const payload = JSON.stringify({
        allMigratedRecords: { '0015g00000QqWxYAAV': '0015g00000RrXyZAAV' },
        errors: {},
        requestedRecords: {
            '0015g00000QqWxYAAV': '0015g00000RrXyZAAV',
            '0035g00000LmNoPAAZ': '',
        },
    });

    it('lists each requested record next to the ID it became', () => {
        const lines = buildFinalSummary(payload).map(stripAnsi);
        expect(lines).toContain('  0015g00000QqWxYAAV → 0015g00000RrXyZAAV');
        expect(lines).toContain('  0035g00000LmNoPAAZ → (not migrated)');
        expect(lines.join('\n')).toContain('(1/2 migrated)');
    });

    it('accepts the payload already parsed as well as the JSON string', () => {
        expect(buildFinalSummary(JSON.parse(payload))).toEqual(buildFinalSummary(payload));
    });

    it('pins the summary on screen and keeps it for reprinting on exit', () => {
        const s = initialState();
        feed(s, 'finished', payload);
        expect(s.done).toBe(true);
        expect(s.finalSummary).not.toBeNull();
        expect(s.overlay).toBe(s.finalSummary);
    });

    it('leaves the feed alone when there is nothing requested to report', () => {
        const s = initialState();
        feed(s, 'finished', JSON.stringify({ errors: {}, requestedRecords: {} }));
        expect(s.overlay).toBeNull();
        expect(s.finalSummary).toBeNull();

        const bad = initialState();
        feed(bad, 'finished', 'not json');
        expect(bad.overlay).toBeNull();
        expect(bad.done).toBe(true);
    });

    it('shows the mapping on the final screen while awaiting exit', () => {
        const s = initialState();
        feed(s, 'finished', payload);
        const frame = buildFrame(s, 0, 60, 22, false, true);
        const text = stripAnsi(frame.join('\n'));
        expect(text).toContain('0015g00000QqWxYAAV → 0015g00000RrXyZAAV');
        expect(text).toContain('(not migrated)');
        expect(text).toContain('Press any key to exit');
        for (const line of frame) expect(visibleLength(line)).toBe(60);
    });

    it('makes a long list scrollable and says so on the exit line', () => {
        const requestedRecords: Record<string, string> = {};
        for (let i = 0; i < 60; i++) {
            requestedRecords[`0015g0000000${String(i).padStart(3, '0')}AAA`] = `0015g0000099${String(i).padStart(3, '0')}AAA`;
        }
        const s = initialState();
        feed(s, 'finished', JSON.stringify({ requestedRecords }));
        expect(maxScrollOffset(s.overlay, 60, 22)).toBeGreaterThan(0);

        const text = stripAnsi(buildFrame(s, 0, 60, 22, false, true).join('\n'));
        expect(text).toContain('↑↓ to scroll');
        expect(text).not.toContain('0015g0000000059AAA'); // below the fold until scrolled

        const scrolled = stripAnsi(
            buildFrame(s, 0, 60, 22, false, true, '', maxScrollOffset(s.overlay, 60, 22)).join('\n'));
        expect(scrolled).toContain('0015g0000000059AAA');
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

    it('wraps a long feed entry instead of cutting it off at the edge', () => {
        const s = initialState();
        const message = 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access '
            + 'rights on cross-reference id 0015g00000XyZaBAAV for field AccountId';
        feed(s, 'error', { message });
        const frame = build(s, 60, 24);
        const body = stripAnsi(frame.join('\n'));
        for (const word of message.split(' ')) expect(body).toContain(word);
        // Feed rows carry the whole message, none of it cut off with an ellipsis.
        expect(body.split('\n').filter(l => l.includes('…') && !l.includes('working')))
            .toEqual([]);
        for (const line of frame) expect(visibleLength(line)).toBe(60);
    });

    it('hangs continuation lines under the first line of the entry', () => {
        const s = initialState();
        feed(s, 'found_existing_record', {
            sObjectName: 'Account',
            recordId: 'a very long identifier that will certainly not fit on one row',
        });
        const rows = stripAnsi(build(s, 44, 24).join('\n'))
            .split('\n')
            .filter(l => l.includes('identifier') || l.includes('Matched'));
        expect(rows.length).toBeGreaterThan(1);
        // Continuation rows are indented past the glyph column, not at it.
        expect(rows[1]).toMatch(/^│ {5}\S/);
    });

    it('keeps the box intact when a console line contains newlines and tabs', () => {
        const s = initialState();
        pushConsole(s, 'query plan:\n\tAccount -> Contact\n\tContact -> Case');
        const frame = build(s, 50, 20);
        expect(frame.length).toBe(20);
        for (const line of frame) {
            expect(visibleLength(line)).toBe(50);
            expect(line).not.toContain('\n');
        }
        expect(stripAnsi(frame.join('\n'))).toContain('Contact -> Case');
    });

    it('keeps rows exact when feed text contains double-width characters', () => {
        const s = initialState();
        pushConsole(s, '取引先 '.repeat(20));
        const frame = build(s, 46, 20);
        for (const line of frame) expect(visibleLength(line)).toBe(46);
    });

    it('shortens both source and target so neither is pushed off the header', () => {
        const s = initialState();
        feed(s, 'starting_migration', {
            options: {
                sourceOrgUrl: 'https://very-long-source-instance.my.salesforce.com',
                targetOrgUrl: 'https://very-long-target-instance.my.salesforce.com',
            },
        });
        const header = stripAnsi(build(s, 60, 22)[1]);
        expect(visibleLength(header)).toBe(60);
        expect(header).toContain('Source https://very-long');
        expect(header).toContain('Target https://very-long');
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
        const max = maxFeedScrollOffset(s.feed, 60, 22);
        expect(max).toBe(40 - bodyHeightFor(22));

        const bottom = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', max, true).join('\n'));
        expect(bottom).toContain('id40');
        expect(bottom).not.toContain('id1 '); // earliest line scrolled off

        const top = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', 0, true).join('\n'));
        expect(top).toContain('id1 ');
        expect(top).not.toContain('id40');
    });

    it('counts wrapped continuation lines in the feed scroll bound', () => {
        const s = initialState();
        for (let i = 1; i <= 5; i++) {
            feed(s, 'error', { message: `failure ${i} ${'detail '.repeat(20)}` });
        }
        s.overlay = ['Continue?'];
        const max = maxFeedScrollOffset(s.feed, 60, 22);
        // Only 5 entries, well under the 14-row body — but they wrap past it, so
        // the bound has to be counted in rendered rows, not entries.
        expect(s.feed.length).toBeLessThan(bodyHeightFor(22));
        expect(max).toBeGreaterThan(0);

        // Scrolled fully down, the last entry's tail is on screen and nothing
        // scrolls past the end.
        const bottom = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', max, true).join('\n'));
        expect(bottom).toContain('detail');
        const past = stripAnsi(buildFrame(s, 0, 60, 22, true, false, '', max + 50, true).join('\n'));
        expect(past).toBe(bottom);
    });
});
