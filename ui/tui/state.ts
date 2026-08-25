import IOEvent from '../../ioevent';
import { ansi } from './ansi';

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

/**
 * The counters are deliberately fed by *per-record* events only, so each record
 * lands in exactly one of them: `created_record`, `found_existing_record` or a
 * matching solver, `skipping_record` or a skip solver. The batch `saved_records`
 * event covers the same records and must not touch them, or every insert is
 * counted twice. `remaining` is likewise taken from the app's own queue length
 * (`record_settled`) rather than derived, because a record can also leave the
 * queue by failing outright, which no counter here represents.
 */
export interface MigrationState {
    source: string;
    target: string;
    phase: Phase;
    total: number;       // records fetched / to migrate
    created: number;
    matched: number;     // resolved to a record that already existed in the target
    errors: number;
    skipped: number;
    remaining: number;
    feed: FeedEntry[];
    /** When set, the feed area is replaced by this overlay (a prompt or summary). */
    overlay: string[] | null;
    /**
     * The end-of-run summary, kept separately from `overlay` so it can be
     * reprinted on the normal screen once the alternate screen is torn down.
     */
    finalSummary: string[] | null;
    /**
     * Set when the run had nothing left to migrate. Any record id on the final
     * screen then comes from an earlier run, so it must not read as "created".
     */
    alreadyMigrated: Record<string, number> | null;
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
        matched: 0,
        errors: 0,
        skipped: 0,
        remaining: 0,
        feed: [],
        overlay: null,
        finalSummary: null,
        alreadyMigrated: null,
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
            state.source = o.sourceSqlite ?? o.sourceFile ?? o.sourceOrgUrl ?? o.sourceOrg ?? '—';
            state.target = o.targetSqlite ?? o.targetFile ?? o.targetOrgUrl ?? o.targetOrg ?? '—';
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
        case 'downloading_file':
            push(state, 'sub', `Downloading ${d.field} of ${d.sObjectName} ${d.recordId}`, 1);
            break;
        case 'file_too_large':
            push(state, 'warn', `${d.field} of ${d.sObjectName} ${d.recordId} is too large - migrating without it`);
            break;
        case 'file_download_failed':
            push(state, 'warn', `Could not download ${d.field} of ${d.sObjectName} ${d.recordId} - migrating without it`);
            break;
        case 'file_document_mapped':
            push(state, 'sub', `ContentDocument ${d.documentId} -> ${d.newDocumentId}`, 1);
            break;
        case 'file_document_unavailable':
            push(state, 'warn', `ContentDocument ${d.documentId} not migrated: version ${d.versionId} never landed`);
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
        case 'nothing_to_migrate': {
            state.alreadyMigrated = d.alreadyMigrated ?? {};
            const counts = formatTypeCounts(d.alreadyMigrated);
            push(state, 'info', `Nothing to migrate${counts ? ` (already migrated: ${counts})` : ''}`);
            break;
        }
        case 'remaining_records':
            state.remaining = d.count ?? 0;
            state.phase = 'Resolving';
            break;
        case 'record_settled':
            // Mid-pass progress: the queue shrank, but the phase is unchanged.
            state.remaining = d.count ?? state.remaining;
            break;
        case 'querying_existing_record':
            push(state, 'run', 'Querying for existing record', 1);
            break;
        case 'found_existing_record':
            state.matched++;
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
            // Feed line only. The counters come from the per-record events this
            // batch is about to produce (`created_record`, `error`, solver events).
            const arr: Array<{ success: boolean }> = Array.isArray(event.data) ? event.data : [];
            const ok = arr.filter(r => r.success).length;
            const bad = arr.length - ok;
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
            if (d.solverAction === 'match') state.matched++;
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
        // 'hidden_error' needs no handling: a hideError solver suppresses the
        // 'error' event itself, so there is nothing here to uncount.
        case 'error_updating_record': {
            state.errors++;
            // One feed line, so only the message - the full payload (fields, status
            // code, stack) is in the log file and in the debug event.
            const why = firstLine(d.error?.message);
            push(state, 'err', `Update failed ${d.sObjectName} ${d.recordId}${why ? `: ${why}` : ''}`);
            // The values that were being written, on their own line: the message says
            // what the org objected to, this says what it objected to it in.
            const attempted = formatAttemptedValues(d.fields);
            if (attempted) push(state, 'sub', attempted, 1);
            break;
        }
        case 'record_no_id':
            // Not an error, but the update it was queued for silently never happens.
            push(state, 'warn', `Update skipped ${d.recordId} (no target ID)`);
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
        case 'finished': {
            state.phase = 'Complete';
            state.done = true;
            if (state.alreadyMigrated) {
                push(state, 'info', 'Finished - nothing to migrate');
            } else {
                push(state, 'ok', 'Migration complete');
            }
            const summary = buildFinalSummary(event.data, state.alreadyMigrated);
            if (summary.length > 0) {
                state.finalSummary = summary;
                state.overlay = summary; // hold it on screen instead of the feed
            }
            break;
        }
        default:
            // Unmapped but harmless events are simply ignored in the feed.
            break;
    }
}

