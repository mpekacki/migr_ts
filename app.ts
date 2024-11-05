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
    }[];
    relationships: {
        [sObjectType: string]: {
            name: string;
        }[];
    };
    solvers: {
        message: string;
        changeFields: {
            field: string;
            value: string;
        }[];
    }[];
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
    const fetchedRecordsByIds: Record<string, SObjectRecord<Schema, string>> = {};
    const lookupFieldsBySObjectType: Record<string, Field[]> = {};
    const old2new: Record<string, string> = {};

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
            const selector = connA.sobject(sObjectName).select('*');
            if (relationships) {
                for (const relationship of relationships) {
                    selector.include(relationship.name);
                }
            }
            selector.where(`Id = '${recordId}'`);
            output({ category: 'output', message: `fetching record ${recordId} of type ${sObjectName}`, type: 'info' });
            const records = await selector.execute();
            const fetchedRecord = records[0];
            const creatableFields = (await getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
            const record: SObjectRecord<Schema, string> = {};
            for (const field of creatableFields) {
                record[field.name] = fetchedRecord[field.name];
            }
            record.attributes = fetchedRecord.attributes;
            fetchedRecordsByIds[recordId] = record;
            const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
            if (lookupFields.length > 0) {
                lookupFieldsBySObjectType[sObjectName] = lookupFields;
            }
            for (const lookupField of lookupFields) {
                const lookupValue = record[lookupField.name];
                if (lookupValue && !(lookupValue in fetchedRecordsByIds) && !newRecordIdsToFetch.includes(lookupValue)) {
                    newRecordIdsToFetch.push(lookupValue);
                }
            }
            if (relationships) {
                for (const relationship of relationships) {
                    const relatedRecords = fetchedRecord[relationship.name]?.records;
                    output({ category: 'output', message: `related records of ${relationship.name}: ${relatedRecords?.length}`, type: 'info' });
                    if (relatedRecords) {
                        for (const relatedRecord of relatedRecords) {
                            if (!(relatedRecord.Id in fetchedRecordsByIds) && !newRecordIdsToFetch.includes(relatedRecord.Id!)) {
                                newRecordIdsToFetch.push(relatedRecord.Id!);
                            }
                        }
                    }
                }
            }
        }
        recordIdsToFetch = newRecordIdsToFetch;
    }

    output({ category: 'output', message: `fetched ${Object.keys(fetchedRecordsByIds).length} records`, type: 'info' });
    // print numbers of records by sobject type
    const sObjectTypes = [...new Set(Object.values(fetchedRecordsByIds).map(record => record.attributes?.type))];
    for (const sObjectType of sObjectTypes) {
        output({ category: 'output', message: `${sObjectType}: ${Object.values(fetchedRecordsByIds).filter(record => record.attributes?.type === sObjectType).length}`, type: 'info' });
    }

    // ask for confirmation
    const confirmation = await input({ category: 'input', message: 'Do you want to continue? (y/n)', type: 'confirm_migration' });
    output({ category: 'output', message: `confirmation: ${confirmation}`, type: 'info' });
    if (confirmation !== 'y') {
        output({ category: 'output', message: 'Aborted', type: 'info' });
        return;
    }

    const toUpdateLater: Record<string, SObjectRecord<Schema, string>> = {};
    while (Object.keys(fetchedRecordsByIds).length > 0) {
        let anyRecordMigrated = false;
        for (const recordId of Object.keys(fetchedRecordsByIds)) {
            const record = fetchedRecordsByIds[recordId];
            const sObjectName = await getSObjectType(recordId);
            let recordReady = true;
            const lookupFields = lookupFieldsBySObjectType[sObjectName];
            if (lookupFields) {
                for (const lookupField of lookupFields) {
                    const lookupValue = record[lookupField.name];
                    if (lookupValue) {
                        if (!(lookupValue in old2new) && lookupValue in fetchedRecordsByIds) {
                            recordReady = false;
                            output({ category: 'output', message: `record ${recordId} is not ready because lookup field ${lookupField.name} (${lookupValue}) is not migrated`, type: 'info' });
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
                let migratedRecordId = '';
                const matcher = options.matchers.find(matcher => matcher.sObjectType === sObjectName);
                if (matcher) {
                    const conditions: Record<string, string> = {};
                    for (const fieldMapping of matcher.fieldMappings) {
                        conditions[fieldMapping.targetField] = record[fieldMapping.sourceField];
                    }
                    const selector = connB.sobject(sObjectName).find(conditions).select('Id');
                    output({ category: 'output', message: `querying for existing record: ${await selector.toSOQL()}`, type: 'info' });
                    const migratedRecord = await selector.execute();
                    migratedRecordId = migratedRecord[0].Id!;
                    output({ category: 'output', message: `found existing record ${migratedRecordId} of type ${sObjectName}`, type: 'info' });
                } else {
                    const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable;
                    if (isObjectCreatable) {
                        output({ category: 'output', message: `creating record ${recordId} of type ${sObjectName}`, type: 'info' });
                        try {
                            const savedRecord: SaveResult = await connB.sobject(sObjectName).create(record);
                            migratedRecordId = savedRecord.id!;
                        } catch (e) {
                            if (options.solvers) {
                                // find solver that matches the error message
                                const solver = options.solvers.find(solver => e.message.includes(solver.message));
                                if (solver) {
                                    if (!(recordId in toUpdateLater)) {
                                        toUpdateLater[recordId] = {
                                            attributes: record.attributes
                                        } as SObjectRecord<Schema, string>;
                                    }
                                    for (const changeField of solver.changeFields) {
                                        toUpdateLater[recordId][changeField.field] = record[changeField.field];
                                        record[changeField.field] = changeField.value;
                                    }
                                    output({ category: 'output', message: `fixing using solver: ${solver.message}`, type: 'info' });
                                    output({ category: 'output', message: `saved old fields in toUpdateLater: ${JSON.stringify(toUpdateLater[recordId])}`, type: 'info' });
                                    anyRecordMigrated = true;
                                    continue;
                                }
                            }
                        }
                        output({ category: 'output', message: `created record ${migratedRecordId} of type ${sObjectName}`, type: 'info' });
                    } else {
                        output({ category: 'output', message: `record ${recordId} of type ${sObjectName} is not creatable`, type: 'info' });
                    }
                }
                old2new[recordId] = migratedRecordId!;
                delete fetchedRecordsByIds[recordId];
                anyRecordMigrated = true;
            }
        }
        if (!anyRecordMigrated) {
            // build lookupFieldsBySObjectType from object describes
            const requiredLookupFieldsBySObjectType: Record<string, string[]> = {};
            const allLookupFieldsBySObjectType: Record<string, string[]> = {};
            const uniqueSObjectTypes = [...new Set(Object.values(fetchedRecordsByIds).map(record => record.attributes!.type))];
            for (const sObjectName of uniqueSObjectTypes) {
                requiredLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                    .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                    .map(field => field.name);
                allLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                    .filter(field => field.type === 'reference' && field.createable)
                    .map(field => field.name);
            }
            const records = Object.values(fetchedRecordsByIds).map(record => ({
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(record).filter(([key]) => key === 'attributes' || allLookupFieldsBySObjectType[record.attributes!.type]?.includes(key))),
                Id: Object.keys(fetchedRecordsByIds).find(key => fetchedRecordsByIds[key] === record)
            }));
            output({ category: 'output', message: `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, type: 'info' });
            const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
            if (toClear.length > 0) {
                output({ category: 'output', message: `found circular dependency: ${JSON.stringify(toClear)}`, type: 'info' });
                // clear the fields that are causing the circular dependency
                for (const clear of toClear) {
                    if (!(clear.recordId in toUpdateLater)) {
                        toUpdateLater[clear.recordId] = {
                            attributes: fetchedRecordsByIds[clear.recordId].attributes
                        } as SObjectRecord<Schema, string>;
                    }
                    toUpdateLater[clear.recordId][clear.field] = fetchedRecordsByIds[clear.recordId][clear.field];
                    fetchedRecordsByIds[clear.recordId][clear.field] = '';

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

    fs.writeFileSync(historyFilePath, JSON.stringify(old2new, null, 2));
    output({ category: 'output', message: 'Finished', data: JSON.stringify(old2new), type: 'info' });
}

export { main, Options, IOEvent };