import * as fs from 'fs';
import * as path from 'path';
import { Options } from './config';

/**
 * The source-id -> target-id map for a run, persisted to
 * `{targetOrg}__history.json` so a repeat run skips what already landed and
 * points new lookups at the records it created last time.
 *
 * A file or SQLite export has no target org whose ids would be worth
 * remembering, so it neither reads nor writes the file - the map still tracks
 * the run in memory, it just does not outlive it.
 *
 * The file is the whole map, so writing it costs as much as the history is long.
 * Writing it for every settled record made a 200-record chunk rewrite the file
 * 200 times, stalling the run for seconds once the history grew. `settle` writes
 * at most once every SAVE_INTERVAL_MS instead, and a timer catches up on what
 * the last write left out. The process exiting writes whatever is still pending,
 * so an interrupted run loses nothing a normal exit would have kept.
 */
export default class MigrationHistory {
    private readonly filePath: string;
    private readonly persist: boolean;
    private readonly old2new: Record<string, string> = {};
    /** Settled mappings not yet in the file. */
    private dirty = false;
    private lastSave = 0;
    private saveTimer: NodeJS.Timeout | null = null;
    /**
     * A write the timer attempted and failed. It has no caller to throw to, so
     * the next settle or save throws it instead - the run must not carry on
     * believing it can be resumed.
     */
    private pendingError: unknown = null;
    private readonly saveOnExit = () => {
        if (this.dirty) {
            try {
                this.write();
            } catch {
                // Nothing left to report it to - the process is already going.
            }
        }
    };

    constructor(options: Options, isMigrateToFile: boolean) {
        this.filePath = resolveFilePath(options);
        this.persist = !isMigrateToFile;
        if (this.persist) {
            // Created up front rather than at the first write: that first write is
            // `settle`, long after the run has started inserting into the target
            // org, so a missing directory would fail the run with records already
            // migrated and no history file to resume from.
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        }
        if (this.persist && fs.existsSync(this.filePath)) {
            Object.assign(this.old2new, JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>);
        }
    }

    has(recordId: string): boolean {
        return recordId in this.old2new;
    }

    get(recordId: string): string {
        return this.old2new[recordId];
    }

    /** Every source id migrated so far, including the ones loaded from the file. */
    ids(): string[] {
        return Object.keys(this.old2new);
    }

    /** The whole map, for the run's final report. */
    all(): Record<string, string> {
        return this.old2new;
    }

    /**
     * Remembers a mapping without touching the file. Used for records that were
     * never inserted (not queryable, malformed id) - they matter to this run's
     * reference resolution but are not something a later run should skip.
     */
    remember(recordId: string, newRecordId: string): void {
        this.old2new[recordId] = newRecordId;
    }

    /**
     * Remembers a mapping and gets it into the file, so an interrupted run resumes
     * from it - right away if the file has not been written for SAVE_INTERVAL_MS,
     * otherwise as soon as that interval is up.
     */
    settle(recordId: string, newRecordId: string): void {
        this.remember(recordId, newRecordId);
        if (!this.persist) {
            return;
        }
        if (!this.dirty) {
            this.dirty = true;
            process.on('exit', this.saveOnExit);
        }
        // Only once the record is pending, so a run that fails here still has
        // the exit write's chance of getting it into the file.
        this.throwPendingError();
        const wait = this.lastSave + SAVE_INTERVAL_MS - Date.now();
        if (wait <= 0) {
            this.save();
        } else if (!this.saveTimer) {
            this.saveTimer = setTimeout(() => {
                this.saveTimer = null;
                try {
                    this.flush();
                } catch (error) {
                    this.pendingError = error;
                }
            }, wait);
            // A pending write must not keep the process alive - exiting writes it.
            this.saveTimer.unref();
        }
    }

    /** Writes the file if anything settled since it was last written. */
    flush(): void {
        if (this.dirty) {
            this.save();
        }
    }

    /** Writes the file now, whether or not anything is pending. */
    save(): void {
        this.throwPendingError();
        if (this.persist) {
            this.write();
        }
    }

    private write(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        fs.writeFileSync(this.filePath, JSON.stringify(this.old2new, null, 2));
        this.lastSave = Date.now();
        if (this.dirty) {
            this.dirty = false;
            process.removeListener('exit', this.saveOnExit);
        }
    }

    private throwPendingError(): void {
        if (this.pendingError) {
            const error = this.pendingError;
            this.pendingError = null;
            throw error;
        }
    }
}

/**
 * How often, at most, settling records rewrites the history file. Long enough
 * that a chunk's worth of records costs one write rather than one each, short
 * enough that the file is never far behind the target org.
 */
const SAVE_INTERVAL_MS = 1000;

/**
 * historyFilePath may name the file itself or the directory to put it in; a path
 * that does not exist yet is read as a directory only if it ends in a separator.
 * Both separators count on Windows - a config written with '/' is the usual way
 * to name a directory there, and taking it for a file name would quietly write a
 * file called `history` where `history/` was asked for.
 */
function resolveFilePath(options: Options): string {
    if (!options.historyFilePath) {
        return path.join(process.cwd(), `${options.targetOrg}__history.json`);
    }
    const stats = fs.existsSync(options.historyFilePath) ? fs.statSync(options.historyFilePath) : null;
    const namesADirectory = options.historyFilePath.endsWith(path.sep) || options.historyFilePath.endsWith('/');
    if ((stats && stats.isDirectory()) || (!stats && namesADirectory)) {
        return path.join(options.historyFilePath, `${options.targetOrg}__history.json`);
    }
    return options.historyFilePath;
}
