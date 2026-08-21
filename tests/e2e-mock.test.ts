/**
 * A copy of e2e.test.ts that runs against in-memory orgs instead of live ones.
 *
 * The migration itself is the real thing - the same `main()` entry point, the
 * same config, the same solvers and IO events - but both orgs are fakes (see
 * fake-salesforce-org.ts and fake-test-org-schema.ts), so the suite needs no
 * scratch orgs, no authentication and no network. e2e.test.ts stays the
 * authority on how the tool behaves against a real org; this file is what can
 * be run anywhere.
 *
 * Two things are necessarily different from the live suite: the migration runs
 * in this process rather than as a `node bundle.js` child process, and "the app
 * was closed unexpectedly" is simulated by aborting the pending input request
 * instead of killing a process.
 */

import { test, expect } from '@jest/globals';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { IOEvent, Options, main } from '../app';
import { getFormatter } from '../ui/event-formatter';
import { FakeSalesforceOrg, createFakeClientFactory } from './fake-salesforce-org';
import {
    CONTRACT_STATUS_ERROR,
    SOURCE_ORG_ALIAS,
    TARGET_ORG_ALIAS,
    createSourceOrg,
    createTargetOrg
} from './fake-test-org-schema';

const sourceOrgAlias = SOURCE_ORG_ALIAS;
const targetOrgAlias = TARGET_ORG_ALIAS;

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

afterEach(async () => {
    for (const file of [`${targetOrgAlias}__history.json`, './custom_history_test.json', './test-output.db', './test-output.json', './test-output.log']) {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
    if (fs.existsSync('./custom_history_test_dir')) {
        fs.rmSync('./custom_history_test_dir', { recursive: true });
    }
});

function setupTestOrgs() {
    return { conn1: sourceOrg, conn2: targetOrg };
}

/** Raised in place of killing the CLI process when a test asks the app to exit. */
class SimulatedExit extends Error {}

type InputHandler =
    | string[]
    | ((event: IOEvent, sendInput: (input: string) => void, exit: () => void) => void | Promise<void>);

async function runMigration(config: any, inputHandler: InputHandler = ['y'], outputFile: string | undefined = undefined) {
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
                const result = (inputHandler as (e: IOEvent, s: (i: string) => void, x: () => void) => void | Promise<void>)(event, sendInput, exit);
                if (result && typeof (result as Promise<void>).then === 'function') {
                    (result as Promise<void>).catch(reject);
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

    if (!exitCalled) {
        expect(capturedOutput.length).toBeGreaterThan(1);
        const finished = [...capturedOutput].reverse().find(event => event.type === 'finished');
        expect(finished).toBeDefined();
        return {
            parsedOutput: JSON.parse(finished!.data),
            capturedOutput
        };
    }
    return {
        parsedOutput: null,
        capturedOutput
    };
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const defaultMatchers = [
    {
        sObjectType: 'Profile',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ]
    },
    {
        sObjectType: 'User',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ]
    },
    {
        sObjectType: 'UserRole',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ]
    },
    {
        sObjectType: 'UserLicense',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ]
    },
    {
        sObjectType: 'RecordType',
        fieldMappings: [
            { sourceField: 'DeveloperName', targetField: 'DeveloperName' },
            { sourceField: 'SobjectType', targetField: 'SobjectType' }
        ]
    }
];

// Error pattern emitted when inserting Custom_Object_D__c with a fussy field set to 'blocked'
const FUSSY_FIELD_ERROR = 'Field \'(\\w+)\'  can\'t be';

const fixContractStatusSolver = {
    action: 'fix',
    message: CONTRACT_STATUS_ERROR,
    changeFields: [
        {
            field: 'Status',
            value: 'Draft'
        }
    ]
};

function extractFussyColumnSolver(replaceWith: string | null, additionalOptions: any = {}) {
    return {
        action: 'extract_column',
        message: FUSSY_FIELD_ERROR,
        replaceWith,
        ...additionalOptions
    };
}

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------

function createBasicConfig(recordIds: string[], additionalOptions: any = {}) {
    return {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds,
        matchers: defaultMatchers,
        ...additionalOptions
    };
}

