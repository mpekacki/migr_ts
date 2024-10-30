import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, Field } from 'jsforce';
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

async function main(options: Options, output: (output: string) => void) {
    output(`starting migration: ${JSON.stringify(options)}`);
    
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
        return describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix)?.name!;
    };

    let recordIdsToFetch = options.recordIds;
    const fetchedRecordsByIds: Record<string, any> = {};
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
            if (sObjectName) {
                const sobjectDescribe = await getSObjectDescribe(sObjectName);
                const relationships = options.relationships?.[sObjectName];
                const selector = connA.sobject(sObjectName).select('*');
                if (relationships) {
                    for (const relationship of relationships) {
                        selector.include(relationship.name);
                    }
                }
                selector.where(`Id = '${recordId}'`);
                output(`fetching record ${recordId} of type ${sObjectName}`);
                const records = await selector.execute();
                let fetchedRecord = records[0];
                const creatableFields = (await getSObjectDescribe(sObjectName)).fields.filter(field => field.createable);
                const record: Record<string, any> = {};
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
                    if (lookupValue) {
                        if (!(lookupValue in fetchedRecordsByIds) && !newRecordIdsToFetch.includes(lookupValue)) {
                            newRecordIdsToFetch.push(lookupValue);
                        }
                    }
                }
                if (relationships) {
                    for (const relationship of relationships) {
                        const relatedRecords = fetchedRecord[relationship.name]?.records;
                        output(`related records of ${relationship.name}: ${relatedRecords?.length}`);
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
        }
        recordIdsToFetch = newRecordIdsToFetch;
    }

    const toUpdateLater: Record<string, Record<string, any>> = {};
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
                            output(`record ${recordId} is not ready because lookup field ${lookupField.name} (${lookupValue}) is not migrated`);
                        } else if (lookupValue in old2new) {
                            output(`mapping ${lookupField.name} to ${lookupValue} for record ${recordId} of type ${sObjectName} - new value: ${old2new[lookupValue]}`);
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
                    const conditions: Record<string, any> = {};
                    for (const fieldMapping of matcher.fieldMappings) {
                        conditions[fieldMapping.targetField] = record[fieldMapping.sourceField];
                    }
                    const selector = connB.sobject(sObjectName).find(conditions).select('Id');
                    output(`querying for existing record: ${await selector.toSOQL()}`);
                    const migratedRecord = await selector.execute();
                    migratedRecordId = migratedRecord[0].Id!;
                    output(`found existing record ${migratedRecordId} of type ${sObjectName}`);
                } else {
                    const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable;
                    if (isObjectCreatable) {
                        output(`creating record ${recordId} of type ${sObjectName}`);
                        try {
                            const savedRecord: any = await connB.sobject(sObjectName).create(record);
                            migratedRecordId = savedRecord.id;
                        } catch (e: any) {
                            if (options.solvers) {
                                // find solver that matches the error message
                                const solver = options.solvers.find(solver => e.message.includes(solver.message));
                                if (solver) {
                                    toUpdateLater[recordId] = {
                                        attributes: record.attributes
                                    };
                                    for (const changeField of solver.changeFields) {
                                        toUpdateLater[recordId][changeField.field] = record[changeField.field];
                                        record[changeField.field] = changeField.value;
                                    }
                                    output(`fixing using solver: ${solver.message}`);
                                    output(`saved old fields in toUpdateLater: ${JSON.stringify(toUpdateLater[recordId])}`);
                                    anyRecordMigrated = true;
                                    continue;
                                }
                            }
                        }
                        output(`created record ${migratedRecordId} of type ${sObjectName}`);
                    } else {
                        output(`record ${recordId} of type ${sObjectName} is not creatable`);
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
            const uniqueSObjectTypes = [...new Set(Object.values(fetchedRecordsByIds).map(record => record.attributes?.type))];
            for (const sObjectName of uniqueSObjectTypes) {
                if (sObjectName) {
                    requiredLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                        .filter(field => field.type === 'reference' && !field.nillable && field.createable)
                        .map(field => field.name);
                    allLookupFieldsBySObjectType[sObjectName] = (await getSObjectDescribe(sObjectName)).fields
                        .filter(field => field.type === 'reference' && field.createable)
                        .map(field => field.name);
                }
            }
            const records = Object.values(fetchedRecordsByIds).map(record => ({
                attributes: record.attributes,
                ...Object.fromEntries(Object.entries(record).filter(([key]) => key === 'attributes' || allLookupFieldsBySObjectType[record.attributes?.type]?.includes(key))),
                Id: Object.keys(fetchedRecordsByIds).find(key => fetchedRecordsByIds[key] === record)
            }));
            output(`looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`);
            const toClear = scanForCircularDependency(records, requiredLookupFieldsBySObjectType);
            if (toClear.length > 0) {
                output(`found circular dependency: ${JSON.stringify(toClear)}`);
                // clear the fields that are causing the circular dependency
                for (const clear of toClear) {
                    if (!(clear.recordId in toUpdateLater)) {
                        toUpdateLater[clear.recordId] = {
                            attributes: fetchedRecordsByIds[clear.recordId].attributes
                        };
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
        output(`updating record ${recordId} of type ${record.attributes?.type} to ${JSON.stringify(record)}`);
        await connB.sobject(record.attributes?.type!).update(record as any);
    }

    fs.writeFileSync(historyFilePath, JSON.stringify(old2new, null, 2));
    output(JSON.stringify(old2new));
}

export { main, Options };