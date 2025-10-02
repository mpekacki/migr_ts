import { SObjectRecord, Schema } from "jsforce";
import { IOEvent, Options } from "./app";

class IO {
    private readonly onOutput: (output: IOEvent) => void;
    private readonly onInput: (input: IOEvent) => Promise<string>;

    constructor(onOutput: (output: IOEvent) => void, onInput: (input: IOEvent) => Promise<string>) {
        this.onOutput = onOutput;
        this.onInput = onInput;
    }

    private buildIOEvent(category: 'output' | 'input', message: string, type: 'confirm_migration' | 'info' | 'insert_error', data?: string) : IOEvent {
        return new IOEvent(category as 'output' | 'input', message, type as 'confirm_migration' | 'info' | 'insert_error', data);
    }

    public startingMigration(options: Options) {
        this.onOutput(this.buildIOEvent('output', `starting migration: ${JSON.stringify(options)}`, 'info'));
    }

    public describeSObject(sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `describing SObject ${sObjectName}`, 'info'));
    }

    public checkingMatchers() {
        this.onOutput(this.buildIOEvent('output', `checking matchers`, 'info'));
    }

    public recordsSoFar(count: number) {
        this.onOutput(this.buildIOEvent('output', `records so far: ${count}`, 'info'));
    }

    public fetchingRecord(recordId: string, sObjectName: string, reason?: string) {
        const reasonText = reason ? ` (via ${reason})` : '';
        this.onOutput(this.buildIOEvent('output', `fetching record ${recordId} of type ${sObjectName}${reasonText}`, 'info'));
    }

    public recordNotFound(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} does not exist in the source org`, 'info'));
    }

    public recordNotQueryable(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} is not queryable`, 'info'));
    }

    public malformedId(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} of type ${sObjectName} is malformed`, 'info'));
    }

    public queryingForRelatedRecords(soql: string) {
        this.onOutput(this.buildIOEvent('output', `querying for related records: ${soql}`, 'info'));
    }

    public relatedRecords(relationshipName: string, count: number) {
        this.onOutput(this.buildIOEvent('output', `related records of ${relationshipName}: ${count}`, 'info'));
    }

    public fetchedRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', `fetched ${count} records`, 'info'));
    }

    public async askForConfirmation(recordCountsBySObjectType: Record<string, any>) {
        const confirmation = await this.onInput(this.buildIOEvent('input', 'Do you want to continue? (y/n)', 'confirm_migration', JSON.stringify(recordCountsBySObjectType)));
        this.confirmation(confirmation);
        return confirmation;
    }

    public aborted() {
        this.onOutput(this.buildIOEvent('output', 'aborted', 'info'));
    }

    public confirmation(confirmation: string) {
        this.onOutput(this.buildIOEvent('output', `confirmation: ${confirmation}`, 'info'));
    }

    public finished(data: string) {
        this.onOutput(this.buildIOEvent('output', 'finished', 'info', data));
    }

    public remainingRecords(count: number) {
        this.onOutput(this.buildIOEvent('output', `remaining records: ${count}`, 'info'));
    }

    public queryingForExistingRecord(soql: string) {
        this.onOutput(this.buildIOEvent('output', `querying for existing record: ${soql}`, 'info'));
    }

    public foundExistingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `found existing record ${recordId} of type ${sObjectName}`, 'info'));
    }

    public skippingRecord(recordId: string, sObjectName: string) {
        this.onOutput(this.buildIOEvent('output', `skipping record ${recordId} of type ${sObjectName} because no existing record was found`, 'info'));
    }

    public mapping(field: string, match: string, newRecordId: string, sObjectName: string, newValue: string) {
        this.onOutput(this.buildIOEvent('output', `mapping ${field} to ${match} for record ${newRecordId} of type ${sObjectName} - new value: ${newValue}`, 'info'));
    }

    public creatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `creating record ${recordId} of type ${sObjectName} with fields ${JSON.stringify(record)}`, 'info'));
    }

    public savingRecords(chunk: Record<string, SObjectRecord<Schema, string>>) {
        this.onOutput(this.buildIOEvent('output', `saving ${Object.keys(chunk).length} records: ${JSON.stringify(Object.values(chunk))}`, 'info'));
    }

    public savedRecords(savedRecords: Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>) {
        this.onOutput(this.buildIOEvent('output', `saved records: ${JSON.stringify(savedRecords)}`, 'info'));
    }

    public createdRecord(recordId: string) {
        this.onOutput(this.buildIOEvent('output', `created record ${recordId}`, 'info'));
    }

    public skippingPreviouslyUsedSolvers(usedSolvers: any[]) {
        this.onOutput(this.buildIOEvent('output', `skipping previously used solvers: ${JSON.stringify(usedSolvers)}`, 'info'));
    }

    public fixingUsingSolver(solver: string) {
        this.onOutput(this.buildIOEvent('output', `fixing using solver: ${solver}`, 'info'));
    }

    public savedOldFieldsInToUpdateLater(oldFields: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `saved old fields in toUpdateLater: ${JSON.stringify(oldFields)}`, 'info'));
    }

    public matchingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `matching record ${recordId} using solver: ${solver}`, 'info'));
    }

    public skippingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `skipping record ${recordId} using solver: ${solver}`, 'info'));
    }

    public extractingColumnFromError(error: string) {
        this.onOutput(this.buildIOEvent('output', `extracting column name from error: ${error}`, 'info'));
    }

    public appendingRandomToRecord(recordId: string, solver: string) {
        this.onOutput(this.buildIOEvent('output', `appending random to record ${recordId} using solver: ${solver}`, 'info'));
    }

    public error(message: string) {
        this.onOutput(this.buildIOEvent('output', `error: ${message}`, 'info'));
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
        return await this.onInput(this.buildIOEvent('input', `recordId: ${recordId}, no solver found for error: ${message}\nPlease provide input to resolve the error:\nAvailable options:\n${optionsList}:`, 'insert_error'));
    }

    public async askForFieldsToUpdate(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', `Enter the fields to update in JSON format:`, 'insert_error'));
    }

    public invalidJson() {
        this.onOutput(this.buildIOEvent('output', `invalid JSON, please try again`, 'info'));
    }

    public async askForMatch(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', `Enter the ID of the record to match:`, 'insert_error'));
    }

    public async askForSolver(): Promise<string> {
        return await this.onInput(this.buildIOEvent('input', 'Enter the solver in JSON format:', 'insert_error'));
    }

    public invalidRegex() {
        this.onOutput(this.buildIOEvent('output', `invalid regex, please try again`, 'info'));
    }

    public invalidInput(input: string) {
        this.onOutput(this.buildIOEvent('output', `invalid input: ${input}`, 'info'));
    }

    public lookingForCircularDependencies(requiredLookupFieldsBySObjectType: Record<string, string[]>, records: any[]) {
        this.onOutput(this.buildIOEvent('output', `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, 'info'));
    }

    public foundCircularDependency(toClear: { recordId: string, field: string }[]) {
        this.onOutput(this.buildIOEvent('output', `found circular dependency: ${JSON.stringify(toClear)}`, 'info'));
    }

    public recordNoId(recordId: string) {
        this.onOutput(this.buildIOEvent('output', `record ${recordId} has no ID, skipping update`, 'info'));
    }

    public updatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput(this.buildIOEvent('output', `updating record ${recordId} of type ${sObjectName} to ${JSON.stringify(record)}`, 'info'));
    }

    public errorUpdatingRecord(recordId: string, sObjectName: string, error: any) {
        this.onOutput(this.buildIOEvent('output', `error updating record ${recordId} of type ${sObjectName}: ${error}`, 'info'));
    }

}

export default IO;