/** One error of the run, flattened out of the per-record map in the output. */
interface SummaryError {
    recordId: string;
    message: string;
    fixed: boolean;
    /** 'insert' or 'update'; empty for an output written before phases existed. */
    phase: string;
    /** The values the failing pass was writing, where the output recorded them. */
    fields?: Record<string, any>;
}

/** Beyond this the section stops being a summary; the rest stays in the feed. */
const MAX_LISTED_ERRORS = 10;

/**
 * The screen shown once the migration finishes: what went wrong, and the IDs the
 * user asked to migrate next to the IDs they became in the target org. The plain
 * UI prints its own version of this as part of its `finished` output; the TUI
 * would otherwise scroll it away with the rest of the feed, so it is pinned as an
 * overlay instead.
 *
 * The errors come first, ahead of the mapping: this screen is all most users
 * read, and a failure they have to scroll past a list of ids to find is a
 * failure they will miss.
 *
 * `alreadyMigrated` is set when the run had nothing left to do. This screen has
 * to say that up front too - otherwise a list of target ids under "Migration
 * complete" reads as though this run created them.
 */
export function buildFinalSummary(data: unknown, alreadyMigrated?: Record<string, number> | null): string[] {
    let parsed: { requestedRecords?: Record<string, string>, errors?: Record<string, any[]> } | null;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : (data as typeof parsed);
    } catch {
        return [];
    }
    const requested = parsed?.requestedRecords ?? {};
    const ids = Object.keys(requested);
    const errors = collectErrors(parsed?.errors);
    if (ids.length === 0 && errors.length === 0) return [];

    const unresolved = errors.filter(error => !error.fixed);
    const lines: string[] = [];
    if (alreadyMigrated) {
        lines.push(ansi.boldOn(ansi.yellow('Nothing to migrate')), '', ...nothingToMigrateNote(alreadyMigrated));
    } else if (unresolved.length > 0) {
        const what = unresolved.length === 1 ? 'error' : 'errors';
        lines.push(ansi.boldOn(ansi.yellow(`⚠ Migration complete with ${unresolved.length} unresolved ${what}`)), '');
    } else {
        lines.push(ansi.boldOn(ansi.green('✓ Migration complete')), '');
    }

    lines.push(...errorSection(errors, unresolved));

    if (ids.length > 0) {
        const idWidth = Math.max(...ids.map(id => id.length));
        const migrated = ids.filter(id => requested[id]).length;
        const note = alreadyMigrated ? 'migrated earlier' : 'migrated';
        lines.push(`${ansi.boldOn('Requested records')} ${ansi.gray(`(${migrated}/${ids.length} ${note})`)}`, '');
        for (const id of ids) {
            const newId = requested[id];
            lines.push(`  ${id.padEnd(idWidth)} ${ansi.gray('→')} ` +
                (newId ? ansi.green(newId) : ansi.yellow('(not migrated)')));
        }
    }
    return lines;
}

