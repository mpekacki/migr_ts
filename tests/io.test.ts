import IO from "../io";
import { IOEvent } from "../app";

describe('IO', () => {
    it('should print to terminal', () => {
        const output: string[] = [];
        const io = new IO((event: IOEvent) => {
            output.push(event.toString());
        }, (input: IOEvent) => Promise.resolve(''));

        io.checkingMatchers();
        expect(output).toEqual([
            'checking matchers'
        ]);
    });
});