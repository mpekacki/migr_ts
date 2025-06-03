import { Schema, SObjectRecord } from "jsforce";

type PreprocessStrategy = {
    anonymizeEmailFields?: boolean;
}

export const preprocessData = (recordsByIds: Record<string, SObjectRecord<Schema, string>>, strategy: PreprocessStrategy) => {
    if (strategy.anonymizeEmailFields) {
        for (const recordId in recordsByIds) {
            const record = recordsByIds[recordId];
            for (const field in record) {
                // if value contains @, clear it
                if (record[field] && record[field].includes('@')) {
                    record[field] = '';
                }
            }
        }
    }
}
