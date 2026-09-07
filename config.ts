/**
 * The shape of the config file passed to the CLI with -c.
 *
 * These types describe user-authored JSON, not engine internals, so they live
 * apart from app.ts: the IO and UI layers need Options without depending on the
 * migration engine.
 */

interface Options {
    sourceOrg?: string;
    sourceFile?: string;
    sourceSqlite?: string;
    targetOrg: string;
    sourceOrgUrl?: string;
    sourceOrgToken?: string;
    targetOrgUrl?: string;
    targetOrgToken?: string;
    targetFile?: string;
    targetSqlite?: string;
    historyFilePath?: string;
    recordIds: string[];
    relatedRecordDepthLimit: number;
    maxConcurrentRequests?: number;
    matchers: {
        sObjectType: string;
        fieldMappings: {
            sourceField: string;
            targetField: string;
        }[];
        whenMissing: 'skip' | 'create';
    }[];
    relationships: {
        [sObjectType: string]: {
            name: string;
        }[];
    };
    solvers: SolverType[];
    /** Which of the run's prompts to answer without the user. */
    fullAuto?: {
        /** Run without any interactive prompt at all. Implies `skipConfirmation`. */
        enabled?: boolean;
        /**
         * Skip only the confirmation prompt. An error no solver handles still
         * goes to the user, unlike `enabled`.
         */
        skipConfirmation?: boolean;
        /** What `enabled` does with an error no solver handles. Required with `enabled`. */
        unhandledErrorBehavior?: 'skip' | 'saveAndExit';
    };
    anonymization?: {
        emailFields?: {
            mode: 'obfuscate' | 'sanitize';
            template?: string;
        };
    };
    files?: {
        /** Defaults to true. Turn off to migrate file records without their contents. */
        enabled?: boolean;
        /** Files larger than this are migrated without their contents. Defaults to 25. */
        maxFileSizeMb?: number;
    };
    /**
     * Anonymous Apex to run in the target org around the migration. Each entry is
     * the path of a file holding one script, and the scripts of a phase run in the
     * order they are listed.
     */
    apex?: {
        /** Run after the migration is confirmed, before the first record is inserted. */
        beforeMigration?: string[];
        /** Run once every record has been inserted and the deferred updates are done. */
        afterMigration?: string[];
    };
}

interface Solver {
    message: string;
    hideError?: boolean;
}

interface FixSolver extends Solver {
    action: 'fix';
    changeFields: {
        field: string;
        value: string;
    }[];
}

interface SkipSolver extends Solver {
    action: 'skip';
}

interface MatchSolver extends Solver {
    action: 'match';
}

interface ExtractSolver extends Solver {
    action: 'extract_column';
    replaceWith: string | null;
    fromFields?: boolean;
}

interface AppendRandomSolver extends Solver {
    action: 'append_random';
    changeFields: {
        field: string;
        length: number;
    }[];
}

interface RetrySolver extends Solver {
    action: 'retry';
    maxAttempts?: number;
    delay?: number; // milliseconds
}

interface BackoffSolver extends Solver {
    action: 'backoff';
    maxAttempts?: number;
    initialDelay?: number; // milliseconds
    backoffMultiplier?: number;
}

interface FallbackSolver extends Solver {
    action: 'fallback';
    fallbackAction: 'skip' | 'log_and_continue';
}

type SolverType = FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver | RetrySolver | BackoffSolver | FallbackSolver;

const UNHANDLED_ERROR_BEHAVIORS = ['skip', 'saveAndExit'];

/**
 * Rejects a fullAuto block the run could not honour, before it has done any
 * work. `unhandledErrorBehavior` is what stands between the user and a run that
 * drops records on its own, so neither a misspelled value nor a missing one may
 * pass quietly for the `skip` the code would otherwise fall through to.
 */
function validateFullAutoOptions(options: Options): void {
    const fullAuto = options.fullAuto;
    if (fullAuto === undefined) {
        return;
    }
    const legal = UNHANDLED_ERROR_BEHAVIORS.map(behavior => `'${behavior}'`).join(' or ');
    if (fullAuto.unhandledErrorBehavior !== undefined && !UNHANDLED_ERROR_BEHAVIORS.includes(fullAuto.unhandledErrorBehavior)) {
        throw new Error(`fullAuto.unhandledErrorBehavior must be ${legal}, not '${fullAuto.unhandledErrorBehavior}'`);
    }
    if (fullAuto.enabled && fullAuto.unhandledErrorBehavior === undefined) {
        throw new Error(`fullAuto.enabled needs fullAuto.unhandledErrorBehavior (${legal}) to say what to do with an error no solver handles`);
    }
}

export {
    validateFullAutoOptions,
    Options,
    Solver,
    FixSolver,
    SkipSolver,
    MatchSolver,
    ExtractSolver,
    AppendRandomSolver,
    RetrySolver,
    BackoffSolver,
    FallbackSolver,
    SolverType,
};
