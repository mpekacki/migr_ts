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

    const buildDependencyGraph = () => {
        const graph = new Map<string, Set<string>>();
        const fieldToRecord = new Map<string, string>();

        for (const record of records) {
            const recordId = record.Id as string;
            graph.set(recordId, new Set());
        }

        for (const record of records) {
            const recordId = record.Id as string;

            for (const field in record) {
                if (field === 'Id' || field === 'attributes') continue;

                const value = record[field];
                if (value == null || typeof value !== 'string') continue;

                if (allRecordIds.has(value) && value !== recordId) {
                    graph.get(recordId)!.add(value);
                    fieldToRecord.set(`${recordId}:${value}`, field);
                } else if (value.length >= 15) {
                    const idPattern = /[a-zA-Z0-9]{15,18}/g;
                    const possibleIds = value.match(idPattern);
                    if (possibleIds) {
                        for (const possibleId of possibleIds) {
                            if (possibleId !== recordId && allRecordIds.has(possibleId)) {
                                graph.get(recordId)!.add(possibleId);
                                fieldToRecord.set(`${recordId}:${possibleId}`, field);
                                break;
                            }
                        }
                    }
                }
            }
        }
        return { graph, fieldToRecord };
    };

    const findCycleIterative = (graph: Map<string, Set<string>>, fieldToRecord: Map<string, string>) => {
        const visited = new Set<string>();
        const inPath = new Set<string>();

        for (const startNode of graph.keys()) {
            if (visited.has(startNode)) continue;

            const stack: Array<{node: string, neighbors: string[], neighborIndex: number, path: string[]}> = [];
            stack.push({node: startNode, neighbors: Array.from(graph.get(startNode) || []), neighborIndex: 0, path: [startNode]});

            visited.add(startNode);
            inPath.add(startNode);

            while (stack.length > 0) {
                const current = stack[stack.length - 1];

                if (current.neighborIndex >= current.neighbors.length) {
                    stack.pop();
                    inPath.delete(current.node);
                    continue;
                }

                const neighbor = current.neighbors[current.neighborIndex];
                current.neighborIndex++;

                if (inPath.has(neighbor)) {
                    const cycleStart = current.path.indexOf(neighbor);
                    const cycle = [...current.path.slice(cycleStart), neighbor];

                    for (let i = 0; i < cycle.length - 1; i++) {
                        const currentId = cycle[i];
                        const nextId = cycle[i + 1];
                        const field = fieldToRecord.get(`${currentId}:${nextId}`);

                        if (field) {
                            const record = recordsById.get(currentId)!;
                            const objectType = record.attributes?.type || '';
                            const requiredLookups = requiredLookupsBySObjectType[objectType] || [];

                            if (!requiredLookups.includes(field)) {
                                return { recordId: currentId, field };
                            }
                        }
                    }
                } else if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    inPath.add(neighbor);
                    stack.push({
                        node: neighbor,
                        neighbors: Array.from(graph.get(neighbor) || []),
                        neighborIndex: 0,
                        path: [...current.path, neighbor]
                    });
                }
            }
        }

        return null;
    };

    let foundCycle = true;
    while (foundCycle) {
        foundCycle = false;
        const { graph, fieldToRecord } = buildDependencyGraph();
        const cycleInfo = findCycleIterative(graph, fieldToRecord);

        if (cycleInfo) {
            toClear.push(cycleInfo);
            recordsById.get(cycleInfo.recordId)![cycleInfo.field] = null;
            foundCycle = true;
        }
    }

    return toClear;
}
