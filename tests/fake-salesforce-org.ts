/**
 * An in-memory stand-in for a Salesforce org.
 *
 * It implements enough of the REST behaviour the migration tool relies on -
 * describes, retrieve, relationship queries, matcher queries, composite
 * create/update - that the whole e2e flow can run without a live org. The
 * schema and the org-specific rules live in fake-test-org-schema.ts; this file
 * is only the engine.
 */

import { DescribeGlobalResult, DescribeSObjectResult } from 'jsforce';
import { SalesforceClient } from '../salesforce-client';
import { ClientFactory } from '../app';

export const FAKE_API_VERSION = '62.0';

// ---------------------------------------------------------------------------
// Record ids
// ---------------------------------------------------------------------------

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** The 3 trailing characters that turn a 15 character id into a case-safe 18 character one. */
function idCheckSuffix(id15: string): string {
    let suffix = '';
    for (let group = 0; group < 3; group++) {
        let bits = 0;
        for (let i = 0; i < 5; i++) {
            const character = id15[group * 5 + i];
            if (character >= 'A' && character <= 'Z') {
                bits |= 1 << i;
            }
        }
        suffix += SUFFIX_CHARS[bits];
    }
    return suffix;
}

export function toId18(id15: string): string {
    return id15 + idCheckSuffix(id15);
}

/**
 * Salesforce rejects ids whose checksum does not match with MALFORMED_ID, which
 * is how the tool tells a real-but-deleted id from a random 18 character string
 * that happens to start with a known key prefix.
 */
