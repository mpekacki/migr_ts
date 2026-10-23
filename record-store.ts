import { Schema, SObjectRecord } from 'jsforce';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Options } from './config';
import { loadSqlite } from './sqlite-store';

/**
 * Where a run keeps the records it fetched until they are migrated: the insert
 * queue (creatable fields only) and the fetched records (every field), file
 * contents included.
 *
 * By default that is memory, as it always was. `recordStore.type: 'sqlite'`
 * moves the record bodies into a scratch SQLite database instead, for a record
 * set too large to hold - only an index of ids and SObject types stays in
 * memory, so everything a table can answer without a record's fields (`has`,
 * `typeOf`, `size`, `ids`) costs no read.
 *
 * The one rule a caller must keep: what `get` hands back from a database is a
 * copy, so a change made to it is kept only by passing it to `set`. In memory
 * `get` hands back the record itself and forgetting the `set` goes unnoticed,
 * which is why the mock e2e suite runs every scenario against both.
 *
 * The database is scratch space, never a source: a run creates a new one, and
 * deletes it when it ends unless told to keep it for inspection. Encrypted, each
 * record is sealed with AES-256-GCM under a key that by default exists only for
 * the run - a database a crash leaves behind cannot be read by anyone. Setting
 * MIGR_TS_STORE_KEY derives the key from that passphrase instead, which is what
 * makes a kept, encrypted database readable afterwards ({@link dumpRecordStore}).
 */

type StoredRecord = SObjectRecord<Schema, string>;

/** The environment variable holding the passphrase an encrypted store's key is derived from. */
export const STORE_KEY_ENV = 'MIGR_TS_STORE_KEY';

const STORE_FORMAT_VERSION = '1';
const TABLES = ['queued', 'fetched'] as const;
type TableName = typeof TABLES[number];

export interface RecordTable {
    readonly size: number;
    has(id: string): boolean;
    /** The record's SObject type, without reading the record. */
    typeOf(id: string): string | undefined;
    /** In a database, a copy: changes to it are kept only by `set`. */
    get(id: string): StoredRecord | undefined;
    set(id: string, record: StoredRecord): void;
    delete(id: string): void;
    /** The ids held right now, in the order they were first set. */
    ids(): string[];
    /**
     * Every record, read one at a time over the ids held when the iteration
     * started - a record deleted in the meantime is passed over.
     */
    entries(): IterableIterator<[string, StoredRecord]>;
}

export interface RecordStore {
    /** The insert queue: the creatable fields of every record left to migrate. */
    readonly queued: RecordTable;
    /** Every field of each record as it was fetched, for matchers and exports. */
    readonly fetched: RecordTable;
    /** The database file, or null for the in-memory store. */
    readonly location: string | null;
    readonly encrypted: boolean;
    readonly keep: boolean;
    /** Releases the store; says whether that deleted its file. Safe to call twice. */
    close(): boolean;
}

/**
 * Rejects a recordStore block the run could not honour, before it has done any
 * work. Called from the runner's constructor, like the other config checks.
 */
export function validateRecordStoreOptions(options: Options): void {
    const store = options.recordStore;
    if (store === undefined) {
        return;
    }
    const type = store.type ?? 'memory';
    if (type !== 'memory' && type !== 'sqlite') {
        throw new Error(`recordStore.type must be 'memory' or 'sqlite', not '${type}'`);
    }
    if (type === 'memory') {
        // Encrypting or keeping a store that never reaches the disk would do
        // nothing at all - better to hear that than to believe it happened.
        const diskOnly = (['path', 'keep', 'encrypt'] as const).filter(key => store[key] !== undefined);
        if (diskOnly.length > 0) {
            throw new Error(`recordStore.${diskOnly.join(', recordStore.')} only apply to recordStore.type 'sqlite'`);
        }
        return;
    }
    try {
        loadSqlite();
    } catch {
        throw new Error(`recordStore.type 'sqlite' needs the built-in node:sqlite module (Node 22.5+); this is Node ${process.versions.node}`);
    }
    if (store.path !== undefined && fs.existsSync(store.path)) {
        throw new Error(`recordStore.path ${store.path} already exists; a run never reuses a record store - remove it or name another file`);
    }
    if (store.keep && store.encrypt && !process.env[STORE_KEY_ENV]) {
        throw new Error(`recordStore.keep with recordStore.encrypt needs ${STORE_KEY_ENV} set: without it the key is random and lost when the run ends, so the kept store could never be read`);
    }
}

/**
 * The store the config asks for. A database goes to `recordStore.path`, or by
 * default into `defaultDirectory` under a name no other run will pick.
 */
export function createRecordStore(options: Options, defaultDirectory: string, targetName: string): RecordStore {
    if ((options.recordStore?.type ?? 'memory') === 'memory') {
        return new MemoryStore();
    }
    const location = options.recordStore?.path ?? path.join(defaultDirectory, defaultFileName(targetName));
    return SqliteStore.create(location, options.recordStore?.encrypt ?? false, options.recordStore?.keep ?? false);
}

