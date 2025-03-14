import { test, expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';
import { exec } from 'child_process';
import fs from 'fs';
import { IOEvent } from '../app';


const sourceOrgAlias = 'testMigrationOrgA';
const targetOrgAlias = 'testMigrationOrgB';

jest.setTimeout(120000);

afterEach(async () => {
    fs.unlinkSync('./config_test.json');
    if (fs.existsSync(`${targetOrgAlias}__history.json`)) {
        fs.unlinkSync(`${targetOrgAlias}__history.json`);
    }
});

async function setupTestConnections() {
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

    return { conn1, conn2 };
}

async function runMigration(config: any, inputHandler: ((event: IOEvent, sendInput: (input: string) => void) => void) | string[] = ['y']) {
    fs.writeFileSync('./config_test.json', JSON.stringify(config, null, 2));
    const capturedOutput: IOEvent[] = [];
    let capturedError = '';

    const child = exec(`npx ts-node ./main.ts --config-json ./config_test.json --debug`);
    child.stdout?.on('data', (data) => {
        console.log(data);
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim() === '') {
                continue;
            }
            const event = JSON.parse(line) as IOEvent;
            capturedOutput.push(event);
            if (event.category === 'input') {
                if (typeof inputHandler === 'function') {
                    inputHandler(event, (input: string) => {
                        console.log(`sending input: ${input}`);
                        child.stdin?.write(input);
                        child.stdin?.write('\n');
                    });
                } else {
                    const input = inputHandler.shift();
                    expect(input).toBeDefined();
                    if (!input) {
                        child.stdin?.end();
                        throw new Error('No input provided');
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

    expect(capturedError).toBe('');
    expect(capturedOutput.length).toBeGreaterThan(1);
    return { 
        parsedOutput: JSON.parse(capturedOutput[capturedOutput.length - 1].data!),
        capturedOutput
    };
}

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
    }
];

test('migrate record - single', async () => {
    console.log('starting test: migrate record - single');

    const { conn1 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [account.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);
});

test('migrate record - complex', async () => {
    console.log('starting test: migrate record');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contact = await conn1.sobject('Contact').create({ FirstName: 'Spider', LastName: 'Jerusalem', AccountId: account.id! });
    console.log(contact);
    expect(contact.id).toBeDefined();

    const campaignFields = { Name: `Aaa! ${Math.random()}`, IsActive: true };

    const campaignOrgA = await conn1.sobject('Campaign').create(campaignFields);
    console.log(campaignOrgA);
    expect(campaignOrgA.id).toBeDefined();

    const campaignOrgB = await conn2.sobject('Campaign').create(campaignFields);
    console.log(campaignOrgB);
    expect(campaignOrgB.id).toBeDefined();

    const opportunity = await conn1.sobject('Opportunity').create({ 
        Name: 'Blasto Bandage', 
        CampaignId: campaignOrgA.id!, 
        AccountId: account.id!, 
        StageName: 'Prospecting', 
        CloseDate: new Date().toISOString() 
    });
    console.log(opportunity);
    expect(opportunity.id).toBeDefined();

    const user = await conn1.sobject('User').select('Id').where(`Name = 'Integration User'`).execute();
    console.log(user);
    expect(user.length).toBeGreaterThan(0);
    expect(user[0].Id).toBeDefined();

    const custObjC = await conn1.sobject('Custom_Object_C__c').create({ OwnerId: user[0].Id! });
    console.log(custObjC);
    expect(custObjC.id).toBeDefined();

    const custObjB = await conn1.sobject('Custom_Object_B__c').create({ Lookup_to_C__c: custObjC.id! });
    console.log(custObjB);
    expect(custObjB.id).toBeDefined();

    const custObjA = await conn1.sobject('Custom_Object_A__c').create({ Lookup_to_B__c: custObjB.id! });
    console.log(custObjA);
    expect(custObjA.id).toBeDefined();

    // create circular dependency
    await conn1.sobject('Custom_Object_C__c').update({ Id: custObjC.id!, Lookup_to_A__c: custObjA.id! });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [opportunity.id!, custObjB.id!, custObjA.id!],
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
    };

    const { parsedOutput } = await runMigration(config, async (ioEvent, sendInput) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
            // event data should contain record counts by sobject type
            const recordCounts = JSON.parse(ioEvent.data!);
            expect(recordCounts).toHaveProperty('Account');
            expect(recordCounts).toHaveProperty('Contact');
            expect(recordCounts).toHaveProperty('Opportunity');
            expect(recordCounts).toHaveProperty('Custom_Object_A__c');
            expect(recordCounts).toHaveProperty('Custom_Object_B__c');
            expect(recordCounts).toHaveProperty('Custom_Object_C__c');
            expect(recordCounts.Account).toBe(1);
            expect(recordCounts.Contact).toBe(1);
            expect(recordCounts.Opportunity).toBe(1);
            expect(recordCounts['Custom_Object_A__c']).toBe(1);
            expect(recordCounts['Custom_Object_B__c']).toBe(1);
            expect(recordCounts['Custom_Object_C__c']).toBe(1);
        }
    });

    // Check if opportunity was migrated
    expect(parsedOutput).toHaveProperty(opportunity.id!);
    const newOpportunityId = parsedOutput[opportunity.id!];
    expect(newOpportunityId).toBeTruthy();
    expect(newOpportunityId).not.toEqual(opportunity.id);

    // Check if account was migrated
    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);

    // Check if contact was migrated
    expect(parsedOutput).toHaveProperty(contact.id!);
    const newContactId = parsedOutput[contact.id!];
    expect(newContactId).toBeTruthy();
    expect(newContactId).not.toEqual(contact.id);

    // should be able to query the new opportunity record
    const newOpportunity: any = await conn2.sobject('Opportunity').retrieve(newOpportunityId);
    expect(newOpportunity).toBeDefined();
    expect(newOpportunity.Name).toEqual('Blasto Bandage');
    expect(newOpportunity.CampaignId).toEqual(campaignOrgB.id);

    // should be able to query the new account record
    const newAccount: any = await conn2.sobject('Account').retrieve(newAccountId);
    expect(newAccount).toBeDefined();
    expect(newAccount.Name).toEqual('Ebola Cola');

    // should be able to query the new contact record
    const newContact: any = await conn2.sobject('Contact').retrieve(newContactId);
    expect(newContact).toBeDefined();
    expect(newContact.FirstName).toEqual('Spider');
    expect(newContact.LastName).toEqual('Jerusalem');

    // Check if the new opportunity is associated with the new account
    expect(newOpportunity.AccountId).toEqual(newAccountId);

    // Check if custom object A was migrated
    expect(parsedOutput).toHaveProperty(custObjA.id!);
    const newCustObjAId = parsedOutput[custObjA.id!];
    expect(newCustObjAId).toBeTruthy();
    expect(newCustObjAId).not.toEqual(custObjA.id);

    // Check if custom object B was migrated
    expect(parsedOutput).toHaveProperty(custObjB.id!);
    const newCustObjBId = parsedOutput[custObjB.id!];
    expect(newCustObjBId).toBeTruthy();
    expect(newCustObjBId).not.toEqual(custObjB.id);

    // Check if custom object C was migrated
    expect(parsedOutput).toHaveProperty(custObjC.id!);
    const newCustObjCId = parsedOutput[custObjC.id!];
    expect(newCustObjCId).toBeTruthy();
    expect(newCustObjCId).not.toEqual(custObjC.id);

    // should be able to query the new custom object C record
    const newCustObjC: any = (await conn2.sobject('Custom_Object_C__c').select('*, Owner.Name').where(`Id = '${newCustObjCId}'`).execute())[0];
    expect(newCustObjC).toBeDefined();
    expect(newCustObjC.Lookup_to_A__c).toEqual(newCustObjAId);
    expect(newCustObjC.Owner.Name).toEqual('Integration User');

    // should be able to query the new custom object A record
    const newCustObjA: any = await conn2.sobject('Custom_Object_A__c').retrieve(newCustObjAId);
    expect(newCustObjA).toBeDefined();
    expect(newCustObjA.Lookup_to_B__c).toEqual(newCustObjBId);

    // should be able to query the new custom object B record
    const newCustObjB: any = await conn2.sobject('Custom_Object_B__c').retrieve(newCustObjBId);
    expect(newCustObjB).toBeDefined();
    expect(newCustObjB.Lookup_to_C__c).toEqual(newCustObjCId);

    // given
    const contact2 = await conn1.sobject('Contact').create({ FirstName: 'Ocean', LastName: 'Man', AccountId: account.id! });
    expect(contact2.id).toBeDefined();
    
    config.recordIds = [contact2.id!, custObjA.id!];

    const { parsedOutput: parsedOutput2, capturedOutput } = await runMigration(config);
    expect(capturedOutput).not.toContain('updating'); // should only create new record

    expect(parsedOutput2).toHaveProperty(contact2.id!);
    const newContactId2 = parsedOutput2[contact2.id!];
    expect(newContactId2).toBeTruthy();
    expect(newContactId2).not.toEqual(contact2.id);

    // should be able to query the new contact record
    const newContact2: any = await conn2.sobject('Contact').retrieve(newContactId2);
    expect(newContact2).toBeDefined();
    expect(newContact2.FirstName).toEqual('Ocean');
    expect(newContact2.LastName).toEqual('Man');
    expect(newContact2.AccountId).toEqual(newAccountId);
});

