import IOEvent from '../ioevent';

// Mock terminal-kit
const mockTerminal = jest.fn() as jest.Mock & {
    green: jest.Mock;
    red: jest.Mock;
    yellow: jest.Mock;
    cyan: jest.Mock;
    magenta: jest.Mock;
    bold: jest.Mock;
};
mockTerminal.green = jest.fn();
mockTerminal.red = jest.fn();
mockTerminal.yellow = jest.fn();
mockTerminal.cyan = jest.fn();
mockTerminal.magenta = jest.fn();
mockTerminal.bold = jest.fn();
jest.mock('terminal-kit', () => ({
    terminal: mockTerminal
}));

// Mock readline
const mockQuestion = jest.fn();
const mockClose = jest.fn();
jest.mock('readline', () => ({
    createInterface: jest.fn(() => ({
        question: mockQuestion,
        close: mockClose
    }))
}));

// Mock event formatter
const MESSAGE = 'test message';
const getFormatter = jest.fn().mockReturnValue((event: IOEvent) => MESSAGE);
jest.mock('../ui/event-formatter', () => ({
    getFormatter
}));

import { TerminalKitUI } from '../ui/terminal-kit/terminal';

describe('TerminalKitUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getFormatter.mockReturnValue((event: IOEvent) => MESSAGE);
    });

    describe('display', () => {
        it('should display message using cyan for checking_matchers and return formatted message', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'checking_matchers');

            const result = ui.display(event);

            expect(mockTerminal.cyan).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display error message in red', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'error', { message: 'something failed' });

            const result = ui.display(event);

            expect(mockTerminal.red).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display success events in green', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'created_record');

            const result = ui.display(event);

            expect(mockTerminal.green).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display warning events in yellow', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'skipping_record');

            const result = ui.display(event);

            expect(mockTerminal.yellow).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display solver events in magenta', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'using_solver');

            const result = ui.display(event);

            expect(mockTerminal.magenta).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display important events in bold', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'starting_migration');

            const result = ui.display(event);

            expect(mockTerminal.bold).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should display unrecognized events with default terminal', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'remaining_records');

            const result = ui.display(event);

            expect(mockTerminal).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should pass debug=true to getFormatter when debug mode is enabled', () => {
            new TerminalKitUI(true);
            expect(getFormatter).toHaveBeenCalledWith(true);
        });

        it('should pass debug=false to getFormatter when debug mode is disabled', () => {
            new TerminalKitUI(false);
            expect(getFormatter).toHaveBeenCalledWith(false);
        });
    });

    describe('prompt', () => {
        it('should prompt user with formatted question and return response', async () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('input', 'confirm_migration');
            mockQuestion.mockImplementation((question: string, callback: (answer: string) => void) => {
                callback('user response');
            });

            const result = await ui.prompt(event);

            expect(mockQuestion).toHaveBeenCalledWith('test message', expect.any(Function));
            expect(result).toBe('user response');
        });
    });

    describe('close', () => {
        it('should close the readline interface', () => {
            const ui = new TerminalKitUI(false);

            ui.close();

            expect(mockClose).toHaveBeenCalled();
        });
    });
});
