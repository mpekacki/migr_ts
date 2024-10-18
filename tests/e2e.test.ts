import { test, expect } from '@jest/globals';
import { Org } from '@salesforce/core';
import { Connection } from 'jsforce';

test('create org', async () => {
    const org1: Org = await Org.create({ aliasOrUsername: 'testMigrationOrgA' });
    await org1.refreshAuth();
    const org2: Org = await Org.create({ aliasOrUsername: 'testMigrationOrgB' });
    await org2.refreshAuth();
    console.log(org1);
    console.log(org2);
    expect(org1).toBeDefined();
    expect(org2).toBeDefined();
    
    const conn = new Connection({
        instanceUrl: org1.getConnection().instanceUrl,
        accessToken: org1.getConnection().accessToken!
    });

    const account = await conn.sobject('Account').create({ Name: 'ACME' });
    console.log(account);
    expect(account.id).toBeDefined();

});
