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

    describe('sanitization mode', () => {
        it('should sanitize email with default domain', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    name: 'John Smith',
                    email: 'john.smith@gmail.com',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'sanitize'
                }
            });
            expect(recordsByIds['0012x0000000000'].name).toBe('John Smith');
            expect(recordsByIds['0012x0000000000'].email).toBe('john.smith.at.gmail.com@example.com');
        });

        it('should sanitize email with custom domain', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    name: 'Jane Doe',
                    email: 'jane.doe@company.org',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'sanitize',
                    domain: 'testdomain.com'
                }
            });
            expect(recordsByIds['0012x0000000000'].email).toBe('jane.doe.at.company.org@testdomain.com');
        });

        it('should sanitize multiple email fields in a record', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    primaryEmail: 'primary@test.com',
                    secondaryEmail: 'secondary@test.com',
                    name: 'Test User',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'sanitize',
                    domain: 'safe.example.com'
                }
            });
            expect(recordsByIds['0012x0000000000'].primaryEmail).toBe('primary.at.test.com@safe.example.com');
            expect(recordsByIds['0012x0000000000'].secondaryEmail).toBe('secondary.at.test.com@safe.example.com');
            expect(recordsByIds['0012x0000000000'].name).toBe('Test User');
        });

        it('should handle emails with multiple @ symbols', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    email: 'user@subdomain@domain.com',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'sanitize'
                }
            });
            // Should replace only the first @ symbol
            expect(recordsByIds['0012x0000000000'].email).toBe('user.at.subdomain@domain.com@example.com');
        });
    });

    describe('obfuscation mode', () => {
        it('should obfuscate email with default domain', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    email: 'test@example.com',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'obfuscate'
                }
            });
            expect(recordsByIds['0012x0000000000'].email).not.toBe('test@example.com');
            expect(recordsByIds['0012x0000000000'].email).toMatch(/^user[a-f0-9]{8}@example\.com$/);
        });

        it('should obfuscate email with custom domain', () => {
            const recordsByIds = {
                '0012x0000000000': {
                    email: 'john.doe@gmail.com',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'obfuscate',
                    domain: 'obfuscated.testdomain.com'
                }
            });
            expect(recordsByIds['0012x0000000000'].email).not.toBe('john.doe@gmail.com');
            expect(recordsByIds['0012x0000000000'].email).toMatch(/^user[a-f0-9]{8}@obfuscated\.testdomain\.com$/);
        });

        it('should consistently hash with obfuscate mode', () => {
            const recordsByIds1 = {
                '0012x0000000001': {
                    email: 'consistent@test.com',
                },
            };
            const recordsByIds2 = {
                '0012x0000000002': {
                    email: 'consistent@test.com',
                },
            };

            preprocessData(recordsByIds1, { emailAnonymization: { mode: 'obfuscate' } });
            preprocessData(recordsByIds2, { emailAnonymization: { mode: 'obfuscate' } });

            expect(recordsByIds1['0012x0000000001'].email).toBe(recordsByIds2['0012x0000000002'].email);
        });

        it('should produce different hashes for different email addresses', () => {
            const recordsByIds = {
                '0012x0000000001': {
                    email1: 'john.doe@example.com',
                    email2: 'jane.smith@example.com',
                },
            };

            preprocessData(recordsByIds, { emailAnonymization: { mode: 'obfuscate' } });

            expect(recordsByIds['0012x0000000001'].email1).not.toBe(recordsByIds['0012x0000000001'].email2);
            expect(recordsByIds['0012x0000000001'].email1).toMatch(/^user[a-f0-9]{8}@example\.com$/);
            expect(recordsByIds['0012x0000000001'].email2).toMatch(/^user[a-f0-9]{8}@example\.com$/);
        });

        it('should consistently hash with custom domain', () => {
            const recordsByIds1 = {
                '0012x0000000001': {
                    email: 'test@original.com',
                },
            };
            const recordsByIds2 = {
                '0012x0000000002': {
                    email: 'test@original.com',
                },
            };

            preprocessData(recordsByIds1, {
                emailAnonymization: {
                    mode: 'obfuscate',
                    domain: 'secure.custom.org'
                }
            });
            preprocessData(recordsByIds2, {
                emailAnonymization: {
                    mode: 'obfuscate',
                    domain: 'secure.custom.org'
                }
            });

            expect(recordsByIds1['0012x0000000001'].email).toBe(recordsByIds2['0012x0000000002'].email);
            expect(recordsByIds1['0012x0000000001'].email).toMatch(/^user[a-f0-9]{8}@secure\.custom\.org$/);
        });
    });

    describe('custom transformer', () => {
        it('should use custom transformer when provided', () => {
            const mockTransformer = jest.fn().mockReturnValue('custom@transformed.com');
            const recordsByIds = {
                '0012x0000000000': {
                    email: 'original@test.com',
                },
            };
            preprocessData(recordsByIds, {
                emailAnonymization: {
                    mode: 'sanitize',
                    customTransformer: mockTransformer
                }
            });
            expect(mockTransformer).toHaveBeenCalledWith('original@test.com');
            expect(recordsByIds['0012x0000000000'].email).toBe('custom@transformed.com');
        });
    });
});