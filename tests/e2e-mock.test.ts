/**
 * Runs the shared e2e scenarios (e2e-scenarios.ts) against in-memory orgs.
 *
 * The migration itself is the real thing - the same `main()` entry point, the
 * same config, the same solvers and IO events - but both orgs are fakes (see
 * fake-salesforce-org.ts and fake-test-org-schema.ts), so this suite needs no
 * scratch orgs, no build, no authentication and no network. e2e.test.ts runs
 * the very same scenarios against real orgs and the built CLI.
 *
 * Two things are necessarily different from the live suite: the migration runs
 * in this process rather than as a `node bundle.js` child process, and "the app
 * was closed unexpectedly" is simulated by aborting the pending input request
 * instead of killing a process.
 */

import { expect, test } from '@jest/globals';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../app';
import { Options } from '../config';
import IOEvent from '../ioevent';
import { getFormatter } from '../ui/event-formatter';
import {
    E2EContext,
    FUSSY_FIELD_ERROR,
    InputHandler,
    MigrationRunResult,
    TestOrg,
    UNCOMPILABLE_APEX,
    cleanupMigrationArtifacts,
    createAccount,
    createBasicConfig,
    defaultMatchers,
    insertAccount,
    toMigrationRunResult,
    writeApexScript
} from './e2e-harness';
import { e2eScenarios } from './e2e-scenarios';
import { STORE_KEY_ENV, dumpRecordStore } from '../record-store';
import { FakeSalesforceOrg, createFakeClientFactory } from './fake-salesforce-org';
import { TARGET_ORG_ALIAS, createSourceOrg, createTargetOrg } from './fake-test-org-schema';

// The live suite prints everything the CLI writes to stdout. Here the whole run
// happens in-process, so the same firehose is opt-in.
const verbose = process.env.MIGR_TS_TEST_VERBOSE === '1';

function log(...args: any[]) {
    if (verbose) {
        console.log(...args);
    }
}

let sourceOrg: FakeSalesforceOrg;
let targetOrg: FakeSalesforceOrg;

beforeEach(() => {
    log(`starting test: ${expect.getState().currentTestName}`);
    // Every test gets a pair of empty orgs, so nothing leaks between tests.
    sourceOrg = createSourceOrg();
    targetOrg = createTargetOrg();
});

afterEach(() => {
    cleanupMigrationArtifacts(TARGET_ORG_ALIAS);
});

/** Adapts an in-memory org to the interface the scenarios are written against. */
class MockTestOrg implements TestOrg {
    constructor(private readonly org: FakeSalesforceOrg) {}

    get alias() {
        return this.org.alias;
    }

    get instanceUrl() {
        return this.org.instanceUrl;
    }

    get accessToken() {
        return this.org.accessToken;
    }

    async create(sObjectType: string, fields: any = {}) {
        const record = this.org.create(sObjectType, fields);
        log(record);
        return { id: record.id };
    }

    async createAll(sObjectType: string, records: any[]) {
        return records.map(fields => ({ id: this.org.create(sObjectType, fields).id }));
    }

    async update(sObjectType: string, changes: any) {
        this.org.update(sObjectType, changes);
    }

    async updateAll(sObjectType: string, records: any[]) {
        for (const record of records) {
            this.org.update(sObjectType, record);
        }
    }

    async delete(sObjectType: string, recordId: string) {
        this.org.delete(sObjectType, recordId);
    }

    async retrieve(sObjectType: string, recordId: string) {
        return this.org.retrieve(sObjectType, recordId);
    }

    async retrieveBlob(sObjectType: string, recordId: string, fieldName: string) {
        return this.org.retrieveBlob(sObjectType, recordId, fieldName);
    }

    async findIds(sObjectType: string, conditions: Record<string, any>) {
        return this.org.find(sObjectType, conditions).map(record => ({ Id: record.Id }));
    }

    async query(soql: string) {
        return this.org.query(soql);
    }
}

/** Raised in place of killing the CLI process when a scenario asks the app to exit. */
class SimulatedExit extends Error {}

/**
 * The record store every run gets unless its config names one - see the second
 * pass over the scenarios below.
 */
let defaultRecordStore: Options['recordStore'];

const DISK_RECORD_STORE: Options['recordStore'] = { type: 'sqlite', encrypt: true };

/** Record stores a run left in the working directory, which none should. */
function leftoverRecordStores(): string[] {
    const dirs = ['.', './custom_history_test_dir'].filter(dir => fs.existsSync(dir));
    return dirs.flatMap(dir => fs.readdirSync(dir).filter(file => file.includes('__records.')).map(file => `${dir}/${file}`));
}

