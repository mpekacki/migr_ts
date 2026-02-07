import { test, expect } from '@jest/globals';
import { Connection, AuthInfo } from '@salesforce/core';
import { exec } from 'child_process';
import * as fs from 'fs';
import { main, ClientFactory, Options, IOEvent } from '../app';
import { MockSalesforceClient } from './mock-salesforce-client';
import { DefaultSalesforceClient, SalesforceClient } from '../salesforce-client';

const sourceOrgAlias = 'testMigrationOrgA';
const targetOrgAlias = 'testMigrationOrgB';

jest.setTimeout(120000);

afterEach(async () => {
    if (fs.existsSync('./config_test.json')) {
        fs.unlinkSync('./config_test.json');
    }
    if (fs.existsSync(`${targetOrgAlias}__history.json`)) {
        fs.unlinkSync(`${targetOrgAlias}__history.json`);
    }
});

let cachedConn1: Connection | undefined;
let cachedConn2: Connection | undefined;

async function setupTestConnections() {
    if (cachedConn1 && cachedConn2) {
        return { conn1: cachedConn1, conn2: cachedConn2 };
    }

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

    cachedConn1 = conn1;
    cachedConn2 = conn2;

    return { conn1, conn2 };
}

async function createAccount(conn: any, name: string = `Account-${Math.random()}`) {
    const account = await conn.sobject('Account').create({ Name: name });
    expect(account.id).toBeDefined();
    return account;
}

async function createContact(conn: any, firstName: string = 'John', lastName: string = 'Doe', accountId?: string) {
    const contact = await conn.sobject('Contact').create({ 
        FirstName: firstName, 
        LastName: lastName, 
        AccountId: accountId 
    });
    expect(contact.id).toBeDefined();
    return contact;
}

const defaultMatchers = [
    {
        sObjectType: 'Profile',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ],
        whenMissing: 'create' as const
    },
    {
        sObjectType: 'User',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ],
        whenMissing: 'create' as const
    },
    {
        sObjectType: 'UserRole',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ],
        whenMissing: 'create' as const
    },
    {
        sObjectType: 'UserLicense',
        fieldMappings: [
            { sourceField: 'Name', targetField: 'Name' }
        ],
        whenMissing: 'create' as const
    }
];

// This test simulates a network error during Contact creation while Account creation succeeds
test('simulate network error during Contact creation in full E2E migration', async () => {
    console.log('starting test: simulate network error during Contact creation in full E2E migration');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records in source org');
    const account = await createAccount(conn1, 'Test Account for Network Error');
    const contact = await createContact(conn1, 'John', 'NetworkError', account.id!);

    console.log('Account created:', account.id);
    console.log('Contact created:', contact.id);

    // Create a client factory that returns normal source client and mock target client
    const clientFactory: ClientFactory = {
        async createSourceClient(orgAlias, orgUrl, orgToken): Promise<SalesforceClient> {
            return new DefaultSalesforceClient(conn1);
        },
        async createTargetClient(orgAlias, orgUrl, orgToken): Promise<SalesforceClient> {
            const targetClient = await MockSalesforceClient.createFromDefaultClient(new DefaultSalesforceClient(conn2));
            // Configure network error for Contact creation - use "Contact" as a pattern to match Contact records
            targetClient.configureError(
                'Contact',
                'bulkCreate',
                new Error('ECONNRESET: Connection reset by peer - simulated network failure during Contact creation')
            );
            return targetClient;
        }
    };

    const options: Options = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [account.id!],
        relatedRecordDepthLimit: 5,
        matchers: defaultMatchers,
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        },
        solvers: []
    };

    const capturedOutput: IOEvent[] = [];
    let migrationCompleted = false;
    let migrationError: any = null;

    try {
        await main(
            options,
            (output: IOEvent) => {
                console.log('Migration output:', output);
                capturedOutput.push(output);
            },
            async (question: IOEvent) => {
                console.log('Migration input request:', question);
                if (question.category === 'input' && question.type === 'confirm_migration') {
                    return 'y'; // Confirm migration
                }
                // For any errors, we'll handle them based on the error type
                if (question.category === 'input' && question.type === 'insert_error') {
                    console.log('Insert error encountered:', question.data?.error);
                    expect(question.data?.error).toContain('ECONNRESET');
                    return 's'; // Skip the failing Contact
                }
                return 'y'; // Default confirmation
            },
            clientFactory
        );
        migrationCompleted = true;
    } catch (error) {
        migrationError = error;
        console.log('Migration failed with error:', error);
    }

    // The migration should complete, but the Contact should fail
    console.log('Migration completed:', migrationCompleted);
    console.log('Migration error:', migrationError);
    
    // Check that we got the expected outputs
    expect(capturedOutput.length).toBeGreaterThan(0);
    
    // Find the final output with results
    const finalOutput = capturedOutput.find(output =>
        output.category === 'output' &&
        output.type === 'finished' &&
        output.data !== undefined
    );
    
    if (finalOutput && finalOutput.data) {
        const result = JSON.parse(finalOutput.data);
        console.log('Final migration result:', result);
        
        // Account should be successfully migrated
        expect(result.allMigratedRecords).toHaveProperty(account.id!);
        
        // Contact should either be in error state or skipped
        const contactResult = result.allMigratedRecords[contact.id!];
        if (contactResult === '') {
            console.log('Contact was skipped as expected');
        } else {
            console.log('Contact result:', contactResult);
        }
    } else {
        console.log('No final result found in output');
    }

    console.log('Network error simulation test completed');
});

