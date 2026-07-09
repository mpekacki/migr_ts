import { test, expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';
import { exec } from 'child_process';
import fs from 'fs';
import { IOEvent } from '../app';


const sourceOrgAlias = 'testMigrationOrgA';
const targetOrgAlias = 'testMigrationOrgB';

jest.setTimeout(120000);

beforeEach(() => {
    console.log(`starting test: ${expect.getState().currentTestName}`);
});

afterEach(async () => {
    if (fs.existsSync('./config_test.json')) {
        fs.unlinkSync('./config_test.json');
    }
    if (fs.existsSync(`${targetOrgAlias}__history.json`)) {
        fs.unlinkSync(`${targetOrgAlias}__history.json`);
    }
    if (fs.existsSync('./custom_history_test.json')) {
        fs.unlinkSync('./custom_history_test.json');
    }
    if (fs.existsSync('./custom_history_test_dir')) {
        fs.rmdirSync('./custom_history_test_dir', { recursive: true });
    }
});

let cachedConn1: Connection | undefined;
let cachedConn2: Connection | undefined;

async function setupTestConnections() {
    if (cachedConn1 && cachedConn2) {
        return { conn1: cachedConn1, conn2: cachedConn2 };
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

    cachedConn1 = conn1;
    cachedConn2 = conn2;

    return { conn1, conn2 };
}

async function runMigration(config: any, inputHandler: ((event: IOEvent, sendInput: (input: string) => void, exit: () => void) => void) | string[] = ['y'], outputFile: string | undefined = undefined) {
    fs.writeFileSync('./config_test.json', JSON.stringify(config, null, 2));
    const capturedOutput: IOEvent[] = [];
    let capturedError = '';

    let command = `npm run start:test -- --config-json ./config_test.json --debug`;
    if (outputFile) {
        command += ` --output-file ${outputFile}`;
    }
    const child = exec(command);
    let exitCalled = false;
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
                if (typeof inputHandler === 'function') {
                    inputHandler(event, (input: string) => {
                        console.log(`sending input: ${input}`);
                        child.stdin?.write(input);
                        child.stdin?.write('\n');
                    }, () => {
                        exitCalled = true;
                        child.kill();
                    });
                } else {
                    const input = inputHandler.shift();
                    if (!input) {
                        capturedError = `Unexpected input request: type="${event.type}", data=${JSON.stringify(event.data)}`;
                        child.kill();
                        return;
                    }
                    console.log(`sending input: ${input}`);
                    child.stdin?.write(input);
                    child.stdin?.write('\n');
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
        expect(capturedOutput.length).toBeGreaterThan(1);
        return {
            parsedOutput: JSON.parse(capturedOutput[capturedOutput.length - 1].data!),
            capturedOutput
        };
    } else {
        return {
            parsedOutput: null,
            capturedOutput
        };
    }
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

// Error emitted when inserting a Contract with Status = 'Activated'
const CONTRACT_STATUS_ERROR = 'Choose a valid contract status and save your changes. Ask your admin for details.';
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

function createTokenAuthConfig(conn1: any, conn2: any, recordIds: string[], additionalOptions: any = {}) {
    return {
        sourceOrgUrl: conn1.instanceUrl,
        sourceOrgToken: conn1.accessToken,
        targetOrgUrl: conn2.instanceUrl,
        targetOrgToken: conn2.accessToken,
        recordIds,
        matchers: defaultMatchers,
        ...additionalOptions
    };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

async function createRecord(conn: any, sObjectType: string, fields: any = {}) {
    const record = await conn.sobject(sObjectType).create(fields);
    console.log(record);
    expect(record.id).toBeDefined();
    return record;
}

async function createAccount(conn: any, name: string = `Account-${Math.random()}`) {
    return createRecord(conn, 'Account', { Name: name });
}

async function createContract(conn: any, accountId: string, status: string = 'Draft', contractTerm: number = 12) {
    return createRecord(conn, 'Contract', {
        AccountId: accountId,
        Status: status,
        StartDate: new Date().toISOString(),
        ContractTerm: contractTerm
    });
}

// An activated Contract cannot be inserted as-is into the target org, so migrating
// it triggers the CONTRACT_STATUS_ERROR insert error.
async function createActivatedContract(conn: any, accountId: string) {
    const contract = await createContract(conn, accountId);
    await conn.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });
    return contract;
}

// Custom_Object_D__c with fussy fields set to 'blocked' triggers the
// FUSSY_FIELD_ERROR insert error in the target org.
async function createFussyCustObjD(conn: any, fussyFields: any = { Fussy_Field_1__c: 'blocked' }) {
    const name = `ext-${Math.random()}`;
    const custObj = await createRecord(conn, 'Custom_Object_D__c', { Name: name });
    await conn.sobject('Custom_Object_D__c').update({ Id: custObj.id!, ...fussyFields });
    return { custObj, name };
}

// Creates a Custom_Object_C__c with the same unique External_Id__c in both orgs,
// so inserting the source record into the target org triggers a duplicate value error.
async function createDuplicateCustObjCs(conn1: any, conn2: any) {
    const externalId = `ext-${Math.random()}`;
    const sourceRecord = await createRecord(conn1, 'Custom_Object_C__c', { External_Id__c: externalId });
    const targetRecord = await createRecord(conn2, 'Custom_Object_C__c', { External_Id__c: externalId });
    return { externalId, sourceRecord, targetRecord };
}

async function bulkInChunks(conn: any, sObjectType: string, operation: 'create' | 'update', records: any[], chunkSize: number = 200) {
    const allResults: any[] = [];
    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        console.log(`bulk ${operation} chunk ${Math.floor(i / chunkSize) + 1} (${chunk.length} records)`);
        const results = await conn.sobject(sObjectType)[operation](chunk);
        allResults.push(...(Array.isArray(results) ? results : [results]));
    }
    return allResults;
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

async function retrieveRecord(conn: any, sObjectType: string, recordId: string): Promise<any> {
    const record = await conn.sobject(sObjectType).retrieve(recordId);
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
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id!]);
    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id!);
});

