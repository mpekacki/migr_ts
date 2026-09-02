import { SObjectRecord, Schema } from "jsforce";
import { Options } from "./config";
import IOEvent, { IOEventType } from "./ioevent";

/**
 * The fields worth keeping off an error object. Deliberately a fixed list rather
 * than a spread of everything enumerable: a transport error can carry the whole
 * request/response graph, and that is both circular (the debug formatter
 * JSON.stringify's the event) and far more than anyone wants in a log line.
 */
const ERROR_FIELDS = ['name', 'errorCode', 'statusCode', 'fields', 'stack'] as const;

/**
 * Errors reach this layer in three shapes: a thrown Error, the array of SaveErrors
 * a composite call returns for one record, or a plain object built by hand. None
 * of them survives the trip to the UI as it is - `${err}` renders the objects as
 * '[object Object]', and JSON.stringify drops an Error's message and stack because
 * both are non-enumerable - so flatten every shape into a plain object carrying a
 * readable `message` next to whatever details came with it.
 */
export function serializeError(error: any): Record<string, any> {
    if (Array.isArray(error)) {
        const errors = error.map(serializeError);
        return { message: errors.map(e => e.message).join(', '), errors };
    }
    if (error === null || typeof error !== 'object') {
        return { message: String(error) };
    }
    const serialized: Record<string, any> = {
        message: typeof error.message === 'string' ? error.message : String(error)
    };
    for (const field of ERROR_FIELDS) {
        if (error[field] !== undefined) {
            serialized[field] = error[field];
        }
    }
    return serialized;
}

/**
 * Long enough for any field worth reading back in a log, short enough that a
 * file never reaches one.
 */
const MAX_LOGGED_FIELD_LENGTH = 500;

/**
 * The records as the log should carry them.
 *
 * A file field holds megabytes of base64 and the debug formatter serializes the
 * whole event, so its contents are replaced by their length: the log needs to
 * say that a file was sent, not repeat it. Records with nothing oversized in
 * them are passed through untouched rather than copied.
 */
function forLogging(records: any[]): any[] {
    return records.map(recordForLogging);
}

/**
 * The field values an update was writing, ready to be reported: everything the
 * payload carried except `attributes`, which says nothing the event's sObjectName
 * does not already say.
 */
export function updatedFields(record: Record<string, any>): Record<string, any> {
    return recordForLogging(Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'attributes')));
}

/** One record's field values as the log should carry them. See forLogging. */
export function recordForLogging(record: any): any {
    let trimmed: any = null;
    for (const [field, value] of Object.entries(record)) {
        if (typeof value === 'string' && value.length > MAX_LOGGED_FIELD_LENGTH) {
            trimmed = trimmed ?? { ...record };
            trimmed[field] = `<${value.length} characters>`;
        }
    }
    return trimmed ?? record;
}

class IO {
    private readonly onOutput: (output: IOEvent) => void;
    private readonly onInput: (input: IOEvent) => Promise<string>;

    constructor(onOutput: (output: IOEvent) => void, onInput: (input: IOEvent) => Promise<string>) {
        this.onOutput = onOutput;
        this.onInput = onInput;
    }

    private buildIOEvent(category: 'output' | 'input', type: IOEventType, data?: any) : IOEvent {
        return new IOEvent(category, type, data);
    }

    public startingMigration(options: Options) {
        this.onOutput(this.buildIOEvent('output', 'starting_migration', { options }));
    }

