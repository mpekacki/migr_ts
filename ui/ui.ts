import IOEvent from '../ioevent';

export interface UI {
    display(event: IOEvent): string;
    prompt(question: IOEvent): Promise<string>;
    /** Optionally block until the user acknowledges the final screen (e.g. a keypress). */
    awaitExit?(): Promise<void>;
    close(): void;
}