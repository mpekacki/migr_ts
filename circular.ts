import { Record as SfRecord } from '@jsforce/jsforce-node/lib/types/common';

interface ToClear {
    recordId: string;
    field: string;
}

/**
 * Where the scan has got to. There is no total to count down to: the scan starts
 * over from the whole record set every time it breaks a cycle, so a pass is the
 * unit of progress - `pass` says how many times it has gone round, `cleared` what
 * that bought, and `done`/`total` how far through the record set this pass is.
 */
export interface CircularScanProgress {
    pass: number;
    cleared: number;
    /** 'graph' builds the dependency graph, 'search' walks it looking for a cycle. */
    stage: 'graph' | 'search';
    done: number;
    total: number;
}

/**
 * How often the scan reports, and with it how often it hands the event loop back.
 * Nothing is waiting on the scan, so this is only about the screen: often enough
 * that it keeps moving, rare enough that a scan finishing inside one interval
 * reports nothing and never yields at all.
 */
const PROGRESS_INTERVAL_MS = 100;

/**
 * The scan is one long stretch of computation over a record set that can run to
 * tens of thousands, and every pass re-reads all of it. Left to itself it blocks
 * the process outright - not even the spinner moves - so it is async and reports
 * where it is, yielding each time it does so the report reaches the screen.
 */
export const scanForCircularDependency = async (
    records: SfRecord[],
    requiredLookupsBySObjectType: Record<string, string[]>,
    onProgress?: (progress: CircularScanProgress) => void
): Promise<ToClear[]> => {
    const toClear: ToClear[] = [];
    let pass = 0;
    let lastReport = Date.now();

    /** Reports if one interval has passed. Returns whether it did. */
    const report = (stage: 'graph' | 'search', done: number, total: number): boolean => {
        if (!onProgress) return false;
        const now = Date.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) return false;
        lastReport = now;
        onProgress({ pass, cleared: toClear.length, stage, done, total });
        return true;
    };

    /** Hand the event loop back, so what was just reported gets painted. */
    const breathe = () => new Promise(resolve => setImmediate(resolve));

    const recordsById = new Map<string, SfRecord>();
    const allRecordIds = new Set<string>();

    for (const record of records) {
        const recordId = record.Id as string;
        recordsById.set(recordId, record);
        allRecordIds.add(recordId);
    }

    const buildDependencyGraph = async () => {
        const graph = new Map<string, Set<string>>();
        const fieldToRecord = new Map<string, string>();

        for (const record of records) {
            const recordId = record.Id as string;
            graph.set(recordId, new Set());
        }

        let read = 0;
        for (const record of records) {
            const recordId = record.Id as string;
            if (report('graph', ++read, records.length)) await breathe();

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

    const findCycleIterative = async (graph: Map<string, Set<string>>, fieldToRecord: Map<string, string>) => {
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
                // Every record is visited exactly once across the whole walk, so
                // the visited set is what the search has behind it.
                if (report('search', visited.size, graph.size)) await breathe();

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
        pass++;
        const { graph, fieldToRecord } = await buildDependencyGraph();
        const cycleInfo = await findCycleIterative(graph, fieldToRecord);

        if (cycleInfo) {
            toClear.push(cycleInfo);
            recordsById.get(cycleInfo.recordId)![cycleInfo.field] = null;
            foundCycle = true;
        }
    }

    return toClear;
}
