import IOEvent from '../../ioevent';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import { ansi, screen } from './ansi';
import { BodyView, bodyHeightFor, buildFrame, inputCursorCol, maxFeedScrollOffset, maxScrollOffset, nextView } from './render';
import { focusRecord, handleRecordsKey, initialRecordsView, RecordsViewState } from './records-view';
import { applyEvent, initialState, MigrationState, pushConsole } from './state';

const SPINNER_MS = 90;
/**
 * The least time between two repaints driven by events. A settled chunk sends a
 * few events per record, and painting each one made a 200-record chunk paint
 * hundreds of frames nobody could see.
 */
const FRAME_MS = 33;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

/**
 * A full-screen, live-updating terminal UI for the migration. It folds the
 * stream of IOEvents into a small state model and repaints a fixed layout:
 * a status/progress header, a scrolling activity feed, and a pinned input box.
 *
 * Keys come through one stdin listener. It is on while a prompt or the final
 * screen waits for input, and - on an interactive terminal - from the moment the
 * retrieved records arrive until the UI closes, so they can be browsed while the
 * migration runs as well as at its prompts.
 */
export class TuiUI implements UI {
    private readonly state: MigrationState = initialState();
    private readonly formatter: (event: IOEvent) => string;
    private prev: string[] = [];
    private spinnerFrame = 0;
    private spinnerTimer: NodeJS.Timeout | null = null;
    private lastFrame = 0;
    private frameTimer: NodeJS.Timeout | null = null;
    private promptActive = false;
    private awaitingExit = false;
    private closed = false;
    private inputBuffer = '';
    private scrollOffset = 0;
    /** What the body shows; Tab goes round the views, Esc back to `main`. */
    private view: BodyView = 'main';
    /** Where the records view is, kept across visits to it. Set once the records arrive. */
    private records: RecordsViewState | null = null;
    /** The record the current prompt is about: the records view opens on it, the first time. */
    private pendingFocus: string | null = null;
    private resolvePrompt: ((answer: string) => void) | null = null;
    private resolveExit: (() => void) | null = null;
    private listening = false;
    private wasRaw = false;
    private cursorShown = false;
    private readonly onKeyData = (chunk: Buffer) => this.onKey(chunk.toString('utf8'));
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
        if (this.state.retrieved && !this.records) {
            this.records = initialRecordsView();
            // Without a terminal there is no one to browse them, and a listener
            // would only hold the process open on a piped stdin.
            if (process.stdin.isTTY) this.listen();
        }
        if (this.state.done) {
            this.stopSpinner();
            this.redraw();
        } else {
            this.requestRedraw();
        }
        return logLine;
    }

    prompt(question: IOEvent): Promise<string> {
        // Show the full question as a scrollable overlay in the body, then collect
        // a line of input at the pinned input box. Long prompts can be scrolled
        // with ↑/↓ and PgUp/PgDn while typing the answer; Tab goes round the
        // records and the activity feed, so both stay reachable while answering.
        this.state.overlay = this.formatter(question).split('\n');
        this.promptActive = true;
        this.inputBuffer = '';
        this.scrollOffset = 0; // start at the top of the summary
        // A question is not to be missed, whatever was being looked at before it.
        this.view = 'main';
        this.pendingFocus = typeof question.data?.recordId === 'string' ? question.data.recordId : null;
        this.stopSpinner();
        return new Promise<string>((resolve) => {
            this.resolvePrompt = resolve;
            this.listen();
            this.redraw();
        });
    }

    private submitPrompt(): void {
        const answer = this.inputBuffer;
        const resolve = this.resolvePrompt!;
        this.resolvePrompt = null;
        this.promptActive = false;
        this.state.overlay = null;
        this.inputBuffer = '';
        this.scrollOffset = 0;
        this.view = 'main';
        this.pendingFocus = null;
        if (!this.wantsKeys()) this.unlisten();
        if (!this.state.done) this.startSpinner();
        this.redraw();
        resolve(answer);
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
        this.view = 'main';
        return new Promise<void>((resolve) => {
            this.resolveExit = resolve;
            this.listen();
            this.redraw();
        });
    }

    private onKey(s: string): void {
        // Raw mode turns Ctrl+C into a key rather than a signal, so it is ours to honour.
        if (s === '\x03') {
            this.close();
            process.exit(130);
        }
        if (this.resolvePrompt) {
            if (this.handlePromptKey(s)) {
                this.submitPrompt();
                return;
            }
        } else if (this.resolveExit) {
            // Moving around the final screen must not count as the acknowledging key.
            if (!this.handleViewKey(s)) {
                const resolve = this.resolveExit;
                this.resolveExit = null;
                this.unlisten();
                resolve();
                return;
            }
        } else {
            this.handleViewKey(s);
        }
        this.redraw();
    }

    /** Apply one key to the prompt. Returns true when the line is submitted. */
    private handlePromptKey(s: string): boolean {
        // The records view takes every key, Enter and Backspace included: what is
        // typed there filters the list, it does not answer the question.
        if (this.view === 'records') {
            this.handleViewKey(s);
            return false;
        }
        if (s === '\r' || s === '\n') return true;                   // Enter
        if (s === '\x7f' || s === '\b') {                            // Backspace
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            return false;
        }
        if (this.handleViewKey(s)) return false;                     // Tab / Esc / scrolling
        if (s.startsWith('\x1b')) return false;                      // other escape sequences
        // Printable input (strip control chars so pastes stay on one line).
        // eslint-disable-next-line no-control-regex
        const printable = s.replace(/[\x00-\x1f]/g, '');
        if (printable) this.inputBuffer += printable;
        return false;
    }

    /**
     * Keys that move around the body rather than answering anything: Tab goes
     * round the views, Esc goes back to the main one, the arrows and PgUp/PgDn
     * scroll - and in the records view every key is the view's own. Shared by the
     * prompt, the final summary and the run in between. Returns true if consumed.
     */
    private handleViewKey(s: string): boolean {
        if (s === '\t') {
            this.switchView(nextView(this.view, this.state.overlay !== null, this.records !== null));
            return true;
        }
        if (this.view === 'records' && this.state.retrieved && this.records) {
            if (handleRecordsKey(this.state.retrieved, this.records, s, this.bodyHeight()) === 'leave') {
                this.switchView('main');
            }
            return true;
        }
        if (s === '\x1b' && this.view === 'feed') {
            this.switchView('main');
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

    private switchView(view: BodyView): void {
        this.view = view;
        // The overlay opens at the top; the feed opens at its latest lines.
        this.scrollOffset = view === 'feed' ? this.maxScroll() : 0;
        if (view === 'records' && this.pendingFocus && this.state.retrieved && this.records) {
            focusRecord(this.state.retrieved, this.records, this.pendingFocus, this.bodyHeight());
            this.pendingFocus = null;
        }
    }

    private maxScroll(): number {
        const { width, height } = this.dims();
        if (this.view === 'feed') return maxFeedScrollOffset(this.state.feed, width, height);
        return maxScrollOffset(this.state.overlay, width, height);
    }

    private bodyHeight(): number {
        return bodyHeightFor(this.dims().height);
    }

    private pageSize(): number {
        return Math.max(1, this.bodyHeight() - 1);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stopSpinner();
        this.unlisten();
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

    /** Whether anything is still waiting on a key once a prompt has its answer. */
    private wantsKeys(): boolean {
        return this.resolvePrompt !== null || this.resolveExit !== null
            || (this.records !== null && process.stdin.isTTY === true);
    }

    private listen(): void {
        if (this.listening || this.closed) return;
        const stdin = process.stdin;
        this.wasRaw = stdin.isRaw ?? false;
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on('data', this.onKeyData);
        this.listening = true;
    }

    private unlisten(): void {
        if (!this.listening) return;
        const stdin = process.stdin;
        stdin.removeListener('data', this.onKeyData);
        stdin.setRawMode?.(this.wasRaw);
        stdin.pause();
        this.listening = false;
    }

    private dims(): { width: number; height: number } {
        return {
            width: process.stdout.columns || 80,
            height: process.stdout.rows || 24,
        };
    }

    /**
     * Repaint for an event: now if the last frame is at least FRAME_MS old,
     * otherwise once that much time has passed, taking in every event since.
     */
    private requestRedraw(): void {
        if (this.frameTimer) return;
        const wait = this.lastFrame + FRAME_MS - Date.now();
        if (wait <= 0) {
            this.redraw();
            return;
        }
        this.frameTimer = setTimeout(() => {
            this.frameTimer = null;
            this.redraw();
        }, wait);
        this.frameTimer.unref?.();
    }

    private redraw(): void {
        if (this.frameTimer) {
            clearTimeout(this.frameTimer);
            this.frameTimer = null;
        }
        if (this.closed) return;
        this.lastFrame = Date.now();
        const { width, height } = this.dims();
        const frame = buildFrame(
            this.state, this.spinnerFrame, width, height,
            this.promptActive, this.awaitingExit, this.inputBuffer, this.scrollOffset,
            this.view, this.records,
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

        // Keep the cursor parked just after the typed input while prompting - but
        // not over the records view, where typing goes to its filter instead.
        const showCursor = this.promptActive && this.view !== 'records';
        if (showCursor !== this.cursorShown) {
            this.write(showCursor ? screen.showCursor : screen.hideCursor);
            this.cursorShown = showCursor;
        }
        if (showCursor) {
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
                if (!this.promptActive || this.view === 'feed') this.redraw();
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
