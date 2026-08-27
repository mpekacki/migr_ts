import { Options } from './config';
import DescribeCache from './describe-cache';
import IO from './io';
import { SalesforceClient } from './salesforce-client';

/**
 * Moving the files behind ContentVersion / ContentDocument - and any other blob
 * carrying object - between orgs.
 *
 * Files are fetched and inserted differently from every other record, in two
 * ways:
 *
 * - Retrieving a record does not bring its file along. A blob field comes back
 *   holding the path of the endpoint that serves it, so the contents have to be
 *   asked for per record and per field. {@link download} puts them back into the
 *   record base64 encoded, which is the form the field takes on the way in, so
 *   the record travels the ordinary path from there: the export writes it, the
 *   import reads it, and the composite insert carries it as it is.
 * - A ContentDocument cannot be inserted at all - it has no createable field.
 *   The target creates one of its own the moment the ContentVersion carrying the
 *   file lands, and that new document is what the source document id has to
 *   point at for ContentDocumentLinks to reattach the file to the right records.
 *   So a fetched ContentDocument is held out of the insert queue ({@link hold})
 *   until its version has landed, and settled with the id the target invented
 *   for it.
 */

/** Big enough for the files a migration realistically carries, small enough to fit a request - see maxFileSizeMb in the README. */
const DEFAULT_MAX_FILE_SIZE_MB = 25;

const CONTENT_VERSION = 'ContentVersion';
const CONTENT_DOCUMENT = 'ContentDocument';
/** The field a ContentDocument names its current ContentVersion with. */
const LATEST_VERSION_FIELD = 'LatestPublishedVersionId';
/** The field a ContentVersion names its ContentDocument with. */
const DOCUMENT_FIELD = 'ContentDocumentId';

/** The byte count next to a blob field, so the size limit can be applied before downloading. */
const SIZE_FIELDS: Record<string, string> = {
    VersionData: 'ContentSize',
    Body: 'BodyLength'
};

/**
 * Fields that tie a record to a file that only exists in the source org, and
 * which the target has to be left to create for itself.
 *
 * ContentVersion.ContentBodyId names the body an existing version already has;
 * the API refuses it next to VersionData outright ("Specify only one of these
 * fields: VersionData or ContentBodyId"). ContentDocumentId names the file the
 * version is a revision of; keeping it would leave the version waiting for a
 * ContentDocument nothing can insert, and dropping it is exactly what makes the
 * target create the document the run then maps the source one onto.
 *
 * Both are createable and populated on the way out, so a record that travelled
 * through an export carries them too - which is why the import drops them as well.
 */
const SOURCE_ONLY_FIELDS: Record<string, string[]> = {
    [CONTENT_VERSION]: ['ContentBodyId', DOCUMENT_FIELD]
};

export default class FileTransfer {
    private readonly enabled: boolean;
    private readonly maxFileSizeBytes: number;
    private readonly blobFieldsBySObjectType: Record<string, Promise<string[]>> = {};
    /** Source ContentDocument id -> the source ContentVersion whose insert will replace it. */
    private readonly heldDocuments = new Map<string, string>();

