console.log('importing dependencies');
import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, Field, Schema, SObjectRecord, SObjectUpdateRecord } from 'jsforce';
import fs from 'fs';
import path from 'path';
import { scanForCircularDependency } from './circular';
import Chunks from './chunks';
import IOEvent from './ioevent';
import IO from './io';
console.log('importing dependencies done');

interface Options {
    sourceOrg: string;
    targetOrg: string;
    sourceOrgUrl: string;
    sourceOrgToken: string;
    targetOrgUrl: string;
    targetOrgToken: string;
    recordIds: string[];
    relatedRecordDepthLimit: number;
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
    solvers: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver)[];
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

async function getConnections(options: Options): Promise<[Connection<Schema>, Connection<Schema>]> {
    const allAuths = await AuthInfo.listAllAuthorizations();
    
    const createAuthInfo = async (orgAlias: string | undefined, orgUrl: string | undefined, orgToken: string | undefined, orgType: 'source' | 'target'): Promise<AuthInfo> => {
        if (orgAlias) {
            // Use alias authentication
            const getOrgUsername = (alias: string) => allAuths.find(auth => auth.aliases?.includes(alias))?.username;
            const username = getOrgUsername(orgAlias);
            if (!username) {
                throw new Error(`Unable to find username for ${orgType} org alias: ${orgAlias}`);
            }
            return await AuthInfo.create({ username });
        } else if (orgUrl && orgToken) {
            // Use token authentication
            return await AuthInfo.create({
                username: orgToken,
                accessTokenOptions: {
                    instanceUrl: orgUrl,
                    serverUrl: orgUrl,
                    sessionId: orgToken
                }
            });
        } else {
            throw new Error(`${orgType.charAt(0).toUpperCase() + orgType.slice(1)} org authentication missing: provide either ${orgType}Org alias or ${orgType}OrgUrl + ${orgType}OrgToken`);
        }
    };

    const [authInfoA, authInfoB] = await Promise.all([
        createAuthInfo(options.sourceOrg, options.sourceOrgUrl, options.sourceOrgToken, 'source'),
        createAuthInfo(options.targetOrg, options.targetOrgUrl, options.targetOrgToken, 'target')
    ]);

    // Create and return connections
    return await Promise.all([
        Connection.create({ authInfo: authInfoA }),
        Connection.create({ authInfo: authInfoB })
    ]);
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

async function main(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>) {
    const io = new IO(onOutput, onInput);
    const chunking = new Chunks(CHUNKING_OBJECTS, 200, 10);

    io.startingMigration(options);

    const [connA, connB] = await getConnections(options);

    // check if history file exists for target org
    const historyFilePath = path.join(process.cwd(), `${options.targetOrg}__history.json`);
    let history: Record<string, string> = {};
    if (fs.existsSync(historyFilePath)) {
        history = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
    }

    const describeGlobal = await connA.describeGlobal();
    const sObjectDescribes: Record<string, DescribeSObjectResult> = {};
    const getSObjectDescribe = async (sObjectName: string): Promise<DescribeSObjectResult> => {
        if (!(sObjectName in sObjectDescribes)) {
            io.describeSObject(sObjectName);
            sObjectDescribes[sObjectName] = await connB.sobject(sObjectName).describe();
        }
        return sObjectDescribes[sObjectName];
    };
    const getSObjectType = async (recordId: string): Promise<string> => {
        const prefix = recordId.substring(0, 3);
        const sobject = describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix);
        if (!sobject) {
            throw new Error(`SObject with prefix ${prefix} not found`);
        }
        return sobject.name;
    };

    // check if all matchers are valid
    io.checkingMatchers();
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
    const errors: Record<string, { message: string, fixed: boolean, solver?: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver) }[]> = {};
    const migratedRecords: Record<string, string> = {};
    
    const setNewRecordId = (recordId: string, newRecordId: string) => {
        old2new[recordId] = newRecordId;
        delete recordsByIds[recordId];
        migratedRecords[recordId] = newRecordId;
    }
    
    for (const recordId of Object.keys(history)) {
        old2new[recordId] = history[recordId];
    }

    let depth = 0;
    while (recordIdsToFetch.length > 0) {
        console.log('depth', depth);
        depth++;
        io.recordsSoFar(Object.keys(recordsByIds).length);
        // Create parallel fetch promises for all records
        const fetchPromises = recordIdsToFetch.map(async (recordId) => {
            const sObjectName = await getSObjectType(recordId);
            const sobjectDescribe = await getSObjectDescribe(sObjectName);
            io.fetchingRecord(recordId, sObjectName);
            let recordFields;
            try {
                recordFields = await connA.sobject(sObjectName).retrieve(recordId);
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
                const selector = connA.sobject(sObjectName).select('Id');
                for (const relationship of relationships) {
                    selector.include(relationship.name).select('Id').end();
                }
                selector.where(`Id = '${recordId}'`);
                io.queryingForRelatedRecords(await selector.toSOQL());
                const relsResults = await selector.execute();
                const recordRelationships = relsResults[0];
                for (const relationship of relationships) {
                    const relatedRecords = recordRelationships![relationship.name]?.records;
                    io.relatedRecords(relationship.name, relatedRecords?.length);
                    if (relatedRecords) {
                        for (const relatedRecord of relatedRecords) {
                            if (!(relatedRecord.Id in recordsByIds) && !newIds.includes(relatedRecord.Id!)) {
                                newIds.push(relatedRecord.Id!);
                            }
                        }
                    }
                }
            }
            return newIds;
        });

        // Wait for all fetches to complete
        const newIdsArrays = await Promise.all(fetchPromises);
        
        // Flatten array of arrays into single array of new IDs to fetch
        const newRecordIdsToFetch = newIdsArrays.flat();
        // remove records that are already fetched
        recordIdsToFetch = recordIdsToFetch.filter(id => !(id in fetchedRecordsByIds));
        recordIdsToFetch = newRecordIdsToFetch;
    }

    // remove records that are already migrated
    for (const recordId of Object.keys(old2new)) {
        if (recordId in recordsByIds) {
            delete recordsByIds[recordId];
        }
    }

    io.fetchedRecords(Object.keys(recordsByIds).length);
    // build map of record counts by sobject type
    const recordCountsBySObjectType: Record<string, number> = {};
    for (const record of Object.values(recordsByIds)) {
        if (!(record.attributes!.type in recordCountsBySObjectType)) {
            recordCountsBySObjectType[record.attributes!.type] = 0;
        }
        recordCountsBySObjectType[record.attributes!.type]++;
    }

    // ask for confirmation
    const confirmation = await io.askForConfirmation(recordCountsBySObjectType);
    if (confirmation !== 'y') {
        io.aborted();
        return;
    }

    const saveAndExit = () => {
        fs.writeFileSync(historyFilePath, JSON.stringify(old2new, null, 2));
        const outputData = {
            ...old2new,
            errors
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
    
    while (Object.keys(recordsByIds).length > 0) {
        io.remainingRecords(Object.keys(recordsByIds).length);
        let anyRecordProcessed = false;
        const toInsert: Record<string, SObjectRecord<Schema, string>> = {};
        for (const recordId of Object.keys(recordsByIds)) {
            const record = recordsByIds[recordId];
            const sObjectName = await getSObjectType(recordId);
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
                    const selector = connB.sobject(sObjectName).find(conditions).select('Id');
                    io.queryingForExistingRecord(await selector.toSOQL());
                    const migratedRecord = await selector.execute();
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
                const savedRecords = (await connB.request({
                method: 'POST',
                url: `/services/data/v${connB.version}/composite/sobjects`,
                body: JSON.stringify({
                        allOrNone: false,
                        records: Object.values(chunk)
                    })
                })) as Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>;
                io.savedRecords(savedRecords);
                for (let i = 0; i < savedRecords.length; i++) {
                    const recordId = Object.keys(chunk)[i];
                    const record = recordsByIds[recordId];
                    const savedRecord = savedRecords[i];
                    let retryRecord = retryAll;
                    let migratedRecordId = '';
                    if (savedRecord.success) {
                        migratedRecordId = savedRecord.id!;
                        io.createdRecord(migratedRecordId);
                    } else if (!retryRecord) {    
                        const errs = savedRecord.errors
                        for (const e of errs) {
                            let errorFixed = false;
                            let solver: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver) | undefined;
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
                                io.error(e.message);
                                let inputOk;
                                let solverAdded = false;
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
                                        saveAndExit();
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
            await connB.sobject(record.attributes!.type).update(record as SObjectUpdateRecord<Schema, string>);
        } catch (e) {
            io.errorUpdatingRecord(recordId, record.attributes!.type, e);
        }
    }

    saveAndExit();
}

export { main, Options, IOEvent };