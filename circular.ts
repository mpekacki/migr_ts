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

    const search = (recordId: string, path: string[]) => {
        const record = recordsById[recordId];
        console.log(`Searching ${JSON.stringify(record)} with path ${JSON.stringify(path)}`);
        for (const field of Object.keys(record)) {
            if (field !== 'Id' && field !== 'attributes') {
                const lookup = record[field as string] as string;
                if (!(lookup in recordsById)) {
                    continue;
                }
                const newPath = [...path, field, lookup];
                for (let j = 0; j < newPath.length; j += 2) {
                    if (lookup === newPath[j]) {
                        for (let i = j + 1; i < newPath.length - 1; i += 2) {
                            const objectType = recordsById[newPath[i - 1]].attributes?.type;
                            const requiredLookups = requiredLookupsBySObjectType[objectType || ''] || [];
                            const field = newPath[i];
                            if (!requiredLookups.includes(field)) {
                                toClear.push({ recordId: newPath[i - 1], field });
                            }
                            return;
                        }
                    }
                }
                search(lookup, newPath);
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