    constructor(
        private readonly io: IO,
        private readonly describes: DescribeCache,
        options: Options,
        private readonly sourceClient: SalesforceClient | null,
        private readonly targetClient: SalesforceClient
    ) {
        this.enabled = options.files?.enabled !== false;
        this.maxFileSizeBytes = (options.files?.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;
    }

    /**
     * The blob fields of an SObject that can be inserted.
     *
     * Everything else in the run consults this to leave them alone: a file is
     * megabytes of base64, and scanning it for record ids the way ordinary string
     * fields are scanned costs real time and turns any 18 character run in the
     * encoding into a lookup for a record that was never there.
     */
    async blobFields(sObjectName: string): Promise<string[]> {
        if (!(sObjectName in this.blobFieldsBySObjectType)) {
            // Cache the promise, not the result, so concurrent fetches share one describe.
            this.blobFieldsBySObjectType[sObjectName] = this.describes.getSObject(sObjectName).then(
                describe => describe.fields.filter(field => field.type === 'base64' && field.createable).map(field => field.name)
            );
        }
        return this.blobFieldsBySObjectType[sObjectName];
    }

    /**
     * Replaces the blob endpoint paths a freshly retrieved record carries with the
     * contents they point at, in both the record being migrated and the fetched
     * record an export is written from.
     *
     * A path left in place would be inserted as the file's contents, so a field
     * whose contents this cannot supply - too large, download failed, files
     * turned off - is dropped rather than sent as it came.
     */
    async download(recordId: string, sObjectName: string, record: any, fetchedRecord: any): Promise<void> {
        for (const field of await this.blobFields(sObjectName)) {
            if (!fetchedRecord[field]) {
                continue;
            }
            if (!this.enabled) {
                this.dropBlobField(record, fetchedRecord, field);
                continue;
            }
            const size = Number(fetchedRecord[SIZE_FIELDS[field]]);
            if (Number.isFinite(size) && size > this.maxFileSizeBytes) {
                this.io.fileTooLarge(recordId, sObjectName, field, size, this.maxFileSizeBytes);
                this.dropBlobField(record, fetchedRecord, field);
                continue;
            }
            this.io.downloadingFile(recordId, sObjectName, field, Number.isFinite(size) ? size : undefined);
            try {
                const contents = await this.sourceClient!.retrieveBlob(sObjectName, recordId, field);
                record[field] = contents;
                fetchedRecord[field] = contents;
            } catch (error) {
                // The record is still worth migrating without its file, and one
                // unreadable file is not worth ending the run over, so this is
                // reported and carried on from rather than thrown.
                this.io.fileDownloadFailed(recordId, sObjectName, field, error);
                this.dropBlobField(record, fetchedRecord, field);
            }
        }
        this.dropSourceOnlyFields(sObjectName, record);
    }

    /**
     * Drops a blob field whose contents could not be supplied from both the record
     * being migrated and the fetched record.
     *
     * The fetched one matters because it is what an export writes: left alone it
     * still holds the endpoint path the retrieve handed back, which a later import
     * would read as an ordinary field value and insert as the file itself.
     */
    private dropBlobField(record: any, fetchedRecord: any, field: string): void {
        delete record[field];
        delete fetchedRecord[field];
    }

    /** See {@link SOURCE_ONLY_FIELDS}. Unconditional: a version with no file to send still cannot claim the source's document. */
    dropSourceOnlyFields(sObjectName: string | undefined, record: any): void {
        for (const field of SOURCE_ONLY_FIELDS[sObjectName ?? ''] ?? []) {
            delete record[field];
        }
    }

    /**
     * The ContentVersion holding the current contents of a fetched
     * ContentDocument. That version is what the run actually migrates - inserting
     * it is what makes the target create a document at all.
     */
    latestVersionOf(sObjectName: string | undefined, fetchedRecord: any): string | undefined {
        if (sObjectName !== CONTENT_DOCUMENT) {
            return undefined;
        }
        return fetchedRecord?.[LATEST_VERSION_FIELD] || undefined;
    }

    /** Keeps `documentId` out of the insert queue until `versionId` has landed. */
    hold(documentId: string, versionId: string): void {
        this.heldDocuments.set(documentId, versionId);
    }

    isHeld(documentId: string): boolean {
        return this.heldDocuments.has(documentId);
    }

    release(documentId: string): void {
        this.heldDocuments.delete(documentId);
    }

    /**
     * The source ContentDocument an inserted ContentVersion belonged to. Read off
     * the fetched record: the migrated copy no longer has the field, because the
     * source document does not exist in the target and dropping it is what makes
     * the target create one.
     */
    documentOf(sObjectName: string | undefined, fetchedRecord: any): string | undefined {
        if (sObjectName !== CONTENT_VERSION) {
            return undefined;
        }
        return fetchedRecord?.[DOCUMENT_FIELD] || undefined;
    }

    /**
     * Held documents whose version is never going to arrive - it failed, was
     * skipped, or was never fetched - so the run can stop waiting for them. They
     * leave the hold here; the caller settles them with no target id.
     */
    strandedDocuments(isVersionPending: (versionId: string) => boolean): { documentId: string, versionId: string }[] {
        const stranded = [...this.heldDocuments.entries()]
            .filter(([, versionId]) => !isVersionPending(versionId))
            .map(([documentId, versionId]) => ({ documentId, versionId }));
        for (const { documentId } of stranded) {
            this.heldDocuments.delete(documentId);
        }
        return stranded;
    }

    /** The ContentDocument the target created for a ContentVersion it has just accepted. */
    async newDocumentOf(newVersionId: string): Promise<string | undefined> {
        const result = await this.targetClient.query(
            `SELECT ${DOCUMENT_FIELD} FROM ${CONTENT_VERSION} WHERE Id = '${newVersionId}'`
        );
        return result?.records?.[0]?.[DOCUMENT_FIELD] || undefined;
    }
}