test('match record by id field', async () => {
    console.log('starting test: match record by id field');

    const { conn1, conn2 } = await setupTestConnections();

    const externalId = `ext-${Math.random()}`;
    const custObjC = await conn1.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjC);
    expect(custObjC.id).toBeDefined();

    const custObjC2 = await conn2.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjC2);
    expect(custObjC2.id).toBeDefined();

    const custObjB = await conn1.sobject('Custom_Object_B__c').create({ Lookup_to_C__c: custObjC.id! });
    console.log(custObjB);
    expect(custObjB.id).toBeDefined();
    
    const custObjB2 = await conn2.sobject('Custom_Object_B__c').create({ Lookup_to_C__c: custObjC2.id! });
    console.log(custObjB2);
    expect(custObjB2.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObjB.id!],
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
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(custObjB.id!);
    const newCustObjBId = parsedOutput[custObjB.id!];
    expect(newCustObjBId).toBeTruthy();
    expect(newCustObjBId).toEqual(custObjB2.id);
});

test('record is skipped, any field updates are cancelled', async () => {
    console.log('starting test: record is skipped, any field updates are cancelled');

    const { conn1, conn2 } = await setupTestConnections();

    const externalId = `ext-${Math.random()}`;
    const custObjC = await conn1.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjC);
    expect(custObjC.id).toBeDefined();

    const custObjC2 = await conn2.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjC2);
    expect(custObjC2.id).toBeDefined();

    const custObjB = await conn1.sobject('Custom_Object_B__c').create({ Lookup_to_C__c: custObjC.id! });
    console.log(custObjB);
    expect(custObjB.id).toBeDefined();
    
    const custObjA = await conn1.sobject('Custom_Object_A__c').create({ Lookup_to_B__c: custObjB.id! });
    console.log(custObjA);
    expect(custObjA.id).toBeDefined();

    await conn1.sobject('Custom_Object_C__c').update({ Id: custObjC.id!, Lookup_to_A__c: custObjA.id! });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObjB.id!],
        matchers: defaultMatchers
    };

    await runMigration(config, ['y', 's', 's', 's']);

    // does not throw error
});

