import { test, expect, describe, afterEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRecordsFromSqlite, writeRecordsToSqlite, SQLITE_FORMAT_VERSION } from '../sqlite-store';

const tempFiles: string[] = [];

function tempDbPath(): string {
    const filePath = path.join(os.tmpdir(), `migr_ts_sqlite_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    tempFiles.push(filePath);
    return filePath;
}

afterEach(() => {
    while (tempFiles.length > 0) {
        const filePath = tempFiles.pop()!;
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

function record(sObjectType: string, fields: Record<string, any> = {}) {
    return { attributes: { type: sObjectType, url: '' }, ...fields };
}

describe('sqlite-store', () => {
    test('round-trips records of several SObject types', () => {
        const filePath = tempDbPath();
        const records = {
            '001000000000001AAA': record('Account', { Name: 'Cloud Kicks', NumberOfEmployees: 42 }),
            '001000000000002AAA': record('Account', { Name: 'Universal Containers', NumberOfEmployees: 7 }),
            '003000000000001AAA': record('Contact', { LastName: 'Doe', AccountId: '001000000000001AAA' })
        };

        writeRecordsToSqlite(filePath, records);
        const readBack = readRecordsFromSqlite(filePath);

        expect(Object.keys(readBack).sort()).toEqual(Object.keys(records).sort());
        expect(readBack['001000000000001AAA']).toEqual({
            attributes: { type: 'Account', url: '' },
            Id: '001000000000001AAA',
            Name: 'Cloud Kicks',
            NumberOfEmployees: 42
        });
        expect(readBack['003000000000001AAA'].AccountId).toBe('001000000000001AAA');
    });

    test('preserves JS value types', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '003000000000001AAA': record('Contact', {
                LastName: 'Doe',
                DoNotCall: true,
                HasOptedOutOfEmail: false,
                Birthdate: '1990-04-01',
                Latitude: 12.5,
                NumberOfChildren: 3,
                Description: null
            })
        });

        const readBack = readRecordsFromSqlite(filePath)['003000000000001AAA'];

        expect(readBack.DoNotCall).toBe(true);
        expect(readBack.HasOptedOutOfEmail).toBe(false);
        expect(readBack.Birthdate).toBe('1990-04-01');
        expect(readBack.Latitude).toBe(12.5);
        expect(readBack.NumberOfChildren).toBe(3);
        expect(readBack.Description).toBeNull();
    });

    test('stores each SObject type in its own queryable table', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            'a00000000000001AAA': record('Custom_Object_A__c', { Name: 'A1', Lookup_to_B__c: 'a01000000000001AAA' }),
            'a01000000000001AAA': record('Custom_Object_B__c', { Name: 'B1' })
        });

        const db = new DatabaseSync(filePath);
        try {
            const rows = db.prepare('SELECT "Id", "Name", "Lookup_to_B__c" FROM "Custom_Object_A__c"').all() as any[];
            expect(rows).toHaveLength(1);
            expect(rows[0].Id).toBe('a00000000000001AAA');
            expect(rows[0].Name).toBe('A1');
            expect(rows[0].Lookup_to_B__c).toBe('a01000000000001AAA');

            const version = db.prepare('SELECT value FROM _migr_meta WHERE key = ?').get('format_version') as any;
            expect(version.value).toBe(SQLITE_FORMAT_VERSION);
        } finally {
            db.close();
        }
    });

    test('skips undefined fields but keeps explicit nulls', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { Name: 'Cloud Kicks', Website: undefined, Phone: null })
        });

        const readBack = readRecordsFromSqlite(filePath)['001000000000001AAA'];

        expect(readBack).not.toHaveProperty('Website');
        expect(readBack.Phone).toBeNull();
    });

    test('creates a column for a field that is null on every record', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { Name: 'Cloud Kicks', Phone: null }),
            '001000000000002AAA': record('Account', { Name: 'Universal Containers', Phone: null })
        });

        const readBack = readRecordsFromSqlite(filePath);

        expect(readBack['001000000000001AAA'].Phone).toBeNull();
        expect(readBack['001000000000002AAA'].Phone).toBeNull();
    });

    test('fills in fields that only some records of a type have', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { Name: 'Cloud Kicks', Website: 'https://example.com' }),
            '001000000000002AAA': record('Account', { Name: 'Universal Containers' })
        });

        const readBack = readRecordsFromSqlite(filePath);

        expect(readBack['001000000000001AAA'].Website).toBe('https://example.com');
        expect(readBack['001000000000002AAA'].Website).toBeNull();
    });

    test('keeps values verbatim when a field holds mixed types', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { Odd_Field__c: 'text' }),
            '001000000000002AAA': record('Account', { Odd_Field__c: 17 })
        });

        const readBack = readRecordsFromSqlite(filePath);

        expect(readBack['001000000000001AAA'].Odd_Field__c).toBe('text');
        expect(readBack['001000000000002AAA'].Odd_Field__c).toBe(17);
    });

    test('round-trips object values as JSON', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { BillingAddress: { city: 'San Francisco', country: 'US' } })
        });

        const readBack = readRecordsFromSqlite(filePath)['001000000000001AAA'];

        expect(readBack.BillingAddress).toEqual({ city: 'San Francisco', country: 'US' });
    });

    test('replaces an existing database instead of appending to it', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {
            '001000000000001AAA': record('Account', { Name: 'Cloud Kicks' })
        });
        writeRecordsToSqlite(filePath, {
            '003000000000001AAA': record('Contact', { LastName: 'Doe' })
        });

        const readBack = readRecordsFromSqlite(filePath);

        expect(Object.keys(readBack)).toEqual(['003000000000001AAA']);
    });

    test('writes and reads an empty record set', () => {
        const filePath = tempDbPath();
        writeRecordsToSqlite(filePath, {});

        expect(readRecordsFromSqlite(filePath)).toEqual({});
    });

    test('throws when a record has no SObject type', () => {
        const filePath = tempDbPath();

        expect(() => writeRecordsToSqlite(filePath, { '001000000000001AAA': { Name: 'Cloud Kicks' } }))
            .toThrow(/missing attributes.type/);
    });

    test('throws when the database does not exist', () => {
        const filePath = path.join(os.tmpdir(), `migr_ts_missing_${Math.random().toString(36).slice(2)}.db`);

        expect(() => readRecordsFromSqlite(filePath)).toThrow(/not found/);
    });

    test('throws when the database is not a migr_ts export', () => {
        const filePath = tempDbPath();
        const db = new DatabaseSync(filePath);
        db.exec('CREATE TABLE something_else (a TEXT)');
        db.close();

        expect(() => readRecordsFromSqlite(filePath)).toThrow(/not a migr_ts SQLite export/);
    });
});
