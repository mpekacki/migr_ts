import Chunks from '../chunks';

describe('Chunks', () => {
    it('should return empty array if no records', () => {
        const chunks = new Chunks([], 200, 10);
        expect(chunks.getChunks({})).toEqual([]);
    });

    it('should return 1 chunk if there is only 1 record', () => {
        const chunks = new Chunks([], 200, 10);
        expect(chunks.getChunks({ '1': { "Name": "asdf", "attributes": { "type": "PermissionSetAssignment" } as any } })).toEqual([{ '1': { "Name": "asdf", "attributes": { "type": "PermissionSetAssignment" } } }]);
    });

    it('should organize records by sobject type and respect the number of sobject chunks', () => {
        const chunks = new Chunks([], 6, 3);
        const records = {
            '1': { "Name": "1", "attributes": { "type": "Case" } as any },
            '2': { "Name": "2", "attributes": { "type": "Account" } as any },
            '3': { "Name": "3", "attributes": { "type": "Case" } as any },
            '4': { "Name": "4", "attributes": { "type": "Account" } as any },
            '5': { "Name": "5", "attributes": { "type": "Quote" } as any },
            '6': { "Name": "6", "attributes": { "type": "Contact" } as any },
            '7': { "Name": "7", "attributes": { "type": "Quote" } as any },
            '8': { "Name": "8", "attributes": { "type": "Lead" } as any },
            '9': { "Name": "9", "attributes": { "type": "Account" } as any },
            '10': { "Name": "10", "attributes": { "type": "Opportunity" } as any },
            '11': { "Name": "11", "attributes": { "type": "Task" } as any },
            '12': { "Name": "12", "attributes": { "type": "Task" } as any },
            '13': { "Name": "13", "attributes": { "type": "Task" } as any },
            '14': { "Name": "14", "attributes": { "type": "Task" } as any },
            '15': { "Name": "15", "attributes": { "type": "Task" } as any },
            '16': { "Name": "16", "attributes": { "type": "Task" } as any },
            '17': { "Name": "17", "attributes": { "type": "Task" } as any },
        };
        expect(chunks.getChunks(records)).toEqual([
            {
                '2': { "Name": "2", "attributes": { "type": "Account" } as any },
                '4': { "Name": "4", "attributes": { "type": "Account" } as any },
                '9': { "Name": "9", "attributes": { "type": "Account" } as any },
                '1': { "Name": "1", "attributes": { "type": "Case" } as any },
                '3': { "Name": "3", "attributes": { "type": "Case" } as any },
                '6': { "Name": "6", "attributes": { "type": "Contact" } as any },
            },
            {
                '8': { "Name": "8", "attributes": { "type": "Lead" } as any },
                '10': { "Name": "10", "attributes": { "type": "Opportunity" } as any },
                '5': { "Name": "5", "attributes": { "type": "Quote" } as any },
                '7': { "Name": "7", "attributes": { "type": "Quote" } as any },
            },
            {
                '11': { "Name": "11", "attributes": { "type": "Task" } as any },
                '12': { "Name": "12", "attributes": { "type": "Task" } as any },
                '13': { "Name": "13", "attributes": { "type": "Task" } as any },
                '14': { "Name": "14", "attributes": { "type": "Task" } as any },
                '15': { "Name": "15", "attributes": { "type": "Task" } as any },
                '16': { "Name": "16", "attributes": { "type": "Task" } as any },
            },
            {
                '17': { "Name": "17", "attributes": { "type": "Task" } as any },
            }
        ]);
    });

    it('should respect the chunk size', () => {
        const chunks = new Chunks([], 3, 10);
        const records = {
            '1': { "Name": "1", "attributes": { "type": "Case" } as any },
            '2': { "Name": "2", "attributes": { "type": "Case" } as any },
            '3': { "Name": "3", "attributes": { "type": "Case" } as any },
            '4': { "Name": "4", "attributes": { "type": "Case" } as any },
            '5': { "Name": "5", "attributes": { "type": "Case" } as any },
            '6': { "Name": "6", "attributes": { "type": "Case" } as any },
            '7': { "Name": "7", "attributes": { "type": "Case" } as any },
            '8': { "Name": "8", "attributes": { "type": "Case" } as any },
            '9': { "Name": "9", "attributes": { "type": "Case" } as any },
            '10': { "Name": "10", "attributes": { "type": "Case" } as any },
        };
        expect(chunks.getChunks(records)).toEqual([
            {
                '1': { "Name": "1", "attributes": { "type": "Case" } as any },
                '2': { "Name": "2", "attributes": { "type": "Case" } as any },
                '3': { "Name": "3", "attributes": { "type": "Case" } as any },
            },
            {
                '4': { "Name": "4", "attributes": { "type": "Case" } as any },
                '5': { "Name": "5", "attributes": { "type": "Case" } as any },
                '6': { "Name": "6", "attributes": { "type": "Case" } as any },
            },
            {
                '7': { "Name": "7", "attributes": { "type": "Case" } as any },
                '8': { "Name": "8", "attributes": { "type": "Case" } as any },
                '9': { "Name": "9", "attributes": { "type": "Case" } as any },
            },
            {
                '10': { "Name": "10", "attributes": { "type": "Case" } as any },
            }
        ]);
    });

    it('should create 2 chunks for 211 records of the same type with chunk size 200', () => {
        const chunks = new Chunks([], 200, 10);
        const records: any = {};
        for (let i = 1; i <= 211; i++) {
            records[`record${i}`] = { "Name": `Record ${i}`, "attributes": { "type": "Custom_Object_D__c" } as any };
        }
        const result = chunks.getChunks(records);
        expect(result.length).toBe(2);
        expect(Object.keys(result[0]).length).toBe(200);
        expect(Object.keys(result[1]).length).toBe(11);
    });

    it('should start a new chunk when the byte limit is reached', () => {
        const chunks = new Chunks([], 200, 10, 100);
        const records = {
            '1': { "VersionData": "a".repeat(60), "attributes": { "type": "ContentVersion" } as any },
            '2': { "VersionData": "b".repeat(60), "attributes": { "type": "ContentVersion" } as any },
            '3': { "VersionData": "c".repeat(60), "attributes": { "type": "ContentVersion" } as any },
        };
        const result = chunks.getChunks(records);
        expect(result.map(chunk => Object.keys(chunk))).toEqual([['1'], ['2'], ['3']]);
    });

    it('should send a record over the byte limit on its own rather than dropping it', () => {
        const chunks = new Chunks([], 200, 10, 100);
        const records = {
            '1': { "VersionData": "a".repeat(500), "attributes": { "type": "ContentVersion" } as any },
            '2': { "Name": "small", "attributes": { "type": "ContentVersion" } as any },
        };
        const result = chunks.getChunks(records);
        expect(result.map(chunk => Object.keys(chunk))).toEqual([['1'], ['2']]);
    });

    it('should ignore record size when no byte limit is set', () => {
        const chunks = new Chunks([], 200, 10);
        const records = {
            '1': { "VersionData": "a".repeat(5000), "attributes": { "type": "ContentVersion" } as any },
            '2': { "VersionData": "b".repeat(5000), "attributes": { "type": "ContentVersion" } as any },
        };
        expect(chunks.getChunks(records)).toHaveLength(1);
    });

    it('should separate system objects from other objects', () => {
        const chunks = new Chunks(['User', 'Profile', 'Role', 'PermissionSet'], 5, 3);
        const records = {
            '1': { "Name": "1", "attributes": { "type": "Case" } as any },
            '2': { "Name": "2", "attributes": { "type": "Account" } as any },
            '3': { "Name": "3", "attributes": { "type": "User" } as any },
            '4': { "Name": "4", "attributes": { "type": "Profile" } as any },
            '5': { "Name": "5", "attributes": { "type": "Role" } as any },
            '6': { "Name": "6", "attributes": { "type": "PermissionSet" } as any },
            '7': { "Name": "7", "attributes": { "type": "User" } as any },
            '8': { "Name": "8", "attributes": { "type": "Profile" } as any },
            '9': { "Name": "9", "attributes": { "type": "User" } as any },
            '10': { "Name": "10", "attributes": { "type": "User" } as any },
            '11': { "Name": "11", "attributes": { "type": "Case" } as any },
            '12': { "Name": "12", "attributes": { "type": "Account" } as any },
            '13': { "Name": "13", "attributes": { "type": "User" } as any },
            '14': { "Name": "14", "attributes": { "type": "User" } as any },
            '15': { "Name": "15", "attributes": { "type": "User" } as any },
            '16': { "Name": "16", "attributes": { "type": "Case" } as any },
            '17': { "Name": "17", "attributes": { "type": "Case" } as any },
            '18': { "Name": "18", "attributes": { "type": "Quote" } as any },
            '19': { "Name": "19", "attributes": { "type": "Order" } as any },
            '20': { "Name": "20", "attributes": { "type": "Opportunity" } as any },
        };
        expect(chunks.getChunks(records)).toEqual([
            {
                '6': { "Name": "6", "attributes": { "type": "PermissionSet" } as any },
                '4': { "Name": "4", "attributes": { "type": "Profile" } as any },
                '8': { "Name": "8", "attributes": { "type": "Profile" } as any },
                '5': { "Name": "5", "attributes": { "type": "Role" } as any },
            },
            {
                '3': { "Name": "3", "attributes": { "type": "User" } as any },
                '7': { "Name": "7", "attributes": { "type": "User" } as any },
                '9': { "Name": "9", "attributes": { "type": "User" } as any },
                '10': { "Name": "10", "attributes": { "type": "User" } as any },
                '13': { "Name": "13", "attributes": { "type": "User" } as any },
            },
            {
                '14': { "Name": "14", "attributes": { "type": "User" } as any },
                '15': { "Name": "15", "attributes": { "type": "User" } as any },
            },
            {
                '2': { "Name": "2", "attributes": { "type": "Account" } as any },
                '12': { "Name": "12", "attributes": { "type": "Account" } as any },
                '1': { "Name": "1", "attributes": { "type": "Case" } as any },
                '11': { "Name": "11", "attributes": { "type": "Case" } as any },
                '16': { "Name": "16", "attributes": { "type": "Case" } as any },
            },
            {
                '17': { "Name": "17", "attributes": { "type": "Case" } as any },
                '20': { "Name": "20", "attributes": { "type": "Opportunity" } as any },
                '19': { "Name": "19", "attributes": { "type": "Order" } as any },
            },
            {
                '18': { "Name": "18", "attributes": { "type": "Quote" } as any },
            }
        ]);
    });
});
