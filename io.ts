import { SObjectRecord, Schema } from "jsforce";
import { IOEvent, Options } from "./app";

class IO {
    private readonly onOutput: (output: IOEvent) => void;
    private readonly onInput: (input: IOEvent) => Promise<string>;

    constructor(onOutput: (output: IOEvent) => void, onInput: (input: IOEvent) => Promise<string>) {
        this.onOutput = onOutput;
        this.onInput = onInput;
    }

    public startingMigration(options: Options) {
        this.onOutput({ category: 'output', message: `starting migration: ${JSON.stringify(options)}`, type: 'info' });
    }

    public describeSObject(sObjectName: string) {
        this.onOutput({ category: 'output', message: `describing SObject ${sObjectName}`, type: 'info' });
    }

    public checkingMatchers() {
        this.onOutput({ category: 'output', message: `checking matchers`, type: 'info' });
    }

    public recordsSoFar(count: number) {
        this.onOutput({ category: 'output', message: `records so far: ${count}`, type: 'info' });
    }

    public fetchingRecord(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `fetching record ${recordId} of type ${sObjectName}`, type: 'info' });
    }

    public recordNotFound(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `record ${recordId} of type ${sObjectName} does not exist in the source org`, type: 'info' });
    }

    public recordNotQueryable(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `record ${recordId} of type ${sObjectName} is not queryable`, type: 'info' });
    }

    public malformedId(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `record ${recordId} of type ${sObjectName} is malformed`, type: 'info' });
    }

    public queryingForRelatedRecords(soql: string) {
        this.onOutput({ category: 'output', message: `querying for related records: ${soql}`, type: 'info' });
    }

    public relatedRecords(relationshipName: string, count: number) {
        this.onOutput({ category: 'output', message: `related records of ${relationshipName}: ${count}`, type: 'info' });
    }

    public fetchedRecords(count: number) {
        this.onOutput({ category: 'output', message: `fetched ${count} records`, type: 'info' });
    }

    public async askForConfirmation(recordCountsBySObjectType: Record<string, number>) {
        const confirmation = await this.onInput({ category: 'input', message: 'Do you want to continue? (y/n)', type: 'confirm_migration', data: JSON.stringify(recordCountsBySObjectType) });
        this.confirmation(confirmation);
        return confirmation;
    }

    public aborted() {
        this.onOutput({ category: 'output', message: 'Aborted', type: 'info' });
    }

    public confirmation(confirmation: string) {
        this.onOutput({ category: 'output', message: `confirmation: ${confirmation}`, type: 'info' });
    }

    public finished(data: string) {
        this.onOutput({ category: 'output', message: 'Finished', data, type: 'info' });
    }

    public remainingRecords(count: number) {
        this.onOutput({ category: 'output', message: `remaining records: ${count}`, type: 'info' });
    }

    public queryingForExistingRecord(soql: string) {
        this.onOutput({ category: 'output', message: `querying for existing record: ${soql}`, type: 'info' });
    }

    public foundExistingRecord(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `found existing record ${recordId} of type ${sObjectName}`, type: 'info' });
    }

    public skippingRecord(recordId: string, sObjectName: string) {
        this.onOutput({ category: 'output', message: `skipping record ${recordId} of type ${sObjectName} because no existing record was found`, type: 'info' });
    }

    public mapping(field: string, match: string, newRecordId: string, sObjectName: string, newValue: string) {
        this.onOutput({ category: 'output', message: `mapping ${field} to ${match} for record ${newRecordId} of type ${sObjectName} - new value: ${newValue}`, type: 'info' });
    }

    public creatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput({ category: 'output', message: `creating record ${recordId} of type ${sObjectName} with fields ${JSON.stringify(record)}`, type: 'info' });
    }

    public savingRecords(chunk: Record<string, SObjectRecord<Schema, string>>) {
        this.onOutput({ category: 'output', message: `saving ${Object.keys(chunk).length} records: ${JSON.stringify(Object.values(chunk))}`, type: 'info' });
    }

    public savedRecords(savedRecords: Array<{ id: string, success: boolean, errors: { message: string, fields: string[] }[] }>) {
        this.onOutput({ category: 'output', message: `saved records: ${JSON.stringify(savedRecords)}`, type: 'info' });
    }

    public createdRecord(recordId: string) {
        this.onOutput({ category: 'output', message: `created record ${recordId}`, type: 'info' });
    }

    public skippingPreviouslyUsedSolvers(usedSolvers: any[]) {
        this.onOutput({ category: 'output', message: `skipping previously used solvers: ${JSON.stringify(usedSolvers)}`, type: 'info' });
    }

    public fixingUsingSolver(solver: string) {
        this.onOutput({ category: 'output', message: `fixing using solver: ${solver}`, type: 'info' });
    }

    public savedOldFieldsInToUpdateLater(oldFields: Record<string, string>) {
        this.onOutput({ category: 'output', message: `saved old fields in toUpdateLater: ${JSON.stringify(oldFields)}`, type: 'info' });
    }

    public matchingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput({ category: 'output', message: `matching record ${recordId} using solver: ${solver}`, type: 'info' });
    }

    public skippingRecordUsingSolver(recordId: string, solver: string) {
        this.onOutput({ category: 'output', message: `skipping record ${recordId} using solver: ${solver}`, type: 'info' });
    }

    public extractingColumnFromError(error: string) {
        this.onOutput({ category: 'output', message: `extracting column name from error: ${error}`, type: 'info' });
    }

    public appendingRandomToRecord(recordId: string, solver: string) {
        this.onOutput({ category: 'output', message: `appending random to record ${recordId} using solver: ${solver}`, type: 'info' });
    }

    public error(message: string) {
        this.onOutput({ category: 'output', message: `error: ${message}`, type: 'info' });
    }

    public async askForInput(recordId: string, message: string): Promise<string> {
        return await this.onInput({ category: 'input', message: `recordId: ${recordId}, no solver found for error: ${message}`, type: 'insert_error' });
    }

    public async askForFieldsToUpdate(recordId: string, message: string): Promise<string> {
        return await this.onInput({ category: 'input', message: `recordId: ${recordId}, no solver found for error: ${message}`, type: 'insert_error' });
    }

    public invalidJson() {
        this.onOutput({ category: 'output', message: `invalid JSON, please try again`, type: 'info' });
    }

    public async askForMatch(): Promise<string> {
        return await this.onInput({ category: 'input', message: `Enter the ID of the record to match:`, type: 'insert_error' });
    }

    public async askForSolver(): Promise<string> {
        return await this.onInput({ category: 'input', message: 'Enter the solver in JSON format:', type: 'insert_error' });
    }

    public invalidRegex() {
        this.onOutput({ category: 'output', message: `invalid regex, please try again`, type: 'info' });
    }

    public invalidInput(input: string) {
        this.onOutput({ category: 'output', message: `invalid input: ${input}`, type: 'info' });
    }

    public lookingForCircularDependencies(requiredLookupFieldsBySObjectType: Record<string, string[]>, records: any[]) {
        this.onOutput({ category: 'output', message: `looking for circular dependencies with ${JSON.stringify(requiredLookupFieldsBySObjectType)} for records ${JSON.stringify(records)}`, type: 'info' });
    }

    public foundCircularDependency(toClear: { recordId: string, field: string }[]) {
        this.onOutput({ category: 'output', message: `found circular dependency: ${JSON.stringify(toClear)}`, type: 'info' });
    }

    public recordNoId(recordId: string) {
        this.onOutput({ category: 'output', message: `record ${recordId} has no ID, skipping update`, type: 'info' });
    }

    public updatingRecord(recordId: string, sObjectName: string, record: Record<string, string>) {
        this.onOutput({ category: 'output', message: `updating record ${recordId} of type ${sObjectName} to ${JSON.stringify(record)}`, type: 'info' });
    }

    public errorUpdatingRecord(recordId: string, sObjectName: string, error: any) {
        this.onOutput({ category: 'output', message: `error updating record ${recordId} of type ${sObjectName}: ${error}`, type: 'info' });
    }

}

export default IO;