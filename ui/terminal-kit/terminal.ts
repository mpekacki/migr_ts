import { terminal } from 'terminal-kit';
import { IOEvent } from '../../app';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';

const GREEN_TYPES = new Set(['created_record', 'finished', 'saved_records', 'found_existing_record']);
const RED_TYPES = new Set(['error', 'error_updating_record', 'record_not_found', 'record_not_queryable', 'malformed_id']);
const YELLOW_TYPES = new Set(['skipping_record', 'found_circular_dependency', 'record_no_id', 'invalid_json', 'invalid_regex', 'invalid_input', 'aborted']);
const CYAN_TYPES = new Set(['fetching_record', 'querying_related_records', 'querying_existing_record', 'describing_sobject', 'checking_matchers']);
const MAGENTA_TYPES = new Set(['using_solver', 'skipping_previously_used_solvers', 'saved_old_fields']);
const BOLD_TYPES = new Set(['confirm_migration', 'starting_migration']);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class TerminalKitUI implements UI {
    private readonly formatter: (event: IOEvent) => string;
    private progressBar: any;
    private progressActive = false;
    private fixedPosition = false;
    private spinnerTimer: ReturnType<typeof setInterval> | null = null;

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
            this.stopSpinner();
            const colorFn = this.getColorFn(event.type);
            if (CYAN_TYPES.has(event.type) && process.stdout.isTTY && !this.progressActive) {
                colorFn(message + ' ');
                terminal(SPINNER_FRAMES[0]);
                let frame = 1;
                this.spinnerTimer = setInterval(() => {
                    terminal('\b' + SPINNER_FRAMES[frame]);
                    frame = (frame + 1) % SPINNER_FRAMES.length;
                }, 100);
            } else {
                colorFn(message + '\n');
            }
        }
        return message;
    }

    private getColorFn(type: string): typeof terminal {
        if (GREEN_TYPES.has(type)) return terminal.green;
        if (RED_TYPES.has(type)) return terminal.red;
        if (YELLOW_TYPES.has(type)) return terminal.yellow;
        if (CYAN_TYPES.has(type)) return terminal.cyan;
        if (MAGENTA_TYPES.has(type)) return terminal.magenta;
        if (BOLD_TYPES.has(type)) return terminal.bold;
        return terminal;
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
        const message = this.formatter(question);
        terminal(message);
        return terminal.inputField({ echo: true }).promise.then((input: string | undefined) => {
            terminal('\n');
            return input ?? '';
        });
    }

    private stopSpinner(): void {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = null;
            terminal('\b \n');
        }
    }

    close(): void {
        this.stopSpinner();
        this.stopProgressBar();
        terminal.grabInput(false);
    }
}
