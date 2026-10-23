import type { DatabaseSync, StatementSync, SupportedValueType } from 'node:sqlite';
import * as fs from 'fs';

/**
 * Reads and writes the record sets that back `sourceSqlite` / `targetSqlite`.
 *
 * Records are stored one table per SObject type (`SELECT * FROM Account`) so an
 * export can be inspected and edited with any SQLite client. SQLite columns are
 * untyped and have no boolean, so the JS type of every field is kept in a side
 * table and used to restore the original values on import.
 *
 * Exporting to a database that already exists merges into it, so several
 * migrations can accumulate in one file; see {@link writeRecordsToSqlite}.
 */

export const SQLITE_FORMAT_VERSION = '1';

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };

let sqliteModule: SqliteModule | undefined;

/**
 * Loads `node:sqlite` on first use.
 *
 * The module is required lazily so runs that never touch `sourceSqlite` /
 * `targetSqlite` do not pay for it, and the ExperimentalWarning Node emits on
 * first load (Node 22 and 23) is swallowed: everything this CLI writes to
 * stdout/stderr is parsed as JSON by its callers and by the e2e tests, so a
 * stray warning line breaks them. `process.emitWarning` is called
 * synchronously while the module loads, so restoring it right after the
 * require is enough.
 */
export function loadSqlite(): SqliteModule {
    if (sqliteModule === undefined) {
        const originalEmitWarning = process.emitWarning;
        process.emitWarning = ((warning: string | Error, ...args: any[]) => {
            const message = typeof warning === 'string' ? warning : warning?.message ?? '';
            if (message.includes('SQLite is an experimental feature')) {
                return;
            }
            return (originalEmitWarning as any)(warning, ...args);
        }) as typeof process.emitWarning;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            sqliteModule = require('node:sqlite') as SqliteModule;
        } finally {
            process.emitWarning = originalEmitWarning;
        }
    }
    return sqliteModule;
}

const META_TABLE = '_migr_meta';
const FIELDS_TABLE = '_migr_fields';
const ID_COLUMN = 'Id';
/** The rowid as a page query selects it, under a name no SObject field can have. */
const ROWID_ALIAS = '_migr_rowid';

type ValueType = 'string' | 'number' | 'boolean' | 'json' | 'mixed';

// Column affinities chosen so values come back out the way they went in.
const COLUMN_AFFINITY: Record<ValueType, string> = {
    string: 'TEXT',
    number: 'NUMERIC',
    boolean: 'INTEGER',
    json: 'TEXT',
    mixed: '' // no affinity - store whatever is given, verbatim
};

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function valueTypeOf(value: any): ValueType {
    if (typeof value === 'boolean') {
        return 'boolean';
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return 'number';
    }
    if (typeof value === 'object') {
        return 'json';
    }
    return 'string';
}

function encodeValue(value: any): SupportedValueType {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return value;
    }
    return String(value);
}

function decodeValue(value: SupportedValueType, type: ValueType): any {
    if (value === null) {
        return null;
    }
    const plain = typeof value === 'bigint' ? Number(value) : value;
    switch (type) {
        case 'boolean':
            return plain === 1 || plain === '1' || plain === 'true';
        case 'number':
            return typeof plain === 'number' ? plain : Number(plain);
        case 'json':
            try {
                return JSON.parse(String(plain));
            } catch {
                return plain;
            }
        case 'string':
            return typeof plain === 'string' ? plain : String(plain);
        default:
            return plain;
    }
}

function mergeValueType(existing: ValueType | undefined, incoming: ValueType): ValueType {
    if (existing === undefined) {
        return incoming;
    }
    return existing === incoming ? existing : 'mixed';
}

/** Fields that are not stored as columns: the id is the primary key, the type is the table. */
function isReservedField(field: string): boolean {
    return field === 'attributes' || field === ID_COLUMN;
}

/**
 * Something {@link writeRecordsToSqlite} can read records from more than once:
 * each call starts the records over, as `[id, record]` pairs.
 */
export type RecordSource = () => Iterable<[string, any]>;