async function runMigration(config: any, inputHandler: InputHandler = ['y'], outputFile?: string): Promise<MigrationRunResult> {
    const capturedOutput: IOEvent[] = [];
    const queuedInputs = Array.isArray(inputHandler) ? [...inputHandler] : null;
    // main.ts writes the same debug-formatted lines it prints to --output-file
    const formatter = getFormatter(true);
    const outputLines: string[] = [];
    let exitCalled = false;

    const onOutput = (event: IOEvent) => {
        log(formatter(event));
        capturedOutput.push(event);
        outputLines.push(formatter(event) + '\n');
    };

    const onInput = (event: IOEvent): Promise<string> => {
        capturedOutput.push(event);
        if (queuedInputs) {
            const input = queuedInputs.shift();
            if (input === undefined) {
                return Promise.reject(new Error(`Unexpected input request: type="${event.type}", data=${JSON.stringify(event.data)}`));
            }
            log(`sending input: ${input}`);
            return Promise.resolve(input);
        }
        return new Promise<string>((resolve, reject) => {
            const sendInput = (input: string) => {
                log(`sending input: ${input}`);
                resolve(input);
            };
            const exit = () => {
                exitCalled = true;
                reject(new SimulatedExit('app closed'));
            };
            try {
                const result = (inputHandler as Exclude<InputHandler, string[]>)(event, sendInput, exit);
                if (result && typeof result.then === 'function') {
                    result.catch(reject);
                }
            } catch (error) {
                reject(error);
            }
        });
    };

    try {
        const options = (defaultRecordStore && config.recordStore === undefined ? { ...config, recordStore: defaultRecordStore } : config) as Options;
        await main(options, onOutput, onInput, createFakeClientFactory([sourceOrg, targetOrg]));
    } catch (error) {
        if (!(error instanceof SimulatedExit)) {
            throw error;
        }
    } finally {
        if (outputFile) {
            fs.writeFileSync(outputFile, outputLines.join(''));
        }
    }

    return toMigrationRunResult(capturedOutput, exitCalled);
}

function createContext(): E2EContext {
    return {
        sourceOrg: new MockTestOrg(sourceOrg),
        targetOrg: new MockTestOrg(targetOrg),
        runMigration
    };
}

for (const e2eScenario of e2eScenarios) {
    test(e2eScenario.name, async () => {
        await e2eScenario.run(createContext());
    });
}

// Every scenario again, with the records in an encrypted database on disk. What
// the store hands back from there is a copy, so a change the engine makes to a
// record and forgets to write back is lost - which in memory, where the store
// hands back the record itself, nothing would notice.
describe('with the records stored on disk, encrypted', () => {
    beforeEach(() => {
        defaultRecordStore = DISK_RECORD_STORE;
    });

    afterEach(() => {
        defaultRecordStore = undefined;
        const leftovers = leftoverRecordStores();
        leftovers.forEach(file => fs.unlinkSync(file));
        expect(leftovers).toEqual([]);
    });

    for (const e2eScenario of e2eScenarios) {
        test(e2eScenario.name, async () => {
            await e2eScenario.run(createContext());
        });
    }
});

// The four tests below live here rather than in the shared scenarios because the
// failures they assert on are thrown errors: in this context that surfaces as a
// rejected main(), while the live CLI turns it into a FATAL line and a non-zero
// exit code - which the live harness reads as the run itself having failed.

test('a failing apex script before the migration stops it before anything is inserted', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        apex: { beforeMigration: [writeApexScript('before', [UNCOMPILABLE_APEX])] }
    }))).rejects.toThrow(/Apex script .* \(apex\.beforeMigration\) failed/);

    expect(targetOrg.records('Account')).toHaveLength(0);
});

test('a failing apex script after the migration is let out only once the run has finished', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        apex: { afterMigration: [writeApexScript('after', [UNCOMPILABLE_APEX])] }
    }))).rejects.toThrow(/Apex script .* \(apex\.afterMigration\) failed/);

    // The migration itself is untouched by the failing script: it ran to the end,
    // and the history file it leaves behind is what a re-run picks up.
    expect(targetOrg.records('Account')).toHaveLength(1);
    expect(Object.values(JSON.parse(fs.readFileSync(`${TARGET_ORG_ALIAS}__history.json`, 'utf8')))).toContain(targetOrg.records('Account')[0].Id);
});

