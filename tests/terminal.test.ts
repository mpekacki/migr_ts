import IOEvent from '../ioevent';

// Mock terminal-kit
const mockTerminal = jest.fn();
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
const getFormatter = jest.fn().mockReturnValue((_event: IOEvent) => MESSAGE);
jest.mock('../ui/event-formatter', () => ({
    getFormatter
}));

import { TerminalKitUI } from '../ui/terminal-kit/terminal';

describe('TerminalKitUI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getFormatter.mockReturnValue((_event: IOEvent) => MESSAGE);
    });

    describe('display', () => {
        it('should display message using terminal and return formatted message', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'checking_matchers');

            const result = ui.display(event);

            expect(mockTerminal).toHaveBeenCalledWith('test message');
            expect(mockTerminal).toHaveBeenCalledWith('\n');
            expect(result).toBe('test message');
        });

        it('should display message with data', () => {
            const ui = new TerminalKitUI(false);
            const event = new IOEvent('output', 'error', { message: 'something failed' });

            const result = ui.display(event);

            expect(mockTerminal).toHaveBeenCalledWith('test message');
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
