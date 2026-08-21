/**
 * The e2e scenarios, defined once and executed in two contexts:
 * e2e.test.ts runs them against real scratch orgs and the built CLI,
 * e2e-mock.test.ts runs them against in-memory orgs and an in-process `main()`.
 *
 * A scenario may only talk to its orgs through the `TestOrg` interface and may
 * only start migrations through `ctx.runMigration`, so anything it asserts holds
 * in both contexts. Anything that is true of only one of them belongs in that
 * context's test file, not here.
 */

import { expect } from '@jest/globals';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
    CONTRACT_STATUS_ERROR,
    E2EContext,
    E2EScenario,
    FUSSY_FIELD_ERROR,
    TestOrg,
    assertFixedErrors,
    assertRecordMappedTo,
    assertRecordMigrated,
    assertRecordNotMigrated,
    assertRecordSkipped,
    confirmMigration,
    createAccount,
    createActivatedContract,
    createBasicConfig,
    createContract,
    createDuplicateCustObjCs,
    createFussyCustObjD,
    createRecord,
    createTokenAuthConfig,
    defaultMatchers,
    extractFussyColumnSolver,
    fixContractStatusSolver,
    hasSavedRecord,
    readLogEvents,
    retrieveRecord,
    scenario
} from './e2e-harness';

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

// Creates an account hierarchy where the parent account's contract triggers an
// unhandled insert error (activated contract) and the child account's contract inserts cleanly
async function createFullAutoTestRecords(sourceOrg: TestOrg) {
    const account = await createAccount(sourceOrg, 'Cloud Kicks');
    const childAccount = await createRecord(sourceOrg, 'Account', {
        Name: 'Child Account',
        ParentId: account.id
    });
    const contract = await createActivatedContract(sourceOrg, account.id);
    const contract2 = await createContract(sourceOrg, childAccount.id);
    return { account, contract, contract2 };
}

