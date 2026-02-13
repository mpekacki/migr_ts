import { terminal } from 'terminal-kit';
import { IOEvent } from '../../app';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import readline from 'readline';

export class TerminalKitUI implements UI {
    private readonly rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    private readonly formatter: (event: IOEvent) => string;
    private progressBar: any;
    private progressActive = false;
    private fixedPosition = false;

    constructor(debug: boolean) {
        this.formatter = getFormatter(debug);
    }

    display(event: IOEvent): string {
        const message = this.formatter(event);
        if (event.type === 'progress_bar_init' && event.data.total > 0) {
            if (process.stdout.isTTY && terminal.height) {
                // Real terminal: fix the progress bar at the bottom line
                terminal.scrollingRegion(1, terminal.height - 1);
                terminal.moveTo(1, terminal.height - 1);
                this.progressBar = terminal.progressBar({
                    title: 'Migrating records:',
                    eta: true,
                    percent: true,
                    syncMode: true,
                    y: terminal.height,
                    x: 1,
                    width: Math.min(terminal.width || 80, 80)
                } as any);
                this.fixedPosition = true;
            } else {
                // Piped/non-TTY: use inline mode (no escape sequences)
                this.progressBar = terminal.progressBar({
                    title: 'Migrating records:',
                    eta: true,
                    percent: true,
                    syncMode: true,
                    inline: true,
                    width: Math.min(terminal.width || 80, 80)
                });
                this.fixedPosition = false;
            }
            this.progressActive = true;
        } else if (event.type === 'progress_bar_update' && this.progressBar) {
            this.progressBar.update(event.data.done / event.data.total);
            if (event.data.done >= event.data.total) {
                this.stopProgressBar();
            }
        } else {
            terminal(message);
            terminal('\n');
        }
        return message;
    }

    private stopProgressBar(): void {
        if (!this.progressActive) return;
        this.progressActive = false;
        if (this.progressBar) {
            this.progressBar.stop();
        }
        if (this.fixedPosition && terminal.height) {
            terminal.moveTo(1, terminal.height);
            terminal.eraseLine();
            terminal.resetScrollingRegion();
            terminal.moveTo(1, terminal.height);
        } else if (!this.fixedPosition) {
            terminal('\n');
        }
    }

    prompt(question: IOEvent): Promise<string> {
        return new Promise((resolve) => this.rl.question(this.formatter(question), resolve));
    }

    close(): void {
        this.stopProgressBar();
        this.rl.close();
    }
}
