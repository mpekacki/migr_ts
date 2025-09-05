import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, DescribeGlobalResult, SObjectRecord, Schema, SObjectUpdateRecord, Query } from 'jsforce';

export interface AuthConfig {
    orgAlias?: string;
    orgUrl?: string;
    orgToken?: string;
}

export interface SalesforceClient {
    describeGlobal(): Promise<DescribeGlobalResult>;
    describeSObject(sObjectName: string): Promise<DescribeSObjectResult>;
    retrieve(sObjectName: string, recordId: string): Promise<any>;
    find(sObjectName: string, conditions: Record<string, string>): any;
    select(sObjectName: string): any;
    query(soql: string): Promise<any>;
    bulkCreate(records: any[]): Promise<Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>>;
    update(sObjectName: string, record: any): Promise<void>;
    getVersion(): string;
}

export class DefaultSalesforceClient implements SalesforceClient {
    constructor(private connection: Connection) {}

    static async createFromAuth(authConfig: AuthConfig): Promise<DefaultSalesforceClient> {
        const allAuths = await AuthInfo.listAllAuthorizations();
        
        let authInfo: AuthInfo;
        if (authConfig.orgAlias) {
            const getOrgUsername = (alias: string) => allAuths.find(auth => auth.aliases?.includes(alias))?.username;
            const username = getOrgUsername(authConfig.orgAlias);
            if (!username) {
                throw new Error(`Unable to find username for org alias: ${authConfig.orgAlias}`);
            }
            authInfo = await AuthInfo.create({ username });
        } else if (authConfig.orgUrl && authConfig.orgToken) {
            authInfo = await AuthInfo.create({
                username: authConfig.orgToken,
                accessTokenOptions: {
                    instanceUrl: authConfig.orgUrl,
                    serverUrl: authConfig.orgUrl,
                    sessionId: authConfig.orgToken
                }
            });
        } else {
            throw new Error('Org authentication missing: provide either orgAlias or orgUrl + orgToken');
        }
        
        const connection = await Connection.create({ authInfo });
        return new DefaultSalesforceClient(connection);
    }

    async describeGlobal(): Promise<DescribeGlobalResult> {
        return await this.connection.describeGlobal();
    }

    async describeSObject(sObjectName: string): Promise<DescribeSObjectResult> {
        return await this.connection.sobject(sObjectName).describe();
    }

    async retrieve(sObjectName: string, recordId: string): Promise<any> {
        return await this.connection.sobject(sObjectName).retrieve(recordId);
    }

    find(sObjectName: string, conditions: Record<string, string>) {
        return this.connection.sobject(sObjectName).find(conditions);
    }

    select(sObjectName: string) {
        return this.connection.sobject(sObjectName).select('Id');
    }

    async query(soql: string): Promise<any> {
        return await this.connection.query(soql);
    }

    async bulkCreate(records: any[]): Promise<Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>> {
        return (await this.connection.request({
            method: 'POST',
            url: `/services/data/v${this.connection.version}/composite/sobjects`,
            body: JSON.stringify({
                allOrNone: false,
                records: records
            })
        })) as Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>;
    }

    async update(sObjectName: string, record: any): Promise<void> {
        await this.connection.sobject(sObjectName).update(record);
    }

    getVersion(): string {
        return this.connection.version;
    }
}