import { Field, Schema, SObjectRecord } from 'jsforce';
import { SalesforceClient, DefaultSalesforceClient, AuthConfig, SaveError, SaveResult } from './salesforce-client';
import * as fs from 'fs';
import { breakCircularDependencies, CircularRecord, Dependency } from './circular';
import Chunks, { ChunkEntry, recordSize } from './chunks';
import IOEvent from './ioevent';
import IO, { serializeError, updatedFields } from './io';
import { createPreprocessor } from './preprocess-data';
import { iterateRecordsInSqlite, writeRecordsToSqlite } from './sqlite-store';
import { FixSolver, Options, SolverType, validateFullAutoOptions, validateSolverOptions } from './config';
import DescribeCache from './describe-cache';
import FileTransfer from './files';
import MigrationHistory from './history';
import { applySolver, handleJsforceError as solveJsforceError, SolverPhase } from './solvers';
import ApexScripts, { validateApexOptions } from './apex';
import { OriginKind, PathStep, RecordOrigin, RetrievedRecord, recordLabel, tracePath } from './record-paths';
import { RecordStore, RecordTable, createRecordStore, validateRecordStoreOptions } from './record-store';

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
/**
 * SObjects that travel in chunks of their own, never sharing a composite insert
 * with ordinary records. These are Salesforce's *setup* objects: a single
 * transaction may touch setup objects or non-setup objects but not both, and
 * mixing them earns a MIXED_DML_OPERATION naming the two offenders.
 *
 * The list has to be hardcoded because nothing in the API reports it. A describe
 * carries no setup flag (`customSetting` covers only custom settings), and
 * Tooling's EntityDefinition has none either - "setup object" is not even a
 * property of the SObject: updating a User is allowed alongside an Account until
 * the payload touches a field bearing on record access (UserRoleId, ProfileId,
 * IsActive), which no per-object boolean could express. So this mirrors the list
 * in the Apex Developer Guide, "sObjects That Can't Be Used Together in DML
 * Operations":
 * https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_dml_non_mix_sobjects.htm
 *
 * Names are matched against `attributes.type` exactly, so the casing is the API's
 * and not the guide's - note `QueueSobject`, which the guide writes `QueueSObject`.
 * The territory and forecasting entries only exist in orgs with those features
 * turned on; a name that never turns up costs nothing.
 *
 * BusinessHours is not a setup object and is not in the guide - it is here
 * because it needs isolating for its own reasons.
 */
const CHUNKING_OBJECTS = [
    'AuthSession',
    'ContentWorkspace',
    'FieldPermissions',
    'ForecastingShare',
    'Group',
    'GroupMember',
    'ObjectPermissions',
    'ObjectTerritory2AssignmentRule',
    'ObjectTerritory2AssignmentRuleItem',
    'PermissionSet',
    'PermissionSetAssignment',
    'QueueSobject',
    'RuleTerritory2Association',
    'SetupEntityAccess',
    'Territory',
    'Territory2',
    'Territory2Model',
    'User',
    'UserPackageLicense',
    'UserRole',
    'UserTerritory',
    'UserTerritory2Association',
    'BusinessHours',
];
/**
 * Kept under the 37.5 MB of base64 a non-multipart request body may carry, with
 * room to spare for the rest of the payload. Only records carrying files come
 * anywhere near it.
 */
const MAX_CHUNK_BYTES = 30 * 1024 * 1024;
/**
 * How many times the update pass may send the same record. A solver is used once
 * per record and message, so the passes normally run out well before this - the
 * cap is there for the solver whose error comes back worded differently every
 * time, which would otherwise keep the run going round forever.
 */
const MAX_UPDATE_ATTEMPTS = 10;

/** A record id a fetched record led to, and the field or relationship it led there through. */
interface Discovery {
    id: string;
    kind: OriginKind;
    name: string;
}

/** Whether a value lookup has anything to look for - an empty value names no record. */
function hasValue(value: any): boolean {
    return value !== null && value !== undefined && value !== '';
}

/**
 * The update pass's counterpart to setFieldWithLaterUpdate: there is no later
 * pass to stash the old value for - this is that pass - so a solver's change is
 * simply what the next attempt sends, and a null takes the field out of the
 * payload altogether.
 */
