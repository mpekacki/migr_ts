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
 * after script that switches it back on, so once the target org has been
 * touched the after phase must run too - down every way out of the migration,
 * an abandoned one included. That is what `armed` is for: `runAfter` is a no-op
 * until the run has changed the target org, and unconditional after that. The
 * org counts as changed once a before script has succeeded, or once the before
 * phase is over and the run goes on to write records. A failed script does not
 * count: Anonymous Apex that fails is rolled back.
 *
 * A failing before script is put to the user - nothing has been migrated yet, and
 * the fix is often an edit to the file - who can retry it (the file is read again),
 * skip it or abort the migration, and when aborting decides whether the after
 * scripts run: only the user knows whether the before scripts that did run left
 * anything to undo. With `fullAuto.enabled` there is no one to ask and the
 * failure is fatal. A failing after script is always fatal: the migration
 * is over by then, and the runner writes its report before letting the failure out.
 */
export default class ApexScripts {
    private armed = false;

    constructor(
        private readonly io: IO,
        private readonly options: Options,
        private readonly client: SalesforceClient
    ) {}

    /**
     * Runs the before phase. Called only once the run is about to write to the
     * target org. Resolves to false when the user aborts the migration at a failing
     * script; the after phase is then armed if, and only if, the user asked for the
     * after scripts to run.
     */
    async runBefore(): Promise<boolean> {
        const paths = phaseScriptPaths(this.options, 'before');
        const ranScripts: string[] = [];
        for (let i = 0; i < paths.length; i++) {
            const filePath = paths[i];
            let done = false;
            while (!done) {
                const failure = await this.execute('before', filePath, i + 1, paths.length);
                if (!failure) {
                    this.armed = true;
                    ranScripts.push(filePath);
                    done = true;
                    continue;
                }
                if (this.options.fullAuto?.enabled) {
                    throw scriptError('before', filePath, failure);
                }
                const action = await this.askWhatToDo(filePath, failure, ranScripts);
                if (action === 'abort' || action === 'abortWithAfter') {
                    this.armed = action === 'abortWithAfter';
                    return false;
                }
                if (action === 'skip') {
                    this.io.apexScriptSkipped('before', filePath);
                    done = true;
                }
            }
        }
        // The run goes on to write records, which the after phase has to close out.
        this.armed = true;
        return true;
    }

    /** Runs the after phase, if the run has changed the target org. */
    async runAfter(): Promise<void> {
        if (!this.armed) {
            return;
        }
        const paths = phaseScriptPaths(this.options, 'after');
        for (let i = 0; i < paths.length; i++) {
            const failure = await this.execute('after', paths[i], i + 1, paths.length);
            if (failure) {
                throw scriptError('after', paths[i], failure);
            }
        }
    }

    /**
     * Runs one script and reports how it went: null when it ran through, the reason
     * otherwise. The file is read on every call, so a retry picks up an edit.
     */
    private async execute(phase: ApexPhase, filePath: string, index: number, total: number): Promise<string | null> {
        this.io.runningApexScript(phase, filePath, index, total);
        const result = await this.client.executeAnonymous(fs.readFileSync(filePath, 'utf8'));
        const failure = failureOf(result);
        if (failure) {
            this.io.apexScriptFailed(phase, filePath, failure, result);
            return failure;
        }
        this.io.apexScriptDone(phase, filePath);
        return null;
    }

    /**
     * `ranScripts` are the before scripts that have already changed the org, so the
     * user can tell whether aborting leaves anything for the after scripts to undo.
     * `ar` (abort and run the after scripts) is an answer only when there are after
     * scripts to run.
     */
    private async askWhatToDo(filePath: string, failure: string, ranScripts: string[]): Promise<'retry' | 'skip' | 'abort' | 'abortWithAfter'> {
        const hasAfterScripts = phaseScriptPaths(this.options, 'after').length > 0;
        for (;;) {
            const answer = (await this.io.askApexScriptAction('before', filePath, failure, [...ranScripts], hasAfterScripts)).trim().toLowerCase();
            switch (answer) {
                case 'r': return 'retry';
                case 's': return 'skip';
                case 'a': return 'abort';
                case 'ar':
                    if (hasAfterScripts) {
                        return 'abortWithAfter';
                    }
                    this.io.invalidInput(answer);
                    break;
                default: this.io.invalidInput(answer);
            }
        }
    }
}

function scriptError(phase: ApexPhase, filePath: string, failure: string): Error {
    return new Error(`Apex script ${filePath} (apex.${phase === 'before' ? 'beforeMigration' : 'afterMigration'}) failed: ${failure}`);
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