test('url and token auth', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = createTokenAuthConfig(conn1, conn2, [account.id!]);
    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id!);
});

test('source auth token, target auth alias', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = {
        sourceOrgUrl: conn1.instanceUrl,
        sourceOrgToken: conn1.accessToken,
        targetOrg: targetOrgAlias,
        recordIds: [account.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id!);
});

test('source auth alias, target auth token', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrgUrl: conn2.instanceUrl,
        targetOrgToken: conn2.accessToken,
        recordIds: [account.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id!);
});

test('migrate record - complex', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contact = await createRecord(conn1, 'Contact', { FirstName: 'Spider', LastName: 'Jerusalem', AccountId: account.id! });

    const campaignFields = { Name: `Aaa! ${Math.random()}`, IsActive: true };
    const campaignOrgA = await createRecord(conn1, 'Campaign', campaignFields);
    const campaignOrgB = await createRecord(conn2, 'Campaign', campaignFields);

    const opportunity = await createRecord(conn1, 'Opportunity', {
        Name: 'Blasto Bandage',
        CampaignId: campaignOrgA.id!,
        AccountId: account.id!,
        StageName: 'Prospecting',
        CloseDate: new Date().toISOString()
    });

    const user = await conn1.sobject('User').select('Id').where(`Name = 'Integration User'`).execute();
    console.log(user);
    expect(user.length).toBeGreaterThan(0);
    expect(user[0].Id).toBeDefined();

    const custObjC = await createRecord(conn1, 'Custom_Object_C__c', { OwnerId: user[0].Id! });
    const custObjB = await createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id! });
    const custObjA = await createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id! });

    // create circular dependency
    await conn1.sobject('Custom_Object_C__c').update({ Id: custObjC.id!, Lookup_to_A__c: custObjA.id! });

    const config = createBasicConfig([opportunity.id!, custObjB.id!, custObjA.id!], {
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

    const newOpportunityId = assertRecordMigrated(parsedOutput, opportunity.id!);
    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);
    const newContactId = assertRecordMigrated(parsedOutput, contact.id!);

    // should be able to query the new opportunity record
    const newOpportunity = await retrieveRecord(conn2, 'Opportunity', newOpportunityId);
    expect(newOpportunity.Name).toEqual('Blasto Bandage');
    expect(newOpportunity.CampaignId).toEqual(campaignOrgB.id);

    // should be able to query the new account record
    const newAccount = await retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');

    // should be able to query the new contact record
    const newContact = await retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.FirstName).toEqual('Spider');
    expect(newContact.LastName).toEqual('Jerusalem');

    // Check if the new opportunity is associated with the new account
    expect(newOpportunity.AccountId).toEqual(newAccountId);

    const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id!);
    const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id!);
    const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id!);

    // should be able to query the new custom object C record
    const newCustObjC: any = (await conn2.sobject('Custom_Object_C__c').select('*, Owner.Name').where(`Id = '${newCustObjCId}'`).execute())[0];
    expect(newCustObjC).toBeDefined();
    expect(newCustObjC.Lookup_to_A__c).toEqual(newCustObjAId);
    expect(newCustObjC.Owner.Name).toEqual('Integration User');

    // should be able to query the new custom object A record
    const newCustObjA = await retrieveRecord(conn2, 'Custom_Object_A__c', newCustObjAId);
    expect(newCustObjA.Lookup_to_B__c).toEqual(newCustObjBId);

    // should be able to query the new custom object B record
    const newCustObjB = await retrieveRecord(conn2, 'Custom_Object_B__c', newCustObjBId);
    expect(newCustObjB.Lookup_to_C__c).toEqual(newCustObjCId);

    // given
    const contact2 = await createRecord(conn1, 'Contact', { FirstName: 'Ocean', LastName: 'Man', AccountId: account.id! });

    config.recordIds = [contact2.id!, custObjA.id!];

    const { parsedOutput: parsedOutput2, capturedOutput } = await runMigration(config);
    expect(capturedOutput).not.toContain('updating'); // should only create new record

    const newContactId2 = assertRecordMigrated(parsedOutput2, contact2.id!);

    // should be able to query the new contact record
    const newContact2 = await retrieveRecord(conn2, 'Contact', newContactId2);
    expect(newContact2.FirstName).toEqual('Ocean');
    expect(newContact2.LastName).toEqual('Man');
    expect(newContact2.AccountId).toEqual(newAccountId);
});