test('migrate record with error - fixed automatically', async () => {
    console.log('starting test: migrate record with error - fixed automatically');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'fix',
                message: 'Choose a valid contract status and save your changes. Ask your admin for details.',
                changeFields: [
                    {
                        field: 'Status',
                        value: 'Draft'
                    }
                ]
            }
        ]
    };

    const { parsedOutput } = await runMigration(config);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(contract.id!);
    expect(parsedOutput.errors[contract.id!]).toHaveLength(1);
    expect(parsedOutput.errors[contract.id!][0].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][0].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][0].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][0].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][0].solver.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
});

test('migrate record with error - fixed automatically, solver does not work', async () => {
    console.log('starting test: migrate record with error - fixed automatically, solver does not work');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'fix',
                message: 'Choose a valid contract status and save your changes. Ask your admin for details.',
                changeFields: [
                    {
                        field: 'ContractTerm',
                        value: 11
                    }
                ]
            }
        ]
    };

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(contract.id!);
    expect(parsedOutput.errors[contract.id!]).toHaveLength(2);
    expect(parsedOutput.errors[contract.id!][0].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][0].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][0].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][0].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][0].solver.changeFields).toEqual([{ field: 'ContractTerm', value: 11 }]);
    expect(parsedOutput.errors[contract.id!][1].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][1].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][1].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][1].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][1].solver.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
});

test('migrate record with error - fixed manually', async () => {
    console.log('starting test: migrate record with error fixed manually');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": "Draft"}']);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(contract.id!);
    expect(parsedOutput.errors[contract.id!]).toHaveLength(1);
    expect(parsedOutput.errors[contract.id!][0].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][0].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][0].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][0].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][0].solver.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
});

