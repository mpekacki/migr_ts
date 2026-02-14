import IOEvent from '../ioevent';

// Mock terminal-kit
const mockInputFieldPromise = { promise: Promise.resolve('user response') };
const mockTerminal = jest.fn() as jest.Mock & {
    green: jest.Mock;
    red: jest.Mock;
    yellow: jest.Mock;
    cyan: jest.Mock;
    magenta: jest.Mock;
    bold: jest.Mock;
    inputField: jest.Mock;
    grabInput: jest.Mock;
};
mockTerminal.green = jest.fn();
mockTerminal.red = jest.fn();
mockTerminal.yellow = jest.fn();
mockTerminal.cyan = jest.fn();
mockTerminal.magenta = jest.fn();
mockTerminal.bold = jest.fn();
mockTerminal.inputField = jest.fn().mockReturnValue(mockInputFieldPromise);
mockTerminal.grabInput = jest.fn();
jest.mock('terminal-kit', () => ({
    terminal: mockTerminal
}));

// Mock event formatter
const MESSAGE = 'test message';
const getFormatter = jest.fn().mockReturnValue((event: IOEvent) => MESSAGE);
jest.mock('../ui/event-formatter', () => ({
    getFormatter
}));

import { TerminalKitUI } from '../ui/terminal-kit/terminal';

const originalIsTTY = process.stdout.isTTY;

describe('TerminalKitUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getFormatter.mockReturnValue((event: IOEvent) => MESSAGE);
        (process.stdout as any).isTTY = undefined;
        mockTerminal.inputField.mockReturnValue({ promise: Promise.resolve('user response') });
    });

    afterEach(() => {
        (process.stdout as any).isTTY = originalIsTTY;
    });

    describe('display', () => {
        it('should display message using cyan for checking_matchers and return formatted message', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'checking_matchers');

            const result = ui.display(event);

            expect(mockTerminal.cyan).toHaveBeenCalledWith('test message\n');
            expect(result).toBe('test message');
        });

        it('should start a spinner for cyan event types when TTY', () => {
            jest.useFakeTimers();
            (process.stdout as any).isTTY = true;
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'fetching_record');

            ui.display(event);

            expect(mockTerminal.cyan).toHaveBeenCalledWith('test message ');
            expect(mockTerminal).toHaveBeenCalledWith('⠋');
            jest.advanceTimersByTime(100);
            expect(mockTerminal).toHaveBeenCalledWith('\b⠙');
            ui.close();
            jest.useRealTimers();
        });

        it('should stop previous spinner when a new event arrives', () => {
            jest.useFakeTimers();
            (process.stdout as any).isTTY = true;
            const ui = new TerminalKitUI(false);

            ui.display(new IOEvent('output', 'fetching_record'));

            mockTerminal.mockClear();
            ui.display(new IOEvent('output', 'created_record'));
            // stopSpinner erases spinner char and prints newline
            expect(mockTerminal).toHaveBeenCalledWith('\b \n');
            // Spinner should be stopped - advancing time should not produce backspace frames
            mockTerminal.mockClear();
            jest.advanceTimersByTime(200);
            expect(mockTerminal).not.toHaveBeenCalledWith(expect.stringContaining('\b'));
            ui.close();
            jest.useRealTimers();
        });

        it('should not start a spinner in non-TTY mode', () => {
            (process.stdout as any).isTTY = undefined;
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'fetching_record');

            ui.display(event);

            expect(mockTerminal.cyan).toHaveBeenCalledWith('test message\n');
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

            const result = await ui.prompt(event);

            expect(mockTerminal).toHaveBeenCalledWith('test message');
            expect(mockTerminal.inputField).toHaveBeenCalledWith({ echo: true });
            expect(result).toBe('user response');
        });
    });

    describe('close', () => {
        it('should call close without errors', () => {
            const ui = new TerminalKitUI(false);

            expect(() => ui.close()).not.toThrow();
        });
    });
});