function createTokenAuthConfig(conn1: FakeSalesforceOrg, conn2: FakeSalesforceOrg, recordIds: string[], additionalOptions: any = {}) {
    return {
        sourceOrgUrl: conn1.instanceUrl,
        sourceOrgToken: conn1.accessToken,
        targetOrgUrl: conn2.instanceUrl,
        targetOrgToken: conn2.accessToken,
        // the history file is still named after the target org
        targetOrg: targetOrgAlias,
        recordIds,
        matchers: defaultMatchers,
        ...additionalOptions
    };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

function createRecord(conn: FakeSalesforceOrg, sObjectType: string, fields: any = {}) {
    const record = conn.create(sObjectType, fields);
    log(record);
    expect(record.id).toBeDefined();
    return record;
}

function createAccount(conn: FakeSalesforceOrg, name: string = `Account-${Math.random()}`) {
    return createRecord(conn, 'Account', { Name: name });
}

function createContract(conn: FakeSalesforceOrg, accountId: string, status: string = 'Draft', contractTerm: number = 12) {
    return createRecord(conn, 'Contract', {
        AccountId: accountId,
        Status: status,
        StartDate: new Date().toISOString(),
        ContractTerm: contractTerm
    });
}

// An activated Contract cannot be inserted as-is into the target org, so migrating
// it triggers the CONTRACT_STATUS_ERROR insert error.
function createActivatedContract(conn: FakeSalesforceOrg, accountId: string) {
    const contract = createContract(conn, accountId);
    conn.update('Contract', { Id: contract.id, Status: 'Activated' });
    return contract;
}

// Custom_Object_D__c with fussy fields set to 'blocked' triggers the
// FUSSY_FIELD_ERROR insert error in the target org.
function createFussyCustObjD(conn: FakeSalesforceOrg, fussyFields: any = { Fussy_Field_1__c: 'blocked' }) {
    const name = `ext-${Math.random()}`;
    const custObj = createRecord(conn, 'Custom_Object_D__c', { Name: name });
    conn.update('Custom_Object_D__c', { Id: custObj.id, ...fussyFields });
    return { custObj, name };
}

// Creates a Custom_Object_C__c with the same unique External_Id__c in both orgs,
// so inserting the source record into the target org triggers a duplicate value error.
function createDuplicateCustObjCs(conn1: FakeSalesforceOrg, conn2: FakeSalesforceOrg) {
    const externalId = `ext-${Math.random()}`;
    const sourceRecord = createRecord(conn1, 'Custom_Object_C__c', { External_Id__c: externalId });
    const targetRecord = createRecord(conn2, 'Custom_Object_C__c', { External_Id__c: externalId });
    return { externalId, sourceRecord, targetRecord };
}

function createAll(conn: FakeSalesforceOrg, sObjectType: string, records: any[]) {
    return records.map(fields => conn.create(sObjectType, fields));
}

function updateAll(conn: FakeSalesforceOrg, sObjectType: string, records: any[]) {
    return records.map(record => {
        conn.update(sObjectType, record);
        return { id: record.Id, success: true };
    });
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function confirmMigration(checkData?: (data: any) => void) {
    return (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
            if (checkData) {
                checkData(ioEvent.data!);
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function getMigratedRecords(parsedOutput: any) {
    // Support both old and new output formats
    return parsedOutput.allMigratedRecords || parsedOutput;
}

function assertRecordMigrated(parsedOutput: any, recordId: string): string {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    const newRecordId = recordSource[recordId];
    expect(newRecordId).toBeTruthy();
    expect(newRecordId).not.toEqual(recordId);
    return newRecordId;
}

// A skipped record appears in the output with an empty string as the new id
function assertRecordSkipped(parsedOutput: any, recordId: string) {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    expect(recordSource[recordId]).toBe('');
}

// Asserts the record was mapped to a specific existing target record
// (matched to a duplicate or reused from history) instead of being created anew
function assertRecordMappedTo(parsedOutput: any, recordId: string, expectedNewId: string): string {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    const newRecordId = recordSource[recordId];
    expect(newRecordId).toBeTruthy();
    expect(newRecordId).toEqual(expectedNewId);
    return newRecordId;
}

function assertFixedErrors(parsedOutput: any, recordId: string, expectedSolvers: { action: string, changeFields?: any }[], message: string = CONTRACT_STATUS_ERROR) {
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(recordId);
    const errors = parsedOutput.errors[recordId];
    expect(errors).toHaveLength(expectedSolvers.length);
    errors.forEach((error: any, i: number) => {
        expect(error.message).toEqual(message);
        expect(error.fixed).toBeTruthy();
        expect(error.solver).toBeDefined();
        expect(error.solver.action).toEqual(expectedSolvers[i].action);
        if (expectedSolvers[i].changeFields) {
            expect(error.solver.changeFields).toEqual(expectedSolvers[i].changeFields);
        }
    });
}

function retrieveRecord(conn: FakeSalesforceOrg, sObjectType: string, recordId: string): any {
    const record = conn.retrieve(sObjectType, recordId);
    expect(record).toBeDefined();
    return record;
}

function readLogEvents(filePath: string): any[] {
    return fs.readFileSync(filePath, 'utf8').split('\n').map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(line => line !== null);
}

function hasSavedRecord(logEvents: any[], recordId: string) {
    return logEvents.some(line => line.type === 'saved_records' && line.data.some((record: any) => record.id === recordId && record.success));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('migrate record - single', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id]);
    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id);
});

test('url and token auth', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = createTokenAuthConfig(conn1, conn2, [account.id]);
    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id);
});

test('source auth token, target auth alias', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = {
        sourceOrgUrl: conn1.instanceUrl,
        sourceOrgToken: conn1.accessToken,
        targetOrg: targetOrgAlias,
        recordIds: [account.id],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id);
});

test('source auth alias, target auth token', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        targetOrgUrl: conn2.instanceUrl,
        targetOrgToken: conn2.accessToken,
        recordIds: [account.id],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id);
});

test('migrate record - complex', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contact = createRecord(conn1, 'Contact', { FirstName: 'Spider', LastName: 'Jerusalem', AccountId: account.id });

    const campaignFields = { Name: `Aaa! ${Math.random()}`, IsActive: true };
    const campaignOrgA = createRecord(conn1, 'Campaign', campaignFields);
    const campaignOrgB = createRecord(conn2, 'Campaign', campaignFields);

    const opportunity = createRecord(conn1, 'Opportunity', {
        Name: 'Blasto Bandage',
        CampaignId: campaignOrgA.id,
        AccountId: account.id,
        StageName: 'Prospecting',
        CloseDate: new Date().toISOString()
    });

    const user = conn1.find('User', { Name: 'Integration User' });
    log(user);
    expect(user.length).toBeGreaterThan(0);
    expect(user[0].Id).toBeDefined();

    const custObjC = createRecord(conn1, 'Custom_Object_C__c', { OwnerId: user[0].Id });
    const custObjB = createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
    const custObjA = createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

    // create circular dependency
    conn1.update('Custom_Object_C__c', { Id: custObjC.id, Lookup_to_A__c: custObjA.id });

    const config = createBasicConfig([opportunity.id, custObjB.id, custObjA.id], {
        matchers: [...defaultMatchers, {
            sObjectType: 'Campaign',
            fieldMappings: [
                { sourceField: 'Name', targetField: 'Name' },
                { sourceField: 'IsActive', targetField: 'IsActive' }
            ]
        }],
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        }
    });

    const { parsedOutput } = await runMigration(config, confirmMigration((recordCounts) => {
        // event data should contain record counts by sobject type
        const expectedCounts: any = {
            Account: 1,
            Contact: 1,
            Opportunity: 1,
            Custom_Object_A__c: 1,
            Custom_Object_B__c: 1,
            Custom_Object_C__c: 1
        };
        for (const [sObjectType, count] of Object.entries(expectedCounts)) {
            expect(recordCounts).toHaveProperty(sObjectType);
            expect(recordCounts[sObjectType]).toBe(count);
        }
    }));

    const newOpportunityId = assertRecordMigrated(parsedOutput, opportunity.id);
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);
    const newContactId = assertRecordMigrated(parsedOutput, contact.id);

    // should be able to query the new opportunity record
    const newOpportunity = retrieveRecord(conn2, 'Opportunity', newOpportunityId);
    expect(newOpportunity.Name).toEqual('Blasto Bandage');
    expect(newOpportunity.CampaignId).toEqual(campaignOrgB.id);

    // should be able to query the new account record
    const newAccount = retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');

    // should be able to query the new contact record
    const newContact = retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.FirstName).toEqual('Spider');
    expect(newContact.LastName).toEqual('Jerusalem');

    // Check if the new opportunity is associated with the new account
    expect(newOpportunity.AccountId).toEqual(newAccountId);

    const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
    const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
    const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

    // should be able to query the new custom object C record, and its owner
    // should be the target org's own Integration User
    const newCustObjC = retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.Lookup_to_A__c).toEqual(newCustObjAId);
    expect(retrieveRecord(conn2, 'User', newCustObjC.OwnerId).Name).toEqual('Integration User');

    // should be able to query the new custom object A record
    const newCustObjA = retrieveRecord(conn2, 'Custom_Object_A__c', newCustObjAId);
    expect(newCustObjA.Lookup_to_B__c).toEqual(newCustObjBId);

    // should be able to query the new custom object B record
    const newCustObjB = retrieveRecord(conn2, 'Custom_Object_B__c', newCustObjBId);
    expect(newCustObjB.Lookup_to_C__c).toEqual(newCustObjCId);

    // given
    const contact2 = createRecord(conn1, 'Contact', { FirstName: 'Ocean', LastName: 'Man', AccountId: account.id });

    config.recordIds = [contact2.id, custObjA.id];

    const { parsedOutput: parsedOutput2, capturedOutput } = await runMigration(config);
    expect(capturedOutput.filter(event => event.type === 'updating_record')).toHaveLength(0); // should only create new record

    const newContactId2 = assertRecordMigrated(parsedOutput2, contact2.id);

    // should be able to query the new contact record
    const newContact2 = retrieveRecord(conn2, 'Contact', newContactId2);
    expect(newContact2.FirstName).toEqual('Ocean');
    expect(newContact2.LastName).toEqual('Man');
    expect(newContact2.AccountId).toEqual(newAccountId);
});