test('match record by id field', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { sourceRecord: custObjC, targetRecord: custObjC2 } = await createDuplicateCustObjCs(conn1, conn2);

    const custObjB = await createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id! });
    const custObjB2 = await createRecord(conn2, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC2.id! });

    const config = createBasicConfig([custObjB.id!], {
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

    assertRecordMappedTo(parsedOutput, custObjB.id!, custObjB2.id!);
});

test('record is skipped, any field updates are cancelled', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { sourceRecord: custObjC } = await createDuplicateCustObjCs(conn1, conn2);

    const custObjB = await createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id! });
    const custObjA = await createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id! });

    await conn1.sobject('Custom_Object_C__c').update({ Id: custObjC.id!, Lookup_to_A__c: custObjA.id! });

    const config = createBasicConfig([custObjB.id!]);

    await runMigration(config, ['y', 's', 's', 's']);

    // does not throw error
});

test('migrate record with error - fixed automatically', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!], {
        solvers: [fixContractStatusSolver]
    });

    const { parsedOutput } = await runMigration(config);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id!, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('hide error from output if solver says so', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!], {
        solvers: [{ ...fixContractStatusSolver, hideError: true }]
    });

    const { parsedOutput } = await runMigration(config);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should not contain any errors
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).not.toHaveProperty(contract.id!);
});

test('migrate record with error - fixed automatically, solver does not work', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!], {
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

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message for both the failed solver and the manual fix
    assertFixedErrors(parsedOutput, contract.id!, [
        { action: 'fix', changeFields: [{ field: 'ContractTerm', value: 11 }] },
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id!, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually, invalid response to solution choice', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 'blocked', 'f', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id!, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed manually, invalid JSON', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": Draft"}', 'asdasfd', '{"Status": "Draft"}']);

    const newContractId = assertRecordMigrated(parsedOutput, contract.id!);

    // should be able to query the new contract record
    const newContract = await retrieveRecord(conn2, 'Contract', newContractId);
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    assertFixedErrors(parsedOutput, contract.id!, [
        { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
    ]);
});

test('migrate record with error - fixed automatically, remove field if new value is null', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj, name } = await createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id!], {
        solvers: [extractFussyColumnSolver(null)]
    });

    const { parsedOutput, capturedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id!);

    const newCustObj = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    const usingSolver = capturedOutput.find(e => e.type === 'using_solver');
    expect(usingSolver).toBeDefined();
    expect(usingSolver?.data?.solverMessage).toEqual(FUSSY_FIELD_ERROR);
    expect(usingSolver?.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be')).toBeTruthy();
    expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
});

test('migrate record with error - fixed manually, remove field if new value is null', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj, name } = await createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id!]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'f', '{"Fussy_Field_1__c": null}']);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id!);

    const newCustObj = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.find(e => e.type === 'insert_error' && e.data?.recordId === custObj.id && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be' ))).toBeDefined();
    expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
});

test('migrate record with error - automatically extract column name to update', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj, name } = await createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj.id!], {
        solvers: [extractFussyColumnSolver(null)]
    });

    const { parsedOutput, capturedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id!);

    const newCustObj = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(0);
});

test('skip solver only if messages were the same', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj, name } = await createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

    const config = createBasicConfig([custObj.id!], {
        solvers: [extractFussyColumnSolver('asdf')]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id!);

    const newCustObj = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId);
    expect(newCustObj.Name).toEqual(name);

    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(custObj.id!);
    expect(parsedOutput.errors[custObj.id!]).toHaveLength(2);
});

test('migrate record with error - manually add new solver', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj: custObj1, name: name1 } = await createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });
    const { custObj: custObj2, name: name2 } = await createFussyCustObjD(conn1, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

    const config = createBasicConfig([custObj1.id!, custObj2.id!]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', '{"action": "extract_column", "message": "Field \'(\\\\w+)\'  can\'t be", "replaceWith": "asdf"}']);

    const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id!);
    const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id!);

    const newCustObj1 = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId1);
    expect(newCustObj1.Name).toEqual(name1);
    expect(newCustObj1.Fussy_Field_1__c).toEqual('blocked');
    expect(newCustObj1.Fussy_Field_2__c).toEqual('blocked');

    const newCustObj2 = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId2);
    expect(newCustObj2.Name).toEqual(name2);
    expect(newCustObj2.Fussy_Field_1__c).toEqual('blocked');
    expect(newCustObj2.Fussy_Field_2__c).toEqual('blocked');

    expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'extract_column' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
});

