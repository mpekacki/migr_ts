import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, DescribeGlobalResult } from 'jsforce';

export interface AuthConfig {
    orgAlias?: string;
    orgUrl?: string;
    orgToken?: string;
}

export interface SaveError {
    message: string;
    fields: string[];
}

export interface SaveResult {
    id: string;
    success: boolean;
    errors: SaveError[];
}

export interface SalesforceClient {
    describeGlobal(): Promise<DescribeGlobalResult>;
    describeSObject(sObjectName: string): Promise<DescribeSObjectResult>;
    retrieve(sObjectName: string, recordId: string): Promise<any>;
    retrieveBlob(sObjectName: string, recordId: string, fieldName: string): Promise<string>;
    find(sObjectName: string, conditions: Record<string, string>): any;
    select(sObjectName: string): any;
    query(soql: string): Promise<any>;
    bulkCreate(records: any[]): Promise<SaveResult[]>;
    bulkUpdate(records: any[]): Promise<SaveResult[]>;
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

    /**
     * The contents of a blob (base64) field, base64 encoded.
     *
     * Retrieving a record does not bring its files along: a blob field comes back
     * holding the path of the endpoint that serves it
     * ("/services/data/v67.0/sobjects/ContentVersion/068.../VersionData"), so the
     * bytes have to be asked for separately. jsforce's `encoding` option decides
     * how it decodes the response body, and base64 is exactly the form the field
     * takes on the way back into the target org, so no buffer is ever held in
     * two representations at once. `responseType` pins the body parser to plain
     * text - without it a file served as application/json would be JSON.parse'd
     * rather than handed over as it came.
     */
    async retrieveBlob(sObjectName: string, recordId: string, fieldName: string): Promise<string> {
        return (await this.connection.request(
            {
                method: 'GET',
                url: `/services/data/v${this.connection.version}/sobjects/${sObjectName}/${recordId}/${fieldName}`
            },
            { encoding: 'base64', responseType: 'text/plain' }
        )) as unknown as string;
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

    async bulkCreate(records: any[]): Promise<SaveResult[]> {
        return (await this.connection.request({
            method: 'POST',
            url: `/services/data/v${this.connection.version}/composite/sobjects`,
            body: JSON.stringify({
                allOrNone: false,
                records: records
            })
        })) as SaveResult[];
    }

    async bulkUpdate(records: any[]): Promise<SaveResult[]> {
        return (await this.connection.request({
            method: 'PATCH',
            url: `/services/data/v${this.connection.version}/composite/sobjects`,
            body: JSON.stringify({
                allOrNone: false,
                records: records
            })
        })) as SaveResult[];
    }

    async update(sObjectName: string, record: any): Promise<void> {
        await this.connection.sobject(sObjectName).update(record);
    }

    getVersion(): string {
        return this.connection.version;
    }
}