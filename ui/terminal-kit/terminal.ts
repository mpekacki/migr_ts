import { terminal } from 'terminal-kit';
import IOEvent from '../../ioevent';
import { UI } from '../ui';
import { getFormatter } from '../event-formatter';
import { helperChoices, JsonHelper } from '../json-helper';
import readline from 'readline';

const BACK = '<';
const MAX_LISTED = 30;

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

    async prompt(question: IOEvent): Promise<string> {
        for (;;) {
            const answer = await this.ask(this.formatter(question));
            if (!question.data?.helper || answer.trim() !== '') return answer;
            const built = await this.runHelper(new JsonHelper(question.data.helper));
            if (built !== null) return built;
        }
    }

    private ask(text: string): Promise<string> {
        return new Promise((resolve) => this.rl.question(text, resolve));
    }

    /** Null when the user backed out of the first step: they are asked for the JSON again. */
    private async runHelper(helper: JsonHelper): Promise<string | null> {
        let filter = '';
        for (;;) {
            const step = helper.step;
            let answer: string;
            if (!step) {
                answer = await this.ask(`\nBuilt: ${helper.result}\nPress Enter to use it, type other JSON instead, or ${BACK} to go back:\n> `);
                if (answer.trim() !== BACK) return answer.trim() === '' ? helper.result : answer;
            } else if (step.kind === 'choose') {
                const choices = helperChoices(step, filter);
                const listed = choices.slice(0, MAX_LISTED).map((c, i) => `  ${i + 1}. ${c.label}${c.hint ? ` (${c.hint})` : ''}`);
                if (choices.length > MAX_LISTED) listed.push(`  ... and ${choices.length - MAX_LISTED} more`);
                if (choices.length === 0) listed.push(`  nothing matches "${filter}" - press Enter to list everything`);
                answer = await this.ask(`\n${step.title}\n${listed.join('\n')}\nEnter a number, text to filter by, or ${BACK} to go back:\n> `);
                if (answer.trim() !== BACK) {
                    const picked = /^\d+$/.test(answer.trim()) ? choices.slice(0, MAX_LISTED)[Number(answer) - 1] : undefined;
                    const found = helperChoices(step, answer);
                    const only = answer.trim() !== '' && (found.length === 1 || found[0]?.label.toLowerCase() === answer.trim().toLowerCase())
                        ? found[0] : undefined;
                    if (picked ?? only) {
                        helper.answer((picked ?? only)!.answer);
                        filter = '';
                    } else {
                        filter = answer;
                    }
                    continue;
                }
            } else {
                const hint = step.initial ? `\nPress Enter for: ${step.initial}` : '';
                const problem = helper.problem ? `\n${helper.problem}` : '';
                answer = await this.ask(`\n${step.title}${hint}${problem}\n(${BACK} to go back)\n> `);
                if (answer.trim() !== BACK) {
                    helper.answer({ text: answer === '' ? step.initial ?? '' : answer });
                    continue;
                }
            }
            filter = '';
            if (!helper.back()) return null;
        }
    }

    close(): void {
        this.rl.close();
    }
}
