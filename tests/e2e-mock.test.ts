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
import { IOEvent, Options, main } from '../app';
import { getFormatter } from '../ui/event-formatter';
import {
    E2EContext,
    InputHandler,
    MigrationRunResult,
    TestOrg,
    cleanupMigrationArtifacts,
    defaultMatchers,
    toMigrationRunResult
} from './e2e-harness';
import { e2eScenarios } from './e2e-scenarios';
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

    async findIds(sObjectType: string, conditions: Record<string, any>) {
        return this.org.find(sObjectType, conditions).map(record => ({ Id: record.Id }));
    }

    async query(soql: string) {
        return this.org.query(soql);
    }
}

/** Raised in place of killing the CLI process when a scenario asks the app to exit. */
class SimulatedExit extends Error {}

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
        await main(config as Options, onOutput, onInput, createFakeClientFactory([sourceOrg, targetOrg]));
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