export function isWellFormedId(id: string): boolean {
    if (!/^[a-zA-Z0-9]+$/.test(id)) {
        return false;
    }
    if (id.length === 15) {
        return true;
    }
    return id.length === 18 && id.slice(15) === idCheckSuffix(id.slice(0, 15));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface FakeFieldDef {
    name: string;
    type: 'id' | 'string' | 'textarea' | 'email' | 'phone' | 'url' | 'picklist' | 'boolean' | 'int' | 'double' | 'date' | 'datetime' | 'reference' | 'base64';
    /** Defaults to true. Non-createable fields are never sent to the target org by the tool. */
    createable?: boolean;
    /** Defaults to true. Required lookups drive circular dependency resolution. */
    nillable?: boolean;
    unique?: boolean;
    referenceTo?: string[];
    /** Applied on create when the field was not supplied, like a Salesforce default value. */
    defaultValue?: (org: FakeSalesforceOrg) => any;
}

export interface FakeChildRelationship {
    /** Relationship name used in subqueries, e.g. `Contacts`. */
    name: string;
    childSObject: string;
    /** Field on the child that points back at this object. */
    field: string;
}

export interface FakeSObjectDef {
    name: string;
    keyPrefix: string;
    /** Defaults to true. Non-createable objects are mapped to an empty id by the tool. */
    createable?: boolean;
    /** Defaults to true. Retrieving a non-queryable object fails with INVALID_TYPE_FOR_OPERATION. */
    queryable?: boolean;
    fields: FakeFieldDef[];
    childRelationships?: FakeChildRelationship[];
    /** Side effects the platform performs on insert, e.g. creating the ContentDocument behind a ContentVersion. */
    afterCreate?: (record: any, org: FakeSalesforceOrg) => void;
}

/** Returns an error when the record breaks the rule, mirroring a validation rule in the org. */
export type FakeValidationRule = (context: { record: any, isNew: boolean, org: FakeSalesforceOrg }) => SaveFailure | null;

export interface FakeOrgConfig {
    alias: string;
    instanceUrl: string;
    accessToken: string;
    /** 3 characters mixed into every generated id so ids never collide between orgs. */
    idTag: string;
    schema: FakeSObjectDef[];
    validationRules?: Record<string, FakeValidationRule[]>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface SaveFailure {
    message: string;
    fields: string[];
    statusCode: string;
}

/** Mirrors the shape of a jsforce request error: a message plus an errorCode. */
export class SalesforceError extends Error {
    constructor(message: string, public errorCode: string) {
        super(message);
        this.name = 'SalesforceError';
    }
}

/** Thrown by the record-level helpers when a save is rejected by the org. */
export class SalesforceSaveError extends Error {
    constructor(public failures: SaveFailure[]) {
        super(failures.map(failure => failure.message).join('; '));
        this.name = 'SalesforceSaveError';
    }
}

export interface SaveResult {
    id: string;
    success: boolean;
    errors: SaveFailure[];
}

// ---------------------------------------------------------------------------
// Org
// ---------------------------------------------------------------------------

function isBlank(value: any): boolean {
    return value === undefined || value === null || value === '';
}

/** Field values are compared as strings so booleans and numbers match their string form, like SOQL does. */
function valueMatches(recordValue: any, conditionValue: any): boolean {
    if (isBlank(recordValue)) {
        return isBlank(conditionValue);
    }
    return String(recordValue) === String(conditionValue);
}

export class FakeSalesforceOrg {
    readonly alias: string;
    readonly instanceUrl: string;
    readonly accessToken: string;

    private readonly idTag: string;
    private readonly defsByName = new Map<string, FakeSObjectDef>();
    private readonly defsByPrefix = new Map<string, FakeSObjectDef>();
    private readonly validationRules: Record<string, FakeValidationRule[]>;
    private readonly recordsByType = new Map<string, Map<string, any>>();
    private idSequence = 0;

    /** Owner assigned to new records, like the running user of a real connection. */
    currentUserId = '';

    constructor(config: FakeOrgConfig) {
        this.alias = config.alias;
        this.instanceUrl = config.instanceUrl;
        this.accessToken = config.accessToken;
        this.idTag = config.idTag;
        this.validationRules = config.validationRules ?? {};
        for (const def of config.schema) {
            this.defsByName.set(def.name, def);
            this.defsByPrefix.set(def.keyPrefix, def);
            this.recordsByType.set(def.name, new Map());
        }
    }

    // --- schema ---

    private requireDef(sObjectName: string): FakeSObjectDef {
        const def = this.defsByName.get(sObjectName);
        if (!def) {
            throw new SalesforceError(`The requested resource does not exist: ${sObjectName}`, 'NOT_FOUND');
        }
        return def;
    }

    private field(def: FakeSObjectDef, fieldName: string): FakeFieldDef | undefined {
        return def.fields.find(field => field.name === fieldName);
    }

    describeGlobal(): DescribeGlobalResult {
        return {
            encoding: 'UTF-8',
            maxBatchSize: 200,
            sobjects: [...this.defsByName.values()].map(def => ({
                name: def.name,
                label: def.name,
                keyPrefix: def.keyPrefix,
                createable: def.createable !== false,
                queryable: def.queryable !== false,
                retrieveable: def.queryable !== false,
                updateable: true
            }))
        } as unknown as DescribeGlobalResult;
    }

    describeSObject(sObjectName: string): DescribeSObjectResult {
        const def = this.requireDef(sObjectName);
        return {
            name: def.name,
            label: def.name,
            keyPrefix: def.keyPrefix,
            createable: def.createable !== false,
            queryable: def.queryable !== false,
            updateable: true,
            fields: def.fields.map(field => ({
                name: field.name,
                type: field.type,
                createable: field.createable !== false,
                updateable: field.createable !== false,
                nillable: field.nillable !== false,
                unique: field.unique === true,
                referenceTo: field.referenceTo ?? []
            })),
            childRelationships: (def.childRelationships ?? []).map(relationship => ({
                relationshipName: relationship.name,
                childSObject: relationship.childSObject,
                field: relationship.field
            }))
        } as unknown as DescribeSObjectResult;
    }

    // --- records ---

    private store(sObjectName: string): Map<string, any> {
        return this.recordsByType.get(sObjectName)!;
    }

    private nextId(keyPrefix: string): string {
        const sequence = (this.idSequence++).toString(36).padStart(9, '0');
        return toId18(`${keyPrefix}${this.idTag}${sequence}`);
    }

    private recordUrl(sObjectName: string, recordId: string): string {
        return `/services/data/v${FAKE_API_VERSION}/sobjects/${sObjectName}/${recordId}`;
    }

    /**
     * Applies the supplied fields to a record, dropping the values Salesforce
     * would ignore: unknown keys are rejected, and blanks are stored as null.
     */
    private applyFields(def: FakeSObjectDef, target: any, fields: Record<string, any>, isNew: boolean): void {
        for (const [fieldName, value] of Object.entries(fields)) {
            if (fieldName === 'attributes' || fieldName === 'Id') {
                continue;
            }
            const field = this.field(def, fieldName);
            if (!field) {
                throw new SalesforceError(`No such column '${fieldName}' on sobject of type ${def.name}`, 'INVALID_FIELD');
            }
            if (value === undefined) {
                continue;
            }
            if (value instanceof Date) {
                // Requests are JSON, so a Date reaches the org as an ISO string.
                target[fieldName] = value.toISOString();
                continue;
            }
            if (isBlank(value)) {
                // On create Salesforce simply leaves the field empty; on update a
                // blank clears it. Either way the stored value is null.
                if (isNew) {
                    continue;
                }
                target[fieldName] = null;
                continue;
            }
            target[fieldName] = value;
        }
    }

    private validate(def: FakeSObjectDef, record: any, isNew: boolean): SaveFailure[] {
        const failures: SaveFailure[] = [];
        for (const field of def.fields) {
            // A lookup can only point at a record that exists in this org, which
            // is what forces the tool to insert records in dependency order.
            if (field.type !== 'reference' || isBlank(record[field.name])) {
                continue;
            }
            const referencedId = String(record[field.name]);
            const exists = (field.referenceTo ?? []).some(referencedType =>
                this.defsByName.has(referencedType) && this.store(referencedType).has(referencedId));
            if (!exists) {
                failures.push({
                    message: `invalid cross reference id: ${referencedId}`,
                    fields: [field.name],
                    statusCode: 'INVALID_CROSS_REFERENCE_KEY'
                });
            }
        }
        for (const field of def.fields) {
            if (!field.unique || isBlank(record[field.name])) {
                continue;
            }
            for (const [otherId, other] of this.store(def.name)) {
                if (otherId !== record.Id && valueMatches(other[field.name], record[field.name])) {
                    failures.push({
                        message: `duplicate value found: ${field.name} duplicates value on record with id: ${otherId}`,
                        fields: [field.name],
                        statusCode: 'DUPLICATE_VALUE'
                    });
                    break;
                }
            }
        }
        for (const rule of this.validationRules[def.name] ?? []) {
            const failure = rule({ record, isNew, org: this });
            if (failure) {
                failures.push(failure);
            }
        }
        return failures;
    }

    /** Creates a record, throwing SalesforceSaveError if the org rejects it. */
    create(sObjectName: string, fields: Record<string, any> = {}): { id: string, success: boolean } {
        const def = this.requireDef(sObjectName);
        const recordId = this.nextId(def.keyPrefix);
        const record: any = {
            attributes: { type: def.name, url: this.recordUrl(def.name, recordId) },
            Id: recordId
        };
        this.applyFields(def, record, fields, true);
        for (const field of def.fields) {
            if (record[field.name] === undefined && field.defaultValue) {
                record[field.name] = field.defaultValue(this);
            }
        }
        if (this.field(def, 'OwnerId') && record.OwnerId === undefined && this.currentUserId) {
            record.OwnerId = this.currentUserId;
        }
        const failures = this.validate(def, record, true);
        if (failures.length > 0) {
            throw new SalesforceSaveError(failures);
        }
        this.store(def.name).set(recordId, record);
        def.afterCreate?.(record, this);
        return { id: recordId, success: true };
    }

    /** Updates a record by Id, throwing SalesforceSaveError if the org rejects it. */
    update(sObjectName: string, changes: Record<string, any>): void {
        const def = this.requireDef(sObjectName);
        const recordId = changes.Id;
        const existing = this.store(def.name).get(recordId);
        if (!existing) {
            throw new SalesforceError(`The requested resource does not exist: ${recordId}`, 'NOT_FOUND');
        }
        const updated = { ...existing };
        this.applyFields(def, updated, changes, false);
        const failures = this.validate(def, updated, false);
        if (failures.length > 0) {
            throw new SalesforceSaveError(failures);
        }
        this.store(def.name).set(recordId, updated);
    }

    delete(sObjectName: string, recordId: string): void {
        const def = this.requireDef(sObjectName);
        if (!this.store(def.name).delete(recordId)) {
            throw new SalesforceError(`The requested resource does not exist: ${recordId}`, 'NOT_FOUND');
        }
    }

    retrieve(sObjectName: string, recordId: string): any {
        const def = this.requireDef(sObjectName);
        if (def.queryable === false) {
            throw new SalesforceError(`Cannot retrieve ${def.name} through the REST API`, 'INVALID_TYPE_FOR_OPERATION');
        }
        if (!isWellFormedId(recordId)) {
            throw new SalesforceError(`Invalid id: ${recordId}`, 'MALFORMED_ID');
        }
        const record = this.store(def.name).get(recordId);
        if (!record) {
            throw new SalesforceError(`Provided external ID field does not exist or is not accessible: the requested resource does not exist`, 'NOT_FOUND');
        }
        return structuredClone(record);
    }

    /** Every record of a type, in insertion order. */
    records(sObjectName: string): any[] {
        return [...this.store(this.requireDef(sObjectName).name).values()].map(record => structuredClone(record));
    }

    /** Records matching every condition, the way a matcher query does. */
    find(sObjectName: string, conditions: Record<string, any> = {}): any[] {
        return this.records(sObjectName).filter(record =>
            Object.entries(conditions).every(([field, value]) => valueMatches(record[field], value)));
    }

    childRecords(sObjectName: string, relationshipName: string, parentId: string): any[] {
        const def = this.requireDef(sObjectName);
        const relationship = (def.childRelationships ?? []).find(child => child.name === relationshipName);
        if (!relationship) {
            throw new SalesforceError(`Didn't understand relationship '${relationshipName}' in FROM part of query call.`, 'INVALID_FIELD');
        }
        return this.records(relationship.childSObject).filter(record => record[relationship.field] === parentId);
    }

    /** Supports the small subset of SOQL the tests use: SELECT ... FROM x [WHERE f = 'v' AND ...]. */
    query(soql: string): { totalSize: number, done: boolean, records: any[] } {
        const match = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)\s*(?:WHERE\s+(.+?))?\s*$/i.exec(soql);
        if (!match) {
            throw new SalesforceError(`Unsupported SOQL: ${soql}`, 'MALFORMED_QUERY');
        }
        const [, fieldList, sObjectName, whereClause] = match;
        const records = this.find(sObjectName, parseWhereClause(whereClause));
        const fields = fieldList.split(',').map(field => field.trim());
        const projected = records.map(record => projectFields(record, fields));
        return { totalSize: projected.length, done: true, records: projected };
    }

    // --- bulk operations, as used by the migration tool ---

    bulkCreate(records: any[]): SaveResult[] {
        return records.map(record => {
            try {
                const { id } = this.create(record.attributes.type, record);
                return { id, success: true, errors: [] };
            } catch (error) {
                return { id: '', success: false, errors: toSaveFailures(error) };
            }
        });
    }

    bulkUpdate(records: any[]): SaveResult[] {
        return records.map(record => {
            try {
                this.update(record.attributes.type, record);
                return { id: record.Id, success: true, errors: [] };
            } catch (error) {
                return { id: record.Id ?? '', success: false, errors: toSaveFailures(error) };
            }
        });
    }
}

function toSaveFailures(error: any): SaveFailure[] {
    if (error instanceof SalesforceSaveError) {
        return error.failures;
    }
    return [{ message: error.message, fields: [], statusCode: error.errorCode ?? 'UNKNOWN_EXCEPTION' }];
}

function projectFields(record: any, fields: string[]): any {
    if (fields.includes('*')) {
        return record;
    }
    const projected: any = { attributes: record.attributes, Id: record.Id };
    for (const field of fields) {
        projected[field] = record[field] ?? null;
    }
    return projected;
}

function parseWhereClause(whereClause: string | undefined): Record<string, any> {
    const conditions: Record<string, any> = {};
    if (!whereClause) {
        return conditions;
    }
    for (const part of whereClause.split(/\s+AND\s+/i)) {
        const match = /^\s*(\w+)\s*=\s*'?([^']*)'?\s*$/.exec(part);
        if (!match) {
            throw new SalesforceError(`Unsupported WHERE clause: ${part}`, 'MALFORMED_QUERY');
        }
        conditions[match[1]] = match[2];
    }
    return conditions;
}