test('migrate record with error - manually add new solver, invalid solver', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { custObj: custObj1, name: name1 } = await createFussyCustObjD(conn1);
    const { custObj: custObj2, name: name2 } = await createFussyCustObjD(conn1);

    const config = createBasicConfig([custObj1.id!, custObj2.id!]);

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', 'asdasd', '{zzz}', '{"action": "fix", "message": "((", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}', '{"action": "fix", "message": "Field \'Fussy_Field_1__c\'  can\'t be", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}']);

    const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id!);
    const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id!);

    const newCustObj1 = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId1);
    expect(newCustObj1.Name).toEqual(name1);

    const newCustObj2 = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjId2);
    expect(newCustObj2.Name).toEqual(name2);

    expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'fix' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
});

test('migrate record with error - automatically skip record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!], {
        solvers: [
            {
                action: 'skip',
                message: CONTRACT_STATUS_ERROR
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    assertRecordSkipped(parsedOutput, contract.id!);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // should be able to query the new account record
    const newAccount = await retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');
});

test('migrate record with error - manually skip record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 's']);

    assertRecordSkipped(parsedOutput, contract.id!);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // should be able to query the new account record
    const newAccount = await retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual('Cloud Kicks');
});

test('migrate record with error - automatically match duplicate record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id!], {
        solvers: [
            {
                action: 'match',
                message: 'duplicate value found: External_Id__c duplicates value on record with id: ([a-zA-Z0-9]{15,18})'
            }
        ]
    });

    const { parsedOutput } = await runMigration(config);

    const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id!, targetRecord.id!);

    // should be able to query the new custom object C record
    const newCustObjC = await retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually match duplicate record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 'm', targetRecord.id!]);

    const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id!, targetRecord.id!);

    // should be able to query the new custom object C record
    const newCustObjC = await retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually retry insert', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id!]);

    const { parsedOutput } = await runMigration(config, async (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
            expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
            // delete record from Org B
            await conn2.sobject('Custom_Object_C__c').delete(targetRecord.id!);
            // retry insert
            sendInput('r');
        }
    });

    const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id!);

    // should be able to query the new custom object C record
    const newCustObjC = await retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).toEqual(externalId);

    expect(parsedOutput.errors).toHaveProperty(sourceRecord.id!);
    expect(parsedOutput.errors[sourceRecord.id!]).toHaveLength(1);
    expect(parsedOutput.errors[sourceRecord.id!][0].fixed).toBeTruthy();
});

test('manually retry all records', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const count = 5;
    const records1 = [];
    for (let i = 0; i < count; i++) {
        console.log(`creating record ${i}`);
        const externalId = `ext-${Math.random()}`;
        const record = await createRecord(conn1, 'Custom_Object_C__c', { External_Id__c: externalId });
        records1.push({
            id: record.id,
            externalId
        });
    }
    const records2: any[] = [];
    for (const record of records1) {
        console.log(`creating record ${record.externalId} in target org`);
        const record2 = await createRecord(conn2, 'Custom_Object_C__c', { External_Id__c: record.externalId });
        records2.push({
            id: record2.id,
            externalId: record.externalId
        });
    }

    const config = createBasicConfig(records1.map(r => r.id!));

    let retryCount = 0;
    const { parsedOutput } = await runMigration(config, async (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
            retryCount++;
            expect(retryCount).toBe(1);
            expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
            // delete records from Org B
            for (const record of records2) {
                await conn2.sobject('Custom_Object_C__c').delete(record.id!);
            }
            // retry insert for all records
            sendInput('ra');
        }
    });
    expect(retryCount).toBe(1);

    for (const record of records1) {
        assertRecordMigrated(parsedOutput, record.id!);
    }
});

test('migrate record with error - quit and save results so far', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    const { parsedOutput } = await runMigration(config, ['y', 'h']);

    // check if Account was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // run migration again, for Account
    config.recordIds = [account.id!];
    const { parsedOutput: parsedOutput2 } = await runMigration(config, ['y']);

    // Account should not be migrated again
    assertRecordMappedTo(parsedOutput2, account.id!, newAccountId);
});

