import { terminal } from 'terminal-kit';
import { IOEvent } from '../../app';
import { UI } from '../ui';
import readline from 'readline';

export class TerminalKitUI implements UI {
    private readonly rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    private readonly debug: boolean;

    constructor(debug: boolean) {
        this.debug = debug;
    }

    private formatMessage(event: IOEvent): string {
        return this.debug ? JSON.stringify(event) : event.toString();
    }

    display(event: IOEvent): string {
        const message = this.formatMessage(event);
        terminal(message);
        terminal('\n');
        return message;
    }

    prompt(question: IOEvent): Promise<string> {
        return new Promise((resolve) => this.rl.question(this.formatMessage(question), resolve));
    }

    close(): void {
        this.rl.close();
    }
}