test('match record by id field', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { sourceRecord: custObjC, targetRecord: custObjC2 } = createDuplicateCustObjCs(conn1, conn2);

    const custObjB = createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
    const custObjB2 = createRecord(conn2, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC2.id });

    const config = createBasicConfig([custObjB.id], {
        matchers: [
            ...defaultMatchers,
            {
                sObjectType: 'Custom_Object_B__c',
                fieldMappings: [
                    { sourceField: 'Lookup_to_C__c', targetField: 'Lookup_to_C__c' }
                ]
            },
            {
                sObjectType: 'Custom_Object_C__c',
                fieldMappings: [
                    { sourceField: 'External_Id__c', targetField: 'External_Id__c' }
                ]
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    assertRecordMappedTo(parsedOutput, custObjB.id, custObjB2.id);
});

test('record is skipped, any field updates are cancelled', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { sourceRecord: custObjC } = createDuplicateCustObjCs(conn1, conn2);

    const custObjB = createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
    const custObjA = createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

    conn1.update('Custom_Object_C__c', { Id: custObjC.id, Lookup_to_A__c: custObjA.id });

    const config = createBasicConfig([custObjB.id]);

    await runMigration(config, (ioEvent, sendInput) => {
        if (ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.type === 'insert_error') {
            sendInput('s');
        }
    });

    // does not throw error
});

test('migrate record with error - fixed automatically', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id], {
        solvers: [fixContractStatusSolver]
    });

    const { parsedOutput } = await runMigration(config);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('hide error from output if solver says so', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id], {
        solvers: [{ ...fixContractStatusSolver, hideError: true }]
    });

    const { parsedOutput } = await runMigration(config);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should not contain any errors
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).not.toHaveProperty(contract.id);
});

test('migrate record with error - fixed automatically, solver does not work', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id], {
        solvers: [
            {
                action: 'fix',
                message: CONTRACT_STATUS_ERROR,
                changeFields: [
                    {
                        field: 'ContractTerm',
                        value: 11
                    }
                ]
            }
        ]
    });

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message for both the failed solver and the manual fix
    assertFixedErrors(parsedOutput, contract.id, [
        { action: 'fix', changeFields: [{ field: 'ContractTerm', value: 11 }] },
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually, invalid response to solution choice', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    const { parsedOutput } = await runMigration(config, ['y', 'blocked', 'f', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually, invalid JSON', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": Draft"}', 'asdasfd', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id);

    // should be able to query the new contract record
    const newContract = retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed automatically, remove field if new value is null', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj, name } = createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id], {
        solvers: [extractFussyColumnSolver(null)]
    });

    const { parsedOutput, capturedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

    const newCustObj = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    const usingSolver = capturedOutput.find(e => e.type === 'using_solver');
    expect(usingSolver).toBeDefined();
    expect(usingSolver?.data?.solverMessage).toEqual(FUSSY_FIELD_ERROR);
    expect(usingSolver?.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be')).toBeTruthy();
    expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
});

test('migrate record with error - fixed manually, remove field if new value is null', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj, name } = createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'f', '{"Fussy_Field_1__c": null}']);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

    const newCustObj = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.find(e => e.type === 'insert_error' && e.data?.recordId === custObj.id && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
    expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
});

test('migrate record with error - automatically extract column name to update', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj, name } = createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id], {
        solvers: [extractFussyColumnSolver(null)]
    });

    const { parsedOutput, capturedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

    const newCustObj = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(0);
});

test('skip solver only if messages were the same', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj, name } = createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

    const config = createBasicConfig([custObj.id], {
        solvers: [extractFussyColumnSolver('asdf')]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

    const newCustObj = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(custObj.id);
    expect(parsedOutput.errors[custObj.id]).toHaveLength(2);
});

test('migrate record with error - manually add new solver', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj: custObj1, name: name1 } = createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });
    const { custObj: custObj2, name: name2 } = createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

    const config = createBasicConfig([custObj1.id, custObj2.id]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', '{"action": "extract_column", "message": "Field \'(\\\\w+)\'  can\'t be", "replaceWith": "asdf"}']);

    const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id);
    const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id);

    const newCustObj1 = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId1);
    expect(newCustObj1.Name).toEqual(name1);
    expect(newCustObj1.Fussy_Field_1__c).toEqual('blocked');
    expect(newCustObj1.Fussy_Field_2__c).toEqual('blocked');

    const newCustObj2 = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId2);
    expect(newCustObj2.Name).toEqual(name2);
    expect(newCustObj2.Fussy_Field_1__c).toEqual('blocked');
    expect(newCustObj2.Fussy_Field_2__c).toEqual('blocked');

    expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'extract_column' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
});

