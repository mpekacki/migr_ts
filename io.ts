import { SObjectRecord, Schema } from "jsforce";
import { IOEvent, Options } from "./app";
import { IOEventType } from "./ioevent";

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

        this.onOutput(this.buildIOEvent('output', 'saving_records', { recordCountsByType, records }));
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

    public async askForInput(recordId: string, message: string): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'insert_error', { recordId, error: message }));
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

        this.onOutput(this.buildIOEvent('output', 'updating_record', { recordCountsByType, records }));
    }

    public errorUpdatingRecord(recordId: string, sObjectName: string, error: any) {
        this.onOutput(this.buildIOEvent('output', 'error_updating_record', { recordId, sObjectName, error }));
    }

}

export default IO;
