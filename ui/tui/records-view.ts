import { edgeLabel, RetrievedRecord, tracePath } from '../../record-paths';
import { ansi, padTo, stripAnsi, truncate, visibleLength } from './ansi';

/**
 * The browser over every record the run retrieved: one group per SObject type,
 * each record listed under it, and under the list the path that led to the
 * selected record - or, on a group, how that type's records were reached. Pure:
 * the TUI owns the state and feeds keys in, this module says what they do and
 * what the body looks like.
 */

export interface RecordGroup {
    sObjectType: string;
    ids: string[];
}

export interface RecordIndex {
    byId: Map<string, RetrievedRecord>;
    /** Largest group first, the way the confirmation lists them; nearest records first within a group. */
    groups: RecordGroup[];
    /** Loaded from a file: no record has an origin, and none of them was asked for either. */
    fromFile: boolean;
}

export interface RecordsViewState {
    /** The groups opened by hand. A filter opens every group with a match in it. */
    expanded: Set<string>;
    filter: string;
    /** The selected row. */
    cursor: number;
    /** The first row on screen. */
    scroll: number;
}

export type RecordRow =
    | { kind: 'group'; group: RecordGroup; shown: number; expanded: boolean }
    | { kind: 'record'; id: string };

export function indexRecords(records: RetrievedRecord[], fromFile: boolean): RecordIndex {
    const byId = new Map(records.map(record => [record.id, record]));
    const depths = new Map(records.map(record => [record.id, tracePath(record.id, id => byId.get(id)).length]));
    const idsByType = new Map<string, string[]>();
    for (const record of records) {
        const ids = idsByType.get(record.sObjectType) ?? [];
        ids.push(record.id);
        idsByType.set(record.sObjectType, ids);
    }
    const groups = [...idsByType.entries()]
        .map(([sObjectType, ids]) => ({
            sObjectType,
            ids: ids.sort((a, b) => depths.get(a)! - depths.get(b)! || a.localeCompare(b)),
        }))
        .sort((a, b) => b.ids.length - a.ids.length || a.sObjectType.localeCompare(b.sObjectType));
    return { byId, groups, fromFile };
}

export function initialRecordsView(): RecordsViewState {
    return { expanded: new Set(), filter: '', cursor: 0, scroll: 0 };
}

function matchesFilter(record: RetrievedRecord, filter: string): boolean {
    return record.id.toLowerCase().includes(filter)
        || record.sObjectType.toLowerCase().includes(filter)
        || (record.label?.toLowerCase().includes(filter) ?? false);
}

/** The rows the list holds right now: every group with something to show, and the records of the open ones. */
export function recordRows(index: RecordIndex, view: RecordsViewState): RecordRow[] {
    const filter = view.filter.toLowerCase();
    const rows: RecordRow[] = [];
    for (const group of index.groups) {
        const ids = filter ? group.ids.filter(id => matchesFilter(index.byId.get(id)!, filter)) : group.ids;
        if (ids.length === 0) {
            continue;
        }
        const expanded = filter !== '' || view.expanded.has(group.sObjectType);
        rows.push({ kind: 'group', group, shown: ids.length, expanded });
        if (expanded) {
            for (const id of ids) {
                rows.push({ kind: 'record', id });
            }
        }
    }
    return rows;
}

/**
 * How the body is split: a header row, the list, and - when there is room for
 * it to say anything - a rule and the path pane under it.
 */
export function recordsLayout(bodyHeight: number): { listHeight: number; pathHeight: number } {
    const pathHeight = bodyHeight >= 10 ? Math.floor((bodyHeight - 2) * 0.4) : 0;
    const listHeight = Math.max(1, bodyHeight - 1 - (pathHeight > 0 ? pathHeight + 1 : 0));
    return { listHeight, pathHeight };
}

/** The cursor kept on a row, and the window kept around the cursor. */
function settle(cursor: number, scroll: number, rowCount: number, listHeight: number): { cursor: number; scroll: number } {
    const c = Math.max(0, Math.min(cursor, rowCount - 1));
    let s = scroll;
    if (c < s) s = c;
    if (c >= s + listHeight) s = c - listHeight + 1;
    s = Math.max(0, Math.min(s, rowCount - listHeight));
    return { cursor: c, scroll: s };
}

function settleView(index: RecordIndex, view: RecordsViewState, listHeight: number): void {
    Object.assign(view, settle(view.cursor, view.scroll, recordRows(index, view).length, listHeight));
}

function rowKey(row: RecordRow | undefined): string | undefined {
    if (!row) return undefined;
    return row.kind === 'group' ? `group:${row.group.sObjectType}` : row.id;
}

/** Change the filter, keeping the selected row selected when it is still listed. */
function setFilter(index: RecordIndex, view: RecordsViewState, filter: string): void {
    const selected = rowKey(recordRows(index, view)[view.cursor]);
    view.filter = filter;
    const at = recordRows(index, view).findIndex(row => rowKey(row) === selected);
    view.cursor = Math.max(0, at);
}

