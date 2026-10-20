import { RetrievedRecord } from '../record-paths';
import { stripAnsi, visibleLength } from '../ui/tui/ansi';
import {
    addRecord, emptyIndex, focusRecord, handleRecordsKey, indexRecords, initialRecordsView, reanchor, RECORDS_KEYS, recordRows, recordsLayout,
    RecordsViewState, renderRecords, sortedGroups,
} from '../ui/tui/records-view';

const UP = RECORDS_KEYS.up[0];
const DOWN = RECORDS_KEYS.down[0];
const LEFT = RECORDS_KEYS.left[0];
const RIGHT = RECORDS_KEYS.right[0];
const ESC = '\x1b';
const ENTER = '\r';
const BODY = 20;

const records: RetrievedRecord[] = [
    { id: '001A', sObjectType: 'Account', label: 'Cloud Kicks' },
    { id: '003C', sObjectType: 'Contact', label: 'John Doe', origin: { from: '003B', kind: 'lookup', name: 'ReportsToId' } },
    { id: '003B', sObjectType: 'Contact', label: 'Jane Doe', origin: { from: '001A', kind: 'child', name: 'Contacts' } },
    { id: '500D', sObjectType: 'Case', label: 'Broken', origin: { from: '003C', kind: 'child', name: 'Cases' } },
    { id: '005U', sObjectType: 'User', label: 'Admin', origin: { from: '001A', kind: 'lookup', name: 'OwnerId' }, alreadyMigrated: true },
];

function rowNames(view: RecordsViewState, index = indexRecords(records, false)): string[] {
    return recordRows(index, view).map(row => row.kind === 'group' ? `[${row.group.sObjectType}]` : row.id);
}

function selected(view: RecordsViewState, index = indexRecords(records, false)): string {
    const row = recordRows(index, view)[view.cursor];
    return row.kind === 'group' ? `[${row.group.sObjectType}]` : row.id;
}

function press(view: RecordsViewState, ...keys: string[]) {
    const index = indexRecords(records, false);
    return keys.map(key => handleRecordsKey(index, view, key, BODY)).pop();
}

