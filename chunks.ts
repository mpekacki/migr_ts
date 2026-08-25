import { SObjectRecord, Schema } from 'jsforce';

/**
 * The size of a record as the request will carry it, near enough to keep a chunk
 * under the body limit. Summing the string lengths rather than serializing the
 * record keeps this cheap for the ordinary case and, more to the point, avoids
 * building a second copy of a record whose file field is megabytes of base64.
 */
function recordSize(record: SObjectRecord<Schema, string>): number {
    let size = 0;
    for (const value of Object.values(record)) {
        size += typeof value === 'string' ? value.length : 16;
    }
    return size;
}

export default class Chunks {
    private systemSObjects: string[];
    private maxChunkSize: number;
    private maxSObjectTypeChunks: number;
    private maxChunkBytes: number;

    /**
     * `maxChunkBytes` bounds the request body, which matters for records carrying
     * files: a composite insert takes base64 blob fields, but the whole
     * non-multipart body is capped at 37.5 MB of base64. A record over the limit
     * on its own still travels alone rather than being dropped.
     */
    constructor(systemSObjects: string[], maxChunkSize: number, maxSObjectTypeChunks: number, maxChunkBytes: number = Infinity) {
        this.systemSObjects = systemSObjects;
        this.maxChunkSize = maxChunkSize;
        this.maxSObjectTypeChunks = maxSObjectTypeChunks;
        this.maxChunkBytes = maxChunkBytes;
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
            let currentChunkBytes = 0;
            for (const recordId of idsSortedBySObjectType) {
                const record = recs[recordId];
                if (record!.attributes!.type !== lastSObjectType) {
                    lastSObjectType = record!.attributes!.type;
                    numSObjectTypeChunks++;
                }
                currentChunkSize++;
                const bytes = this.maxChunkBytes === Infinity ? 0 : recordSize(record);
                currentChunkBytes += bytes;
                // A record over the limit by itself starts a chunk of its own rather
                // than looping forever trying to make room for it.
                const overBytes = currentChunkBytes > this.maxChunkBytes && currentChunkSize > 1;
                if (currentChunkSize > this.maxChunkSize || numSObjectTypeChunks > this.maxSObjectTypeChunks || overBytes) {
                    chunks.push(currentChunk);
                    currentChunk = {};
                    currentChunkSize = 1;
                    numSObjectTypeChunks = 1;
                    currentChunkBytes = bytes;
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
