/**
 * The contract between the e2e scenarios and the context they run in.
 *
 * The scenarios in e2e-scenarios.ts are written once and executed twice:
 * against real scratch orgs and the built CLI (e2e.test.ts), and against
 * in-memory orgs and an in-process `main()` (e2e-mock.test.ts). Everything a
 * scenario needs from its context goes through the interfaces below, and
 * everything a scenario needs that is the same in both contexts - matchers,
 * solvers, config factories, assertions - lives here.
 */

import { expect } from '@jest/globals';
import fs from 'fs';
import { IOEvent } from '../app';

// Error emitted when inserting a Contract with Status = 'Activated'
export const CONTRACT_STATUS_ERROR = 'Choose a valid contract status and save your changes. Ask your admin for details.';
// Error pattern emitted when inserting Custom_Object_D__c with a fussy field set to 'blocked'
export const FUSSY_FIELD_ERROR = 'Field \'(\\w+)\'  can\'t be';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The record-level operations a scenario performs directly on an org. */
export interface TestOrg {
    readonly alias: string;
    readonly instanceUrl: string;
    readonly accessToken: string;

    create(sObjectType: string, fields?: any): Promise<{ id: string }>;
    createAll(sObjectType: string, records: any[]): Promise<{ id: string }[]>;
    update(sObjectType: string, changes: any): Promise<void>;
    updateAll(sObjectType: string, records: any[]): Promise<void>;
    delete(sObjectType: string, recordId: string): Promise<void>;
    retrieve(sObjectType: string, recordId: string): Promise<any>;
    /** Records matching every condition. Only `Id` is guaranteed to be populated. */
    findIds(sObjectType: string, conditions: Record<string, any>): Promise<{ Id: string }[]>;
    query(soql: string): Promise<{ records: any[] }>;
}

/**
 * Answers the app's input requests. An array is consumed one input per request;
 * a function is called for every request and answers through `sendInput`, or
 * ends the run as if the app had been closed through `exit`.
 */
export type InputHandler =
    | string[]
    | ((event: IOEvent, sendInput: (input: string) => void, exit: () => void) => void | Promise<void>);

export interface MigrationRunResult {
    /** The parsed `finished` payload, or null when the run was ended through `exit`. */
    parsedOutput: any;
    capturedOutput: IOEvent[];
}

export interface E2EContext {
    sourceOrg: TestOrg;
    targetOrg: TestOrg;
    runMigration(config: any, inputHandler?: InputHandler, outputFile?: string): Promise<MigrationRunResult>;
}

export interface E2EScenario {
    name: string;
    run(ctx: E2EContext): Promise<void>;
}