/**
 * Select a record, opening its group and clearing a filter that hides it, with
 * the list scrolled to show it mid-window. Says whether there was such a record.
 */
export function focusRecord(index: RecordIndex, view: RecordsViewState, id: string, bodyHeight: number): boolean {
    const record = index.byId.get(id);
    if (!record) {
        return false;
    }
    if (view.filter && !matchesFilter(record, view.filter.toLowerCase())) {
        view.filter = '';
    }
    view.expanded.add(record.sObjectType);
    const rows = recordRows(index, view);
    const { listHeight } = recordsLayout(bodyHeight);
    view.cursor = rows.findIndex(row => row.kind === 'record' && row.id === id);
    view.scroll = view.cursor - Math.floor(listHeight / 2);
    settleView(index, view, listHeight);
    return true;
}

export const RECORDS_KEYS = {
    up: ['\x1b[A', '\x1bOA'],
    down: ['\x1b[B', '\x1bOB'],
    left: ['\x1b[D', '\x1bOD'],
    right: ['\x1b[C', '\x1bOC'],
    pageUp: ['\x1b[5~'],
    pageDown: ['\x1b[6~'],
    home: ['\x1b[H', '\x1b[1~', '\x1bOH'],
    end: ['\x1b[F', '\x1b[4~', '\x1bOF'],
};

/**
 * One key of the browser. Everything typed goes to the filter, so the only key
 * that leaves is Esc - and only once there is no filter left for it to clear.
 */
export function handleRecordsKey(index: RecordIndex, view: RecordsViewState, key: string, bodyHeight: number): 'handled' | 'leave' {
    const { listHeight } = recordsLayout(bodyHeight);
    const rows = recordRows(index, view);
    const selected = rows[view.cursor];
    const is = (keys: string[]) => keys.includes(key);

    if (key === '\x1b') {
        if (!view.filter) {
            return 'leave';
        }
        setFilter(index, view, '');
    } else if (is(RECORDS_KEYS.up)) {
        view.cursor--;
    } else if (is(RECORDS_KEYS.down)) {
        view.cursor++;
    } else if (is(RECORDS_KEYS.pageUp)) {
        view.cursor -= listHeight;
    } else if (is(RECORDS_KEYS.pageDown)) {
        view.cursor += listHeight;
    } else if (is(RECORDS_KEYS.home)) {
        view.cursor = 0;
    } else if (is(RECORDS_KEYS.end)) {
        view.cursor = rows.length - 1;
    } else if (is(RECORDS_KEYS.right)) {
        if (selected?.kind === 'group') {
            view.expanded.add(selected.group.sObjectType);
        }
    } else if (is(RECORDS_KEYS.left)) {
        if (selected?.kind === 'record') {
            // Up to the group it is listed under.
            for (let i = view.cursor; i >= 0; i--) {
                if (rows[i].kind === 'group') {
                    view.cursor = i;
                    break;
                }
            }
        } else if (selected?.kind === 'group' && !view.filter) {
            view.expanded.delete(selected.group.sObjectType);
        }
    } else if (key === '\r' || key === '\n') {
        if (selected?.kind === 'group' && !view.filter) {
            const type = selected.group.sObjectType;
            if (view.expanded.has(type)) view.expanded.delete(type);
            else view.expanded.add(type);
        } else if (selected?.kind === 'record') {
            // One step up the path: the record this one was reached through.
            const from = index.byId.get(selected.id)?.origin?.from;
            if (from) {
                focusRecord(index, view, from, bodyHeight);
            }
        }
    } else if (key === '\x7f' || key === '\b') {
        setFilter(index, view, view.filter.slice(0, -1));
    } else if (!key.startsWith('\x1b')) {
        // eslint-disable-next-line no-control-regex
        const printable = key.replace(/[\x00-\x1f]/g, '');
        if (printable) {
            setFilter(index, view, view.filter + printable);
        }
    }
    settleView(index, view, listHeight);
    return 'handled';
}

/** Esc and Tab are on the separator below, with every other view's. */
const HELP = '↑↓ ←→ · Enter: parent · type to filter';

/** The body of the records view: exactly `bodyHeight` lines, each at most `inner` columns. */
export function renderRecords(index: RecordIndex, view: RecordsViewState, inner: number, bodyHeight: number): string[] {
    const rows = recordRows(index, view);
    const { listHeight, pathHeight } = recordsLayout(bodyHeight);
    const { cursor, scroll } = settle(view.cursor, view.scroll, rows.length, listHeight);

    const lines = [headerLine(index, view, inner)];
    for (let i = 0; i < listHeight; i++) {
        const row = rows[scroll + i];
        if (row) {
            lines.push(renderRow(index, row, scroll + i === cursor, inner));
        } else if (i === 0) {
            lines.push(ansi.gray(view.filter ? `No records match "${view.filter}"` : 'No records were retrieved'));
        } else {
            lines.push('');
        }
    }
    if (pathHeight > 0) {
        const row = rows[cursor];
        const title = row?.kind === 'group'
            ? 'How these were reached'
            : 'Path · Field: lookup · Relationship[]: child records';
        const rule = truncate(`── ${title} `, inner);
        lines.push(ansi.gray(rule + '─'.repeat(Math.max(0, inner - visibleLength(rule)))));
        const detail = !row ? [] : row.kind === 'group' ? groupDetail(index, row.group, pathHeight) : pathDetail(index, row.id, pathHeight);
        for (let i = 0; i < pathHeight; i++) {
            lines.push(truncate(detail[i] ?? '', inner));
        }
    }
    return lines;
}

