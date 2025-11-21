import { IOEvent } from '../app';

export interface UI {
    display(event: IOEvent): string;
    prompt(question: IOEvent): Promise<string>;
    close(): void;
}