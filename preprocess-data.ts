import { Schema, SObjectRecord } from "jsforce";

type PreprocessStrategy = {
    anonymizeEmailFields?: boolean;
}

export const preprocessData = (recordsByIds: Record<string, SObjectRecord<Schema, string>>, strategy: PreprocessStrategy) => {
    if (strategy.anonymizeEmailFields) {
        
    }
}
