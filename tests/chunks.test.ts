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
        const chunks = new Chunks([], 200, 3);
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
            }
        ]);
    });
});
