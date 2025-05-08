import { Record as SfRecord } from '@jsforce/jsforce-node/lib/types/common';

interface ToClear {
    recordId: string;
    field: string;
}

export const scanForCircularDependency = (records: SfRecord[], requiredLookupsBySObjectType: Record<string, string[]>): ToClear[] => {
    const toClear: ToClear[] = [];

    const recordsById = records.reduce((acc, record) => {
        acc[record.Id as string] = record;
        return acc;
    }, {} as Record<string, SfRecord>);

    const visited = new Set<string>();

    const search = (recordId: string, path: string[]) => {
        // console.log('searching', recordId, path[0], path[path.length - 1], path.length);
        const record = recordsById[recordId];
        for (const field of Object.keys(record)) {
            if (field !== 'Id' && field !== 'attributes') {
                const val = String(record[field as string]);
                const idsInVal = Object.keys(recordsById).filter(id => val?.includes(id));
                if (idsInVal.length === 0) {
                    continue;
                }
                for (const lookup of idsInVal) {
                    const newPath = [...path, field, lookup];
                    for (let j = 0; j < newPath.length; j += 2) {
                        if (lookup === newPath[j]) {
                            for (let i = j + 1; i < newPath.length - 1; i += 2) {
                                const objectType = recordsById[newPath[i - 1]].attributes?.type;
                                const requiredLookups = requiredLookupsBySObjectType[objectType || ''] || [];
                                const field = newPath[i];
                                if (!requiredLookups.includes(field)) {
                                    toClear.push({ recordId: newPath[i - 1], field });
                                    console.log('clearing', newPath[i - 1], field);
                                    recordsById[newPath[i - 1]][field as string] = null;
                                    for (let k = 0; k < newPath.length; k += 2) {
                                        visited.add(newPath[k]);
                                    }
                                }
                                return;
                            }
                        }
                    }
                    if (!(visited.has(recordId) && visited.has(lookup))) {
                        search(lookup, newPath);
                    }
                }
            }
        }
    }

    for (const record of records) {
        const recordId = record.Id as string;
        const path = [recordId];
        search(recordId, path);
    }

    return toClear;
}
