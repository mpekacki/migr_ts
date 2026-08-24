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
            const prefix = recordId.substring(0, 3);
            const sobject = describeGlobal.sobjects.find((sobject: any) => sobject.keyPrefix === prefix);
            if (!sobject) {
                throw new Error(`SObject with prefix ${prefix} not found`);
            }
            return sobject.name;
        }
        throw new Error('Unable to determine SObject type');
    }
}
