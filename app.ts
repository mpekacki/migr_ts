import { Connection, AuthInfo } from '@salesforce/core';
import { DescribeSObjectResult, Field } from 'jsforce';

interface Options {
    sourceOrg: string;
    targetOrg: string;
    recordId: string;
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
}

async function main(options: Options, output: (output: string) => void) {
    const allAuths = await AuthInfo.listAllAuthorizations();

    const orgAUsername = allAuths.find(auth => auth.aliases!.includes(options.sourceOrg))?.username;
    const orgBUsername = allAuths.find(auth => auth.aliases!.includes(options.targetOrg))?.username;

    const authInfoOptionsA: AuthInfo.Options = {
        username: orgAUsername!
    };
    const authInfoOptionsB: AuthInfo.Options = {
        username: orgBUsername!
    };
    const authInfoA = await AuthInfo.create(authInfoOptionsA);
    const authInfoB = await AuthInfo.create(authInfoOptionsB);

    const connA = await Connection.create({ authInfo: authInfoA });
    const connB = await Connection.create({ authInfo: authInfoB });

    const describeGlobal = await connA.describeGlobal();
    const sObjectDescribes: Record<string, DescribeSObjectResult> = {};
    async function getSObjectDescribe(sObjectName: string): Promise<DescribeSObjectResult> {
        if (!(sObjectName in sObjectDescribes)) {
            sObjectDescribes[sObjectName] = await connA.sobject(sObjectName).describe();
        }
        return sObjectDescribes[sObjectName];
    }

    let recordIdsToFetch = [options.recordId];
    const fetchedRecordsByIds: Record<string, any> = {};
    const lookupFieldsByObjectPrefix: Record<string, Field[]> = {};

    while (recordIdsToFetch.length > 0) {
        const newRecordIdsToFetch: string[] = [];
        for (const recordId of recordIdsToFetch) {
            const prefix = recordId.substring(0, 3);
            const sObjectName = describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix)?.name;
            if (sObjectName) {
                const sobjectDescribe = await getSObjectDescribe(sObjectName);
                const relationships = options.relationships[sObjectName];
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
                fetchedRecordsByIds[recordId] = record;
                const lookupFields = sobjectDescribe.fields.filter(field => field.type === 'reference');
                if (lookupFields.length > 0) {
                    lookupFieldsByObjectPrefix[prefix] = lookupFields;
                }
                for (const lookupField of lookupFields) {
                    const lookupValue = record[lookupField.name];
                    if (lookupValue) {
                        if (!(lookupValue in fetchedRecordsByIds) && !recordIdsToFetch.includes(lookupValue)) {
                            recordIdsToFetch.push(lookupValue);
                        }
                    }
                }
                if (relationships) {
                    for (const relationship of relationships) {
                        const relatedRecords = fetchedRecord[relationship.name]?.records;
                        output(`related records of ${relationship.name}: ${relatedRecords?.length}`);
                        if (relatedRecords) {
                            for (const relatedRecord of relatedRecords) {
                                if (!(relatedRecord.Id in fetchedRecordsByIds) && !recordIdsToFetch.includes(relatedRecord.Id!)) {
                                    recordIdsToFetch.push(relatedRecord.Id!);
                                }
                            }
                        }
                    }
                }
            }
        }
        recordIdsToFetch = newRecordIdsToFetch;
    }

    const old2new: Record<string, string> = {};
    while (Object.keys(fetchedRecordsByIds).length > 0) {
        for (const recordId of Object.keys(fetchedRecordsByIds)) {
            const record = fetchedRecordsByIds[recordId];
            const prefix = recordId.substring(0, 3);
            let recordReady = true;
            const lookupFields = lookupFieldsByObjectPrefix[prefix];
            if (lookupFields) {
                for (const lookupField of lookupFields) {
                    const lookupValue = record[lookupField.name];
                    if (lookupValue) {
                        if (!(lookupValue in old2new)) {
                            recordReady = false;
                        } else {
                            record[lookupField.name] = old2new[lookupValue];
                            if (record[lookupField.name] === '') {
                                delete record[lookupField.name];
                            }
                        }
                    }
                }
            }
            if (recordReady) {
                const sObjectName = describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix)?.name;
                if (sObjectName) {
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
                    } else {
                        const isObjectCreatable = (await getSObjectDescribe(sObjectName)).createable && !(['User', 'Profile'].includes(sObjectName));
                        if (isObjectCreatable) {
                            output(`creating record ${recordId} of type ${sObjectName}`);
                            const savedRecord: any = await connB.sobject(sObjectName).create(record);
                            migratedRecordId = savedRecord.id;
                            output(`created record ${migratedRecordId} of type ${sObjectName}`);
                        }
                    }
                    old2new[recordId] = migratedRecordId!;
                    delete fetchedRecordsByIds[recordId];
                }
            }
        }
    }
    
    output(JSON.stringify(old2new));
}

export { main, Options };