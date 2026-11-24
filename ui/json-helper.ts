import { SolverType } from '../config';
import { HelperField, JsonHelperContext } from '../ioevent';

/**
 * The step-by-step builders behind the two error prompts that take JSON. They
 * only ever produce the text the user could have typed: the engine is sent the
 * same JSON either way and knows nothing of the steps.
 *
 * A builder is a generator that yields questions and is sent answers. It has to
 * be deterministic - going back a step is replaying every answer but the last -
 * and knows nothing of how a question is put, so both UIs run the same one.
 */

export interface HelperOption {
    label: string;
    hint?: string;
}

export type HelperStep =
    | {
        kind: 'choose';
        title: string;
        options: HelperOption[];
        /** Set when a typed text that is none of the options is an answer too: says what it would mean. */
        custom?: (text: string) => string;
    }
    | {
        kind: 'text';
        title: string;
        initial?: string;
        /** Says what is wrong with an answer, or undefined when nothing is. */
        validate?: (text: string) => string | undefined;
    };

export type HelperAnswer = { option: number } | { text: string };

type Steps<T> = Generator<HelperStep, T, HelperAnswer>;

export class JsonHelper {
    /** The question to answer, or null once there is a `result`. */
    step: HelperStep | null = null;
    result: string | null = null;
    /** Why the last answer was not taken. */
    problem: string | null = null;
    private answers: HelperAnswer[] = [];
    private steps!: Steps<unknown>;

    constructor(readonly context: JsonHelperContext) {
        this.replay([]);
    }

    answer(answer: HelperAnswer): void {
        this.problem = null;
        if (this.step?.kind === 'text' && 'text' in answer) {
            this.problem = this.step.validate?.(answer.text) ?? null;
            if (this.problem) return;
        }
        this.answers.push(answer);
        this.advance(this.steps.next(answer));
    }

    /** Takes the last answer back. False when there is none, i.e. at the first question. */
    back(): boolean {
        this.problem = null;
        if (this.answers.length === 0) return false;
        this.replay(this.answers.slice(0, -1));
        return true;
    }

    private replay(answers: HelperAnswer[]): void {
        this.steps = this.context.kind === 'fix' ? fixSteps(this.context) : solverSteps(this.context);
        this.answers = answers;
        this.advance(this.steps.next());
        for (const answer of answers) this.advance(this.steps.next(answer));
    }

    private advance(next: IteratorResult<HelperStep, unknown>): void {
        this.step = next.done ? null : next.value;
        this.result = next.done ? JSON.stringify(next.value) : null;
    }
}

/** The answers a question offers once `filter` has been typed at it. */
export function helperChoices(step: HelperStep, filter: string): { label: string, hint?: string, answer: HelperAnswer }[] {
    if (step.kind !== 'choose') return [];
    const needle = filter.trim().toLowerCase();
    const choices = step.options
        .map((option, index) => ({ ...option, answer: { option: index } as HelperAnswer }))
        .filter(({ label, hint }) => `${label} ${hint ?? ''}`.toLowerCase().includes(needle));
    // The option spelled out in full goes first, so Enter takes what was typed.
    const isExact = ({ label }: HelperOption) => label.toLowerCase() === needle;
    choices.sort((a, b) => Number(isExact(b)) - Number(isExact(a)));
    if (needle && step.custom && !choices.some(isExact)) {
        choices.push({ label: step.custom(filter.trim()), hint: undefined, answer: { text: filter.trim() } });
    }
    return choices;
}

// ── the steps ───────────────────────────────────────────────────────────────

/** Asks for one of `choices`, handing back its value - or the text typed instead. */
function* choose<T>(
    title: string,
    choices: (HelperOption & { value: T })[],
    custom?: { label: (text: string) => string, value: (text: string) => T },
): Steps<T> {
    const options = choices.map(({ label, hint }) => ({ label: oneLine(label), hint: hint === undefined ? undefined : oneLine(hint) }));
    const answer = yield { kind: 'choose', title, options, custom: custom?.label };
    return 'option' in answer ? choices[answer.option].value : custom!.value(answer.text);
}

function* text(title: string, initial?: string, validate?: (text: string) => string | undefined): Steps<string> {
    const answer = yield { kind: 'text', title, initial, validate };
    return 'text' in answer ? answer.text : '';
}

type FieldValue = string | number | boolean | null;

function* fixSteps(ctx: JsonHelperContext): Steps<Record<string, FieldValue>> {
    const changes = yield* changeFieldsSteps(ctx);
    return Object.fromEntries(changes.map(({ field, value }) => [field, value]));
}

function* changeFieldsSteps(ctx: JsonHelperContext): Steps<{ field: string, value: FieldValue }[]> {
    const changes: { field: string, value: FieldValue }[] = [];
    let more = true;
    while (more) {
        const field = yield* fieldStep('Which field should be changed?', ctx, changes.map(change => change.field));
        changes.push({ field, value: yield* valueStep(`New value of ${field}?`, ctx, field) });
        more = yield* anotherStep(changes.map(change => `${change.field} = ${JSON.stringify(change.value)}`));
    }
    return changes;
}