function headerLine(index: RecordIndex, view: RecordsViewState, inner: number): string {
    const total = index.byId.size;
    const left = view.filter
        ? `${ansi.boldOn('Filter')} ${ansi.yellow(view.filter)}▏`
        : `${ansi.boldOn(`${total} retrieved record${total === 1 ? '' : 's'}`)} ${ansi.gray(`in ${index.groups.length} type${index.groups.length === 1 ? '' : 's'}`)}`;
    const room = inner - visibleLength(left) - 3;
    if (room >= visibleLength(HELP)) {
        return left + ' '.repeat(inner - visibleLength(left) - visibleLength(HELP)) + ansi.gray(HELP);
    }
    return truncate(left, inner);
}

function renderRow(index: RecordIndex, row: RecordRow, selected: boolean, inner: number): string {
    let text: string;
    if (row.kind === 'group') {
        const count = row.shown === row.group.ids.length ? String(row.shown) : `${row.shown} of ${row.group.ids.length}`;
        text = `${row.expanded ? '▾' : '▸'} ${ansi.boldOn(row.group.sObjectType)}  ${ansi.gray(count)}`;
    } else {
        const record = index.byId.get(row.id)!;
        const label = record.label ? `  ${truncate(record.label, 30)}` : '';
        const migrated = record.alreadyMigrated ? `  ${ansi.yellow('already migrated')}` : '';
        text = `    ${record.id}${label}  ${ansi.gray(reachedBy(index, record))}${migrated}`;
    }
    if (!selected) {
        return truncate(text, inner);
    }
    // Plain text under the highlight: a color reset inside it would end the
    // highlight with it, part way along the row.
    return ansi.inverse(padTo(stripAnsi(truncate(text, inner)), inner));
}

/** The last hop of a record's path, the way its row in the list shows it. */
function reachedBy(index: RecordIndex, record: RetrievedRecord): string {
    if (!record.origin) {
        return index.fromFile ? 'loaded from file' : 'requested';
    }
    const from = index.byId.get(record.origin.from);
    return `← ${from?.sObjectType ?? record.origin.from}.${edgeLabel(record.origin)}`;
}

/**
 * The path as a tree, the record it started at on top. When it is longer than
 * the pane, the top and the bottom are what matter - where it started and where
 * it ended - so the middle gives way.
 */
function pathDetail(index: RecordIndex, id: string, height: number): string[] {
    const steps = tracePath(id, step => index.byId.get(step));
    const lines = steps.map((step, i) => {
        const record = index.byId.get(step.id);
        const label = step.label ? `  ${ansi.gray(step.label)}` : '';
        const migrated = record?.alreadyMigrated ? `  ${ansi.yellow('already migrated')}` : '';
        const name = `${ansi.boldOn(step.sObjectType)} ${i === steps.length - 1 ? ansi.cyan(step.id) : step.id}${label}${migrated}`;
        if (i === 0) {
            const how = index.fromFile ? 'loaded from file' : 'requested';
            return `${name}  ${ansi.gray(`(${how})`)}`;
        }
        return `${'  '.repeat(i - 1)}└ ${ansi.magenta(edgeLabel(step.via!))} → ${name}`;
    });
    if (lines.length <= height) {
        return lines;
    }
    if (height < 3) {
        return lines.slice(-height);
    }
    const hidden = lines.length - (height - 1);
    return [lines[0], ansi.gray(`  ⋮ ${hidden} more`), ...lines.slice(lines.length - (height - 2))];
}

/** Each way the group's records were reached - the last hop of their paths - with how many came that way. */
function groupDetail(index: RecordIndex, group: RecordGroup, height: number): string[] {
    const counts = new Map<string, number>();
    for (const id of group.ids) {
        const way = reachedBy(index, index.byId.get(id)!).replace(/^← /, 'via ');
        counts.set(way, (counts.get(way) ?? 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const width = Math.max(...entries.map(([, count]) => String(count).length));
    const lines = entries.map(([way, count]) => `${String(count).padStart(width)}  ${way}`);
    if (lines.length <= height) {
        return lines;
    }
    return [...lines.slice(0, height - 1), ansi.gray(`… ${lines.length - (height - 1)} more`)];
}
