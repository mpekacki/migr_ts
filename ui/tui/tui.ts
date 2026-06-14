import readline from 'readline';
import { IOEvent } from '../../app';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import { ansi, screen } from './ansi';
import { buildFrame } from './render';
import { applyEvent, initialState, MigrationState, pushConsole } from './state';

const SPINNER_MS = 90;
const INPUT_PROMPT = `${ansi.green('>')} `;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * A full-screen, live-updating terminal UI for the migration. It folds the
 * stream of IOEvents into a small state model and repaints a fixed layout:
 * a status/progress header, a scrolling activity feed, and a pinned input box.
 */
export class TuiUI implements UI {
    private readonly state: MigrationState = initialState();
    private readonly formatter: (event: IOEvent) => string;
    private prev: string[] = [];
    private spinnerFrame = 0;
    private spinnerTimer: NodeJS.Timeout | null = null;
    private promptActive = false;
    private awaitingExit = false;
    private closed = false;
    private readonly savedConsole: Partial<Record<ConsoleMethod, (...a: unknown[]) => void>> = {};
    private readonly onResize = () => { this.prev = []; this.redraw(); };

    constructor(debug: boolean) {
        // The log-file output still wants readable, stable lines.
        this.formatter = getFormatter(debug);
        this.enter();
    }

    private enter(): void {
        this.write(screen.enterAlt + screen.hideCursor + screen.clear);
        this.interceptConsole();
        process.stdout.on('resize', this.onResize);
        this.startSpinner();
        this.redraw();
    }

    display(event: IOEvent): string {
        const logLine = this.formatter(event);
        applyEvent(this.state, event);
        if (this.state.done) this.stopSpinner();
        this.redraw();
        return logLine;
    }

    prompt(question: IOEvent): Promise<string> {
        // Show the full question as an overlay in the body, then collect a line
        // of input at the pinned input box.
        this.state.overlay = this.formatter(question).split('\n');
        this.promptActive = true;
        this.stopSpinner();
        this.redraw();

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const { col, row } = this.inputCursor();
        this.write(screen.showCursor + screen.moveTo(col, row));

        return new Promise<string>((resolve) => {
            rl.question(INPUT_PROMPT, (answer) => {
                rl.close();
                this.write(screen.hideCursor);
                this.promptActive = false;
                this.state.overlay = null;
                if (!this.state.done) this.startSpinner();
                this.redraw();
                resolve(answer);
            });
        });
    }

    /**
     * Hold the final screen open until the user presses a key, so the summary
     * is readable instead of vanishing the instant the migration ends. Resolves
     * immediately when there is no interactive terminal to read a key from.
     */
    awaitExit(): Promise<void> {
        if (this.closed || !process.stdin.isTTY) return Promise.resolve();
        this.stopSpinner();
        this.awaitingExit = true;
        this.redraw();
        return this.waitForKeypress();
    }

    private waitForKeypress(): Promise<void> {
        return new Promise<void>((resolve) => {
            const stdin = process.stdin;
            const wasRaw = stdin.isRaw;
            stdin.setRawMode?.(true);
            stdin.resume();
            const onData = (chunk: Buffer) => {
                // Ctrl+C while waiting should still terminate the process.
                if (chunk.length === 1 && chunk[0] === 0x03) {
                    this.close();
                    process.exit(130);
                }
                stdin.removeListener('data', onData);
                stdin.setRawMode?.(wasRaw ?? false);
                stdin.pause();
                resolve();
            };
            stdin.on('data', onData);
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stopSpinner();
        process.stdout.removeListener('resize', this.onResize);
        this.restoreConsole();
        this.write(screen.showCursor + screen.exitAlt);
    }

    // ── internals ───────────────────────────────────────────────────────────

    private dims(): { width: number; height: number } {
        return {
            width: process.stdout.columns || 80,
            height: process.stdout.rows || 24,
        };
    }

    private inputCursor(): { col: number; row: number } {
        const { height } = this.dims();
        // Input line is the second-to-last row; cursor sits just inside "│ ".
        return { col: 3, row: height - 1 };
    }

    private redraw(): void {
        if (this.closed) return;
        const { width, height } = this.dims();
        const frame = buildFrame(this.state, this.spinnerFrame, width, height, this.promptActive, this.awaitingExit);

        let out = '';
        for (let i = 0; i < frame.length; i++) {
            if (frame[i] !== this.prev[i]) {
                out += screen.moveTo(1, i + 1) + frame[i] + screen.eraseToLineEnd;
            }
        }
        // Clear any trailing rows left over from a previous, taller frame.
        for (let i = frame.length; i < this.prev.length; i++) {
            out += screen.moveTo(1, i + 1) + screen.eraseToLineEnd;
        }
        this.prev = frame;
        if (out) this.write(out + ansi.reset);

        // Keep the cursor parked in the input box while prompting.
        if (this.promptActive) {
            const { col, row } = this.inputCursor();
            this.write(screen.moveTo(col + 2, row)); // +2 for the "> " readline prompt
        }
    }

    private startSpinner(): void {
        if (this.spinnerTimer) return;
        this.spinnerTimer = setInterval(() => {
            this.spinnerFrame++;
            this.redraw();
        }, SPINNER_MS);
        // Don't keep the process alive solely for the animation.
        this.spinnerTimer.unref?.();
    }

    private stopSpinner(): void {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = null;
        }
    }

    private interceptConsole(): void {
        const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
        for (const m of methods) {
            this.savedConsole[m] = console[m].bind(console);
            console[m] = (...args: unknown[]) => {
                const text = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
                pushConsole(this.state, text);
                if (!this.promptActive) this.redraw();
            };
        }
    }

    private restoreConsole(): void {
        for (const [m, fn] of Object.entries(this.savedConsole)) {
            if (fn) console[m as ConsoleMethod] = fn;
        }
    }

    private write(s: string): void {
        process.stdout.write(s);
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
