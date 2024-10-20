import { test, expect } from '@jest/globals';
import { Org } from '@salesforce/core';
import { Connection } from 'jsforce';
import { main } from '../app';

test('migrate record', async () => {
    // Increase timeout to 30 seconds
    jest.setTimeout(30000);

    // given
    console.log('creating orgs');
    const org1: Org = await Org.create({ aliasOrUsername: 'testMigrationOrgA' });
    await org1.refreshAuth();
    const org2: Org = await Org.create({ aliasOrUsername: 'testMigrationOrgB' });
    await org2.refreshAuth();
    console.log(org1);
    console.log(org2);
    expect(org1).toBeDefined();
    expect(org2).toBeDefined();
    
    const conn1 = new Connection({
        instanceUrl: org1.getConnection().instanceUrl,
        accessToken: org1.getConnection().accessToken!
    });

    const conn2 = new Connection({
        instanceUrl: org2.getConnection().instanceUrl,
        accessToken: org2.getConnection().accessToken!
    });

    console.log('creating records');
    const account = await conn1.sobject('Account').create({ Name: 'ACME' });
    console.log(account);
    expect(account.id).toBeDefined();

    const opportunity = await conn1.sobject('Opportunity').create({ Name: 'Blasto Bandage', AccountId: account.id!, StageName: 'Prospecting', CloseDate: new Date().toISOString() });
    console.log(opportunity);
    expect(opportunity.id).toBeDefined();

    let capturedOutput = '';
    const onOutput = (output: string) => {
        capturedOutput += output;
    };

    // when
    await main('testMigrationOrgA', 'testMigrationOrgB', opportunity.id!, onOutput);

    // then
    // should output old record ids to new record ids, e.g. {"006xx000001234AAA":"006yy000002345BBB","001xx000003456CCC":"001yy000004567DDD"}
    console.log('capturedOutput', capturedOutput);
    const parsedOutput = JSON.parse(capturedOutput);
    
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

    // should be able to query the new opportunity record
    const newOpportunity: any = await conn2.sobject('Opportunity').retrieve(newOpportunityId);
    expect(newOpportunity).toBeDefined();
    expect(newOpportunity.Name).toEqual('Blasto Bandage');

    // should be able to query the new account record
    const newAccount: any = await conn2.sobject('Account').retrieve(newAccountId);
    expect(newAccount).toBeDefined();
    expect(newAccount.Name).toEqual('ACME');

    // Check if the new opportunity is associated with the new account
    expect(newOpportunity.AccountId).toEqual(newAccountId);
}, 30000); // Add timeout parameter to test function
