import IO from "../io";
import IOEvent from "../ioevent";

describe('IO', () => {
    const createIO = () => {
        const output: IOEvent[] = [];
        const input: IOEvent[] = [];
        const io = new IO((event: IOEvent) => {
            output.push(event);
        }, (event: IOEvent) => {
            input.push(event);
            return Promise.resolve('');
        });
        return {io, output, input};
    };

    it('should emit checking_matchers event', () => {
        const {io, output} = createIO();

        io.checkingMatchers();
        expect(output).toHaveLength(1);
        expect(output[0].type).toBe('checking_matchers');
        expect(output[0].category).toBe('output');
    });

    it('should emit saving_records with record counts by type', () => {
        const {io, output} = createIO();

        const chunk = {
            '001xx000003DGb0AAG': {
                attributes: { type: 'Account' },
                Id: '001xx000003DGb0AAG',
                Name: 'Test Account with a very long name that should be truncated because it exceeds the 100 character limit for the JSON representation and we need to make sure it actually gets cut off properly'
            },
            '003xx000003DGb1AAG': {
                attributes: { type: 'Contact' },
                Id: '003xx000003DGb1AAG',
                Name: 'Test Contact with another very long name that also should be truncated'
            },
            '003xx000003DGb2AAG': {
                attributes: { type: 'Contact' },
                Id: '003xx000003DGb2AAG',
                Name: 'Another Test Contact'
            }
        } as any;

        io.savingRecords(chunk);

        expect(output).toHaveLength(1);
        expect(output[0].type).toBe('saving_records');
        expect(output[0].data.recordCountsByType).toEqual({ Account: 1, Contact: 2 });
        expect(output[0].data.records).toHaveLength(3);
    });

    it('should keep the message and stack of a thrown error through JSON serialization', () => {
        const {io, output} = createIO();
        const error: any = new Error('Request failed with status code 503');
        error.errorCode = 'SERVER_UNAVAILABLE';

        io.errorUpdatingRecord('001xx000003DGb0AAG', 'Account', error);

        expect(output[0].type).toBe('error_updating_record');
        // The debug formatter stringifies the event, and an Error's own message and
        // stack are non-enumerable - they only survive if IO copied them out first.
        const serialized = JSON.parse(JSON.stringify(output[0])).data.error;
        expect(serialized.message).toBe('Request failed with status code 503');
        expect(serialized.errorCode).toBe('SERVER_UNAVAILABLE');
        expect(serialized.name).toBe('Error');
        expect(serialized.stack).toContain('Request failed with status code 503');
    });

    it('should keep every SaveError detail when a record fails to update', () => {
        const {io, output} = createIO();

        io.errorUpdatingRecord('001xx000003DGb0AAG', 'Account', [
            { message: 'insufficient access rights on cross-reference id', fields: ['ParentId'], statusCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' },
            { message: 'Owner cannot be blank', fields: ['OwnerId'], statusCode: 'FIELD_INTEGRITY_EXCEPTION' }
        ]);

        const error = output[0].data.error;
        expect(error.message).toBe('insufficient access rights on cross-reference id, Owner cannot be blank');
        expect(error.errors).toHaveLength(2);
        expect(error.errors[0].fields).toEqual(['ParentId']);
        expect(error.errors[1].statusCode).toBe('FIELD_INTEGRITY_EXCEPTION');
    });

    it('should still produce a message for an error that is not an object', () => {
        const {io, output} = createIO();

        io.errorUpdatingRecord('001xx000003DGb0AAG', 'Account', 'connection reset');

        expect(output[0].data.error).toEqual({ message: 'connection reset' });
    });

    it('should include matchers data in confirm_migration event', async () => {
        const {io, input} = createIO();
        await io.askForConfirmation({
            Account: 1,
            Contact: 2,
            matchers: {
                Account: {
                    whenMissing: 'create'
                }
            }
        });
        expect(input[0].type).toBe('confirm_migration');
        expect(input[0].data.matchers).toBeDefined();
    });
});