test('migrate record with error - fixed manually, invalid response to solution choice', async () => {
    console.log('starting test: migrate record with error fixed manually, invalid response to solution choice');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 'dupa', 'f', '{"Status": "Draft"}']);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(contract.id!);
    expect(parsedOutput.errors[contract.id!]).toHaveLength(1);
    expect(parsedOutput.errors[contract.id!][0].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][0].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][0].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][0].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][0].solver.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
});

test('migrate record with error - fixed manually, invalid JSON', async () => {
    console.log('starting test: migrate record with error fixed manually, invalid JSON');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 'f', '{"Status": Draft"}', 'asdasfd', '{"Status": "Draft"}']);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');

    // output should contain the error message
    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(contract.id!);
    expect(parsedOutput.errors[contract.id!]).toHaveLength(1);
    expect(parsedOutput.errors[contract.id!][0].message).toEqual('Choose a valid contract status and save your changes. Ask your admin for details.');
    expect(parsedOutput.errors[contract.id!][0].fixed).toBeTruthy();
    expect(parsedOutput.errors[contract.id!][0].solver).toBeDefined();
    expect(parsedOutput.errors[contract.id!][0].solver.action).toEqual('fix');
    expect(parsedOutput.errors[contract.id!][0].solver.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
});

test('migrate record with error - fixed automatically, remove field if new value is null', async () => {
    console.log('starting test: migrate record with error - fixed automatically, remove field if new value is null');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const name = `ext-${Math.random()}`;
    const custObj = await conn1.sobject('Custom_Object_D__c').create({ Name: name });
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj.id!, Fussy_Field_1__c: 'dupa' });
    console.log(custObj);
    expect(custObj.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'extract_column',
                message: 'Field \'(\\w+)\'  can\'t be',
                replaceWith: null
            }
        ]
    };

    const { parsedOutput, capturedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(custObj.id!);
    const newCustObjId = parsedOutput[custObj.id!];
    expect(newCustObjId).toBeTruthy();
    expect(newCustObjId).not.toEqual(custObj.id);

    const newCustObj: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId);
    expect(newCustObj).toBeDefined();
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.find(e => e.message.includes('extracting column name from error: Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
    expect(capturedOutput.map(e => e.message).filter(e => e.includes('updating record'))).toHaveLength(0);
});

test('migrate record with error - fixed manually, remove field if new value is null', async () => {
    console.log('starting test: migrate record with error - fixed manually, remove field if new value is null');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const name = `ext-${Math.random()}`;
    const custObj = await conn1.sobject('Custom_Object_D__c').create({ Name: name });
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj.id!, Fussy_Field_1__c: 'dupa' });
    console.log(custObj);
    expect(custObj.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'f', '{"Fussy_Field_1__c": null}']);

    expect(parsedOutput).toHaveProperty(custObj.id!);
    const newCustObjId = parsedOutput[custObj.id!];
    expect(newCustObjId).toBeTruthy();
    expect(newCustObjId).not.toEqual(custObj.id);

    const newCustObj: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId);
    expect(newCustObj).toBeDefined();
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.find(e => e.message.includes('recordId: ' + custObj.id + ', no solver found for error: Field \'Fussy_Field_1__c\'  can\'t be'))).toBeDefined();
    expect(capturedOutput.map(e => e.message).filter(e => e.includes('updating record'))).toHaveLength(0);
});

test('migrate record with error - automatically extract column name to update', async () => {
    console.log('starting test: migrate record with error - automatically extract column name to update');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const name = `ext-${Math.random()}`;
    const custObj = await conn1.sobject('Custom_Object_D__c').create({ Name: name });
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj.id!, Fussy_Field_1__c: 'dupa' });
    console.log(custObj);
    expect(custObj.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'extract_column',
                message: 'Field \'(\\w+)\'  can\'t be',
                replaceWith: null
            }
        ]
    };

    const { parsedOutput, capturedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(custObj.id!);
    const newCustObjId = parsedOutput[custObj.id!];
    expect(newCustObjId).toBeTruthy();
    expect(newCustObjId).not.toEqual(custObj.id);

    const newCustObj: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId);
    expect(newCustObj).toBeDefined();
    expect(newCustObj.Name).toEqual(name);

    expect(capturedOutput.map(e => e.message).filter(e => e.includes('updating record'))).toHaveLength(0);
});

