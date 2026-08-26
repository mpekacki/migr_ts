import * as fs from 'fs';
import { Options } from './config';
import IO from './io';
import { ApexExecutionResult, SalesforceClient } from './salesforce-client';

/** Which side of the migration a script runs on. */
export type ApexPhase = 'before' | 'after';

/**
 * The Anonymous Apex a run executes in the target org on either side of the
 * migration: `apex.beforeMigration` before the first record is inserted,
 * `apex.afterMigration` once the last one has landed and the deferred updates
 * are done. This is the "switch the triggers off, rebuild the rollups
 * afterwards" step around a migration.
 *
 * Three things bound when they run. They run in the *target* org, so a file or
 * SQLite export - which has no target org, only a source client standing in for
 * one - cannot have them. They run only once the migration is confirmed, so
 * nothing touches the target org while the user is still deciding, and only if
 * the run has something to migrate at all: scripts bracket what a run writes,
 * and a run that writes nothing has nothing to bracket.
 *
 * And they run as a *pair*. A before script that switched automation off has an
 * after script that switches it back on, so once the before phase has run the
 * after phase must run too - down every way out of the migration, an abandoned
 * one included. That is what `armed` is for: `runAfter` is a no-op until
 * `runBefore` has committed the run to the target org, and unconditional after
 * that.
 */
export default class ApexScripts {
    private armed = false;

    constructor(
        private readonly io: IO,
        private readonly options: Options,
        private readonly client: SalesforceClient
    ) {}

    /**
     * Runs the before phase and arms the after phase. Called only once the run is
     * about to write to the target org.
     */
    async runBefore(): Promise<void> {
        this.armed = true;
        await this.run('before');
    }

    /** Runs the after phase, if the before phase committed the run to the target org. */
    async runAfter(): Promise<void> {
        if (!this.armed) {
            return;
        }
        await this.run('after');
    }

    private async run(phase: ApexPhase): Promise<void> {
        const paths = phaseScriptPaths(this.options, phase);
        for (let i = 0; i < paths.length; i++) {
            const filePath = paths[i];
            this.io.runningApexScript(phase, filePath, i + 1, paths.length);
            const result = await this.client.executeAnonymous(fs.readFileSync(filePath, 'utf8'));
            const failure = failureOf(result);
            if (failure) {
                this.io.apexScriptFailed(phase, filePath, failure, result);
                throw new Error(`Apex script ${filePath} (apex.${phase === 'before' ? 'beforeMigration' : 'afterMigration'}) failed: ${failure}`);
            }
            this.io.apexScriptDone(phase, filePath);
        }
    }
}

function phaseScriptPaths(options: Options, phase: ApexPhase): string[] {
    return (phase === 'before' ? options.apex?.beforeMigration : options.apex?.afterMigration) ?? [];
}

/** Every configured script, in the order the run would execute them. */
export function apexScriptPaths(options: Options): string[] {
    return [...phaseScriptPaths(options, 'before'), ...phaseScriptPaths(options, 'after')];
}

/**
 * Rejects a configuration the run could never honour, before it has done any
 * work: a mistyped path is worth hearing about now and not after a long fetch
 * and a confirmation prompt.
 */
export function validateApexOptions(options: Options, isMigrateToFile: boolean): void {
    const paths = apexScriptPaths(options);
    if (paths.length === 0) {
        return;
    }
    if (isMigrateToFile) {
        throw new Error('Apex scripts run in the target org, so apex.beforeMigration/apex.afterMigration cannot be combined with targetFile or targetSqlite');
    }
    const missing = paths.filter(filePath => !fs.existsSync(filePath));
    if (missing.length > 0) {
        throw new Error(`Apex script${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`);
    }
}

/** Why a script failed, or null when it ran through. */
function failureOf(result: ApexExecutionResult): string | null {
    if (!result.compiled) {
        // The Tooling API reports -1 for both when the problem has no position.
        const at = result.line >= 0 ? ` (line ${result.line}, column ${result.column})` : '';
        return `${result.compileProblem ?? 'the script did not compile'}${at}`;
    }
    if (!result.success) {
        return result.exceptionMessage ?? 'the script threw an exception';
    }
    return null;
}
