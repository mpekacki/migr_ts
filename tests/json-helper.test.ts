import IOEvent, { JsonHelperContext } from '../ioevent';
import { helperChoices, JsonHelper } from '../ui/json-helper';
import { stripAnsi, visibleLength } from '../ui/tui/ansi';
import { renderHelper } from '../ui/tui/render';
import { TuiUI } from '../ui/tui/tui';
import { TerminalKitUI } from '../ui/terminal-kit/terminal';

const mockQuestion = jest.fn();
jest.mock('readline', () => ({ createInterface: () => ({ question: mockQuestion, close: () => {} }) }));
jest.mock('terminal-kit', () => ({ terminal: () => {} }));

function context(overrides: Partial<JsonHelperContext> = {}): JsonHelperContext {
    return {
        kind: 'fix',
        phase: 'insert',
        error: 'Bad status (Activated).',
        errorFields: ['Status'],
        values: { Name: 'Acme', Status: 'Activated' },
        fields: [
            { name: 'Amount', type: 'currency' },
            { name: 'Name', type: 'string' },
            { name: 'Status', label: 'State', type: 'picklist', picklistValues: ['Draft', 'Activated'] },
            { name: 'Active__c', type: 'boolean' },
        ],
        ...overrides,
    };
}

/** Answers by the label of an option, or with the text when no option has it. */
function answer(helper: JsonHelper, ...answers: string[]) {
    for (const text of answers) {
        const choice = helperChoices(helper.step!, text)[0];
        if (helper.step!.kind === 'choose' && !choice) throw new Error(`no choice ${text}`);
        helper.answer(choice?.answer ?? { text });
    }
}

describe('fix helper', () => {
    it('offers the fields the error names first, then those with a value', () => {
        expect(helperChoices(new JsonHelper(context()).step!, '').map(c => c.label))
            .toEqual(['Status', 'Name', 'Active__c', 'Amount']);
    });

    it('builds values of the type of the field', () => {
        const helper = new JsonHelper(context());
        answer(helper, 'Status', 'Draft', 'Yes', 'Amount', '12.5', 'Yes', 'Active__c', 'false', 'Yes', 'Name', 'Leave', 'No');
        expect(JSON.parse(helper.result!)).toEqual({ Status: 'Draft', Amount: 12.5, Active__c: false, Name: null });
    });

    it('takes a field and a value it does not know of', () => {
        const helper = new JsonHelper(context({ fields: [], values: {}, errorFields: [] }));
        answer(helper, 'Other__c', 'Type a value', 'say "hi"', 'No');
        expect(JSON.parse(helper.result!)).toEqual({ Other__c: 'say "hi"' });
    });

    it('goes back a step at a time, from the result too', () => {
        const helper = new JsonHelper(context());
        expect(helper.back()).toBe(false);
        answer(helper, 'Status', 'Draft', 'No');
        expect(helper.back()).toBe(true);
        expect(helper.back()).toBe(true);
        answer(helper, 'Activated', 'No');
        expect(helper.result).toBe('{"Status":"Activated"}');
    });
});

