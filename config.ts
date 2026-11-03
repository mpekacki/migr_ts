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
    /** The records the migration starts from. */
    recordIds?: string[];
    /**
     * SOQL queries run against the source org at the start of the run; every id
     * they return is a starting record, exactly as if it were in `recordIds` (the
     * two combine). Each query has to select Id. Needs a source org, so it is
     * refused next to `sourceFile`/`sourceSqlite`.
     */
    recordQueries?: string[];
    relatedRecordDepthLimit: number;
    maxConcurrentRequests?: number;
    /**
     * How many batches of records (up to 200 each) are sent to the target org at
     * once, by the insert pass and by the update pass that follows it. Defaults to
     * 1, one batch at a time. The results of every batch sent together are in hand
     * before any of them is dealt with, and they are dealt with in order - solvers
     * and prompts never run concurrently.
     */
    maxConcurrentBatches?: number;
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
    /**
     * Fields that name another record by a value of their own rather than by its
     * id - a UUID or other business key both records carry. A fetched record of
     * the keyed type has `field` read, and every `sObjectType` record whose
     * `matchField` holds the same value is fetched too - and, with
     * `includeChildren`, the other way round as well. The value itself goes
     * across unchanged, so nothing has to be remapped once both have arrived.
     */
    valueLookups?: {
        [sObjectType: string]: ValueLookup[];
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
        /**
         * Run after the migration is confirmed, before the first record is inserted.
         * A failing script is put to the user - retry, skip or abort - unless
         * `fullAuto.enabled`, where it fails the run.
         */
        beforeMigration?: string[];
        /** Run once every record has been inserted and the deferred updates are done. */
        afterMigration?: string[];
    };
    /**
     * Where the run keeps the records it fetched until they are migrated. In
     * memory by default; `sqlite` keeps them in a scratch database on disk
     * instead, for record sets too large to hold in memory.
     */
    recordStore?: {
        /** Defaults to 'memory'. */
        type?: 'memory' | 'sqlite';
        /**
         * The database file. Defaults to `{targetOrg}__records.{timestamp}.db` next
         * to the history file. Must not exist yet - a run never reuses a store.
         */
        path?: string;
        /** Leave the database behind when the run ends, for inspection. Defaults to false. */
        keep?: boolean;
        /**
         * Encrypt every record with AES-256-GCM. The key is random and lives only
         * as long as the run, unless MIGR_TS_STORE_KEY supplies a passphrase to
         * derive it from. Defaults to false.
         */
        encrypt?: boolean;
    };
}

interface ValueLookup {
    /** The field of the record being fetched that holds the value. */
    field: string;
    /** The SObject to look the value up in. */
    sObjectType: string;
    /** The field of `sObjectType` the value is looked for in. */
    matchField: string;
    /**
     * Follow the value back as well, like a child relationship: a fetched
     * `sObjectType` record has `matchField` read, and every record of the keyed
     * type whose `field` holds the same value is fetched too. Like
     * `relationships`, and unlike the lookup itself, this stops at
     * `relatedRecordDepthLimit`. Defaults to false.
     */
    includeChildren?: boolean;
}

interface Solver {
    message: string;
    /**
     * Compare `message` to the whole error text literally instead of compiling it
     * as a regular expression. For the message that carries regex punctuation of
     * its own, and for the one that is a prefix of another message the solver
     * must not act on.
     */
    exact?: boolean;
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

/**
 * Rejects a solver that could never act. An exact solver has no pattern, so it
 * has no capture group either, and reading a value out of one is the whole of
 * what `match` and `extract_column` do - the exception being an
 * `extract_column` that takes the column off the error's `fields` instead.
 * Left alone the combination matches errors and then resolves none of them,
 * which is worth hearing about before the run rather than in the middle of it.
 */
function validateSolverOptions(options: Options): void {
    for (const solver of options.solvers ?? []) {
        if (!solver.exact) {
            continue;
        }
        if (solver.action === 'match') {
            throw new Error(`A 'match' solver reads the id it matches on out of a capture group, so it cannot be exact: '${solver.message}'`);
        }
        if (solver.action === 'extract_column' && !solver.fromFields) {
            throw new Error(`An 'extract_column' solver reads the column name out of a capture group, so it cannot be exact unless it takes the column from the error's fields (fromFields): '${solver.message}'`);
        }
    }
}

/**
 * Rejects record queries the run could not run. A file source has no org to
 * query, and the records it loads are all migrated anyway - a query there would
 * be quietly ignored, which is worse than refused.
 */
function validateRecordQueryOptions(options: Options, isMigrateFromFile: boolean): void {
    const queries = options.recordQueries;
    if (queries === undefined) {
        return;
    }
    if (!Array.isArray(queries) || queries.some(query => typeof query !== 'string' || query.trim() === '')) {
        throw new Error('recordQueries must be a list of SOQL queries');
    }
    if (isMigrateFromFile && queries.length > 0) {
        throw new Error('recordQueries need a source org to query, so they cannot be used with sourceFile or sourceSqlite');
    }
}

/**
 * Rejects a batch limit the run could not honour. Anything but a positive whole
 * number would either send nothing at all or be rounded into a limit the user
 * did not write.
 */
function validateBatchOptions(options: Options): void {
    const limit = options.maxConcurrentBatches;
    if (limit === undefined) {
        return;
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        throw new Error(`maxConcurrentBatches must be a positive whole number, not ${JSON.stringify(limit)}`);
    }
}

export {
    validateBatchOptions,
    validateFullAutoOptions,
    validateSolverOptions,
    validateRecordQueryOptions,
    Options,
    ValueLookup,
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