test('migrate record with error - manually add new solver, invalid solver', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { custObj: custObj1, name: name1 } = createFussyCustObjD(conn1);
    const { custObj: custObj2, name: name2 } = createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj1.id, custObj2.id]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', 'asdasd', '{zzz}', '{"action": "fix", "message": "((", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}', '{"action": "fix", "message": "Field \'Fussy_Field_1__c\'  can\'t be", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}']);

    const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id);
    const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id);

    const newCustObj1 = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId1);
    expect(newCustObj1.Name).toEqual(name1);

    const newCustObj2 = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId2);
    expect(newCustObj2.Name).toEqual(name2);

    expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'fix' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
});

test('migrate record with error - automatically skip record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id], {
        solvers: [
            {
                action: 'skip',
                message: CONTRACT_STATUS_ERROR
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    assertRecordSkipped(parsedOutput, contract.id);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // should be able to query the new account record
    const newAccount = retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');
});

test('migrate record with error - manually skip record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    const { parsedOutput } = await runMigration(config, ['y', 's']);

    assertRecordSkipped(parsedOutput, contract.id);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // should be able to query the new account record
    const newAccount = retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');
});

test('migrate record with error - automatically match duplicate record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { externalId, sourceRecord, targetRecord } = createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id], {
        solvers: [
            {
                action: 'match',
                message: 'duplicate value found: External_Id__c duplicates value on record with id: ([a-zA-Z0-9]{15,18})'
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id, targetRecord.id);

    // should be able to query the new custom object C record
    const newCustObjC = retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually match duplicate record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { externalId, sourceRecord, targetRecord } = createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id]);

    const { parsedOutput } = await runMigration(config, ['y', 'm', targetRecord.id]);

    const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id, targetRecord.id);

    // should be able to query the new custom object C record
    const newCustObjC = retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually retry insert', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { externalId, sourceRecord, targetRecord } = createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id]);

    const { parsedOutput } = await runMigration(config, (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
            expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
            // delete record from Org B
            conn2.delete('Custom_Object_C__c', targetRecord.id);
            // retry insert
            sendInput('r');
        }
    });

    const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id);

    // should be able to query the new custom object C record
    const newCustObjC = retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);

    expect(parsedOutput.errors).toHaveProperty(sourceRecord.id);
    expect(parsedOutput.errors[sourceRecord.id]).toHaveLength(1);
    expect(parsedOutput.errors[sourceRecord.id][0].fixed).toBeTruthy();
});

test('manually retry all records', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const count = 5;
    const records1 = [];
    for (let i = 0; i < count; i++) {
        log(`creating record ${i}`);
        const externalId = `ext-${Math.random()}`;
        const record = createRecord(conn1, 'Custom_Object_C__c', { External_Id__c: externalId });
        records1.push({
            id: record.id,
            externalId
        });
    }
    const records2: any[] = [];
    for (const record of records1) {
        log(`creating record ${record.externalId} in target org`);
        const record2 = createRecord(conn2, 'Custom_Object_C__c', { External_Id__c: record.externalId });
        records2.push({
            id: record2.id,
            externalId: record.externalId
        });
    }

    const config = createBasicConfig(records1.map(r => r.id));

    let retryCount = 0;
    const { parsedOutput } = await runMigration(config, (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
            retryCount++;
            expect(retryCount).toBe(1);
            expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
            // delete records from Org B
            for (const record of records2) {
                conn2.delete('Custom_Object_C__c', record.id);
            }
            // retry insert for all records
            sendInput('ra');
        }
    });
    expect(retryCount).toBe(1);

    for (const record of records1) {
        assertRecordMigrated(parsedOutput, record.id);
    }
});

test('migrate record with error - quit and save results so far', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    const { parsedOutput } = await runMigration(config, ['y', 'h']);

    // check if Account was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // run migration again, for Account
    config.recordIds = [account.id];
    const { parsedOutput: parsedOutput2 } = await runMigration(config, ['y']);

    // Account should not be migrated again
    assertRecordMappedTo(parsedOutput2, account.id, newAccountId);
});

test('match not found, create new record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    const account1 = createAccount(conn1, account1Name);
    const account2 = createAccount(conn1, account2Name);
    const account1B = createAccount(conn2, account1Name);

    const config = createBasicConfig([account1.id, account2.id], {
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Name', targetField: 'Name' }
            ],
            whenMissing: 'create'
        }]
    });

    const { parsedOutput } = await runMigration(config, confirmMigration((recordCounts) => {
        expect(recordCounts).toHaveProperty('Account');
        expect(recordCounts.Account).toBe(2);

        expect(recordCounts).toHaveProperty('matchers');
        const matchers = recordCounts.matchers;
        expect(matchers).toHaveProperty('Account');
        expect(matchers.Account.whenMissing).toBe('create');
    }));

    assertRecordMappedTo(parsedOutput, account1.id, account1B.id);

    const newAccount2Id = assertRecordMigrated(parsedOutput, account2.id);

    // should be able to query the new account record
    const newAccount2 = retrieveRecord(conn2, 'Account', newAccount2Id);
    expect(newAccount2.Name).toEqual(account2Name);
});

test('match not found, skip record', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    const account1 = createAccount(conn1, account1Name);
    const account2 = createAccount(conn1, account2Name);
    const account1B = createAccount(conn2, account1Name);

    const config = createBasicConfig([account1.id, account2.id], {
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Name', targetField: 'Name' }
            ],
            whenMissing: 'skip'
        }]
    });

    const { parsedOutput } = await runMigration(config, confirmMigration((recordCounts) => {
        expect(recordCounts).toHaveProperty('Account');
        expect(recordCounts.Account).toBe(2);

        expect(recordCounts).toHaveProperty('matchers');
        const matchers = recordCounts.matchers;
        expect(matchers).toHaveProperty('Account');
        expect(matchers.Account.whenMissing).toBe('skip');
    }));

    assertRecordMappedTo(parsedOutput, account1.id, account1B.id);

    assertRecordSkipped(parsedOutput, account2.id);

    // should not be able to query the new account record by account name
    const newAccount2 = conn2.find('Account', { Name: account2Name });
    expect(newAccount2.length).toBe(0);
});