test('skip solver only if messages were the same', async () => {
    console.log('starting test: skip solver only if messages were the same');

    const { conn1, conn2 } = await setupTestConnections();


    console.log('creating records');
    const name = `ext-${Math.random()}`;
    const custObj = await conn1.sobject('Custom_Object_D__c').create({ Name: name });
    console.log(custObj);
    expect(custObj.id).toBeDefined();

    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj.id!, Fussy_Field_1__c: 'dupa', Fussy_Field_2__c: 'dupa' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'extract_column',
                message: 'Field \'(\\w+)\'  can\'t be',
                replaceWith: "asdf"
            }
        ]
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(custObj.id!);
    const newCustObjId = parsedOutput[custObj.id!];
    expect(newCustObjId).toBeTruthy();
    expect(newCustObjId).not.toEqual(custObj.id);

    const newCustObj: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId);
    expect(newCustObj).toBeDefined();
    expect(newCustObj.Name).toEqual(name);

    expect(parsedOutput).toHaveProperty('errors');
    expect(parsedOutput.errors).toHaveProperty(custObj.id!);
    expect(parsedOutput.errors[custObj.id!]).toHaveLength(2);
});

test('migrate record with error - manually add new solver', async () => {
    console.log('starting test: migrate record with error - manually add new solver');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const name1 = `ext-${Math.random()}`;
    const custObj1 = await conn1.sobject('Custom_Object_D__c').create({ Name: name1 });
    console.log(custObj1);
    expect(custObj1.id).toBeDefined();
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj1.id!, Fussy_Field_1__c: 'dupa', Fussy_Field_2__c: 'dupa' });

    const name2 = `ext-${Math.random()}`;
    const custObj2 = await conn1.sobject('Custom_Object_D__c').create({ Name: name2 });
    console.log(custObj2);
    expect(custObj2.id).toBeDefined();
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj2.id!, Fussy_Field_1__c: 'dupa', Fussy_Field_2__c: 'dupa' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj1.id!, custObj2.id!],
        matchers: defaultMatchers
    };

    // manually add new solver:
    /*
            {
                action: 'extract_column',
                message: 'Field \'(\\w+)\'  can\'t be',
                replaceWith: "asdf"
            }
    */
    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', '{"action": "extract_column", "message": "Field \'(\\\\w+)\'  can\'t be", "replaceWith": "asdf"}']);

    expect(parsedOutput).toHaveProperty(custObj1.id!);
    const newCustObjId1 = parsedOutput[custObj1.id!];
    expect(newCustObjId1).toBeTruthy();
    expect(newCustObjId1).not.toEqual(custObj1.id);

    expect(parsedOutput).toHaveProperty(custObj2.id!);
    const newCustObjId2 = parsedOutput[custObj2.id!];
    expect(newCustObjId2).toBeTruthy();
    expect(newCustObjId2).not.toEqual(custObj2.id);

    const newCustObj1: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId1);
    expect(newCustObj1).toBeDefined();
    expect(newCustObj1.Name).toEqual(name1);
    expect(newCustObj1.Fussy_Field_1__c).toEqual('dupa');
    expect(newCustObj1.Fussy_Field_2__c).toEqual('dupa');

    const newCustObj2: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId2);
    expect(newCustObj2).toBeDefined();
    expect(newCustObj2.Name).toEqual(name2);
    expect(newCustObj2.Fussy_Field_1__c).toEqual('dupa');
    expect(newCustObj2.Fussy_Field_2__c).toEqual('dupa');


    expect(capturedOutput.map(e => e.message)).toContain('extracting column name from error: Field \'Fussy_Field_1__c\'  can\'t be');
});