function setUpdateField(record: any, field: string, value: string | null): void {
    if (value === null) {
        delete record[field];
    } else {
        record[field] = value;
    }
}

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

    /** All five are set up by the first steps of run() and used by everything after. */
    private describes!: DescribeCache;
    private files!: FileTransfer;
    private apex!: ApexScripts;
    private history!: MigrationHistory;
    private store!: RecordStore;

    /**
     * The insert queue (creatable fields only) and every fetched record (all
     * fields) - see record-store.ts. Both may live on disk, which is why every
     * change to a record is followed by a `set`: what `get` returned is a copy.
     */
    private get queued(): RecordTable {
        return this.store.queued;
    }
    private get fetched(): RecordTable {
        return this.store.fetched;
    }
    /**
     * The SObject type and label of every fetched record, for the path of each
     * record fetched after it: reading those off the fetched records would mean
     * a disk read (and maybe a file's worth of base64) per ancestor per fetch.
     */
    private summaries = new Map<string, { sObjectType: string, label?: string }>();
    private lookupFieldsBySObjectType: Record<string, Field[]> = {};
    /**
     * Every error the run reports, keyed by source record id. `phase` says which
     * pass it came from: solvers act on both, but only an insert error can also be
     * put to the user, since the update pass is the last thing the run does.
     * `fields` is the payload an update was writing, so the output says what it was
     * trying to set and not just that it failed.
     */
    private errors: Record<string, { message: string, fixed: boolean, solver?: SolverType, phase: 'insert' | 'update', fields?: Record<string, any> }[]> = {};
    /**
     * How each fetched record was reached, keyed by its id - see record-paths.ts.
     * A requested record has none, so following these back always ends at one.
     */
    private origins: Record<string, RecordOrigin> = {};
    private toUpdateLater: Record<string, SObjectRecord<Schema, string>> = {};
    /** Fetched records dropped by removeAlreadyMigratedRecords, counted per SObject type. */
    private alreadyMigratedCountsBySObjectType: Record<string, number> = {};
    /**
     * The fetch wave each record arrived in - the same depth relatedRecordDepthLimit
     * is checked against, 1 being the configured recordIds.
     */
    private fetchDepthsByIds: Record<string, number> = {};
    /** fetchDepthsByIds counted per depth, kept as it fills so progress is cheap to report. */
    private recordCountsByDepth: Record<number, number> = {};

    constructor(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>, clientFactory?: ClientFactory) {
        this.options = options;
        // A prompt can wait indefinitely, and a user who closes the app there has
        // to find every record settled so far in the history file - so the file
        // is brought up to date before the question goes out, not left to the
        // write the history would otherwise make a moment later.
        this.io = new IO(onOutput, question => {
            this.history?.flush();
            return onInput(question);
        });
        this.chunking = new Chunks(CHUNKING_OBJECTS, 200, 10, MAX_CHUNK_BYTES);
        this.clientFactory = clientFactory;
        if (options.sourceFile !== undefined && options.sourceSqlite !== undefined) {
            throw new Error('Specify either sourceFile or sourceSqlite, not both');
        }
        if (options.targetFile !== undefined && options.targetSqlite !== undefined) {
            throw new Error('Specify either targetFile or targetSqlite, not both');
        }
        this.isMigrateToFile = options.targetFile !== undefined || options.targetSqlite !== undefined;
        this.isMigrateFromFile = options.sourceFile !== undefined || options.sourceSqlite !== undefined;
        validateApexOptions(options, this.isMigrateToFile);
        validateFullAutoOptions(options);
        validateSolverOptions(options);
        validateRecordStoreOptions(options);
    }

    async run(): Promise<void> {
        try {
            await this.runMigration();
        } finally {
            // A run that throws has still settled whatever it inserted before it
            // did, and the history file is what keeps a re-run from inserting it
            // again.
            this.history?.flush();
            this.closeRecordStore();
        }
    }

    private openRecordStore(): void {
        this.store = createRecordStore(this.options, this.history.directory, this.options.targetOrg ?? 'export');
        if (this.store.location) {
            this.io.recordStoreOpened(this.store.location, this.store.encrypted, this.store.keep);
        }
    }

    /** However the run ends, a store on disk goes with it unless the config keeps it. */
    private closeRecordStore(): void {
        if (!this.store) {
            return;
        }
        try {
            const deleted = this.store.close();
            if (this.store.location) {
                this.io.recordStoreClosed(this.store.location, deleted);
            }
        } catch (error) {
            // Reported rather than thrown: this runs on the way out of a run that
            // may be failing already, and its error is the one worth seeing.
            this.io.error(`Could not remove record store ${this.store.location}: ${error.message}`);
        }
    }

    private async runMigration(): Promise<void> {
        this.io.startingMigration(this.options);

        await this.initializeClients();
        this.history = new MigrationHistory(this.options, this.isMigrateToFile);
        this.openRecordStore();
        await this.validateMatchers();
        if (!this.isMigrateFromFile) {
            await this.validateValueLookups();
        }

        let recordIdsToFetch = this.options.recordIds;
        if (this.isMigrateFromFile) {
            await this.loadRecordsFromFile();
            recordIdsToFetch = [];
        }

        await this.fetchRecords(recordIdsToFetch);
        this.removeAlreadyMigratedRecords();
        this.applyPreprocessing();

        this.io.fetchedRecords(this.queued.size, this.countRemainingRecordsByDepth());
        this.io.retrievedRecords(this.listRetrievedRecords(), this.isMigrateFromFile);

        // With nothing left to migrate there is nothing to confirm - say why and
        // carry on to the reporting the run would have produced anyway. Two flags
        // open this door: `enabled` answers every prompt of the run, while
        // `skipConfirmation` answers only this one and leaves an unhandled error
        // to the user.
        const nothingToMigrate = this.queued.size === 0;
        if (nothingToMigrate) {
            this.io.nothingToMigrate({ ...this.alreadyMigratedCountsBySObjectType });
        } else if (!(this.options.fullAuto?.enabled || this.options.fullAuto?.skipConfirmation)) {
            const confirmed = await this.confirmMigration();
            if (!confirmed) {
                this.io.aborted();
                return;
            }
        }

        if (!this.isMigrateToFile) {
            // The apex scripts bracket what the run writes to the target org: a run
            // with nothing left to migrate writes nothing, so it runs neither phase.
            // Past this point the run is committed to the target org, which is the
            // whole condition on the before scripts - and on the after scripts,
            // which ApexScripts then runs down every way out, the abandoned run
            // included.
            if (!nothingToMigrate) {
                await this.apex.runBefore();
            }
            const completed = await this.migrateToOrg();
            if (!completed) {
                // Abandoned part way. saveAndExit has already written the report, so
                // all that is left is to undo what the before scripts did.
                await this.apex.runAfter();
                return;
            }
            const updated = await this.updateClearedFields();
            if (!updated) {
                // Abandoned part way through the update pass, the same way the
                // insert pass is abandoned and for the same reason: saveAndExit has
                // written the report, leaving only the before scripts to undo.
                await this.apex.runAfter();
                return;
            }
            await this.runAfterScripts();
        } else {
            // Awaited like every other way out of run(): a write that fails has to
            // reach main()'s error handling rather than escape as an unhandled
            // rejection.
            await this.migrateToFile();
        }
    }

    /**
     * The after scripts, then the run's report. A failing script must not cost the
     * run that report - the migration itself is over and the summary is the only
     * record of how it went - so the summary is written first and the failure let
     * out once it is safely out.
     */
    private async runAfterScripts(): Promise<void> {
        let failure: unknown;
        try {
            await this.apex.runAfter();
        } catch (error) {
            failure = error;
        }
        await this.saveAndExit();
        if (failure) {
            throw failure;
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
        this.files = new FileTransfer(this.io, this.describes, this.options, this.sourceClient, this.targetClient);
        this.apex = new ApexScripts(this.io, this.options, this.targetClient);
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

    /**
     * A misspelled field would otherwise never come up: the record has no value
     * for it, so no query is made and the records it names are quietly left out.
     */
    private async validateValueLookups(): Promise<void> {
        for (const [sObjectType, lookups] of Object.entries(this.options.valueLookups ?? {})) {
            for (const lookup of lookups) {
                const checks = [[sObjectType, lookup.field], [lookup.sObjectType, lookup.matchField]];
                for (const [checkedSObjectType, fieldName] of checks) {
                    const sobjectDescribe = await this.describes.getSObject(checkedSObjectType);
                    if (!sobjectDescribe.fields.some(field => field.name === fieldName)) {
                        throw new Error(`Value lookup field ${fieldName} not found in SObject ${checkedSObjectType}`);
                    }
                }
            }
        }
    }

    /**
     * A SQLite export is read a record at a time, so it never has to fit in
     * memory; a JSON one cannot be parsed in pieces and is read whole.
     */
    private loadedRecords(): Iterable<[string, any]> {
        if (this.options.sourceSqlite !== undefined) {
            return iterateRecordsInSqlite(this.options.sourceSqlite);
        }
        return Object.entries(JSON.parse(fs.readFileSync(this.options.sourceFile!, 'utf8')).records);
    }

    private async loadRecordsFromFile(): Promise<void> {
        // Stands in for the source org's global describe. It is handed over before
        // the loop rather than after it because getSObjectType reads it as the loop
        // fills it in - each record's own type is enough to place the ones after it.
        const describeFromFile: { sobjects: any[] } = { sobjects: [] };
        this.describes.setFileDescribe(describeFromFile);
        const documents: { documentId: string, versionId: string }[] = [];

        for (const [recordId, record] of this.loadedRecords()) {
            if (!describeFromFile.sobjects.find((sobject: any) => sobject.name === record.attributes.type)) {
                describeFromFile.sobjects.push({
                    keyPrefix: recordId.substring(0, 3),
                    name: record.attributes.type
                });
            }
            this.fetched.set(recordId, record);
            this.summaries.set(recordId, { sObjectType: record.attributes.type, label: recordLabel(record) });
            const versionId = this.files.latestVersionOf(record.attributes?.type, record);
            if (versionId) {
                documents.push({ documentId: recordId, versionId });
            }

            const sObjectName = await this.describes.getSObjectType(recordId, record);
            const creatableFields = (await this.describes.getSObject(sObjectName)).fields.filter(field => field.createable);
            const recordForMigration: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                recordForMigration[field.name] = record[field.name];
            }
            recordForMigration.attributes = record.attributes || { type: sObjectName, url: '' };
            // An export carries the fields naming the file's body and document in the
            // source org; the target has to make its own.
            this.files.dropSourceOnlyFields(sObjectName, recordForMigration);
            this.queueRecord(recordId, recordForMigration);
        }

        // Only once every record is loaded, so a document is held back only when the
        // version that releases it actually came along in the export.
        for (const { documentId, versionId } of documents) {
            if (this.queued.has(versionId)) {
                this.files.hold(documentId, versionId);
            }
        }
    }

    /** How many requests fetching and matching each keep in flight at once. */
    private get maxConcurrency(): number {
        return this.options.maxConcurrentRequests || 10;
    }

    private async fetchRecords(recordIdsToFetch: string[]): Promise<void> {
        const requested = new Set(recordIdsToFetch);
        let depth = 0;
        while (recordIdsToFetch.length > 0) {
            depth++;
            this.io.recordsSoFar(this.queued.size, depth, { ...this.recordCountsByDepth });

            const fetchFunctions = recordIdsToFetch.map(recordId => () => this.fetchRecordAndDiscoverIds(recordId, depth));

            const rawResults = await executeConcurrently(fetchFunctions, this.maxConcurrency);

            const newRecordIdsToFetch = new Set<string>();
            for (let i = 0; i < rawResults.length; i++) {
                const result = rawResults[i];
                if (result instanceof Error) {
                    this.io.error(`Error fetching record ${recordIdsToFetch[i]}: ${result.message}`);
                    continue;
                }
                for (const discovery of result) {
                    if (this.fetched.has(discovery.id)) {
                        continue;
                    }
                    // The first record to lead to one is the one its path goes
                    // through. Waves go shallowest first, so that is a shortest path,
                    // and reading the results in the order the wave asked for them -
                    // rather than as the fetches happen to finish - keeps it the same
                    // from one run to the next.
                    if (!(discovery.id in this.origins) && !requested.has(discovery.id)) {
                        this.origins[discovery.id] = { from: recordIdsToFetch[i], kind: discovery.kind, name: discovery.name };
                    }
                    newRecordIdsToFetch.add(discovery.id);
                }
            }
            recordIdsToFetch = [...newRecordIdsToFetch];
        }
    }

    /** The path that led to a record about to be fetched - every record on it before this one already is. */
    private pathTo(recordId: string, sObjectName: string): PathStep[] {
        return tracePath(recordId, id => {
            if (id === recordId) {
                return { sObjectType: sObjectName, origin: this.origins[id] };
            }
            const summary = this.summaries.get(id);
            return summary && { ...summary, origin: this.origins[id] };
        });
    }

    /**
     * Every record the run retrieved, with how it got there. Taken once fetching
     * is over and before anything settles, while the fetched records are all still
     * there - including the ones an earlier run migrated, which are part of the
     * path to the records under them.
     */
    private listRetrievedRecords(): RetrievedRecord[] {
        return [...this.fetched.entries()]
            .map(([id, record]) => this.retrievedRecord(id, record, !this.queued.has(id)));
    }

    private retrievedRecord(id: string, fetchedRecord: SObjectRecord<Schema, string>, alreadyMigrated: boolean): RetrievedRecord {
        const retrieved: RetrievedRecord = { id, sObjectType: fetchedRecord.attributes!.type, label: recordLabel(fetchedRecord) };
        if (this.origins[id]) {
            retrieved.origin = this.origins[id];
        }
        if (alreadyMigrated) {
            retrieved.alreadyMigrated = true;
        }
        return retrieved;
    }

    private async fetchRecordAndDiscoverIds(recordId: string, depth: number): Promise<Discovery[]> {
        const sObjectName = await this.describes.getSObjectType(recordId);
        const sobjectDescribe = await this.describes.getSObject(sObjectName);
        this.io.fetchingRecord(recordId, sObjectName, this.pathTo(recordId, sObjectName));
        const recordFields = await this.retrieveRecord(recordId, sObjectName);
        if (!recordFields) {
            return [];
        }
        // Set now, as the mark that the record has arrived, and again below once
        // the download has filled its files in.
        this.fetched.set(recordId, recordFields);
        this.summaries.set(recordId, { sObjectType: recordFields.attributes!.type, label: recordLabel(recordFields) });
        const creatableFields = (await this.describes.getSObject(sObjectName)).fields.filter(field => field.createable);
        const record: SObjectRecord<Schema, string> = {};
        for (const field of creatableFields) {
            record[field.name] = recordFields[field.name];
        }
        record.attributes = recordFields.attributes;
        // A blob field arrives holding the path of the endpoint serving it, not the
        // file, so the contents are downloaded into both maps before anything else
        // reads the record.
        await this.files.download(recordId, sObjectName, record, recordFields);
        this.fetched.set(recordId, recordFields);
        this.queueRecord(recordId, record);
        // The first wave is not de-duplicated, so a record id listed twice in the
        // config is fetched twice - and must still be counted once.
        if (!(recordId in this.fetchDepthsByIds)) {
            this.fetchDepthsByIds[recordId] = depth;
            this.recordCountsByDepth[depth] = (this.recordCountsByDepth[depth] || 0) + 1;
        }
        // The record itself goes out with the count, so the records view can grow
        // while fetching is still going. Its origin is already settled - the wave
        // before this one assigned it - and the history file was read before the
        // fetch began, so it already says whether an earlier run migrated it.
        this.io.recordsSoFar(this.queued.size, depth, { ...this.recordCountsByDepth },
            this.retrievedRecord(recordId, recordFields, this.history.has(recordId)));
        const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
        if (lookupFields.length > 0) {
            this.lookupFieldsBySObjectType[sObjectName] = lookupFields;
        }
        const found = new Map<string, Discovery>();
        await this.discoverReferencedIds(record, creatableFields, found);
        this.collectFileVersionId(recordId, sObjectName, recordFields, found);
        await this.collectRelatedRecordIds(recordId, sObjectName, depth, found);
        await this.collectValueLookupIds(recordId, sObjectName, depth, recordFields, found);
        return [...found.values()];
    }

    /**
     * A ContentDocument names its current ContentVersion in a field no one can
     * insert, so the id scan never sees it - but that version is the only thing
     * that carries the file, and inserting it is what makes the target create a
     * document to hold it. Queue it, and hold the document until it lands.
     */
    private collectFileVersionId(recordId: string, sObjectName: string, fetchedRecord: any, found: Map<string, Discovery>): void {
        const versionId = this.files.latestVersionOf(sObjectName, fetchedRecord);
        if (!versionId) {
            return;
        }
        this.files.hold(recordId, versionId);
        if (!this.fetched.has(versionId) && !found.has(versionId)) {
            found.set(versionId, { id: versionId, kind: 'lookup', name: 'LatestPublishedVersionId' });
        }
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

    private async discoverReferencedIds(record: SObjectRecord<Schema, string>, creatableFields: Field[], found: Map<string, Discovery>): Promise<void> {
        for (const field of creatableFields) {
            if (field.type === 'base64') {
                // A file's contents are megabytes of base64: scanning them for record
                // ids is pure cost, and any 18 character run in there is a coincidence.
                continue;
            }
            if (record[field.name]) {
                const matches = String(record[field.name])?.match(ID_REGEX);
                if (matches) {
                    for (const match of matches) {
                        if (!this.queued.has(match) && !found.has(match)) {
                            try {
                                await this.describes.getSObjectType(match);
                                found.set(match, { id: match, kind: 'lookup', name: field.name });
                            } catch {
                                // do nothing, it was some random string
                            }
                        }
                    }
                }
            }
        }
    }

    private async collectRelatedRecordIds(recordId: string, sObjectName: string, depth: number, found: Map<string, Discovery>): Promise<void> {
        const relationships = this.options.relationships?.[sObjectName];
        if (!relationships || !this.childrenAllowedAt(depth)) {
            return;
        }
        const selector = this.sourceClient!.select(sObjectName);
        for (const relationship of relationships) {
            selector.include(relationship.name).select('Id').end();
        }
        selector.where(`Id = '${recordId}'`);
        this.io.queryingForRelatedRecords(await selector.toSOQL(), sObjectName, recordId, relationships.map(r => r.name));
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
                    if (!this.queued.has(relatedRecord.Id!) && !found.has(relatedRecord.Id!)) {
                        found.set(relatedRecord.Id!, { id: relatedRecord.Id!, kind: 'child', name: relationship.name });
                    }
                }
            }
        }
    }

    /**
     * The records a field names by a value they share rather than by id - see
     * `valueLookups`. The value is read off the fetched record, so a field that
     * cannot be inserted (a formula, say) can name records too. Like a lookup, and
     * unlike a child relationship, the depth limit does not stop the lookup: it
     * names the records this one goes with. `includeChildren` follows the value
     * back to the records naming this one, which is a fan of children like
     * `relationships`, so that direction does stop at the limit.
     */
    private async collectValueLookupIds(recordId: string, sObjectName: string, depth: number, fetchedRecord: any, found: Map<string, Discovery>): Promise<void> {
        const add = (ids: string[], kind: OriginKind, name: string) => {
            for (const id of ids) {
                if (id !== recordId && !this.queued.has(id) && !found.has(id)) {
                    found.set(id, { id, kind, name });
                }
            }
        };
        for (const lookup of this.options.valueLookups?.[sObjectName] ?? []) {
            const value = fetchedRecord[lookup.field];
            if (hasValue(value)) {
                add(await this.findIdsByValue(lookup.sObjectType, lookup.matchField, value, sObjectName, recordId, 'lookup'), 'lookup', lookup.field);
            }
        }
        if (!this.childrenAllowedAt(depth)) {
            return;
        }
        for (const [childSObjectType, lookups] of Object.entries(this.options.valueLookups ?? {})) {
            for (const lookup of lookups) {
                const value = fetchedRecord[lookup.matchField];
                if (lookup.includeChildren && lookup.sObjectType === sObjectName && hasValue(value)) {
                    add(await this.findIdsByValue(childSObjectType, lookup.field, value, sObjectName, recordId, 'child'), 'child', `${childSObjectType}.${lookup.field}`);
                }
            }
        }
    }

    /** The ids of the source records of `sObjectType` whose `field` holds `value`. */
    private async findIdsByValue(sObjectType: string, field: string, value: any, sObjectName: string, recordId: string, kind: OriginKind): Promise<string[]> {
        const selector = this.sourceClient!.find(sObjectType, { [field]: value }).select('Id');
        this.io.queryingForValueLookup(await selector.toSOQL(), sObjectName, recordId, sObjectType, field, String(value), kind);
        let matches: any[] = [];
        try {
            matches = await selector.execute();
        } catch (jsforceError) {
            try {
                const errorResult = await this.handleJsforceError(
                    jsforceError,
                    `look up ${sObjectType} by ${field} for ${recordId}`,
                    () => selector.execute()
                );
                if (errorResult.success && errorResult.result) {
                    matches = errorResult.result;
                } else if (errorResult.shouldSkip) {
                    this.io.error(`Skipping lookup of ${sObjectType} by ${field} for ${recordId} due to jsforce error: ${jsforceError.message}`);
                } else {
                    throw jsforceError;
                }
            } catch {
                this.io.error(`Unhandled jsforce error looking up ${sObjectType} by ${field}: ${jsforceError.message}`);
            }
        }
        this.io.valueLookupRecords(sObjectType, field, kind, matches.length);
        return matches.map(match => match.Id);
    }

    /** Whether a record fetched at `depth` may still lead to its children. */
    private childrenAllowedAt(depth: number): boolean {
        return !(this.options.relatedRecordDepthLimit && depth >= this.options.relatedRecordDepthLimit);
    }

    private removeAlreadyMigratedRecords(): void {
        for (const recordId of this.history.ids()) {
            if (this.queued.has(recordId)) {
                const sObjectType = this.queued.typeOf(recordId);
                if (sObjectType) {
                    this.alreadyMigratedCountsBySObjectType[sObjectType] = (this.alreadyMigratedCountsBySObjectType[sObjectType] || 0) + 1;
                }
                this.dequeueRecord(recordId);
            }
        }
    }

    private queueRecord(recordId: string, record: SObjectRecord<Schema, string>): void {
        this.queued.set(recordId, record);
    }

    private dequeueRecord(recordId: string): void {
        this.queued.delete(recordId);
    }

    /**
     * The records left to migrate, counted per fetch depth. Taken after
     * removeAlreadyMigratedRecords so it adds up to the fetched count reported
     * with it; records loaded from a file were never fetched and count nowhere.
     */
    private countRemainingRecordsByDepth(): Record<number, number> {
        const counts: Record<number, number> = {};
        for (const recordId of this.queued.ids()) {
            const depth = this.fetchDepthsByIds[recordId];
            if (depth !== undefined) {
                counts[depth] = (counts[depth] || 0) + 1;
            }
        }
        return counts;
    }

    private applyPreprocessing(): void {
        if (this.options.anonymization?.emailFields?.mode) {
            const preprocess = createPreprocessor({
                emailAnonymization: {
                    mode: this.options.anonymization.emailFields.mode,
                    template: this.options.anonymization.emailFields.template
                }
            });
            if (!preprocess) {
                return;
            }
            const preprocessTable = (table: RecordTable) => {
                for (const [id, record] of table.entries()) {
                    preprocess(record);
                    table.set(id, record);
                }
            };
            preprocessTable(this.queued);
            if (this.isMigrateToFile) {
                // The export carries the fetched record, not just its creatable
                // fields, so the fields only that map holds have to be anonymized
                // too. Both maps hold the raw value once and the transformers are
                // deterministic, so the fields they share end up identical - which
                // is why this runs per map rather than over the merged export,
                // where an already obfuscated address would be obfuscated again.
                preprocessTable(this.fetched);
            }
        }
    }

    private async confirmMigration(): Promise<boolean> {
        const matchersBySObjectType: Record<string, { whenMissing: string }> = {};
        for (const matcher of this.options.matchers) {
            matchersBySObjectType[matcher.sObjectType] = { whenMissing: matcher.whenMissing };
        }

        const recordCountsBySObjectType: Record<string, number> = {};
        for (const recordId of this.queued.ids()) {
            const sObjectType = this.queued.typeOf(recordId)!;
            if (!(sObjectType in recordCountsBySObjectType)) {
                recordCountsBySObjectType[sObjectType] = 0;
            }
            recordCountsBySObjectType[sObjectType]++;
        }

        const source = this.options.sourceSqlite ?? this.options.sourceFile ?? this.options.sourceOrgUrl ?? this.options.sourceOrg;
        const target = this.options.targetSqlite ?? this.options.targetFile ?? this.options.targetOrgUrl ?? this.options.targetOrg;
        const alreadyMigrated = { ...this.alreadyMigratedCountsBySObjectType };
        const confirmationData = { source, target, matchers: matchersBySObjectType, alreadyMigrated, ...recordCountsBySObjectType };
        const confirmation = await this.io.askForConfirmation(confirmationData);
        return confirmation === 'y';
    }

    private async migrateToOrg(): Promise<boolean> {
        while (this.queued.size > 0) {
            this.io.remainingRecords(this.queued.size);
            const { toInsert, anyRecordProcessed } = await this.collectRecordsReadyToInsert();
            let recordProcessed = anyRecordProcessed;
            if (toInsert.length > 0) {
                const { exit, solverAdded } = await this.insertRecords(toInsert);
                if (exit) {
                    return false;
                }
                recordProcessed = recordProcessed || solverAdded;
            }
            if (!recordProcessed && !this.releaseStrandedDocuments()) {
                await this.resolveCircularDependencies();
            }
        }
        return true;
    }

    /**
     * Matcher queries run in parallel, so the pass goes in waves: find every record
     * whose references are all settled, query the target for all of them at once,
     * then settle the matches in queue order. A match can be what a record further
     * on was waiting for - its lookup, or the value a matcher of its own compares
     * against - so a wave that settled anything is followed by another. One that
     * only queued inserts is the last: nothing becomes ready until those land.
     *
     * What it hands back is the plan for each record to insert, not the record:
     * insertRecords reads the records a chunk at a time, so a store on disk never
     * has the whole ready set in memory.
     */
    private async collectRecordsReadyToInsert(): Promise<{ toInsert: ChunkEntry[], anyRecordProcessed: boolean }> {
        let anyRecordProcessed = false;
        const toInsert: ChunkEntry[] = [];
        const toInsertIds = new Set<string>();
        let settledAny = true;
        while (settledAny) {
            settledAny = false;
            const ready: { recordId: string, sObjectName: string, bytes: number }[] = [];
            for (const recordId of this.queued.ids()) {
                if (toInsertIds.has(recordId)) {
                    continue;
                }
                const record = this.queued.get(recordId)!;
                const sObjectName = await this.describes.getSObjectType(recordId, record);
                if (this.files.isHeld(recordId)) {
                    // A ContentDocument has no createable field: it comes into being with
                    // the ContentVersion carrying its file. It waits here until that
                    // version lands and hands over the id the target gave the document.
                    continue;
                }
                const { ready: isReady, changed } = await this.resolveRecordReferences(recordId, record, sObjectName);
                if (changed) {
                    this.queued.set(recordId, record);
                }
                if (isReady) {
                    ready.push({ recordId, sObjectName, bytes: this.chunking.countsBytes ? recordSize(record) : 0 });
                }
            }
            if (ready.length === 0) {
                break;
            }
            anyRecordProcessed = true;

            const outcomes = await executeConcurrently(
                ready.map(({ recordId, sObjectName }) => () => this.findExistingRecordId(recordId, sObjectName)),
                this.maxConcurrency
            );
            // executeConcurrently hands back a failure in place of its result; a
            // matcher that cannot be evaluated still has to stop the run.
            const failure = outcomes.find(outcome => outcome instanceof Error);
            if (failure) {
                throw failure;
            }

            for (let i = 0; i < ready.length; i++) {
                const { recordId, sObjectName, bytes } = ready[i];
                const { migratedRecordId, skipRecord } = outcomes[i];
                const isObjectCreatable = (await this.describes.getSObject(sObjectName)).createable;
                if (!migratedRecordId && !skipRecord && isObjectCreatable) {
                    toInsert.push({ id: recordId, sObjectType: this.queued.typeOf(recordId)!, bytes });
                    toInsertIds.add(recordId);
                } else {
                    this.setNewRecordId(recordId, migratedRecordId!);
                    settledAny = true;
                }
            }
        }
        return { toInsert, anyRecordProcessed };
    }

    /**
     * Points the record's references at the records they settled into, and says
     * whether any is still waiting to. `changed` is for the caller to write the
     * record back, which a store on disk needs, and only then.
     */
    private async resolveRecordReferences(recordId: string, record: SObjectRecord<Schema, string>, sObjectName: string): Promise<{ ready: boolean, changed: boolean }> {
        let ready = true;
        let changed = false;
        await this.forEachReferencedId(record, sObjectName, (field, id) => {
            if (this.isWaitingOn(recordId, id)) {
                ready = false;
            } else if (this.history.has(id)) {
                record[field] = record[field].replace(id, this.history.get(id));
                if (record[field] === '') {
                    delete record[field];
                }
                changed = true;
            }
        });
        return { ready, changed };
    }

    /**
     * Every id a record's fields name - lookups and ids written into text alike,
     * blob fields aside (megabytes of base64 turn up runs that only look like
     * ids). The insert loop and the circular-dependency scan both read a record's
     * references through here, so they cannot disagree about what it waits on.
     */
    private async forEachReferencedId(record: SObjectRecord<Schema, string>, sObjectName: string, visit: (field: string, id: string) => void): Promise<void> {
        const blobFields = await this.files.blobFields(sObjectName);
        for (const field of Object.keys(record)) {
            if (blobFields.includes(field) || !record[field]) {
                continue;
            }
            for (const match of String(record[field]).match(ID_REGEX) ?? []) {
                try {
                    await this.describes.getSObjectType(match);
                } catch {
                    // do nothing, it was some random string
                    continue;
                }
                visit(field, match);
            }
        }
    }

    /** Whether `id` names a record still in the queue, which `recordId` then has to wait for. */
    private isWaitingOn(recordId: string, id: string): boolean {
        return !this.history.has(id) && this.queued.has(id) && id !== recordId;
    }

    private async findExistingRecordId(recordId: string, sObjectName: string): Promise<{ migratedRecordId: string, skipRecord: boolean }> {
        const matcher = this.options.matchers.find(matcher => matcher.sObjectType === sObjectName);
        if (!matcher) {
            return { migratedRecordId: '', skipRecord: false };
        }
        const fetchedRecord = this.fetched.get(recordId);
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
        this.io.queryingForExistingRecord(
            'SELECT Id FROM ' + sObjectName + ' WHERE ' + Object.entries(conditions).map(([k, v]) => `${k} = '${v}'`).join(' AND '),
            sObjectName,
            recordId,
            conditions
        );
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

    private async insertRecords(toInsert: ChunkEntry[]): Promise<{ exit: boolean, solverAdded: boolean }> {
        let retryAll = false;
        let solverAdded = false;
        for (const chunkRecordIds of this.chunking.getChunkIds(toInsert)) {
            // Read only now, so no more than a chunk of records is in memory at a
            // time. What is sent is a copy; the queued record is the one the
            // solvers change.
            const chunk: Record<string, SObjectRecord<Schema, string>> = {};
            for (const recordId of chunkRecordIds) {
                const record = this.queued.get(recordId)!;
                chunk[recordId] = { attributes: record.attributes, ...record } as SObjectRecord<Schema, string>;
            }
            this.io.savingRecords(chunk);
            const savedRecords = await this.insertChunk(chunk);
            for (let i = 0; i < savedRecords.length; i++) {
                const recordId = chunkRecordIds[i];
                const record = this.queued.get(recordId)!;
                const result = await this.processSaveResult(recordId, record, savedRecords[i], retryAll);
                if (result.exit) {
                    return { exit: true, solverAdded };
                }
                if (this.queued.has(recordId)) {
                    // Still queued, so going round again - with whatever the
                    // solvers or the user changed on it.
                    this.queued.set(recordId, record);
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
            await this.mapFileDocument(recordId, record, migratedRecordId);
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

    /**
     * A ContentVersion has landed, so the target has created a ContentDocument to
     * hold its file. Point the source document id at that new one and let the
     * document out of the hold: ContentDocumentLinks - and anything else naming
     * the file - resolve through it.
     */
    private async mapFileDocument(recordId: string, record: SObjectRecord<Schema, string>, newRecordId: string): Promise<void> {
        // Only a ContentVersion names a document, so only one is worth reading the
        // fetched record of.
        const sObjectType = record.attributes?.type;
        const documentId = this.files.carriesDocument(sObjectType) ? this.files.documentOf(sObjectType, this.fetched.get(recordId)) : undefined;
        if (!documentId) {
            return;
        }
        const newDocumentId = await this.files.newDocumentOf(newRecordId);
        if (!newDocumentId) {
            return;
        }
        this.io.fileDocumentMapped(documentId, newDocumentId, newRecordId);
        this.files.release(documentId);
        if (this.queued.has(documentId)) {
            this.setNewRecordId(documentId, newDocumentId);
        } else {
            // The document was never fetched - only the version was - but the
            // mapping still has to outlive the run, or a re-run's links point at a
            // document that only exists in the source.
            this.history.settle(documentId, newDocumentId);
        }
    }

    /**
     * Held documents whose version is never going to arrive - it failed, was
     * skipped, or was already migrated - stop being waited for. Reports whether
     * that freed anything, so the caller only goes looking for a circular
     * dependency once no file is holding the run up.
     */
    private releaseStrandedDocuments(): boolean {
        let released = false;
        for (const { documentId, versionId } of this.files.strandedDocuments(versionId => this.queued.has(versionId))) {
            if (!this.queued.has(documentId)) {
                // Already settled - by an earlier run through the history file, or by
                // the version that did land. Nothing to report and nothing to undo.
                continue;
            }
            this.io.fileDocumentUnavailable(documentId, versionId);
            this.setNewRecordId(documentId, '');
            released = true;
        }
        return released;
    }

    /**
     * The solvers this record has already been through for this exact message in
     * this pass, so each is used once. By message, because a solver that acts on
     * one offending field at a time - extract_column - has to come round again for
     * the next field the org complains about; by pass, because the two are solved
     * independently, and a solver spent on the insert is still owed to the update.
     */
    private usedSolvers(recordId: string, phase: SolverPhase, e: SaveError): (SolverType | undefined)[] {
        return this.errors[recordId]?.filter(error => error.phase === phase && error.message === e.message).map(error => error.solver) ?? [];
    }

    private async handleSaveError(recordId: string, record: SObjectRecord<Schema, string>, e: SaveError): Promise<{ retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean, hidden: boolean }> {
        const applied = applySolver(recordId, record, e, {
            io: this.io,
            phase: 'insert',
            solvers: this.options.solvers,
            usedSolvers: this.usedSolvers(recordId, 'insert', e),
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
                const resolution = await this.handleErrorInteractively(recordId, record, e, 'insert');
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
        this.errors[recordId].push({ message: e.message, fixed: errorFixed, solver, phase: 'insert' });
        return { retry, retryAll, matchedId, solverAdded: false, exit: false, hidden: false };
    }

    /**
     * An error no solver could deal with, put to the user. The two passes take the
     * same answers bar one: `match` names a record already in the target to point
     * at instead of inserting, which an update - addressed to the record the run
     * has already created - has no use for, so there it is not an answer at all.
     * The other difference is what `fix` does with the values the user gives:
     * during the insert they replace fields whose original values are stashed for
     * the update pass to write back, while during the update pass - which is that
     * pass - they are simply what the next attempt sends.
     */
    private async handleErrorInteractively(recordId: string, record: SObjectRecord<Schema, string>, e: SaveError, phase: SolverPhase): Promise<{ solver?: SolverType, errorFixed: boolean, retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean }> {
        const result: { solver?: SolverType, errorFixed: boolean, retry: boolean, retryAll: boolean, matchedId?: string, solverAdded: boolean, exit: boolean } = { errorFixed: false, retry: false, retryAll: false, solverAdded: false, exit: false };
        const setField = (field: string, value: string | null) => phase === 'insert'
            ? this.setFieldWithLaterUpdate(recordId, record, field, value)
            : setUpdateField(record, field, value);
        let inputOk;
        do {
            inputOk = true;
            const userInput = await this.io.askForInput(phase, recordId, e.message, e);
            if (userInput === USER_INPUTS.fix) {
                let fieldsToUpdate;
                while (!fieldsToUpdate) {
                    const fieldsJson = await this.io.askForFieldsToUpdate(phase);
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
                    setField(field, fieldsToUpdate[field]);
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
            } else if (userInput === USER_INPUTS.match && phase === 'insert') {
                result.matchedId = await this.io.askForMatch();
            } else if (userInput === USER_INPUTS.saveAndExit) {
                await this.saveAndExit();
                result.exit = true;
            } else if (userInput === USER_INPUTS.addSolver) {
                let newSolver;
                while (!newSolver) {
                    const solverJson = await this.io.askForSolver(phase);
                    try {
                        newSolver = JSON.parse(solverJson);
                        // An exact solver's message is never compiled, so it is
                        // free to be something that is not a valid pattern - which
                        // is half of why one would write it exact.
                        if (!newSolver.exact) {
                            new RegExp(newSolver.message);
                        }
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
        const uniqueSObjectTypes = [...new Set(this.queued.ids().map(recordId => this.queued.typeOf(recordId)!))];
        await Promise.all(uniqueSObjectTypes.map(async sObjectName => {
            requiredLookupFieldsBySObjectType[sObjectName] = (await this.describes.getSObject(sObjectName)).fields
                .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                .map(field => field.name);
        }));

        // The graph is what the insert loop waits on, read off the same references.
        const records: CircularRecord[] = [];
        const dependencies: Dependency[] = [];
        for (const [recordId, record] of this.queued.entries()) {
            const sObjectType = record.attributes!.type;
            const requiredLookups = requiredLookupFieldsBySObjectType[sObjectType];
            records.push({ id: recordId, sObjectType, stashed: recordId in this.toUpdateLater });
            await this.forEachReferencedId(record, sObjectType, (field, id) => {
                if (this.isWaitingOn(recordId, id)) {
                    dependencies.push({ recordId, field, dependsOn: id, required: requiredLookups.includes(field) });
                }
            });
            const held = this.files.heldFor(recordId);
            if (held && this.queued.has(held.versionId)) {
                // Not a field that can be cleared: the document only exists once its version does.
                dependencies.push({ recordId, field: held.field, dependsOn: held.versionId, required: true });
            }
        }

        this.io.lookingForCircularDependencies(requiredLookupFieldsBySObjectType, records.length, dependencies.length);
        const { toClear, unbreakable } = await breakCircularDependencies(
            records,
            dependencies,
            progress => this.io.circularDependencyProgress(progress)
        );
        if (toClear.length > 0) {
            this.io.foundCircularDependency(toClear);
            for (const clear of toClear) {
                const record = this.queued.get(clear.recordId)!;
                this.setFieldWithLaterUpdate(clear.recordId, record, clear.field, '');
                this.queued.set(clear.recordId, record);
            }
        } else if (unbreakable.length > 0) {
            const cycles = unbreakable.map(cycle => cycle.map(step => `${step.recordId}.${step.field} -> ${step.dependsOn}`).join(', '));
            throw new Error(
                'Cannot find record ready to migrate: these records wait on each other through required lookups only, '
                + `which cannot be left empty for later: ${cycles.join('; ')}`
            );
        } else {
            throw new Error('Cannot find record ready to migrate. Circular dependency?');
        }
    }

    /**
     * The deferred values go in, and a failure here gets the same solvers an
     * insert failure does - and then the same user: a record a solver acted on is
     * updated again with what the solver changed, until nothing is left that a
     * solver can act on and what remains has been put to the user.
     *
     * Says whether the pass ran to the end. It does not when the user answers one
     * of its errors with save-and-exit, which leaves the records still pending
     * un-updated - the report is already written by then.
     */
    private async updateClearedFields(): Promise<boolean> {
        let pending = await this.collectRecordsToUpdate();
        for (let attempt = 1; Object.keys(pending).length > 0; attempt++) {
            if (attempt > MAX_UPDATE_ATTEMPTS) {
                for (const recordId of Object.keys(pending)) {
                    this.reportUpdateError(recordId, pending[recordId], new Error(`Giving up after ${MAX_UPDATE_ATTEMPTS} update attempts`));
                }
                return true;
            }
            const pass = await this.updateRecords(pending);
            if (pass.exit) {
                return false;
            }
            pending = pass.pending;
        }
        return true;
    }

    /**
     * The stashed values, addressed to the records the target actually holds: every
     * id the run replaced along the way now resolves to its new one, and so does
     * the id of the record being updated. A record that never made it into the
     * target has nothing to update.
     */
    private async collectRecordsToUpdate(): Promise<Record<string, any>> {
        const recordsToUpdate: Record<string, any> = {};
        for (const recordId of Object.keys(this.toUpdateLater)) {
            const record = this.toUpdateLater[recordId];
            const blobFields = await this.files.blobFields(record.attributes!.type);
            for (const field of Object.keys(record)) {
                if (field !== 'attributes' && !blobFields.includes(field)) {
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
        return recordsToUpdate;
    }

    /**
     * One pass of the update. Records whose failure a solver or the user acted on
     * come back to be tried again with what that changed; every other record is
     * done with, updated or reported.
     *
     * `retryAll` is the user's answer to send the rest of this pass's failures
     * again without being asked about each one, and so lasts exactly as long as the
     * pass does - the next one asks again.
     */
    private async updateRecords(records: Record<string, any>): Promise<{ pending: Record<string, any>, exit: boolean }> {
        const toRetry: Record<string, any> = {};
        let retryAll = false;
        const chunks: Record<string, any>[] = this.chunking.getChunks(records);
        for (const chunk of chunks) {
            this.io.updatingRecord(chunk);
            const updateResults = await this.updateChunk(chunk);
            for (let j = 0; j < updateResults.length; j++) {
                const recordId = Object.keys(chunk)[j];
                const result = updateResults[j];
                if (result.success) {
                    // An error an earlier attempt reported has been gotten past -
                    // the record holds the values the update was sent to write.
                    this.errors[recordId]?.filter(error => error.phase === 'update').forEach(error => error.fixed = true);
                    continue;
                }
                const outcome = await this.handleUpdateErrors(recordId, records[recordId], result.errors, retryAll);
                if (outcome.exit) {
                    return { pending: toRetry, exit: true };
                }
                retryAll = outcome.retryAll;
                if (outcome.retry) {
                    toRetry[recordId] = records[recordId];
                }
            }
        }
        return { pending: toRetry, exit: false };
    }

    /**
     * The update counterpart of insertChunk: an error thrown by the call itself is
     * offered to the whole-operation solvers, and what it leaves unresolved is
     * turned into a failure for every record in the chunk - in the shape the org
     * reports a single record's failure in, so the record-level solvers get their
     * turn at it too.
     */
    private async updateChunk(chunk: Record<string, any>): Promise<SaveResult[]> {
        try {
            return await this.targetClient!.bulkUpdate(Object.values(chunk));
        } catch (jsforceError) {
            let message = `Jsforce error: ${jsforceError.message}`;
            try {
                const errorResult = await this.handleJsforceError(
                    jsforceError,
                    `bulk update ${Object.keys(chunk).length} records`,
                    () => this.targetClient!.bulkUpdate(Object.values(chunk))
                );

                if (errorResult.success && errorResult.result) {
                    return errorResult.result;
                } else if (errorResult.shouldSkip) {
                    message = `Skipped due to jsforce error: ${jsforceError.message}`;
                    this.io.error(`Skipping bulk update for ${Object.keys(chunk).length} records due to jsforce error: ${jsforceError.message}`);
                } else {
                    throw jsforceError;
                }
            } catch {
                this.io.error(`Unhandled jsforce error in bulkUpdate: ${jsforceError.message}`);
            }
            return Object.keys(chunk).map(() => ({
                id: '',
                success: false,
                errors: [{ message, fields: [] }]
            }));
        }
    }

    /**
     * Every failure the org reported for one record's update, through the solvers
     * and - for what they could not act on - to the user, exactly as the insert
     * pass does. Says whether the record is worth updating again, whether the user
     * asked for the rest of the pass to be retried unasked, and whether they asked
     * the run to stop.
     */
    private async handleUpdateErrors(recordId: string, record: any, errors: SaveError[], retryAll: boolean): Promise<{ retry: boolean, retryAll: boolean, exit: boolean }> {
        if (retryAll) {
            return { retry: true, retryAll, exit: false };
        }
        // The payload as this attempt sent it: a solver acting on one failure
        // changes the record the next attempt will send, and the report has to name
        // what the org actually rejected.
        const attempted = { ...record };
        const outcomes: { e: SaveError, solver?: SolverType, errorFixed: boolean, retry: boolean, reported: boolean }[] = [];
        for (const e of errors) {
            const applied = applySolver(recordId, record, e, {
                io: this.io,
                phase: 'update',
                solvers: this.options.solvers,
                usedSolvers: this.usedSolvers(recordId, 'update', e),
                setField: (field, value) => setUpdateField(record, field, value),
            });
            const outcome = { e, solver: applied.solver, errorFixed: applied.errorFixed, retry: applied.retry, reported: true };
            outcomes.push(outcome);
            if (outcome.errorFixed) {
                continue;
            }
            if (!this.options.fullAuto?.enabled) {
                const resolution = await this.handleErrorInteractively(recordId, record, e, 'update');
                if (resolution.exit) {
                    return { retry: false, retryAll, exit: true };
                }
                if (resolution.solver) {
                    outcome.solver = resolution.solver;
                }
                outcome.errorFixed = resolution.errorFixed;
                outcome.retry = outcome.retry || resolution.retry;
                retryAll = resolution.retryAll;
                // A solver added here has not been tried on anything yet: send the
                // record again and let applySolver find it on the failure that comes
                // back, which is what puts the solver's name in the report.
                outcome.reported = !resolution.solverAdded;
            } else if (this.options.fullAuto?.unhandledErrorBehavior === 'saveAndExit') {
                await this.saveAndExit();
                return { retry: false, retryAll, exit: true };
            }
            // fullAuto with 'skip' behavior: fall through and report the error
        }

        if (!outcomes.every(outcome => outcome.errorFixed || outcome.retry)) {
            // One failure nothing could act on is the end of this record's update:
            // it would be rejected for that reason however often it is sent. So the
            // failures a solver did act on are reported alongside it - nothing was
            // actually gotten past - and as the SaveErrors themselves rather than
            // their joined messages, since the status code and the offending field
            // names are what make an update failure actionable.
            this.reportUpdateError(recordId, attempted, errors);
            return { retry: false, retryAll, exit: false };
        }
        for (const outcome of outcomes) {
            if (outcome.solver?.hideError || !outcome.reported) {
                continue;
            }
            if (!(recordId in this.errors)) {
                this.errors[recordId] = [];
            }
            this.errors[recordId].push({ message: outcome.e.message, fixed: outcome.errorFixed, solver: outcome.solver, phase: 'update', fields: updatedFields(attempted) });
        }
        // Every action that resolves an update failure either changes the record and
        // asks for it to be sent again, or skips it - and a skip is a decision that
        // this record's update is not to happen, whatever the others changed.
        return {
            retry: outcomes.some(outcome => outcome.retry) && !outcomes.some(outcome => outcome.solver?.action === 'skip'),
            retryAll,
            exit: false
        };
    }

    /**
     * A record failed the update pass and no solver could act on it. Report it and
     * keep it in this.errors, so the run's output names it too - without this the
     * record looks fully migrated there while its deferred lookup is still empty in
     * the target. There is no `record_no_id` counterpart on purpose: a record with
     * no target id was skipped or matched away during the insert pass, which is not
     * an error of its own.
     */
    private reportUpdateError(recordId: string, record: any, error: any): void {
        const sObjectName = record.attributes!.type;
        this.io.errorUpdatingRecord(recordId, sObjectName, error, record);
        if (!(recordId in this.errors)) {
            this.errors[recordId] = [];
        }
        this.errors[recordId].push({ message: serializeError(error).message, fixed: false, phase: 'update', fields: updatedFields(record) });
    }

    /**
     * The records an export writes, one at a time, so a store on disk is never
     * read into memory whole. Each is the whole fetched record, not just the
     * fields that can be inserted: matchers read their source fields off the
     * fetched record (findExistingRecordId), and plenty of them - Name on User,
     * formula fields, DeveloperName on RecordType - are not creatable, so leaving
     * them out makes the export unusable as a source. The creatable filter is
     * applied on the way back in, by loadRecordsFromFile.
     */
    private *exportedRecords(): Generator<[string, any]> {
        for (const [id, record] of this.queued.entries()) {
            const fetchedRecord = this.fetched.get(id) ?? {};
            yield [id, {
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(fetchedRecord)),
                ...Object.fromEntries(Object.entries(record)),
                Id: id
            }];
        }
    }

    private async migrateToFile(): Promise<void> {
        if (this.options.targetSqlite !== undefined) {
            writeRecordsToSqlite(this.options.targetSqlite, () => this.exportedRecords());
        } else {
            writeRecordsToJson(this.options.targetFile!, this.exportedRecords());
        }

        // The records themselves are in the export; the report names them, the way
        // an org migration's report maps each record to the one it became.
        const exportedRecordIds: Record<string, string> = {};
        for (const id of this.queued.ids()) {
            exportedRecordIds[id] = id;
        }
        const requestedRecordsMappings: Record<string, string> = {};
        for (const originalRecordId of this.options.recordIds) {
            requestedRecordsMappings[originalRecordId] = originalRecordId;
        }

        const outputData = {
            allMigratedRecords: exportedRecordIds,
            errors: {},
            requestedRecords: requestedRecordsMappings
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
            requestedRecords: requestedRecordsMappings
        };
        this.io.finished(JSON.stringify(outputData));
    }

    private setNewRecordId(recordId: string, newRecordId: string): void {
        this.history.settle(recordId, newRecordId);
        this.dequeueRecord(recordId);
        // Nothing reads a settled record's fetched fields again, so they go - but
        // a store kept for inspection keeps them, or a run that went well would
        // leave it empty.
        if (!this.store.keep) {
            this.fetched.delete(recordId);
        }
        // Every record leaves the queue through here - created, matched, skipped
        // or given up on - so this is the one place the remaining count is exact.
        this.io.recordSettled(this.queued.size);
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
}

/**
 * `{ "records": { id: record, ... } }`, written a record at a time, laid out
 * exactly as `JSON.stringify(file, null, 2)` would lay it out.
 */
function writeRecordsToJson(filePath: string, records: Iterable<[string, any]>): void {
    const fd = fs.openSync(filePath, 'w');
    try {
        let first = true;
        fs.writeSync(fd, '{\n  "records": {');
        for (const [id, record] of records) {
            // JSON strings cannot hold a raw newline, so every one in the output
            // is layout, and indenting after it nests the record two levels down.
            fs.writeSync(fd, `${first ? '' : ','}\n    ${JSON.stringify(id)}: ${JSON.stringify(record, null, 2).replace(/\n/g, '\n    ')}`);
            first = false;
        }
        fs.writeSync(fd, first ? '}\n}' : '\n  }\n}');
    } finally {
        fs.closeSync(fd);
    }
}

async function main(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>, clientFactory?: ClientFactory) {
    const runner = new MigrationRunner(options, onOutput, onInput, clientFactory);
    await runner.run();
}

export { main };