export function scenario(name: string, run: (ctx: E2EContext) => Promise<void>): E2EScenario {
    return { name, run };
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

export const defaultMatchers = [
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

export const fixContractStatusSolver = {
    action: 'fix',
    message: CONTRACT_STATUS_ERROR,
    changeFields: [
        {
            field: 'Status',
            value: 'Draft'
        }
    ]
};

export function extractFussyColumnSolver(replaceWith: string | null, additionalOptions: any = {}) {
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

export function createBasicConfig(ctx: E2EContext, recordIds: string[], additionalOptions: any = {}) {
    return {
        sourceOrg: ctx.sourceOrg.alias,
        targetOrg: ctx.targetOrg.alias,
        recordIds,
        matchers: defaultMatchers,
        ...additionalOptions
    };
}

export function createTokenAuthConfig(ctx: E2EContext, recordIds: string[], additionalOptions: any = {}) {
    return {
        sourceOrgUrl: ctx.sourceOrg.instanceUrl,
        sourceOrgToken: ctx.sourceOrg.accessToken,
        targetOrgUrl: ctx.targetOrg.instanceUrl,
        targetOrgToken: ctx.targetOrg.accessToken,
        recordIds,
        matchers: defaultMatchers,
        ...additionalOptions
    };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

export async function createRecord(org: TestOrg, sObjectType: string, fields: any = {}) {
    const record = await org.create(sObjectType, fields);
    expect(record.id).toBeDefined();
    return record;
}

export async function createAccount(org: TestOrg, name: string = `Account-${Math.random()}`) {
    return createRecord(org, 'Account', { Name: name });
}

export async function createContract(org: TestOrg, accountId: string, status: string = 'Draft', contractTerm: number = 12) {
    return createRecord(org, 'Contract', {
        AccountId: accountId,
        Status: status,
        StartDate: new Date().toISOString(),
        ContractTerm: contractTerm
    });
}

// An activated Contract cannot be inserted as-is into the target org, so migrating
// it triggers the CONTRACT_STATUS_ERROR insert error.
export async function createActivatedContract(org: TestOrg, accountId: string) {
    const contract = await createContract(org, accountId);
    await org.update('Contract', { Id: contract.id, Status: 'Activated' });
    return contract;
}

// Custom_Object_D__c with fussy fields set to 'blocked' triggers the
// FUSSY_FIELD_ERROR insert error in the target org.
export async function createFussyCustObjD(org: TestOrg, fussyFields: any = { Fussy_Field_1__c: 'blocked' }) {
    const name = `ext-${Math.random()}`;
    const custObj = await createRecord(org, 'Custom_Object_D__c', { Name: name });
    await org.update('Custom_Object_D__c', { Id: custObj.id, ...fussyFields });
    return { custObj, name };
}

// Creates a Custom_Object_C__c with the same unique External_Id__c in both orgs,
// so inserting the source record into the target org triggers a duplicate value error.
export async function createDuplicateCustObjCs(sourceOrg: TestOrg, targetOrg: TestOrg) {
    const externalId = `ext-${Math.random()}`;
    const sourceRecord = await createRecord(sourceOrg, 'Custom_Object_C__c', { External_Id__c: externalId });
    const targetRecord = await createRecord(targetOrg, 'Custom_Object_C__c', { External_Id__c: externalId });
    return { externalId, sourceRecord, targetRecord };
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

export function confirmMigration(checkData?: (data: any) => void): InputHandler {
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

export function assertRecordMigrated(parsedOutput: any, recordId: string): string {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    const newRecordId = recordSource[recordId];
    expect(newRecordId).toBeTruthy();
    expect(newRecordId).not.toEqual(recordId);
    return newRecordId;
}

/** A skipped record appears in the output with an empty string as the new id. */
export function assertRecordSkipped(parsedOutput: any, recordId: string) {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    expect(recordSource[recordId]).toBe('');
}

export function assertRecordNotMigrated(parsedOutput: any, recordId: string) {
    expect(getMigratedRecords(parsedOutput)).not.toHaveProperty(recordId);
}

/**
 * Asserts the record was mapped to a specific existing target record
 * (matched to a duplicate or reused from history) instead of being created anew.
 */
export function assertRecordMappedTo(parsedOutput: any, recordId: string, expectedNewId: string): string {
    const recordSource = getMigratedRecords(parsedOutput);
    expect(recordSource).toHaveProperty(recordId);
    const newRecordId = recordSource[recordId];
    expect(newRecordId).toBeTruthy();
    expect(newRecordId).toEqual(expectedNewId);
    return newRecordId;
}

export function assertFixedErrors(parsedOutput: any, recordId: string, expectedSolvers: { action: string, changeFields?: any }[], message: string = CONTRACT_STATUS_ERROR) {
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

export async function retrieveRecord(org: TestOrg, sObjectType: string, recordId: string): Promise<any> {
    const record = await org.retrieve(sObjectType, recordId);
    expect(record).toBeDefined();
    return record;
}

export function readLogEvents(filePath: string): any[] {
    return fs.readFileSync(filePath, 'utf8').split('\n').map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(line => line !== null);
}

export function hasSavedRecord(logEvents: any[], recordId: string) {
    return logEvents.some(line => line.type === 'saved_records' && line.data.some((record: any) => record.id === recordId && record.success));
}

// ---------------------------------------------------------------------------
// Shared harness plumbing
// ---------------------------------------------------------------------------

/** Turns the captured events into the result a scenario works with. */
export function toMigrationRunResult(capturedOutput: IOEvent[], exitCalled: boolean): MigrationRunResult {
    if (exitCalled) {
        return { parsedOutput: null, capturedOutput };
    }
    expect(capturedOutput.length).toBeGreaterThan(1);
    const finished = [...capturedOutput].reverse().find(event => event.type === 'finished');
    expect(finished).toBeDefined();
    return { parsedOutput: JSON.parse(finished!.data), capturedOutput };
}

/** Files a migration run leaves behind in the working directory. */
export function cleanupMigrationArtifacts(targetOrgAlias: string) {
    const files = [
        `${targetOrgAlias}__history.json`,
        // written when the config authenticates with url + token and names no target org
        'undefined__history.json',
        './custom_history_test.json',
        './test-output.json',
        './test-output.db',
        './test-output.log'
    ];
    for (const file of files) {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
    if (fs.existsSync('./custom_history_test_dir')) {
        fs.rmSync('./custom_history_test_dir', { recursive: true });
    }
}
