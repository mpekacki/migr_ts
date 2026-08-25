/**
 * Runs the shared e2e scenarios (e2e-scenarios.ts) against real orgs.
 *
 * Requires the two scratch orgs (see create_scratch.sh) and a built bundle
 * (`npm run build`): every migration is executed as a `node bundle.js` child
 * process, driven through its stdin/stdout. e2e-mock.test.ts runs the very same
 * scenarios in-process against in-memory orgs.
 */

import { expect, test } from '@jest/globals';
import { AuthInfo, Connection } from '@salesforce/core';
import { exec } from 'child_process';
import fs from 'fs';
import IOEvent from '../ioevent';
import {
    E2EContext,
    InputHandler,
    MigrationRunResult,
    TestOrg,
    cleanupMigrationArtifacts,
    toMigrationRunResult
} from './e2e-harness';
import { e2eScenarios } from './e2e-scenarios';

const sourceOrgAlias = 'testMigrationOrgA';
const targetOrgAlias = 'testMigrationOrgB';

const BULK_CHUNK_SIZE = 200;

jest.setTimeout(120000);

beforeEach(() => {
    console.log(`starting test: ${expect.getState().currentTestName}`);
});

afterEach(async () => {
    if (fs.existsSync('./config_test.json')) {
        fs.unlinkSync('./config_test.json');
    }
    cleanupMigrationArtifacts(targetOrgAlias);
});

/** Adapts a live org connection to the interface the scenarios are written against. */
class LiveTestOrg implements TestOrg {
    constructor(readonly alias: string, private readonly connection: Connection) {}

    get instanceUrl() {
        return this.connection.instanceUrl;
    }

    get accessToken() {
        return this.connection.accessToken!;
    }

    async create(sObjectType: string, fields: any = {}) {
        const record: any = await this.connection.sobject(sObjectType).create(fields);
        console.log(record);
        if (!record.success) {
            throw new Error(`Failed to create ${sObjectType}: ${JSON.stringify(record.errors)}`);
        }
        return { id: record.id as string };
    }

    async createAll(sObjectType: string, records: any[]) {
        const results = await this.bulkInChunks(sObjectType, 'create', records);
        return results.map(result => {
            if (!result.success) {
                throw new Error(`Failed to create ${sObjectType}: ${JSON.stringify(result.errors)}`);
            }
            return { id: result.id as string };
        });
    }

    async update(sObjectType: string, changes: any) {
        const result: any = await this.connection.sobject(sObjectType).update(changes);
        if (!result.success) {
            throw new Error(`Failed to update ${sObjectType}: ${JSON.stringify(result.errors)}`);
        }
    }

    async updateAll(sObjectType: string, records: any[]) {
        const results = await this.bulkInChunks(sObjectType, 'update', records);
        for (const result of results) {
            if (!result.success) {
                throw new Error(`Failed to update ${sObjectType}: ${JSON.stringify(result.errors)}`);
            }
        }
    }

    async delete(sObjectType: string, recordId: string) {
        await this.connection.sobject(sObjectType).delete(recordId);
    }

    async retrieve(sObjectType: string, recordId: string) {
        return await this.connection.sobject(sObjectType).retrieve(recordId);
    }

    async findIds(sObjectType: string, conditions: Record<string, any>) {
        return await this.connection.sobject(sObjectType).find(conditions, 'Id').execute() as unknown as { Id: string }[];
    }

    async query(soql: string) {
        return await this.connection.query(soql);
    }

    private async bulkInChunks(sObjectType: string, operation: 'create' | 'update', records: any[]): Promise<any[]> {
        const allResults: any[] = [];
        for (let i = 0; i < records.length; i += BULK_CHUNK_SIZE) {
            const chunk = records.slice(i, i + BULK_CHUNK_SIZE);
            console.log(`bulk ${operation} chunk ${Math.floor(i / BULK_CHUNK_SIZE) + 1} (${chunk.length} records)`);
            const results = await (this.connection.sobject(sObjectType) as any)[operation](chunk);
            allResults.push(...(Array.isArray(results) ? results : [results]));
        }
        return allResults;
    }
}

let cachedContext: E2EContext | undefined;

async function setupTestOrgs(): Promise<E2EContext> {
    if (cachedContext) {
        return cachedContext;
    }

    console.log('logging in to test orgs');
    const allAuths = await AuthInfo.listAllAuthorizations();

    const orgAUsername = allAuths.find(auth => auth.aliases!.includes(sourceOrgAlias))?.username;
    const orgBUsername = allAuths.find(auth => auth.aliases!.includes(targetOrgAlias))?.username;

    expect(orgAUsername).toBeDefined();
    expect(orgBUsername).toBeDefined();

    const authInfoOptionsA: AuthInfo.Options = { username: orgAUsername! };
    const authInfoOptionsB: AuthInfo.Options = { username: orgBUsername! };

    const [authInfoA, authInfoB] = await Promise.all([
        AuthInfo.create(authInfoOptionsA),
        AuthInfo.create(authInfoOptionsB)
    ]);

    const [conn1, conn2] = await Promise.all([
        Connection.create({ authInfo: authInfoA }),
        Connection.create({ authInfo: authInfoB })
    ]);

    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();

    cachedContext = {
        sourceOrg: new LiveTestOrg(sourceOrgAlias, conn1),
        targetOrg: new LiveTestOrg(targetOrgAlias, conn2),
        runMigration
    };

    return cachedContext;
}

async function runMigration(config: any, inputHandler: InputHandler = ['y'], outputFile: string | undefined = undefined): Promise<MigrationRunResult> {
    fs.writeFileSync('./config_test.json', JSON.stringify(config, null, 2));
    const capturedOutput: IOEvent[] = [];
    const queuedInputs = Array.isArray(inputHandler) ? [...inputHandler] : null;
    let capturedError = '';

    let command = `npm run start:test -- --config-json ./config_test.json --debug`;
    if (outputFile) {
        command += ` --output-file ${outputFile}`;
    }
    const child = exec(command);
    let exitCalled = false;
    const sendInput = (input: string) => {
        console.log(`sending input: ${input}`);
        child.stdin?.write(input);
        child.stdin?.write('\n');
    };
    child.stdout?.on('data', (data) => {
        console.log(data);
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim() === '' || !line.trim().startsWith('{')) {
                continue;
            }
            let event;
            try {
                event = JSON.parse(line) as IOEvent;
            } catch {
                console.error(`Error parsing line: ${line}`);
                continue;
            }
            capturedOutput.push(event);
            if (event.category === 'input') {
                if (queuedInputs) {
                    const input = queuedInputs.shift();
                    if (input === undefined) {
                        capturedError = `Unexpected input request: type="${event.type}", data=${JSON.stringify(event.data)}`;
                        child.kill();
                        return;
                    }
                    sendInput(input);
                } else {
                    (inputHandler as Exclude<InputHandler, string[]>)(event, sendInput, () => {
                        exitCalled = true;
                        child.kill();
                    });
                }
            }
        }
    });
    child.stderr?.on('data', (data) => {
        console.error(data);
        capturedError += data;
    });
    await new Promise(resolve => child.on('close', resolve));

    if (!exitCalled) {
        expect(capturedError).toBe('');
    }
    return toMigrationRunResult(capturedOutput, exitCalled);
}

for (const e2eScenario of e2eScenarios) {
    test(e2eScenario.name, async () => {
        await e2eScenario.run(await setupTestOrgs());
    });
}
