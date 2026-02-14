import IOEvent from '../ioevent';
import { getFormatter } from '../ui/event-formatter';

describe('event-formatter', () => {
    describe('getFormatter(false) - normal mode', () => {
        const format = getFormatter(false);

        it('should format starting_migration', () => {
            const event = new IOEvent('output', 'starting_migration', { options: { recordIds: ['123'] } });
            expect(format(event)).toBe('starting migration: {"recordIds":["123"]}');
        });

        it('should format describing_sobject', () => {
            const event = new IOEvent('output', 'describing_sobject', { sObjectName: 'Account' });
            expect(format(event)).toBe('describing SObject Account');
        });

        it('should format checking_matchers', () => {
            const event = new IOEvent('output', 'checking_matchers');
            expect(format(event)).toBe('checking matchers');
        });

        it('should format records_so_far', () => {
            const event = new IOEvent('output', 'records_so_far', { count: 5 });
            expect(format(event)).toBe('records so far: 5');
        });

        it('should format depth', () => {
            const event = new IOEvent('output', 'depth', { depth: 3 });
            expect(format(event)).toBe('depth 3');
        });

        it('should format fetching_record with reason', () => {
            const event = new IOEvent('output', 'fetching_record', { recordId: '001', sObjectName: 'Account', reason: 'lookup' });
            expect(format(event)).toBe('fetching record 001 of type Account (via lookup)');
        });

        it('should format fetching_record without reason', () => {
            const event = new IOEvent('output', 'fetching_record', { recordId: '001', sObjectName: 'Account' });
            expect(format(event)).toBe('fetching record 001 of type Account');
        });

        it('should format record_not_found', () => {
            const event = new IOEvent('output', 'record_not_found', { recordId: '001', sObjectName: 'Account' });
            expect(format(event)).toBe('record 001 of type Account does not exist in the source org');
        });

        it('should format saving_records grouped by type', () => {
            const records = [
                { type: 'Account', name: 'ACME' },
                { type: 'Contact', name: 'John Smith' },
                { type: 'Account', name: 'Anthropic' },
                { type: 'Contact', name: 'Jane Doe' }
            ];
            const event = new IOEvent('output', 'saving_records', { records });
            const result = format(event);
            expect(result).toBe('saving 4 records:\nAccount (2): ACME, Anthropic\nContact (2): John Smith, Jane Doe');
        });

        it('should format saving_records with * for nameless records', () => {
            const records = [
                { type: 'CustomObject__c', name: '*' }
            ];
            const event = new IOEvent('output', 'saving_records', { records });
            const result = format(event);
            expect(result).toBe('saving 1 records:\nCustomObject__c (1): *');
        });

        it('should format insert_error with options', () => {
            const event = new IOEvent('input', 'insert_error', { recordId: '001', error: 'duplicate value' });
            const result = format(event);
            expect(result).toContain('recordId: 001');
            expect(result).toContain('duplicate value');
            expect(result).toContain('Fix (f)');
            expect(result).toContain('Skip (s)');
        });

        it('should format insert_error without recordId as generic input prompt', () => {
            const event = new IOEvent('input', 'insert_error', {});
            expect(format(event)).toBe('Enter input:');
        });

        it('should format error', () => {
            const event = new IOEvent('output', 'error', { message: 'something went wrong' });
            expect(format(event)).toBe('error: something went wrong');
        });

        it('should format aborted', () => {
            const event = new IOEvent('output', 'aborted');
            expect(format(event)).toBe('aborted');
        });

        it('should format using_solver with fix action', () => {
            const event = new IOEvent('output', 'using_solver', { error: 'err', solverMessage: 'fix it', solverAction: 'fix' });
            expect(format(event)).toBe('fixing using solver: fix it');
        });

        it('should format using_solver with match action', () => {
            const event = new IOEvent('output', 'using_solver', { recordId: '001', solver: 'mySolver', solverAction: 'match' });
            expect(format(event)).toBe('matching record 001 using solver: mySolver');
        });

        it('should format using_solver with skip action', () => {
            const event = new IOEvent('output', 'using_solver', { recordId: '001', solver: 'mySolver', solverAction: 'skip' });
            expect(format(event)).toBe('skipping record 001 using solver: mySolver');
        });

        it('should format using_solver with extract_column action', () => {
            const event = new IOEvent('output', 'using_solver', { error: 'bad field', solverMessage: 'extract', solverAction: 'extract_column' });
            expect(format(event)).toBe('extracting column name from error: bad field');
        });

        it('should format using_solver with append_random action', () => {
            const event = new IOEvent('output', 'using_solver', { recordId: '001', solver: 'mySolver', solverAction: 'append_random' });
            expect(format(event)).toBe('appending random to record 001 using solver: mySolver');
        });

        it('should format updating_record with type counts', () => {
            const records = [
                { attributes: { type: 'Account' }, Id: '001' }
            ];
            const event = new IOEvent('output', 'updating_record', {
                recordCountsByType: { Account: 1 },
                records
            });
            const result = format(event);
            expect(result).toContain('updating 1 records');
            expect(result).toContain('1 Account');
        });

        it('should format invalid_json', () => {
            const event = new IOEvent('output', 'invalid_json');
            expect(format(event)).toBe('invalid JSON, please try again');
        });

        it('should format invalid_regex', () => {
            const event = new IOEvent('output', 'invalid_regex');
            expect(format(event)).toBe('invalid regex, please try again');
        });
    });

    describe('getFormatter(true) - debug mode', () => {
        const format = getFormatter(true);

        it('should return JSON.stringify of the event', () => {
            const event = new IOEvent('output', 'checking_matchers');
            expect(format(event)).toBe(JSON.stringify(event));
        });

        it('should include data in JSON output', () => {
            const event = new IOEvent('output', 'error', { message: 'test' });
            const result = format(event);
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe('error');
            expect(parsed.data.message).toBe('test');
        });
    });
});
