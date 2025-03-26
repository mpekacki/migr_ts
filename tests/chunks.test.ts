import Chunks from '../chunks';

describe('Chunks', () => {
    it('should return empty array if no records', () => {
        const chunks = new Chunks([], 200, 10);
        expect(chunks.getChunks({})).toEqual([]);
    });

    it('should return 1 chunk if there is only 1 record', () => {
        const chunks = new Chunks([], 200, 10);
        expect(chunks.getChunks({ '001JW00000gvuyEYAQ': { "Name": "asdf", "attributes": { "type": "PermissionSetAssignment" } as any } })).toEqual([{ '001JW00000gvuyEYAQ': { "Name": "asdf", "attributes": { "type": "PermissionSetAssignment" } } }]);
    });
});
