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

        const recordIdArray = Array.from(allRecordIds);

        for (const record of records) {
            const recordId = record.Id as string;

            for (const [field, value] of Object.entries(record)) {
                if (field === 'Id' || field === 'attributes' || value == null) continue;

                const valueStr = String(value);

                if (allRecordIds.has(valueStr) && valueStr !== recordId) {
                    graph.get(recordId)!.add(valueStr);
                    fieldToRecord.set(`${recordId}:${valueStr}`, field);
                } else {
                    for (const targetId of recordIdArray) {
                        if (targetId !== recordId && targetId.length > 15 && valueStr.includes(targetId)) {
                            graph.get(recordId)!.add(targetId);
                            fieldToRecord.set(`${recordId}:${targetId}`, field);
                            break;
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
            console.log('clearing', cycleInfo.recordId, cycleInfo.field);
            recordsById.get(cycleInfo.recordId)![cycleInfo.field] = null;
            foundCycle = true;
        }
    }

    return toClear;
}
