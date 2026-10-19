/** A record still waiting to be migrated. */
export interface CircularRecord {
    id: string;
    sObjectType: string;
    /** Already has fields set aside for the update pass, so freeing it costs no extra update. */
    stashed?: boolean;
}

/** One field of `recordId` naming `dependsOn`, a record that has to be migrated first. */
export interface Dependency {
    recordId: string;
    field: string;
    dependsOn: string;
    /** A required lookup cannot be left empty for later, so it is never cleared. */
    required: boolean;
}

export interface ToClear {
    recordId: string;
    field: string;
}

/**
 * Where the scan has got to. 'scc' maps the whole record set into groups of
 * records that wait on each other, `done` of `total` records so far; 'break'
 * frees records inside those groups, `done` of the `total` records in them
 * being out of every cycle. `cleared` is how many fields that has cost so far.
 */
export interface CircularScanProgress {
    stage: 'scc' | 'break';
    cleared: number;
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
 * Picks the fields to leave empty on insert - and set by the update pass - so
 * that no record waits on itself through a chain of others.
 *
 * Cycles only live inside strongly connected components, so the record set is
 * split into those once (Tarjan) and everything outside them is left alone.
 * Inside a component one record is *freed*: every field it uses to wait on the
 * rest of the component is cleared, which takes it out of every cycle at once.
 * The remainder is split again and the same goes on until no component is left.
 * Only the component just broken is looked at again, never the whole set, and
 * no field is read twice: the graph is built once, from `dependencies`.
 *
 * Each freed record costs one update later, so the choice of record is what
 * matters (see `better`). A component in which every record waits on another
 * through a required lookup has no record that can be freed; following those
 * lookups must come back round, and that cycle is returned in `unbreakable`.
 *
 * The scan can run long on a large record set, and left to itself it would
 * block the process outright - not even the spinner moves - so it is async and
 * reports where it is, yielding each time it does so the report reaches the screen.
 */
export const breakCircularDependencies = async (
    records: CircularRecord[],
    dependencies: Dependency[],
    onProgress?: (progress: CircularScanProgress) => void
): Promise<{ toClear: ToClear[], unbreakable: Dependency[][] }> => {
    const toClear: ToClear[] = [];
    const unbreakable: Dependency[][] = [];
    let lastReport = Date.now();

    /** Reports if one interval has passed. Returns whether it did. */
    const report = (stage: 'scc' | 'break', done: number, total: number): boolean => {
        if (!onProgress) return false;
        const now = Date.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) return false;
        lastReport = now;
        onProgress({ stage, cleared: toClear.length, done, total });
        return true;
    };

    /** Hand the event loop back, so what was just reported gets painted. */
    const breathe = () => new Promise(resolve => setImmediate(resolve));

    const n = records.length;
    const nodeOf = new Map<string, number>();
    records.forEach((record, node) => nodeOf.set(record.id, node));

    // The dependencies of node i are edges outStart[i] up to outStart[i + 1].
    const edges = dependencies.filter(d => d.recordId !== d.dependsOn && nodeOf.has(d.recordId) && nodeOf.has(d.dependsOn));
    const outStart = new Int32Array(n + 1);
    for (const edge of edges) {
        outStart[nodeOf.get(edge.recordId)! + 1]++;
    }
    for (let node = 0; node < n; node++) {
        outStart[node + 1] += outStart[node];
    }
    const fill = outStart.slice(0, n);
    const dependencyAt: Dependency[] = new Array(edges.length);
    const target = new Int32Array(edges.length);
    for (const edge of edges) {
        const at = fill[nodeOf.get(edge.recordId)!]++;
        dependencyAt[at] = edge;
        target[at] = nodeOf.get(edge.dependsOn)!;
    }
    const cleared = new Uint8Array(edges.length);

    // `member[node] === generation` marks the nodes of the set being worked on;
    // an edge leaving it is not followed.
    const member = new Int32Array(n);
    let generation = 0;
    const inSet = (node: number) => member[node] === generation;
    const mark = (nodes: number[]) => {
        generation++;
        for (const node of nodes) member[node] = generation;
    };

    const index = new Int32Array(n);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const nextEdge = new Int32Array(n);

    /**
     * Tarjan's algorithm over `nodes`, following only the edges that stay among
     * them and have not been cleared. Iterative: a component can be as long as
     * the record set, far deeper than the call stack goes.
     */
    const components = async (nodes: number[], progress: (visited: number) => boolean): Promise<number[][]> => {
        mark(nodes);
        for (const node of nodes) index[node] = -1;
        const found: number[][] = [];
        const stack: number[] = [];
        const path: number[] = [];
        let visited = 0;
        const enter = (node: number) => {
            index[node] = low[node] = visited++;
            nextEdge[node] = outStart[node];
            stack.push(node);
            onStack[node] = 1;
            path.push(node);
        };
        for (const root of nodes) {
            if (index[root] !== -1) continue;
            enter(root);
            while (path.length > 0) {
                if (progress(visited)) await breathe();
                const node = path[path.length - 1];
                if (nextEdge[node] < outStart[node + 1]) {
                    const edge = nextEdge[node]++;
                    const next = target[edge];
                    if (cleared[edge] || !inSet(next)) continue;
                    if (index[next] === -1) {
                        enter(next);
                    } else if (onStack[next]) {
                        low[node] = Math.min(low[node], index[next]);
                    }
                    continue;
                }
                path.pop();
                if (path.length > 0) {
                    const parent = path[path.length - 1];
                    low[parent] = Math.min(low[parent], low[node]);
                }
                if (low[node] === index[node]) {
                    const component: number[] = [];
                    let popped: number;
                    do {
                        popped = stack.pop()!;
                        onStack[popped] = 0;
                        component.push(popped);
                    } while (popped !== node);
                    found.push(component);
                }
            }
        }
        return found;
    };

