import { DescribeSObjectResult } from 'jsforce';
import { DescribeGlobalResult } from 'jsforce/lib/api/soap/schema';
import { SalesforceClient } from './salesforce-client';
import IO from './io';

/**
 * Describe calls, cached for the run.
 *
 * The two describes come from different orgs on purpose: the global describe
 * resolves a record id's key prefix to an SObject name, so it has to describe
 * the org the ids came from (the source), while the per-SObject describe decides
 * which fields can be inserted, so it has to describe the org they are going to
 * (the target). A file source has no org to ask, so it stands in a describe
 * built from the exported records - see setFileDescribe.
 */
export default class DescribeCache {
    private global: DescribeGlobalResult | null = null;
    private fromFile: any | null = null;
    private readonly sObjects: Record<string, Promise<DescribeSObjectResult>> = {};
    private readonly sourceSObjects: Record<string, Promise<DescribeSObjectResult>> = {};

    constructor(
        private readonly io: IO,
        private readonly sourceClient: SalesforceClient | null,
        private readonly targetClient: SalesforceClient,
        private readonly isMigrateFromFile: boolean,
    ) {}

    /** The stand-in global describe a file source provides, built by loadRecordsFromFile. */
    setFileDescribe(describe: any): void {
        this.fromFile = describe;
    }

    async getGlobal(): Promise<any> {
        if (this.isMigrateFromFile) {
            return this.fromFile;
        }
        if (!this.global) {
            this.global = await this.sourceClient!.describeGlobal();
        }
        return this.global;
    }

    async getSObject(sObjectName: string): Promise<DescribeSObjectResult> {
        if (!(sObjectName in this.sObjects)) {
            this.io.describeSObject(sObjectName);
            // Cache the promise, not the result, so concurrent callers share one call.
            this.sObjects[sObjectName] = this.targetClient.describeSObject(sObjectName);
        }
        try {
            return await this.sObjects[sObjectName];
        } catch (ex) {
            console.log('error fetching ' + sObjectName + ' SObject describe');
            throw ex;
        }
    }

    /**
     * The per-SObject describe of the source org - the exception to the rule
     * above. Retrieving several records at once means naming the fields to read,
     * and those have to be fields the source has: the target may have ones it
     * does not, and asking for one of those fails the whole request.
     */
    async getSourceSObject(sObjectName: string): Promise<DescribeSObjectResult> {
        if (!(sObjectName in this.sourceSObjects)) {
            this.sourceSObjects[sObjectName] = this.sourceClient!.describeSObject(sObjectName);
        }
        return this.sourceSObjects[sObjectName];
    }

    /**
     * The SObject a record belongs to, from its own attributes when it carries
     * them and from its id's key prefix otherwise. Throws for a prefix no SObject
     * claims, which is how callers tell a real id from any other 18-character
     * string the ID_REGEX scan turned up.
     */
    async getSObjectType(recordId: string, record?: any): Promise<string> {
        if (record && record.attributes && record.attributes.type) {
            return record.attributes.type;
        }
        const describeGlobal = await this.getGlobal();
        if (describeGlobal) {
            const name = this.namesByPrefix(describeGlobal).get(recordId.substring(0, 3));
            if (name === undefined) {
                throw new Error(`SObject with prefix ${recordId.substring(0, 3)} not found`);
            }
            return name;
        }
        throw new Error('Unable to determine SObject type');
    }

    /**
     * The SObject an id's key prefix belongs to, or undefined when no SObject
     * claims it (or there is nothing to ask). For the id scan, which tries every
     * 18-character run of every text field and is mostly told "not an id" - an
     * answer not worth an Error and its stack each time.
     */
    async findSObjectType(recordId: string): Promise<string | undefined> {
        let describeGlobal: any;
        try {
            describeGlobal = await this.getGlobal();
        } catch {
            return undefined;
        }
        return describeGlobal ? this.namesByPrefix(describeGlobal).get(recordId.substring(0, 3)) : undefined;
    }

    private prefixes: { describe: any, size: number, names: Map<string, string> } | null = null;

    /**
     * Key prefix to SObject name, the first SObject listing a prefix winning, as a
     * search of the list would have it. Built once rather than searching ~1500
     * SObjects per id. A file source's stand-in describe grows while its records
     * load, so the map is rebuilt whenever the list has changed size.
     */
    private namesByPrefix(describeGlobal: any): Map<string, string> {
        const sobjects: any[] = describeGlobal.sobjects;
        const cached = this.prefixes;
        if (cached && cached.describe === describeGlobal && cached.size === sobjects.length) {
            return cached.names;
        }
        const names = new Map<string, string>();
        for (const sobject of sobjects) {
            if (typeof sobject.keyPrefix === 'string' && !names.has(sobject.keyPrefix)) {
                names.set(sobject.keyPrefix, sobject.name);
            }
        }
        this.prefixes = { describe: describeGlobal, size: sobjects.length, names };
        return names;
    }
}
