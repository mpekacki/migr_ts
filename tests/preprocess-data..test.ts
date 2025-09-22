import { preprocessData } from "../preprocess-data";

describe('preprocessData', () => {
    it('should not modify records if no strategy is provided', () => {
        const recordsByIds = {
            '0012x0000000000': {
                name: 'John Smith',
                email: 'test@example.com',
            },
        };
        preprocessData(recordsByIds, {});
        expect(recordsByIds['0012x0000000000'].name).toBe('John Smith');
        expect(recordsByIds['0012x0000000000'].email).toBe('test@example.com');
    });

    it('should anonymize email fields', () => {
        const recordsByIds = {
            '0012x0000000000': {
                name: 'John Smith',
                email: 'test@example.com',
            },
        };
        preprocessData(recordsByIds, {
            anonymizeEmailFields: true,
        });
        expect(recordsByIds['0012x0000000000'].name).toBe('John Smith');
        expect(recordsByIds['0012x0000000000'].email).not.toBe('test@example.com');
        expect(recordsByIds['0012x0000000000'].email).toContain('@');
    });

    it('should use custom email obfuscator when provided', () => {
        const mockObfuscator = jest.fn().mockReturnValue('mockuser@test.com');
        const recordsByIds = {
            '0012x0000000000': {
                name: 'John Smith',
                email: 'test@example.com',
            },
        };
        preprocessData(recordsByIds, {
            anonymizeEmailFields: true,
            emailObfuscator: mockObfuscator,
        });
        expect(mockObfuscator).toHaveBeenCalledWith('test@example.com');
        expect(recordsByIds['0012x0000000000'].email).toBe('mockuser@test.com');
    });

    it('should consistently hash the same email address', () => {
        const recordsByIds1 = {
            '0012x0000000001': {
                email: 'john.doe@example.com',
            },
        };
        const recordsByIds2 = {
            '0012x0000000002': {
                email: 'john.doe@example.com',
            },
        };

        preprocessData(recordsByIds1, { anonymizeEmailFields: true });
        preprocessData(recordsByIds2, { anonymizeEmailFields: true });

        expect(recordsByIds1['0012x0000000001'].email).toBe(recordsByIds2['0012x0000000002'].email);
        expect(recordsByIds1['0012x0000000001'].email).toMatch(/^user[a-f0-9]{8}@obfuscated\.local$/);
    });

    it('should produce different hashes for different email addresses', () => {
        const recordsByIds = {
            '0012x0000000001': {
                email1: 'john.doe@example.com',
                email2: 'jane.smith@example.com',
            },
        };

        preprocessData(recordsByIds, { anonymizeEmailFields: true });

        expect(recordsByIds['0012x0000000001'].email1).not.toBe(recordsByIds['0012x0000000001'].email2);
        expect(recordsByIds['0012x0000000001'].email1).toMatch(/^user[a-f0-9]{8}@obfuscated\.local$/);
        expect(recordsByIds['0012x0000000001'].email2).toMatch(/^user[a-f0-9]{8}@obfuscated\.local$/);
    });
});