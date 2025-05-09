console.log('importing dependencies');
import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, Field, Schema, SObjectRecord, SObjectUpdateRecord } from 'jsforce';
import fs from 'fs';
import path from 'path';
import { scanForCircularDependency } from './circular';
import Chunks from './chunks';
import IOEvent from './ioevent';
console.log('importing dependencies done');

interface Options {
    sourceOrg: string;
    targetOrg: string;
    sourceOrgUrl: string;
    sourceOrgToken: string;
    targetOrgUrl: string;
    targetOrgToken: string;
    recordIds: string[];
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
    // Create source connection
    let authInfoA: AuthInfo;
    if (options.sourceOrg) {
        // Use alias authentication for source
        const getOrgUsername = (orgAlias: string) => allAuths.find(auth => auth.aliases?.includes(orgAlias))?.username;
        const orgAUsername = getOrgUsername(options.sourceOrg);
        if (!orgAUsername) {
            throw new Error(`Unable to find username for source org alias: ${options.sourceOrg}`);
        }
        authInfoA = await AuthInfo.create({ username: orgAUsername });
    } else if (options.sourceOrgUrl && options.sourceOrgToken) {
        // Use token authentication for source
        authInfoA = await AuthInfo.create({
            username: options.sourceOrgToken,
            accessTokenOptions: {
                instanceUrl: options.sourceOrgUrl,
                serverUrl: options.sourceOrgUrl,
                sessionId: options.sourceOrgToken
            }
        });
    } else {
        throw new Error('Source org authentication missing: provide either sourceOrg alias or sourceOrgUrl + sourceOrgToken');
    }

    // Create target connection
    let authInfoB: AuthInfo;
    if (options.targetOrg) {
        // Use alias authentication for target
        const getOrgUsername = (orgAlias: string) => allAuths.find(auth => auth.aliases?.includes(orgAlias))?.username;
        const orgBUsername = getOrgUsername(options.targetOrg);
        if (!orgBUsername) {
            throw new Error(`Unable to find username for target org alias: ${options.targetOrg}`);
        }
        authInfoB = await AuthInfo.create({ username: orgBUsername });
    } else if (options.targetOrgUrl && options.targetOrgToken) {
        // Use token authentication for target
        authInfoB = await AuthInfo.create({
            username: options.targetOrgToken,
            accessTokenOptions: {
                instanceUrl: options.targetOrgUrl,
                serverUrl: options.targetOrgUrl,
                sessionId: options.targetOrgToken
            }
        });
    } else {
        throw new Error('Target org authentication missing: provide either targetOrg alias or targetOrgUrl + targetOrgToken');
    }

    // Create and return connections
    return await Promise.all([
        Connection.create({ authInfo: authInfoA }),
        Connection.create({ authInfo: authInfoB })
    ]);
}

