import { SObjectRecord, Schema } from 'jsforce';

export default class Chunks {
    private systemSObjects: string[];
    private maxChunkSize: number;
    private maxSObjectTypeChunks: number;

    constructor(systemSObjects: string[], maxChunkSize: number, maxSObjectTypeChunks: number) {
        this.systemSObjects = systemSObjects;
        this.maxChunkSize = maxChunkSize;
        this.maxSObjectTypeChunks = maxSObjectTypeChunks;
    }

    public getChunks(records: Record<string, SObjectRecord<Schema, string>>): Record<string, SObjectRecord<Schema, string>>[] {
        const systemRecords: Record<string, SObjectRecord<Schema, string>> = {};
        const nonSystemRecords: Record<string, SObjectRecord<Schema, string>> = {};
        for (const recordId of Object.keys(records)) {
            const record = records[recordId];
            if (this.systemSObjects.includes(record!.attributes!.type)) {
                systemRecords[recordId] = record;
            } else {
                nonSystemRecords[recordId] = record;
            }
        }
        const chunks: Record<string, SObjectRecord<Schema, string>>[] = [];
        for (const recs of [systemRecords, nonSystemRecords]) {
            const idsSortedBySObjectType: string[] = Object.keys(recs).sort((a, b) => {
                const aSObjectType = recs[a]!.attributes!.type;
                const bSObjectType = recs[b]!.attributes!.type;
                if (aSObjectType === bSObjectType) {
                    return 0;
                }
                return aSObjectType.localeCompare(bSObjectType);
            });

            let currentChunk: Record<string, SObjectRecord<Schema, string>> = {};
            let lastSObjectType: string | null = null;
            let numSObjectTypeChunks = 0;
            let currentChunkSize = 0;
            for (const recordId of idsSortedBySObjectType) {
                const record = recs[recordId];
                if (record!.attributes!.type !== lastSObjectType) {
                    lastSObjectType = record!.attributes!.type;
                    numSObjectTypeChunks++;
                }
                currentChunkSize++;
                if (currentChunkSize > this.maxChunkSize || numSObjectTypeChunks > this.maxSObjectTypeChunks) {
                    chunks.push(currentChunk);
                    currentChunk = {};
                    currentChunkSize = 1;
                    numSObjectTypeChunks = 1;
                }
                currentChunk[recordId] = record;
            }
            if (Object.keys(currentChunk).length > 0) {
                chunks.push(currentChunk);
            }
        }
        return chunks;
    }
}