test('migrate record with error - manually add new solver, invalid solver', async () => {
    console.log('starting test: migrate record with error - manually add new solver, invalid JSON');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const name1 = `ext-${Math.random()}`;
    const custObj1 = await conn1.sobject('Custom_Object_D__c').create({ Name: name1 });
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj1.id!, Fussy_Field_1__c: 'dupa' });
    console.log(custObj1);
    expect(custObj1.id).toBeDefined();

    const name2 = `ext-${Math.random()}`;
    const custObj2 = await conn1.sobject('Custom_Object_D__c').create({ Name: name2 });
    await conn1.sobject('Custom_Object_D__c').update({ Id: custObj2.id!, Fussy_Field_1__c: 'dupa' });
    console.log(custObj2);
    expect(custObj2.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObj1.id!, custObj2.id!],
        matchers: defaultMatchers
    };


    const { parsedOutput, capturedOutput } = await runMigration(config, ['y', 'a', 'asdasd', '{zzz}', '{"action": "fix", "message": "((", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}', '{"action": "fix", "message": "Field \'Fussy_Field_1__c\'  can\'t be", "changeFields": [{"field": "Fussy_Field_1__c", "value": null}]}']);

    expect(parsedOutput).toHaveProperty(custObj1.id!);
    const newCustObjId1 = parsedOutput[custObj1.id!];
    expect(newCustObjId1).toBeTruthy();
    expect(newCustObjId1).not.toEqual(custObj1.id);

    expect(parsedOutput).toHaveProperty(custObj2.id!);
    const newCustObjId2 = parsedOutput[custObj2.id!];
    expect(newCustObjId2).toBeTruthy();
    expect(newCustObjId2).not.toEqual(custObj2.id);

    const newCustObj1: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId1);
    expect(newCustObj1).toBeDefined();
    expect(newCustObj1.Name).toEqual(name1);

    const newCustObj2: any = await conn2.sobject('Custom_Object_D__c').retrieve(newCustObjId2);
    expect(newCustObj2).toBeDefined();
    expect(newCustObj2.Name).toEqual(name2);

    expect(capturedOutput.map(e => e.message)).toContain('fixing using solver: Field \'Fussy_Field_1__c\'  can\'t be');
});

test('migrate record with error - automatically skip record', async () => {
    console.log('starting test: migrate record with error - automatically skip record');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'skip',
                message: 'Choose a valid contract status and save your changes. Ask your admin for details.'
            }
        ]
    };

    const { parsedOutput } = await runMigration(config);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBe('');

    // Check if account was migrated
    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);

    // should be able to query the new account record
    const newAccount: any = await conn2.sobject('Account').retrieve(newAccountId);
    expect(newAccount).toBeDefined();
    expect(newAccount.Name).toEqual('Ebola Cola');
});

test('migrate record with error - manually skip record', async () => {
    console.log('starting test: migrate record with error - manually skip record');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 's']);

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBe('');

    // Check if account was migrated
    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);

    // should be able to query the new account record
    const newAccount: any = await conn2.sobject('Account').retrieve(newAccountId);
    expect(newAccount).toBeDefined();
    expect(newAccount.Name).toEqual('Ebola Cola');
});

test('migrate record with error - automatically match duplicate record', async () => {
    console.log('starting test: migrate record with error - automatically match duplicate record');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const externalId = `ext-${Math.random()}`;
    const custObjCorgA = await conn1.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgA);
    expect(custObjCorgA.id).toBeDefined();

    const custObjCorgB = await conn2.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgB);
    expect(custObjCorgB.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObjCorgA.id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'match',
                message: 'duplicate value found: External_Id__c duplicates value on record with id: ([a-zA-Z0-9]{15,18})'
            }
        ]
    };

    const { parsedOutput } = await runMigration(config);

    // check if the record was migrated
    expect(parsedOutput).toHaveProperty(custObjCorgA.id!);
    const newCustObjCId = parsedOutput[custObjCorgA.id!];
    expect(newCustObjCId).toBeTruthy();
    expect(newCustObjCId).toEqual(custObjCorgB.id);

    // should be able to query the new custom object C record
    const newCustObjC: any = await conn2.sobject('Custom_Object_C__c').retrieve(newCustObjCId);
    expect(newCustObjC).toBeDefined();
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually match duplicate record', async () => {
    console.log('starting test: migrate record with error - manually match duplicate record');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const externalId = `ext-${Math.random()}`;
    const custObjCorgA = await conn1.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgA);
    expect(custObjCorgA.id).toBeDefined();

    const custObjCorgB = await conn2.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgB);
    expect(custObjCorgB.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObjCorgA.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 'm', custObjCorgB.id!]);

    // check if the record was migrated
    expect(parsedOutput).toHaveProperty(custObjCorgA.id!);
    const newCustObjCId = parsedOutput[custObjCorgA.id!];
    expect(newCustObjCId).toBeTruthy();
    expect(newCustObjCId).toEqual(custObjCorgB.id);

    // should be able to query the new custom object C record
    const newCustObjC: any = await conn2.sobject('Custom_Object_C__c').retrieve(newCustObjCId);
    expect(newCustObjC).toBeDefined();
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - manually retry insert', async () => {
    console.log('starting test: migrate record with error - manually retry insert');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const externalId = `ext-${Math.random()}`;
    const custObjCorgA = await conn1.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgA);
    expect(custObjCorgA.id).toBeDefined();

    const custObjCorgB = await conn2.sobject('Custom_Object_C__c').create({ External_Id__c: externalId });
    console.log(custObjCorgB);
    expect(custObjCorgB.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [custObjCorgA.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, async (ioEvent: IOEvent, sendInput: (input: string) => void) => {
        if (ioEvent.category === 'input' && ioEvent.type === 'confirm_migration') {
            sendInput('y');
        } else if (ioEvent.category === 'input' && ioEvent.type === 'insert_error') {
            expect(ioEvent.message).toContain('duplicate value found: External_Id__c duplicates value on record with id:');
            // delete record from Org B
            await conn2.sobject('Custom_Object_C__c').delete(custObjCorgB.id!);
            // retry insert
            sendInput('r');
        }
    });

    // check if the record was migrated
    expect(parsedOutput).toHaveProperty(custObjCorgA.id!);
    const newCustObjCId = parsedOutput[custObjCorgA.id!];
    expect(newCustObjCId).toBeTruthy();
    expect(newCustObjCId).not.toEqual(custObjCorgB.id);

    // should be able to query the new custom object C record
    const newCustObjC: any = await conn2.sobject('Custom_Object_C__c').retrieve(newCustObjCId);
    expect(newCustObjC).toBeDefined();
    expect(newCustObjC.External_Id__c).toEqual(externalId);
});

