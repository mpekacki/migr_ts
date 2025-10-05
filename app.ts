console.log('importing dependencies');
import { DescribeSObjectResult, Field, Schema, SObjectRecord } from 'jsforce';
import { SalesforceClient, DefaultSalesforceClient, AuthConfig } from './salesforce-client';
import * as fs from 'fs';
import * as path from 'path';
import { scanForCircularDependency } from './circular';
import Chunks from './chunks';
import IOEvent from './ioevent';
import IO from './io';
import { preprocessData } from './preprocess-data';
import { DescribeGlobalResult } from 'jsforce/lib/api/soap/schema';
console.log('importing dependencies done');

interface Options {
    sourceOrg?: string;
    sourceFile?: string;
    targetOrg: string;
    sourceOrgUrl?: string;
    sourceOrgToken?: string;
    targetOrgUrl?: string;
    targetOrgToken?: string;
    targetFile?: string;
    recordIds: string[];
    relatedRecordDepthLimit: number;
    maxConcurrentRequests?: number;
    matchers: {
        sObjectType: string;
        fieldMappings: {
            sourceField: string;
            targetField: string;
        }[];
        whenMissing: 'skip' | 'create';
    }[];
    relationships: {
        [sObjectType: string]: {
            name: string;
        }[];
    };
    solvers: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver | RetrySolver | BackoffSolver | FallbackSolver)[];
    fullAuto?: {
        enabled: boolean;
        unhandledErrorBehavior: 'skip' | 'saveAndExit';
    };
    anonymization?: {
        emailFields?: {
            anonymize: boolean;
        };
    };
}

interface Solver {
    message: string;
    hideError?: boolean;
}

interface FixSolver extends Solver {
    action: 'fix';
    changeFields: {
        field: string;
        value: string;
    }[];
}

interface SkipSolver extends Solver {
    action: 'skip';
}

interface MatchSolver extends Solver {
    action: 'match';
}

interface ExtractSolver extends Solver {
    action: 'extract_column';
    replaceWith: string | null;
}

interface AppendRandomSolver extends Solver {
    action: 'append_random';
    changeFields: {
        field: string;
        length: number;
    }[];
}

interface RetrySolver extends Solver {
    action: 'retry';
    maxAttempts?: number;
    delay?: number; // milliseconds
}

interface BackoffSolver extends Solver {
    action: 'backoff';
    maxAttempts?: number;
    initialDelay?: number; // milliseconds
    backoffMultiplier?: number;
}

interface FallbackSolver extends Solver {
    action: 'fallback';
    fallbackAction: 'skip' | 'log_and_continue';
}

export interface ClientFactory {
    createSourceClient(orgAlias: string | undefined, orgUrl: string | undefined, orgToken: string | undefined): Promise<SalesforceClient>;
    createTargetClient(orgAlias: string | undefined, orgUrl: string | undefined, orgToken: string | undefined): Promise<SalesforceClient>;
}

const ID_REGEX = /[a-zA-Z0-9]{18}/g;
const USER_INPUTS = {
    fix: 'f',
    retry: 'r',
    retryAll: 'ra',
    match: 'm',
    saveAndExit: 'h',
    addSolver: 'a',
    skip: 's',
};
const CHUNKING_OBJECTS = ['User', 'UserRole', 'PermissionSetAssignment', 'BusinessHours'];

// Utility function to limit concurrent promise execution
async function executeConcurrently<T>(
    promises: (() => Promise<T>)[],
    maxConcurrency: number
): Promise<T[]> {
    const results: T[] = new Array(promises.length);
    const executing: Promise<void>[] = [];
    let index = 0;

    const executeNext = async (): Promise<void> => {
        const currentIndex = index++;
        if (currentIndex >= promises.length) return;

        try {
            results[currentIndex] = await promises[currentIndex]();
        } catch (error) {
            // Store the error in the results array to maintain order
            results[currentIndex] = error as T;
        }

        // Continue with the next promise
        await executeNext();
    };

    // Start initial batch of promises
    for (let i = 0; i < Math.min(maxConcurrency, promises.length); i++) {
        executing.push(executeNext());
    }

    // Wait for all promises to complete
    await Promise.all(executing);

    return results;
}