async function main(options: Options, onOutput: (output: IOEvent) => void, onInput: (question: IOEvent) => Promise<string>) {
    const output = (event: IOEvent) => {
        onOutput(new IOEvent(event.category, event.message, event.type, event.data));
    };
    const input = (question: IOEvent) => {
        return onInput(new IOEvent(question.category, question.message, question.type, question.data));
    };

    const chunking = new Chunks(['User', 'UserRole', 'PermissionSetAssignment', 'BusinessHours'], 200, 10);

    output({ category: 'output', message: `starting migration: ${JSON.stringify(options)}`, type: 'info' });

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
            // output({ category: 'output', message: `describing SObject ${sObjectName}`, type: 'info' });
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
    output({ category: 'output', message: `checking matchers`, type: 'info' });
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

    for (const recordId of Object.keys(history)) {
        old2new[recordId] = history[recordId];
        recordIdsToFetch = recordIdsToFetch.filter(id => id !== recordId);
    }

    while (recordIdsToFetch.length > 0) {
        output({ category: 'output', message: `records so far: ${Object.keys(recordsByIds).length}`, type: 'info' });
        // Create parallel fetch promises for all records
        const fetchPromises = recordIdsToFetch.map(async (recordId) => {
            const sObjectName = await getSObjectType(recordId);
            const sobjectDescribe = await getSObjectDescribe(sObjectName);
            output({ category: 'output', message: `fetching record ${recordId} of type ${sObjectName}`, type: 'info' });
            let recordFields;
            try {
                recordFields = await connA.sobject(sObjectName).retrieve(recordId);
            } catch (error) {
                if (error.errorCode === 'NOT_FOUND' || error.message?.includes('resource does not exist')) {
                    output({ category: 'output', message: `record ${recordId} of type ${sObjectName} does not exist in the source org`, type: 'info' });
                    return [];
                } else if (error.errorCode === 'INVALID_TYPE_FOR_OPERATION') {
                    output({ category: 'output', message: `record ${recordId} of type ${sObjectName} is not queryable`, type: 'info' });
                    old2new[recordId] = '';
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
                    const regex = /[a-zA-Z0-9]{18}/g;
                    const matches = String(record[field.name])?.match(regex);
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
            if (relationships) {
                const selector = connA.sobject(sObjectName).select('Id');
                for (const relationship of relationships) {
                    selector.include(relationship.name).select('Id').end();
                }
                selector.where(`Id = '${recordId}'`);
                output({ category: 'output', message: `querying for related records: ${await selector.toSOQL()}`, type: 'info' });
                const relsResults = await selector.execute();
                const recordRelationships = relsResults[0];
                for (const relationship of relationships) {
                    const relatedRecords = recordRelationships![relationship.name]?.records;
                    output({ category: 'output', message: `related records of ${relationship.name}: ${relatedRecords?.length}`, type: 'info' });
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

    output({ category: 'output', message: `fetched ${Object.keys(recordsByIds).length} records`, type: 'info' });
    // build map of record counts by sobject type
    const recordCountsBySObjectType: Record<string, number> = {};
    for (const record of Object.values(recordsByIds)) {
        if (!(record.attributes!.type in recordCountsBySObjectType)) {
            recordCountsBySObjectType[record.attributes!.type] = 0;
        }
        recordCountsBySObjectType[record.attributes!.type]++;
    }

    // ask for confirmation
    const confirmation = await input({ category: 'input', message: 'Do you want to continue? (y/n)', type: 'confirm_migration', data: JSON.stringify(recordCountsBySObjectType) });
    output({ category: 'output', message: `confirmation: ${confirmation}`, type: 'info' });
    if (confirmation !== 'y') {
        output({ category: 'output', message: 'Aborted', type: 'info' });
        return;
    }

    const saveAndExit = () => {
        fs.writeFileSync(historyFilePath, JSON.stringify(old2new, null, 2));
        const outputData = {
            ...old2new,
            errors
        };
        output({ category: 'output', message: 'Finished', data: JSON.stringify(outputData), type: 'info' });
    }

    const toUpdateLater: Record<string, SObjectRecord<Schema, string>> = {};
    const setFieldWithLaterUpdate = (recordId: string, record: SObjectRecord<Schema, string>, field: string, value: string) => {
        if (!(recordId in toUpdateLater)) {
            toUpdateLater[recordId] = {
                attributes: record.attributes
            } as SObjectRecord<Schema, string>;
        }
        toUpdateLater[recordId][field] = record[field];
        record[field] = value;
    }
    
    while (Object.keys(recordsByIds).length > 0) {
        output({ category: 'output', message: `remaining records: ${Object.keys(recordsByIds).length}`, type: 'info' });
        let anyRecordProcessed = false;
        const toInsert: Record<string, SObjectRecord<Schema, string>> = {};
        for (const recordId of Object.keys(recordsByIds)) {
            const record = recordsByIds[recordId];
            const sObjectName = await getSObjectType(recordId);
            let recordReady = true;
            for (const field of Object.keys(record)) {
                if (record[field]) {
                    const regex = /[a-zA-Z0-9]{18}/g;
                    const matches = String(record[field])?.match(regex);
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
                                output({ category: 'output', message: `mapping ${field} to ${match} for record ${recordId} of type ${sObjectName} - new value: ${old2new[match]}`, type: 'info' });
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
                    output({ category: 'output', message: `querying for existing record: ${await selector.toSOQL()}`, type: 'info' });
                    const migratedRecord = await selector.execute();
                    if (migratedRecord.length > 0) {
                        migratedRecordId = migratedRecord[0].Id!;
                        output({ category: 'output', message: `found existing record ${migratedRecordId} of type ${sObjectName}`, type: 'info' });
                    } else if (matcher.whenMissing === 'skip') {
                        output({ category: 'output', message: `skipping record ${recordId} of type ${sObjectName} because no existing record was found`, type: 'info' });
                        skipRecord = true;
                    }
                }
                const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable;
                if (!migratedRecordId && !skipRecord && isObjectCreatable) {
                    toInsert[recordId] = {
                        attributes: record.attributes,
                            ...record
                        } as SObjectRecord<Schema, string>;
                    output({ category: 'output', message: `creating record ${recordId} of type ${sObjectName} with fields ${JSON.stringify(record)}`, type: 'info' });
                } else {
                    old2new[recordId] = migratedRecordId!;
                    delete recordsByIds[recordId];
                }
            }
        }
        if (Object.keys(toInsert).length > 0) {
            const chunks: Record<string, SObjectRecord<Schema, string>>[] = chunking.getChunks(toInsert);
            let retryAll = false;
            for (const chunk of chunks) {
                output({ category: 'output', message: `saving ${Object.keys(chunk).length} records: ${JSON.stringify(Object.values(chunk))}`, type: 'info' });
                const savedRecords = (await connB.request({
                method: 'POST',
                url: '/services/data/v62.0/composite/sobjects',
                body: JSON.stringify({
                        allOrNone: false,
                        records: Object.values(chunk)
                    })
                })) as Array<{ id: string, success: boolean, errors: any[] }>;
                output({ category: 'output', message: `saved records: ${JSON.stringify(savedRecords)}`, type: 'info' });
                for (let i = 0; i < savedRecords.length; i++) {
                    const recordId = Object.keys(chunk)[i];
                    const record = recordsByIds[recordId];
                    const savedRecord = savedRecords[i];
                    let retryRecord = retryAll;
                    let migratedRecordId = '';
                    if (savedRecord.success) {
                        migratedRecordId = savedRecord.id!;
                        output({ category: 'output', message: `created record ${migratedRecordId}`, type: 'info' });
                    } else if (!retryRecord) {    
                        const errs = savedRecord.errors
                        for (const e of errs) {
                            let errorFixed = false;
                            let solver: (FixSolver | SkipSolver | MatchSolver | ExtractSolver | AppendRandomSolver) | undefined;
                            if (options.solvers) {
                                // get previously used solvers
                                const usedSolvers = errors[recordId]?.filter(error => error.message === e.message).map(error => error.solver);
                                if (usedSolvers?.length > 0) {
                                    output({ category: 'output', message: `skipping previously used solvers: ${JSON.stringify(usedSolvers)}`, type: 'info' });
                                }
                                // find solver that matches the error message
                                solver = options.solvers.find(solver => new RegExp(solver.message).test(e.message) && !usedSolvers?.includes(solver));
                                if (solver) {
                                    if (solver.action === 'fix') {
                                        for (const changeField of solver.changeFields) {
                                            if (changeField.value === null) {
                                                delete record[changeField.field];
                                            } else {
                                                setFieldWithLaterUpdate(recordId, record, changeField.field, changeField.value);
                                            }
                                        }
                                        output({ category: 'output', message: `fixing using solver: ${solver.message}`, type: 'info' });
                                        output({ category: 'output', message: `saved old fields in toUpdateLater: ${JSON.stringify(toUpdateLater[recordId])}`, type: 'info' });
                                        errorFixed = true;
                                        retryRecord = true;
                                    } else if (solver.action === 'skip') {
                                        output({ category: 'output', message: `skipping record ${recordId} using solver: ${solver.message}`, type: 'info' });
                                        errorFixed = true;
                                    } else if (solver.action === 'match') {
                                        output({ category: 'output', message: `matching record ${recordId} using solver: ${solver.message}`, type: 'info' });
                                        const matchId = new RegExp(solver.message).exec(e.message)?.[1];
                                        if (matchId) {
                                            migratedRecordId = matchId;
                                            errorFixed = true;
                                        }
                                    } else if (solver.action === 'extract_column') {
                                        output({ category: 'output', message: `extracting column name from error: ${e.message}`, type: 'info' });
                                        const columnName = new RegExp(solver.message).exec(e.message)?.[1];
                                        if (columnName) {
                                            if (solver.replaceWith === null) {
                                                delete record[columnName];
                                            } else {
                                                setFieldWithLaterUpdate(recordId, record, columnName, solver.replaceWith);
                                            }
                                            errorFixed = true;
                                            retryRecord = true;
                                        }
                                    } else if (solver.action === 'append_random') {
                                        output({ category: 'output', message: `appending random to record ${recordId} using solver: ${solver.message}`, type: 'info' });
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
                                output({ category: 'output', message: `error: ${JSON.stringify(e)}`, type: 'info' });
                                let inputOk;
                                let solverAdded = false;
                                do {
                                    inputOk = true;
                                    const userInput = await input({ category: 'input', message: `recordId: ${recordId}, no solver found for error: ${e.message}`, type: 'insert_error' });
                                    if (userInput === 'f') {
                                        let fieldsToUpdate;
                                        while (!fieldsToUpdate) {
                                            const fieldsJson = await input({ category: 'input', message: 'Enter the fields to update in JSON format:', type: 'insert_error' });
                                            try {
                                                fieldsToUpdate = JSON.parse(fieldsJson);
                                            } catch {
                                                output({ category: 'output', message: `invalid JSON, please try again`, type: 'info' });
                                            }
                                        }
                                        solver = {
                                            action: 'fix',
                                            message: e.message,
                                            changeFields: []
                                        }
                                        for (const field of Object.keys(fieldsToUpdate)) {
                                            if (fieldsToUpdate[field] === null) {
                                                delete record[field];
                                            } else {
                                                setFieldWithLaterUpdate(recordId, record, field, fieldsToUpdate[field]);
                                            }
                                            solver.changeFields.push({ field, value: fieldsToUpdate[field] });
                                        }
                                        retryRecord = true;
                                        errorFixed = true;
                                    } else if (userInput === 'r') {
                                        retryRecord = true;
                                    } else if (userInput === 'ra') {
                                        retryAll = true;
                                        retryRecord = true;
                                    } else if (userInput === 'm') {
                                        migratedRecordId = await input({ category: 'input', message: `Enter the ID of the record to match:`, type: 'insert_error' });
                                    } else if (userInput === 'h') {
                                        saveAndExit();
                                        return;
                                    } else if (userInput === 'a') {
                                        let newSolver;
                                        while (!newSolver) {
                                            const solverJson = await input({ category: 'input', message: 'Enter the solver in JSON format:', type: 'insert_error' });
                                            try {
                                                newSolver = JSON.parse(solverJson);
                                                new RegExp(newSolver.message);
                                            } catch {
                                                newSolver = null;
                                                output({ category: 'output', message: `invalid JSON or regex, please try again`, type: 'info' });
                                            }
                                        }
                                        if (!options.solvers) {
                                            options.solvers = [];
                                        }
                                        options.solvers.push(newSolver);
                                        anyRecordProcessed = true;
                                        solverAdded = true;
                                        retryRecord = true;
                                    } else if (userInput == 's') {
                                        // skip record, don't do anything
                                    } else {
                                        output({ category: 'output', message: `invalid input: ${userInput}`, type: 'info' });
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
                    old2new[recordId] = migratedRecordId!;
                    delete recordsByIds[recordId];
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
            output({ category: 'output', message: `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, type: 'info' });
            const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
            if (toClear.length > 0) {
                output({ category: 'output', message: `found circular dependency: ${JSON.stringify(toClear)}`, type: 'info' });
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
                const regex = /[a-zA-Z0-9]{18}/g;
                const matches = value.match(regex);
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
            output({ category: 'output', message: `record ${recordId} has no ID, skipping update`, type: 'info' });
            continue;
        }
        output({ category: 'output', message: `updating record ${recordId} of type ${record.attributes!.type} to ${JSON.stringify(record)}`, type: 'info' });
        try {
            await connB.sobject(record.attributes!.type).update(record as SObjectUpdateRecord<Schema, string>);
        } catch (e) {
            output({ category: 'output', message: `error updating record ${recordId} of type ${record.attributes!.type}: ${e}`, type: 'info' });
        }
    }

    saveAndExit();
}

export { main, Options, IOEvent };