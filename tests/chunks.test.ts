import Chunks from '../chunks';

describe('Chunks', () => {
    it('should return empty array if no records', () => {
        const chunks = new Chunks([], 200, 10);
        expect(chunks.getChunks({})).toEqual([]);
    });
});
