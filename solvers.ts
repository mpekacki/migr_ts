import { Schema, SObjectRecord } from 'jsforce';
import IO from './io';
import { BackoffSolver, FallbackSolver, RetrySolver, SolverType } from './config';
import { SaveError } from './salesforce-client';

export interface SolverOutcome {
    solver?: SolverType;
    errorFixed: boolean;
    retry: boolean;
    matchedId?: string;
}

/** Which pass of the migration an error came from. */
export type SolverPhase = 'insert' | 'update';

/** What applySolver needs from the run in order to act on a record. */
export interface SolverContext {
    io: IO;
    /**
     * The pass the error came from. Both hand their failures to the same solvers,
     * but not every action means something in both: see appliesInPhase.
     */
    phase: SolverPhase;
    solvers?: SolverType[];
    /** Solvers already tried for this record and this message, so each is used once. */
    usedSolvers: (SolverType | undefined)[];
    /** Sets a field - on insert, stashing the old value for the update pass that follows. */
    setField(field: string, value: string | null): void;
    /** What that pass has stashed for this record so far, for reporting. Insert only. */
    stashedFields?(): SObjectRecord<Schema, string>;
}

/**
 * A match solver resolves an insert by naming a record that is already in the
 * target, so the run can point at it instead of creating one. An update has no
 * such way out - the record it is addressed to is the one the run created - so a
 * match solver is passed over there, leaving the error to a solver that can act
 * on it.
 */
function appliesInPhase(solver: SolverType, phase: SolverPhase): boolean {
    return phase === 'insert' || solver.action !== 'match';
}

/**
 * Applies the first configured solver whose pattern matches a save error and
 * that this record has not already been through, mutating the record where the
 * solver says to. An unmatched error comes back unfixed for the caller to hand
 * to the user (or, in fullAuto and in the update pass, to record and move on).
 */
export function applySolver(
    recordId: string,
    record: SObjectRecord<Schema, string>,
    e: SaveError,
    ctx: SolverContext
): SolverOutcome {
    const result: SolverOutcome = { errorFixed: false, retry: false };
    if (!ctx.solvers) {
        return result;
    }
    if (ctx.usedSolvers.length > 0) {
        ctx.io.skippingPreviouslyUsedSolvers(ctx.usedSolvers);
    }
    const solver = ctx.solvers.find(solver => appliesInPhase(solver, ctx.phase)
        && new RegExp(solver.message).test(e.message)
        && !ctx.usedSolvers.includes(solver));
    if (!solver) {
        return result;
    }
    result.solver = solver;
    if (solver.action === 'fix') {
        for (const changeField of solver.changeFields) {
            ctx.setField(changeField.field, changeField.value);
        }
        ctx.io.fixingUsingSolver(e.message, solver.message, solver.action);
        const stashed = ctx.stashedFields?.();
        if (stashed) {
            ctx.io.savedOldFieldsInToUpdateLater(stashed);
        }
        result.errorFixed = true;
        result.retry = true;
    } else if (solver.action === 'skip') {
        ctx.io.skippingRecordUsingSolver(recordId, solver.message);
        result.errorFixed = true;
    } else if (solver.action === 'match') {
        const matchId = new RegExp(solver.message).exec(e.message)?.[1];
        if (matchId) {
            // Only report the match once it actually produced an id - a solver
            // whose pattern captures nothing leaves the error unresolved.
            ctx.io.matchingRecordUsingSolver(recordId, solver.message);
            result.matchedId = matchId;
            result.errorFixed = true;
        }
    } else if (solver.action === 'extract_column') {
        ctx.io.extractingColumnFromError(e.message, solver.message);
        let columnName;
        if (solver.fromFields) {
            columnName = e.fields[0];
        } else {
            columnName = new RegExp(solver.message).exec(e.message)?.[1];
        }
        if (columnName) {
            ctx.setField(columnName, solver.replaceWith);
            result.errorFixed = true;
            result.retry = true;
        }
    } else if (solver.action === 'append_random') {
        ctx.io.appendingRandomToRecord(recordId, solver.message);
        for (const changeField of solver.changeFields) {
            record[changeField.field] = record[changeField.field] + '.' + Math.random().toString(36).substring(2, 2 + changeField.length);
        }
        result.errorFixed = true;
        result.retry = true;
    }
    return result;
}

/**
 * The other half of the solver system: errors thrown by the API call itself
 * rather than reported per record in its results. Only the solvers that act on
 * a whole operation apply here - retry, backoff and fallback. Anything else
 * rethrows for the caller to deal with.
 */
export async function handleJsforceError(
    error: any,
    context: string,
    io: IO,
    solvers: SolverType[] | undefined,
    retryOperation?: () => Promise<any>
): Promise<{ success: boolean, result?: any, shouldSkip?: boolean }> {
    const errorMessage = error.message || error.toString();

    const solver = solvers?.find(solver => new RegExp(solver.message).test(errorMessage));

    if (solver) {
        if (solver.action === 'retry') {
            const retrySolver = solver as RetrySolver;
            const maxAttempts = retrySolver.maxAttempts || 3;
            const delay = retrySolver.delay || 1000;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    if (delay > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    io.error(`Retrying ${context} (attempt ${attempt}/${maxAttempts})`);
                    const result = await retryOperation!();
                    return { success: true, result };
                } catch {
                    if (attempt === maxAttempts) {
                        return { success: false };
                    }
                }
            }
        } else if (solver.action === 'backoff') {
            const backoffSolver = solver as BackoffSolver;
            const maxAttempts = backoffSolver.maxAttempts || 3;
            const initialDelay = backoffSolver.initialDelay || 1000;
            const multiplier = backoffSolver.backoffMultiplier || 2;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const delay = initialDelay * Math.pow(multiplier, attempt - 1);
                    if (delay > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    io.error(`Retrying ${context} with backoff (attempt ${attempt}/${maxAttempts}, delay: ${delay}ms)`);
                    const result = await retryOperation!();
                    return { success: true, result };
                } catch {
                    if (attempt === maxAttempts) {
                        return { success: false };
                    }
                }
            }
        } else if (solver.action === 'fallback') {
            const fallbackSolver = solver as FallbackSolver;
            io.error(`Fallback action for ${context}: ${fallbackSolver.fallbackAction}`);
            if (fallbackSolver.fallbackAction === 'skip') {
                return { success: false, shouldSkip: true };
            } else if (fallbackSolver.fallbackAction === 'log_and_continue') {
                io.error(`Continuing despite error in ${context}: ${errorMessage}`);
                return { success: false, shouldSkip: false };
            }
        }
    }

    throw error;
}
