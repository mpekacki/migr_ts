import { SObjectRecord, Schema } from 'jsforce';

/**
 * The size of a record as the request will carry it, near enough to keep a chunk
 * under the body limit. Summing the string lengths rather than serializing the
 * record keeps this cheap for the ordinary case and, more to the point, avoids
 * building a second copy of a record whose file field is megabytes of base64.
 */
export function recordSize(record: SObjectRecord<Schema, string>): number {
    let size = 0;
    for (const value of Object.values(record)) {
        size += typeof value === 'string' ? value.length : 16;
    }
    return size;
}

/**
 * What chunking needs to know about a record, without the record itself: a
 * caller that keeps its records on disk can plan the chunks first and read each
 * one's records only when it is about to send them.
 */
export interface ChunkEntry {
    id: string;
    sObjectType: string;
    /** {@link recordSize}; only read when the chunks are bounded in bytes. */
    bytes: number;
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

    /** Whether the chunks are bounded in bytes, which is when a {@link ChunkEntry} needs its `bytes`. */
    get countsBytes(): boolean {
        return this.maxChunkBytes !== Infinity;
    }

    public getChunks(records: Record<string, SObjectRecord<Schema, string>>): Record<string, SObjectRecord<Schema, string>>[] {
        const entries = Object.keys(records).map(id => ({
            id,
            sObjectType: records[id]!.attributes!.type,
            bytes: this.countsBytes ? recordSize(records[id]) : 0
        }));
        return this.getChunkIds(entries).map(ids => {
            const chunk: Record<string, SObjectRecord<Schema, string>> = {};
            for (const id of ids) {
                chunk[id] = records[id];
            }
            return chunk;
        });
    }

    /** {@link getChunks}, planned from what is known about each record rather than from the records. */
    public getChunkIds(entries: ChunkEntry[]): string[][] {
        const systemEntries: ChunkEntry[] = [];
        const nonSystemEntries: ChunkEntry[] = [];
        for (const entry of entries) {
            if (this.systemSObjects.includes(entry.sObjectType)) {
                systemEntries.push(entry);
            } else {
                nonSystemEntries.push(entry);
            }
        }
        const chunks: string[][] = [];
        for (const group of [systemEntries, nonSystemEntries]) {
            const sortedBySObjectType = [...group].sort((a, b) => {
                if (a.sObjectType === b.sObjectType) {
                    return 0;
                }
                return a.sObjectType.localeCompare(b.sObjectType);
            });

            let currentChunk: string[] = [];
            let lastSObjectType: string | null = null;
            let numSObjectTypeChunks = 0;
            let currentChunkSize = 0;
            let currentChunkBytes = 0;
            for (const entry of sortedBySObjectType) {
                if (entry.sObjectType !== lastSObjectType) {
                    lastSObjectType = entry.sObjectType;
                    numSObjectTypeChunks++;
                }
                currentChunkSize++;
                const bytes = this.countsBytes ? entry.bytes : 0;
                currentChunkBytes += bytes;
                // A record over the limit by itself starts a chunk of its own rather
                // than looping forever trying to make room for it.
                const overBytes = currentChunkBytes > this.maxChunkBytes && currentChunkSize > 1;
                if (currentChunkSize > this.maxChunkSize || numSObjectTypeChunks > this.maxSObjectTypeChunks || overBytes) {
                    chunks.push(currentChunk);
                    currentChunk = [];
                    currentChunkSize = 1;
                    numSObjectTypeChunks = 1;
                    currentChunkBytes = bytes;
                }
                currentChunk.push(entry.id);
            }
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
            }
        }
        return chunks;
    }
}