test('match not found, create new record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    const account1 = await createAccount(conn1, account1Name);
    const account2 = await createAccount(conn1, account2Name);
    const account1B = await createAccount(conn2, account1Name);

    const config = createBasicConfig([account1.id!, account2.id!], {
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

    assertRecordMappedTo(parsedOutput, account1.id!, account1B.id!);

    const newAccount2Id = assertRecordMigrated(parsedOutput, account2.id!);

    // should be able to query the new account record
    const newAccount2 = await retrieveRecord(conn2, 'Account', newAccount2Id);
    expect(newAccount2.Name).toEqual(account2Name);
});

test('match not found, skip record', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    const account1 = await createAccount(conn1, account1Name);
    const account2 = await createAccount(conn1, account2Name);
    const account1B = await createAccount(conn2, account1Name);

    const config = createBasicConfig([account1.id!, account2.id!], {
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

    assertRecordMappedTo(parsedOutput, account1.id!, account1B.id!);

    assertRecordSkipped(parsedOutput, account2.id!);

    // should not be able to query the new account record by account name
    const newAccount2: any = await conn2.sobject('Account').select('Id').where(`Name = '${account2Name}'`).execute();
    expect(newAccount2.length).toBe(0);
});

test('use history for both primary and secondary records', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account1Name = `Cloud Kicks ${Math.random()}`;
    const contactName = `John Doe ${Math.random()}`;

    const account = await createAccount(conn1, account1Name);
    const contact = await createRecord(conn1, 'Contact', { AccountId: account.id!, LastName: contactName });

    const config = createBasicConfig([contact.id!]);

    const { parsedOutput } = await runMigration(config);

    const newContactId = assertRecordMigrated(parsedOutput, contact.id!);

    // should be able to query the new contact record
    const newContact = await retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.LastName).toEqual(contactName);

    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // should be able to query the new account record
    const newAccount = await retrieveRecord(conn2, 'Account', newAccountId);
    expect(newAccount.Name).toEqual(account1Name);

    // run migration again with new contact
    const contact2 = await createRecord(conn1, 'Contact', { AccountId: account.id!, LastName: contactName });

    config.recordIds = [contact2.id!];

    const { parsedOutput: parsedOutput2 } = await runMigration(config);

    assertRecordMigrated(parsedOutput2, contact2.id!);

    assertRecordMappedTo(parsedOutput2, account.id!, newAccountId);
});

test('fix column automatically with modifying current value', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(conn1, conn2);

    const config = createBasicConfig([sourceRecord.id!], {
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

    const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id!);

    // should be able to query the new record
    const newCustObjC = await retrieveRecord(conn2, 'Custom_Object_C__c', newCustObjCId);
    expect(newCustObjC.External_Id__c).not.toEqual(externalId);
    expect(newCustObjC.External_Id__c).toMatch(new RegExp(`^${externalId}\\.[a-z0-9]{4}$`));

    // error should be logged
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(sourceRecord.id!);
    expect(parsedOutput.errors[sourceRecord.id!]).toHaveLength(1);
    expect(parsedOutput.errors[sourceRecord.id!][0].message).toEqual(`duplicate value found: External_Id__c duplicates value on record with id: ${targetRecord.id}`);
});

test('more than 10 chunks', async () => {
    const { conn1 } = await setupTestConnections();

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
        const record = await createRecord(conn1, sObjectType, fields);
        recordIds.push(record.id!);
    }

    const config = createBasicConfig(recordIds);

    const { parsedOutput } = await runMigration(config);

    for (const recordId of recordIds) {
        assertRecordMigrated(parsedOutput, recordId);
    }
});

test('failed later update', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const custObjD = await createRecord(conn1, 'Custom_Object_D__c', { Fussy_Field_1__c: 'fail' });

    const config = createBasicConfig([custObjD.id!], {
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

    const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id!);

    // should be able to query the new record
    const newCustObjD = await retrieveRecord(conn2, 'Custom_Object_D__c', newCustObjDId);
    expect(newCustObjD.Fussy_Field_1__c).toEqual('ok');
});

test('match by wrong field', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const accountName = `Cloud Kicks ${Math.random()}`;
    const account1 = await createAccount(conn1, accountName);
    await createAccount(conn2, accountName);

    const config = createBasicConfig([account1.id!], {
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Ugabuga', targetField: 'Ugabuga' }
            ]
        }]
    });

    try {
        await runMigration(config);
        fail('Migration should have failed');
    } catch (error) {
        console.log(error);
    }
});

test('find ids inside text', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');
    const custObjD = await createRecord(conn1, 'Custom_Object_D__c', { });

    const case1 = await createRecord(conn1, 'Case', {
        Description: `Here's an Id for you: ${account.id} and here's another one: ${custObjD.id}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`
    });

    const config = createBasicConfig([case1.id!]);

    const { parsedOutput } = await runMigration(config);

    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id!);
    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);
    const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id!);

    const newCase1 = await retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe(`Here's an Id for you: ${newAccountId} and here's another one: ${newCustObjDId}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`);
});

