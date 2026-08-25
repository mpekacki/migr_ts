import { SalesforceClient, DefaultSalesforceClient, AuthConfig } from '../salesforce-client';

interface ErrorConfig {
    recordId: string;
    operation: 'bulkCreate' | 'bulkUpdate' | 'retrieve' | 'retrieveBlob' | 'query' | 'update' | 'describeSObject' | 'describeGlobal' | 'find' | 'select';
    error: Error;
}

export class MockSalesforceClient implements SalesforceClient {
    private defaultClient: DefaultSalesforceClient;
    private errorConfigs: ErrorConfig[] = [];

    private constructor(defaultClient: DefaultSalesforceClient) {
        this.defaultClient = defaultClient;
    }

    static async createFromAuth(authConfig: AuthConfig): Promise<MockSalesforceClient> {
        const defaultClient = await DefaultSalesforceClient.createFromAuth(authConfig);
        return new MockSalesforceClient(defaultClient);
    }

    static async createFromDefaultClient(defaultClient: DefaultSalesforceClient): Promise<MockSalesforceClient> {
        return new MockSalesforceClient(defaultClient);
    }

    /**
     * Configure the client to throw an error for a specific record ID and operation
     */
    configureError(recordId: string, operation: 'bulkCreate' | 'bulkUpdate' | 'retrieve' | 'retrieveBlob' | 'query' | 'update' | 'describeSObject' | 'describeGlobal' | 'find' | 'select', error: Error): void {
        this.errorConfigs.push({ recordId, operation, error });
    }

    /**
     * Clear all configured errors
     */
    clearErrors(): void {
        this.errorConfigs = [];
    }

    private shouldThrowError(operation: string, data?: any): Error | null {
        // For bulkCreate and bulkUpdate, check if any record in the array matches our error config
        if ((operation === 'bulkCreate' || operation === 'bulkUpdate') && Array.isArray(data)) {
            for (const record of data) {
                for (const config of this.errorConfigs) {
                    if (config.operation === operation) {
                        // Check if this is a Contact record and we have a Contact error configured
                        if (record.attributes?.type === 'Contact' && config.recordId.includes('Contact')) {
                            return config.error;
                        }
                        // Check if this record matches the specific recordId pattern
                        if (config.recordId === record.attributes?.url?.split('/').pop()) {
                            return config.error;
                        }
                    }
                }
            }
        }

        // For other operations, check if recordId or operation matches
        for (const config of this.errorConfigs) {
            if (config.operation === operation) {
                return config.error;
            }
        }

        return null;
    }

    async describeGlobal(): Promise<any> {
        const error = this.shouldThrowError('describeGlobal');
        if (error) throw error;
        return this.defaultClient.describeGlobal();
    }

    async describeSObject(sObjectName: string): Promise<any> {
        const error = this.shouldThrowError('describeSObject');
        if (error) throw error;
        return this.defaultClient.describeSObject(sObjectName);
    }

    async retrieve(sObjectName: string, recordId: string): Promise<any> {
        const error = this.shouldThrowError('retrieve');
        if (error) throw error;
        return this.defaultClient.retrieve(sObjectName, recordId);
    }

    async retrieveBlob(sObjectName: string, recordId: string, fieldName: string): Promise<string> {
        const error = this.shouldThrowError('retrieveBlob');
        if (error) throw error;
        return this.defaultClient.retrieveBlob(sObjectName, recordId, fieldName);
    }

    find(sObjectName: string, conditions: Record<string, string>): any {
        const error = this.shouldThrowError('find');
        if (error) throw error;
        return this.defaultClient.find(sObjectName, conditions);
    }

    select(sObjectName: string): any {
        const error = this.shouldThrowError('select');
        if (error) throw error;
        return this.defaultClient.select(sObjectName);
    }

    async query(soql: string): Promise<any> {
        const error = this.shouldThrowError('query');
        if (error) throw error;
        return this.defaultClient.query(soql);
    }

    async bulkCreate(records: any[]): Promise<Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>> {
        const error = this.shouldThrowError('bulkCreate', records);
        if (error) throw error;
        return this.defaultClient.bulkCreate(records);
    }

    async bulkUpdate(records: any[]): Promise<Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>> {
        const error = this.shouldThrowError('bulkUpdate', records);
        if (error) throw error;
        return this.defaultClient.bulkUpdate(records);
    }

    async update(sObjectName: string, record: any): Promise<void> {
        const error = this.shouldThrowError('update');
        if (error) throw error;
        return this.defaultClient.update(sObjectName, record);
    }

    getVersion(): string {
        return this.defaultClient.getVersion();
    }
}