export const e2eScenarios: E2EScenario[] = [

    scenario('migrate record - single', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = createBasicConfig(ctx, [account.id]);
        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, account.id);
    }),

    scenario('url and token auth', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = createTokenAuthConfig(ctx, [account.id]);
        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, account.id);
    }),

    scenario('source auth token, target auth alias', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = {
            sourceOrgUrl: ctx.sourceOrg.instanceUrl,
            sourceOrgToken: ctx.sourceOrg.accessToken,
            targetOrg: ctx.targetOrg.alias,
            recordIds: [account.id],
            matchers: defaultMatchers
        };

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, account.id);
    }),

    scenario('source auth alias, target auth token', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = {
            sourceOrg: ctx.sourceOrg.alias,
            targetOrgUrl: ctx.targetOrg.instanceUrl,
            targetOrgToken: ctx.targetOrg.accessToken,
            recordIds: [account.id],
            matchers: defaultMatchers
        };

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, account.id);
    }),

    scenario('migrate record - complex', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contact = await createRecord(ctx.sourceOrg, 'Contact', { FirstName: 'Spider', LastName: 'Jerusalem', AccountId: account.id });

        const campaignFields = { Name: `Aaa! ${Math.random()}`, IsActive: true };
        const campaignOrgA = await createRecord(ctx.sourceOrg, 'Campaign', campaignFields);
        const campaignOrgB = await createRecord(ctx.targetOrg, 'Campaign', campaignFields);

        const opportunity = await createRecord(ctx.sourceOrg, 'Opportunity', {
            Name: 'Blasto Bandage',
            CampaignId: campaignOrgA.id,
            AccountId: account.id,
            StageName: 'Prospecting',
            CloseDate: new Date().toISOString()
        });

        const user = await ctx.sourceOrg.findIds('User', { Name: 'Integration User' });
        expect(user.length).toBeGreaterThan(0);
        expect(user[0].Id).toBeDefined();

        const custObjC = await createRecord(ctx.sourceOrg, 'Custom_Object_C__c', { OwnerId: user[0].Id });
        const custObjB = await createRecord(ctx.sourceOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
        const custObjA = await createRecord(ctx.sourceOrg, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

        // create circular dependency
        await ctx.sourceOrg.update('Custom_Object_C__c', { Id: custObjC.id, Lookup_to_A__c: custObjA.id });

        const config = createBasicConfig(ctx, [opportunity.id, custObjB.id, custObjA.id], {
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

        const { parsedOutput } = await ctx.runMigration(config, confirmMigration((recordCounts) => {
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
        const newOpportunity = await retrieveRecord(ctx.targetOrg, 'Opportunity', newOpportunityId);
        expect(newOpportunity.Name).toEqual('Blasto Bandage');
        expect(newOpportunity.CampaignId).toEqual(campaignOrgB.id);

        // should be able to query the new account record
        const newAccount = await retrieveRecord(ctx.targetOrg, 'Account', newAccountId);
        expect(newAccount.Name).toEqual('Cloud Kicks');

        // should be able to query the new contact record
        const newContact = await retrieveRecord(ctx.targetOrg, 'Contact', newContactId);
        expect(newContact.FirstName).toEqual('Spider');
        expect(newContact.LastName).toEqual('Jerusalem');

        // Check if the new opportunity is associated with the new account
        expect(newOpportunity.AccountId).toEqual(newAccountId);

        const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
        const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
        const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

        // should be able to query the new custom object C record, and its owner
        // should be the target org's own Integration User
        const newCustObjC = await retrieveRecord(ctx.targetOrg, 'Custom_Object_C__c', newCustObjCId);
        expect(newCustObjC.Lookup_to_A__c).toEqual(newCustObjAId);
        const newOwner = await retrieveRecord(ctx.targetOrg, 'User', newCustObjC.OwnerId);
        expect(newOwner.Name).toEqual('Integration User');

        // should be able to query the new custom object A record
        const newCustObjA = await retrieveRecord(ctx.targetOrg, 'Custom_Object_A__c', newCustObjAId);
        expect(newCustObjA.Lookup_to_B__c).toEqual(newCustObjBId);

        // should be able to query the new custom object B record
        const newCustObjB = await retrieveRecord(ctx.targetOrg, 'Custom_Object_B__c', newCustObjBId);
        expect(newCustObjB.Lookup_to_C__c).toEqual(newCustObjCId);

        // given
        const contact2 = await createRecord(ctx.sourceOrg, 'Contact', { FirstName: 'Ocean', LastName: 'Man', AccountId: account.id });

        config.recordIds = [contact2.id, custObjA.id];

        const { parsedOutput: parsedOutput2, capturedOutput } = await ctx.runMigration(config);
        // should only create new records, nothing to update afterwards
        expect(capturedOutput.filter(event => event.type === 'updating_record')).toHaveLength(0);

        const newContactId2 = assertRecordMigrated(parsedOutput2, contact2.id);

        // should be able to query the new contact record
        const newContact2 = await retrieveRecord(ctx.targetOrg, 'Contact', newContactId2);
        expect(newContact2.FirstName).toEqual('Ocean');
        expect(newContact2.LastName).toEqual('Man');
        expect(newContact2.AccountId).toEqual(newAccountId);
    }),

    scenario('match record by id field', async (ctx: E2EContext) => {
        const { sourceRecord: custObjC, targetRecord: custObjC2 } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const custObjB = await createRecord(ctx.sourceOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
        const custObjB2 = await createRecord(ctx.targetOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC2.id });

        const config = createBasicConfig(ctx, [custObjB.id], {
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

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMappedTo(parsedOutput, custObjB.id, custObjB2.id);
    }),

    scenario('record is skipped, any field updates are cancelled', async (ctx: E2EContext) => {
        const { sourceRecord: custObjC } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const custObjB = await createRecord(ctx.sourceOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
        const custObjA = await createRecord(ctx.sourceOrg, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

        await ctx.sourceOrg.update('Custom_Object_C__c', { Id: custObjC.id, Lookup_to_A__c: custObjA.id });

        const config = createBasicConfig(ctx, [custObjB.id]);

        await ctx.runMigration(config, (ioEvent, sendInput) => {
            if (ioEvent.type === 'confirm_migration') {
                sendInput('y');
            } else if (ioEvent.type === 'insert_error') {
                sendInput('s');
            }
        });

        // does not throw error
    }),

    scenario('migrate record with error - fixed automatically', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id], {
            solvers: [fixContractStatusSolver]
        });

        const { parsedOutput } = await ctx.runMigration(config);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should contain the error message
        assertFixedErrors(parsedOutput, contract.id, [
            { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
        ]);
    }),

    scenario('hide error from output if solver says so', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id], {
            solvers: [{ ...fixContractStatusSolver, hideError: true }]
        });

        const { parsedOutput } = await ctx.runMigration(config);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should not contain any errors
        expect(parsedOutput).toHaveProperty('errors');
        expect(parsedOutput.errors).not.toHaveProperty(contract.id);
    }),

    scenario('migrate record with error - fixed automatically, solver does not work', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id], {
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

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should contain the error message for both the failed solver and the manual fix
        assertFixedErrors(parsedOutput, contract.id, [
            { action: 'fix', changeFields: [{ field: 'ContractTerm', value: 11 }] },
            { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
        ]);
    }),

    scenario('migrate record with error - fixed manually', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should contain the error message
        assertFixedErrors(parsedOutput, contract.id, [
            { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
        ]);
    }),

    scenario('migrate record with error - fixed manually, invalid response to solution choice', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'blocked', 'f', '{"Status": "Draft"}']);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should contain the error message
        assertFixedErrors(parsedOutput, contract.id, [
            { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
        ]);
    }),

    scenario('migrate record with error - fixed manually, invalid JSON', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'f', '{"Status": Draft"}', 'asdasfd', '{"Status": "Draft"}']);

        const newContractId = assertRecordMigrated(parsedOutput, contract.id);

        // should be able to query the new contract record
        const newContract = await retrieveRecord(ctx.targetOrg, 'Contract', newContractId);
        expect(newContract.Status).toEqual('Activated');

        // output should contain the error message
        assertFixedErrors(parsedOutput, contract.id, [
            { action: 'fix', changeFields: [{ field: 'Status', value: 'Draft' }] }
        ]);
    }),

    scenario('migrate record with error - fixed automatically, remove field if new value is null', async (ctx: E2EContext) => {
        const { custObj, name } = await createFussyCustObjD(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [custObj.id], {
            solvers: [extractFussyColumnSolver(null)]
        });

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config);

        const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

        const newCustObj = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId);
        expect(newCustObj.Name).toEqual(name);

        const usingSolver = capturedOutput.find(e => e.type === 'using_solver');
        expect(usingSolver).toBeDefined();
        expect(usingSolver?.data?.solverMessage).toEqual(FUSSY_FIELD_ERROR);
        expect(usingSolver?.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be')).toBeTruthy();
        expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
    }),

    scenario('migrate record with error - fixed manually, remove field if new value is null', async (ctx: E2EContext) => {
        const { custObj, name } = await createFussyCustObjD(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [custObj.id]);

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config, ['y', 'f', '{"Fussy_Field_1__c": null}']);

        const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

        const newCustObj = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId);
        expect(newCustObj.Name).toEqual(name);

        expect(capturedOutput.find(e => e.type === 'insert_error' && e.data?.recordId === custObj.id && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
        expect(capturedOutput.find(e => e.type === 'updating_record')).toBeUndefined();
    }),

    scenario('migrate record with error - automatically extract column name to update', async (ctx: E2EContext) => {
        const { custObj, name } = await createFussyCustObjD(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [custObj.id], {
            solvers: [extractFussyColumnSolver(null)]
        });

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config);

        const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

        const newCustObj = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId);
        expect(newCustObj.Name).toEqual(name);

        expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(0);
    }),

    scenario('skip solver only if messages were the same', async (ctx: E2EContext) => {
        const { custObj, name } = await createFussyCustObjD(ctx.sourceOrg, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

        const config = createBasicConfig(ctx, [custObj.id], {
            solvers: [extractFussyColumnSolver('asdf')]
        });

        const { parsedOutput } = await ctx.runMigration(config);

        const newCustObjId = assertRecordMigrated(parsedOutput, custObj.id);

        const newCustObj = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId);
        expect(newCustObj.Name).toEqual(name);

        expect(parsedOutput).toHaveProperty('errors');
        expect(parsedOutput.errors).toHaveProperty(custObj.id);
        expect(parsedOutput.errors[custObj.id]).toHaveLength(2);
    }),

    scenario('migrate record with error - manually add new solver', async (ctx: E2EContext) => {
        const { custObj: custObj1, name: name1 } = await createFussyCustObjD(ctx.sourceOrg, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });
        const { custObj: custObj2, name: name2 } = await createFussyCustObjD(ctx.sourceOrg, { Fussy_Field_1__c: 'blocked', Fussy_Field_2__c: 'blocked' });

        const config = createBasicConfig(ctx, [custObj1.id, custObj2.id]);

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config, ['y', 'a', '{"action": "extract_column", "message": "Field \'(\\\\w+)\'  can\'t be", "replaceWith": "asdf"}']);

        const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id);
        const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id);

        const newCustObj1 = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId1);
        expect(newCustObj1.Name).toEqual(name1);
        expect(newCustObj1.Fussy_Field_1__c).toEqual('blocked');
        expect(newCustObj1.Fussy_Field_2__c).toEqual('blocked');

        const newCustObj2 = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId2);
        expect(newCustObj2.Name).toEqual(name2);
        expect(newCustObj2.Fussy_Field_1__c).toEqual('blocked');
        expect(newCustObj2.Fussy_Field_2__c).toEqual('blocked');

        expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'extract_column' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
    }),

    scenario('migrate record with error - manually add new solver, invalid solver', async (ctx: E2EContext) => {
        const { custObj: custObj1, name: name1 } = await createFussyCustObjD(ctx.sourceOrg);
        const { custObj: custObj2, name: name2 } = await createFussyCustObjD(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [custObj1.id, custObj2.id]);

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config, ['y', 'a', 'asdasd', '{zzz}', '{"action": "fix", "message": "((", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}', '{"action": "fix", "message": "Field \'Fussy_Field_1__c\'  can\'t be", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}']);

        const newCustObjId1 = assertRecordMigrated(parsedOutput, custObj1.id);
        const newCustObjId2 = assertRecordMigrated(parsedOutput, custObj2.id);

        const newCustObj1 = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId1);
        expect(newCustObj1.Name).toEqual(name1);

        const newCustObj2 = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjId2);
        expect(newCustObj2.Name).toEqual(name2);

        expect(capturedOutput.find(e => e.type === 'using_solver' && e.data?.solverAction === 'fix' && e.data?.error?.includes('Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
    }),

    scenario('migrate record with error - automatically skip record', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id], {
            solvers: [
                {
                    action: 'skip',
                    message: CONTRACT_STATUS_ERROR
                }
            ]
        });

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordSkipped(parsedOutput, contract.id);

        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // should be able to query the new account record
        const newAccount = await retrieveRecord(ctx.targetOrg, 'Account', newAccountId);
        expect(newAccount.Name).toEqual('Cloud Kicks');
    }),

    scenario('migrate record with error - manually skip record', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 's']);

        assertRecordSkipped(parsedOutput, contract.id);

        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // should be able to query the new account record
        const newAccount = await retrieveRecord(ctx.targetOrg, 'Account', newAccountId);
        expect(newAccount.Name).toEqual('Cloud Kicks');
    }),

    scenario('migrate record with error - automatically match duplicate record', async (ctx: E2EContext) => {
        const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const config = createBasicConfig(ctx, [sourceRecord.id], {
            solvers: [
                {
                    action: 'match',
                    message: 'duplicate value found: External_Id__c duplicates value on record with id: ([a-zA-Z0-9]{15,18})'
                }
            ]
        });

        const { parsedOutput } = await ctx.runMigration(config);

        const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id, targetRecord.id);

        // should be able to query the new custom object C record
        const newCustObjC = await retrieveRecord(ctx.targetOrg, 'Custom_Object_C__c', newCustObjCId);
        expect(newCustObjC.External_Id__c).toEqual(externalId);
    }),

    scenario('migrate record with error - manually match duplicate record', async (ctx: E2EContext) => {
        const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const config = createBasicConfig(ctx, [sourceRecord.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'm', targetRecord.id]);

        const newCustObjCId = assertRecordMappedTo(parsedOutput, sourceRecord.id, targetRecord.id);

        // should be able to query the new custom object C record
        const newCustObjC = await retrieveRecord(ctx.targetOrg, 'Custom_Object_C__c', newCustObjCId);
        expect(newCustObjC.External_Id__c).toEqual(externalId);
    }),

    scenario('migrate record with error - manually retry insert', async (ctx: E2EContext) => {
        const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const config = createBasicConfig(ctx, [sourceRecord.id]);

        const { parsedOutput } = await ctx.runMigration(config, async (ioEvent, sendInput) => {
            if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
                sendInput('y');
            } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
                expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
                // delete record from Org B
                await ctx.targetOrg.delete('Custom_Object_C__c', targetRecord.id);
                // retry insert
                sendInput('r');
            }
        });

        const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id);

        // should be able to query the new custom object C record
        const newCustObjC = await retrieveRecord(ctx.targetOrg, 'Custom_Object_C__c', newCustObjCId);
        expect(newCustObjC.External_Id__c).toEqual(externalId);

        expect(parsedOutput.errors).toHaveProperty(sourceRecord.id);
        expect(parsedOutput.errors[sourceRecord.id]).toHaveLength(1);
        expect(parsedOutput.errors[sourceRecord.id][0].fixed).toBeTruthy();
    }),

    scenario('manually retry all records', async (ctx: E2EContext) => {
        const count = 5;
        const records1 = [];
        for (let i = 0; i < count; i++) {
            const externalId = `ext-${Math.random()}`;
            const record = await createRecord(ctx.sourceOrg, 'Custom_Object_C__c', { External_Id__c: externalId });
            records1.push({
                id: record.id,
                externalId
            });
        }
        const records2: any[] = [];
        for (const record of records1) {
            const record2 = await createRecord(ctx.targetOrg, 'Custom_Object_C__c', { External_Id__c: record.externalId });
            records2.push({
                id: record2.id,
                externalId: record.externalId
            });
        }

        const config = createBasicConfig(ctx, records1.map(r => r.id));

        let retryCount = 0;
        const { parsedOutput } = await ctx.runMigration(config, async (ioEvent, sendInput) => {
            if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
                sendInput('y');
            } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
                retryCount++;
                expect(retryCount).toBe(1);
                expect(ioEvent.data.error).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
                // delete records from Org B
                for (const record of records2) {
                    await ctx.targetOrg.delete('Custom_Object_C__c', record.id);
                }
                // retry insert for all records
                sendInput('ra');
            }
        });
        expect(retryCount).toBe(1);

        for (const record of records1) {
            assertRecordMigrated(parsedOutput, record.id);
        }
    }),

    scenario('migrate record with error - quit and save results so far', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y', 'h']);

        // check if Account was migrated
        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // run migration again, for Account
        config.recordIds = [account.id];
        const { parsedOutput: parsedOutput2 } = await ctx.runMigration(config, ['y']);

        // Account should not be migrated again
        assertRecordMappedTo(parsedOutput2, account.id, newAccountId);
    }),

    scenario('match not found, create new record', async (ctx: E2EContext) => {
        const account1Name = `Cloud Kicks ${Math.random()}`;
        const account2Name = `ACME ${Math.random()}`;

        const account1 = await createAccount(ctx.sourceOrg, account1Name);
        const account2 = await createAccount(ctx.sourceOrg, account2Name);
        const account1B = await createAccount(ctx.targetOrg, account1Name);

        const config = createBasicConfig(ctx, [account1.id, account2.id], {
            matchers: [...defaultMatchers, {
                sObjectType: 'Account',
                fieldMappings: [
                    { sourceField: 'Name', targetField: 'Name' }
                ],
                whenMissing: 'create'
            }]
        });

        const { parsedOutput } = await ctx.runMigration(config, confirmMigration((recordCounts) => {
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
        const newAccount2 = await retrieveRecord(ctx.targetOrg, 'Account', newAccount2Id);
        expect(newAccount2.Name).toEqual(account2Name);
    }),

    scenario('match not found, skip record', async (ctx: E2EContext) => {
        const account1Name = `Cloud Kicks ${Math.random()}`;
        const account2Name = `ACME ${Math.random()}`;

        const account1 = await createAccount(ctx.sourceOrg, account1Name);
        const account2 = await createAccount(ctx.sourceOrg, account2Name);
        const account1B = await createAccount(ctx.targetOrg, account1Name);

        const config = createBasicConfig(ctx, [account1.id, account2.id], {
            matchers: [...defaultMatchers, {
                sObjectType: 'Account',
                fieldMappings: [
                    { sourceField: 'Name', targetField: 'Name' }
                ],
                whenMissing: 'skip'
            }]
        });

        const { parsedOutput } = await ctx.runMigration(config, confirmMigration((recordCounts) => {
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
        const newAccount2 = await ctx.targetOrg.findIds('Account', { Name: account2Name });
        expect(newAccount2.length).toBe(0);
    }),

    scenario('use history for both primary and secondary records', async (ctx: E2EContext) => {
        const account1Name = `Cloud Kicks ${Math.random()}`;
        const contactName = `John Doe ${Math.random()}`;

        const account = await createAccount(ctx.sourceOrg, account1Name);
        const contact = await createRecord(ctx.sourceOrg, 'Contact', { AccountId: account.id, LastName: contactName });

        const config = createBasicConfig(ctx, [contact.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        const newContactId = assertRecordMigrated(parsedOutput, contact.id);

        // should be able to query the new contact record
        const newContact = await retrieveRecord(ctx.targetOrg, 'Contact', newContactId);
        expect(newContact.LastName).toEqual(contactName);

        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // should be able to query the new account record
        const newAccount = await retrieveRecord(ctx.targetOrg, 'Account', newAccountId);
        expect(newAccount.Name).toEqual(account1Name);

        // run migration again with new contact
        const contact2 = await createRecord(ctx.sourceOrg, 'Contact', { AccountId: account.id, LastName: contactName });

        config.recordIds = [contact2.id];

        const { parsedOutput: parsedOutput2 } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput2, contact2.id);

        assertRecordMappedTo(parsedOutput2, account.id, newAccountId);
    }),

    scenario('fix column automatically with modifying current value', async (ctx: E2EContext) => {
        const { externalId, sourceRecord, targetRecord } = await createDuplicateCustObjCs(ctx.sourceOrg, ctx.targetOrg);

        const config = createBasicConfig(ctx, [sourceRecord.id], {
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

        const { parsedOutput } = await ctx.runMigration(config);

        const newCustObjCId = assertRecordMigrated(parsedOutput, sourceRecord.id);

        // should be able to query the new record
        const newCustObjC = await retrieveRecord(ctx.targetOrg, 'Custom_Object_C__c', newCustObjCId);
        expect(newCustObjC.External_Id__c).not.toEqual(externalId);
        expect(newCustObjC.External_Id__c).toMatch(new RegExp(`^${externalId}\\.[a-z0-9]{4}$`));

        // error should be logged
        expect(parsedOutput).toHaveProperty('errors');
        expect(parsedOutput.errors).toHaveProperty(sourceRecord.id);
        expect(parsedOutput.errors[sourceRecord.id]).toHaveLength(1);
        expect(parsedOutput.errors[sourceRecord.id][0].message).toEqual(`duplicate value found: External_Id__c duplicates value on record with id: ${targetRecord.id}`);
    }),

    scenario('more than 10 chunks', async (ctx: E2EContext) => {
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
            const record = await createRecord(ctx.sourceOrg, sObjectType, fields);
            recordIds.push(record.id);
        }

        const config = createBasicConfig(ctx, recordIds);

        const { parsedOutput } = await ctx.runMigration(config);

        for (const recordId of recordIds) {
            assertRecordMigrated(parsedOutput, recordId);
        }
    }),

    scenario('failed later update', async (ctx: E2EContext) => {
        const custObjD = await createRecord(ctx.sourceOrg, 'Custom_Object_D__c', { Fussy_Field_1__c: 'fail' });

        const config = createBasicConfig(ctx, [custObjD.id], {
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

        const { parsedOutput } = await ctx.runMigration(config);

        const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id);

        // should be able to query the new record
        const newCustObjD = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newCustObjDId);
        expect(newCustObjD.Fussy_Field_1__c).toEqual('ok');
    }),

    scenario('match by wrong field', async (ctx: E2EContext) => {
        const accountName = `Cloud Kicks ${Math.random()}`;
        const account1 = await createAccount(ctx.sourceOrg, accountName);
        await createAccount(ctx.targetOrg, accountName);

        const config = createBasicConfig(ctx, [account1.id], {
            matchers: [...defaultMatchers, {
                sObjectType: 'Account',
                fieldMappings: [
                    { sourceField: 'Ugabuga', targetField: 'Ugabuga' }
                ]
            }]
        });

        // the migration fails before touching any record
        await expect(ctx.runMigration(config)).rejects.toThrow();
    }),

    scenario('find ids inside text', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');
        const custObjD = await createRecord(ctx.sourceOrg, 'Custom_Object_D__c', {});

        const case1 = await createRecord(ctx.sourceOrg, 'Case', {
            Description: `Here's an Id for you: ${account.id} and here's another one: ${custObjD.id}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`
        });

        const config = createBasicConfig(ctx, [case1.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);
        const newAccountId = assertRecordMigrated(parsedOutput, account.id);
        const newCustObjDId = assertRecordMigrated(parsedOutput, custObjD.id);

        const newCase1 = await retrieveRecord(ctx.targetOrg, 'Case', newCase1Id);
        expect(newCase1.Description).toBe(`Here's an Id for you: ${newAccountId} and here's another one: ${newCustObjDId}, what are you gonna do? Also: interinstitutional counterculturalism psychoanalytically constitutionalizes neuropsychological overclassification, counterquestioning lumpenproletariats.`);
    }),

    scenario('invalid record id in field', async (ctx: E2EContext) => {
        const case1 = await createRecord(ctx.sourceOrg, 'Case', {
            Description: `This record does not exist: 001J6000002UKyHIAW`
        });

        const config = createBasicConfig(ctx, [case1.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);

        const newCase1 = await retrieveRecord(ctx.targetOrg, 'Case', newCase1Id);
        expect(newCase1.Description).toBe(`This record does not exist: 001J6000002UKyHIAW`);
    }),

    scenario('record references self', async (ctx: E2EContext) => {
        const case1 = await createRecord(ctx.sourceOrg, 'Case', {});

        await ctx.sourceOrg.update('Case', {
            Id: case1.id,
            Description: `This is my id: ${case1.id}`
        });

        const config = createBasicConfig(ctx, [case1.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, case1.id);
    }),

    scenario('circular relationship in text fields', async (ctx: E2EContext) => {
        const caseA = await createRecord(ctx.sourceOrg, 'Case', {});

        const caseB = await createRecord(ctx.sourceOrg, 'Case', {
            Description: `I like ${caseA.id}`
        });

        const caseC = await createRecord(ctx.sourceOrg, 'Case', {
            Description: `And I like ${caseB.id}`
        });

        await ctx.sourceOrg.update('Case', {
            Id: caseA.id,
            Description: `But I like ${caseC.id} better`
        });

        const config = createBasicConfig(ctx, [caseA.id, caseB.id, caseC.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        const newCaseAId = assertRecordMigrated(parsedOutput, caseA.id);
        const newCaseBId = assertRecordMigrated(parsedOutput, caseB.id);
        const newCaseCId = assertRecordMigrated(parsedOutput, caseC.id);

        const newCaseA = await retrieveRecord(ctx.targetOrg, 'Case', newCaseAId);
        expect(newCaseA.Description).toBe(`But I like ${newCaseCId} better`);

        const newCaseB = await retrieveRecord(ctx.targetOrg, 'Case', newCaseBId);
        expect(newCaseB.Description).toBe(`I like ${newCaseAId}`);

        const newCaseC = await retrieveRecord(ctx.targetOrg, 'Case', newCaseCId);
        expect(newCaseC.Description).toBe(`And I like ${newCaseBId}`);
    }),

    scenario('non-queryable and non-creatable object', async (ctx: E2EContext) => {
        const contentVersion = await createRecord(ctx.sourceOrg, 'ContentVersion', {
            Title: 'Test Document', // Required field
            PathOnClient: 'test.txt', // Required field
            VersionData: 'Hello World'
        });

        const config = createBasicConfig(ctx, [contentVersion.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, contentVersion.id);
    }),

    scenario('write output to log file', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = createBasicConfig(ctx, [account.id]);

        const { parsedOutput } = await ctx.runMigration(config, ['y'], 'test-output.log');

        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        expect(hasSavedRecord(readLogEvents('test-output.log'), newAccountId)).toBe(true);

        // run another migration to check that the log file is overwritten
        const account2 = await createAccount(ctx.sourceOrg, 'Cloud Kicks 2');

        const config2 = createBasicConfig(ctx, [account2.id]);

        const { parsedOutput: parsedOutput2 } = await ctx.runMigration(config2, ['y'], 'test-output.log');
        const newAccountId2 = assertRecordMigrated(parsedOutput2, account2.id);

        const logEvents2 = readLogEvents('test-output.log');
        expect(hasSavedRecord(logEvents2, newAccountId2)).toBe(true);
        expect(hasSavedRecord(logEvents2, newAccountId)).toBe(false);
    }),

    scenario('malformed id', async (ctx: E2EContext) => {
        const case1 = await createRecord(ctx.sourceOrg, 'Case', {
            Description: 'Bad Id: 574300075a6OKB0000'
        });

        const config = createBasicConfig(ctx, [case1.id]);

        const { parsedOutput } = await ctx.runMigration(config);
        const newCase1Id = assertRecordMigrated(parsedOutput, case1.id);

        const newCase1 = await retrieveRecord(ctx.targetOrg, 'Case', newCase1Id);
        expect(newCase1.Description).toBe('Bad Id: 574300075a6OKB0000');
    }),

    scenario('limit level of depth for querying related records', async (ctx: E2EContext) => {
        const HIERARCHY_LEVEL = 4;

        const accounts: any[] = [];
        for (let i = 0; i < HIERARCHY_LEVEL; i++) {
            const account = await createRecord(ctx.sourceOrg, 'Account', { Name: `Account ${i}`, ParentId: accounts[i - 1]?.id });
            accounts.push(account);
        }

        const contact = await createRecord(ctx.sourceOrg, 'Contact', {
            FirstName: 'John',
            LastName: 'Doe',
            AccountId: accounts[0].id
        });

        const contact2 = await createRecord(ctx.sourceOrg, 'Contact', {
            FirstName: 'Jane',
            LastName: 'Doe',
            AccountId: accounts[1].id
        });

        const config = createBasicConfig(ctx, [accounts[HIERARCHY_LEVEL - 1].id], {
            relationships: {
                "Account": [
                    {
                        "name": "Contacts"
                    }
                ]
            },
            relatedRecordDepthLimit: HIERARCHY_LEVEL
        });

        const { parsedOutput } = await ctx.runMigration(config);

        for (let i = 0; i < HIERARCHY_LEVEL; i++) {
            assertRecordMigrated(parsedOutput, accounts[i].id);
        }

        // the contact hanging off the deepest account is past the depth limit
        assertRecordNotMigrated(parsedOutput, contact.id);

        assertRecordMigrated(parsedOutput, contact2.id);
    }),

    scenario('fetch related record for a record that is in history', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const config = createBasicConfig(ctx, [account.id]);

        const { parsedOutput } = await ctx.runMigration(config);

        assertRecordMigrated(parsedOutput, account.id);

        // create contact
        const contact = await createRecord(ctx.sourceOrg, 'Contact', {
            FirstName: 'John',
            LastName: 'Doe',
            AccountId: account.id
        });

        // run migration with added relationship for Account
        const config2 = createBasicConfig(ctx, [account.id], {
            relationships: {
                "Account": [
                    {
                        "name": "Contacts"
                    }
                ]
            }
        });

        const { parsedOutput: parsedOutput2 } = await ctx.runMigration(config2);

        assertRecordMigrated(parsedOutput2, account.id);

        assertRecordMigrated(parsedOutput2, contact.id);
    }),

    scenario('save history file even if app is closed unexpectedly', async (ctx: E2EContext) => {
        const accountName = `Unique Account ${Date.now()}`;
        const account = await createAccount(ctx.sourceOrg, accountName);
        const contract = await createActivatedContract(ctx.sourceOrg, account.id);

        const config = createBasicConfig(ctx, [contract.id]);

        await ctx.runMigration(config, function (event, sendInput, exit) {
            if (event.type === 'confirm_migration') {
                sendInput('y');
            } else if (event.type === 'insert_error') {
                // close app
                exit();
            }
        });

        const newAccount = await ctx.targetOrg.query(`SELECT Id, Name FROM Account WHERE Name = '${accountName}'`);
        expect(newAccount).toBeDefined();
        expect(newAccount.records.length).toBe(1);

        // run migration again
        const config2 = createBasicConfig(ctx, [contract.id], {
            solvers: [fixContractStatusSolver]
        });
        const { parsedOutput: parsedOutput2 } = await ctx.runMigration(config2);

        assertRecordMappedTo(parsedOutput2, account.id, newAccount.records[0].Id);
    }),

    scenario('migrate to file and from file', async (ctx: E2EContext) => {
        const custObjC = await createRecord(ctx.sourceOrg, 'Custom_Object_C__c', {});
        const custObjB = await createRecord(ctx.sourceOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
        const custObjA = await createRecord(ctx.sourceOrg, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

        const configToFile = {
            sourceOrg: ctx.sourceOrg.alias,
            targetFile: 'test-output.json',
            recordIds: [custObjA.id],
            matchers: defaultMatchers
        };

        await ctx.runMigration(configToFile);

        const configFromFile = {
            sourceFile: 'test-output.json',
            targetOrg: ctx.targetOrg.alias,
            recordIds: [custObjA.id],
            matchers: defaultMatchers
        };

        const { parsedOutput } = await ctx.runMigration(configFromFile);

        const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
        const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
        const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

        const newCustObjB = await retrieveRecord(ctx.targetOrg, 'Custom_Object_B__c', newCustObjBId);
        expect(newCustObjB.Lookup_to_C__c).toBe(newCustObjCId);

        const newCustObjA = await retrieveRecord(ctx.targetOrg, 'Custom_Object_A__c', newCustObjAId);
        expect(newCustObjA.Lookup_to_B__c).toBe(newCustObjBId);
    }),

    scenario('migrate to SQLite database and from SQLite database', async (ctx: E2EContext) => {
        const custObjC = await createRecord(ctx.sourceOrg, 'Custom_Object_C__c', {});
        const custObjB = await createRecord(ctx.sourceOrg, 'Custom_Object_B__c', { Lookup_to_C__c: custObjC.id });
        const custObjA = await createRecord(ctx.sourceOrg, 'Custom_Object_A__c', { Lookup_to_B__c: custObjB.id });

        const configToSqlite = {
            sourceOrg: ctx.sourceOrg.alias,
            targetSqlite: 'test-output.db',
            recordIds: [custObjA.id],
            matchers: defaultMatchers
        };

        await ctx.runMigration(configToSqlite);

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
            targetOrg: ctx.targetOrg.alias,
            recordIds: [custObjA.id],
            matchers: defaultMatchers
        };

        const { parsedOutput } = await ctx.runMigration(configFromSqlite);

        const newCustObjAId = assertRecordMigrated(parsedOutput, custObjA.id);
        const newCustObjBId = assertRecordMigrated(parsedOutput, custObjB.id);
        const newCustObjCId = assertRecordMigrated(parsedOutput, custObjC.id);

        const newCustObjB = await retrieveRecord(ctx.targetOrg, 'Custom_Object_B__c', newCustObjBId);
        expect(newCustObjB.Lookup_to_C__c).toBe(newCustObjCId);

        const newCustObjA = await retrieveRecord(ctx.targetOrg, 'Custom_Object_A__c', newCustObjAId);
        expect(newCustObjA.Lookup_to_B__c).toBe(newCustObjBId);
    }),

    scenario('SQLite round trip preserves text, number, boolean and date fields', async (ctx: E2EContext) => {
        const accountName = `Sqlite Account ${Date.now()}`;
        const account = await createRecord(ctx.sourceOrg, 'Account', {
            Name: accountName,
            NumberOfEmployees: 42,
            Description: 'Exported through SQLite'
        });
        const task = await createRecord(ctx.sourceOrg, 'Task', {
            Subject: 'Sqlite Roundtrip',
            WhatId: account.id,
            ActivityDate: '2030-04-01',
            CallDurationInSeconds: 90,
            IsReminderSet: true,
            ReminderDateTime: '2030-04-01T09:00:00.000+0000',
            IsRecurrence: false
        });

        await ctx.runMigration({
            sourceOrg: ctx.sourceOrg.alias,
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

        const { parsedOutput } = await ctx.runMigration({
            sourceSqlite: 'test-output.db',
            targetOrg: ctx.targetOrg.alias,
            recordIds: [task.id],
            matchers: defaultMatchers
        });

        // and that the target org got the original types back, not stringified ones
        const newAccountId = assertRecordMigrated(parsedOutput, account.id);
        const newAccount = await retrieveRecord(ctx.targetOrg, 'Account', newAccountId);
        expect(newAccount.Name).toBe(accountName);
        expect(newAccount.NumberOfEmployees).toBe(42);
        expect(newAccount.Description).toBe('Exported through SQLite');

        const newTask = await retrieveRecord(ctx.targetOrg, 'Task', assertRecordMigrated(parsedOutput, task.id));
        expect(newTask.Subject).toBe('Sqlite Roundtrip');
        expect(newTask.WhatId).toBe(newAccountId);
        expect(newTask.ActivityDate).toBe('2030-04-01');
        expect(newTask.CallDurationInSeconds).toBe(90);
        expect(newTask.IsReminderSet).toBe(true);
        expect(newTask.IsRecurrence).toBe(false);
    }),

    scenario('full auto mode - save and exit', async (ctx: E2EContext) => {
        const { account, contract, contract2 } = await createFullAutoTestRecords(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [contract.id, contract2.id], {
            fullAuto: {
                enabled: true,
                unhandledErrorBehavior: 'saveAndExit'
            }
        });

        const { parsedOutput } = await ctx.runMigration(config, []); // no input needed for full auto mode

        assertRecordMigrated(parsedOutput, account.id);

        expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract.id);
        expect(parsedOutput.allMigratedRecords).not.toHaveProperty(contract2.id);
    }),

    scenario('full auto mode - skip', async (ctx: E2EContext) => {
        const { account, contract, contract2 } = await createFullAutoTestRecords(ctx.sourceOrg);

        const config = createBasicConfig(ctx, [contract.id, contract2.id], {
            fullAuto: {
                enabled: true,
                unhandledErrorBehavior: 'skip'
            }
        });

        const { parsedOutput } = await ctx.runMigration(config, []); // no input needed for full auto mode

        assertRecordMigrated(parsedOutput, account.id);

        assertRecordSkipped(parsedOutput, contract.id);
        assertRecordMigrated(parsedOutput, contract2.id);
    }),

    scenario('anonymize email fields', async (ctx: E2EContext) => {
        const uniqueEmail = `test+${Date.now()}@example.com`;
        const contact = await createRecord(ctx.sourceOrg, 'Contact', { FirstName: 'John', LastName: 'Doe', Email: uniqueEmail });

        const config = createBasicConfig(ctx, [contact.id], {
            anonymization: {
                emailFields: {
                    mode: 'obfuscate'
                }
            }
        });

        const { parsedOutput } = await ctx.runMigration(config);

        const newContactId = assertRecordMigrated(parsedOutput, contact.id);

        const newContact = await retrieveRecord(ctx.targetOrg, 'Contact', newContactId);
        expect(newContact.Email).not.toBe(uniqueEmail);
        expect(newContact.Email).toContain('@');
    }),

    scenario('report record reason counts', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Cloud Kicks');

        const contact = await createRecord(ctx.sourceOrg, 'Contact', {
            FirstName: 'John',
            LastName: 'Doe'
        });

        const contact2 = await createRecord(ctx.sourceOrg, 'Contact', {
            FirstName: 'Jane',
            LastName: 'Doe',
            AccountId: account.id,
            ReportsToId: contact.id
        });

        const caseRecord = await createRecord(ctx.sourceOrg, 'Case', {
            Subject: 'Test Case',
            ContactId: contact.id
        });

        const config = createBasicConfig(ctx, [account.id], {
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

        const { parsedOutput } = await ctx.runMigration(config, confirmMigration((recordCounts) => {
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
    }),

    scenario('custom history file path', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Custom History Test Account');

        const customHistoryPath = './custom_history_test.json';
        const config = createBasicConfig(ctx, [account.id], {
            historyFilePath: customHistoryPath
        });

        const { parsedOutput } = await ctx.runMigration(config);

        // Verify record was migrated
        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // Verify custom history file was created
        expect(fs.existsSync(customHistoryPath)).toBe(true);

        // Verify custom history file contains the mapping
        const historyContent = JSON.parse(fs.readFileSync(customHistoryPath, 'utf8'));
        expect(historyContent).toHaveProperty(account.id);
        expect(historyContent[account.id]).toBe(newAccountId);

        // Verify default history file was NOT created
        expect(fs.existsSync(`${ctx.targetOrg.alias}__history.json`)).toBe(false);
    }),

    scenario('custom history file path as directory', async (ctx: E2EContext) => {
        const account = await createAccount(ctx.sourceOrg, 'Custom History Test Account');

        const customHistoryPath = './custom_history_test_dir';
        fs.mkdirSync(customHistoryPath, { recursive: true });
        const config = createBasicConfig(ctx, [account.id], {
            historyFilePath: customHistoryPath
        });

        const { parsedOutput } = await ctx.runMigration(config);

        // Verify record was migrated
        const newAccountId = assertRecordMigrated(parsedOutput, account.id);

        // Verify custom history file was created
        expect(fs.existsSync(`${customHistoryPath}/${ctx.targetOrg.alias}__history.json`)).toBe(true);

        // Verify custom history file contains the mapping
        const historyContent = JSON.parse(fs.readFileSync(`${customHistoryPath}/${ctx.targetOrg.alias}__history.json`, 'utf8'));
        expect(historyContent).toHaveProperty(account.id);
        expect(historyContent[account.id]).toBe(newAccountId);

        // Verify default history file was NOT created
        expect(fs.existsSync(`${ctx.targetOrg.alias}__history.json`)).toBe(false);
    }),

    scenario('solver with additional info from error', async (ctx: E2EContext) => {
        const recordTypes = await ctx.sourceOrg.findIds('RecordType', {
            SobjectType: 'Custom_Object_E__c',
            DeveloperName: 'Enhanced'
        });
        expect(recordTypes.length).toBe(1);
        const custObjE = await createRecord(ctx.sourceOrg, 'Custom_Object_E__c', { RecordTypeId: recordTypes[0].Id, Some_picklist__c: 'Enhanced value' });

        const config = createBasicConfig(ctx, [custObjE.id], {
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

        const { parsedOutput } = await ctx.runMigration(config);

        const newCustObjEId = assertRecordMigrated(parsedOutput, custObjE.id);
        const newCustObjE = await retrieveRecord(ctx.targetOrg, 'Custom_Object_E__c', newCustObjEId);
        expect(newCustObjE.Some_picklist__c).toBe('Normal value');
    }),

    scenario('bulk update records', async (ctx: E2EContext) => {
        const recordsToCreate = [];
        for (let i = 0; i < 211; i++) {
            recordsToCreate.push({ Name: `ext-${Math.random()}` });
        }

        const allCreateResults = await ctx.sourceOrg.createAll('Custom_Object_D__c', recordsToCreate);
        expect(allCreateResults).toHaveLength(211);

        // Prepare updates for all created records
        const recordsToUpdate = [];
        const recordIds: string[] = [];
        for (const result of allCreateResults) {
            expect(result.id).toBeDefined();
            recordIds.push(result.id);
            recordsToUpdate.push({
                Id: result.id,
                Fussy_Field_1__c: 'blocked',
                Fussy_Field_2__c: 'blocked'
            });
        }

        await ctx.sourceOrg.updateAll('Custom_Object_D__c', recordsToUpdate);

        const config = createBasicConfig(ctx, recordIds, {
            solvers: [extractFussyColumnSolver('asdf', { hideError: true })]
        });

        const { parsedOutput, capturedOutput } = await ctx.runMigration(config);
        for (const recordId of recordIds) {
            const newRecordId = assertRecordMigrated(parsedOutput, recordId);
            // check if the record was updated
            const record = await retrieveRecord(ctx.targetOrg, 'Custom_Object_D__c', newRecordId);
            expect(record.Fussy_Field_1__c).toBe('blocked');
            expect(record.Fussy_Field_2__c).toBe('blocked');
        }
        expect(capturedOutput.filter(e => e.type === 'updating_record')).toHaveLength(2);
    })
];