test('invalid record id in field', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const case1 = await createRecord(conn1, 'Case', {
        Description: `This record does not exist: 001J6000002UKyHIAW`
    });

    const config = createBasicConfig([case1.id!]);

    const { parsedOutput } = await runMigration(config);

    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id!);

    const newCase1 = await retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe(`This record does not exist: 001J6000002UKyHIAW`);
});

test('record references self', async () => {
    const { conn1 } = await setupTestConnections();

    const case1 = await createRecord(conn1, 'Case', {});

    await conn1.sobject('Case').update({
        Id: case1.id!,
        Description: `This is my id: ${case1.id}`
    });

    const config = createBasicConfig([case1.id!]);

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, case1.id!);

    // const newCase1: any = await conn2.sobject('Case').retrieve(newCase1Id);
    // expect(newCase1).toBeDefined();
    // expect(newCase1.Description).toBe(`This is my id: ${newCase1Id}`);
});

test('circular relationship in text fields', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const caseA = await createRecord(conn1, 'Case', {});

    const caseB = await createRecord(conn1, 'Case', {
        Description: `I like ${caseA.id}`
    });

    const caseC = await createRecord(conn1, 'Case', {
        Description: `And I like ${caseB.id}`
    });

    await conn1.sobject('Case').update({
        Id: caseA.id!,
        Description: `But I like ${caseC.id} better`
    });

    const config = createBasicConfig([caseA.id!, caseB.id!, caseC.id!]);

    const { parsedOutput } = await runMigration(config);

    const newCaseAId = assertRecordMigrated(parsedOutput, caseA.id!);
    const newCaseBId = assertRecordMigrated(parsedOutput, caseB.id!);
    const newCaseCId = assertRecordMigrated(parsedOutput, caseC.id!);

    const newCaseA = await retrieveRecord(conn2, 'Case', newCaseAId);
    expect(newCaseA.Description).toBe(`But I like ${newCaseCId} better`);

    const newCaseB = await retrieveRecord(conn2, 'Case', newCaseBId);
    expect(newCaseB.Description).toBe(`I like ${newCaseAId}`);

    const newCaseC = await retrieveRecord(conn2, 'Case', newCaseCId);
    expect(newCaseC.Description).toBe(`And I like ${newCaseBId}`);
});

test('non-queryable and non-creatable object', async () => {
    const { conn1 } = await setupTestConnections();

    const contentVersion = await createRecord(conn1, 'ContentVersion', {
        Title: 'Test Document', // Required field
        PathOnClient: 'test.txt', // Required field
        VersionData: 'Hello World'
    });

    const config = createBasicConfig([contentVersion.id!]);

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, contentVersion.id!);
});

test('write output to log file', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id!]);

    const { parsedOutput } = await runMigration(config, ['y'], 'test-output.log');

    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    expect(hasSavedRecord(readLogEvents('test-output.log'), newAccountId)).toBe(true);

    // run another migration to check that the log file is overwritten
    const account2 = await createAccount(conn1, 'Cloud Kicks 2');

    const config2 = createBasicConfig([account2.id!]);

    const { parsedOutput: parsedOutput2 } = await runMigration(config2, ['y'], 'test-output.log');
    const newAccountId2 = assertRecordMigrated(parsedOutput2, account2.id!);

    const logEvents2 = readLogEvents('test-output.log');
    expect(hasSavedRecord(logEvents2, newAccountId2)).toBe(true);
    expect(hasSavedRecord(logEvents2, newAccountId)).toBe(false);
});

test('malformed id', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const case1 = await createRecord(conn1, 'Case', {
        Description: 'Bad Id: 574300075a6OKB0000'
    });

    const config = createBasicConfig([case1.id!]);

    const { parsedOutput } = await runMigration(config);
    const newCase1Id = assertRecordMigrated(parsedOutput, case1.id!);

    const newCase1 = await retrieveRecord(conn2, 'Case', newCase1Id);
    expect(newCase1.Description).toBe('Bad Id: 574300075a6OKB0000');
});

test('limit level of depth for querying related records', async () => {
    const { conn1 } = await setupTestConnections();

    const HIERARCHY_LEVEL = 4;

    const accounts: any[] = [];
    for (let i = 0; i < HIERARCHY_LEVEL; i++) {
        const account = await createRecord(conn1, 'Account', { Name: `Account ${i}`, ParentId: accounts[i - 1]?.id });
        accounts.push(account);
    }

    const contact = await createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe',
        AccountId: accounts[0].id
    });

    const contact2 = await createRecord(conn1, 'Contact', {
        FirstName: 'Jane',
        LastName: 'Doe',
        AccountId: accounts[1].id
    });

    const config = createBasicConfig([accounts[HIERARCHY_LEVEL - 1].id!], {
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
        assertRecordMigrated(parsedOutput, accounts[i].id!);
    }

    expect(parsedOutput).not.toHaveProperty(contact.id!);

    assertRecordMigrated(parsedOutput, contact2.id!);
});

