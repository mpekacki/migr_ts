import { IOEvent } from '../../app';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import { ansi, screen } from './ansi';
import { bodyHeightFor, buildFrame, inputCursorCol, maxFeedScrollOffset, maxScrollOffset } from './render';
import { applyEvent, initialState, MigrationState, pushConsole } from './state';

const SPINNER_MS = 90;

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
    private inputBuffer = '';
    private scrollOffset = 0;
    /** While prompting: show the activity feed instead of the question (Tab toggles). */
    private feedView = false;
    private readonly savedConsole: Partial<Record<ConsoleMethod, (...a: unknown[]) => void>> = {};
    private readonly onResize = () => {
        this.prev = [];
        this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());
        this.redraw();
    };

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
        // Show the full question as a scrollable overlay in the body, then collect
        // a line of input at the pinned input box. Long prompts can be scrolled
        // with ↑/↓ and PgUp/PgDn while typing the answer; Tab flips the body to
        // the activity feed so earlier output stays reachable.
        this.state.overlay = this.formatter(question).split('\n');
        this.promptActive = true;
        this.inputBuffer = '';
        this.scrollOffset = 0; // start at the top of the summary
        this.feedView = false;
        this.stopSpinner();
        this.write(screen.showCursor);
        this.redraw();
        return this.readPromptLine();
    }

    private readPromptLine(): Promise<string> {
        return new Promise<string>((resolve) => {
            const stdin = process.stdin;
            const wasRaw = stdin.isRaw;
            stdin.setRawMode?.(true);
            stdin.resume();

            const onData = (chunk: Buffer) => {
                if (this.handlePromptKey(chunk)) {
                    const answer = this.inputBuffer;
                    stdin.removeListener('data', onData);
                    stdin.setRawMode?.(wasRaw ?? false);
                    stdin.pause();
                    this.write(screen.hideCursor);
                    this.promptActive = false;
                    this.state.overlay = null;
                    this.inputBuffer = '';
                    this.scrollOffset = 0;
                    this.feedView = false;
                    if (!this.state.done) this.startSpinner();
                    this.redraw();
                    resolve(answer);
                } else {
                    this.redraw();
                }
            };
            stdin.on('data', onData);
        });
    }

    /** Apply one key chunk to the prompt. Returns true when the line is submitted. */
    private handlePromptKey(chunk: Buffer): boolean {
        const s = chunk.toString('utf8');
        if (s === '\x03') { this.close(); process.exit(130); }       // Ctrl+C
        if (s === '\r' || s === '\n') return true;                   // Enter
        if (s === '\x7f' || s === '\b') {                            // Backspace
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            return false;
        }
        if (this.handleViewKey(s)) return false;                     // Tab / scrolling
        if (s.startsWith('\x1b')) return false;                      // other escape sequences
        // Printable input (strip control chars so pastes stay on one line).
        // eslint-disable-next-line no-control-regex
        const printable = s.replace(/[\x00-\x1f]/g, '');
        if (printable) this.inputBuffer += printable;
        return false;
    }

    /**
     * Keys that move around the body rather than answering anything: Tab flips
     * between the overlay and the activity feed, the arrows and PgUp/PgDn scroll
     * it. Shared by the prompt and the final summary. Returns true if consumed.
     */
    private handleViewKey(s: string): boolean {
        if (s === '\t') {
            this.feedView = !this.feedView;
            // The overlay opens at the top; the feed opens at its latest lines.
            this.scrollOffset = this.feedView ? this.maxScroll() : 0;
            return true;
        }
        const max = this.maxScroll();
        const page = this.pageSize();
        if (s === '\x1b[A') this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        else if (s === '\x1b[B') this.scrollOffset = Math.min(max, this.scrollOffset + 1);
        else if (s === '\x1b[5~') this.scrollOffset = Math.max(0, this.scrollOffset - page);
        else if (s === '\x1b[6~') this.scrollOffset = Math.min(max, this.scrollOffset + page);
        else return false;
        return true;
    }

    private maxScroll(): number {
        const { width, height } = this.dims();
        if (this.feedView) return maxFeedScrollOffset(this.state.feed, width, height);
        return maxScrollOffset(this.state.overlay, width, height);
    }

    private pageSize(): number {
        return Math.max(1, bodyHeightFor(this.dims().height) - 1);
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
        this.scrollOffset = 0;
        this.feedView = false;
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
                // Scrolling the summary must not count as the acknowledging key.
                if (this.handleViewKey(chunk.toString('utf8'))) {
                    this.redraw();
                    return;
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
        // The alternate screen takes the summary with it. Reprint it on the
        // normal screen so the new record IDs stay in the scrollback.
        if (this.state.finalSummary) {
            this.write(this.state.finalSummary.join('\n') + `${ansi.reset}\n`);
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    private dims(): { width: number; height: number } {
        return {
            width: process.stdout.columns || 80,
            height: process.stdout.rows || 24,
        };
    }

    private redraw(): void {
        if (this.closed) return;
        const { width, height } = this.dims();
        const frame = buildFrame(
            this.state, this.spinnerFrame, width, height,
            this.promptActive, this.awaitingExit, this.inputBuffer, this.scrollOffset,
            this.feedView,
        );

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

        // Keep the cursor parked just after the typed input while prompting.
        if (this.promptActive) {
            const inputRow = Math.max(10, height) - 1; // second-to-last row
            this.write(screen.moveTo(inputCursorCol(this.inputBuffer, width), inputRow));
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
                // Repaint unless a prompt owns the body — except when the user
                // has toggled the feed into view, where new lines should appear.
                if (!this.promptActive || this.feedView) this.redraw();
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
