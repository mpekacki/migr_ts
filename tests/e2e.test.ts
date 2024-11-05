import { test, expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';
import { exec } from 'child_process';
import fs from 'fs';
import { IOEvent } from '../app';


const sourceOrgAlias = 'testMigrationOrgA';
const targetOrgAlias = 'testMigrationOrgB';

afterEach(async () => {
    try {
        fs.unlinkSync('./config_test.json');
        fs.unlinkSync(`${targetOrgAlias}__history.json`);
    } catch (error) {
        console.log('Error deleting files:', error);
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

async function runMigration(config: any, onOutput?: (output: IOEvent, writeToInput: (input: string) => void) => void) {
    fs.writeFileSync('./config_test.json', JSON.stringify(config, null, 2));
    const capturedOutput: IOEvent[] = [];
    let capturedError = '';

    const child = exec(`npx ts-node ./main.ts --config-json ./config_test.json`);
    child.stdout?.on('data', (data) => {
        console.log(data);
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim() === '') {
                continue;
            }
            const event = JSON.parse(line) as IOEvent;
            capturedOutput.push(event);
            if (onOutput) {
                onOutput(event, (input: string) => {
                    console.log('sending input:', input);
                    child.stdin?.write(input);
                });
            } else if (event.category === 'input' && event.type === 'confirm_migration') {
                console.log('sending y');
                child.stdin?.write('y');
                child.stdin?.write('\n');
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
            { sourceField: 'FirstName', targetField: 'FirstName' },
            { sourceField: 'LastName', targetField: 'LastName' }
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

test('migrate record', async () => {
    console.log('starting test: migrate record');

    jest.setTimeout(60000);

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

    const { parsedOutput } = await runMigration(config);

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
}, 60000);

test('migrate record with error fixed automatically', async () => {
    console.log('starting test: migrate record with error');

    jest.setTimeout(60000);

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
}, 60000);

test('migrate record with error fixed manually', async () => {
    console.log('starting test: migrate record with error fixed manually');

    jest.setTimeout(60000);

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

    let askedToFixError = false;
    const { parsedOutput } = await runMigration(config, (output, writeToInput) => {
        if (output.category === 'input' && output.type === 'confirm_migration') {
            writeToInput('y\n');
        }
        if (output.category === 'input' && output.type === 'insert_error') {
            askedToFixError = true;
            writeToInput('{"Status": "Draft"}\n');
        }
    });

    expect(askedToFixError).toBeTruthy();

    // Check if contract was migrated
    expect(parsedOutput).toHaveProperty(contract.id!);
    const newContractId = parsedOutput[contract.id!];
    expect(newContractId).toBeTruthy();
    expect(newContractId).not.toEqual(contract.id);

    // should be able to query the new contract record
    const newContract: any = await conn2.sobject('Contract').retrieve(newContractId);
    expect(newContract).toBeDefined();
    expect(newContract.Status).toEqual('Activated');
}, 60000);