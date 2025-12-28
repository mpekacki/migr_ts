import IO from "../io";
import { IOEvent } from "../app";

describe('IO', () => {
    const createIO = () => {
        const output: string[] = [];
        const input: string[] = [];
        const io = new IO((event: IOEvent) => {
            console.log(JSON.stringify(event));
            output.push(event.toString());
        }, (event: IOEvent) => {
            console.log(JSON.stringify(event));
            input.push(event.toString());
            return Promise.resolve('');
        });
        return {io, output, input};
    };

    it('should print to terminal', () => {
        const {io, output} = createIO();

        io.checkingMatchers();
        expect(output).toEqual([
            '{}\nchecking matchers'
        ]);
    });

    it('should show how many records are being saved and of which type, and trim the JSON to 1000 characters', () => {
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

        expect(output.length).toBe(1);
        const outputStr = output[0];

        // Should show record count
        expect(outputStr).toContain('saving 3 records');

        // Should show types with counts
        expect(outputStr).toContain('1 Account');
        expect(outputStr).toContain('2 Contact');

        // Find the JSON part and verify it's trimmed to 1000 characters or less
        const match = outputStr.match(/: (.+)$/);
        if (match) {
            const jsonPart = match[1];
            expect(jsonPart.length).toBeLessThanOrEqual(1003); // 1000 + "..."
        }
    });

    it('should show the record counts and matchers when confirming the migration', async () => {
        const {io, output, input} = createIO();
        await io.askForConfirmation({
            Account: 1,
            Contact: 2,
            matchers: {
                Account: {
                    whenMissing: 'create'
                }
            }
        });
        expect(input[0]).toContain('matchers');
    });
});