async function main(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>, clientFactory?: ClientFactory) {
    const io = new IO(onOutput, onInput);
    const chunking = new Chunks(CHUNKING_OBJECTS, 200, 10);

    io.startingMigration(options);

    // Helper function to handle jsforce errors with solvers
    const handleJsforceError = async (error: any, context: string, retryOperation?: () => Promise<any>): Promise<{ success: boolean, result?: any, shouldSkip?: boolean }> => {
        const errorMessage = error.message || error.toString();
        
        // Find applicable solver
        const solver = options.solvers?.find(solver => new RegExp(solver.message).test(errorMessage));
        
        if (solver) {
            if (solver.action === 'retry') {
                const retrySolver = solver as RetrySolver;
                const maxAttempts = retrySolver.maxAttempts || 3;
                const delay = retrySolver.delay || 1000;
                
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        if (delay > 0) {
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                        io.error(`Retrying ${context} (attempt ${attempt}/${maxAttempts})`);
                        const result = await retryOperation!();
                        return { success: true, result };
                    } catch (retryError) {
                        if (attempt === maxAttempts) {
                            return { success: false };
                        }
                    }
                }
            } else if (solver.action === 'backoff') {
                const backoffSolver = solver as BackoffSolver;
                const maxAttempts = backoffSolver.maxAttempts || 3;
                const initialDelay = backoffSolver.initialDelay || 1000;
                const multiplier = backoffSolver.backoffMultiplier || 2;
                
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        const delay = initialDelay * Math.pow(multiplier, attempt - 1);
                        if (delay > 0) {
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                        io.error(`Retrying ${context} with backoff (attempt ${attempt}/${maxAttempts}, delay: ${delay}ms)`);
                        const result = await retryOperation!();
                        return { success: true, result };
                    } catch (retryError) {
                        if (attempt === maxAttempts) {
                            return { success: false };
                        }
                    }
                }
            } else if (solver.action === 'fallback') {
                const fallbackSolver = solver as FallbackSolver;
                io.error(`Fallback action for ${context}: ${fallbackSolver.fallbackAction}`);
                if (fallbackSolver.fallbackAction === 'skip') {
                    return { success: false, shouldSkip: true };
                } else if (fallbackSolver.fallbackAction === 'log_and_continue') {
                    io.error(`Continuing despite error in ${context}: ${errorMessage}`);
                    return { success: false, shouldSkip: false };
                }
            }
        }
        
        // No solver found or solver didn't handle the error
        throw error;
    };

    const createSalesforceClient = async (orgAlias: string | undefined, orgUrl: string | undefined, orgToken: string | undefined, orgType: 'source' | 'target'): Promise<SalesforceClient> => {
        if (clientFactory) {
            try {
                if (orgType === 'source') {
                    return await clientFactory.createSourceClient(orgAlias, orgUrl, orgToken);
                } else {
                    return await clientFactory.createTargetClient(orgAlias, orgUrl, orgToken);
                }
            } catch (error) {
                throw new Error(`${orgType.charAt(0).toUpperCase() + orgType.slice(1)} org authentication failed: ${error.message}`);
            }
        } else {
            const authConfig: AuthConfig = {
                orgAlias,
                orgUrl,
                orgToken
            };
            try {
                return await DefaultSalesforceClient.createFromAuth(authConfig);
            } catch (error) {
                throw new Error(`${orgType.charAt(0).toUpperCase() + orgType.slice(1)} org authentication failed: ${error.message}`);
            }
        }
    };

    const isMigrateToFile = options.targetFile !== undefined;
    const isMigrateFromFile = options.sourceFile !== undefined;

    const clientPromises: Promise<SalesforceClient>[] = [];
    if (!isMigrateFromFile) {
        clientPromises.push(createSalesforceClient(options.sourceOrg, options.sourceOrgUrl, options.sourceOrgToken, 'source'));
    }
    if (!isMigrateToFile) {
        clientPromises.push(createSalesforceClient(options.targetOrg, options.targetOrgUrl, options.targetOrgToken, 'target'));
    }
    const clients = await Promise.all(clientPromises);
    const sourceClient = isMigrateFromFile ? (clients.length > 0 ? clients[0] : null) : clients[0];
    const targetClient = isMigrateToFile ? sourceClient : (isMigrateFromFile ? clients[0] : clients[1]);
    
    // Ensure we have at least one client for target operations
    if (!targetClient) {
        throw new Error('No target client available');
    }

    // check if history file exists for target org
    const historyFilePath = path.join(process.cwd(), `${options.targetOrg}__history.json`);
    let history: Record<string, string> = {};
    if (!isMigrateToFile && fs.existsSync(historyFilePath)) {
        history = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
    }

    let describeFromFile: DescribeGlobalResult | null = null;
    const getDescribeGlobal = async () => {
        if (isMigrateFromFile) {
            return describeFromFile;
        }
        return await sourceClient!.describeGlobal();
    }
    const sObjectDescribes = { cache: {} as Record<string, Promise<DescribeSObjectResult>> };
    const getSObjectDescribe = async (sObjectName: string): Promise<DescribeSObjectResult> => {
        if (!(sObjectName in sObjectDescribes.cache)) {
            io.describeSObject(sObjectName);
            sObjectDescribes.cache[sObjectName] = targetClient!.describeSObject(sObjectName);
        }
        return await sObjectDescribes.cache[sObjectName];
    };
    const getSObjectType = async (recordId: string, record?: any): Promise<string> => {
        if (record && record.attributes && record.attributes.type) {
            return record.attributes.type;
        }
        const describeGlobal = await getDescribeGlobal();
        if (describeGlobal) {
            const prefix = recordId.substring(0, 3);
            const sobject = describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix);
            if (!sobject) {
                throw new Error(`SObject with prefix ${prefix} not found`);
            }
            return sobject.name;
        }
        throw new Error('Unable to determine SObject type');
    };

    // check if all matchers are valid
    io.checkingMatchers();
    // Get all unique SObject types from matchers to describe them in bulk
    const matcherSObjectTypes = [...new Set(options.matchers.map(m => m.sObjectType))];
    
    // Describe all matcher SObjects in parallel
    await Promise.all(matcherSObjectTypes.map(sObjectType => getSObjectDescribe(sObjectType)));
    
    // Now validate field mappings
    for (const matcher of options.matchers) {
        const sobjectDescribe = await getSObjectDescribe(matcher.sObjectType);
        for (const fieldMapping of matcher.fieldMappings) {
            if (!sobjectDescribe.fields.some(field => field.name === fieldMapping.sourceField)) {
                throw new Error(`Field ${fieldMapping.sourceField} not found in SObject ${matcher.sObjectType}`);
            }
        }
    }

    let recordIdsToFetch = options.recordIds;
    const recordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    const fetchedRecordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    const lookupFieldsBySObjectType: Record<string, Field[]> = {};
    const old2new: Record<string, string> = {};
    const errors: Record<string, { message: string, fixed: boolean, solver?: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver | RetrySolver | BackoffSolver | FallbackSolver) }[]> = {};
    const migratedRecords: Record<string, string> = {};
    const recordAddedReasons: Record<string, string> = {}; // Track why each record was added
    
    // Load records from file if sourceFile is provided
    if (isMigrateFromFile) {
        const fileContent = fs.readFileSync(options.sourceFile!, 'utf8');
        const parsedFile = JSON.parse(fileContent);
        describeFromFile = parsedFile.describeGlobal;
        
        for (const recordId of Object.keys(parsedFile.records)) {
            const record = parsedFile.records[recordId];
            fetchedRecordsByIds[recordId] = record;
            
            // Create record for migration (filter out non-creatable fields if needed)
            const sObjectName = await getSObjectType(recordId, record);
            const creatableFields = (await getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
            const recordForMigration: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                recordForMigration[field.name] = record[field.name];
            }
            recordForMigration.attributes = record.attributes || { type: sObjectName, url: '' };
            recordsByIds[recordId] = recordForMigration;
        }
        recordIdsToFetch = []; // No need to fetch from org when reading from file
    }
    
    const setNewRecordId = (recordId: string, newRecordId: string) => {
        old2new[recordId] = newRecordId;
        delete recordsByIds[recordId];
        delete fetchedRecordsByIds[recordId];
        migratedRecords[recordId] = newRecordId;
        saveHistoryFile();
    }
    
    for (const recordId of Object.keys(history)) {
        old2new[recordId] = history[recordId];
    }

    let depth = 0;
    while (recordIdsToFetch.length > 0) {
        console.log('depth', depth);
        depth++;
        io.recordsSoFar(Object.keys(recordsByIds).length);
        // Create fetch functions for each record (wrapped to control concurrency)
        const fetchFunctions = recordIdsToFetch.map(recordId => async (): Promise<string[]> => {
            const sObjectName = await getSObjectType(recordId);
            const sobjectDescribe = await getSObjectDescribe(sObjectName);
            const reason = recordAddedReasons[recordId];
            io.fetchingRecord(recordId, sObjectName, reason);
            let recordFields;
            try {
                recordFields = await sourceClient!.retrieve(sObjectName, recordId);
            } catch (error) {
                if (error.errorCode === 'NOT_FOUND' || error.message?.includes('resource does not exist')) {
                    io.recordNotFound(recordId, sObjectName);
                    return [];
                } else if (error.errorCode === 'INVALID_TYPE_FOR_OPERATION') {
                    io.recordNotQueryable(recordId, sObjectName);
                    old2new[recordId] = '';
                    return [];
                } else if (error.errorCode === 'MALFORMED_ID') {
                    io.malformedId(recordId, sObjectName);
                    old2new[recordId] = recordId;
                    return [];
                } else {
                    throw error;
                }
            }
            fetchedRecordsByIds[recordId] = recordFields;
            const creatableFields = (await getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
            const record: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                record[field.name] = recordFields[field.name];
            }
            record.attributes = recordFields.attributes;
            recordsByIds[recordId] = record;
            const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
            if (lookupFields.length > 0) {
                lookupFieldsBySObjectType[sObjectName] = lookupFields;
            }
            const newIds: string[] = [];
            for (const field of creatableFields) {
                // check if field contains some record Ids
                if (record[field.name]) {
                    const matches = String(record[field.name])?.match(ID_REGEX);
                    if (matches) {
                        for (const match of matches) {
                            if (!(match in recordsByIds) && !newIds.includes(match)) {
                                try {
                                    await getSObjectType(match);
                                    newIds.push(match);
                                    // Propagate the reason if current record was added due to a relationship
                                    if (recordId in recordAddedReasons) {
                                        recordAddedReasons[match] = recordAddedReasons[recordId];
                                    }
                                } catch {
                                    // do nothing, it was some random string
                                }
                            }
                        }
                    }
                }
            }
            const relationships = options.relationships?.[sObjectName];
            if (relationships && (!options.relatedRecordDepthLimit || depth < options.relatedRecordDepthLimit)) {
                const selector = sourceClient!.select(sObjectName);
                for (const relationship of relationships) {
                    selector.include(relationship.name).select('Id').end();
                }
                selector.where(`Id = '${recordId}'`);
                io.queryingForRelatedRecords(await selector.toSOQL());
                let relsResults: any[] = [];

                try {
                    relsResults = await selector.execute();
                } catch (jsforceError) {
                    try {
                        const errorResult = await handleJsforceError(
                            jsforceError,
                            `query related records for ${recordId}`,
                            () => selector.execute()
                        );

                        if (errorResult.success && errorResult.result) {
                            relsResults = errorResult.result;
                        } else if (errorResult.shouldSkip) {
                            io.error(`Skipping related records query for ${recordId} due to jsforce error: ${jsforceError.message}`);
                            relsResults = [];
                        } else {
                            throw jsforceError;
                        }
                    } catch (unhandledError) {
                        io.error(`Unhandled jsforce error in related records query: ${jsforceError.message}`);
                        relsResults = [];
                    }
                }
                const recordRelationships = relsResults[0];
                for (const relationship of relationships) {
                    const relatedRecords = recordRelationships![relationship.name]?.records;
                    io.relatedRecords(relationship.name, relatedRecords?.length);
                    if (relatedRecords) {
                        for (const relatedRecord of relatedRecords) {
                            if (!(relatedRecord.Id in recordsByIds) && !newIds.includes(relatedRecord.Id!)) {
                                newIds.push(relatedRecord.Id!);
                                recordAddedReasons[relatedRecord.Id!] = `${sObjectName}.${relationship.name}`;
                            }
                        }
                    }
                }
            }
            return newIds;
        });

        // Execute fetches with concurrency control
        const maxConcurrency = options.maxConcurrentRequests || 10; // Default to 10 concurrent requests
        const rawResults = await executeConcurrently(fetchFunctions, maxConcurrency);

        // Handle results and errors from concurrent execution
        const newIdsArrays: string[][] = [];
        for (let i = 0; i < rawResults.length; i++) {
            const result = rawResults[i];
            if (result instanceof Error) {
                // Log the error but continue with other records
                io.error(`Error fetching record ${recordIdsToFetch[i]}: ${result.message}`);
                newIdsArrays.push([]); // Add empty array for failed fetch
            } else {
                newIdsArrays.push(result);
            }
        }

        // Flatten array of arrays into single array of new IDs to fetch
        let newRecordIdsToFetch = newIdsArrays.flat().filter((id): id is string => id !== undefined);
        // remove records that are already fetched
        newRecordIdsToFetch = newRecordIdsToFetch.filter(id => !(id in fetchedRecordsByIds));
        recordIdsToFetch = newRecordIdsToFetch;
        // remove duplicates
        recordIdsToFetch = [...new Set(recordIdsToFetch)];
    }

    // remove records that are already migrated
    for (const recordId of Object.keys(old2new)) {
        if (recordId in recordsByIds) {
            delete recordsByIds[recordId];
        }
    }

    io.fetchedRecords(Object.keys(recordsByIds).length);

    // Apply preprocessing (e.g., anonymization)
    if (options.anonymization?.emailFields?.anonymize) {
        preprocessData(recordsByIds, { anonymizeEmailFields: true });
    }

    // Helper function to count record reasons by SObject type
    const countRecordReasons = async (): Promise<Record<string, Record<string, number>>> => {
        const recordReasons: Record<string, Record<string, number>> = {};
        for (const recordId in recordAddedReasons) {
            const reason = recordAddedReasons[recordId];
            const sObjectType = await getSObjectType(recordId);

            if (!recordReasons[reason]) {
                recordReasons[reason] = {};
            }
            recordReasons[reason][sObjectType] = (recordReasons[reason][sObjectType] || 0) + 1;
        }
        return recordReasons;
    }

    // build map of record counts by sobject type
    const recordCountsBySObjectType: Record<string, number> = {};
    for (const record of Object.values(recordsByIds)) {
        if (!(record.attributes!.type in recordCountsBySObjectType)) {
            recordCountsBySObjectType[record.attributes!.type] = 0;
        }
        recordCountsBySObjectType[record.attributes!.type]++;
    }

    if (!options.fullAuto?.enabled) {
        // ask for confirmation
        const confirmationData = { recordReasons: await countRecordReasons(), ...recordCountsBySObjectType };
        const confirmation = await io.askForConfirmation(confirmationData);
        if (confirmation !== 'y') {
            io.aborted();
            return;
        }
    }

    const saveHistoryFile = () => {
        if (!isMigrateToFile) {
            fs.writeFileSync(historyFilePath, JSON.stringify(old2new, null, 2));
        }
    }

    const saveAndExit = async () => {
        saveHistoryFile();

        // Create a summary of original recordIds from config with their new mappings
        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of options.recordIds) {
            requestedRecordsMappings[originalRecordId] = old2new[originalRecordId] || '';
        }

        const outputData = {
            allMigratedRecords: old2new,
            errors,
            recordReasons: await countRecordReasons(),
            requestedRecords: requestedRecordsMappings
        };
        io.finished(JSON.stringify(outputData));
    }

    const toUpdateLater: Record<string, SObjectRecord<Schema, string>> = {};
    const setFieldWithLaterUpdate = (recordId: string, record: SObjectRecord<Schema, string>, field: string, value: string | null) => {
        if (value === null) {
            delete record[field];
        } else {
            if (!(recordId in toUpdateLater)) {
                toUpdateLater[recordId] = {
                    attributes: record.attributes
                } as SObjectRecord<Schema, string>;
            }
            toUpdateLater[recordId][field] = record[field];
            record[field] = value;
        }
    }
    
    if (!isMigrateToFile) {
        while (Object.keys(recordsByIds).length > 0) {
            io.remainingRecords(Object.keys(recordsByIds).length);
            let anyRecordProcessed = false;
            const toInsert: Record<string, SObjectRecord<Schema, string>> = {};
            for (const recordId of Object.keys(recordsByIds)) {
                const record = recordsByIds[recordId];
                const sObjectName = await getSObjectType(recordId, record);
                let recordReady = true;
                for (const field of Object.keys(record)) {
                    if (record[field]) {
                        const matches = String(record[field])?.match(ID_REGEX);
                        if (matches) {
                            for (const match of matches) {
                                try {
                                    await getSObjectType(match);
                                } catch {
                                    // do nothing, it was some random string
                                    continue;
                                }
                                if (!(match in old2new) && match in recordsByIds && match !== recordId) {
                                    recordReady = false;
                                    // output({ category: 'output', message: `record ${recordId} of type ${sObjectName} is not ready because lookup field ${field} (${match}) is not migrated`, type: 'info' });
                                } else if (match in old2new) {
                                    io.mapping(field, match, recordId, sObjectName, old2new[match]);
                                    record[field] = record[field].replace(match, old2new[match]);
                                    if (record[field] === '') {
                                        delete record[field];
                                    }
                                }
                            }
                        }
                    }
                }
                if (recordReady) {
                    anyRecordProcessed = true;
                    // output({ category: 'output', message: `anyRecordProcessed true for record ${recordId} of type ${sObjectName} because record is ready`, type: 'info' });
                    let migratedRecordId = '';
                    let skipRecord = false;
                    const matcher = options.matchers.find(matcher => matcher.sObjectType === sObjectName);
                    if (matcher) {
                        const conditions: Record<string, string> = {};
                        for (const fieldMapping of matcher.fieldMappings) {
                            conditions[fieldMapping.targetField] = fetchedRecordsByIds[recordId][fieldMapping.sourceField];
                            if (conditions[fieldMapping.targetField] in old2new) {
                                conditions[fieldMapping.targetField] = old2new[conditions[fieldMapping.targetField]];
                            }
                        }
                        const selector = targetClient!.find(sObjectName, conditions).select('Id');
                        io.queryingForExistingRecord('SELECT Id FROM ' + sObjectName + ' WHERE ' + Object.entries(conditions).map(([k, v]) => `${k} = '${v}'`).join(' AND '));
                        let migratedRecord: any[] = [];
                        
                        try {
                            migratedRecord = await selector.execute();
                        } catch (jsforceError) {
                            try {
                                const errorResult = await handleJsforceError(
                                    jsforceError,
                                    `find existing record for ${sObjectName}`,
                                    () => selector.execute()
                                );
                                
                                if (errorResult.success && errorResult.result) {
                                    migratedRecord = errorResult.result;
                                } else if (errorResult.shouldSkip) {
                                    io.error(`Skipping existing record search for ${recordId} due to jsforce error: ${jsforceError.message}`);
                                    migratedRecord = [];
                                } else {
                                    throw jsforceError;
                                }
                            } catch (unhandledError) {
                                io.error(`Unhandled jsforce error in find operation: ${jsforceError.message}`);
                                migratedRecord = [];
                            }
                        }
                        if (migratedRecord.length > 0) {
                            migratedRecordId = migratedRecord[0].Id!;
                            io.foundExistingRecord(migratedRecordId, sObjectName);
                        } else if (matcher.whenMissing === 'skip') {
                            io.skippingRecord(recordId, sObjectName);
                            skipRecord = true;
                        }
                    }
                    const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable;
                    if (!migratedRecordId && !skipRecord && isObjectCreatable) {
                        toInsert[recordId] = {
                            attributes: record.attributes,
                                ...record
                            } as SObjectRecord<Schema, string>;
                        io.creatingRecord(recordId, sObjectName, record);
                    } else {
                        setNewRecordId(recordId, migratedRecordId!);
                    }
                }
            }
            if (Object.keys(toInsert).length > 0) {
                const chunks: Record<string, SObjectRecord<Schema, string>>[] = chunking.getChunks(toInsert);
                let retryAll = false;
                for (const chunk of chunks) {
                    io.savingRecords(chunk);
                    let savedRecords: Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>;
                    
                    try {
                        savedRecords = await targetClient!.bulkCreate(Object.values(chunk));
                        io.savedRecords(savedRecords);
                    } catch (jsforceError) {
                        // Handle jsforce connection errors with solvers
                        try {
                            const errorResult = await handleJsforceError(
                                jsforceError, 
                                `bulkCreate for chunk with ${Object.keys(chunk).length} records`,
                                () => targetClient!.bulkCreate(Object.values(chunk))
                            );
                            
                            if (errorResult.success && errorResult.result) {
                                savedRecords = errorResult.result;
                                io.savedRecords(savedRecords);
                            } else if (errorResult.shouldSkip) {
                                // Skip this chunk - mark all records as failed
                                savedRecords = Object.keys(chunk).map(() => ({
                                    id: '',
                                    success: false,
                                    errors: [{ message: `Skipped due to jsforce error: ${jsforceError.message}`, fields: [] }]
                                }));
                                io.error(`Skipping chunk due to jsforce error: ${jsforceError.message}`);
                            } else {
                                // Re-throw if not handled by solver
                                throw jsforceError;
                            }
                        } catch (unhandledError) {
                            // If error handling fails, mark all records in chunk as failed
                            savedRecords = Object.keys(chunk).map(() => ({
                                id: '',
                                success: false,
                                errors: [{ message: `Jsforce error: ${jsforceError.message}`, fields: [] }]
                            }));
                            io.error(`Unhandled jsforce error in bulkCreate: ${jsforceError.message}`);
                        }
                    }
                    for (let i = 0; i < savedRecords.length; i++) {
                        const recordId = Object.keys(chunk)[i];
                        const record = recordsByIds[recordId];
                        const savedRecord = savedRecords[i];
                        let retryRecord = retryAll;
                        let migratedRecordId = '';
                        if (savedRecord.success) {
                            migratedRecordId = savedRecord.id!;
                            io.createdRecord(migratedRecordId);
                            // mark errors as fixed
                            if (errors[recordId]) {
                                errors[recordId].forEach(error => error.fixed = true);
                            }
                        } else if (!retryRecord) {    
                            const errs = savedRecord.errors
                            for (const e of errs) {
                                let errorFixed = false;
                                let solver: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver | RetrySolver | BackoffSolver | FallbackSolver) | undefined;
                                if (options.solvers) {
                                    // get previously used solvers
                                    const usedSolvers = errors[recordId]?.filter(error => error.message === e.message).map(error => error.solver);
                                    if (usedSolvers?.length > 0) {
                                        io.skippingPreviouslyUsedSolvers(usedSolvers);
                                    }
                                    // find solver that matches the error message
                                    solver = options.solvers.find(solver => new RegExp(solver.message).test(e.message) && !usedSolvers?.includes(solver));
                                    if (solver) {
                                        if (solver.action === 'fix') {
                                            for (const changeField of solver.changeFields) {
                                                setFieldWithLaterUpdate(recordId, record, changeField.field, changeField.value);
                                            }
                                            io.fixingUsingSolver(solver.message);
                                            io.savedOldFieldsInToUpdateLater(toUpdateLater[recordId]);
                                            errorFixed = true;
                                            retryRecord = true;
                                        } else if (solver.action === 'skip') {
                                            io.skippingRecordUsingSolver(recordId, solver.message);
                                            errorFixed = true;
                                        } else if (solver.action === 'match') {
                                            io.matchingRecordUsingSolver(recordId, solver.message);
                                            const matchId = new RegExp(solver.message).exec(e.message)?.[1];
                                            if (matchId) {
                                                migratedRecordId = matchId;
                                                errorFixed = true;
                                            }
                                        } else if (solver.action === 'extract_column') {
                                            io.extractingColumnFromError(e.message);
                                            const columnName = new RegExp(solver.message).exec(e.message)?.[1];
                                            if (columnName) {
                                                setFieldWithLaterUpdate(recordId, record, columnName, solver.replaceWith);
                                                errorFixed = true;
                                                retryRecord = true;
                                            }
                                        } else if (solver.action === 'append_random') {
                                            io.appendingRandomToRecord(recordId, solver.message);
                                            for (const changeField of solver.changeFields) {
                                                record[changeField.field] = record[changeField.field] + '.' + Math.random().toString(36).substring(2, 2 + changeField.length);
                                            }
                                            errorFixed = true;
                                            retryRecord = true;
                                        }
                                    }
                                }
                                if (!errorFixed) {
                                    // no solver found, ask user what to do
                                    io.error(JSON.stringify(e));
                                    let inputOk;
                                    let solverAdded = false;
                                    if (!options.fullAuto?.enabled) {
                                        do {
                                            inputOk = true;
                                            const userInput = await io.askForInput(recordId, e.message);
                                            if (userInput === USER_INPUTS.fix) {
                                                let fieldsToUpdate;
                                                while (!fieldsToUpdate) {
                                                    const fieldsJson = await io.askForFieldsToUpdate();
                                                    try {
                                                        fieldsToUpdate = JSON.parse(fieldsJson);
                                                    } catch {
                                                        io.invalidJson();
                                                    }
                                                }
                                                solver = {
                                                    action: 'fix',
                                                    message: e.message,
                                                    changeFields: []
                                                }
                                                for (const field of Object.keys(fieldsToUpdate)) {
                                                    setFieldWithLaterUpdate(recordId, record, field, fieldsToUpdate[field]);
                                                    solver.changeFields.push({ field, value: fieldsToUpdate[field] });
                                                }
                                                retryRecord = true;
                                                errorFixed = true;
                                            } else if (userInput === USER_INPUTS.retry) {
                                                retryRecord = true;
                                            } else if (userInput === USER_INPUTS.retryAll) {
                                                retryAll = true;
                                                retryRecord = true;
                                            } else if (userInput === USER_INPUTS.match) {
                                                migratedRecordId = await io.askForMatch();
                                            } else if (userInput === USER_INPUTS.saveAndExit) {
                                                await saveAndExit();
                                                return;
                                            } else if (userInput === USER_INPUTS.addSolver) {
                                                let newSolver;
                                                while (!newSolver) {
                                                    const solverJson = await io.askForSolver();
                                                    try {
                                                        newSolver = JSON.parse(solverJson);
                                                        new RegExp(newSolver.message);
                                                    } catch {
                                                        newSolver = null;
                                                        io.invalidJson();
                                                    }
                                                }
                                                if (!options.solvers) {
                                                    options.solvers = [];
                                                }
                                                options.solvers.push(newSolver);
                                                anyRecordProcessed = true;
                                                solverAdded = true;
                                                retryRecord = true;
                                            } else if (userInput === USER_INPUTS.skip) {
                                                // skip record, don't do anything
                                            } else {
                                                io.invalidInput(userInput);
                                                inputOk = false;
                                            }
                                        } while (!inputOk);
                                        if (solverAdded) {
                                            break;
                                        }
                                    } else {
                                        if (options.fullAuto?.unhandledErrorBehavior === 'saveAndExit') {
                                            await saveAndExit();
                                            return;
                                        } else {
                                            // skip record, don't do anything
                                        }
                                    }
                                }
                                if (!solver?.hideError) {
                                    if (!(recordId in errors)) {
                                        errors[recordId] = [];
                                    }
                                    errors[recordId].push({ message: e.message, fixed: errorFixed, solver });
                                }
                            }
                        }
                        if (retryRecord) {
                            continue;
                        }
                        setNewRecordId(recordId, migratedRecordId!);
                    }
                }
            }
            if (!anyRecordProcessed) {
                // build lookupFieldsBySObjectType from object describes
                const requiredLookupFieldsBySObjectType: Record<string, string[]> = {};
                const allLookupFieldsBySObjectType: Record<string, string[]> = {};
                const uniqueSObjectTypes = [...new Set(Object.values(recordsByIds).map(record => record.attributes!.type))];
                for (const sObjectName of uniqueSObjectTypes) {
                    requiredLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                        .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                        .map(field => field.name);
                    allLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                        .filter(field => field.type === 'reference' && field.createable)
                        .map(field => field.name);
                }
                const records = Object.values(recordsByIds).map(record => ({
                    attributes: record.attributes,
                    ...Object.fromEntries(Object.entries(record)),
                    Id: Object.keys(recordsByIds).find(key => recordsByIds[key] === record)
                }));
                io.lookingForCircularDependencies(requiredLookupFieldsBySObjectType, records);
                const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
                if (toClear.length > 0) {
                    io.foundCircularDependency(toClear);
                    // clear the fields that are causing the circular dependency
                    for (const clear of toClear) {
                        setFieldWithLaterUpdate(clear.recordId, recordsByIds[clear.recordId], clear.field, '');
                    }
                } else {
                    throw new Error('Cannot find record ready to migrate. Circular dependency?');
                }
            }
        }

        // update the fields that were cleared
        for (const recordId of Object.keys(toUpdateLater)) {
            const record = toUpdateLater[recordId];
            for (const field of Object.keys(record)) {
                if (field !== 'attributes') {
                    const value = String(record[field]);
                    const matches = value.match(ID_REGEX);
                    if (matches) {
                        for (const match of matches) {
                            if (match in old2new) {
                                record[field] = value.replace(match, old2new[match]);
                            }
                        }
                    }
                }
            }
            record.Id = old2new[recordId];
            if (!record.Id) {
                io.recordNoId(recordId);
                continue;
            }
            io.updatingRecord(recordId, record.attributes!.type, record);
            try {
                await targetClient!.update(record.attributes!.type, record);
            } catch (jsforceError) {
                try {
                    const errorResult = await handleJsforceError(
                        jsforceError,
                        `update record ${recordId} of type ${record.attributes!.type}`,
                        () => targetClient!.update(record.attributes!.type, record)
                    );
                    
                    if (!errorResult.success && !errorResult.shouldSkip) {
                        io.errorUpdatingRecord(recordId, record.attributes!.type, jsforceError);
                    } else if (errorResult.shouldSkip) {
                        io.error(`Skipping update for ${recordId} due to jsforce error: ${jsforceError.message}`);
                    }
                } catch (unhandledError) {
                    io.errorUpdatingRecord(recordId, record.attributes!.type, jsforceError);
                }
            }
        }

        await saveAndExit();
    } else {
        // migrate to file
        // Write JSON as key-value pairs: id -> record
        const recordsObj: Record<string, any> = {};
        for (const [id, record] of Object.entries(recordsByIds)) {
            recordsObj[id] = {
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(record)),
                Id: id
            };
        }
        const describeGlobal = await getDescribeGlobal();
        let describeGlobalForFile: any = describeGlobal;
        if (describeGlobal) {
            // remove everything except sobject prefix and name
            describeGlobalForFile = {
                sobjects: describeGlobal.sobjects.map(sobject => ({
                    keyPrefix: sobject.keyPrefix,
                    name: sobject.name
                }))
            };
        }
        const fileData = {
            records: recordsObj,
            describeGlobal: describeGlobalForFile
        };
        fs.writeFileSync(options.targetFile!, JSON.stringify(fileData, null, 2));
        
        // Create a summary for file migration (all records are "as-is" with same IDs)
        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of options.recordIds) {
            requestedRecordsMappings[originalRecordId] = originalRecordId; // Same ID when migrating to file
        }

        const outputData = {
            allMigratedRecords: recordsObj,
            errors: {}, // No errors in file migration typically
            requestedRecords: requestedRecordsMappings,
            recordReasons: await countRecordReasons()
        };
        io.finished(JSON.stringify(outputData));
    }
}

export { main, Options, IOEvent };