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
        const chunks: Record<string, SObjectRecord<Schema, string>>[] = [];
        for (const recordId of Object.keys(records)) {
            const record = records[recordId];
            const chunkIndex = Math.floor(Object.keys(records).indexOf(recordId) / this.maxChunkSize);
            if (!chunks[chunkIndex]) {
                chunks[chunkIndex] = {};
            }
            chunks[chunkIndex][recordId] = record;
        }
        return chunks;
    }
}
