import { Connection, AuthInfo } from '@salesforce/core';
import { Field } from 'jsforce';

async function main(orgA: string, orgB: string, recordId: string, onOutput: (output: string) => void) {
    const allAuths = await AuthInfo.listAllAuthorizations();

    const orgAUsername = allAuths.find(auth => auth.aliases!.includes(orgA))?.username;
    const orgBUsername = allAuths.find(auth => auth.aliases!.includes(orgB))?.username;

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

    let recordIdsToFetch = [recordId];
    const fetchedRecordsByIds: Record<string, any> = {};
    const lookupFieldsByObjectPrefix: Record<string, Field[]> = {};

    while (recordIdsToFetch.length > 0) {
        const newRecordIdsToFetch: string[] = [];
        for (const recordId of recordIdsToFetch) {
            const prefix = recordId.substring(0, 3);
            const sObjectName = describeGlobal.sobjects.find(sobject => sobject.keyPrefix === prefix)?.name;
            if (sObjectName) {
                const sobjectDescribe = await connA.sobject(sObjectName).describe();
                console.log(`fetching record ${recordId} of type ${sObjectName}`);
                let record = await connA.sobject(sObjectName).retrieve(recordId);
                const creatableFields = (await connA.sobject(sObjectName).describe()).fields.filter(field => field.createable);
                const newRecord: Record<string, any> = {};
                for (const field of creatableFields) {
                    newRecord[field.name] = record[field.name];
                }
                record = newRecord;
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
                    const isObjectCreatable = (await connA.sobject(sObjectName).describe()).createable && !(['User', 'Profile'].includes(sObjectName));
                    if (isObjectCreatable) {
                        console.log(`creating record ${recordId} of type ${sObjectName}`);
                        const savedRecord: any = await connB.sobject(sObjectName).create(record);
                        migratedRecordId = savedRecord.id;
                        console.log(`created record ${migratedRecordId} of type ${sObjectName}`);
                    }
                    old2new[recordId] = migratedRecordId!;
                    delete fetchedRecordsByIds[recordId];
                }
            }
        }
    }
    
    onOutput(JSON.stringify(old2new));
}

export { main };