function defaultFileName(targetName: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${targetName}__records.${timestamp}-${crypto.randomBytes(3).toString('hex')}.db`;
}

class MemoryTable implements RecordTable {
    private readonly records = new Map<string, StoredRecord>();

    get size(): number {
        return this.records.size;
    }

    has(id: string): boolean {
        return this.records.has(id);
    }

    typeOf(id: string): string | undefined {
        return this.records.get(id)?.attributes?.type;
    }

    get(id: string): StoredRecord | undefined {
        return this.records.get(id);
    }

    set(id: string, record: StoredRecord): void {
        this.records.set(id, record);
    }

    delete(id: string): void {
        this.records.delete(id);
    }

    ids(): string[] {
        return [...this.records.keys()];
    }

    *entries(): IterableIterator<[string, StoredRecord]> {
        for (const id of this.ids()) {
            const record = this.records.get(id);
            if (record) {
                yield [id, record];
            }
        }
    }
}

class MemoryStore implements RecordStore {
    readonly queued = new MemoryTable();
    readonly fetched = new MemoryTable();
    readonly location = null;
    readonly encrypted = false;
    readonly keep = false;

    close(): boolean {
        return false;
    }
}

/**
 * AES-256-GCM, one fresh IV per value. The table and id a value belongs to are
 * its additional authenticated data, so a row moved under another id - or into
 * the other table - fails to open rather than passing for that record.
 */
class RecordCipher {
    private static readonly VERSION = 1;
    private static readonly IV_BYTES = 12;
    private static readonly TAG_BYTES = 16;

    constructor(private readonly key: Buffer) {}

    seal(context: string, plaintext: string): Buffer {
        const iv = crypto.randomBytes(RecordCipher.IV_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(context, 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return Buffer.concat([Buffer.from([RecordCipher.VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    }

    open(context: string, sealed: Uint8Array): string {
        const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
        if (bytes[0] !== RecordCipher.VERSION) {
            throw new Error(`Unknown record store encryption version ${bytes[0]}`);
        }
        const ivEnd = 1 + RecordCipher.IV_BYTES;
        const tagEnd = ivEnd + RecordCipher.TAG_BYTES;
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, ivEnd));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(bytes.subarray(ivEnd, tagEnd));
        return Buffer.concat([decipher.update(bytes.subarray(tagEnd)), decipher.final()]).toString('utf8');
    }
}

const KEY_CHECK_CONTEXT = 'meta:key_check';
const KEY_CHECK_PLAINTEXT = 'migr_ts record store';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.scryptSync(passphrase, salt, 32);
}

/** Stored as JSON text when not encrypted, so the database reads with any SQLite client. */
function encodeRecord(cipher: RecordCipher | null, table: TableName, id: string, record: StoredRecord): string | Buffer {
    const json = JSON.stringify(record);
    return cipher ? cipher.seal(`${table}:${id}`, json) : json;
}

function decodeRecord(cipher: RecordCipher | null, table: TableName, id: string, data: unknown): StoredRecord {
    const json = cipher ? cipher.open(`${table}:${id}`, data as Uint8Array) : String(data);
    return JSON.parse(json);
}

class SqliteTable implements RecordTable {
    /** id -> SObject type of every record the table holds, in the order they were first set. */
    private readonly index = new Map<string, string | undefined>();
    private readonly selectStatement: StatementSync;
    private readonly upsertStatement: StatementSync;
    private readonly deleteStatement: StatementSync;

    constructor(db: DatabaseSync, private readonly name: TableName, private readonly cipher: RecordCipher | null) {
        this.selectStatement = db.prepare(`SELECT data FROM ${name} WHERE id = ?`);
        this.upsertStatement = db.prepare(`INSERT INTO ${name} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`);
        this.deleteStatement = db.prepare(`DELETE FROM ${name} WHERE id = ?`);
    }

    get size(): number {
        return this.index.size;
    }

    has(id: string): boolean {
        return this.index.has(id);
    }

    typeOf(id: string): string | undefined {
        return this.index.get(id);
    }

    get(id: string): StoredRecord | undefined {
        if (!this.index.has(id)) {
            return undefined;
        }
        const row = this.selectStatement.get(id) as { data: unknown } | undefined;
        return row && decodeRecord(this.cipher, this.name, id, row.data);
    }

    set(id: string, record: StoredRecord): void {
        this.upsertStatement.run(id, encodeRecord(this.cipher, this.name, id, record));
        this.index.set(id, record.attributes?.type);
    }

    delete(id: string): void {
        if (this.index.delete(id)) {
            this.deleteStatement.run(id);
        }
    }

    ids(): string[] {
        return [...this.index.keys()];
    }

    *entries(): IterableIterator<[string, StoredRecord]> {
        for (const id of this.ids()) {
            const record = this.get(id);
            if (record) {
                yield [id, record];
            }
        }
    }
}

class SqliteStore implements RecordStore {
    readonly queued: SqliteTable;
    readonly fetched: SqliteTable;
    private closed = false;
    /**
     * Ctrl+C and fatal errors leave through process.exit, which runs no finally
     * blocks - but does emit 'exit', synchronously, which is all deleting a file
     * needs.
     */
    private readonly closeOnExit = () => {
        try {
            this.close();
        } catch {
            // Nothing left to report it to - the process is already going.
        }
    };

    private constructor(private readonly db: DatabaseSync, readonly location: string, private readonly cipher: RecordCipher | null, readonly keep: boolean) {
        this.queued = new SqliteTable(db, 'queued', cipher);
        this.fetched = new SqliteTable(db, 'fetched', cipher);
        process.on('exit', this.closeOnExit);
    }

    get encrypted(): boolean {
        return this.cipher !== null;
    }

    static create(location: string, encrypt: boolean, keep: boolean): SqliteStore {
        if (fs.existsSync(location)) {
            throw new Error(`Record store ${location} already exists; a run never reuses a record store`);
        }
        fs.mkdirSync(path.dirname(location), { recursive: true });
        const db = new (loadSqlite().DatabaseSync)(location);
        try {
            // Scratch space that no run ever resumes from: a crash loses nothing
            // that matters, so durability is traded for speed.
            db.exec('PRAGMA journal_mode = MEMORY');
            db.exec('PRAGMA synchronous = OFF');
            db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
            for (const table of TABLES) {
                db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, data)`);
            }
            const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
            insertMeta.run('format_version', STORE_FORMAT_VERSION);
            insertMeta.run('created_at', new Date().toISOString());

            let cipher: RecordCipher | null = null;
            if (encrypt) {
                const passphrase = process.env[STORE_KEY_ENV];
                const salt = crypto.randomBytes(16);
                cipher = new RecordCipher(passphrase ? deriveKey(passphrase, salt) : crypto.randomBytes(32));
                insertMeta.run('encryption', 'aes-256-gcm');
                insertMeta.run('key_source', passphrase ? 'passphrase' : 'random');
                insertMeta.run('salt', salt.toString('hex'));
                insertMeta.run('key_check', cipher.seal(KEY_CHECK_CONTEXT, KEY_CHECK_PLAINTEXT).toString('base64'));
            } else {
                insertMeta.run('encryption', 'none');
            }
            return new SqliteStore(db, location, cipher, keep);
        } catch (error) {
            db.close();
            removeDatabaseFiles(location);
            throw error;
        }
    }

    close(): boolean {
        if (this.closed) {
            return false;
        }
        this.closed = true;
        process.removeListener('exit', this.closeOnExit);
        this.db.close();
        if (this.keep) {
            return false;
        }
        removeDatabaseFiles(this.location);
        return true;
    }
}