test('use history for both primary and secondary records', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const contactName = `John Doe ${Math.random()}`;

    const account = createAccount(conn1, account1Name);
    const contact = createRecord(conn1, 'Contact', { AccountId: account.id, LastName: contactName });

    const config = createBasicConfig([contact.id]);

    const { parsedOutput } = await runMigration(config);

    const newContactId = assertRecordMigrated(parsedOutput, contact.id);

    // should be able to query the new contact record
    const newContact = retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.LastName).toEqual(contactName);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // should be able to query the new account record
    const newAccount = retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual(account1Name);

    // run migration again with new contact
    const contact2 = createRecord(conn1, 'Contact', { AccountId: account.id, LastName: contactName });

    config.recordIds = [contact2.id];

    const { parsedOutput: parsedOutput2 } = await runMigration(config);

    assertRecordMigrated(parsedOutput2, contact2.id);

    assertRecordMappedTo(parsedOutput2, account.id, newAccountId);
});

test('fix column automatically with modifying current value', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const { externalId, sourceRecord, targetRecord } = createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id], {
        solvers: [
            {
                action: 'append_random',
                message: 'duplicate value found: External_Id__c duplicates value on record',
                changeFields: [
                    {
                        field: 'External_Id__c',
                        length: 4
                    }
                ]
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id);

    // should be able to query the new record
    const newCustObjC = retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).not.toEqual(externalId);
    expect(newCustObjC.External_Id__c).toMatch(new RegExp(`^${externalId}\\.[a-z0-9]{4}$`));

    // error should be logged
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(sourceRecord.id);
    expect(parsedOutput.errors[sourceRecord.id]).toHaveLength(1);
    expect(parsedOutput.errors[sourceRecord.id][0].message).toEqual(`duplicate value found: External_Id__c duplicates value on record with id: ${targetRecord.id}`);
});

test('more than 10 chunks', async () => {
    const { conn1 } = setupTestOrgs();

    const recordSpecs: [string, any][] = [
        ['Account', { Name: 'Cloud Kicks' }],
        ['Contact', { FirstName: 'Spider', LastName: 'Jerusalem' }],
        ['Campaign', { Name: 'Cloud Kicks Campaign' }],
        ['Case', { Subject: 'Cloud Kicks Case 1' }],
        ['Lead', { FirstName: 'Spider', LastName: 'Jerusalem', Company: 'Cloud Kicks' }],
        ['Opportunity', { Name: 'Cloud Kicks Opportunity', StageName: 'Prospecting', CloseDate: new Date() }],
        ['Task', { Subject: 'Cloud Kicks Task' }],
        ['Event', { Subject: 'Cloud Kicks Event', StartDateTime: new Date(), EndDateTime: new Date() }],
        ['Custom_Object_C__c', { Name: 'Cloud Kicks Custom Object C' }],
        ['Custom_Object_D__c', { Name: 'Cloud Kicks Custom Object D' }],
        ['WorkOrder', {}]
    ];

    const recordIds: string[] = [];
    for (const [sObjectType, fields] of recordSpecs) {
        const record = createRecord(conn1, sObjectType, fields);
        recordIds.push(record.id);
    }

    const config = createBasicConfig(recordIds);

    const { parsedOutput } = await runMigration(config);

    for (const recordId of recordIds) {
        assertRecordMigrated(parsedOutput, recordId);
    }
});

test('failed later update', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const custObjD = createRecord(conn1, 'Custom_Object_D__c', { Fussy_Field_1__c: 'fail' });

    const config = createBasicConfig([custObjD.id], {
        solvers: [
            {
                action: 'fix',
                message: 'Always fails on org B',
                changeFields: [
                    {
                        field: 'Fussy_Field_1__c',
                        value: 'ok'
                    }
                ]
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id);

    // should be able to query the new record
    const newCustObjD = retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjDId);
    expect(newCustObjD.Fussy_Field_1__c).toEqual('ok');
});

test('match by wrong field', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const accountName = `Cloud Kicks ${Math.random()}`;
    const account1 = createAccount(conn1, accountName);
    createAccount(conn2, accountName);

    const config = createBasicConfig([account1.id], {
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Ugabuga', targetField: 'Ugabuga' }
            ]
        }]
    });

    await expect(runMigration(config)).rejects.toThrow('Field Ugabuga not found in SObject Account');
});

test('find ids inside text', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');
    const custObjD = createRecord(conn1, 'Custom_Object_D__c', {});

    const case1 = createRecord(conn1, 'Case', {
        Description: `Here's an Id for you: ${account.id} and here's another one: ${custObjD.id}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`
    });

    const config = createBasicConfig([case1.id]);

    const { parsedOutput } = await runMigration(config);

    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);
    const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id);

    const newCase1 = retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe(`Here's an Id for you: ${newAccountId} and here's another one: ${newCustObjDId}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`);
});

test('invalid record id in field', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const case1 = createRecord(conn1, 'Case', {
        Description: `This record does not exist: 001J6000002UKyHIAW`
    });

    const config = createBasicConfig([case1.id]);

    const { parsedOutput } = await runMigration(config);

    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);

    const newCase1 = retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe(`This record does not exist: 001J6000002UKyHIAW`);
});

test('record references self', async () => {
    const { conn1 } = setupTestOrgs();

    const case1 = createRecord(conn1, 'Case', {});

    conn1.update('Case', {
        Id: case1.id,
        Description: `This is my id: ${case1.id}`
    });

    const config = createBasicConfig([case1.id]);

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, case1.id);
});

test('circular relationship in text fields', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const caseA = createRecord(conn1, 'Case', {});

    const caseB = createRecord(conn1, 'Case', {
        Description: `I like ${caseA.id}`
    });

    const caseC = createRecord(conn1, 'Case', {
        Description: `And I like ${caseB.id}`
    });

    conn1.update('Case', {
        Id: caseA.id,
        Description: `But I like ${caseC.id} better`
    });

    const config = createBasicConfig([caseA.id, caseB.id, caseC.id]);

    const { parsedOutput } = await runMigration(config);

    const newCaseAId = assertRecordMigrated(parsedOutput, caseA.id);
    const newCaseBId = assertRecordMigrated(parsedOutput, caseB.id);
    const newCaseCId = assertRecordMigrated(parsedOutput, caseC.id);

    const newCaseA = retrieveRecord(conn2, 'Case', newCaseAId);
    expect(newCaseA.Description).toBe(`But I like ${newCaseCId} better`);

    const newCaseB = retrieveRecord(conn2, 'Case', newCaseBId);
    expect(newCaseB.Description).toBe(`I like ${newCaseAId}`);

    const newCaseC = retrieveRecord(conn2, 'Case', newCaseCId);
    expect(newCaseC.Description).toBe(`And I like ${newCaseBId}`);
});

