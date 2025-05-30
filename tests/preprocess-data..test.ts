import { preprocessData } from "../preprocess-data";

describe('preprocessData', () => {
    it('should not modify records if no strategy is provided', () => {
        const recordsByIds = {
            '0012x0000000000': {
                email: 'test@example.com',
            },
        };
        preprocessData(recordsByIds);
        expect(recordsByIds['0012x0000000000'].email).toBe('test@example.com');
    });

    it('should anonymize email fields', () => {
        const recordsByIds = {
            '0012x0000000000': {
                email: 'test@example.com',
            },
        };
        preprocessData(recordsByIds, {
            anonymizeEmailFields: true,
        });
        expect(recordsByIds['0012x0000000000'].email).not.toBe('test@example.com');
    });
});