test('fetch related record for a record that is in history', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const config = createBasicConfig([account.id!]);

    const { parsedOutput } = await runMigration(config);

    assertRecordMigrated(parsedOutput, account.id!);

    // create contact
    const contact = await createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe',
        AccountId: account.id
    });

    // run migration with added relationship for Account
    const config2 = createBasicConfig([account.id!], {
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        }
    });

    const { parsedOutput: parsedOutput2 } = await runMigration(config2);

    assertRecordMigrated(parsedOutput2, account.id!);

    assertRecordMigrated(parsedOutput2, contact.id!);
});

test('save history file even if app is closed unexpectedly', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const accountName = `Unique Account ${Date.now()}`;
    const account = await createAccount(conn1, accountName);
    const contract = await createActivatedContract(conn1, account.id!);

    const config = createBasicConfig([contract.id!]);

    await runMigration(config, function(event, sendInput, exit) {
        if (event.type === 'confirm_migration') {
            sendInput('y');
        } else if (event.type === 'insert_error') {
            // close app
            exit();
        }
    });

    const newAccount = await conn2.query(`SELECT Id, Name FROM Account WHERE Name = '${accountName}'`);
    expect(newAccount).toBeDefined();
    expect(newAccount.records.length).toBe(1);

    // run migration again
    const config2 = createBasicConfig([contract.id!], {
        solvers: [fixContractStatusSolver]
    });
    const { parsedOutput: parsedOutput2 } = await runMigration(config2);

    assertRecordMappedTo(parsedOutput2, account.id!, newAccount.records[0].Id!);
});

test('migrate to file and from file', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const custObjC = await createRecord(conn1, 'Custom_Object_C__c', { });
    const custObjB = await createRecord(conn1, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id! });
    const custObjA = await createRecord(conn1, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id! });

    const configToFile = {
        sourceOrg: sourceOrgAlias,
        targetFile: 'test-output.json',
        recordIds: [custObjA.id!],
        matchers: defaultMatchers
    };

    await runMigration(configToFile);

    const configFromFile = {
        sourceFile: 'test-output.json',
        targetOrg: targetOrgAlias,
        recordIds: [custObjA.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(configFromFile);

    const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id!);
    const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id!);
    const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id!);

    const newCustObjB = await retrieveRecord(conn2, 'Custom_Object_B__c', newCustObjBId);
    expect(newCustObjB.Lookup_to_C__c).toBe(newCustObjCId);

    const newCustObjA = await retrieveRecord(conn2, 'Custom_Object_A__c', newCustObjAId);
    expect(newCustObjA.Lookup_to_B__c).toBe(newCustObjBId);
});

// Creates an account hierarchy where the parent account's contract triggers an
// unhandled insert error (activated contract) and the child account's contract inserts cleanly
async function createFullAutoTestRecords(conn1: any) {
    const account = await createAccount(conn1, 'Cloud Kicks');
    const childAccount = await createRecord(conn1, 'Account', {
        Name: 'Child Account',
        ParentId: account.id
    });
    const contract = await createActivatedContract(conn1, account.id!);
    const contract2 = await createContract(conn1, childAccount.id!);
    return { account, contract, contract2 };
}

test('full auto mode - save and exit', async () => {
    const { conn1 } = await setupTestConnections();

    const { account, contract, contract2 } = await createFullAutoTestRecords(conn1);

    const config = createBasicConfig([contract.id!, contract2.id!], {
        fullAuto: {
            enabled: true,
            unhandledErrorBehavior: 'saveAndExit'
        }
    });

    const { parsedOutput } = await runMigration(config, []); // no input needed for full auto mode

    assertRecordMigrated(parsedOutput, account.id!);

    expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract.id!);
    expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract2.id!);
});

test('full auto mode - skip', async () => {
    const { conn1 } = await setupTestConnections();

    const { account, contract, contract2 } = await createFullAutoTestRecords(conn1);

    const config = createBasicConfig([contract.id!, contract2.id!], {
        fullAuto: {
            enabled: true,
            unhandledErrorBehavior: 'skip'
        }
    });

    const { parsedOutput } = await runMigration(config, []); // no input needed for full auto mode

    assertRecordMigrated(parsedOutput, account.id!);

    assertRecordSkipped(parsedOutput, contract.id!);
    assertRecordMigrated(parsedOutput, contract2.id!);
});

test('anonymize email fields', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const uniqueEmail = `test+${Date.now()}@example.com`;
    const contact = await createRecord(conn1, 'Contact', { FirstName: 'John', LastName: 'Doe', Email: uniqueEmail });

    const config = createBasicConfig([contact.id!], {
        anonymization: {
            emailFields: {
                mode: 'obfuscate'
            }
        }
    });

    const { parsedOutput } = await runMigration(config);

    const newContactId = assertRecordMigrated(parsedOutput, contact.id!);

    const newContact = await retrieveRecord(conn2, 'Contact', newContactId);
    expect(newContact.Email).not.toBe(uniqueEmail);
    expect(newContact.Email).toContain('@');
});