test('non-queryable and non-creatable object', async () => {
    const { conn1 } = setupTestOrgs();

    const contentVersion = createRecord(conn1, 'ContentVersion', {
        Title: 'Test Document', // Required field
        PathOnClient: 'test.txt', // Required field
        VersionData: 'Hello World'
    });

    const config = createBasicConfig([contentVersion.id]);

    const { parsedOutput, capturedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, contentVersion.id);

    // the ContentDocument behind it can neither be queried nor created
    expect(capturedOutput.find(e => e.type === 'record_not_queryable' && e.data?.sObjectName === 'ContentDocument')).toBeDefined();
});

test('write output to log file', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id]);

    const { parsedOutput } = await runMigration(config, ['y'], 'test-output.log');

    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    expect(hasSavedRecord(readLogEvents('test-output.log'), newAccountId)).toBe(true);

    // run another migration to check that the log file is overwritten
    const account2 = createAccount(conn1, 'Cloud Kicks 2');

    const config2 = createBasicConfig([account2.id]);

    const { parsedOutput: parsedOutput2 } = await runMigration(config2, ['y'], 'test-output.log');
    const newAccountId2 = assertRecordMigrated(parsedOutput2, account2.id);

    const logEvents2 = readLogEvents('test-output.log');
    expect(hasSavedRecord(logEvents2, newAccountId2)).toBe(true);
    expect(hasSavedRecord(logEvents2, newAccountId)).toBe(false);
});

test('malformed id', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const case1 = createRecord(conn1, 'Case', {
        Description: 'Bad Id: 574300075a6OKB0000'
    });

    const config = createBasicConfig([case1.id]);

    const { parsedOutput } = await runMigration(config);
    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);

    const newCase1 = retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe('Bad Id: 574300075a6OKB0000');
});

test('limit level of depth for querying related records', async () => {
    const { conn1 } = setupTestOrgs();

    const HIERARCHY_LEVEL = 4;

    const accounts: any[] = [];
    for (let i = 0; i < HIERARCHY_LEVEL; i++) {
        const account = createRecord(conn1, 'Account', { Name: `Account ${i}`, ParentId: accounts[i - 1]?.id });
        accounts.push(account);
    }

    const contact = createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe',
        AccountId: accounts[0].id
    });

    const contact2 = createRecord(conn1, 'Contact', {
        FirstName: 'Jane',
        LastName: 'Doe',
        AccountId: accounts[1].id
    });

    const config = createBasicConfig([accounts[HIERARCHY_LEVEL - 1].id], {
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        },
        relatedRecordDepthLimit: HIERARCHY_LEVEL
    });

    const { parsedOutput } = await runMigration(config);

    for (let i = 0; i < HIERARCHY_LEVEL; i++) {
        assertRecordMigrated(parsedOutput, accounts[i].id);
    }

    expect(getMigratedRecords(parsedOutput)).not.toHaveProperty(contact.id);

    assertRecordMigrated(parsedOutput, contact2.id);
});

test('fetch related record for a record that is in history', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id]);

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id);

    // create contact
    const contact = createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe',
        AccountId: account.id
    });

    // run migration with added relationship for Account
    const config2 = createBasicConfig([account.id], {
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        }
    });

    const { parsedOutput: parsedOutput2 } = await runMigration(config2);

    assertRecordMigrated(parsedOutput2, account.id);

    assertRecordMigrated(parsedOutput2, contact.id);
});

test('save history file even if app is closed unexpectedly', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const accountName = `Unique Account ${Date.now()}`;
    const account = createAccount(conn1, accountName);
    const contract = createActivatedContract(conn1, account.id);

    const config = createBasicConfig([contract.id]);

    await runMigration(config, function (event, sendInput, exit) {
        if (event.type === 'confirm_migration') {
            sendInput('y');
        } else if (event.type === 'insert_error') {
            // close app
            exit();
        }
    });

    const newAccount = conn2.query(`SELECT Id, Name FROM Account WHERE Name = '${accountName}'`);
    expect(newAccount).toBeDefined();
    expect(newAccount.records.length).toBe(1);

    // run migration again
    const config2 = createBasicConfig([contract.id], {
        solvers: [fixContractStatusSolver]
    });
    const { parsedOutput: parsedOutput2 } = await runMigration(config2);

    assertRecordMappedTo(parsedOutput2, account.id, newAccount.records[0].Id);
});

test('migrate to file and from file', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const custObjC = createRecord(conn1, 'Custom_Object_C__c', {});
    const custObjB = createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
    const custObjA = createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

    const configToFile = {
        sourceOrg: sourceOrgAlias,
        targetFile: 'test-output.json',
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    };

    await runMigration(configToFile);

    const configFromFile = {
        sourceFile: 'test-output.json',
        targetOrg: targetOrgAlias,
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(configFromFile);

    const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
    const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
    const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

    const newCustObjB = retrieveRecord(conn2, 'Custom_Object_B__c', newCustObjBId);
    expect(newCustObjB.Lookup_to_C__c).toBe(newCustObjCId);

    const newCustObjA = retrieveRecord(conn2, 'Custom_Object_A__c', newCustObjAId);
    expect(newCustObjA.Lookup_to_B__c).toBe(newCustObjBId);
});

// Reads a table out of a migr_ts SQLite export so the export can be inspected
// with plain SQL, which is the point of exporting to SQLite instead of JSON.
function queryExportedRecords(dbPath: string, sObjectType: string): any[] {
    const db = new DatabaseSync(dbPath);
    try {
        return db.prepare(`SELECT * FROM "${sObjectType}" ORDER BY rowid`).all() as any[];
    } finally {
        db.close();
    }
}