test('apex scripts are refused for a file export, which has no target org to run them in', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration({
        sourceOrg: ctx.sourceOrg.alias,
        targetFile: './test-output.json',
        recordIds: [account.id],
        matchers: defaultMatchers,
        apex: { beforeMigration: [writeApexScript('before', [insertAccount('never runs')])] }
    })).rejects.toThrow(/cannot be combined with targetFile or targetSqlite/);
});

test('a missing apex script fails the run before it fetches anything', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        apex: { afterMigration: ['./apex_test_does_not_exist.apex'] }
    }))).rejects.toThrow(/Apex script not found: \.\/apex_test_does_not_exist\.apex/);
});

test('full auto without an unhandled error behavior fails the run rather than dropping records', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        fullAuto: { enabled: true }
    }))).rejects.toThrow(/fullAuto\.enabled needs fullAuto\.unhandledErrorBehavior/);
});

test('a misspelled unhandled error behavior fails the run instead of quietly meaning skip', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        fullAuto: { enabled: true, unhandledErrorBehavior: 'saveAndExist' }
    }))).rejects.toThrow(/fullAuto\.unhandledErrorBehavior must be 'skip' or 'saveAndExit', not 'saveAndExist'/);
});

test('an exact solver that could never capture fails the run instead of matching errors and resolving none', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        solvers: [{ action: 'match', message: 'duplicates value on record', exact: true }]
    }))).rejects.toThrow(/'match' solver reads the id it matches on out of a capture group/);

    await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
        solvers: [{ action: 'extract_column', message: FUSSY_FIELD_ERROR, exact: true, replaceWith: null }]
    }))).rejects.toThrow(/'extract_column' solver reads the column name out of a capture group/);
});

// Also a thrown error, and the one way to tell that the export is awaited: writing
// it is the last thing a run does, so an unawaited write would leave main() to
// resolve as if the run had succeeded and let the failure escape the process.
test('an export that cannot be written fails the run', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);

    await expect(ctx.runMigration({
        sourceOrg: ctx.sourceOrg.alias,
        targetSqlite: './no_such_directory/test-output.db',
        recordIds: [account.id],
        matchers: defaultMatchers
    })).rejects.toThrow(/unable to open database file/);
});

// Lives here rather than in the shared scenarios because it reads the progress
// events themselves, which the live suite only sees as formatted log lines.
test('fetch progress counts the records per fetch depth', async () => {
    const ctx = createContext();
    const account = await createAccount(ctx.sourceOrg);
    await ctx.sourceOrg.createAll('Contact', [
        { LastName: 'Depth-1', AccountId: account.id },
        { LastName: 'Depth-2', AccountId: account.id }
    ]);

    const { capturedOutput } = await ctx.runMigration(createBasicConfig(ctx, [account.id], {
        relationships: { Account: [{ name: 'Contacts' }] },
        relatedRecordDepthLimit: 2
    }));

    const progress = capturedOutput.filter(event => event.type === 'records_so_far');
    for (const event of progress) {
        const counted = Object.values(event.data.countsByDepth as Record<number, number>).reduce((sum, n) => sum + n, 0);
        expect(counted).toBe(event.data.count);
    }
    // 1: the Account. 2: its two Contacts and the User owning it. 3: that User's
    // Profile - past the limit, which stops relationship queries, not lookups.
    const last = progress[progress.length - 1].data;
    expect(last.countsByDepth).toEqual({ 1: 1, 2: 3, 3: 1 });

    const fetched = capturedOutput.find(event => event.type === 'fetched_records')!.data;
    expect(fetched.countsByDepth).toEqual(last.countsByDepth);
});

// Lives here rather than in the shared scenarios because it reads concurrency off
// the order of IO events, which only an in-process run delivers without delay. A
// query job announces its query before its first await, so with three in flight
// three Account queries go out before the first of them comes back.
test('matcher queries run maxConcurrentRequests at a time', async () => {
    const ctx = createContext();
    const names = Array.from({ length: 15 }, (_, i) => `Parallel-${i}`);
    const sourceIds = (await ctx.sourceOrg.createAll('Account', names.map(Name => ({ Name })))).map(result => result.id);
    const targetIds = (await ctx.targetOrg.createAll('Account', names.map(Name => ({ Name })))).map(result => result.id);

    const { parsedOutput, capturedOutput } = await ctx.runMigration(createBasicConfig(ctx, sourceIds, {
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [{ sourceField: 'Name', targetField: 'Name' }],
            whenMissing: 'create'
        }],
        maxConcurrentRequests: 3
    }));

    const accountEvents = capturedOutput.filter(event => event.data?.sObjectName === 'Account'
        && (event.type === 'querying_existing_record' || event.type === 'found_existing_record'));
    const firstFound = accountEvents.findIndex(event => event.type === 'found_existing_record');
    expect(firstFound).toBe(3);
    expect(accountEvents.filter(event => event.type === 'found_existing_record')).toHaveLength(15);

    expect(targetOrg.records('Account')).toHaveLength(15);
    expect(sourceIds.map(id => parsedOutput.allMigratedRecords[id])).toEqual(targetIds);
});