test('report record reason counts', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Cloud Kicks');

    const contact = await createRecord(conn1, 'Contact', {
        FirstName: 'John',
        LastName: 'Doe'
    });

    const contact2 = await createRecord(conn1, 'Contact', {
        FirstName: 'Jane',
        LastName: 'Doe',
        AccountId: account.id!,
        ReportsToId: contact.id!
    });

    const caseRecord = await createRecord(conn1, 'Case', {
        Subject: 'Test Case',
        ContactId: contact.id!
    });

    const config = createBasicConfig([account.id!], {
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

    assertRecordMigrated(parsedOutput, account.id!);
    assertRecordMigrated(parsedOutput, contact.id!);
    assertRecordMigrated(parsedOutput, contact2.id!);
    assertRecordMigrated(parsedOutput, caseRecord.id!);
});

test('custom history file path', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Custom History Test Account');

    const customHistoryPath = './custom_history_test.json';
    const config = createBasicConfig([account.id!], {
        historyFilePath: customHistoryPath
    });

    const { parsedOutput } = await runMigration(config);

    // Verify record was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // Verify custom history file was created
    expect(fs.existsSync(customHistoryPath)).toBe(true);

    // Verify custom history file contains the mapping
    const historyContent = JSON.parse(fs.readFileSync(customHistoryPath, 'utf8'));
    expect(historyContent).toHaveProperty(account.id!);
    expect(historyContent[account.id!]).toBe(newAccountId);

    // Verify default history file was NOT created
    expect(fs.existsSync(`${targetOrgAlias}__history.json`)).toBe(false);
});

test('custom history file path as directory', async () => {
    const { conn1 } = await setupTestConnections();

    const account = await createAccount(conn1, 'Custom History Test Account');

    const customHistoryPath = './custom_history_test_dir';
    fs.mkdirSync(customHistoryPath, { recursive: true });
    const config = createBasicConfig([account.id!], {
        historyFilePath: customHistoryPath
    });

    const { parsedOutput } = await runMigration(config);

    // Verify record was migrated
    const newAccountId = assertRecordMigrated(parsedOutput, account.id!);

    // Verify custom history file was created
    expect(fs.existsSync(`${customHistoryPath}/${targetOrgAlias}__history.json`)).toBe(true);

    // Verify custom history file contains the mapping
    const historyContent = JSON.parse(fs.readFileSync(`${customHistoryPath}/${targetOrgAlias}__history.json`, 'utf8'));
    expect(historyContent).toHaveProperty(account.id!);
    expect(historyContent[account.id!]).toBe(newAccountId);

    // Verify default history file was NOT created
    expect(fs.existsSync(`${targetOrgAlias}__history.json`)).toBe(false);
});

test('solver with additional info from error', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const rtEnhanced = await conn1.sobject('RecordType').findOne({
        sObjectType: 'Custom_Object_E__c',
        DeveloperName: 'Enhanced'
    }, 'Id');
    expect(rtEnhanced).toBeDefined();
    const custObjE = await createRecord(conn1, 'Custom_Object_E__c', { RecordTypeId: rtEnhanced!.Id, Some_picklist__c: 'Enhanced value' });

    const config = createBasicConfig([custObjE.id!], {
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

    const newCustObjEId = assertRecordMigrated(parsedOutput, custObjE.id!);
    const newCustObjE = await retrieveRecord(conn2, 'Custom_Object_E__c', newCustObjEId);
    expect(newCustObjE.Some_picklist__c).toBe('Normal value');
});

test('bulk update records', async () => {
    const { conn1, conn2 } = await setupTestConnections();

    const recordsToCreate = [];
    for (let i = 0; i < 211; i++) {
        recordsToCreate.push({ Name: `ext-${Math.random()}` });
    }

    const allCreateResults = await bulkInChunks(conn1, 'Custom_Object_D__c', 'create', recordsToCreate);
    expect(allCreateResults).toHaveLength(211);

    // Prepare updates for all created records
    const recordsToUpdate = [];
    const recordIds: string[] = [];
    for (const result of allCreateResults) {
        expect(result.success).toBe(true);
        expect(result.id).toBeDefined();
        recordIds.push(result.id!);
        recordsToUpdate.push({
            Id: result.id!,
            Fussy_Field_1__c: 'blocked',
            Fussy_Field_2__c: 'blocked'
        });
    }

    const allUpdateResults = await bulkInChunks(conn1, 'Custom_Object_D__c', 'update', recordsToUpdate);
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
        const record = await retrieveRecord(conn2, 'Custom_Object_D__c', newRecordId);
        expect(record.Fussy_Field_1__c).toBe('blocked');
        expect(record.Fussy_Field_2__c).toBe('blocked');
    }
    expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(2);
});