    public describeSObject(sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'describing_sobject', { sObjectName }));
    }

    public checkingMatchers() {
        this.onOutput(this.buildIOEvent('output', 'checking_matchers'));
    }

    public recordsSoFar(count: number) {
        this.onOutput(this.buildIOEvent('output', 'records_so_far', { count }));
    }

    public fetchingRecord(recordId: string, sObjectName: string, reason?: string) {
        this.onOutput(this.buildIOEvent('output', 'fetching_record', { recordId, sObjectName, reason }));
    }

    public recordNotFound(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'record_not_found', { recordId, sObjectName }));
    }

    public recordNotQueryable(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'record_not_queryable', { recordId, sObjectName }));
    }

    public malformedId(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'malformed_id', { recordId, sObjectName }));
    }

    public queryingForRelatedRecords(soql: string) {
        this.onOutput(this.buildIOEvent('output', 'querying_related_records', { soql }));
    }

    public relatedRecords(relationshipName: string, count: number) {
        this.onOutput(this.buildIOEvent('output', 'related_records', { relationshipName, count }));
    }

    public fetchedRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', 'fetched_records', { count }));
    }

    public nothingToMigrate(alreadyMigrated: Record<string, number>) {
        this.onOutput(this.buildIOEvent('output', 'nothing_to_migrate', { alreadyMigrated }));
    }

    public async askForConfirmation(recordCountsBySObjectType: Record<string, any>) {
        const confirmation = await this.onInput(this.buildIOEvent('input', 'confirm_migration', recordCountsBySObjectType));
        this.confirmation(confirmation);
        return confirmation;
    }

    public aborted() {
        this.onOutput(this.buildIOEvent('output', 'aborted'));
    }

    public confirmation(confirmation: string) {
        this.onOutput(this.buildIOEvent('output', 'confirmation', { confirmation }));
    }

    public finished(data: string) {
        this.onOutput(this.buildIOEvent('output', 'finished', data));
    }

    public remainingRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', 'remaining_records', { count }));
    }

    /**
     * One record left the queue - created, matched, skipped or given up on - and
     * `count` are still waiting. Unlike remainingRecords this says nothing about
     * where the run is, only how much is left.
     */
    public recordSettled(count: number) {
        this.onOutput(this.buildIOEvent('output', 'record_settled', { count }));
    }

    public queryingForExistingRecord(soql: string) {
        this.onOutput(this.buildIOEvent('output', 'querying_existing_record', { soql }));
    }

    public foundExistingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'found_existing_record', { recordId, sObjectName }));
    }

    public skippingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', 'skipping_record', { recordId, sObjectName }));
    }

    public mapping(field: string, match: string, newRecordId: string, sObjectName: string, newValue: string) {
        this.onOutput(this.buildIOEvent('output', 'mapping', { field, match, newRecordId, sObjectName, newValue }));
    }

    public creatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', 'creating_record', { recordId, sObjectName, record }));
    }

    public savingRecords(chunk: Record<string, SObjectRecord<Schema, string>>) {
        const records = Object.values(chunk);
        const recordCountsByType: Record<string, number> = {};

        records.forEach(record => {
            const type = (record as any).attributes?.type || 'Unknown';
            recordCountsByType[type] = (recordCountsByType[type] || 0) + 1;
        });

        this.onOutput(this.buildIOEvent('output', 'saving_records', { recordCountsByType, records: forLogging(records) }));
    }

    public savedRecords(savedRecords: Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>) {
        this.onOutput(this.buildIOEvent('output', 'saved_records', savedRecords));
    }

    public createdRecord(recordId: string) {
        this.onOutput(this.buildIOEvent('output', 'created_record', { recordId }));
    }

    public skippingPreviouslyUsedSolvers(usedSolvers: any[]) {
        this.onOutput(this.buildIOEvent('output', 'skipping_previously_used_solvers', { usedSolvers }));
    }

    public fixingUsingSolver(error: string, solverMessage: string, solverAction: string) {
        this.onOutput(this.buildIOEvent('output', 'using_solver', { error, solverMessage, solverAction }));
    }

    public savedOldFieldsInToUpdateLater(oldFields: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', 'saved_old_fields', { oldFields }));
    }

    public matchingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', 'using_solver', { recordId, solver, solverAction: 'match' }));
    }

    public skippingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', 'using_solver', { recordId, solver, solverAction: 'skip' }));
    }

    public extractingColumnFromError(error: string, solverMessage: string) {
        this.onOutput(this.buildIOEvent('output', 'using_solver', { error, solverMessage, solverAction: 'extract_column' }));
    }

    public appendingRandomToRecord(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', 'using_solver', { recordId, solver, solverAction: 'append_random' }));
    }

    public error(message: string) {
        this.onOutput(this.buildIOEvent('output', 'error', { message }));
    }

    public hidingError(recordId: string) {
        this.onOutput(this.buildIOEvent('output', 'hidden_error', { recordId }));
    }

    public async askForInput(recordId: string, message: string, errorDetails?: any): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'insert_error', { recordId, error: message, errorDetails }));
    }

    public async askForFieldsToUpdate(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'insert_error', {}));
    }

    public invalidJson() {
        this.onOutput(this.buildIOEvent('output', 'invalid_json'));
    }

    public async askForMatch(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'insert_error', {}));
    }

    public async askForSolver(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'insert_error', {}));
    }

    public invalidRegex() {
        this.onOutput(this.buildIOEvent('output', 'invalid_regex'));
    }

    public invalidInput(input: string) {
        this.onOutput(this.buildIOEvent('output', 'invalid_input', { input }));
    }

    public lookingForCircularDependencies(requiredLookupFieldsBySObjectType: Record<string, string[]>, records: any[]) {
        this.onOutput(this.buildIOEvent('output', 'looking_for_circular_dependencies', { requiredLookupFieldsBySObjectType, records }));
    }

    /**
     * How far the scan has got. It is the one step of a run that can take a long
     * while with nothing else to say, so it says where it is instead of leaving
     * the screen on 'looking for circular dependencies' until it is done.
     */
    public circularDependencyProgress(progress: { pass: number, cleared: number, stage: 'graph' | 'search', done: number, total: number }) {
        this.onOutput(this.buildIOEvent('output', 'circular_dependency_progress', { ...progress }));
    }

    public foundCircularDependency(toClear: { recordId: string, field: string }[]) {
        this.onOutput(this.buildIOEvent('output', 'found_circular_dependency', { toClear }));
    }

    public recordNoId(recordId: string) {
        this.onOutput(this.buildIOEvent('output', 'record_no_id', { recordId }));
    }

    public updatingRecord(chunk: Record<string, any>) {
        const records = Object.values(chunk);
        const recordCountsByType: Record<string, number> = {};

        records.forEach(record => {
            const type = (record as any).attributes?.type || 'Unknown';
            recordCountsByType[type] = (recordCountsByType[type] || 0) + 1;
        });

        this.onOutput(this.buildIOEvent('output', 'updating_record', { recordCountsByType, records: forLogging(records) }));
    }

    /**
     * `record` is the payload that was sent to the org. Without it the report names
     * the record and the message but not what the update was trying to write, which
     * is exactly what tells apart a bad lookup value from a validation rule.
     */
    public errorUpdatingRecord(recordId: string, sObjectName: string, error: any, record?: Record<string, any>) {
        const fields = record ? updatedFields(record) : undefined;
        this.onOutput(this.buildIOEvent('output', 'error_updating_record', { recordId, sObjectName, error: serializeError(error), fields }));
    }

    public downloadingFile(recordId: string, sObjectName: string, field: string, size?: number) {
        this.onOutput(this.buildIOEvent('output', 'downloading_file', { recordId, sObjectName, field, size }));
    }

    public fileTooLarge(recordId: string, sObjectName: string, field: string, size: number, limit: number) {
        this.onOutput(this.buildIOEvent('output', 'file_too_large', { recordId, sObjectName, field, size, limit }));
    }

    public fileDownloadFailed(recordId: string, sObjectName: string, field: string, error: any) {
        this.onOutput(this.buildIOEvent('output', 'file_download_failed', { recordId, sObjectName, field, error: serializeError(error) }));
    }

    public fileDocumentMapped(documentId: string, newDocumentId: string, versionId: string) {
        this.onOutput(this.buildIOEvent('output', 'file_document_mapped', { documentId, newDocumentId, versionId }));
    }

    public fileDocumentUnavailable(documentId: string, versionId: string) {
        this.onOutput(this.buildIOEvent('output', 'file_document_unavailable', { documentId, versionId }));
    }

    public runningApexScript(phase: string, filePath: string, index: number, total: number) {
        this.onOutput(this.buildIOEvent('output', 'running_apex_script', { phase, filePath, index, total }));
    }

    public apexScriptDone(phase: string, filePath: string) {
        this.onOutput(this.buildIOEvent('output', 'apex_script_done', { phase, filePath }));
    }

    /**
     * `failure` is the one-line reason the run reports; `result` is the whole
     * Tooling API payload, which is where the stack trace of a script that threw
     * lives.
     */
    public apexScriptFailed(phase: string, filePath: string, failure: string, result: any) {
        this.onOutput(this.buildIOEvent('output', 'apex_script_failed', { phase, filePath, failure, result }));
    }

}

export default IO;