/**
 * Writes every record to `filePath`, merging with any database already there:
 * records only the database has are kept, records this run produced again are
 * replaced by their new version, so a second migration adds to the export
 * instead of wiping it. `records` is keyed by record id; each record carries
 * its SObject type in `attributes.type`, exactly like the JSON file format.
 *
 * `records` may also be a {@link RecordSource}, for a record set too large to
 * hold in memory: neither it nor the existing database is then read whole, at
 * the cost of reading each of them more than once - for the ids, for the
 * columns, and for the rows.
 *
 * The merged set is written to a temporary database that replaces `filePath`
 * only once it is complete, so a failed run cannot take the previous export
 * down with it.
 */
export function writeRecordsToSqlite(filePath: string, records: Record<string, any> | RecordSource): void {
    const source: RecordSource = typeof records === 'function' ? records as RecordSource : () => Object.entries(records);
    const hasExisting = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    if (hasExisting) {
        // A file that is not a migr_ts export has to make this throw rather than
        // be overwritten - and before any of the work, not after it.
        assertIsExport(filePath);
    }
    const exportedIds = new Set<string>();
    for (const [id] of source()) {
        exportedIds.add(id);
    }
    const merged: RecordSource = function* () {
        if (hasExisting) {
            for (const entry of iterateRecordsInSqlite(filePath)) {
                if (!exportedIds.has(entry[0])) {
                    yield entry;
                }
            }
        }
        yield* source();
    };
    const tempPath = `${filePath}.migr_ts_tmp`;
    if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
    }
    try {
        writeDatabase(tempPath, merged);
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw error;
    }
}

function assertIsExport(filePath: string): void {
    const db = new (loadSqlite().DatabaseSync)(filePath);
    try {
        assertHasFieldsTable(db, filePath);
    } finally {
        db.close();
    }
}

function assertHasFieldsTable(db: DatabaseSync, filePath: string): void {
    const hasFieldsTable = db
        .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?')
        .all(FIELDS_TABLE).length > 0;
    if (!hasFieldsTable) {
        throw new Error(`${filePath} is not a migr_ts SQLite export (missing ${FIELDS_TABLE} table)`);
    }
}

/**
 * Two passes over `records`: the first works out every table's columns, the
 * second writes the rows - so no more than one record is held at a time.
 */
