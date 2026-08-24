import { DescribeSObjectResult, Field, Schema, SObjectRecord } from 'jsforce';
import { SalesforceClient, DefaultSalesforceClient, AuthConfig } from './salesforce-client';
import * as fs from 'fs';
import * as path from 'path';
import { scanForCircularDependency } from './circular';
import Chunks from './chunks';
import IOEvent from './ioevent';
import IO from './io';
import { preprocessData } from './preprocess-data';
import { readRecordsFromSqlite, writeRecordsToSqlite } from './sqlite-store';
import { DescribeGlobalResult } from 'jsforce/lib/api/soap/schema';

interface Options {
    sourceOrg?: string;
    sourceFile?: string;
    sourceSqlite?: string;
    targetOrg: string;
    sourceOrgUrl?: string;
    sourceOrgToken?: string;
    targetOrgUrl?: string;
    targetOrgToken?: string;
    targetFile?: string;
    targetSqlite?: string;
    historyFilePath?: string;
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
    solvers: SolverType[];
    fullAuto?: {
        enabled: boolean;
        unhandledErrorBehavior: 'skip' | 'saveAndExit';
    };
    anonymization?: {
        emailFields?: {
            mode: 'obfuscate' | 'sanitize';
            template?: string;
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
    fromFields?: boolean;
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

type SolverType = FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver | RetrySolver | BackoffSolver | FallbackSolver;

interface SaveError {
    message: string;
    fields: string[];
}

interface SaveResult {
    id: string;
    success: boolean;
    errors: SaveError[];
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

class MigrationRunner {
    private options: Options;
    private io: IO;
    private chunking: Chunks;
    private clientFactory?: ClientFactory;

    private sourceClient: SalesforceClient | null = null;
    private targetClient: SalesforceClient | null = null;
    private isMigrateToFile: boolean;
    private isMigrateFromFile: boolean;

    private historyFilePath: string = '';
    private describeFromFile: any | null = null;
    private describeGlobal: DescribeGlobalResult | null = null;
    private sObjectDescribes = { cache: {} as Record<string, Promise<DescribeSObjectResult>> };

    private recordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    private fetchedRecordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    private lookupFieldsBySObjectType: Record<string, Field[]> = {};
    private old2new: Record<string, string> = {};
    private errors: Record<string, { message: string, fixed: boolean, solver?: SolverType }[]> = {};
    private migratedRecords: Record<string, string> = {};
    private recordAddedReasons: Record<string, string> = {};
    private toUpdateLater: Record<string, SObjectRecord<Schema, string>> = {};
    /** Fetched records dropped by removeAlreadyMigratedRecords, counted per SObject type. */
    private alreadyMigratedCountsBySObjectType: Record<string, number> = {};

    constructor(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>, clientFactory?: ClientFactory) {
        this.options = options;
        this.io = new IO(onOutput, onInput);
        this.chunking = new Chunks(CHUNKING_OBJECTS, 200, 10);
        this.clientFactory = clientFactory;
        if (options.sourceFile !== undefined && options.sourceSqlite !== undefined) {
            throw new Error('Specify either sourceFile or sourceSqlite, not both');
        }
        if (options.targetFile !== undefined && options.targetSqlite !== undefined) {
            throw new Error('Specify either targetFile or targetSqlite, not both');
        }
        this.isMigrateToFile = options.targetFile !== undefined || options.targetSqlite !== undefined;
        this.isMigrateFromFile = options.sourceFile !== undefined || options.sourceSqlite !== undefined;
    }

    async run(): Promise<void> {
        this.io.startingMigration(this.options);

        await this.initializeClients();
        this.initializeHistory();
        await this.validateMatchers();

        let recordIdsToFetch = this.options.recordIds;
        if (this.isMigrateFromFile) {
            await this.loadRecordsFromFile();
            recordIdsToFetch = [];
        }

        await this.fetchRecords(recordIdsToFetch);
        this.removeAlreadyMigratedRecords();
        this.applyPreprocessing();

        this.io.fetchedRecords(Object.keys(this.recordsByIds).length);

        // With nothing left to migrate there is nothing to confirm - say why and
        // carry on to the reporting the run would have produced anyway.
        const nothingToMigrate = Object.keys(this.recordsByIds).length === 0;
        if (nothingToMigrate) {
            this.io.nothingToMigrate({ ...this.alreadyMigratedCountsBySObjectType });
        } else if (!this.options.fullAuto?.enabled) {
            const confirmed = await this.confirmMigration();
            if (!confirmed) {
                this.io.aborted();
                return;
            }
        }

        if (!this.isMigrateToFile) {
            const completed = await this.migrateToOrg();
            if (!completed) {
                return;
            }
            await this.updateClearedFields();
            await this.saveAndExit();
        } else {
            this.migrateToFile();
        }
    }

    private async initializeClients(): Promise<void> {
        const clientPromises: Promise<SalesforceClient>[] = [];
        if (!this.isMigrateFromFile) {
            clientPromises.push(this.createSalesforceClient(this.options.sourceOrg, this.options.sourceOrgUrl, this.options.sourceOrgToken, 'source'));
        }
        if (!this.isMigrateToFile) {
            clientPromises.push(this.createSalesforceClient(this.options.targetOrg, this.options.targetOrgUrl, this.options.targetOrgToken, 'target'));
        }
        const clients = await Promise.all(clientPromises);
        this.sourceClient = this.isMigrateFromFile ? (clients.length > 0 ? clients[0] : null) : clients[0];
        this.targetClient = this.isMigrateToFile ? this.sourceClient : (this.isMigrateFromFile ? clients[0] : clients[1]);

        if (!this.targetClient) {
            throw new Error('No target client available');
        }
    }

    private initializeHistory(): void {
        if (this.options.historyFilePath) {
            const stats = fs.existsSync(this.options.historyFilePath) ? fs.statSync(this.options.historyFilePath) : null;
            if ((stats && stats.isDirectory()) || (!stats && this.options.historyFilePath.endsWith(path.sep))) {
                this.historyFilePath = path.join(this.options.historyFilePath, `${this.options.targetOrg}__history.json`);
            } else {
                this.historyFilePath = this.options.historyFilePath;
            }
        } else {
            this.historyFilePath = path.join(process.cwd(), `${this.options.targetOrg}__history.json`);
        }
        let history: Record<string, string> = {};
        if (!this.isMigrateToFile && fs.existsSync(this.historyFilePath)) {
            history = JSON.parse(fs.readFileSync(this.historyFilePath, 'utf8'));
        }
        for (const recordId of Object.keys(history)) {
            this.old2new[recordId] = history[recordId];
        }
    }

    private async validateMatchers(): Promise<void> {
        this.io.checkingMatchers();
        const matcherSObjectTypes = [...new Set(this.options.matchers.map(m => m.sObjectType))];
        await Promise.all(matcherSObjectTypes.map(sObjectType => this.getSObjectDescribe(sObjectType)));

        for (const matcher of this.options.matchers) {
            const sobjectDescribe = await this.getSObjectDescribe(matcher.sObjectType);
            for (const fieldMapping of matcher.fieldMappings) {
                if (!sobjectDescribe.fields.some(field => field.name === fieldMapping.sourceField)) {
                    throw new Error(`Field ${fieldMapping.sourceField} not found in SObject ${matcher.sObjectType}`);
                }
            }
        }
    }

    private async loadRecordsFromFile(): Promise<void> {
        const loadedRecords = this.options.sourceSqlite !== undefined
            ? readRecordsFromSqlite(this.options.sourceSqlite)
            : JSON.parse(fs.readFileSync(this.options.sourceFile!, 'utf8')).records;
        this.describeFromFile = {
            sobjects: []
        };

        for (const recordId of Object.keys(loadedRecords)) {
            const record = loadedRecords[recordId];
            if (!this.describeFromFile.sobjects.find((sobject: any) => sobject.name === record.attributes.type)) {
                this.describeFromFile.sobjects.push({
                    keyPrefix: recordId.substring(0, 3),
                    name: record.attributes.type
                });
            }
            this.fetchedRecordsByIds[recordId] = record;

            const sObjectName = await this.getSObjectType(recordId, record);
            const creatableFields = (await this.getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
            const recordForMigration: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                recordForMigration[field.name] = record[field.name];
            }
            recordForMigration.attributes = record.attributes || { type: sObjectName, url: '' };
            this.recordsByIds[recordId] = recordForMigration;
        }
    }

    private async fetchRecords(recordIdsToFetch: string[]): Promise<void> {
        let depth = 0;
        while (recordIdsToFetch.length > 0) {
            depth++;
            this.io.recordsSoFar(Object.keys(this.recordsByIds).length);

            const fetchFunctions = recordIdsToFetch.map(recordId => () => this.fetchRecordAndDiscoverIds(recordId, depth));

            const maxConcurrency = this.options.maxConcurrentRequests || 10;
            const rawResults = await executeConcurrently(fetchFunctions, maxConcurrency);

            const newIdsArrays: string[][] = [];
            for (let i = 0; i < rawResults.length; i++) {
                const result = rawResults[i];
                if (result instanceof Error) {
                    this.io.error(`Error fetching record ${recordIdsToFetch[i]}: ${result.message}`);
                    newIdsArrays.push([]);
                } else {
                    newIdsArrays.push(result);
                }
            }

            let newRecordIdsToFetch = newIdsArrays.flat().filter((id): id is string => id !== undefined);
            newRecordIdsToFetch = newRecordIdsToFetch.filter(id => !(id in this.fetchedRecordsByIds));
            recordIdsToFetch = [...new Set(newRecordIdsToFetch)];
        }
    }

    private async fetchRecordAndDiscoverIds(recordId: string, depth: number): Promise<string[]> {
        const sObjectName = await this.getSObjectType(recordId);
        const sobjectDescribe = await this.getSObjectDescribe(sObjectName);
        const reason = this.recordAddedReasons[recordId];
        this.io.fetchingRecord(recordId, sObjectName, reason);
        const recordFields = await this.retrieveRecord(recordId, sObjectName);
        if (!recordFields) {
            return [];
        }
        this.fetchedRecordsByIds[recordId] = recordFields;
        const creatableFields = (await this.getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
        const record: SObjectRecord<Schema, string> = {};
        for (const field of creatableFields) {
            record[field.name] = recordFields[field.name];
        }
        record.attributes = recordFields.attributes;
        this.recordsByIds[recordId] = record;
        this.io.recordsSoFar(Object.keys(this.recordsByIds).length);
        const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
        if (lookupFields.length > 0) {
            this.lookupFieldsBySObjectType[sObjectName] = lookupFields;
        }
        const newIds = await this.discoverReferencedIds(recordId, record, creatableFields);
        await this.collectRelatedRecordIds(recordId, sObjectName, depth, newIds);
        return newIds;
    }

    private async retrieveRecord(recordId: string, sObjectName: string): Promise<any | null> {
        try {
            return await this.sourceClient!.retrieve(sObjectName, recordId);
        } catch (error) {
            if (error.errorCode === 'NOT_FOUND' || error.message?.includes('resource does not exist')) {
                this.io.recordNotFound(recordId, sObjectName);
                return null;
            } else if (error.errorCode === 'INVALID_TYPE_FOR_OPERATION') {
                this.io.recordNotQueryable(recordId, sObjectName);
                this.old2new[recordId] = '';
                return null;
            } else if (error.errorCode === 'MALFORMED_ID') {
                this.io.malformedId(recordId, sObjectName);
                this.old2new[recordId] = recordId;
                return null;
            } else {
                throw error;
            }
        }
    }

    private async discoverReferencedIds(recordId: string, record: SObjectRecord<Schema, string>, creatableFields: Field[]): Promise<string[]> {
        const newIds: string[] = [];
        for (const field of creatableFields) {
            if (record[field.name]) {
                const matches = String(record[field.name])?.match(ID_REGEX);
                if (matches) {
                    for (const match of matches) {
                        if (!(match in this.recordsByIds) && !newIds.includes(match)) {
                            try {
                                await this.getSObjectType(match);
                                newIds.push(match);
                                if (recordId in this.recordAddedReasons) {
                                    this.recordAddedReasons[match] = this.recordAddedReasons[recordId];
                                }
                            } catch {
                                // do nothing, it was some random string
                            }
                        }
                    }
                }
            }
        }
        return newIds;
    }

    private async collectRelatedRecordIds(recordId: string, sObjectName: string, depth: number, newIds: string[]): Promise<void> {
        const relationships = this.options.relationships?.[sObjectName];
        if (!relationships || (this.options.relatedRecordDepthLimit && depth >= this.options.relatedRecordDepthLimit)) {
            return;
        }
        const selector = this.sourceClient!.select(sObjectName);
        for (const relationship of relationships) {
            selector.include(relationship.name).select('Id').end();
        }
        selector.where(`Id = '${recordId}'`);
        this.io.queryingForRelatedRecords(await selector.toSOQL());
        let relsResults: any[] = [];

        try {
            relsResults = await selector.execute();
        } catch (jsforceError) {
            try {
                const errorResult = await this.handleJsforceError(
                    jsforceError,
                    `query related records for ${recordId}`,
                    () => selector.execute()
                );

                if (errorResult.success && errorResult.result) {
                    relsResults = errorResult.result;
                } else if (errorResult.shouldSkip) {
                    this.io.error(`Skipping related records query for ${recordId} due to jsforce error: ${jsforceError.message}`);
                    relsResults = [];
                } else {
                    throw jsforceError;
                }
            } catch {
                this.io.error(`Unhandled jsforce error in related records query: ${jsforceError.message}`);
                relsResults = [];
            }
        }
        const recordRelationships = relsResults[0];
        for (const relationship of relationships) {
            const relatedRecords = recordRelationships![relationship.name]?.records;
            this.io.relatedRecords(relationship.name, relatedRecords?.length);
            if (relatedRecords) {
                for (const relatedRecord of relatedRecords) {
                    if (!(relatedRecord.Id in this.recordsByIds) && !newIds.includes(relatedRecord.Id!)) {
                        newIds.push(relatedRecord.Id!);
                        this.recordAddedReasons[relatedRecord.Id!] = this.recordAddedReasons[recordId] || `${sObjectName}.${relationship.name}`;
                    }
                }
            }
        }
    }

    private removeAlreadyMigratedRecords(): void {
        for (const recordId of Object.keys(this.old2new)) {
            if (recordId in this.recordsByIds) {
                const sObjectType = this.recordsByIds[recordId].attributes?.type;
                if (sObjectType) {
                    this.alreadyMigratedCountsBySObjectType[sObjectType] = (this.alreadyMigratedCountsBySObjectType[sObjectType] || 0) + 1;
                }
                delete this.recordsByIds[recordId];
            }
        }
    }

    private applyPreprocessing(): void {
        if (this.options.anonymization?.emailFields?.mode) {
            preprocessData(this.recordsByIds, {
                emailAnonymization: {
                    mode: this.options.anonymization.emailFields.mode,
                    template: this.options.anonymization.emailFields.template
                }
            });
        }
    }

    private async confirmMigration(): Promise<boolean> {
        const matchersBySObjectType: Record<string, { whenMissing: string }> = {};
        for (const matcher of this.options.matchers) {
            matchersBySObjectType[matcher.sObjectType] = { whenMissing: matcher.whenMissing };
        }

        const recordCountsBySObjectType: Record<string, number> = {};
        for (const record of Object.values(this.recordsByIds)) {
            if (!(record.attributes!.type in recordCountsBySObjectType)) {
                recordCountsBySObjectType[record.attributes!.type] = 0;
            }
            recordCountsBySObjectType[record.attributes!.type]++;
        }

        const source = this.options.sourceSqlite ?? this.options.sourceFile ?? this.options.sourceOrgUrl ?? this.options.sourceOrg;
        const target = this.options.targetSqlite ?? this.options.targetFile ?? this.options.targetOrgUrl ?? this.options.targetOrg;
        const alreadyMigrated = { ...this.alreadyMigratedCountsBySObjectType };
        const confirmationData = { source, target, recordReasons: await this.countRecordReasons(), matchers: matchersBySObjectType, alreadyMigrated, ...recordCountsBySObjectType };
        const confirmation = await this.io.askForConfirmation(confirmationData);
        return confirmation === 'y';
    }

    private async migrateToOrg(): Promise<boolean> {
        while (Object.keys(this.recordsByIds).length > 0) {
            this.io.remainingRecords(Object.keys(this.recordsByIds).length);
            const { toInsert, anyRecordProcessed } = await this.collectRecordsReadyToInsert();
            let recordProcessed = anyRecordProcessed;
            if (Object.keys(toInsert).length > 0) {
                const { exit, solverAdded } = await this.insertRecords(toInsert);
                if (exit) {
                    return false;
                }
                recordProcessed = recordProcessed || solverAdded;
            }
            if (!recordProcessed) {
                await this.resolveCircularDependencies();
            }
        }
        return true;
    }

    private async collectRecordsReadyToInsert(): Promise<{ toInsert: Record<string, SObjectRecord<Schema, string>>, anyRecordProcessed: boolean }> {
        let anyRecordProcessed = false;
        const toInsert: Record<string, SObjectRecord<Schema, string>> = {};
        for (const recordId of Object.keys(this.recordsByIds)) {
            const record = this.recordsByIds[recordId];
            const sObjectName = await this.getSObjectType(recordId, record);
            const recordReady = await this.resolveRecordReferences(recordId, record);
            if (recordReady) {
                anyRecordProcessed = true;
                const { migratedRecordId, skipRecord } = await this.findExistingRecordId(recordId, sObjectName);
                const isObjectCreatable = (await this.getSObjectDescribe(sObjectName)).createable;
                if (!migratedRecordId && !skipRecord && isObjectCreatable) {
                    toInsert[recordId] = {
                        attributes: record.attributes,
                        ...record
                    } as SObjectRecord<Schema, string>;
                } else {
                    this.setNewRecordId(recordId, migratedRecordId!);
                }
            }
        }
        return { toInsert, anyRecordProcessed };
    }

    private async resolveRecordReferences(recordId: string, record: SObjectRecord<Schema, string>): Promise<boolean> {
        let recordReady = true;
        for (const field of Object.keys(record)) {
            if (record[field]) {
                const matches = String(record[field])?.match(ID_REGEX);
                if (matches) {
                    for (const match of matches) {
                        try {
                            await this.getSObjectType(match);
                        } catch {
                            // do nothing, it was some random string
                            continue;
                        }
                        if (!(match in this.old2new) && match in this.recordsByIds && match !== recordId) {
                            recordReady = false;
                        } else if (match in this.old2new) {
                            record[field] = record[field].replace(match, this.old2new[match]);
                            if (record[field] === '') {
                                delete record[field];
                            }
                        }
                    }
                }
            }
        }
        return recordReady;
    }

    private async findExistingRecordId(recordId: string, sObjectName: string): Promise<{ migratedRecordId: string, skipRecord: boolean }> {
        const matcher = this.options.matchers.find(matcher => matcher.sObjectType === sObjectName);
        if (!matcher) {
            return { migratedRecordId: '', skipRecord: false };
        }
        const conditions: Record<string, string> = {};
        for (const fieldMapping of matcher.fieldMappings) {
            conditions[fieldMapping.targetField] = this.fetchedRecordsByIds[recordId][fieldMapping.sourceField];
            if (conditions[fieldMapping.targetField] in this.old2new) {
                conditions[fieldMapping.targetField] = this.old2new[conditions[fieldMapping.targetField]];
            }
        }
        const selector = this.targetClient!.find(sObjectName, conditions).select('Id');
        this.io.queryingForExistingRecord('SELECT Id FROM ' + sObjectName + ' WHERE ' + Object.entries(conditions).map(([k, v]) => `${k} = '${v}'`).join(' AND '));
        let migratedRecord: any[] = [];

        try {
            migratedRecord = await selector.execute();
        } catch (jsforceError) {
            try {
                const errorResult = await this.handleJsforceError(
                    jsforceError,
                    `find existing record for ${sObjectName}`,
                    () => selector.execute()
                );

                if (errorResult.success && errorResult.result) {
                    migratedRecord = errorResult.result;
                } else if (errorResult.shouldSkip) {
                    this.io.error(`Skipping existing record search for ${recordId} due to jsforce error: ${jsforceError.message}`);
                    migratedRecord = [];
                } else {
                    throw jsforceError;
                }
            } catch {
                this.io.error(`Unhandled jsforce error in find operation: ${jsforceError.message}`);
                migratedRecord = [];
            }
        }
        if (migratedRecord.length > 0) {
            const migratedRecordId = migratedRecord[0].Id!;
            this.io.foundExistingRecord(migratedRecordId, sObjectName);
            return { migratedRecordId, skipRecord: false };
        }
        if (matcher.whenMissing === 'skip') {
            this.io.skippingRecord(recordId, sObjectName);
            return { migratedRecordId: '', skipRecord: true };
        }
        return { migratedRecordId: '', skipRecord: false };
    }

    private async insertRecords(toInsert: Record<string, SObjectRecord<Schema, string>>): Promise<{ exit: boolean, solverAdded: boolean }> {
        const chunks: Record<string, SObjectRecord<Schema, string>>[] = this.chunking.getChunks(toInsert);
        let retryAll = false;
        let solverAdded = false;
        for (const chunk of chunks) {
            this.io.savingRecords(chunk);
            const savedRecords = await this.insertChunk(chunk);
            for (let i = 0; i < savedRecords.length; i++) {
                const recordId = Object.keys(chunk)[i];
                const record = this.recordsByIds[recordId];
                const result = await this.processSaveResult(recordId, record, savedRecords[i], retryAll);
                if (result.exit) {
                    return { exit: true, solverAdded };
                }
                retryAll = result.retryAll;
                solverAdded = solverAdded || result.solverAdded;
            }
        }
        return { exit: false, solverAdded };
    }

    private async insertChunk(chunk: Record<string, SObjectRecord<Schema, string>>): Promise<SaveResult[]> {
        let savedRecords: SaveResult[];

        try {
            savedRecords = await this.targetClient!.bulkCreate(Object.values(chunk));
            this.io.savedRecords(savedRecords);
        } catch (jsforceError) {
            try {
                const errorResult = await this.handleJsforceError(
                    jsforceError,
                    `bulkCreate for chunk with ${Object.keys(chunk).length} records`,
                    () => this.targetClient!.bulkCreate(Object.values(chunk))
                );

                if (errorResult.success && errorResult.result) {
                    savedRecords = errorResult.result;
                    this.io.savedRecords(savedRecords);
                } else if (errorResult.shouldSkip) {
                    savedRecords = Object.keys(chunk).map(() => ({
                        id: '',
                        success: false,
                        errors: [{ message: `Skipped due to jsforce error: ${jsforceError.message}`, fields: [] }]
                    }));
                    this.io.error(`Skipping chunk due to jsforce error: ${jsforceError.message}`);
                } else {
                    throw jsforceError;
                }
            } catch {
                savedRecords = Object.keys(chunk).map(() => ({
                    id: '',
                    success: false,
                    errors: [{ message: `Jsforce error: ${jsforceError.message}`, fields: [] }]
                }));
                this.io.error(`Unhandled jsforce error in bulkCreate: ${jsforceError.message}`);
            }
        }
        return savedRecords;
    }

    private async processSaveResult(recordId: string, record: SObjectRecord<Schema, string>, savedRecord: SaveResult, retryAll: boolean): Promise<{ exit: boolean, retryAll: boolean, solverAdded: boolean }> {
        let retryRecord = retryAll;
        let solverAdded = false;
        let migratedRecordId = '';
        if (savedRecord.success) {
            migratedRecordId = savedRecord.id!;
            this.io.createdRecord(migratedRecordId);
            if (this.errors[recordId]) {
                this.errors[recordId].forEach(error => error.fixed = true);
            }
        } else if (!retryRecord) {
            const errs = savedRecord.errors;
            let hiddenErrorCount = 0;
            for (const e of errs) {
                const outcome = await this.handleSaveError(recordId, record, e);
                if (outcome.exit) {
                    return { exit: true, retryAll, solverAdded };
                }
                retryRecord = retryRecord || outcome.retry;
                retryAll = retryAll || outcome.retryAll;
                if (outcome.matchedId !== undefined) {
                    migratedRecordId = outcome.matchedId;
                }
                if (outcome.hidden) {
                    hiddenErrorCount++;
                }
                if (outcome.solverAdded) {
                    solverAdded = true;
                    break;
                }
            }
            if (errs.length > 0 && hiddenErrorCount === errs.length) {
                this.io.hidingError(recordId);
            }
        }
        if (!retryRecord) {
            this.setNewRecordId(recordId, migratedRecordId!);
        }
        return { exit: false, retryAll, solverAdded };
    }

    private async handleSaveError(recordId: string, record: SObjectRecord<Schema, string>, e: SaveError): Promise<{ retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean, hidden: boolean }> {
        const applied = this.applySolver(recordId, record, e);
        let solver = applied.solver;
        let errorFixed = applied.errorFixed;
        let retry = applied.retry;
        let retryAll = false;
        let matchedId = applied.matchedId;

        if (!errorFixed) {
            // A hideError solver keeps the error out of the output entirely, so it
            // must not be reported here either - only the record's own resolution is.
            if (!applied.solver?.hideError) {
                this.io.error(JSON.stringify(e));
            }
            if (!this.options.fullAuto?.enabled) {
                const resolution = await this.handleErrorInteractively(recordId, record, e);
                if (resolution.exit) {
                    return { retry, retryAll, matchedId, solverAdded: false, exit: true, hidden: false };
                }
                if (resolution.solver) {
                    solver = resolution.solver;
                }
                errorFixed = resolution.errorFixed;
                retry = retry || resolution.retry;
                retryAll = resolution.retryAll;
                if (resolution.matchedId !== undefined) {
                    matchedId = resolution.matchedId;
                }
                if (resolution.solverAdded) {
                    return { retry: true, retryAll, matchedId, solverAdded: true, exit: false, hidden: false };
                }
            } else if (this.options.fullAuto?.unhandledErrorBehavior === 'saveAndExit') {
                await this.saveAndExit();
                return { retry, retryAll, matchedId, solverAdded: false, exit: true, hidden: false };
            }
            // fullAuto with 'skip' behavior: fall through and record the error
        }
        if (solver?.hideError) {
            return { retry, retryAll, matchedId, solverAdded: false, exit: false, hidden: true };
        }
        if (!(recordId in this.errors)) {
            this.errors[recordId] = [];
        }
        this.errors[recordId].push({ message: e.message, fixed: errorFixed, solver });
        return { retry, retryAll, matchedId, solverAdded: false, exit: false, hidden: false };
    }

    private applySolver(recordId: string, record: SObjectRecord<Schema, string>, e: SaveError): { solver?: SolverType, errorFixed: boolean, retry: boolean, matchedId?: string } {
        const result: { solver?: SolverType, errorFixed: boolean, retry: boolean, matchedId?: string } = { errorFixed: false, retry: false };
        if (!this.options.solvers) {
            return result;
        }
        const usedSolvers = this.errors[recordId]?.filter(error => error.message === e.message).map(error => error.solver);
        if (usedSolvers?.length > 0) {
            this.io.skippingPreviouslyUsedSolvers(usedSolvers);
        }
        const solver = this.options.solvers.find(solver => new RegExp(solver.message).test(e.message) && !usedSolvers?.includes(solver));
        if (!solver) {
            return result;
        }
        result.solver = solver;
        if (solver.action === 'fix') {
            for (const changeField of solver.changeFields) {
                this.setFieldWithLaterUpdate(recordId, record, changeField.field, changeField.value);
            }
            this.io.fixingUsingSolver(e.message, solver.message, solver.action);
            this.io.savedOldFieldsInToUpdateLater(this.toUpdateLater[recordId]);
            result.errorFixed = true;
            result.retry = true;
        } else if (solver.action === 'skip') {
            this.io.skippingRecordUsingSolver(recordId, solver.message);
            result.errorFixed = true;
        } else if (solver.action === 'match') {
            const matchId = new RegExp(solver.message).exec(e.message)?.[1];
            if (matchId) {
                // Only report the match once it actually produced an id - a solver
                // whose pattern captures nothing leaves the error unresolved.
                this.io.matchingRecordUsingSolver(recordId, solver.message);
                result.matchedId = matchId;
                result.errorFixed = true;
            }
        } else if (solver.action === 'extract_column') {
            this.io.extractingColumnFromError(e.message, solver.message);
            let columnName;
            if (solver.fromFields) {
                columnName = e.fields[0];
            } else {
                columnName = new RegExp(solver.message).exec(e.message)?.[1];
            }
            if (columnName) {
                this.setFieldWithLaterUpdate(recordId, record, columnName, solver.replaceWith);
                result.errorFixed = true;
                result.retry = true;
            }
        } else if (solver.action === 'append_random') {
            this.io.appendingRandomToRecord(recordId, solver.message);
            for (const changeField of solver.changeFields) {
                record[changeField.field] = record[changeField.field] + '.' + Math.random().toString(36).substring(2, 2 + changeField.length);
            }
            result.errorFixed = true;
            result.retry = true;
        }
        return result;
    }

    private async handleErrorInteractively(recordId: string, record: SObjectRecord<Schema, string>, e: SaveError): Promise<{ solver?: SolverType, errorFixed: boolean, retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean }> {
        const result: { solver?: SolverType, errorFixed: boolean, retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean } = { errorFixed: false, retry: false, retryAll: false, solverAdded: false, exit: false };
        let inputOk;
        do {
            inputOk = true;
            const userInput = await this.io.askForInput(recordId, e.message, e);
            if (userInput === USER_INPUTS.fix) {
                let fieldsToUpdate;
                while (!fieldsToUpdate) {
                    const fieldsJson = await this.io.askForFieldsToUpdate();
                    try {
                        fieldsToUpdate = JSON.parse(fieldsJson);
                    } catch {
                        this.io.invalidJson();
                    }
                }
                const solver: FixSolver = {
                    action: 'fix',
                    message: e.message,
                    changeFields: []
                };
                for (const field of Object.keys(fieldsToUpdate)) {
                    this.setFieldWithLaterUpdate(recordId, record, field, fieldsToUpdate[field]);
                    solver.changeFields.push({ field, value: fieldsToUpdate[field] });
                }
                result.solver = solver;
                result.retry = true;
                result.errorFixed = true;
            } else if (userInput === USER_INPUTS.retry) {
                result.retry = true;
            } else if (userInput === USER_INPUTS.retryAll) {
                result.retryAll = true;
                result.retry = true;
            } else if (userInput === USER_INPUTS.match) {
                result.matchedId = await this.io.askForMatch();
            } else if (userInput === USER_INPUTS.saveAndExit) {
                await this.saveAndExit();
                result.exit = true;
            } else if (userInput === USER_INPUTS.addSolver) {
                let newSolver;
                while (!newSolver) {
                    const solverJson = await this.io.askForSolver();
                    try {
                        newSolver = JSON.parse(solverJson);
                        new RegExp(newSolver.message);
                    } catch {
                        newSolver = null;
                        this.io.invalidJson();
                    }
                }
                if (!this.options.solvers) {
                    this.options.solvers = [];
                }
                this.options.solvers.push(newSolver);
                result.solverAdded = true;
                result.retry = true;
            } else if (userInput === USER_INPUTS.skip) {
                // skip record, don't do anything
            } else {
                this.io.invalidInput(userInput);
                inputOk = false;
            }
        } while (!inputOk);
        return result;
    }

    private async resolveCircularDependencies(): Promise<void> {
        const requiredLookupFieldsBySObjectType: Record<string, string[]> = {};
        const allLookupFieldsBySObjectType: Record<string, string[]> = {};
        const uniqueSObjectTypes = [...new Set(Object.values(this.recordsByIds).map(record => record.attributes!.type))];
        const describePromises: Promise<void>[] = [];
        for (const sObjectName of uniqueSObjectTypes) {
            describePromises.push((async () => {
                requiredLookupFieldsBySObjectType[sObjectName] = (await this.getSObjectDescribe(sObjectName)).fields
                    .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                    .map(field => field.name);
                allLookupFieldsBySObjectType[sObjectName] = (await this.getSObjectDescribe(sObjectName)).fields
                    .filter(field => field.type === 'reference' && field.createable)
                    .map(field => field.name);
            })());
        }
        await Promise.all(describePromises);
        const records = Object.values(this.recordsByIds).map(record => ({
            attributes: record.attributes,
            ...Object.fromEntries(Object.entries(record)),
            Id: Object.keys(this.recordsByIds).find(key => this.recordsByIds[key] === record)
        }));
        this.io.lookingForCircularDependencies(requiredLookupFieldsBySObjectType, records);
        const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
        if (toClear.length > 0) {
            this.io.foundCircularDependency(toClear);
            for (const clear of toClear) {
                this.setFieldWithLaterUpdate(clear.recordId, this.recordsByIds[clear.recordId], clear.field, '');
            }
        } else {
            throw new Error('Cannot find record ready to migrate. Circular dependency?');
        }
    }

    private async updateClearedFields(): Promise<void> {
        const recordsToUpdate: Record<string, any> = {};
        for (const recordId of Object.keys(this.toUpdateLater)) {
            const record = this.toUpdateLater[recordId];
            for (const field of Object.keys(record)) {
                if (field !== 'attributes') {
                    const value = String(record[field]);
                    const matches = value.match(ID_REGEX);
                    if (matches) {
                        for (const match of matches) {
                            if (match in this.old2new) {
                                record[field] = value.replace(match, this.old2new[match]);
                            }
                        }
                    }
                }
            }
            record.Id = this.old2new[recordId];
            if (!record.Id) {
                this.io.recordNoId(recordId);
                continue;
            }
            recordsToUpdate[recordId] = record;
        }

        if (Object.keys(recordsToUpdate).length > 0) {
            const chunks: Record<string, any>[] = this.chunking.getChunks(recordsToUpdate);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                this.io.updatingRecord(chunk);
                try {
                    const updateResults = await this.targetClient!.bulkUpdate(Object.values(chunk));
                    for (let j = 0; j < updateResults.length; j++) {
                        const recordId = Object.keys(chunk)[j];
                        const result = updateResults[j];
                        if (!result.success) {
                            this.io.errorUpdatingRecord(recordId, recordsToUpdate[recordId].attributes!.type, { message: result.errors.map(e => e.message).join(', ') });
                        }
                    }
                } catch (jsforceError) {
                    try {
                        const errorResult = await this.handleJsforceError(
                            jsforceError,
                            `bulk update ${Object.keys(chunk).length} records`,
                            () => this.targetClient!.bulkUpdate(Object.values(chunk))
                        );

                        if (!errorResult.success && !errorResult.shouldSkip) {
                            for (const recordId of Object.keys(chunk)) {
                                this.io.errorUpdatingRecord(recordId, recordsToUpdate[recordId].attributes!.type, jsforceError);
                            }
                        } else if (errorResult.shouldSkip) {
                            this.io.error(`Skipping bulk update for ${Object.keys(chunk).length} records due to jsforce error: ${jsforceError.message}`);
                        }
                    } catch {
                        for (const recordId of Object.keys(chunk)) {
                            this.io.errorUpdatingRecord(recordId, recordsToUpdate[recordId].attributes!.type, jsforceError);
                        }
                    }
                }
            }
        }
    }

    private async migrateToFile(): Promise<void> {
        const recordsObj: Record<string, any> = {};
        for (const [id, record] of Object.entries(this.recordsByIds)) {
            recordsObj[id] = {
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(record)),
                Id: id
            };
        }
        if (this.options.targetSqlite !== undefined) {
            writeRecordsToSqlite(this.options.targetSqlite, recordsObj);
        } else {
            const fileData = {
                records: recordsObj
            };
            fs.writeFileSync(this.options.targetFile!, JSON.stringify(fileData, null, 2));
        }

        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of this.options.recordIds) {
            requestedRecordsMappings[originalRecordId] = originalRecordId;
        }

        const outputData = {
            allMigratedRecords: recordsObj,
            errors: {},
            requestedRecords: requestedRecordsMappings,
            recordReasons: await this.countRecordReasons()
        };
        this.io.finished(JSON.stringify(outputData));
    }

    // --- Helper methods ---

    private async createSalesforceClient(orgAlias: string | undefined, orgUrl: string | undefined, orgToken: string | undefined, orgType: 'source' | 'target'): Promise<SalesforceClient> {
        if (this.clientFactory) {
            try {
                if (orgType === 'source') {
                    return await this.clientFactory.createSourceClient(orgAlias, orgUrl, orgToken);
                } else {
                    return await this.clientFactory.createTargetClient(orgAlias, orgUrl, orgToken);
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
    }

    private async getDescribeGlobal(): Promise<any> {
        if (this.isMigrateFromFile) {
            return this.describeFromFile;
        }
        if (!this.describeGlobal) {
            this.describeGlobal = await this.sourceClient!.describeGlobal();
        }
        return this.describeGlobal;
    }

    private async getSObjectDescribe(sObjectName: string): Promise<DescribeSObjectResult> {
        if (!(sObjectName in this.sObjectDescribes.cache)) {
            this.io.describeSObject(sObjectName);
            this.sObjectDescribes.cache[sObjectName] = this.targetClient!.describeSObject(sObjectName);
        }
        try {
            return await this.sObjectDescribes.cache[sObjectName];
        } catch (ex) {
            console.log('error fetching ' + sObjectName + ' SObject describe');
            throw ex;
        }
    }

    private async getSObjectType(recordId: string, record?: any): Promise<string> {
        if (record && record.attributes && record.attributes.type) {
            return record.attributes.type;
        }
        const describeGlobal = await this.getDescribeGlobal();
        if (describeGlobal) {
            const prefix = recordId.substring(0, 3);
            const sobject = describeGlobal.sobjects.find((sobject: any) => sobject.keyPrefix === prefix);
            if (!sobject) {
                throw new Error(`SObject with prefix ${prefix} not found`);
            }
            return sobject.name;
        }
        throw new Error('Unable to determine SObject type');
    }

    private async handleJsforceError(error: any, context: string, retryOperation?: () => Promise<any>): Promise<{ success: boolean, result?: any, shouldSkip?: boolean }> {
        const errorMessage = error.message || error.toString();

        const solver = this.options.solvers?.find(solver => new RegExp(solver.message).test(errorMessage));

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
                        this.io.error(`Retrying ${context} (attempt ${attempt}/${maxAttempts})`);
                        const result = await retryOperation!();
                        return { success: true, result };
                    } catch {
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
                        this.io.error(`Retrying ${context} with backoff (attempt ${attempt}/${maxAttempts}, delay: ${delay}ms)`);
                        const result = await retryOperation!();
                        return { success: true, result };
                    } catch {
                        if (attempt === maxAttempts) {
                            return { success: false };
                        }
                    }
                }
            } else if (solver.action === 'fallback') {
                const fallbackSolver = solver as FallbackSolver;
                this.io.error(`Fallback action for ${context}: ${fallbackSolver.fallbackAction}`);
                if (fallbackSolver.fallbackAction === 'skip') {
                    return { success: false, shouldSkip: true };
                } else if (fallbackSolver.fallbackAction === 'log_and_continue') {
                    this.io.error(`Continuing despite error in ${context}: ${errorMessage}`);
                    return { success: false, shouldSkip: false };
                }
            }
        }

        throw error;
    }

    private saveHistoryFile(): void {
        if (!this.isMigrateToFile) {
            fs.writeFileSync(this.historyFilePath, JSON.stringify(this.old2new, null, 2));
        }
    }

    private async saveAndExit(): Promise<void> {
        this.saveHistoryFile();

        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of this.options.recordIds) {
            requestedRecordsMappings[originalRecordId] = this.old2new[originalRecordId] || '';
        }

        const outputData = {
            allMigratedRecords: this.old2new,
            errors: this.errors,
            recordReasons: await this.countRecordReasons(),
            requestedRecords: requestedRecordsMappings
        };
        this.io.finished(JSON.stringify(outputData));
    }

