import { Record as SfRecord } from '@jsforce/jsforce-node/lib/types/common';

interface ToClear {
    recordId: string;
    field: string;
}

export const scanForCircularDependency = (records: SfRecord[], requiredLookupsBySObjectType: Record<string, string[]>): ToClear[] => {
    const toClear: ToClear[] = [];
    const recordsById = new Map<string, SfRecord>();
    const allRecordIds = new Set<string>();

    for (const record of records) {
        const recordId = record.Id as string;
        recordsById.set(recordId, record);
        allRecordIds.add(recordId);
    }

    const findDependencies = () => {
        const fieldDependencies = new Map<string, Set<string>>();

        for (const record of records) {
            const recordId = record.Id as string;
            const dependencies = new Set<string>();

            for (const [field, value] of Object.entries(record)) {
                if (field === 'Id' || field === 'attributes' || value == null) continue;

                const valueStr = String(value);
                for (const targetId of allRecordIds) {
                    if (targetId !== recordId && valueStr.includes(targetId)) {
                        dependencies.add(`${field}:${targetId}`);
                    }
                }
            }
            fieldDependencies.set(recordId, dependencies);
        }
        return fieldDependencies;
    };

    let foundCycle = true;
    while (foundCycle) {
        foundCycle = false;
        const fieldDependencies = findDependencies();
        const visited = new Set<string>();
        const inPath = new Set<string>();
        const pathStack: Array<{recordId: string, field: string}> = [];

        const dfs = (recordId: string): boolean => {
            if (inPath.has(recordId)) {
                const cycleStart = pathStack.findIndex(entry => entry.recordId === recordId);
                for (let i = cycleStart; i < pathStack.length; i++) {
                    const entry = pathStack[i];
                    const record = recordsById.get(entry.recordId)!;
                    const objectType = record.attributes?.type || '';
                    const requiredLookups = requiredLookupsBySObjectType[objectType] || [];

                    if (!requiredLookups.includes(entry.field)) {
                        toClear.push({ recordId: entry.recordId, field: entry.field });
                        console.log('clearing', entry.recordId, entry.field);
                        record[entry.field as string] = null;
                        return true;
                    }
                }
                return false;
            }

            if (visited.has(recordId)) return false;

            visited.add(recordId);
            inPath.add(recordId);

            const dependencies = fieldDependencies.get(recordId);
            if (dependencies) {
                for (const dep of dependencies) {
                    const [field, targetId] = dep.split(':');
                    pathStack.push({ recordId, field });

                    if (dfs(targetId)) {
                        inPath.delete(recordId);
                        return true;
                    }
                    pathStack.pop();
                }
            }

            inPath.delete(recordId);
            return false;
        };

        for (const record of records) {
            const recordId = record.Id as string;
            if (!visited.has(recordId)) {
                if (dfs(recordId)) {
                    foundCycle = true;
                    break;
                }
            }
        }
    }

    return toClear;
}