test('migrate record with error - quit and save results so far', async () => {
    console.log('starting test: migrate record with error - quit and save results so far');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'Ebola Cola' });
    console.log(account);
    expect(account.id).toBeDefined();

    const contract = await conn1.sobject('Contract').create({ 
        AccountId: account.id!, 
        Status: 'Draft', 
        StartDate: new Date().toISOString(), 
        ContractTerm: 12 
    });
    console.log(contract);
    expect(contract.id).toBeDefined();

    await conn1.sobject('Contract').update({ Id: contract.id!, Status: 'Activated' });

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contract.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config, ['y', 'h']);

    // check if Account was migrated
    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);

    // run migration again, for Account
    config.recordIds = [account.id!];
    const { parsedOutput: parsedOutput2 } = await runMigration(config, ['y']);

    // Account should not be migrated again
    expect(parsedOutput2).toHaveProperty(account.id!);
    const newAccountId2 = parsedOutput2[account.id!];
    expect(newAccountId2).toBeTruthy();
    expect(newAccountId2).toEqual(newAccountId);
});

test('match not found, create new record', async () => {
    console.log('starting test: match not found, create new record');

    const { conn1, conn2 } = await setupTestConnections();

    const account1Name = `Ebola Cola ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    console.log('creating records');
    const account1 = await conn1.sobject('Account').create({ Name: account1Name });
    console.log(account1);
    expect(account1.id).toBeDefined();

    const account2 = await conn1.sobject('Account').create({ Name: account2Name });
    console.log(account2);
    expect(account2.id).toBeDefined();

    const account1B = await conn2.sobject('Account').create({ Name: account1Name });
    console.log(account1B);
    expect(account1B.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [account1.id!, account2.id!],
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Name', targetField: 'Name' }
            ],
            whenMissing: 'create'
        }]
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(account1.id!);
    const newAccount1Id = parsedOutput[account1.id!];
    expect(newAccount1Id).toBeTruthy();
    expect(newAccount1Id).toEqual(account1B.id);

    expect(parsedOutput).toHaveProperty(account2.id!);
    const newAccount2Id = parsedOutput[account2.id!];
    expect(newAccount2Id).toBeTruthy();
    expect(newAccount2Id).not.toEqual(account2.id);

    // should be able to query the new account record
    const newAccount2: any = await conn2.sobject('Account').retrieve(newAccount2Id);
    expect(newAccount2).toBeDefined();
    expect(newAccount2.Name).toEqual(account2Name);
});

test('match not found, skip record', async () => {
    console.log('starting test: match not found, skip record');

    const { conn1, conn2 } = await setupTestConnections();

    const account1Name = `Ebola Cola ${Math.random()}`;
    const account2Name = `ACME ${Math.random()}`;

    console.log('creating records');
    const account1 = await conn1.sobject('Account').create({ Name: account1Name });
    console.log(account1);
    expect(account1.id).toBeDefined();

    const account2 = await conn1.sobject('Account').create({ Name: account2Name });
    console.log(account2);
    expect(account2.id).toBeDefined();

    const account1B = await conn2.sobject('Account').create({ Name: account1Name });
    console.log(account1B);
    expect(account1B.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [account1.id!, account2.id!],
        matchers: [...defaultMatchers, {
            sObjectType: 'Account',
            fieldMappings: [
                { sourceField: 'Name', targetField: 'Name' }
            ],
            whenMissing: 'skip'
        }]
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(account1.id!);
    const newAccount1Id = parsedOutput[account1.id!];
    expect(newAccount1Id).toBeTruthy();
    expect(newAccount1Id).toEqual(account1B.id);

    expect(parsedOutput).toHaveProperty(account2.id!);
    const newAccount2Id = parsedOutput[account2.id!];
    expect(newAccount2Id).toBe('');

    // should not be able to query the new account record by account name
    const newAccount2: any = await conn2.sobject('Account').select('Id').where(`Name = '${account2Name}'`).execute();
    expect(newAccount2.length).toBe(0);
});

test('use history for both primary and secondary records', async () => {
    console.log('starting test: use history for both primary and secondary records');

    const { conn1, conn2 } = await setupTestConnections();
    
    const account1Name = `Ebola Cola ${Math.random()}`;
    const contactName = `John Doe ${Math.random()}`;

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: account1Name });
    console.log(account);
    expect(account.id).toBeDefined();

    const contact = await conn1.sobject('Contact').create({ AccountId: account.id!, LastName: contactName });
    console.log(contact);
    expect(contact.id).toBeDefined();

    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [contact.id!],
        matchers: defaultMatchers
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(contact.id!);
    const newContactId = parsedOutput[contact.id!];
    expect(newContactId).toBeTruthy();
    expect(newContactId).not.toEqual(contact.id);

    // should be able to query the new contact record
    const newContact: any = await conn2.sobject('Contact').retrieve(newContactId);
    expect(newContact).toBeDefined();
    expect(newContact.LastName).toEqual(contactName);
    
    expect(parsedOutput).toHaveProperty(account.id!);
    const newAccountId = parsedOutput[account.id!];
    expect(newAccountId).toBeTruthy();
    expect(newAccountId).not.toEqual(account.id);

    // should be able to query the new account record
    const newAccount: any = await conn2.sobject('Account').retrieve(newAccountId);
    expect(newAccount).toBeDefined();
    expect(newAccount.Name).toEqual(account1Name);

    // run migration again with new contact
    const contact2 = await conn1.sobject('Contact').create({ AccountId: account.id!, LastName: contactName });
    console.log(contact2);
    expect(contact2.id).toBeDefined();

    config.recordIds = [contact2.id!];

    const { parsedOutput: parsedOutput2 } = await runMigration(config);

    expect(parsedOutput2).toHaveProperty(contact2.id!);
    const newContactId2 = parsedOutput2[contact2.id!];
    expect(newContactId2).toBeTruthy();
    expect(newContactId2).not.toEqual(contact2.id);

    expect(parsedOutput2).toHaveProperty(account.id!);
    const newAccountId2 = parsedOutput2[account.id!];
    expect(newAccountId2).toBeTruthy();
    expect(newAccountId2).toEqual(newAccountId);
});

test('fix column automatically with modifying current value', async () => {
    console.log('starting test: fix column automatically with modifying current value');

    const { conn1, conn2 } = await setupTestConnections();
    
    // query pre-existing Chatter Test user
    const chatterTestUser = await conn1.sobject('User').select('Id').where('Name = \'Chatter Test\'').execute();
    expect(chatterTestUser.length).toBe(1);


    const config = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [chatterTestUser[0].Id!],
        matchers: defaultMatchers,
        solvers: [
            {
                action: 'append_random',
                message: 'Duplicate Username',
                changeFields: [
                    {
                        field: 'Username',
                        length: 4
                    }
                ]
            }
        ]
    };

    const { parsedOutput } = await runMigration(config);

    expect(parsedOutput).toHaveProperty(chatterTestUser[0].Id!);
    const newChatterTestUserId = parsedOutput[chatterTestUser[0].Id!];
    expect(newChatterTestUserId).toBeTruthy();
    expect(newChatterTestUserId).not.toEqual(chatterTestUser[0].Id);

    // should be able to query the new user record
    const newChatterTestUser: any = await conn2.sobject('User').retrieve(newChatterTestUserId);
    expect(newChatterTestUser).toBeDefined();
    expect(newChatterTestUser.Name).toEqual('Chatter Test');
});
