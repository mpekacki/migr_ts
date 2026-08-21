import { DatabaseSync, SupportedValueType } from 'node:sqlite';
import * as fs from 'fs';

/**
 * Reads and writes the record sets that back `sourceSqlite` / `targetSqlite`.
 *
 * Records are stored one table per SObject type (`SELECT * FROM Account`) so an
 * export can be inspected and edited with any SQLite client. SQLite columns are
 * untyped and have no boolean, so the JS type of every field is kept in a side
 * table and used to restore the original values on import.
 */

export const SQLITE_FORMAT_VERSION = '1';

const META_TABLE = '_migr_meta';
const FIELDS_TABLE = '_migr_fields';
const ID_COLUMN = 'Id';

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
 * Writes every record to `filePath`, replacing any database already there.
 * `records` is keyed by record id; each record carries its SObject type in
 * `attributes.type`, exactly like the JSON file format.
 */
export function writeRecordsToSqlite(filePath: string, records: Record<string, any>): void {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    const recordIdsByType: Record<string, string[]> = {};
    const fieldTypesByType: Record<string, Record<string, ValueType>> = {};

    for (const [recordId, record] of Object.entries(records)) {
        const sObjectType = record?.attributes?.type;
        if (!sObjectType) {
            throw new Error(`Cannot export record ${recordId} to SQLite: missing attributes.type`);
        }
        if (!(sObjectType in recordIdsByType)) {
            recordIdsByType[sObjectType] = [];
            fieldTypesByType[sObjectType] = {};
        }
        recordIdsByType[sObjectType].push(recordId);

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

    const db = new DatabaseSync(filePath);
    try {
        db.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
        db.exec(`CREATE TABLE ${FIELDS_TABLE} (sobject_type TEXT NOT NULL, field_name TEXT NOT NULL, value_type TEXT NOT NULL, PRIMARY KEY (sobject_type, field_name))`);

        const insertMeta = db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
        insertMeta.run('format_version', SQLITE_FORMAT_VERSION);
        insertMeta.run('exported_at', new Date().toISOString());

        const insertField = db.prepare(`INSERT INTO ${FIELDS_TABLE} (sobject_type, field_name, value_type) VALUES (?, ?, ?)`);

        db.exec('BEGIN');
        try {
            for (const sObjectType of Object.keys(recordIdsByType)) {
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
                const insertRecord = db.prepare(
                    `INSERT INTO ${quoteIdentifier(sObjectType)} (${allColumns.map(quoteIdentifier).join(', ')}) VALUES (${allColumns.map(() => '?').join(', ')})`
                );
                for (const recordId of recordIdsByType[sObjectType]) {
                    const record = records[recordId];
                    const values: SupportedValueType[] = [recordId];
                    for (const field of fields) {
                        values.push(encodeValue(record[field]));
                    }
                    insertRecord.run(...values);
                }
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
    if (!fs.existsSync(filePath)) {
        throw new Error(`SQLite database not found: ${filePath}`);
    }

    const db = new DatabaseSync(filePath);
    try {
        const hasFieldsTable = db
            .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?')
            .all(FIELDS_TABLE).length > 0;
        if (!hasFieldsTable) {
            throw new Error(`${filePath} is not a migr_ts SQLite export (missing ${FIELDS_TABLE} table)`);
        }

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

        const records: Record<string, any> = {};
        for (const table of tables) {
            const sObjectType = String(table.name);
            const fieldTypes = fieldTypesByType[sObjectType] ?? {};
            const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(sObjectType)} ORDER BY rowid`).all() as any[];
            for (const row of rows) {
                const recordId = String(row[ID_COLUMN]);
                const record: Record<string, any> = {
                    attributes: { type: sObjectType, url: '' },
                    [ID_COLUMN]: recordId
                };
                for (const [column, value] of Object.entries(row)) {
                    if (column === ID_COLUMN) {
                        continue;
                    }
                    record[column] = decodeValue(value as SupportedValueType, fieldTypes[column] ?? 'mixed');
                }
                records[recordId] = record;
            }
        }
        return records;
    } finally {
        db.close();
    }
}