function* anotherStep(soFar: string[]): Steps<boolean> {
    return yield* choose(`So far: ${soFar.join(', ')}. Change another field too?`, [
        { label: 'No, done', value: false },
        { label: 'Yes, another field', value: true },
    ]);
}

/** The fields the error names come first, then those the record has a value in, then the rest. */
function* fieldStep(title: string, ctx: JsonHelperContext, taken: string[], only: (field: HelperField) => boolean = () => true): Steps<string> {
    const known = new Map(ctx.fields.map(field => [field.name, field]));
    for (const name of [...ctx.errorFields, ...Object.keys(ctx.values)]) {
        if (!known.has(name)) known.set(name, { name });
    }
    const rank = ({ name }: HelperField) => ctx.errorFields.includes(name) ? 0 : hasValue(ctx.values[name]) ? 1 : 2;
    const fields = [...known.values()]
        .filter(field => !taken.includes(field.name) && only(field))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return yield* choose(
        title,
        fields.map(field => ({
            label: field.name,
            hint: [
                rank(field) === 0 ? 'named by the error' : '',
                field.label && field.label !== field.name ? field.label : '',
                field.type ?? '',
                hasValue(ctx.values[field.name]) ? `now ${JSON.stringify(ctx.values[field.name])}` : '',
            ].filter(Boolean).join(' · '),
            value: field.name,
        })),
        { label: name => `Use field "${name}"`, value: name => name },
    );
}

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

const NUMBER_TYPES = ['int', 'long', 'double', 'currency', 'percent'];
const PICKLIST_TYPES = ['picklist', 'multipicklist', 'combobox'];