function writeDatabase(filePath: string, records: RecordSource): void {
    const fieldTypesByType: Record<string, Record<string, ValueType>> = {};

    for (const [recordId, record] of records()) {
        const sObjectType = record?.attributes?.type;
        if (!sObjectType) {
            throw new Error(`Cannot export record ${recordId} to SQLite: missing attributes.type`);
        }
        if (!(sObjectType in fieldTypesByType)) {
            fieldTypesByType[sObjectType] = {};
        }

        const fieldTypes = fieldTypesByType[sObjectType];
        for (const [field, value] of Object.entries(record)) {
            if (isReservedField(field) || value === undefined) {
                continue;
            }
            if (value === null) {
                // Nulls carry no type information, but the column still has to exist.
                fieldTypes[field] = fieldTypes[field] ?? 'string';
                continue;
            }
            fieldTypes[field] = mergeValueType(fieldTypes[field], valueTypeOf(value));
        }
    }

    const db = new (loadSqlite().DatabaseSync)(filePath);
    try {
        db.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
        db.exec(`CREATE TABLE ${FIELDS_TABLE} (sobject_type TEXT NOT NULL, field_name TEXT NOT NULL, value_type TEXT NOT NULL, PRIMARY KEY (sobject_type, field_name))`);

        const insertMeta = db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
        insertMeta.run('format_version', SQLITE_FORMAT_VERSION);
        insertMeta.run('exported_at', new Date().toISOString());

        const insertField = db.prepare(`INSERT INTO ${FIELDS_TABLE} (sobject_type, field_name, value_type) VALUES (?, ?, ?)`);

        db.exec('BEGIN');
        try {
            const insertsByType: Record<string, { fields: string[], statement: StatementSync }> = {};
            for (const sObjectType of Object.keys(fieldTypesByType)) {
                const fieldTypes = fieldTypesByType[sObjectType];
                const fields = Object.keys(fieldTypes);

                const columns = [`${quoteIdentifier(ID_COLUMN)} TEXT PRIMARY KEY`];
                for (const field of fields) {
                    const affinity = COLUMN_AFFINITY[fieldTypes[field]];
                    columns.push(`${quoteIdentifier(field)}${affinity ? ' ' + affinity : ''}`);
                }
                db.exec(`CREATE TABLE ${quoteIdentifier(sObjectType)} (${columns.join(', ')})`);

                for (const field of fields) {
                    insertField.run(sObjectType, field, fieldTypes[field]);
                }

                const allColumns = [ID_COLUMN, ...fields];
                insertsByType[sObjectType] = {
                    fields,
                    statement: db.prepare(
                        `INSERT INTO ${quoteIdentifier(sObjectType)} (${allColumns.map(quoteIdentifier).join(', ')}) VALUES (${allColumns.map(() => '?').join(', ')})`
                    )
                };
            }

            for (const [recordId, record] of records()) {
                const { fields, statement } = insertsByType[record.attributes.type];
                const values: SupportedValueType[] = [recordId];
                for (const field of fields) {
                    values.push(encodeValue(record[field]));
                }
                statement.run(...values);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    } finally {
        db.close();
    }
}

/**
 * Reads back a database written by {@link writeRecordsToSqlite}, returning the
 * records keyed by id in the same shape as the JSON file format.
 */
export function readRecordsFromSqlite(filePath: string): Record<string, any> {
    const records: Record<string, any> = {};
    for (const [recordId, record] of iterateRecordsInSqlite(filePath)) {
        records[recordId] = record;
    }
    return records;
}

/** How many rows {@link iterateRecordsInSqlite} reads per query. */
const PAGE_SIZE = 500;

/**
 * The records of a database written by {@link writeRecordsToSqlite}, one at a
 * time and in the shape the JSON file format has them, so a large export can be
 * read without holding it whole. Tables go in name order, rows in the order
 * they were written.
 *
 * Each table is read a page at a time by rowid rather than through a statement
 * iterator, which needs a newer Node than the 22.5 this otherwise runs on.
 */
export function* iterateRecordsInSqlite(filePath: string): Generator<[string, any]> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`SQLite database not found: ${filePath}`);
    }

    const db = new (loadSqlite().DatabaseSync)(filePath);
    try {
        assertHasFieldsTable(db, filePath);

        const fieldTypesByType: Record<string, Record<string, ValueType>> = {};
        for (const row of db.prepare(`SELECT sobject_type, field_name, value_type FROM ${FIELDS_TABLE}`).all() as any[]) {
            const sObjectType = String(row.sobject_type);
            if (!(sObjectType in fieldTypesByType)) {
                fieldTypesByType[sObjectType] = {};
            }
            fieldTypesByType[sObjectType][String(row.field_name)] = String(row.value_type) as ValueType;
        }

        const tables = db
            .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'\\_%\' ESCAPE \'\\\' AND name NOT LIKE \'sqlite\\_%\' ESCAPE \'\\\' ORDER BY name')
            .all() as any[];

        for (const table of tables) {
            const sObjectType = String(table.name);
            const fieldTypes = fieldTypesByType[sObjectType] ?? {};
            const page = db.prepare(`SELECT rowid AS ${ROWID_ALIAS}, * FROM ${quoteIdentifier(sObjectType)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_SIZE}`);
            let lastRowid: SupportedValueType = 0;
            for (;;) {
                const rows = page.all(lastRowid) as any[];
                for (const row of rows) {
                    lastRowid = row[ROWID_ALIAS];
                    const recordId = String(row[ID_COLUMN]);
                    const record: Record<string, any> = {
                        attributes: { type: sObjectType, url: '' },
                        [ID_COLUMN]: recordId
                    };
                    for (const [column, value] of Object.entries(row)) {
                        if (column === ID_COLUMN || column === ROWID_ALIAS) {
                            continue;
                        }
                        record[column] = decodeValue(value as SupportedValueType, fieldTypes[column] ?? 'mixed');
                    }
                    yield [recordId, record];
                }
                if (rows.length < PAGE_SIZE) {
                    break;
                }
            }
        }
    } finally {
        db.close();
    }
}