/** Flattens the output's `{ recordId: [error, ...] }` map into one row per error. */
function collectErrors(errors?: Record<string, any[]>): SummaryError[] {
    const flattened: SummaryError[] = [];
    for (const [recordId, recordErrors] of Object.entries(errors ?? {})) {
        for (const error of recordErrors ?? []) {
            flattened.push({
                recordId,
                message: firstLine(error?.message) || 'unknown error',
                fixed: error?.fixed === true,
                phase: typeof error?.phase === 'string' ? error.phase : '',
                fields: error?.fields && typeof error.fields === 'object' ? error.fields : undefined
            });
        }
    }
    return flattened;
}

/**
 * Counts every error the run reported but lists only the unresolved ones: an
 * error a solver fixed needs no attention, and saying how many were fixed is
 * enough to explain why the activity log has more of them than this list.
 */
function errorSection(errors: SummaryError[], unresolved: SummaryError[]): string[] {
    if (errors.length === 0) return [];

    const fixed = errors.length - unresolved.length;
    const counts = [`${unresolved.length} unresolved`];
    if (fixed > 0) {
        counts.push(`${fixed} fixed`);
    }
    const lines = [`${ansi.boldOn('Errors')} ${ansi.gray(`(${counts.join(', ')})`)}`];

    const listed = unresolved.slice(0, MAX_LISTED_ERRORS);
    if (listed.length > 0) {
        lines.push('');
    }
    const idWidth = Math.max(0, ...listed.map(error => error.recordId.length));
    const phaseWidth = Math.max(0, ...listed.map(error => error.phase.length));
    for (const error of listed) {
        // Pad before coloring - escape codes are invisible but not zero-length.
        const phase = phaseWidth > 0 ? `${ansi.gray(error.phase.padEnd(phaseWidth))} ` : '';
        lines.push(`  ${ansi.yellow(error.recordId.padEnd(idWidth))} ${phase}${error.message}`);
        // The payload the org rejected, indented under its message: which field held
        // the bad value is the first thing anyone reading this list wants to know.
        const attempted = formatAttemptedValues(error.fields);
        if (attempted) {
            lines.push(`  ${' '.repeat(idWidth)} ${phaseWidth > 0 ? ' '.repeat(phaseWidth + 1) : ''}${ansi.gray(attempted)}`);
        }
    }
    if (unresolved.length > listed.length) {
        lines.push(ansi.gray(`  … and ${unresolved.length - listed.length} more in the activity log`));
    }
    lines.push('');
    return lines;
}

/** The note under the headline, or nothing at all when there is none to give. */
function nothingToMigrateNote(alreadyMigrated: Record<string, number>): string[] {
    const total = Object.values(alreadyMigrated).reduce((sum, n) => sum + n, 0);
    if (total === 0) {
        return [];
    }
    const record = total === 1 ? 'record was' : 'records were';
    return [ansi.gray(`${total} ${record} migrated earlier (${formatTypeCounts(alreadyMigrated)}).`), ''];
}

const ATTEMPTED_VALUES_CAP = 160;

/**
 * `Field=value, Field=value` for the feed, kept short enough to stay on one line -
 * the log file has the untrimmed payload for anything this cuts off.
 */
function formatAttemptedValues(fields?: Record<string, any>): string {
    if (!fields || typeof fields !== 'object') return '';
    const pairs = Object.entries(fields)
        .filter(([field]) => field !== 'Id')
        .map(([field, value]) => `${field}=${value === '' ? "''" : firstLine(String(value))}`);
    if (pairs.length === 0) return '';
    const text = pairs.join(', ');
    return text.length > ATTEMPTED_VALUES_CAP ? `${text.slice(0, ATTEMPTED_VALUES_CAP - 1)}…` : text;
}

/** A feed entry is one line: keep the first line of a multi-line error message. */
function firstLine(text?: string): string {
    if (typeof text !== 'string') return '';
    return text.split('\n')[0].trim();
}

export function formatTypeCounts(recordCountsByType?: Record<string, number>): string {
    if (!recordCountsByType) return '';
    return Object.entries(recordCountsByType)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
}