function typedValue(value: string, type: string | undefined): FieldValue {
    if (type === 'boolean' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (type && NUMBER_TYPES.includes(type) && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return value;
}

function* valueStep(title: string, ctx: JsonHelperContext, name: string): Steps<FieldValue> {
    const field = ctx.fields.find(field => field.name === name);
    const choices: (HelperOption & { value: { set: FieldValue } | 'type' })[] = [];
    if (field?.type === 'boolean') {
        choices.push({ label: 'true', value: { set: true } }, { label: 'false', value: { set: false } });
    } else if (field?.type && PICKLIST_TYPES.includes(field.type)) {
        for (const value of field.picklistValues ?? []) choices.push({ label: value, value: { set: value } });
    }
    choices.push(
        { label: 'Type a value', value: 'type' },
        {
            label: 'Empty the field',
            hint: ctx.phase === 'insert' ? 'the original value is written back after the insert' : undefined,
            value: { set: '' },
        },
        { label: 'Leave the field out', hint: 'null - not sent at all, and not restored later', value: { set: null } },
    );
    const chosen = yield* choose<{ set: FieldValue } | 'type'>(title, choices, {
        label: value => `Use value "${value}"`,
        value: value => ({ set: typedValue(value, field?.type) }),
    });
    return chosen === 'type' ? typedValue(yield* text(title), field?.type) : chosen.set;
}

function* solverSteps(ctx: JsonHelperContext): Steps<SolverType> {
    // retry, backoff and fallback are left out: they act on a failed API call,
    // never on the per-record error this prompt is about.
    const action = yield* choose<'fix' | 'skip' | 'match' | 'extract_column' | 'append_random'>('What should the solver do?', [
        { label: 'fix', hint: 'set fields to given values and retry', value: 'fix' },
        { label: 'skip', hint: 'skip the record', value: 'skip' },
        // An update has no record to match away to.
        ...(ctx.phase === 'insert'
            ? [{ label: 'match', hint: 'use the existing record whose id is in the error', value: 'match' as const }]
            : []),
        { label: 'extract_column', hint: 'drop or replace the field the error names, and retry', value: 'extract_column' },
        { label: 'append_random', hint: 'append a random suffix to fields, and retry', value: 'append_random' },
    ]);

    let solver: Record<string, unknown>;
    if (action === 'match') {
        solver = { ...yield* messageStep(ctx, 'id'), action };
    } else if (action === 'extract_column') {
        const fromFields = ctx.errorFields.length > 0 && (yield* choose('Where is the name of the field taken from?', [
            { label: 'The first field the error lists', hint: ctx.errorFields[0], value: true },
            { label: 'The text of the error', value: false },
        ]));
        const message = yield* messageStep(ctx, fromFields ? undefined : 'field');
        const drop = yield* choose('What should happen to that field?', [
            { label: 'Leave it out', hint: 'null - not restored later', value: true },
            { label: 'Replace its value', value: false },
        ]);
        const replaceWith = drop ? null : yield* text('Value to replace it with?');
        solver = { ...message, action, ...(fromFields ? { fromFields } : {}), replaceWith };
    } else if (action === 'append_random') {
        const message = yield* messageStep(ctx);
        const changeFields: { field: string, length: number }[] = [];
        let more = true;
        while (more) {
            const field = yield* fieldStep(
                'Which field should get the random suffix?', ctx, changeFields.map(change => change.field),
                // The suffix is appended to the value the field has.
                field => typeof ctx.values[field.name] === 'string' && ctx.values[field.name] !== '',
            );
            const length = yield* text(`Length of the suffix of ${field}?`, '5',
                value => /^([1-9]|10)$/.test(value.trim()) ? undefined : 'Enter a whole number from 1 to 10');
            changeFields.push({ field, length: Number(length) });
            more = yield* anotherStep(changeFields.map(change => `${change.field} (${change.length})`));
        }
        solver = { ...message, action, changeFields };
    } else if (action === 'fix') {
        const message = yield* messageStep(ctx);
        solver = { ...message, action, changeFields: yield* changeFieldsSteps(ctx) };
    } else {
        solver = { ...yield* messageStep(ctx), action };
    }

    const hideError = yield* choose('Should the errors it handles be reported?', [
        { label: 'Yes, report them', value: false },
        { label: 'No, hide them', hint: 'hideError', value: true },
    ]);
    return { ...solver, ...(hideError ? { hideError } : {}) } as unknown as SolverType;
}

/** What the pattern of a solver has to capture, if anything. */
type Capture = 'id' | 'field';

function* messageStep(ctx: JsonHelperContext, capture?: Capture): Steps<{ message: string, exact?: true }> {
    const choices: (HelperOption & { value: { message: string, exact?: true } | 'type' })[] = [];
    if (capture) {
        for (const found of captureCandidates(ctx, capture)) {
            choices.push({ label: `Capture ${found.text}`, hint: found.pattern, value: { message: found.pattern } });
        }
    } else {
        choices.push({ label: 'Exactly this error', hint: 'the whole text, literally', value: { message: ctx.error, exact: true } });
        const general = generalized(ctx.error);
        if (general !== escapeRegex(ctx.error)) {
            choices.push({ label: 'This error with any ids, numbers and quoted values', hint: general, value: { message: general } });
        }
        choices.push({ label: 'Any error containing this text', hint: escapeRegex(ctx.error), value: { message: escapeRegex(ctx.error) } });
    }
    choices.push({ label: 'Type a pattern', hint: 'a regular expression', value: 'type' });
    const chosen = yield* choose('Which errors should it act on?', choices);
    if (chosen !== 'type') return chosen;
    const message = yield* text(
        capture
            ? `Regular expression, with the ${capture === 'id' ? 'record id' : 'field name'} in the first (group)?`
            : 'Regular expression the error has to match?',
        escapeRegex(ctx.error),
        value => patternProblem(value, ctx.error, capture),
    );
    return { message };
}

function patternProblem(pattern: string, error: string, capture: Capture | undefined): string | undefined {
    if (pattern === '') return 'Enter a pattern';
    let match;
    try {
        match = new RegExp(pattern).exec(error);
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
    if (!match) return 'This does not match the error being resolved';
    if (capture && !match[1]) return `This captures nothing - put the ${capture === 'id' ? 'record id' : 'field name'} in (parentheses)`;
    return undefined;
}

/** The parts of the error worth capturing, each with a pattern that captures it and lets the other values vary. */
function captureCandidates(ctx: JsonHelperContext, capture: Capture): { text: string, pattern: string }[] {
    const names = new Set([...ctx.fields.map(field => field.name), ...Object.keys(ctx.values), ...ctx.errorFields]);
    const candidates: { text: string, pattern: string }[] = [];
    for (const word of ctx.error.matchAll(/\w+/g)) {
        const matches = capture === 'id' ? isId(word[0]) : names.has(word[0]) || /__c$/i.test(word[0]);
        if (!matches) continue;
        const before = ctx.error.slice(0, word.index);
        const after = ctx.error.slice(word.index + word[0].length);
        const group = capture === 'id' ? '([a-zA-Z0-9]{15,18})' : '(\\w+)';
        const literal = escapeRegex(before) + group + escapeRegex(after);
        // Generalizing can leave the group in the wrong place, next to wildcards
        // that take part of it: keep the literal pattern when it does.
        const general = generalized(before) + group + generalized(after);
        const pattern = new RegExp(general).exec(ctx.error)?.[1] === word[0] ? general : literal;
        candidates.push({ text: word[0], pattern });
    }
    return candidates;
}

/** An id has a digit in it somewhere, which is what tells it from a long word. */
function isId(word: string): boolean {
    return /^([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(word) && /\d/.test(word);
}

function generalized(message: string): string {
    // Split on what varies from record to record, keeping it (odd indexes).
    return message.split(/("[^"]*"|(?<!\w)'[^']*'(?!\w)|\b\w+\b)/).map((part, i) => {
        if (i % 2 === 0) return escapeRegex(part);
        if (part.startsWith('"')) return '"[^"]*"';
        if (part.startsWith('\'')) return '\'[^\']*\'';
        if (isId(part)) return '[a-zA-Z0-9]{15,18}';
        return /^\d+$/.test(part) ? '\\d+' : part;
    }).join('');
}

/** Matches `text` literally - on one line, so that it can be edited on one. */
function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** Fit for a line of a list, whatever the record or the error had in it. */
export function oneLine(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x1f\x7f]+/g, ' ');
}
