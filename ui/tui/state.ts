import IOEvent from '../../ioevent';

export type Phase =
    | 'Starting'
    | 'Describing'
    | 'Matching'
    | 'Fetching'
    | 'Confirm'
    | 'Resolving'
    | 'Saving'
    | 'Updating'
    | 'Complete'
    | 'Aborted';

export type Glyph = 'run' | 'ok' | 'err' | 'warn' | 'info' | 'sub';

export interface FeedEntry {
    glyph: Glyph;
    indent: number;
    text: string;
}

export interface MigrationState {
    source: string;
    target: string;
    phase: Phase;
    total: number;       // records fetched / to migrate
    created: number;
    errors: number;
    skipped: number;
    remaining: number;
    feed: FeedEntry[];
    /** When set, the feed area is replaced by this overlay (a prompt or summary). */
    overlay: string[] | null;
    done: boolean;
}

const FEED_CAP = 500;

export function initialState(): MigrationState {
    return {
        source: '—',
        target: '—',
        phase: 'Starting',
        total: 0,
        created: 0,
        errors: 0,
        skipped: 0,
        remaining: 0,
        feed: [],
        overlay: null,
        done: false,
    };
}

function push(state: MigrationState, glyph: Glyph, text: string, indent = 0) {
    // Demote any previous in-progress entry now that something new happened.
    for (const e of state.feed) {
        if (e.glyph === 'run') e.glyph = 'info';
    }
    state.feed.push({ glyph, indent, text });
    if (state.feed.length > FEED_CAP) {
        state.feed.splice(0, state.feed.length - FEED_CAP);
    }
}

/** A raw console.* line captured while the TUI owns the screen. */
export function pushConsole(state: MigrationState, text: string) {
    state.feed.push({ glyph: 'sub', indent: 0, text });
    if (state.feed.length > FEED_CAP) {
        state.feed.splice(0, state.feed.length - FEED_CAP);
    }
}

/** Fold an output IOEvent into the migration state. */
export function applyEvent(state: MigrationState, event: IOEvent): void {
    const d = event.data ?? {};
    switch (event.type) {
        case 'starting_migration': {
            const o = d.options ?? {};
            state.source = o.sourceFile ?? o.sourceOrgUrl ?? o.sourceOrg ?? '—';
            state.target = o.targetFile ?? o.targetOrgUrl ?? o.targetOrg ?? '—';
            state.phase = 'Starting';
            push(state, 'run', 'Starting migration');
            break;
        }
        case 'describing_sobject':
            state.phase = 'Describing';
            push(state, 'run', `Describing ${d.sObjectName}`);
            break;
        case 'checking_matchers':
            state.phase = 'Matching';
            push(state, 'run', 'Checking matchers');
            break;
        case 'records_so_far':
            state.phase = 'Fetching';
            state.total = d.count ?? state.total;
            break;
        case 'fetching_record': {
            state.phase = 'Fetching';
            const via = d.reason ? ` (via ${d.reason})` : '';
            push(state, 'run', `Fetching ${d.sObjectName} ${d.recordId}${via}`);
            break;
        }
        case 'record_not_found':
            push(state, 'warn', `${d.sObjectName} ${d.recordId} not found in source`);
            break;
        case 'record_not_queryable':
            push(state, 'warn', `${d.sObjectName} ${d.recordId} is not queryable`);
            break;
        case 'malformed_id':
            push(state, 'warn', `${d.sObjectName} ${d.recordId} is malformed`);
            break;
        case 'querying_related_records':
            state.phase = 'Fetching';
            push(state, 'run', 'Querying related records');
            break;
        case 'related_records':
            if (d.count > 0) push(state, 'sub', `${d.relationshipName}: ${d.count}`, 1);
            break;
        case 'fetched_records':
            state.total = d.count ?? state.total;
            push(state, 'ok', `Fetched ${d.count} records`);
            break;
        case 'remaining_records':
            state.remaining = d.count ?? 0;
            state.phase = 'Resolving';
            break;
        case 'querying_existing_record':
            push(state, 'run', 'Querying for existing record', 1);
            break;
        case 'found_existing_record':
            push(state, 'sub', `Matched existing ${d.sObjectName} ${d.recordId}`, 1);
            break;
        case 'skipping_record':
            state.skipped++;
            push(state, 'sub', `Skipped ${d.sObjectName} ${d.recordId} (no match)`, 1);
            break;
        case 'creating_record':
            push(state, 'sub', `Preparing ${d.sObjectName} ${d.recordId}`, 1);
            break;
        case 'saving_records': {
            state.phase = 'Saving';
            const counts = formatTypeCounts(d.recordCountsByType);
            const n = (d.records ?? []).length;
            push(state, 'run', `Saving ${n} records${counts ? ` (${counts})` : ''}`);
            break;
        }
        case 'saved_records': {
            const arr: Array<{ success: boolean }> = Array.isArray(event.data) ? event.data : [];
            const ok = arr.filter(r => r.success).length;
            const bad = arr.length - ok;
            state.created += ok;
            state.errors += bad;
            if (state.remaining > 0) state.remaining = Math.max(0, state.remaining - ok);
            push(state, bad > 0 ? 'warn' : 'ok', `Saved ${ok}/${arr.length} records`);
            break;
        }
        case 'created_record':
            state.created++;
            break;
        case 'updating_record': {
            state.phase = 'Updating';
            const counts = formatTypeCounts(d.recordCountsByType);
            const n = (d.records ?? []).length;
            push(state, 'run', `Updating ${n} records${counts ? ` (${counts})` : ''}`);
            break;
        }
        case 'using_solver': {
            const label =
                d.solverAction === 'match' ? `Matched ${d.recordId} via solver` :
                d.solverAction === 'skip' ? `Skipped ${d.recordId} via solver` :
                d.solverAction === 'extract_column' ? 'Extracted column from error' :
                d.solverAction === 'append_random' ? `Appended random to ${d.recordId}` :
                `Applied solver: ${d.solverMessage ?? ''}`;
            if (d.solverAction === 'skip') state.skipped++;
            push(state, 'info', label, 1);
            break;
        }
        case 'looking_for_circular_dependencies':
            push(state, 'run', 'Resolving circular dependencies');
            break;
        case 'found_circular_dependency': {
            const n = Array.isArray(d.toClear) ? d.toClear.length : 0;
            push(state, 'sub', `Deferred ${n} circular field(s)`, 1);
            break;
        }
        case 'error':
            state.errors++;
            push(state, 'err', d.message ?? 'error');
            break;
        case 'error_updating_record':
            state.errors++;
            push(state, 'err', `Update failed ${d.sObjectName} ${d.recordId}`);
            break;
        case 'aborted':
            state.phase = 'Aborted';
            state.done = true;
            push(state, 'err', 'Migration aborted');
            break;
        case 'confirmation':
            push(state, 'info', `Confirmation: ${d.confirmation}`);
            break;
        case 'invalid_json':
            push(state, 'warn', 'Invalid JSON, try again');
            break;
        case 'invalid_regex':
            push(state, 'warn', 'Invalid regex, try again');
            break;
        case 'invalid_input':
            push(state, 'warn', `Invalid input: ${d.input}`);
            break;
        case 'finished':
            state.phase = 'Complete';
            state.done = true;
            push(state, 'ok', 'Migration complete');
            break;
        default:
            // Unmapped but harmless events are simply ignored in the feed.
            break;
    }
}

export function formatTypeCounts(recordCountsByType?: Record<string, number>): string {
    if (!recordCountsByType) return '';
    return Object.entries(recordCountsByType)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
}