// ---------------------------------------------------------------------------
// Query builders (the jsforce chaining the tool uses)
// ---------------------------------------------------------------------------

class FakeSubQuery {
    constructor(private readonly parent: FakeQuery) {}

    select(): FakeSubQuery {
        return this;
    }

    end(): FakeQuery {
        return this.parent;
    }
}

export class FakeQuery {
    private readonly whereClauses: string[] = [];
    private readonly includes: string[] = [];

    constructor(
        private readonly org: FakeSalesforceOrg,
        private readonly sObjectType: string,
        private readonly conditions: Record<string, any> = {}
    ) {}

    select(): FakeQuery {
        return this;
    }

    include(relationshipName: string): FakeSubQuery {
        this.includes.push(relationshipName);
        return new FakeSubQuery(this);
    }

    where(clause: string): FakeQuery {
        this.whereClauses.push(clause);
        return this;
    }

    toSOQL(): string {
        const subQueries = this.includes.map(name => `, (SELECT Id FROM ${name})`).join('');
        const conditions = [
            ...Object.entries(this.conditions).map(([field, value]) => `${field} = '${value}'`),
            ...this.whereClauses
        ];
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        return `SELECT Id${subQueries} FROM ${this.sObjectType}${where}`;
    }

    async execute(): Promise<any[]> {
        const conditions = { ...this.conditions };
        for (const clause of this.whereClauses) {
            Object.assign(conditions, parseWhereClause(clause));
        }
        return this.org.find(this.sObjectType, conditions).map(record => {
            const result: any = { ...record };
            for (const relationshipName of this.includes) {
                const children = this.org.childRecords(this.sObjectType, relationshipName, record.Id);
                // Salesforce returns null, not an empty list, when a subquery has no rows.
                result[relationshipName] = children.length > 0
                    ? { totalSize: children.length, done: true, records: children.map(child => ({ attributes: child.attributes, Id: child.Id })) }
                    : null;
            }
            return result;
        });
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FakeSalesforceClient implements SalesforceClient {
    constructor(private readonly org: FakeSalesforceOrg) {}

    async describeGlobal(): Promise<DescribeGlobalResult> {
        return this.org.describeGlobal();
    }

    async describeSObject(sObjectName: string): Promise<DescribeSObjectResult> {
        return this.org.describeSObject(sObjectName);
    }

    async retrieve(sObjectName: string, recordId: string): Promise<any> {
        return this.org.retrieve(sObjectName, recordId);
    }

    find(sObjectName: string, conditions: Record<string, string>): FakeQuery {
        return new FakeQuery(this.org, sObjectName, conditions);
    }

    select(sObjectName: string): FakeQuery {
        return new FakeQuery(this.org, sObjectName);
    }

    async query(soql: string): Promise<any> {
        return this.org.query(soql);
    }

    async bulkCreate(records: any[]): Promise<SaveResult[]> {
        return this.org.bulkCreate(records);
    }

    async bulkUpdate(records: any[]): Promise<SaveResult[]> {
        return this.org.bulkUpdate(records);
    }

    async update(sObjectName: string, record: any): Promise<void> {
        this.org.update(sObjectName, record);
    }

    getVersion(): string {
        return FAKE_API_VERSION;
    }
}

/**
 * Resolves the org the config asked for, by alias or by url + token, so the
 * config plumbing for both authentication styles is exercised.
 */
export function createFakeClientFactory(orgs: FakeSalesforceOrg[]): ClientFactory {
    const resolve = (orgAlias?: string, orgUrl?: string, orgToken?: string): SalesforceClient => {
        const org = orgAlias
            ? orgs.find(candidate => candidate.alias === orgAlias)
            : orgs.find(candidate => candidate.instanceUrl === orgUrl && candidate.accessToken === orgToken);
        if (!org) {
            throw new Error(`Unable to find org for alias=${orgAlias} url=${orgUrl}`);
        }
        return new FakeSalesforceClient(org);
    };
    return {
        async createSourceClient(orgAlias, orgUrl, orgToken) {
            return resolve(orgAlias, orgUrl, orgToken);
        },
        async createTargetClient(orgAlias, orgUrl, orgToken) {
            return resolve(orgAlias, orgUrl, orgToken);
        }
    };
}
