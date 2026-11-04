/**
 * Handing the event loop back during long stretches of work.
 *
 * Work that only awaits what is already at hand - a cached describe, a record
 * store on disk, which node:sqlite reads synchronously - never lets Node get to
 * its timers or its I/O: an `await` of a settled promise resumes as a microtask,
 * ahead of all of them. Run over a large record set, that freezes the screen
 * outright. The TUI's frames and spinner are timers, keys arrive as I/O, and on
 * Windows even what has been written to the terminal reaches it only once the
 * loop comes round.
 */

/** Resolves once the event loop has been round: timers and I/O get their turn. */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * A check to call between items of a long loop: it yields once `intervalMs` has
 * passed since it last did, and costs nothing otherwise - so a loop that finishes
 * inside one interval never yields at all.
 *
 * Concurrent workers share one, and while it is yielding every one of them that
 * comes past waits on that same yield. Each yielding on its own would not do:
 * the immediates run one after another in a single turn of the loop, and each
 * worker resuming would start the interval over and run a whole one of its own
 * before the next got going - holding the loop for one interval per worker.
 */
export function makeBreather(intervalMs: number): () => Promise<void> | void {
    let last = Date.now();
    let pending: Promise<void> | null = null;
    return () => {
        if (pending) {
            return pending;
        }
        if (Date.now() - last < intervalMs) {
            return;
        }
        pending = yieldToEventLoop().then(() => {
            last = Date.now();
            pending = null;
        });
        return pending;
    };
}
