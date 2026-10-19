import { scopeKey as pluginScopeKey } from '../../plugin-system-helpers.js';
import { buildPluginMarketplaceSnapshot } from './snapshot-inputs.js';
/** Coalesces one local scan and reuses it for the page's search/filter/pagination requests. */
export class MarketplacePreviewCache {
    preview;
    lastGood;
    task;
    generation = 0;
    invalidate() {
        this.generation += 1;
        this.preview = undefined;
    }
    lastGoodSnapshot(scopeKey) {
        return this.lastGood?.scopeKey === scopeKey ? this.lastGood.snapshot : undefined;
    }
    async read(scopeKey, reuseCached, build) {
        if (reuseCached && this.preview?.scopeKey === scopeKey)
            return this.preview.snapshot;
        const generation = this.generation;
        if (this.task?.scopeKey === scopeKey && this.task.generation === generation) {
            return this.task.promise;
        }
        const promise = build();
        this.task = { scopeKey, generation, promise };
        try {
            const snapshot = await promise;
            if (this.generation !== generation) {
                return this.read(scopeKey, true, build);
            }
            this.preview = { scopeKey, snapshot };
            this.lastGood = { scopeKey, snapshot };
            return snapshot;
        }
        finally {
            if (this.task?.promise === promise)
                this.task = undefined;
        }
    }
}
/** Owns the read-only Marketplace projection without widening PluginSystem's publication API. */
export class PluginMarketplacePreview {
    options;
    constructor(options) {
        this.options = options;
    }
    invalidate() {
        this.options.cache.invalidate();
    }
    async read(options = {}) {
        await this.options.initialize();
        this.options.assertUsable();
        const scope = this.options.readScope();
        if (pluginScopeKey(scope) !== this.options.desiredScopeKey()) {
            this.options.activateScopeBoundary(scope);
            this.options.scheduleCachedRestore();
        }
        const requestedScopeKey = pluginScopeKey(scope);
        const snapshot = await this.options.cache.read(requestedScopeKey, options.reuseCached === true, () => this.build(scope, requestedScopeKey));
        return pluginScopeKey(scope) === this.options.desiredScopeKey()
            ? snapshot
            : this.options.currentSnapshot();
    }
    buildFromInputs(input) {
        const snapshot = buildPluginMarketplaceSnapshot({
            builder: this.options.builder,
            revision: this.options.currentSnapshot().revision,
            snapshotInputs: input,
            isLocalEnabled: this.options.isLocalEnabled,
        });
        this.options.recordBuildContext(snapshot, { input, options: {} });
        return snapshot;
    }
    async build(scope, requestedScopeKey) {
        const input = await this.options.readSnapshotBuildInputs(scope, this.options.cache.lastGoodSnapshot(requestedScopeKey) ?? this.options.desiredSnapshot());
        return this.buildFromInputs(input);
    }
}
//# sourceMappingURL=marketplace-preview.js.map