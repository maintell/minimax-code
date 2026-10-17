import { PluginSystemError } from '../errors.js';
import { ignoreFailure, settleInBackground } from '../plugin-system-helpers.js';
/** Keeps retired MCP runtimes alive until turns using their snapshot finish. */
export class PluginCapabilityGenerationRegistry {
    current;
    generations = new Map();
    cleanupTasks = new Set();
    constructor(revision, runtime) {
        this.current = this.create(revision, runtime);
    }
    get currentLeaseCount() {
        return this.current.leaseCount;
    }
    retain(revision) {
        const generation = this.generations.get(revision);
        if (!generation) {
            throw new PluginSystemError('SNAPSHOT_GENERATION_MISSING', `Plugin snapshot generation ${revision} is unavailable`);
        }
        generation.leaseCount += 1;
    }
    release(revision) {
        const generation = this.generations.get(revision);
        if (!generation || generation.leaseCount <= 0)
            return;
        generation.leaseCount -= 1;
        this.tryCleanup(generation);
    }
    replace(revision, runtime, finalize) {
        const prior = this.current;
        this.current = this.create(revision, runtime);
        prior.retired = true;
        if (finalize)
            prior.finalizers.push(finalize);
        this.tryCleanup(prior);
    }
    replaceRevision(revision) {
        this.generations.delete(this.current.revision);
        this.current = this.create(revision, this.current.runtime);
    }
    async dispose() {
        for (const generation of this.generations.values()) {
            generation.retired = true;
            generation.leaseCount = 0;
            this.tryCleanup(generation);
        }
        await Promise.allSettled([...this.cleanupTasks]);
    }
    create(revision, runtime) {
        const generation = {
            revision,
            runtime,
            finalizers: [],
            leaseCount: 0,
            retired: false,
        };
        this.generations.set(revision, generation);
        return generation;
    }
    tryCleanup(generation) {
        if (!generation.retired || generation.leaseCount > 0 || generation.cleanupTask)
            return;
        const cleanup = this.cleanup(generation);
        generation.cleanupTask = cleanup;
        this.cleanupTasks.add(cleanup);
        settleInBackground(this.trackCleanup(cleanup));
    }
    async trackCleanup(cleanup) {
        try {
            await cleanup;
        }
        finally {
            this.cleanupTasks.delete(cleanup);
        }
    }
    async cleanup(generation) {
        await ignoreFailure(generation.runtime.close());
        for (const finalize of generation.finalizers)
            await ignoreFailure(finalize());
        if (this.generations.get(generation.revision) === generation) {
            this.generations.delete(generation.revision);
        }
    }
}
//# sourceMappingURL=generation-registry.js.map