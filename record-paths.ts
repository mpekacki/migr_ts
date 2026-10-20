/**
 * How the run came to retrieve each record. A record is fetched either because
 * it was asked for (`recordIds`) or because a record fetched before it led to it,
 * and that one link is all the run keeps per record - its origin. Following the
 * origins back from any record ends at a requested one, which gives the whole
 * path: every lookup and child relationship the fetch went through to get there.
 *
 * This module imports nothing. The engine records the origins and the UI walks
 * them, and both read them through the types and helpers here.
 */

/**
 * `lookup`: a field of the record before it names it - a lookup, or any other
 * field an id was found in. `child`: it came back from a child relationship of
 * the record before it, one of those configured under `relationships`.
 */
export type OriginKind = 'lookup' | 'child';

export interface RecordOrigin {
    /** The record whose fetch turned this one up. */
    from: string;
    kind: OriginKind;
    /** The field (`lookup`) or the relationship (`child`) of `from` it was found through. */
    name: string;
}

/** One record the run retrieved, as the UI is told about it once fetching is over. */
export interface RetrievedRecord {
    id: string;
    sObjectType: string;
    /** A human-readable name for the record, where it has one. */
    label?: string;
    /** Absent on a requested record, and on every record loaded from a file. */
    origin?: RecordOrigin;
    /** Retrieved, but left out of this run because an earlier one migrated it. */
    alreadyMigrated?: boolean;
}

export interface PathStep {
    id: string;
    sObjectType: string;
    label?: string;
    /** How this record was reached from the step before it; absent on the first step. */
    via?: { kind: OriginKind; name: string };
}

/** The fields tried, in order, for a record's label. */
const LABEL_FIELDS = ['Name', 'Subject', 'Title', 'CaseNumber', 'DeveloperName', 'MasterLabel'];

export function recordLabel(record: Record<string, any> | undefined): string | undefined {
    for (const field of LABEL_FIELDS) {
        const value = record?.[field];
        if (typeof value === 'string' && value.trim() !== '') {
            return value;
        }
    }
    return undefined;
}

/**
 * The path that led to `id`, from the record it started at down to `id` itself.
 * `find` describes a record by id; the walk stops at a record without an origin,
 * at one `find` does not know, and - should the origins ever loop - at a record
 * it has already been through.
 */
export function tracePath(
    id: string,
    find: (id: string) => { sObjectType: string; label?: string; origin?: RecordOrigin } | undefined
): PathStep[] {
    const steps: PathStep[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const record = find(current);
        if (!record) {
            break;
        }
        const step: PathStep = { id: current, sObjectType: record.sObjectType, label: record.label };
        if (record.origin) {
            step.via = { kind: record.origin.kind, name: record.origin.name };
        }
        steps.unshift(step);
        current = record.origin?.from;
    }
    return steps;
}

/** A relationship reads as a collection - `Contacts[]` - and a field as itself. */
export function edgeLabel(via: { kind: OriginKind; name: string }): string {
    return via.kind === 'child' ? `${via.name}[]` : via.name;
}

/**
 * The hops that led to the last step, for a log line:
 * `Account 001… > Contacts[] > Contact 003… > ReportsToId`. Empty for a path of
 * one step - a record nothing led to.
 */
export function describePathWithIds(steps: PathStep[]): string {
    const parts: string[] = [];
    for (let i = 1; i < steps.length; i++) {
        parts.push(`${steps[i - 1].sObjectType} ${steps[i - 1].id}`, edgeLabel(steps[i].via!));
    }
    return parts.join(' > ');
}

/**
 * The same hops by record type alone, short enough for one line of the TUI:
 * `Account.Contacts[] › Contact.ReportsToId`.
 */
export function describePathByType(steps: PathStep[]): string {
    const hops: string[] = [];
    for (let i = 1; i < steps.length; i++) {
        hops.push(`${steps[i - 1].sObjectType}.${edgeLabel(steps[i].via!)}`);
    }
    return hops.join(' › ');
}
