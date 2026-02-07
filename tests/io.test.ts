import IO from "../io";
import { IOEvent } from "../app";

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