/** The database and whatever SQLite keeps next to it. */
function removeDatabaseFiles(location: string): void {
    for (const file of [location, `${location}-journal`, `${location}-wal`, `${location}-shm`]) {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
}

/**
 * Everything a kept store holds, decrypted when it is encrypted - which takes
 * the passphrase it was created with in MIGR_TS_STORE_KEY. For inspection: it
 * reads the whole store into memory.
 */
export function dumpRecordStore(location: string): { queued: Record<string, StoredRecord>, fetched: Record<string, StoredRecord> } {
    if (!fs.existsSync(location)) {
        throw new Error(`Record store not found: ${location}`);
    }
    const db = new (loadSqlite().DatabaseSync)(location);
    try {
        const hasMeta = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'meta\'').all().length > 0;
        if (!hasMeta) {
            throw new Error(`${location} is not a migr_ts record store`);
        }
        const meta: Record<string, string> = {};
        for (const row of db.prepare('SELECT key, value FROM meta').all() as { key: string, value: string }[]) {
            meta[row.key] = row.value;
        }
        if (!('format_version' in meta) || !TABLES.every(table => db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').all(table).length > 0)) {
            throw new Error(`${location} is not a migr_ts record store`);
        }
        const cipher = meta.encryption === 'aes-256-gcm' ? storeCipher(location, meta) : null;
        const dump = { queued: {} as Record<string, StoredRecord>, fetched: {} as Record<string, StoredRecord> };
        for (const table of TABLES) {
            for (const row of db.prepare(`SELECT id, data FROM ${table} ORDER BY rowid`).all() as { id: string, data: unknown }[]) {
                dump[table][row.id] = decodeRecord(cipher, table, row.id, row.data);
            }
        }
        return dump;
    } finally {
        db.close();
    }
}

function storeCipher(location: string, meta: Record<string, string>): RecordCipher {
    if (meta.key_source !== 'passphrase') {
        throw new Error(`${location} was encrypted with a random key that ended with its run; it cannot be read`);
    }
    const passphrase = process.env[STORE_KEY_ENV];
    if (!passphrase) {
        throw new Error(`${location} is encrypted: set ${STORE_KEY_ENV} to the passphrase it was created with`);
    }
    const cipher = new RecordCipher(deriveKey(passphrase, Buffer.from(meta.salt, 'hex')));
    try {
        cipher.open(KEY_CHECK_CONTEXT, Buffer.from(meta.key_check, 'base64'));
    } catch {
        throw new Error(`${STORE_KEY_ENV} is not the passphrase ${location} was created with`);
    }
    return cipher;
}
