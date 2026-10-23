import { test, expect, describe, afterEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Options } from '../config';
import { RecordStore, STORE_KEY_ENV, createRecordStore, dumpRecordStore, validateRecordStoreOptions } from '../record-store';

const stores: RecordStore[] = [];
const tempPaths: string[] = [];

function tempStorePath(): string {
    const filePath = path.join(os.tmpdir(), `migr_ts_store_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    tempPaths.push(filePath);
    return filePath;
}

function options(recordStore: Options['recordStore']): Options {
    return { targetOrg: 'target', recordIds: [], relatedRecordDepthLimit: 0, matchers: [], relationships: {}, solvers: [], recordStore };
}

function open(recordStore: Options['recordStore']): RecordStore {
    const store = createRecordStore(options(recordStore), os.tmpdir(), 'target');
    stores.push(store);
    return store;
}

function account(fields: Record<string, any> = {}) {
    return { attributes: { type: 'Account', url: '' }, ...fields } as any;
}

afterEach(() => {
    while (stores.length > 0) {
        stores.pop()!.close();
    }
    while (tempPaths.length > 0) {
        const filePath = tempPaths.pop()!;
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    delete process.env[STORE_KEY_ENV];
});

describe.each([
    ['memory', undefined],
    ['sqlite', { type: 'sqlite' as const, path: '' }],
    ['encrypted sqlite', { type: 'sqlite' as const, path: '', encrypt: true }],
])('a %s record table', (_name, recordStore) => {
    const openTable = () => open(recordStore && { ...recordStore, path: tempStorePath() }).queued;

    test('holds records by id', () => {
        const table = openTable();
        table.set('001000000000001AAA', account({ Name: 'Cloud Kicks', NumberOfEmployees: 42, IsActive__c: true }));

        expect(table.has('001000000000001AAA')).toBe(true);
        expect(table.has('001000000000002AAA')).toBe(false);
        expect(table.typeOf('001000000000001AAA')).toBe('Account');
        expect(table.get('001000000000001AAA')).toEqual(account({ Name: 'Cloud Kicks', NumberOfEmployees: 42, IsActive__c: true }));
        expect(table.get('001000000000002AAA')).toBeUndefined();
        expect(table.size).toBe(1);
    });

    test('keeps the order records were first set in', () => {
        const table = openTable();
        table.set('001000000000002AAA', account());
        table.set('001000000000001AAA', account());
        table.set('001000000000003AAA', account());
        table.set('001000000000002AAA', account({ Name: 'again' }));

        expect(table.ids()).toEqual(['001000000000002AAA', '001000000000001AAA', '001000000000003AAA']);
        expect([...table.entries()].map(([id]) => id)).toEqual(table.ids());
    });

    test('forgets a deleted record, also part way through an iteration', () => {
        const table = openTable();
        table.set('001000000000001AAA', account());
        table.set('001000000000002AAA', account());

        const seen: string[] = [];
        for (const [id] of table.entries()) {
            seen.push(id);
            table.delete('001000000000002AAA');
        }

        expect(seen).toEqual(['001000000000001AAA']);
        expect(table.has('001000000000002AAA')).toBe(false);
        expect(table.size).toBe(1);
        table.delete('001000000000009AAA');
        expect(table.size).toBe(1);
    });

    test('keeps a change once it is set', () => {
        const table = openTable();
        table.set('001000000000001AAA', account({ Name: 'Cloud Kicks' }));

        const record = table.get('001000000000001AAA')!;
        record.Name = 'Renamed';
        table.set('001000000000001AAA', record);

        expect(table.get('001000000000001AAA')!.Name).toBe('Renamed');
    });
});

describe('a record store on disk', () => {
    test('hands back copies, so a change is kept only by set', () => {
        const store = open({ type: 'sqlite', path: tempStorePath() });
        store.queued.set('001000000000001AAA', account({ Name: 'Cloud Kicks' }));

        store.queued.get('001000000000001AAA')!.Name = 'Lost';

        expect(store.queued.get('001000000000001AAA')!.Name).toBe('Cloud Kicks');
    });

    test('keeps the two tables apart', () => {
        const store = open({ type: 'sqlite', path: tempStorePath() });
        store.queued.set('001000000000001AAA', account({ Name: 'queued' }));
        store.fetched.set('001000000000001AAA', account({ Name: 'fetched', Formula__c: 'x' }));

        expect(store.queued.get('001000000000001AAA')!.Name).toBe('queued');
        expect(store.fetched.get('001000000000001AAA')!.Name).toBe('fetched');
        store.queued.delete('001000000000001AAA');
        expect(store.fetched.has('001000000000001AAA')).toBe(true);
    });

    test('is deleted when it closes', () => {
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location });
        store.queued.set('001000000000001AAA', account());
        expect(fs.existsSync(location)).toBe(true);

        expect(store.close()).toBe(true);

        expect(fs.existsSync(location)).toBe(false);
        expect(store.close()).toBe(false);
    });

    test('is deleted when the process exits without closing it', () => {
        const location = tempStorePath();
        open({ type: 'sqlite', path: location });

        process.emit('exit', 0);

        expect(fs.existsSync(location)).toBe(false);
    });

    test('stays when it is to be kept', () => {
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location, keep: true });
        store.queued.set('001000000000001AAA', account({ Name: 'Cloud Kicks' }));

        expect(store.close()).toBe(false);

        expect(fs.existsSync(location)).toBe(true);
        expect(dumpRecordStore(location).queued['001000000000001AAA'].Name).toBe('Cloud Kicks');
    });

    test('goes next to the history file under a name of its own by default', () => {
        const first = open({ type: 'sqlite' });
        const second = open({ type: 'sqlite' });

        expect(path.dirname(first.location!)).toBe(os.tmpdir());
        expect(path.basename(first.location!)).toMatch(/^target__records\..*\.db$/);
        expect(second.location).not.toBe(first.location);
    });

    test('is readable with any SQLite client when not encrypted', () => {
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location, keep: true });
        store.fetched.set('001000000000001AAA', account({ Name: 'Cloud Kicks' }));
        store.close();

        const db = new DatabaseSync(location);
        try {
            const row = db.prepare('SELECT data FROM fetched WHERE id = ?').get('001000000000001AAA') as any;
            expect(JSON.parse(row.data).Name).toBe('Cloud Kicks');
        } finally {
            db.close();
        }
    });
});

describe('an encrypted record store', () => {
    function keptEncryptedStore(passphrase: string) {
        process.env[STORE_KEY_ENV] = passphrase;
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location, keep: true, encrypt: true });
        return { location, store };
    }

    test('never writes a field value to disk in the clear', () => {
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location, encrypt: true });
        store.queued.set('001000000000001AAA', account({ Name: 'Very Secret Corp', Email__c: 'ceo@secret.example' }));
        store.fetched.set('001000000000001AAA', account({ Name: 'Very Secret Corp' }));

        const bytes = fs.readFileSync(location).toString('latin1');
        expect(bytes).not.toContain('Very Secret Corp');
        expect(bytes).not.toContain('ceo@secret.example');
        expect(bytes).not.toContain('Account');
        expect(store.queued.get('001000000000001AAA')!.Name).toBe('Very Secret Corp');
    });

    test('cannot be read once a random key is gone', () => {
        const location = tempStorePath();
        const store = open({ type: 'sqlite', path: location, encrypt: true });
        store.queued.set('001000000000001AAA', account());
        fs.copyFileSync(location, `${location}.copy`);
        tempPaths.push(`${location}.copy`);

        expect(() => dumpRecordStore(`${location}.copy`)).toThrow(/random key/);
    });

    test('reads back with the passphrase it was created with', () => {
        const { location, store } = keptEncryptedStore('correct horse');
        store.queued.set('001000000000001AAA', account({ Name: 'Cloud Kicks' }));
        store.fetched.set('001000000000001AAA', account({ Name: 'Cloud Kicks', Formula__c: 'x' }));
        store.close();

        expect(dumpRecordStore(location)).toEqual({
            queued: { '001000000000001AAA': account({ Name: 'Cloud Kicks' }) },
            fetched: { '001000000000001AAA': account({ Name: 'Cloud Kicks', Formula__c: 'x' }) },
        });
    });

    test('refuses a wrong passphrase, or none', () => {
        const { location, store } = keptEncryptedStore('correct horse');
        store.close();

        process.env[STORE_KEY_ENV] = 'battery staple';
        expect(() => dumpRecordStore(location)).toThrow(/not the passphrase/);
        delete process.env[STORE_KEY_ENV];
        expect(() => dumpRecordStore(location)).toThrow(new RegExp(`set ${STORE_KEY_ENV}`));
    });

    test('will not pass one record off as another', () => {
        const { location, store } = keptEncryptedStore('correct horse');
        store.queued.set('001000000000001AAA', account({ Name: 'One' }));
        store.queued.set('001000000000002AAA', account({ Name: 'Two' }));
        store.close();

        const db = new DatabaseSync(location);
        try {
            const two = db.prepare('SELECT data FROM queued WHERE id = ?').get('001000000000002AAA') as any;
            db.prepare('UPDATE queued SET data = ? WHERE id = ?').run(two.data, '001000000000001AAA');
        } finally {
            db.close();
        }

        expect(() => dumpRecordStore(location)).toThrow(/authenticate/);
    });
});

describe('validateRecordStoreOptions', () => {
    test('accepts no store, a memory store and a disk store', () => {
        expect(() => validateRecordStoreOptions(options(undefined))).not.toThrow();
        expect(() => validateRecordStoreOptions(options({ type: 'memory' }))).not.toThrow();
        expect(() => validateRecordStoreOptions(options({ type: 'sqlite', encrypt: true }))).not.toThrow();
    });

    test('refuses an unknown type', () => {
        expect(() => validateRecordStoreOptions(options({ type: 'disk' as any }))).toThrow(/must be 'memory' or 'sqlite', not 'disk'/);
    });

    test('refuses disk options for a store in memory', () => {
        expect(() => validateRecordStoreOptions(options({ encrypt: true }))).toThrow(/recordStore.encrypt only apply to recordStore.type 'sqlite'/);
    });

    test('refuses a path that already exists', () => {
        const location = tempStorePath();
        fs.writeFileSync(location, 'something precious');

        expect(() => validateRecordStoreOptions(options({ type: 'sqlite', path: location }))).toThrow(/already exists/);
        expect(fs.readFileSync(location, 'utf8')).toBe('something precious');
    });

    test('refuses to keep an encrypted store whose key would be lost', () => {
        expect(() => validateRecordStoreOptions(options({ type: 'sqlite', keep: true, encrypt: true }))).toThrow(new RegExp(`needs ${STORE_KEY_ENV}`));
        process.env[STORE_KEY_ENV] = 'correct horse';
        expect(() => validateRecordStoreOptions(options({ type: 'sqlite', keep: true, encrypt: true }))).not.toThrow();
    });
});
