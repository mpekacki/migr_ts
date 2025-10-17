import { Schema, SObjectRecord } from "jsforce";
import { createHash } from "crypto";

type PreprocessStrategy = {
    anonymizeEmailFields?: boolean;
    emailObfuscator?: (email: string) => string;
}

const defaultEmailObfuscator = (email: string): string => {
    const hash = createHash('sha256').update(email.toLowerCase()).digest('hex');
    const shortHash = hash.substring(0, 8);
    return `user${shortHash}@obfuscated.example.com`;
};

export const preprocessData = (recordsByIds: Record<string, SObjectRecord<Schema, string>>, strategy: PreprocessStrategy) => {
    if (strategy.anonymizeEmailFields) {
        const obfuscator = strategy.emailObfuscator || defaultEmailObfuscator;
        for (const recordId in recordsByIds) {
            const record = recordsByIds[recordId];
            for (const field in record) {
                // if value contains @, obfuscate it
                if (record[field] && typeof record[field] === 'string' && record[field].includes('@')) {
                    record[field] = obfuscator(record[field] as string);
                }
            }
        }
    }
}