describe('solver helper', () => {
    const solver = (overrides: Partial<JsonHelperContext> = {}) => new JsonHelper(context({ kind: 'solver', ...overrides }));

    it('builds an exact skip solver', () => {
        const helper = solver();
        answer(helper, 'skip', 'Exactly this error', 'No');
        expect(JSON.parse(helper.result!)).toEqual({ message: 'Bad status (Activated).', exact: true, action: 'skip', hideError: true });
    });

    it('escapes the error it builds a pattern of', () => {
        const helper = solver({ error: 'Line (1)\nline two?' });
        answer(helper, 'fix', 'Any error containing', 'Status', 'Draft', 'No', 'Yes');
        const built = JSON.parse(helper.result!);
        expect(new RegExp(built.message).test('x Line (1)\nline two?')).toBe(true);
        expect(built.changeFields).toEqual([{ field: 'Status', value: 'Draft' }]);
    });

    it('captures the id of the error, not its long words', () => {
        const helper = solver({ error: 'representatives: duplicate of record with id: 001xx000003DGb0' });
        answer(helper, 'match');
        expect(helperChoices(helper.step!, '').map(c => c.label)).toEqual(['Capture 001xx000003DGb0', 'Type a pattern']);
        answer(helper, 'Capture', 'Yes');
        const pattern = new RegExp(JSON.parse(helper.result!).message);
        expect(pattern.exec('representatives: duplicate of record with id: 003yy000003DGb9')![1]).toBe('003yy000003DGb9');
    });

    it('captures a field name out of the text', () => {
        const helper = solver({ error: 'Field \'Fussy__c\'  can\'t be \'blocked\'', errorFields: [] });
        answer(helper, 'extract_column', 'Capture', 'Leave', 'Yes');
        const built = JSON.parse(helper.result!);
        expect(new RegExp(built.message).exec('Field \'Other__c\'  can\'t be \'x\'')![1]).toBe('Other__c');
        expect(built.replaceWith).toBeNull();
    });

    it('takes the column from the fields of the error', () => {
        const helper = solver();
        answer(helper, 'extract_column', 'The first field', 'Exactly', 'Replace', 'x', 'Yes');
        expect(JSON.parse(helper.result!)).toMatchObject({ action: 'extract_column', fromFields: true, exact: true, replaceWith: 'x' });
    });

    it('refuses a pattern that is broken, matches something else or captures nothing', () => {
        const helper = solver({ error: 'duplicate' });
        answer(helper, 'match', 'Type a pattern');
        for (const bad of ['((', 'other', 'duplicate']) {
            answer(helper, bad);
            expect(helper.problem).toBeTruthy();
        }
        answer(helper, '(dup)', 'Yes');
        expect(JSON.parse(helper.result!).message).toBe('(dup)');
    });

    it('builds append_random and refuses a bad length', () => {
        const helper = solver();
        answer(helper, 'append_random', 'Exactly', 'Name', '99');
        expect(helper.problem).toBeTruthy();
        answer(helper, '4', 'No', 'Yes');
        expect(JSON.parse(helper.result!).changeFields).toEqual([{ field: 'Name', length: 4 }]);
    });

    it('does not offer match during the update pass', () => {
        expect(helperChoices(solver({ phase: 'update' }).step!, '').map(c => c.label)).not.toContain('match');
    });
});

it('renders within the body, the selection in sight', () => {
    const fields = Array.from({ length: 100 }, (_, i) => ({ name: `Field_${String(i).padStart(3, '0')}__c` }));
    const lines = renderHelper(new JsonHelper(context({ fields, values: {}, errorFields: [] })), '', 70, 40, 10);
    expect(lines).toHaveLength(10);
    expect(lines.every(line => visibleLength(line) <= 40)).toBe(true);
    expect(lines.map(stripAnsi).some(line => line.startsWith('❯ Field_070__c'))).toBe(true);
});

describe('in the TUI', () => {
    const DOWN = '\x1b[B';

    async function drive(keys: string[]): Promise<string> {
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const ui = new TuiUI(false);
        // Keys are handed over directly: listening would hold stdin open.
        (ui as any).listen = () => {};
        try {
            const result = ui.prompt(new IOEvent('input', 'insert_error', { helper: context() }));
            for (const key of keys) (ui as any).onKey(key);
            return await result;
        } finally {
            ui.close();
            write.mockRestore();
        }
    }

    it('still takes JSON typed by hand', async () => {
        expect(await drive(['{"Name": "x"}', '\r'])).toBe('{"Name": "x"}');
    });

    it('puts what was built on the input line, to be edited or sent', async () => {
        const build = ['\r', '\r', 'Dra', '\r', '\r'];
        expect(await drive([...build, '\r'])).toBe('{"Status":"Draft"}');
        expect(await drive([...build, '\x7f', ',"Name":"x"}', '\r'])).toBe('{"Status":"Draft","Name":"x"}');
    });

    it('moves with the arrows, and Esc leads back to typing', async () => {
        expect(await drive(['\r', DOWN, '\r', '\x1b', '\x1b', '{}', '\r'])).toBe('{}');
    });

    it('answers nothing from the activity log', async () => {
        expect(await drive(['\r', 'Sta', '\t', '\x7f', '\r', '\r', 'Draft', '\r', '\r', '\r'])).toBe('{"Status":"Draft"}');
    });
});

describe('in the plain UI', () => {
    async function drive(answers: string[]): Promise<string> {
        mockQuestion.mockReset();
        mockQuestion.mockImplementation((_text, resolve) => resolve(answers.shift()!));
        return new TerminalKitUI(false).prompt(new IOEvent('input', 'insert_error', { helper: context() }));
    }

    it('takes numbers and text, and the result on Enter', async () => {
        expect(await drive(['', '1', 'Draft', '1', ''])).toBe('{"Status":"Draft"}');
    });

    it('goes back, out of the helper too, and takes other JSON instead', async () => {
        expect(await drive(['', '1', '<', '<', '{}'])).toBe('{}');
        expect(await drive(['', '1', 'Draft', '1', '{"a":1}'])).toBe('{"a":1}');
    });
});
