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
 */
export default class MigrationHistory {
    private readonly filePath: string;
    private readonly persist: boolean;
    private readonly old2new: Record<string, string> = {};

    constructor(options: Options, isMigrateToFile: boolean) {
        this.filePath = resolveFilePath(options);
        this.persist = !isMigrateToFile;
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

    /** Remembers a mapping and writes the file, so an interrupted run resumes from it. */
    settle(recordId: string, newRecordId: string): void {
        this.remember(recordId, newRecordId);
        this.save();
    }

    save(): void {
        if (this.persist) {
            fs.writeFileSync(this.filePath, JSON.stringify(this.old2new, null, 2));
        }
    }
}

/**
 * historyFilePath may name the file itself or the directory to put it in; a path
 * that does not exist yet is read as a directory only if it ends in a separator.
 */
function resolveFilePath(options: Options): string {
    if (!options.historyFilePath) {
        return path.join(process.cwd(), `${options.targetOrg}__history.json`);
    }
    const stats = fs.existsSync(options.historyFilePath) ? fs.statSync(options.historyFilePath) : null;
    if ((stats && stats.isDirectory()) || (!stats && options.historyFilePath.endsWith(path.sep))) {
        return path.join(options.historyFilePath, `${options.targetOrg}__history.json`);
    }
    return options.historyFilePath;
}
