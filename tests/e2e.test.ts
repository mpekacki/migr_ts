import { test, expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';
import util from 'util';
import { exec } from 'child_process';
import fs from 'fs';

const execPromise = util.promisify(exec);

afterEach(async () => {
    try {
        fs.unlinkSync('./config.json');
        fs.unlinkSync('./testMigrationOrgB__history.json');
    } catch (error) {
        console.error('Error deleting files:', error);
    }
});

test('migrate record', async () => {
    // Increase timeout to 60 seconds
    jest.setTimeout(60000);

    // given
    console.log('logging in to test orgs');
    const allAuths = await AuthInfo.listAllAuthorizations();

    const orgAUsername = allAuths.find(auth => auth.aliases!.includes('testMigrationOrgA'))?.username;
    const orgBUsername = allAuths.find(auth => auth.aliases!.includes('testMigrationOrgB'))?.username;

    const authInfoOptionsA: AuthInfo.Options = {
        username: orgAUsername!
    };
    const authInfoOptionsB: AuthInfo.Options = {
        username: orgBUsername!
    };
    const authInfoA = await AuthInfo.create(authInfoOptionsA);
    const authInfoB = await AuthInfo.create(authInfoOptionsB);

    const conn1 = await Connection.create({ authInfo: authInfoA });
    const conn2 = await Connection.create({ authInfo: authInfoB });

    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();

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

    const opportunity = await conn1.sobject('Opportunity').create({ Name: 'Blasto Bandage', CampaignId: campaignOrgA.id!, AccountId: account.id!, StageName: 'Prospecting', CloseDate: new Date().toISOString() });
    console.log(opportunity);
    expect(opportunity.id).toBeDefined();

    let capturedOutput = '';

    const config = {
        sourceOrg: 'testMigrationOrgA',
        targetOrg: 'testMigrationOrgB',
        recordId: opportunity.id!,
        matchers: [
            {
                sObjectType: 'Campaign',
                fieldMappings: [
                    {
                        sourceField: 'Name',
                        targetField: 'Name'
                    },
                    {
                        sourceField: 'IsActive',
                        targetField: 'IsActive'
                    }
                ]
            },
            {
                sObjectType: 'Profile',
                fieldMappings: [
                    {
                        sourceField: 'Name',
                        targetField: 'Name'
                    }
                ]
            },
            {
                sObjectType: 'User',
                fieldMappings: [
                    {
                        sourceField: 'Name',
                        targetField: 'Name'
                    }
                ]
            },
            {
                sObjectType: 'UserRole',
                fieldMappings: [
                    {
                        sourceField: 'Name',
                        targetField: 'Name'
                    }
                ]
            },
            {
                sObjectType: 'UserLicense',
                fieldMappings: [
                    {
                        sourceField: 'Name',
                        targetField: 'Name'
                    }
                ]
            }
        ],
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        }
    };

    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));

    // when
    const child = exec(`npx ts-node ./main.ts --config-json ./config.json`);
    child.stdout?.on('data', (data) => {
        console.log(data);
        capturedOutput += data;
    });
    child.stderr?.on('data', (data) => {
        console.error(data);
    });
    await new Promise(resolve => child.on('close', resolve));

    // then
    // should output old record ids to new record ids, e.g. {"006xx000001234AAA":"006yy000002345BBB","001xx000003456CCC":"001yy000004567DDD"}
    const outputLines = capturedOutput.split('\n');
    expect(outputLines.length).toBeGreaterThan(1);
    const parsedOutput = JSON.parse(outputLines[outputLines.length - 2]);

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

    // given
    const contact2 = await conn1.sobject('Contact').create({ FirstName: 'Ocean', LastName: 'Man', AccountId: account.id! });
    expect(contact2.id).toBeDefined();
    
    config.recordId = contact2.id!;
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
    capturedOutput = '';

    // when
    const child2 = exec(`npx ts-node ./main.ts --config-json ./config.json`);
    child2.stdout?.on('data', (data) => {
        console.log(data);
        capturedOutput += data;
    });
    child2.stderr?.on('data', (data) => {
        console.error(data);
    });
    await new Promise(resolve => child2.on('close', resolve));

    // then
    const outputLines2 = capturedOutput.split('\n');
    expect(outputLines.length).toBeGreaterThan(1);
    const parsedOutput2 = JSON.parse(outputLines2[outputLines2.length - 2]);
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