    private setNewRecordId(recordId: string, newRecordId: string): void {
        this.old2new[recordId] = newRecordId;
        delete this.recordsByIds[recordId];
        delete this.fetchedRecordsByIds[recordId];
        this.migratedRecords[recordId] = newRecordId;
        this.saveHistoryFile();
        // Every record leaves the queue through here - created, matched, skipped
        // or given up on - so this is the one place the remaining count is exact.
        this.io.recordSettled(Object.keys(this.recordsByIds).length);
    }

    private setFieldWithLaterUpdate(recordId: string, record: SObjectRecord<Schema, string>, field: string, value: string | null): void {
        if (value === null) {
            delete record[field];
        } else {
            if (!(recordId in this.toUpdateLater)) {
                this.toUpdateLater[recordId] = {
                    attributes: record.attributes
                } as SObjectRecord<Schema, string>;
            }
            this.toUpdateLater[recordId][field] = record[field];
            record[field] = value;
        }
    }

    private async countRecordReasons(): Promise<Record<string, Record<string, number>>> {
        const recordReasons: Record<string, Record<string, number>> = {};
        for (const recordId in this.recordAddedReasons) {
            const reason = this.recordAddedReasons[recordId];
            const sObjectType = await this.getSObjectType(recordId);

            if (!recordReasons[reason]) {
                recordReasons[reason] = {};
            }
            recordReasons[reason][sObjectType] = (recordReasons[reason][sObjectType] || 0) + 1;
        }
        return recordReasons;
    }
}

async function main(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>, clientFactory?: ClientFactory) {
    const runner = new MigrationRunner(options, onOutput, onInput, clientFactory);
    await runner.run();
}

export { main, Options, IOEvent };
