/**
 * The schema and org behaviour the e2e tests expect, modelled on the scratch
 * org that tests/TestProject deploys: the same custom objects, the same
 * validation rules, and the same standard objects the migration tool walks
 * through (User, Profile, RecordType, ...).
 *
 * Two orgs are built from it, a source and a target. They are identical except
 * for the bits the real TestProject also makes org specific: `Org_A_Only_Field__c`
 * exists only in the source org, and the rules gated on the `Is_Org_A__c` custom
 * setting only fire in the target org.
 */

import {
    FakeFieldDef,
    FakeOrgConfig,
    FakeSObjectDef,
    FakeSalesforceOrg,
    FakeValidationRule
} from './fake-salesforce-org';

export const SOURCE_ORG_ALIAS = 'mockSourceOrg';
export const TARGET_ORG_ALIAS = 'mockTargetOrg';

// Error emitted when inserting a Contract with Status = 'Activated'
export const CONTRACT_STATUS_ERROR = 'Choose a valid contract status and save your changes. Ask your admin for details.';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ID_FIELD: FakeFieldDef = { name: 'Id', type: 'id', createable: false };
const OWNER_FIELD: FakeFieldDef = { name: 'OwnerId', type: 'reference', referenceTo: ['User'] };
const CREATED_DATE_FIELD: FakeFieldDef = { name: 'CreatedDate', type: 'datetime', createable: false };