test('migrate to SQLite database and from SQLite database', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const custObjC = createRecord(conn1, 'Custom_Object_C__c', {});
    const custObjB = createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
    const custObjA = createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

    const configToSqlite = {
        sourceOrg: sourceOrgAlias,
        targetSqlite: 'test-output.db',
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    };

    await runMigration(configToSqlite);

    // the export is a real, queryable database with one table per SObject type
    expect(fs.existsSync('./test-output.db')).toBe(true);

    const exportedA = queryExportedRecords('./test-output.db', 'Custom_Object_A__c');
    expect(exportedA).toHaveLength(1);
    expect(exportedA[0].Id).toBe(custObjA.id);
    expect(exportedA[0].Lookup_to_B__c).toBe(custObjB.id);

    const exportedB = queryExportedRecords('./test-output.db', 'Custom_Object_B__c');
    expect(exportedB).toHaveLength(1);
    expect(exportedB[0].Id).toBe(custObjB.id);
    expect(exportedB[0].Lookup_to_C__c).toBe(custObjC.id);

    expect(queryExportedRecords('./test-output.db', 'Custom_Object_C__c')).toHaveLength(1);

    const configFromSqlite = {
        sourceSqlite: 'test-output.db',
        targetOrg: targetOrgAlias,
        recordIds: [custObjA.id],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(configFromSqlite);

    const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
    const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
    const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

    const newCustObjB = retrieveRecord(conn2, 'Custom_Object_B__c', newCustObjBId);
    expect(newCustObjB.Lookup_to_C__c).toBe(newCustObjCId);

    const newCustObjA = retrieveRecord(conn2, 'Custom_Object_A__c', newCustObjAId);
    expect(newCustObjA.Lookup_to_B__c).toBe(newCustObjBId);
});

test('SQLite round trip preserves text, number, boolean and date fields', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const accountName = `Sqlite Account ${Date.now()}`;
    const account = createRecord(conn1, 'Account', {
        Name: accountName,
        NumberOfEmployees: 42,
        Description: 'Exported through SQLite'
    });
    const task = createRecord(conn1, 'Task', {
        Subject: 'Sqlite Roundtrip',
        WhatId: account.id,
        ActivityDate: '2030-04-01',
        CallDurationInSeconds: 90,
        IsReminderSet: true,
        ReminderDateTime: '2030-04-01T09:00:00.000+0000',
        IsRecurrence: false
    });

    await runMigration({
        sourceOrg: sourceOrgAlias,
        targetSqlite: 'test-output.db',
        recordIds: [task.id],
        matchers: defaultMatchers
    });

    // SQLite has no boolean type, so check how the values landed in the file
    const exportedTask = queryExportedRecords('./test-output.db', 'Task')
        .find(row => row.Id === task.id);
    expect(exportedTask).toBeDefined();
    expect(exportedTask.Subject).toBe('Sqlite Roundtrip');
    expect(exportedTask.ActivityDate).toBe('2030-04-01');
    expect(exportedTask.CallDurationInSeconds).toBe(90);
    expect(exportedTask.IsReminderSet).toBe(1);
    expect(exportedTask.IsRecurrence).toBe(0);

    const exportedAccount = queryExportedRecords('./test-output.db', 'Account')
        .find(row => row.Id === account.id);
    expect(exportedAccount).toBeDefined();
    expect(exportedAccount.NumberOfEmployees).toBe(42);
    expect(exportedAccount.Description).toBe('Exported through SQLite');

    const { parsedOutput } = await runMigration({
        sourceSqlite: 'test-output.db',
        targetOrg: targetOrgAlias,
        recordIds: [task.id],
        matchers: defaultMatchers
    });

    // and that the target org got the original types back, not stringified ones
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);
    const newAccount = retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toBe(accountName);
    expect(newAccount.NumberOfEmployees).toBe(42);
    expect(newAccount.Description).toBe('Exported through SQLite');

    const newTask = retrieveRecord(conn2, 'Task', assertRecordMigrated(parsedOutput, task.id));
    expect(newTask.Subject).toBe('Sqlite Roundtrip');
    expect(newTask.WhatId).toBe(newAccountId);
    expect(newTask.ActivityDate).toBe('2030-04-01');
    expect(newTask.CallDurationInSeconds).toBe(90);
    expect(newTask.IsReminderSet).toBe(true);
    expect(newTask.IsRecurrence).toBe(false);
});

// Creates an account hierarchy where the parent account's contract triggers an
// unhandled insert error (activated contract) and the child account's contract inserts cleanly
function createFullAutoTestRecords(conn1: FakeSalesforceOrg) {
    const account = createAccount(conn1, 'Cloud Kicks');
    const childAccount = createRecord(conn1, 'Account', {
        Name: 'Child Account',
        ParentId: account.id
    });
    const contract = createActivatedContract(conn1, account.id);
    const contract2 = createContract(conn1, childAccount.id);
    return { account, contract, contract2 };
}

test('full auto mode - save and exit', async () => {
    const { conn1 } = setupTestOrgs();

    const { account, contract, contract2 } = createFullAutoTestRecords(conn1);

    const config = createBasicConfig([contract.id, contract2.id], {
        fullAuto: {
            enabled: true,
            unhandledErrorBehavior: 'saveAndExit'
        }
    });

    const { parsedOutput } = await runMigration(config, []); // no input needed for full auto mode

    assertRecordMigrated(parsedOutput, account.id);

    expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract.id);
    expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract2.id);
});

test('full auto mode - skip', async () => {
    const { conn1 } = setupTestOrgs();

    const { account, contract, contract2 } = createFullAutoTestRecords(conn1);

    const config = createBasicConfig([contract.id, contract2.id], {
        fullAuto: {
            enabled: true,
            unhandledErrorBehavior: 'skip'
        }
    });

    const { parsedOutput } = await runMigration(config, []); // no input needed for full auto mode

    assertRecordMigrated(parsedOutput, account.id);

    assertRecordSkipped(parsedOutput, contract.id);
    assertRecordMigrated(parsedOutput, contract2.id);
});

test('anonymize email fields', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const uniqueEmail = `test+${Date.now()}@example.com`;
    const contact = createRecord(conn1, 'Contact', { FirstName: 'John', LastName: 'Doe', Email: uniqueEmail });

    const config = createBasicConfig([contact.id], {
        anonymization: {
            emailFields: {
                mode: 'obfuscate'
            }
        }
    });

    const { parsedOutput } = await runMigration(config);

    const newContactId = assertRecordMigrated(parsedOutput, contact.id);

    const newContact = retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.Email).not.toBe(uniqueEmail);
    expect(newContact.Email).toContain('@');
});

