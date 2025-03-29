import { expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';

class TestOrg {
    alias: string;
    conn: Connection;
    
    private constructor(alias: string, conn: Connection) {
        this.alias = alias;
        this.conn = conn;
    }

    public static async create(alias: string) {
        const allAuths = await AuthInfo.listAllAuthorizations();
        const orgUsername = allAuths.find(auth => auth.aliases!.includes(alias))?.username;
        expect(orgUsername).toBeDefined();
        const authInfoOptions: AuthInfo.Options = { username: orgUsername! };
        const authInfo = await AuthInfo.create(authInfoOptions);
        const conn = await Connection.create({ authInfo });
        return new TestOrg(alias, conn);
    }

    public async createAccount() {
        const account = await this.conn.sobject('Account').create({ Name: 'Ebola Cola' });
        return account;
    }

    public async verifyAccount(newId: string) {
        const account = await this.conn.sobject('Account').retrieve(newId);
        expect(account.Name).toBe('Ebola Cola');
    }
}

async function getOrgs(sourceOrgAlias: string, targetOrgAlias: string) {
    const sourceOrg = await TestOrg.create(sourceOrgAlias);
    const targetOrg = await TestOrg.create(targetOrgAlias);

    return { sourceOrg, targetOrg };
}

export { getOrgs };