function buildSchema(isSourceOrg: boolean): FakeSObjectDef[] {
    return [
        {
            name: 'Account',
            keyPrefix: '001',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', nillable: false },
                { name: 'ParentId', type: 'reference', referenceTo: ['Account'] },
                { name: 'Description', type: 'textarea' },
                { name: 'NumberOfEmployees', type: 'int' },
                { name: 'Industry', type: 'picklist' },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ],
            childRelationships: [
                { name: 'Contacts', childSObject: 'Contact', field: 'AccountId' },
                { name: 'ChildAccounts', childSObject: 'Account', field: 'ParentId' }
            ]
        },
        {
            name: 'Contact',
            keyPrefix: '003',
            fields: [
                ID_FIELD,
                // Name is the read-only compound of FirstName and LastName
                { name: 'Name', type: 'string', createable: false },
                { name: 'FirstName', type: 'string' },
                { name: 'LastName', type: 'string', nillable: false },
                { name: 'Email', type: 'email' },
                { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
                { name: 'ReportsToId', type: 'reference', referenceTo: ['Contact'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ],
            childRelationships: [
                { name: 'Cases', childSObject: 'Case', field: 'ContactId' }
            ]
        },
        {
            name: 'Campaign',
            keyPrefix: '701',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', nillable: false },
                { name: 'IsActive', type: 'boolean' },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Opportunity',
            keyPrefix: '006',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', nillable: false },
                { name: 'StageName', type: 'picklist', nillable: false },
                { name: 'CloseDate', type: 'date', nillable: false },
                { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
                { name: 'CampaignId', type: 'reference', referenceTo: ['Campaign'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Contract',
            keyPrefix: '800',
            fields: [
                ID_FIELD,
                { name: 'ContractNumber', type: 'string', createable: false },
                // A Contract cannot exist without its Account, which makes AccountId
                // a required lookup for circular dependency resolution.
                { name: 'AccountId', type: 'reference', referenceTo: ['Account'], nillable: false },
                { name: 'Status', type: 'picklist' },
                { name: 'StartDate', type: 'date' },
                { name: 'ContractTerm', type: 'int' },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Case',
            keyPrefix: '500',
            fields: [
                ID_FIELD,
                { name: 'CaseNumber', type: 'string', createable: false },
                { name: 'Subject', type: 'string' },
                { name: 'Description', type: 'textarea' },
                { name: 'Status', type: 'picklist' },
                { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
                { name: 'ContactId', type: 'reference', referenceTo: ['Contact'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Lead',
            keyPrefix: '00Q',
            fields: [
                ID_FIELD,
                { name: 'FirstName', type: 'string' },
                { name: 'LastName', type: 'string', nillable: false },
                { name: 'Company', type: 'string', nillable: false },
                { name: 'Email', type: 'email' },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Task',
            keyPrefix: '00T',
            fields: [
                ID_FIELD,
                { name: 'Subject', type: 'string' },
                { name: 'WhatId', type: 'reference', referenceTo: ['Account', 'Opportunity'] },
                { name: 'WhoId', type: 'reference', referenceTo: ['Contact', 'Lead'] },
                { name: 'ActivityDate', type: 'date' },
                { name: 'CallDurationInSeconds', type: 'int' },
                { name: 'IsReminderSet', type: 'boolean' },
                { name: 'ReminderDateTime', type: 'datetime' },
                { name: 'IsRecurrence', type: 'boolean' },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Event',
            keyPrefix: '00U',
            fields: [
                ID_FIELD,
                { name: 'Subject', type: 'string' },
                { name: 'StartDateTime', type: 'datetime' },
                { name: 'EndDateTime', type: 'datetime' },
                { name: 'WhatId', type: 'reference', referenceTo: ['Account', 'Opportunity'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'WorkOrder',
            keyPrefix: '0WO',
            fields: [
                ID_FIELD,
                { name: 'WorkOrderNumber', type: 'string', createable: false },
                { name: 'Subject', type: 'string' },
                { name: 'Description', type: 'textarea' },
                { name: 'Status', type: 'picklist' },
                { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'User',
            keyPrefix: '005',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', createable: false },
                { name: 'FirstName', type: 'string' },
                { name: 'LastName', type: 'string', nillable: false },
                { name: 'Username', type: 'string', nillable: false, unique: true },
                { name: 'Email', type: 'email' },
                { name: 'Alias', type: 'string' },
                { name: 'IsActive', type: 'boolean' },
                { name: 'ProfileId', type: 'reference', referenceTo: ['Profile'], nillable: false },
                { name: 'UserRoleId', type: 'reference', referenceTo: ['UserRole'] }
            ]
        },
        {
            name: 'Profile',
            keyPrefix: '00e',
            createable: false,
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', createable: false },
                { name: 'UserLicenseId', type: 'reference', referenceTo: ['UserLicense'], createable: false }
            ]
        },
        {
            name: 'UserRole',
            keyPrefix: '00E',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', nillable: false },
                { name: 'DeveloperName', type: 'string' }
            ]
        },
        {
            name: 'UserLicense',
            keyPrefix: '100',
            createable: false,
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', createable: false },
                { name: 'LicenseDefinitionKey', type: 'string', createable: false }
            ]
        },
        {
            name: 'RecordType',
            keyPrefix: '012',
            createable: false,
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string', createable: false },
                { name: 'DeveloperName', type: 'string', createable: false },
                { name: 'SobjectType', type: 'string', createable: false },
                { name: 'IsActive', type: 'boolean', createable: false }
            ]
        },
        {
            name: 'ContentVersion',
            keyPrefix: '068',
            fields: [
                ID_FIELD,
                { name: 'Title', type: 'string', nillable: false },
                { name: 'PathOnClient', type: 'string', nillable: false },
                { name: 'VersionData', type: 'base64' },
                { name: 'ContentDocumentId', type: 'reference', referenceTo: ['ContentDocument'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ],
            // Inserting a version without a document creates the document for it.
            afterCreate: (record, org) => {
                if (!record.ContentDocumentId) {
                    record.ContentDocumentId = org.create('ContentDocument', { Title: record.Title }).id;
                }
            }
        },
        {
            // Documents are managed through ContentVersion: they can neither be
            // retrieved through the REST retrieve endpoint nor created directly.
            name: 'ContentDocument',
            keyPrefix: '069',
            createable: false,
            queryable: false,
            fields: [
                ID_FIELD,
                { name: 'Title', type: 'string', createable: false },
                { name: 'OwnerId', type: 'reference', referenceTo: ['User'], createable: false }
            ]
        },
        {
            name: 'Custom_Object_A__c',
            keyPrefix: 'a00',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string' },
                { name: 'Lookup_to_B__c', type: 'reference', referenceTo: ['Custom_Object_B__c'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Custom_Object_B__c',
            keyPrefix: 'a01',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string' },
                { name: 'Lookup_to_C__c', type: 'reference', referenceTo: ['Custom_Object_C__c'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Custom_Object_C__c',
            keyPrefix: 'a02',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string' },
                {
                    name: 'External_Id__c',
                    type: 'string',
                    nillable: false,
                    unique: true,
                    // The real field defaults to TEXT(UNIXTIMESTAMP(NOW()))
                    defaultValue: () => `ext-default-${Math.random().toString(36).slice(2)}`
                },
                { name: 'Lookup_to_A__c', type: 'reference', referenceTo: ['Custom_Object_A__c'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Custom_Object_D__c',
            keyPrefix: 'a03',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string' },
                { name: 'Fussy_Field_1__c', type: 'string' },
                { name: 'Fussy_Field_2__c', type: 'string' },
                ...(isSourceOrg ? [{ name: 'Org_A_Only_Field__c', type: 'string' } as FakeFieldDef] : []),
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        },
        {
            name: 'Custom_Object_E__c',
            keyPrefix: 'a04',
            fields: [
                ID_FIELD,
                { name: 'Name', type: 'string' },
                { name: 'Some_picklist__c', type: 'picklist' },
                { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] },
                OWNER_FIELD,
                CREATED_DATE_FIELD
            ]
        }
    ];
}

// ---------------------------------------------------------------------------
// Validation rules
// ---------------------------------------------------------------------------

/** FussyValidation1 / FussyValidation2: the value is only rejected on create. */
function fussyFieldOnCreateRule(fieldName: string): FakeValidationRule {
    return ({ record, isNew }) => {
        if (isNew && record[fieldName] === 'blocked') {
            return {
                message: `Field '${fieldName}'  can't be "blocked" on create, only on update.`,
                fields: [fieldName],
                statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION'
            };
        }
        return null;
    };
}

/** FussyValidation3: gated on the Is_Org_A__c custom setting, so it only fires in the target org. */
const alwaysFailsOnOrgBRule: FakeValidationRule = ({ record }) => {
    if (record.Fussy_Field_1__c === 'fail') {
        return {
            message: 'Always fails on org B',
            fields: ['Fussy_Field_1__c'],
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION'
        };
    }
    return null;
};

/** The Enhanced record type is only exposed through a permission set the target org's user does not have. */
const enhancedRecordTypeNotVisibleRule: FakeValidationRule = ({ record, org }) => {
    if (!record.RecordTypeId) {
        return null;
    }
    const recordType = org.records('RecordType').find(candidate => candidate.Id === record.RecordTypeId);
    if (recordType?.DeveloperName === 'Enhanced') {
        return {
            message: `Record Type ID: this ID value isn't valid for the user: ${record.RecordTypeId}`,
            fields: ['RecordTypeId'],
            statusCode: 'INVALID_CROSS_REFERENCE_KEY'
        };
    }
    return null;
};

/** Some_picklist__c is restricted, and only the Enhanced record type offers 'Enhanced value'. */
const restrictedPicklistRule: FakeValidationRule = ({ record, org }) => {
    const value = record.Some_picklist__c;
    if (!value) {
        return null;
    }
    const recordType = record.RecordTypeId
        ? org.records('RecordType').find(candidate => candidate.Id === record.RecordTypeId)
        : undefined;
    const allowedValues = recordType?.DeveloperName === 'Enhanced'
        ? ['Normal value', 'Enhanced value']
        : ['Normal value'];
    if (!allowedValues.includes(value)) {
        return {
            message: `bad value for restricted picklist field: ${value}`,
            fields: ['Some_picklist__c'],
            statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST'
        };
    }
    return null;
};

/** An activated contract cannot be created, only updated into that state. */
const contractStatusRule: FakeValidationRule = ({ record, isNew }) => {
    if (isNew && record.Status && record.Status !== 'Draft') {
        return {
            message: CONTRACT_STATUS_ERROR,
            fields: ['Status'],
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION'
        };
    }
    return null;
};

function buildValidationRules(isSourceOrg: boolean): Record<string, FakeValidationRule[]> {
    return {
        Contract: [contractStatusRule],
        Custom_Object_D__c: [
            fussyFieldOnCreateRule('Fussy_Field_1__c'),
            fussyFieldOnCreateRule('Fussy_Field_2__c'),
            ...(isSourceOrg ? [] : [alwaysFailsOnOrgBRule])
        ],
        Custom_Object_E__c: [
            ...(isSourceOrg ? [] : [enhancedRecordTypeNotVisibleRule]),
            restrictedPicklistRule
        ]
    };
}

// ---------------------------------------------------------------------------
// Org factories
// ---------------------------------------------------------------------------

function createOrg(config: Omit<FakeOrgConfig, 'schema' | 'validationRules'>, isSourceOrg: boolean): FakeSalesforceOrg {
    const org = new FakeSalesforceOrg({
        ...config,
        schema: buildSchema(isSourceOrg),
        validationRules: buildValidationRules(isSourceOrg)
    });

    const license = org.create('UserLicense', { Name: 'Salesforce', LicenseDefinitionKey: 'SFDC' });
    const profile = org.create('Profile', { Name: 'System Administrator', UserLicenseId: license.id });
    const user = org.create('User', {
        Name: 'Integration User',
        FirstName: 'Integration',
        LastName: 'User',
        Username: `integration.user@${config.alias}.example.com`,
        Email: 'integration.user@example.com',
        Alias: 'intusr',
        IsActive: true,
        ProfileId: profile.id
    });
    org.currentUserId = user.id;

    for (const developerName of ['Normal', 'Enhanced']) {
        org.create('RecordType', {
            Name: developerName,
            DeveloperName: developerName,
            SobjectType: 'Custom_Object_E__c',
            IsActive: true
        });
    }

    return org;
}

export function createSourceOrg(): FakeSalesforceOrg {
    return createOrg({
        alias: SOURCE_ORG_ALIAS,
        instanceUrl: 'https://mock-source-org.my.salesforce.com',
        accessToken: 'mock-source-token',
        idTag: 'A00'
    }, true);
}

export function createTargetOrg(): FakeSalesforceOrg {
    return createOrg({
        alias: TARGET_ORG_ALIAS,
        instanceUrl: 'https://mock-target-org.my.salesforce.com',
        accessToken: 'mock-target-token',
        idTag: 'B00'
    }, false);
}