    /** The edges of `node` that stay inside the marked set and are still there. */
    const liveEdges = function* (node: number) {
        for (let edge = outStart[node]; edge < outStart[node + 1]; edge++) {
            if (!cleared[edge] && inSet(target[edge])) yield edge;
        }
    };

    const inDegree = new Int32Array(n);
    const outDegree = new Int32Array(n);
    const fieldCount = new Int32Array(n);
    const blocked = new Uint8Array(n);

    /**
     * Which of two freeable records to free. One that already has an update
     * coming costs nothing extra; after that, the one sitting on the most cycles
     * (in-degree times out-degree, the usual stand-in for it), so the fewest
     * records end up freed; then the one with the fewest fields to clear. The
     * rest only keeps the choice stable, so alike records lose alike fields.
     */
    const better = (a: number, b: number): boolean => {
        const stashedA = records[a].stashed ? 1 : 0;
        const stashedB = records[b].stashed ? 1 : 0;
        if (stashedA !== stashedB) return stashedA > stashedB;
        const cyclesA = inDegree[a] * outDegree[a];
        const cyclesB = inDegree[b] * outDegree[b];
        if (cyclesA !== cyclesB) return cyclesA > cyclesB;
        if (fieldCount[a] !== fieldCount[b]) return fieldCount[a] < fieldCount[b];
        if (records[a].sObjectType !== records[b].sObjectType) return records[a].sObjectType < records[b].sObjectType;
        return records[a].id < records[b].id;
    };

    /** The record to free in the marked component, or undefined if every one waits through a required lookup. */
    const pickRecordToFree = (component: number[]): number | undefined => {
        for (const node of component) {
            inDegree[node] = outDegree[node] = 0;
        }
        for (const node of component) {
            const fields = new Set<string>();
            blocked[node] = 0;
            for (const edge of liveEdges(node)) {
                outDegree[node]++;
                inDegree[target[edge]]++;
                fields.add(dependencyAt[edge].field);
                if (dependencyAt[edge].required) blocked[node] = 1;
            }
            fieldCount[node] = fields.size;
        }
        let best: number | undefined;
        for (const node of component) {
            if (blocked[node]) continue;
            if (best === undefined || better(node, best)) best = node;
        }
        return best;
    };

    /**
     * With no record to free, every record in the component waits on another
     * through a required lookup, so following those lookups has to come back to
     * a record already passed: that is the cycle nothing can break.
     */
    const requiredCycle = (component: number[]): Dependency[] => {
        const steps: Dependency[] = [];
        const stepAt = new Map<number, number>();
        let node = component[0];
        while (!stepAt.has(node)) {
            stepAt.set(node, steps.length);
            let required = -1;
            for (const edge of liveEdges(node)) {
                if (dependencyAt[edge].required) {
                    required = edge;
                    break;
                }
            }
            steps.push(dependencyAt[required]);
            node = target[required];
        }
        return steps.slice(stepAt.get(node));
    };

    const all = Array.from({ length: n }, (_, node) => node);
    const work = (await components(all, visited => report('scc', visited, n))).filter(component => component.length > 1);
    const total = work.reduce((sum, component) => sum + component.length, 0);
    let done = 0;

    while (work.length > 0) {
        const component = work.pop()!;
        if (report('break', done, total)) await breathe();
        mark(component);
        const freed = pickRecordToFree(component);
        if (freed === undefined) {
            unbreakable.push(requiredCycle(component));
            done += component.length;
            continue;
        }

        // A field is cleared whole, so every id it names stops being waited on,
        // inside the component or not.
        const fields = new Set<string>();
        for (const edge of liveEdges(freed)) {
            fields.add(dependencyAt[edge].field);
        }
        for (let edge = outStart[freed]; edge < outStart[freed + 1]; edge++) {
            if (fields.has(dependencyAt[edge].field)) cleared[edge] = 1;
        }
        for (const field of fields) {
            toClear.push({ recordId: records[freed].id, field });
        }
        done++;

        const rest = component.filter(node => node !== freed);
        for (const part of await components(rest, () => report('break', done, total))) {
            if (part.length > 1) {
                work.push(part);
            } else {
                done++;
            }
        }
    }

    return { toClear, unbreakable };
}
