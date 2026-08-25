import { terminal } from 'terminal-kit';
import IOEvent from '../../ioevent';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import readline from 'readline';

export class TerminalKitUI implements UI {
    private readonly rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    private readonly formatter: (event: IOEvent) => string;

    constructor(debug: boolean) {
        this.formatter = getFormatter(debug);
    }

    display(event: IOEvent): string {
        const message = this.formatter(event);
        terminal(message);
        terminal('\n');
        return message;
    }

    prompt(question: IOEvent): Promise<string> {
        return new Promise((resolve) => this.rl.question(this.formatter(question), resolve));
    }

    close(): void {
        this.rl.close();
    }
}