test('report record reason counts', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Cloud Kicks');

    const contact = createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe'
    });

    const contact2 = createRecord(conn1, 'Contact', {
        FirstName: 'Jane',
        LastName: 'Doe',
        AccountId: account.id,
        ReportsToId: contact.id
    });

    const caseRecord = createRecord(conn1, 'Case', {
        Subject: 'Test Case',
        ContactId: contact.id
    });

    const config = createBasicConfig([account.id], {
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ],
            "Contact": [
                {
                    "name": "Cases"
                }
            ]
        }
    });

    const { parsedOutput } = await runMigration(config, confirmMigration((recordCounts) => {
        expect(recordCounts).toHaveProperty('Account');
        expect(recordCounts).toHaveProperty('Contact');
        expect(recordCounts.Account).toBe(1);
        expect(recordCounts.Contact).toBe(2);

        expect(recordCounts).toHaveProperty('recordReasons');
        expect(recordCounts.recordReasons).toHaveProperty(['Account.Contacts']);
        expect(recordCounts.recordReasons['Account.Contacts']).toHaveProperty('Contact');
        expect(recordCounts.recordReasons['Account.Contacts'].Contact).toBe(2);
        expect(recordCounts.recordReasons['Account.Contacts']).toHaveProperty('Case');
        expect(recordCounts.recordReasons['Account.Contacts'].Case).toBe(1);
    }));

    assertRecordMigrated(parsedOutput, account.id);
    assertRecordMigrated(parsedOutput, contact.id);
    assertRecordMigrated(parsedOutput, contact2.id);
    assertRecordMigrated(parsedOutput, caseRecord.id);
});

test('custom history file path', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Custom History Test Account');

    const customHistoryPath = './custom_history_test.json';
    const config = createBasicConfig([account.id], {
        historyFilePath: customHistoryPath
    });

    const { parsedOutput } = await runMigration(config);

    // Verify record was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // Verify custom history file was created
    expect(fs.existsSync(customHistoryPath)).toBe(true);

    // Verify custom history file contains the mapping
    const historyContent = JSON.parse(fs.readFileSync(customHistoryPath, 'utf8'));
    expect(historyContent).toHaveProperty(account.id);
    expect(historyContent[account.id]).toBe(newAccountId);

    // Verify default history file was NOT created
    expect(fs.existsSync(`${targetOrgAlias}__history.json`)).toBe(false);
});

test('custom history file path as directory', async () => {
    const { conn1 } = setupTestOrgs();

    const account = createAccount(conn1, 'Custom History Test Account');

    const customHistoryPath = './custom_history_test_dir';
    fs.mkdirSync(customHistoryPath, { recursive: true });
    const config = createBasicConfig([account.id], {
        historyFilePath: customHistoryPath
    });

    const { parsedOutput } = await runMigration(config);

    // Verify record was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id);

    // Verify custom history file was created
    expect(fs.existsSync(`${customHistoryPath}/${targetOrgAlias}__history.json`)).toBe(true);

    // Verify custom history file contains the mapping
    const historyContent = JSON.parse(fs.readFileSync(`${customHistoryPath}/${targetOrgAlias}__history.json`, 'utf8'));
    expect(historyContent).toHaveProperty(account.id);
    expect(historyContent[account.id]).toBe(newAccountId);

    // Verify default history file was NOT created
    expect(fs.existsSync(`${targetOrgAlias}__history.json`)).toBe(false);
});

test('solver with additional info from error', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const rtEnhanced = conn1.find('RecordType', {
        SobjectType: 'Custom_Object_E__c',
        DeveloperName: 'Enhanced'
    })[0];
    expect(rtEnhanced).toBeDefined();
    const custObjE = createRecord(conn1, 'Custom_Object_E__c', { RecordTypeId: rtEnhanced.Id, Some_picklist__c: 'Enhanced value' });

    const config = createBasicConfig([custObjE.id], {
        solvers: [
            {
                action: 'fix',
                message: 'Record Type ID: this ID value isn\'t valid for the user',
                changeFields: [
                    {
                        field: 'RecordTypeId',
                        value: null
                    }
                ]
            },
            {
                action: 'extract_column',
                message: 'bad value for restricted picklist field: [\\w ]+',
                fromFields: true,
                replaceWith: 'Normal value'
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjEId = assertRecordMigrated(parsedOutput, custObjE.id);
    const newCustObjE = retrieveRecord(conn2, 'Custom_Object_E__c', newCustObjEId);
    expect(newCustObjE.Some_picklist__c).toBe('Normal value');
});

test('bulk update records', async () => {
    const { conn1, conn2 } = setupTestOrgs();

    const recordsToCreate = [];
    for (let i = 0; i < 211; i++) {
        recordsToCreate.push({ Name: `ext-${Math.random()}` });
    }

    const allCreateResults = createAll(conn1, 'Custom_Object_D__c', recordsToCreate);
    expect(allCreateResults).toHaveLength(211);

    // Prepare updates for all created records
    const recordsToUpdate = [];
    const recordIds: string[] = [];
    for (const result of allCreateResults) {
        expect(result.success).toBe(true);
        expect(result.id).toBeDefined();
        recordIds.push(result.id);
        recordsToUpdate.push({
            Id: result.id,
            Fussy_Field_1__c: 'blocked',
            Fussy_Field_2__c: 'blocked'
        });
    }

    const allUpdateResults = updateAll(conn1, 'Custom_Object_D__c', recordsToUpdate);
    expect(allUpdateResults).toHaveLength(211);
    for (const result of allUpdateResults) {
        expect(result.success).toBe(true);
    }

    const config = createBasicConfig(recordIds, {
        solvers: [extractFussyColumnSolver('asdf', { hideError: true })]
    });

    const { parsedOutput, capturedOutput } = await runMigration(config);
    for (const recordId of recordIds) {
        const newRecordId = assertRecordMigrated(parsedOutput, recordId);
        // check if the record was updated
        const record = retrieveRecord(conn2, 'Custom_Object_D__c', newRecordId);
        expect(record.Fussy_Field_1__c).toBe('blocked');
        expect(record.Fussy_Field_2__c).toBe('blocked');
    }
    expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(2);
});
