import { breakCircularDependencies, CircularRecord, CircularScanProgress, Dependency } from '../circular';

const record = (id: string, sObjectType = 'Custom_Object__c', stashed = false): CircularRecord => ({ id, sObjectType, stashed });
const dependency = (recordId: string, field: string, dependsOn: string, required = false): Dependency => ({ recordId, field, dependsOn, required });

describe('breakCircularDependencies', () => {
    it('should clear nothing if there is no record', async () => {
        expect(await breakCircularDependencies([], [])).toEqual({ toClear: [], unbreakable: [] });
    });

    it('should clear nothing if no record waits on itself', async () => {
        expect(await breakCircularDependencies(
            [record('A'), record('B'), record('C')],
            [dependency('A', 'Lookup__c', 'B'), dependency('B', 'Lookup__c', 'C'), dependency('A', 'Other__c', 'C')]
        )).toEqual({ toClear: [], unbreakable: [] });
    });

    it('should clear the field that is not required in a cycle of 2 records', async () => {
        expect(await breakCircularDependencies(
            [record('A', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c')],
            [dependency('A', 'Lookup_to_B__c', 'B'), dependency('B', 'Lookup_to_A__c', 'A', true)]
        )).toEqual({ toClear: [{ recordId: 'A', field: 'Lookup_to_B__c' }], unbreakable: [] });
    });

    it('should clear the field that is not required in a cycle of 3 records, leaving the records outside it alone', async () => {
        expect(await breakCircularDependencies(
            [record('A1', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c'), record('A2', 'Custom_Object_A__c'), record('C', 'Custom_Object_C__c')],
            [
                dependency('A1', 'Lookup_to_B__c', 'B', true),
                dependency('B', 'Lookup_to_C__c', 'C', true),
                dependency('A2', 'Lookup_to_B__c', 'B', true),
                dependency('C', 'Lookup_to_A__c', 'A2'),
            ]
        )).toEqual({ toClear: [{ recordId: 'C', field: 'Lookup_to_A__c' }], unbreakable: [] });
    });

    it('should clear only one field in a cycle of 2 records when no field is required', async () => {
        expect(await breakCircularDependencies(
            [record('A', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c')],
            [dependency('A', 'Lookup_to_B__c', 'B'), dependency('B', 'Lookup_to_A__c', 'A')]
        )).toEqual({ toClear: [{ recordId: 'A', field: 'Lookup_to_B__c' }], unbreakable: [] });
    });

    it('should clear the field that is not required when a record names the other through two fields', async () => {
        // Only the last field naming B used to be remembered, so a required one
        // there hid the field that could be cleared and the cycle looked unbreakable.
        expect(await breakCircularDependencies(
            [record('A', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c')],
            [
                dependency('A', 'Optional_Lookup_to_B__c', 'B'),
                dependency('B', 'Lookup_to_A__c', 'A', true),
                dependency('B', 'Other_Lookup_to_A__c', 'A', true),
            ]
        )).toEqual({ toClear: [{ recordId: 'A', field: 'Optional_Lookup_to_B__c' }], unbreakable: [] });
    });

    it('should clear every field a freed record waits through', async () => {
        // A text field naming two records is one field to clear, not two.
        expect(await breakCircularDependencies(
            [record('A', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c'), record('C', 'Custom_Object_B__c')],
            [
                dependency('A', 'Description__c', 'B'),
                dependency('A', 'Description__c', 'C'),
                dependency('A', 'Lookup__c', 'C'),
                dependency('B', 'Lookup_to_A__c', 'A', true),
                dependency('C', 'Lookup_to_A__c', 'A', true),
            ]
        )).toEqual({
            toClear: [{ recordId: 'A', field: 'Description__c' }, { recordId: 'A', field: 'Lookup__c' }],
            unbreakable: []
        });
    });

    it('should free the record that sits on the most cycles', async () => {
        // Freeing 2 breaks both cycles at once; freeing 1 or 3 needs a second record.
        const { toClear } = await breakCircularDependencies(
            [record('1'), record('2'), record('3')],
            [dependency('1', 'Lookup__c', '2'), dependency('2', 'Lookup__c', '1'), dependency('2', 'Lookup2__c', '3'), dependency('3', 'Lookup2__c', '2')]
        );
        expect(toClear).toEqual([{ recordId: '2', field: 'Lookup__c' }, { recordId: '2', field: 'Lookup2__c' }]);
    });

    it('should prefer a record that already has an update coming', async () => {
        const { toClear } = await breakCircularDependencies(
            [record('A', 'Custom_Object_A__c'), record('B', 'Custom_Object_B__c', true)],
            [dependency('A', 'Lookup_to_B__c', 'B'), dependency('B', 'Lookup_to_A__c', 'A')]
        );
        expect(toClear).toEqual([{ recordId: 'B', field: 'Lookup_to_A__c' }]);
    });

    it('should clear the same field on alike records', async () => {
        const records: CircularRecord[] = [];
        const dependencies: Dependency[] = [];
        for (let i = 0; i < 10; i++) {
            records.push(record(`contact${i}`, 'Contact'), record(`account${i}`, 'Account'));
            dependencies.push(dependency(`contact${i}`, 'AccountId', `account${i}`), dependency(`account${i}`, 'Primary_Contact__c', `contact${i}`));
        }
        const { toClear } = await breakCircularDependencies(records, dependencies);
        expect(toClear).toHaveLength(10);
        expect(new Set(toClear.map(clear => clear.field))).toEqual(new Set(['Primary_Contact__c']));
    });

    it('should report a cycle of required lookups as unbreakable, and still break the rest', async () => {
        const { toClear, unbreakable } = await breakCircularDependencies(
            [record('A'), record('B'), record('C'), record('D')],
            [
                dependency('A', 'Lookup__c', 'B', true),
                dependency('B', 'Lookup__c', 'A', true),
                dependency('C', 'Lookup__c', 'D'),
                dependency('D', 'Lookup__c', 'C', true),
            ]
        );
        expect(toClear).toEqual([{ recordId: 'C', field: 'Lookup__c' }]);
        expect(unbreakable).toHaveLength(1);
        expect(unbreakable[0].map(step => step.recordId).sort()).toEqual(['A', 'B']);
        expect(unbreakable[0].every(step => step.required)).toBe(true);
    });

    it('should free what can be freed inside a component around a cycle of required lookups', async () => {
        // C can be freed; what is left of the component, A and B, cannot.
        const { toClear, unbreakable } = await breakCircularDependencies(
            [record('A'), record('B'), record('C')],
            [
                dependency('A', 'Lookup__c', 'B', true),
                dependency('B', 'Lookup__c', 'A', true),
                dependency('A', 'Other__c', 'C'),
                dependency('C', 'Lookup__c', 'A'),
            ]
        );
        expect(toClear).toEqual([{ recordId: 'C', field: 'Lookup__c' }]);
        expect(unbreakable.map(cycle => cycle.map(step => step.recordId).sort())).toEqual([['A', 'B']]);
    });

    it('should ignore dependencies on records that are not in the set', async () => {
        expect(await breakCircularDependencies(
            [record('A')],
            [dependency('A', 'Lookup__c', 'A'), dependency('A', 'Other__c', 'missing')]
        )).toEqual({ toClear: [], unbreakable: [] });
    });

    it('should break many independent cycles quickly', async () => {
        // Breaking one cycle per pass over the whole record set made this quadratic.
        const num = 20000;
        const records: CircularRecord[] = [];
        const dependencies: Dependency[] = [];
        for (let i = 0; i < num; i++) {
            records.push(record(`a${i}`, 'Custom_Object_A__c'), record(`b${i}`, 'Custom_Object_B__c'));
            dependencies.push(dependency(`a${i}`, 'Lookup_to_B__c', `b${i}`), dependency(`b${i}`, 'Lookup_to_A__c', `a${i}`, true));
        }
        const startTime = performance.now();
        const { toClear } = await breakCircularDependencies(records, dependencies);
        const executionTime = (performance.now() - startTime) / 1000;

        expect(executionTime).toBeLessThan(5);
        expect(toClear).toHaveLength(num);
        expect(toClear.every(clear => clear.field === 'Lookup_to_B__c')).toBe(true);
    });

    it('should break one long cycle quickly', async () => {
        const num = 100000;
        const id = (i: number) => `r${i % num}`;
        const records = Array.from({ length: num }, (_, i) => record(id(i)));
        const dependencies = Array.from({ length: num }, (_, i) => dependency(id(i), 'Lookup__c', id(i + 1)));
        const startTime = performance.now();
        const { toClear } = await breakCircularDependencies(records, dependencies);
        const executionTime = (performance.now() - startTime) / 1000;

        expect(executionTime).toBeLessThan(5);
        expect(toClear).toHaveLength(1);
    });

    it('should report progress and yield while it runs long', async () => {
        // Every look at the clock finds an interval gone, so every chance to report is taken.
        let now = 0;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now += 1000);
        try {
            const num = 50;
            const records: CircularRecord[] = [];
            const dependencies: Dependency[] = [];
            for (let i = 0; i < num; i++) {
                records.push(record(`a${i}`), record(`b${i}`));
                dependencies.push(dependency(`a${i}`, 'Lookup__c', `b${i}`), dependency(`b${i}`, 'Lookup__c', `a${i}`));
            }
            const progress: CircularScanProgress[] = [];
            let yielded = false;
            setImmediate(() => yielded = true);
            await breakCircularDependencies(records, dependencies, p => progress.push(p));

            expect(yielded).toBe(true);
            expect(progress.some(p => p.stage === 'scc')).toBe(true);
            expect(progress.some(p => p.stage === 'break')).toBe(true);
            // Every record is on a cycle, so both stages count the whole set.
            for (const p of progress) {
                expect(p.total).toEqual(2 * num);
                expect(p.done).toBeLessThanOrEqual(p.total);
                expect(p.cleared).toBeLessThanOrEqual(num);
            }
        } finally {
            clock.mockRestore();
        }
    });

    it('should report no progress for a scan that finishes immediately', async () => {
        const progress: CircularScanProgress[] = [];
        await breakCircularDependencies(
            [record('1'), record('2')],
            [dependency('1', 'Lookup__c', '2'), dependency('2', 'Lookup__c', '1')],
            p => progress.push(p)
        );
        expect(progress).toEqual([]);
    });
});
