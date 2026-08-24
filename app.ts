import { Field, Schema, SObjectRecord } from 'jsforce';
import { SalesforceClient, DefaultSalesforceClient, AuthConfig, SaveError, SaveResult } from './salesforce-client';
import * as fs from 'fs';
import { scanForCircularDependency } from './circular';
import Chunks from './chunks';
import IOEvent from './ioevent';
import IO from './io';
import { preprocessData } from './preprocess-data';
import { readRecordsFromSqlite, writeRecordsToSqlite } from './sqlite-store';
import { FixSolver, Options, SolverType } from './config';
import DescribeCache from './describe-cache';
import MigrationHistory from './history';
import { applySolver, handleJsforceError as solveJsforceError } from './solvers';

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

    /** Both are set up by the first two steps of run() and used by everything after. */
    private describes!: DescribeCache;
    private history!: MigrationHistory;

    private recordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    private fetchedRecordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    private lookupFieldsBySObjectType: Record<string, Field[]> = {};
    private errors: Record<string, { message: string, fixed: boolean, solver?: SolverType }[]> = {};
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
        this.history = new MigrationHistory(this.options, this.isMigrateToFile);
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

        this.describes = new DescribeCache(this.io, this.sourceClient, this.targetClient, this.isMigrateFromFile);
    }

    private async validateMatchers(): Promise<void> {
        this.io.checkingMatchers();
        const matcherSObjectTypes = [...new Set(this.options.matchers.map(m => m.sObjectType))];
        await Promise.all(matcherSObjectTypes.map(sObjectType => this.describes.getSObject(sObjectType)));

        for (const matcher of this.options.matchers) {
            const sobjectDescribe = await this.describes.getSObject(matcher.sObjectType);
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
        // Stands in for the source org's global describe. It is handed over before
        // the loop rather than after it because getSObjectType reads it as the loop
        // fills it in - each record's own type is enough to place the ones after it.
        const describeFromFile: { sobjects: any[] } = { sobjects: [] };
        this.describes.setFileDescribe(describeFromFile);

        for (const recordId of Object.keys(loadedRecords)) {
            const record = loadedRecords[recordId];
            if (!describeFromFile.sobjects.find((sobject: any) => sobject.name === record.attributes.type)) {
                describeFromFile.sobjects.push({
                    keyPrefix: recordId.substring(0, 3),
                    name: record.attributes.type
                });
            }
            this.fetchedRecordsByIds[recordId] = record;

            const sObjectName = await this.describes.getSObjectType(recordId, record);
            const creatableFields = (await this.describes.getSObject(sObjectName)).fields.filter(field => field.createable);
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
        const sObjectName = await this.describes.getSObjectType(recordId);
        const sobjectDescribe = await this.describes.getSObject(sObjectName);
        const reason = this.recordAddedReasons[recordId];
        this.io.fetchingRecord(recordId, sObjectName, reason);
        const recordFields = await this.retrieveRecord(recordId, sObjectName);
        if (!recordFields) {
            return [];
        }
        this.fetchedRecordsByIds[recordId] = recordFields;
        const creatableFields = (await this.describes.getSObject(sObjectName)).fields.filter(field => field.createable);
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
                this.history.remember(recordId, '');
                return null;
            } else if (error.errorCode === 'MALFORMED_ID') {
                this.io.malformedId(recordId, sObjectName);
                this.history.remember(recordId, recordId);
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
                                await this.describes.getSObjectType(match);
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
        for (const recordId of this.history.ids()) {
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
            const strategy = {
                emailAnonymization: {
                    mode: this.options.anonymization.emailFields.mode,
                    template: this.options.anonymization.emailFields.template
                }
            };
            preprocessData(this.recordsByIds, strategy);
            if (this.isMigrateToFile) {
                // The export carries the fetched record, not just its creatable
                // fields, so the fields only that map holds have to be anonymized
                // too. Both maps hold the raw value once and the transformers are
                // deterministic, so the fields they share end up identical - which
                // is why this runs per map rather than over the merged export,
                // where an already obfuscated address would be obfuscated again.
                preprocessData(this.fetchedRecordsByIds, strategy);
            }
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
            const sObjectName = await this.describes.getSObjectType(recordId, record);
            const recordReady = await this.resolveRecordReferences(recordId, record);
            if (recordReady) {
                anyRecordProcessed = true;
                const { migratedRecordId, skipRecord } = await this.findExistingRecordId(recordId, sObjectName);
                const isObjectCreatable = (await this.describes.getSObject(sObjectName)).createable;
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
                            await this.describes.getSObjectType(match);
                        } catch {
                            // do nothing, it was some random string
                            continue;
                        }
                        if (!this.history.has(match) && match in this.recordsByIds && match !== recordId) {
                            recordReady = false;
                        } else if (this.history.has(match)) {
                            record[field] = record[field].replace(match, this.history.get(match));
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
        const fetchedRecord = this.fetchedRecordsByIds[recordId];
        const conditions: Record<string, string> = {};
        const missingFields: string[] = [];
        for (const fieldMapping of matcher.fieldMappings) {
            // A field the source does not carry at all would be dropped from the
            // WHERE clause by jsforce rather than rejected, and a matcher whose
            // every field is dropped queries the whole SObject and adopts the first
            // record it finds. Refuse instead. A null value is fine - that is a
            // real condition, and what an exported empty field comes back as.
            if (!fetchedRecord || !(fieldMapping.sourceField in fetchedRecord) || fetchedRecord[fieldMapping.sourceField] === undefined) {
                missingFields.push(fieldMapping.sourceField);
                continue;
            }
            conditions[fieldMapping.targetField] = fetchedRecord[fieldMapping.sourceField];
            if (this.history.has(conditions[fieldMapping.targetField])) {
                conditions[fieldMapping.targetField] = this.history.get(conditions[fieldMapping.targetField]);
            }
        }
        if (missingFields.length > 0) {
            throw new Error(
                `Record ${recordId} (${sObjectName}) has no value for matcher field${missingFields.length > 1 ? 's' : ''} ${missingFields.join(', ')}, `
                + 'so it cannot be matched against the target org. Fields that cannot be inserted (formula fields, Name on User, '
                + 'DeveloperName on RecordType) were left out of exports made before this was fixed - re-export the source, '
                + 'or add the missing column to it.'
            );
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
        const applied = applySolver(recordId, record, e, {
            io: this.io,
            solvers: this.options.solvers,
            usedSolvers: this.errors[recordId]?.filter(error => error.message === e.message).map(error => error.solver) ?? [],
            setField: (field, value) => this.setFieldWithLaterUpdate(recordId, record, field, value),
            stashedFields: () => this.toUpdateLater[recordId],
        });
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
                requiredLookupFieldsBySObjectType[sObjectName] = (await this.describes.getSObject(sObjectName)).fields
                    .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                    .map(field => field.name);
                allLookupFieldsBySObjectType[sObjectName] = (await this.describes.getSObject(sObjectName)).fields
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
                            if (this.history.has(match)) {
                                record[field] = value.replace(match, this.history.get(match));
                            }
                        }
                    }
                }
            }
            record.Id = this.history.get(recordId);
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
            // Export the whole fetched record, not just the fields that can be
            // inserted: matchers read their source fields off the fetched record
            // (findExistingRecordId), and plenty of them - Name on User, formula
            // fields, DeveloperName on RecordType - are not creatable, so leaving
            // them out makes the export unusable as a source. The creatable filter
            // is applied on the way back in, by loadRecordsFromFile.
            const fetchedRecord = this.fetchedRecordsByIds[id] ?? {};
            recordsObj[id] = {
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(fetchedRecord)),
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

    private async handleJsforceError(error: any, context: string, retryOperation?: () => Promise<any>): Promise<{ success: boolean, result?: any, shouldSkip?: boolean }> {
        return solveJsforceError(error, context, this.io, this.options.solvers, retryOperation);
    }

    private async saveAndExit(): Promise<void> {
        this.history.save();

        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of this.options.recordIds) {
            requestedRecordsMappings[originalRecordId] = this.history.get(originalRecordId) || '';
        }

        const outputData = {
            allMigratedRecords: this.history.all(),
            errors: this.errors,
            recordReasons: await this.countRecordReasons(),
            requestedRecords: requestedRecordsMappings
        };
        this.io.finished(JSON.stringify(outputData));
    }

    private setNewRecordId(recordId: string, newRecordId: string): void {
        this.history.settle(recordId, newRecordId);
        delete this.recordsByIds[recordId];
        delete this.fetchedRecordsByIds[recordId];
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
            const sObjectType = await this.describes.getSObjectType(recordId);

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

export { main };
