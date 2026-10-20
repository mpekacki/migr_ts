import { describePathByType, describePathWithIds, edgeLabel, recordLabel, RecordOrigin, tracePath } from '../record-paths';

describe('record paths', () => {
    const records: Record<string, { sObjectType: string; label?: string; origin?: RecordOrigin }> = {
        '001A': { sObjectType: 'Account', label: 'Cloud Kicks' },
        '003B': { sObjectType: 'Contact', origin: { from: '001A', kind: 'child', name: 'Contacts' } },
        '003C': { sObjectType: 'Contact', origin: { from: '003B', kind: 'lookup', name: 'ReportsToId' } },
        '500D': { sObjectType: 'Case', origin: { from: '003C', kind: 'child', name: 'Cases' } },
    };
    const find = (id: string) => records[id];

    it('traces a record back to the record its fetch started at', () => {
        expect(tracePath('500D', find)).toEqual([
            { id: '001A', sObjectType: 'Account', label: 'Cloud Kicks' },
            { id: '003B', sObjectType: 'Contact', label: undefined, via: { kind: 'child', name: 'Contacts' } },
            { id: '003C', sObjectType: 'Contact', label: undefined, via: { kind: 'lookup', name: 'ReportsToId' } },
            { id: '500D', sObjectType: 'Case', label: undefined, via: { kind: 'child', name: 'Cases' } },
        ]);
    });

    it('is a single step for a record nothing led to', () => {
        expect(tracePath('001A', find)).toHaveLength(1);
    });

    it('stops at a record it does not know, and does not go round a loop', () => {
        expect(tracePath('nope', find)).toEqual([]);
        const looped: Record<string, { sObjectType: string; origin?: RecordOrigin }> = {
            a: { sObjectType: 'A', origin: { from: 'b', kind: 'lookup', name: 'B__c' } },
            b: { sObjectType: 'B', origin: { from: 'a', kind: 'lookup', name: 'A__c' } },
        };
        expect(tracePath('a', id => looped[id]).map(step => step.id)).toEqual(['b', 'a']);
    });

    it('describes the hops with ids for the log, and by type for one line of the TUI', () => {
        const path = tracePath('500D', find);
        expect(describePathWithIds(path)).toBe('Account 001A > Contacts[] > Contact 003B > ReportsToId > Contact 003C > Cases[]');
        expect(describePathByType(path)).toBe('Account.Contacts[] › Contact.ReportsToId › Contact.Cases[]');
        expect(describePathWithIds(tracePath('001A', find))).toBe('');
    });

    it('marks a child relationship as a collection', () => {
        expect(edgeLabel({ kind: 'child', name: 'Contacts' })).toBe('Contacts[]');
        expect(edgeLabel({ kind: 'lookup', name: 'AccountId' })).toBe('AccountId');
    });

    it('labels a record by the first name-like field it has a value in', () => {
        expect(recordLabel({ Name: 'Acme' })).toBe('Acme');
        expect(recordLabel({ Name: null, Subject: 'Broken' })).toBe('Broken');
        expect(recordLabel({ Name: '  ', CaseNumber: '00001001' })).toBe('00001001');
        expect(recordLabel({ Id: '001' })).toBeUndefined();
        expect(recordLabel(undefined)).toBeUndefined();
    });
});
