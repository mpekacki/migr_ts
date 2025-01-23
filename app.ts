import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, Field, SaveResult, Schema, SObjectRecord, SObjectUpdateRecord } from 'jsforce';
import fs from 'fs';
import path from 'path';
import { scanForCircularDependency } from './circular';

interface Options {
    sourceOrg: string;
    targetOrg: string;
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
    solvers: (FixSolver | SkipSolver | MatchSolver)[];
}

interface Solver {
    message: string;
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

interface IOEvent {
    category: 'output' | 'input';
    message: string;
    type: 'confirm_migration' | 'info' | 'insert_error';
    data?: string;
}

async function main(options: Options, output: (output: IOEvent) => void, input: (question: IOEvent) => Promise<string>) {
    output({ category: 'output', message: `starting migration: ${JSON.stringify(options)}`, type: 'info' });
    
    const allAuths = await AuthInfo.listAllAuthorizations();

    const getOrgUsername = (orgAlias: string) => allAuths.find(auth => auth.aliases?.includes(orgAlias))?.username;
    const orgAUsername = getOrgUsername(options.sourceOrg);
    const orgBUsername = getOrgUsername(options.targetOrg);

    if (!orgAUsername || !orgBUsername) {
        throw new Error('Unable to find username for source or target org');
    }

    const createAuthInfo = (username: string) => AuthInfo.create({ username });
    const [authInfoA, authInfoB] = await Promise.all([
        createAuthInfo(orgAUsername),
        createAuthInfo(orgBUsername)
    ]);

    const [connA, connB] = await Promise.all([
        Connection.create({ authInfo: authInfoA }),
        Connection.create({ authInfo: authInfoB })
    ]);

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
            sObjectDescribes[sObjectName] = await connA.sobject(sObjectName).describe();
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

    let recordIdsToFetch = options.recordIds;
    const recordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    const fetchedRecordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    const lookupFieldsBySObjectType: Record<string, Field[]> = {};
    const old2new: Record<string, string> = {};
    const errors: Record<string, { message: string, fixed: boolean, solver?: (FixSolver | SkipSolver | MatchSolver) }[]> = {};

    for (const recordId of Object.keys(history)) {
        old2new[recordId] = history[recordId];
        recordIdsToFetch = recordIdsToFetch.filter(id => id !== recordId);
    }

    while (recordIdsToFetch.length > 0) {
        const newRecordIdsToFetch: string[] = [];
        for (const recordId of recordIdsToFetch) {
            const sObjectName = await getSObjectType(recordId);
            const sobjectDescribe = await getSObjectDescribe(sObjectName);
            const relationships = options.relationships?.[sObjectName];
            const recordFields = await connA.sobject(sObjectName).retrieve(recordId);
            const selector = connA.sobject(sObjectName).select('Id');
            if (relationships) {
                for (const relationship of relationships) {
                    selector.include(relationship.name).select('Id').end();
                }
            }
            selector.where(`Id = '${recordId}'`);
            const relsResults = await selector.execute();
            const recordRelationships = relsResults[0];
            fetchedRecordsByIds[recordId] = recordFields;
            const creatableFields = (await getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
            const record: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                record[field.name] = recordFields[field.name];
            }
            record.attributes = recordRelationships.attributes;
            recordsByIds[recordId] = record;
            const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
            if (lookupFields.length > 0) {
                lookupFieldsBySObjectType[sObjectName] = lookupFields;
            }
            for (const lookupField of lookupFields) {
                const lookupValue = record[lookupField.name];
                if (lookupValue && !(lookupValue in recordsByIds) && !newRecordIdsToFetch.includes(lookupValue)) {
                    newRecordIdsToFetch.push(lookupValue);
                }
            }
            if (relationships) {
                for (const relationship of relationships) {
                    const relatedRecords = recordRelationships[relationship.name]?.records;
                    output({ category: 'output', message: `related records of ${relationship.name}: ${relatedRecords?.length}`, type: 'info' });
                    if (relatedRecords) {
                        for (const relatedRecord of relatedRecords) {
                            if (!(relatedRecord.Id in recordsByIds) && !newRecordIdsToFetch.includes(relatedRecord.Id!)) {
                                newRecordIdsToFetch.push(relatedRecord.Id!);
                            }
                        }
                    }
                }
            }
        }
        recordIdsToFetch = newRecordIdsToFetch;
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
    while (Object.keys(recordsByIds).length > 0) {
        let anyRecordProcessed = false;
        for (const recordId of Object.keys(recordsByIds)) {
            const record = recordsByIds[recordId];
            const sObjectName = await getSObjectType(recordId);
            let recordReady = true;
            const lookupFields = lookupFieldsBySObjectType[sObjectName];
            if (lookupFields) {
                for (const lookupField of lookupFields) {
                    const lookupValue = record[lookupField.name];
                    if (lookupValue) {
                        if (!(lookupValue in old2new) && lookupValue in recordsByIds) {
                            recordReady = false;
                            // output({ category: 'output', message: `record ${recordId} is not ready because lookup field ${lookupField.name} (${lookupValue}) is not migrated`, type: 'info' });
                        } else if (lookupValue in old2new) {
                            output({ category: 'output', message: `mapping ${lookupField.name} to ${lookupValue} for record ${recordId} of type ${sObjectName} - new value: ${old2new[lookupValue]}`, type: 'info' });
                            record[lookupField.name] = old2new[lookupValue];
                            if (record[lookupField.name] === '') {
                                delete record[lookupField.name];
                            }
                        }
                    }
                }
            }
            if (recordReady) {
                anyRecordProcessed = true;
                let migratedRecordId = '';
                let retryRecord = false;
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
                if (!migratedRecordId && !skipRecord) {
                    const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable;
                    if (isObjectCreatable) {
                        output({ category: 'output', message: `creating record ${recordId} of type ${sObjectName} with fields ${JSON.stringify(record)}`, type: 'info' });
                        try {
                            const savedRecord: SaveResult = await connB.sobject(sObjectName).create(record);
                            migratedRecordId = savedRecord.id!;
                            output({ category: 'output', message: `created record ${migratedRecordId} of type ${sObjectName}`, type: 'info' });
                        } catch (e) {
                            let errorFixed = false;
                            let solver: (FixSolver | SkipSolver | MatchSolver) | undefined;
                            if (options.solvers) {
                                // find solver that matches the error message
                                solver = options.solvers.find(solver => new RegExp(solver.message).test(e.message));
                                if (solver) {
                                    if (solver.action === 'fix') {
                                        for (const changeField of solver.changeFields) {
                                            if (changeField.value === null) {
                                                delete record[changeField.field];
                                            } else {
                                                if (!(recordId in toUpdateLater)) {
                                                    toUpdateLater[recordId] = {
                                                        attributes: record.attributes
                                                    } as SObjectRecord<Schema, string>;
                                                }
                                                toUpdateLater[recordId][changeField.field] = record[changeField.field];
                                                record[changeField.field] = changeField.value;
                                            }
                                        }
                                        output({ category: 'output', message: `fixing using solver: ${solver.message}`, type: 'info' });
                                        output({ category: 'output', message: `saved old fields in toUpdateLater: ${JSON.stringify(toUpdateLater[recordId])}`, type: 'info' });
                                        errorFixed = true;
                                        retryRecord = true;
                                    } else if (solver.action === 'skip') {
                                        output({ category: 'output', message: `skipping record ${recordId} of type ${sObjectName} using solver: ${solver.message}`, type: 'info' });
                                        errorFixed = true;
                                    } else if (solver.action === 'match') {
                                        output({ category: 'output', message: `matching record ${recordId} of type ${sObjectName} using solver: ${solver.message}`, type: 'info' });
                                        const matchId = new RegExp(solver.message).exec(e.message)?.[1];
                                        if (matchId) {
                                            migratedRecordId = matchId;
                                            errorFixed = true;
                                        }
                                    }
                                }
                            }
                            if (!errorFixed) {
                                // no solver found, ask user what to do
                                output({ category: 'output', message: `error: ${JSON.stringify(e)}`, type: 'info' });
                                const userInput = await input({ category: 'input', message: `no solver found for error: ${e.message}`, type: 'insert_error' });
                                if (userInput === 'f') {
                                    let fieldsToUpdate;
                                    while (!fieldsToUpdate) {
                                        const fieldsJson = await input({ category: 'input', message: 'Enter the fields to update in JSON format:', type: 'insert_error' });
                                        try {
                                            fieldsToUpdate = JSON.parse(fieldsJson);
                                        } catch (e) {
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
                                            if (!(recordId in toUpdateLater)) {
                                                toUpdateLater[recordId] = {
                                                    attributes: record.attributes
                                                } as SObjectRecord<Schema, string>;
                                            }
                                            toUpdateLater[recordId][field] = record[field];
                                            record[field] = fieldsToUpdate[field];
                                        }
                                        solver.changeFields.push({ field, value: fieldsToUpdate[field] });
                                    }
                                    retryRecord = true;
                                    errorFixed = true;
                                } else if (userInput === 'r') {
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
                                        } catch (e) {
                                            output({ category: 'output', message: `invalid JSON, please try again`, type: 'info' });
                                        }
                                    }
                                    if (!options.solvers) {
                                        options.solvers = [];
                                    }
                                    options.solvers.push(newSolver);
                                    anyRecordProcessed = true;
                                    break;
                                }
                            }
                            if (!(recordId in errors)) {
                                errors[recordId] = [];
                            }
                            errors[recordId].push({ message: e.message, fixed: errorFixed, solver });
                        }
                    } else {
                        output({ category: 'output', message: `record ${recordId} of type ${sObjectName} is not creatable`, type: 'info' });
                    }
                }
                if (retryRecord) {
                    continue;
                }
                old2new[recordId] = migratedRecordId!;
                delete recordsByIds[recordId];
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
                ...Object.fromEntries(Object.entries(record).filter(([key]) => key === 'attributes' || allLookupFieldsBySObjectType[record.attributes!.type]?.includes(key))),
                Id: Object.keys(recordsByIds).find(key => recordsByIds[key] === record)
            }));
            output({ category: 'output', message: `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, type: 'info' });
            const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
            if (toClear.length > 0) {
                output({ category: 'output', message: `found circular dependency: ${JSON.stringify(toClear)}`, type: 'info' });
                // clear the fields that are causing the circular dependency
                for (const clear of toClear) {
                    if (!(clear.recordId in toUpdateLater)) {
                        toUpdateLater[clear.recordId] = {
                            attributes: recordsByIds[clear.recordId].attributes
                        } as SObjectRecord<Schema, string>;
                    }
                    toUpdateLater[clear.recordId][clear.field] = recordsByIds[clear.recordId][clear.field];
                    recordsByIds[clear.recordId][clear.field] = '';

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
            if (field !== 'attributes' && record[field] in old2new) {
                record[field] = old2new[record[field]];
            }
        }
        record.Id = old2new[recordId];
        output({ category: 'output', message: `updating record ${recordId} of type ${record.attributes!.type} to ${JSON.stringify(record)}`, type: 'info' });
        await connB.sobject(record.attributes!.type).update(record as SObjectUpdateRecord<Schema, string>);
    }

    saveAndExit();
}

export { main, Options, IOEvent };