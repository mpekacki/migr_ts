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

    private buildIOEvent(category: 'output' | 'input', message: string, type: IOEventType, data?: any) : IOEvent {
        return new IOEvent(category, message, type, data);
    }

    public startingMigration(options: Options) {
        this.onOutput(this.buildIOEvent('output', `starting migration: ${JSON.stringify(options)}`, 'info', { options }));
    }

    public describeSObject(sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `describing SObject ${sObjectName}`, 'info', { sObjectName }));
    }

    public checkingMatchers() {
        this.onOutput(this.buildIOEvent('output', `checking matchers`, 'info', {}));
    }

    public recordsSoFar(count: number) {
        this.onOutput(this.buildIOEvent('output', `records so far: ${count}`, 'info', { count }));
    }

    public fetchingRecord(recordId: string, sObjectName: string, reason?: string) {
        const reasonText = reason ? ` (via ${reason})` : '';
        this.onOutput(this.buildIOEvent('output', `fetching record ${recordId} of type ${sObjectName}${reasonText}`, 'info', { recordId, sObjectName, reason }));
    }

    public recordNotFound(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} does not exist in the source org`, 'info', { recordId, sObjectName }));
    }

    public recordNotQueryable(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} is not queryable`, 'info', { recordId, sObjectName }));
    }

    public malformedId(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} is malformed`, 'info', { recordId, sObjectName }));
    }

    public queryingForRelatedRecords(soql: string) {
        this.onOutput(this.buildIOEvent('output', `querying for related records: ${soql}`, 'info', { soql }));
    }

    public relatedRecords(relationshipName: string, count: number) {
        this.onOutput(this.buildIOEvent('output', `related records of ${relationshipName}: ${count}`, 'info', { relationshipName, count }));
    }

    public fetchedRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', `fetched ${count} records`, 'info', { count }));
    }

    public async askForConfirmation(recordCountsBySObjectType: Record<string, any>) {
        const confirmation = await this.onInput(this.buildIOEvent('input', 'Do you want to continue? (y/n)', 'confirm_migration', recordCountsBySObjectType));
        this.confirmation(confirmation);
        return confirmation;
    }

    public aborted() {
        this.onOutput(this.buildIOEvent('output', 'aborted', 'info', {}));
    }

    public confirmation(confirmation: string) {
        this.onOutput(this.buildIOEvent('output', `confirmation: ${confirmation}`, 'info', { confirmation }));
    }

    public finished(data: string) {
        this.onOutput(this.buildIOEvent('output', 'finished', 'info', data));
    }

    public remainingRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', `remaining records: ${count}`, 'info', { count }));
    }

    public queryingForExistingRecord(soql: string) {
        this.onOutput(this.buildIOEvent('output', `querying for existing record: ${soql}`, 'info', { soql }));
    }

    public foundExistingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `found existing record ${recordId} of type ${sObjectName}`, 'info', { recordId, sObjectName }));
    }

    public skippingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `skipping record ${recordId} of type ${sObjectName} because no existing record was found`, 'info', { recordId, sObjectName }));
    }

    public mapping(field: string, match: string, newRecordId: string, sObjectName: string, newValue: string) {
        this.onOutput(this.buildIOEvent('output', `mapping ${field} to ${match} for record ${newRecordId} of type ${sObjectName} - new value: ${newValue}`, 'info', { field, match, newRecordId, sObjectName, newValue }));
    }

    public creatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `creating record ${recordId} of type ${sObjectName} with fields ${JSON.stringify(record)}`, 'creating_record', { recordId, sObjectName, record }));
    }

    public savingRecords(chunk: Record<string, SObjectRecord<Schema, string>>) {
        const records = Object.values(chunk);
        const recordCountsByType: Record<string, number> = {};

        // Count records by type
        records.forEach(record => {
            const type = (record as any).attributes?.type || 'Unknown';
            recordCountsByType[type] = (recordCountsByType[type] || 0) + 1;
        });

        // Format type counts (e.g., "1 Account, 2 Contact")
        const typeCounts = Object.entries(recordCountsByType)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');

        // Trim JSON to 1000 characters
        let jsonStr = JSON.stringify(records);
        if (jsonStr.length > 1000) {
            jsonStr = jsonStr.substring(0, 1000) + '...';
        }

        this.onOutput(this.buildIOEvent('output', `saving ${records.length} records (${typeCounts}): ${jsonStr}`, 'info', { recordCountsByType }));
    }

    public savedRecords(savedRecords: Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>) {
        this.onOutput(this.buildIOEvent('output', `saved records: ${JSON.stringify(savedRecords)}`, 'saved_records', savedRecords));
    }

    public createdRecord(recordId: string) {
        this.onOutput(this.buildIOEvent('output', `created record ${recordId}`, 'info', { recordId }));
    }

    public skippingPreviouslyUsedSolvers(usedSolvers: any[]) {
        this.onOutput(this.buildIOEvent('output', `skipping previously used solvers: ${JSON.stringify(usedSolvers)}`, 'info', { usedSolvers }));
    }

    public fixingUsingSolver(error: string, solverMessage: string, solverAction: string) {
        this.onOutput(this.buildIOEvent('output', `fixing using solver: ${solverMessage}`, 'using_solver', { error, solverMessage, solverAction }));
    }

    public savedOldFieldsInToUpdateLater(oldFields: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `saved old fields in toUpdateLater: ${JSON.stringify(oldFields)}`, 'info', { oldFields }));
    }

    public matchingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `matching record ${recordId} using solver: ${solver}`, 'info', { recordId, solver }));
    }

    public skippingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `skipping record ${recordId} using solver: ${solver}`, 'info', { recordId, solver }));
    }

    public extractingColumnFromError(error: string, solverMessage: string) {
        this.onOutput(this.buildIOEvent('output', `extracting column name from error: ${error}`, 'using_solver', { error, solverMessage, solverAction: 'extract_column' }));
    }

    public appendingRandomToRecord(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `appending random to record ${recordId} using solver: ${solver}`, 'info', { recordId, solver }));
    }

    public error(message: string) {
        this.onOutput(this.buildIOEvent('output', `error: ${message}`, 'info', { message }));
    }

    public async askForInput(recordId: string, message: string): Promise<string> {
        const options = [
            { key: 'f', label: 'Fix' },
            { key: 'r', label: 'Retry' },
            { key: 'ra', label: 'Retry All' },
            { key: 'm', label: 'Match' },
            { key: 'h', label: 'Save and Exit' },
            { key: 'a', label: 'Add Solver' },
            { key: 's', label: 'Skip' }
        ];
        const optionsList = options.map(opt => `- ${opt.label} (${opt.key})`).join('\n');
        return await this.onInput(this.buildIOEvent('input', `recordId: ${recordId}, no solver found for error: ${message}\nPlease provide input to resolve the error:\nAvailable options:\n${optionsList}:`, 'insert_error', { recordId, error: message }));
    }

    public async askForFieldsToUpdate(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', `Enter the fields to update in JSON format:`, 'insert_error', {}));
    }

    public invalidJson() {
        this.onOutput(this.buildIOEvent('output', `invalid JSON, please try again`, 'info', {}));
    }

    public async askForMatch(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', `Enter the ID of the record to match:`, 'insert_error', {}));
    }

    public async askForSolver(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'Enter the solver in JSON format:', 'insert_error', {}));
    }

    public invalidRegex() {
        this.onOutput(this.buildIOEvent('output', `invalid regex, please try again`, 'info', {}));
    }

    public invalidInput(input: string) {
        this.onOutput(this.buildIOEvent('output', `invalid input: ${input}`, 'info', { input }));
    }

    public lookingForCircularDependencies(requiredLookupFieldsBySObjectType: Record<string, string[]>, records: any[]) {
        this.onOutput(this.buildIOEvent('output', `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, 'info', { requiredLookupFieldsBySObjectType, records }));
    }

    public foundCircularDependency(toClear: { recordId: string, field: string }[]) {
        this.onOutput(this.buildIOEvent('output', `found circular dependency: ${JSON.stringify(toClear)}`, 'info', { toClear }));
    }

    public recordNoId(recordId: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} has no ID, skipping update`, 'info', { recordId }));
    }

    public updatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `updating record ${recordId} of type ${sObjectName} to ${JSON.stringify(record)}`, 'updating_record', { recordId, sObjectName, record }));
    }

    public errorUpdatingRecord(recordId: string, sObjectName: string, error: any) {
        this.onOutput(this.buildIOEvent('output', `error updating record ${recordId} of type ${sObjectName}: ${error}`, 'info', { recordId, sObjectName, error }));
    }

}

export default IO;