// Lives here rather than in the shared scenarios because the failure it asserts on
// is a thrown error: in this context that surfaces as a rejected main(), while the
// live CLI turns it into a FATAL line and a non-zero exit code.
test('a source missing a matcher field fails instead of matching an arbitrary record', async () => {
    const ctx = createContext();
    const custObjA = await ctx.sourceOrg.create('Custom_Object_A__c', {});

    await ctx.runMigration({
        sourceOrg: ctx.sourceOrg.alias,
        targetSqlite: 'test-output.db',
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    });

    // an export made before non-creatable fields were exported: the User matcher
    // matches on Name, and the column is not there
    const db = new DatabaseSync('./test-output.db');
    try {
        db.exec('ALTER TABLE "User" DROP COLUMN "Name"');
    } finally {
        db.close();
    }

    await expect(ctx.runMigration({
        sourceSqlite: 'test-output.db',
        targetOrg: ctx.targetOrg.alias,
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    })).rejects.toThrow(/\(User\) has no value for matcher field Name/);
});

// The record store's own life cycle, which the scenarios above only see the
// inside of: where it goes, that it goes away, and what a kept one holds.
describe('the record store on disk', () => {
    afterEach(() => {
        delete process.env[STORE_KEY_ENV];
    });

    test('is announced, and deleted once the run is over', async () => {
        const ctx = createContext();
        const account = await createAccount(ctx.sourceOrg);

        const { capturedOutput } = await ctx.runMigration(createBasicConfig(ctx, [account.id], {
            recordStore: { type: 'sqlite', encrypt: true }
        }));

        const opened = capturedOutput.find(event => event.type === 'record_store_opened');
        const closed = capturedOutput.find(event => event.type === 'record_store_closed');
        expect(opened?.data).toEqual({ path: expect.stringContaining(`${TARGET_ORG_ALIAS}__records.`), encrypted: true, keep: false });
        expect(closed?.data).toEqual({ path: opened?.data.path, deleted: true });
        expect(fs.existsSync(opened?.data.path)).toBe(false);
        expect(targetOrg.records('Account')).toHaveLength(1);
    });

    test('is deleted when the run fails', async () => {
        const ctx = createContext();
        const account = await createAccount(ctx.sourceOrg);

        await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
            recordStore: { type: 'sqlite', path: './test-record-store.db' },
            apex: { afterMigration: [writeApexScript('after', [UNCOMPILABLE_APEX])] }
        }))).rejects.toThrow(/apex\.afterMigration\) failed/);

        expect(fs.existsSync('./test-record-store.db')).toBe(false);
    });

    test('kept, still holds every record the run fetched, readable with its passphrase', async () => {
        const ctx = createContext();
        const account = await createAccount(ctx.sourceOrg, 'Kept Account');
        const contact = await ctx.sourceOrg.create('Contact', { LastName: 'Kept', AccountId: account.id });
        process.env[STORE_KEY_ENV] = 'correct horse battery staple';

        await ctx.runMigration(createBasicConfig(ctx, [contact.id], {
            recordStore: { type: 'sqlite', path: './test-record-store.db', keep: true, encrypt: true }
        }));

        const dump = dumpRecordStore('./test-record-store.db');
        expect(dump.queued).toEqual({});
        expect(dump.fetched[contact.id].LastName).toBe('Kept');
        expect(dump.fetched[account.id].Name).toBe('Kept Account');
        expect(targetOrg.records('Contact')).toHaveLength(1);
    });

    test('refuses to start over a store a run kept', async () => {
        const ctx = createContext();
        const account = await createAccount(ctx.sourceOrg);
        fs.writeFileSync('./test-record-store.db', '');

        await expect(ctx.runMigration(createBasicConfig(ctx, [account.id], {
            recordStore: { type: 'sqlite', path: './test-record-store.db' }
        }))).rejects.toThrow(/already exists/);

        expect(targetOrg.records('Account')).toHaveLength(0);
    });
});