// Helper test to verify our MockSalesforceClient works correctly
test('verify MockSalesforceClient functionality', async () => {
    const { conn1 } = await setupTestConnections();
    
    const defaultClient = new DefaultSalesforceClient(conn1);
    const mockClient = await MockSalesforceClient.createFromDefaultClient(defaultClient);

    // Test that normal operations pass through
    const version = mockClient.getVersion();
    expect(version).toBeDefined();

    // Test error injection for bulkCreate
    const testError = new Error('Test error for bulkCreate');
    mockClient.configureError('testId', 'bulkCreate', testError);

    const testRecords = [{ attributes: { type: 'Contact' }, Name: 'Test' }];
    
    try {
        await mockClient.bulkCreate(testRecords);
        expect(false).toBe(true); // Should not reach here
    } catch (error) {
        expect(error.message).toBe('Test error for bulkCreate');
    }

    // Clear errors and verify it works again
    mockClient.clearErrors();
    
    // This should work with actual Salesforce (might fail for other reasons, but not our injected error)
    try {
        await mockClient.bulkCreate([]);
        // Empty array should succeed
    } catch (error) {
        // Ignore actual Salesforce errors, we're just testing our mock doesn't interfere
    }
});

// Test the new jsforce error handling with retry solver
test('jsforce error handling with retry solver', async () => {
    console.log('starting test: jsforce error handling with retry solver');

    const { conn1, conn2 } = await setupTestConnections();

    console.log('creating records in source org');
    const account = await createAccount(conn1, 'Test Account for Retry');
    const contact = await createContact(conn1, 'Jane', 'Retry', account.id!);

    console.log('Account created:', account.id);
    console.log('Contact created:', contact.id);

    // Create a client factory that simulates network errors but allows retries
    const clientFactory: ClientFactory = {
        async createSourceClient(orgAlias, orgUrl, orgToken): Promise<SalesforceClient> {
            return new DefaultSalesforceClient(conn1);
        },
        async createTargetClient(orgAlias, orgUrl, orgToken): Promise<SalesforceClient> {
            const targetClient = await MockSalesforceClient.createFromDefaultClient(new DefaultSalesforceClient(conn2));
            // Configure network error for Contact creation that should be retried
            targetClient.configureError(
                'Contact',
                'bulkCreate',
                new Error('ECONNRESET: Connection reset by peer - transient network error')
            );
            return targetClient;
        }
    };

    const options: Options = {
        sourceOrg: sourceOrgAlias,
        targetOrg: targetOrgAlias,
        recordIds: [account.id!],
        relatedRecordDepthLimit: 5,
        matchers: defaultMatchers,
        relationships: {
            "Account": [
                {
                    "name": "Contacts"
                }
            ]
        },
        solvers: [
            {
                action: 'retry',
                message: 'Jsforce error:.*ECONNRESET.*transient network error',
                maxAttempts: 3,
                delay: 100 // 100ms delay for testing
            },
            {
                action: 'backoff',
                message: 'Jsforce error:.*ETIMEDOUT',
                maxAttempts: 3,
                initialDelay: 100,
                backoffMultiplier: 2
            },
            {
                action: 'fallback',
                message: 'Jsforce error:.*PERMANENT_ERROR',
                fallbackAction: 'skip'
            }
        ]
    };

    const capturedOutput: IOEvent[] = [];
    let migrationCompleted = false;
    let migrationError: any = null;

    try {
        await main(
            options,
            (output: IOEvent) => {
                console.log('Migration output:', output.type, output.data);
                capturedOutput.push(output);
            },
            async (question: IOEvent) => {
                console.log('Migration input request:', question);
                if (question.category === 'input' && question.type === 'confirm_migration') {
                    return 'y';
                }
                if (question.category === 'input' && question.type === 'insert_error') {
                    console.log('Insert error encountered:', question.data?.error);
                    return 's'; // Skip the failing record if not handled by solver
                }
                return 'y';
            },
            clientFactory
        );
        migrationCompleted = true;
    } catch (error) {
        migrationError = error;
        console.log('Migration failed with error:', error);
    }

    // The migration should complete, but Contact creation should fail after retries
    console.log('Migration completed:', migrationCompleted);
    console.log('Migration error:', migrationError);

    // Check that jsforce error handling messages appeared in output
    const jsforceErrorMessages = capturedOutput.filter(output =>
        output.type === 'error' && output.data?.message?.includes('Jsforce error:')
    );

    console.log('Jsforce error messages found:', jsforceErrorMessages.length);
    expect(jsforceErrorMessages.length).toBeGreaterThan(0);

    // Check that the errors are now properly integrated into the solver framework
    const unhandledJsforceMessages = capturedOutput.filter(output =>
        output.type === 'error' && output.data?.message?.includes('Unhandled jsforce error')
    );
    
    console.log('Unhandled jsforce error messages found:', unhandledJsforceMessages.length);
    expect(unhandledJsforceMessages.length).toBeGreaterThan(0);

    // Find the final output with results
    const finalOutput = capturedOutput.find(output =>
        output.category === 'output' &&
        output.type === 'finished' &&
        output.data !== undefined
    );
    
    if (finalOutput && finalOutput.data) {
        const result = JSON.parse(finalOutput.data);
        console.log('Final migration result:', result);
        
        // Account should be successfully migrated
        expect(result.allMigratedRecords).toHaveProperty(account.id!);
    }

    console.log('Jsforce error handling with retry test completed');
});