describe('records view', () => {
    it('groups the records by type, largest group first and nearest record first', () => {
        const index = indexRecords(records, false);
        expect(sortedGroups(index).map(group => group.sObjectType)).toEqual(['Contact', 'Account', 'Case', 'User']);
        // Jane is one hop from the requested account, John two
        expect(index.groups.get('Contact')!.ids).toEqual(['003B', '003C']);
    });

    describe('while fetching', () => {
        // the order a fetch can deliver them in: every record after the one its path goes through
        const arrivals: RetrievedRecord[][] = [
            [records[0], records[2], records[4], records[1], records[3]],
            [records[0], records[4], records[2], records[1], records[3]],
        ];

        it('orders the records as they arrive exactly as it orders the complete list', () => {
            const complete = indexRecords(records, false);
            for (const order of arrivals) {
                const live = emptyIndex(false, false);
                order.forEach(record => addRecord(live, record));
                expect(sortedGroups(live)).toEqual(sortedGroups(complete));
                expect(live.depths).toEqual(complete.depths);
            }
        });

        it('keeps the order within a wave whichever fetch finishes first', () => {
            const wave = ['a3', 'a1', 'a2'].map(id => ({ id, sObjectType: 'Contact', origin: { from: 'root', kind: 'child' as const, name: 'Contacts' } }));
            const live = emptyIndex(false, false);
            addRecord(live, { id: 'root', sObjectType: 'Account' });
            wave.forEach(record => addRecord(live, record));
            expect(live.groups.get('Contact')!.ids).toEqual(['a1', 'a2', 'a3']);
        });

        it('counts a record fetched twice once', () => {
            const live = emptyIndex(false, false);
            addRecord(live, records[0]);
            addRecord(live, records[0]);
            expect(live.groups.get('Account')!.ids).toEqual(['001A']);
            expect(live.byId.size).toBe(1);
        });

        it('keeps the selected record where it is on screen as records arrive above it', () => {
            const live = emptyIndex(false, false);
            const contacts = Array.from({ length: 20 }, (_, i) => ({
                id: `003${String(i + 10).padStart(3, '0')}`, sObjectType: 'Contact', origin: { from: '001A', kind: 'child' as const, name: 'Contacts' },
            }));
            addRecord(live, records[0]);
            contacts.slice(10).forEach(record => addRecord(live, record));
            const view = initialRecordsView();
            focusRecord(live, view, '003025', BODY);
            const onScreen = view.cursor - view.scroll;

            // the earlier ids sort above it
            contacts.slice(0, 10).forEach(record => addRecord(live, record));
            reanchor(live, view, BODY);
            expect(selected(view, live)).toBe('003025');
            expect(view.cursor - view.scroll).toBe(onScreen);
        });

        it('says it is still fetching until the complete list replaces it', () => {
            const live = emptyIndex(false, false);
            addRecord(live, records[0]);
            const view = initialRecordsView();
            expect(stripAnsi(renderRecords(live, view, 100, BODY)[0])).toContain('1 retrieved record in 1 type · fetching…');
            expect(stripAnsi(renderRecords(indexRecords(records, false), view, 100, BODY)[0])).not.toContain('fetching');
        });
    });

    it('starts with every group folded, and opens and closes them', () => {
        const view = initialRecordsView();
        expect(rowNames(view)).toEqual(['[Contact]', '[Account]', '[Case]', '[User]']);

        press(view, RIGHT);
        expect(rowNames(view)).toEqual(['[Contact]', '003B', '003C', '[Account]', '[Case]', '[User]']);

        // left on a record goes up to its group, left on an open group folds it
        press(view, DOWN, DOWN);
        expect(selected(view)).toBe('003C');
        press(view, LEFT);
        expect(selected(view)).toBe('[Contact]');
        press(view, LEFT);
        expect(rowNames(view)).toEqual(['[Contact]', '[Account]', '[Case]', '[User]']);

        press(view, ENTER);
        expect(rowNames(view)).toContain('003B');
    });

    it('keeps the cursor on the list', () => {
        const view = initialRecordsView();
        press(view, UP, UP);
        expect(view.cursor).toBe(0);
        press(view, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);
        expect(selected(view)).toBe('[User]');
    });

    it('goes up the path with Enter, one record at a time', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        focusRecord(index, view, '500D', BODY);
        expect(selected(view)).toBe('500D');

        press(view, ENTER);
        expect(selected(view)).toBe('003C');
        press(view, ENTER);
        expect(selected(view)).toBe('003B');
        press(view, ENTER);
        expect(selected(view)).toBe('001A');
        // a requested record is where the path starts - there is nowhere further up
        press(view, ENTER);
        expect(selected(view)).toBe('001A');
    });

    it('filters on what is typed, and leaves only once Esc has nothing left to clear', () => {
        const view = initialRecordsView();
        press(view, ...'john');
        expect(view.filter).toBe('john');
        expect(rowNames(view)).toEqual(['[Contact]', '003C']);

        press(view, '\x7f');
        expect(view.filter).toBe('joh');

        // by id and type too
        press(view, ESC);
        press(view, ...'500');
        expect(rowNames(view)).toEqual(['[Case]', '500D']);

        expect(press(view, ESC)).toBe('handled');
        expect(view.filter).toBe('');
        expect(press(view, ESC)).toBe('leave');
    });

    it('keeps the selected record selected when the filter changes around it', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        focusRecord(index, view, '003C', BODY);
        press(view, ...'doe');
        expect(selected(view)).toBe('003C');
    });

    it('shows the selected record whatever the filter, when asked to focus on it', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        press(view, ...'case');
        expect(focusRecord(index, view, '003B', BODY)).toBe(true);
        expect(view.filter).toBe('');
        expect(selected(view)).toBe('003B');
        expect(focusRecord(index, view, 'unknown', BODY)).toBe(false);
    });

    it('renders exactly the body height, each line within the width', () => {
        const index = indexRecords(records, false);
        for (const height of [2, 6, 10, 20, 40]) {
            for (const inner of [20, 56, 100]) {
                const view = initialRecordsView();
                focusRecord(index, view, '500D', height);
                const lines = renderRecords(index, view, inner, height);
                expect(lines).toHaveLength(height);
                for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(inner);
            }
        }
    });

    it('draws the path to the selected record as a tree from the requested record down', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        focusRecord(index, view, '500D', BODY);
        const text = renderRecords(index, view, 100, BODY).map(stripAnsi);

        expect(text).toContain('Account 001A  Cloud Kicks  (requested)');
        expect(text).toContain('└ Contacts[] → Contact 003B  Jane Doe');
        expect(text).toContain('  └ ReportsToId → Contact 003C  John Doe');
        expect(text).toContain('    └ Cases[] → Case 500D  Broken');
        // the record's own row names the last hop
        expect(text.find(line => line.includes('    500D'))).toContain('← Contact.Cases[]');
    });

    it('summarises how a group was reached when the group is selected', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        const text = renderRecords(index, view, 100, BODY).map(stripAnsi).join('\n');
        expect(text).toContain('How these were reached');
        expect(text).toContain('1  via Account.Contacts[]');
        expect(text).toContain('1  via Contact.ReportsToId');
    });

    it('marks a record an earlier run migrated', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        focusRecord(index, view, '005U', BODY);
        const text = renderRecords(index, view, 100, BODY).map(stripAnsi).join('\n');
        expect(text).toContain('already migrated');
    });

    it('keeps both ends of a path longer than the pane', () => {
        const chain: RetrievedRecord[] = [{ id: 'r0', sObjectType: 'Thing__c' }];
        for (let i = 1; i < 30; i++) {
            chain.push({ id: `r${i}`, sObjectType: 'Thing__c', origin: { from: `r${i - 1}`, kind: 'lookup', name: 'Parent__c' } });
        }
        const index = indexRecords(chain, false);
        const view = initialRecordsView();
        focusRecord(index, view, 'r29', BODY);
        const { pathHeight } = recordsLayout(BODY);
        const pane = renderRecords(index, view, 100, BODY).slice(-pathHeight).map(stripAnsi);
        expect(pane[0]).toContain('r0');
        expect(pane[1]).toContain('⋮');
        expect(pane[pane.length - 1]).toContain('r29');
    });

    it('says the records came from a file rather than claiming they were requested', () => {
        const index = indexRecords([{ id: '001A', sObjectType: 'Account' }], true);
        const view = initialRecordsView();
        focusRecord(index, view, '001A', BODY);
        const text = renderRecords(index, view, 100, BODY).map(stripAnsi).join('\n');
        expect(text).toContain('loaded from file');
        expect(text).not.toContain('requested');
    });

    it('says so when nothing matches the filter', () => {
        const index = indexRecords(records, false);
        const view = initialRecordsView();
        handleRecordsKey(index, view, 'z', BODY);
        handleRecordsKey(index, view, 'z', BODY);
        expect(renderRecords(index, view, 100, BODY).map(stripAnsi)).toContain('No records match "zz"');
    });
});
