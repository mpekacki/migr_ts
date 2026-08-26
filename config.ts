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
    fullAuto?: {
        enabled: boolean;
        unhandledErrorBehavior: 'skip' | 'saveAndExit';
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

export {
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
