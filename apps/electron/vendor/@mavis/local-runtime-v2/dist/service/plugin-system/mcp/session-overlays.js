import { PluginSystemError } from '../errors.js';
import { normalizedPluginName, settleInBackground } from '../plugin-system-helpers.js';
import { PluginCapabilityGenerationRegistry } from './generation-registry.js';
import { pluginMcpServerNameKey, withPluginMcpRuntime, } from '../plugin/runtime/snapshot-builder.js';
/** Marks a revision composed from a base snapshot and one session's preview generation. */
const LAYER_MARK = '#preview/';
/**
 * Per-session `LOCAL_PREVIEW` overlays of the Plugin snapshot (two.md §10.2 ④, §12). Each session
 * owns one MCP generation for its previews' servers, so a preview's connections never serve
 * another session; the published snapshot and other sessions are unaffected. Turn views and
 * Plugin MCP call targets compose the current base snapshot with the session's generation; a
 * composed revision leases both.
 */
export class PluginSessionOverlays {
    deps;
    layers = new Map();
    /** The composed snapshot per `(base, layer generation)`; recomposed when either changes. */
    composed = new WeakMap();
    closed = false;
    constructor(deps) {
        this.deps = deps;
    }
    /** Enters (or replaces) a preview in its session; resolves once its MCP servers are listed. */
    async put(input) {
        const preview = readPreviewPackage(input);
        return this.mutate(input.sessionId, (previews) => {
            previews.set(normalizedPluginName(input.pluginName), preview);
        });
    }
    async remove(sessionId, pluginName) {
        if (!this.layers.get(sessionId)?.previews.has(normalizedPluginName(pluginName)))
            return;
        await this.mutate(sessionId, (previews) => {
            previews.delete(normalizedPluginName(pluginName));
        });
    }
    /** Closes the session's MCP generations, leased or not; the session is gone. */
    async deleteSession(sessionId) {
        const layer = this.layers.get(sessionId);
        if (!layer)
            return;
        this.layers.delete(sessionId);
        await settled(layer.queue);
        await layer.generations.dispose();
    }
    /** The snapshot `sessionId` sees: `base` itself when the session has no preview. */
    snapshotFor(sessionId, base) {
        const layer = this.layers.get(sessionId);
        const current = layer?.current;
        if (!layer || !current || current.previews.length === 0)
            return base;
        const cached = this.composed.get(current);
        const composed = cached?.base === base ? cached : { base, ...this.compose(base, current) };
        this.composed.set(current, composed);
        if (composed.stale && base === this.deps.currentBase())
            this.rebase(sessionId, layer);
        return composed.snapshot;
    }
    /**
     * `stale`: the generation's tools were named for another set of replaced Plugins than `base`
     * has. They are left out rather than published under names the rules no longer match.
     */
    compose(base, current) {
        const overlay = this.deps.builder.overlaySession(base, current.previews, `${base.revision}${LAYER_MARK}${current.revision}`);
        const previewServers = overlay.mcpServers.filter((entry) => entry.source === 'LOCAL_PREVIEW');
        const stale = nameKeysOf(previewServers) !== current.nameKeys;
        // A preview the overlay refused (an official name) contributes no tools either.
        const entered = new Set(stale ? [] : previewServers.map((entry) => normalizedPluginName(entry.pluginName)));
        const bindings = current.runtimeToolBindings.filter((binding) => binding.pluginName !== undefined && entered.has(normalizedPluginName(binding.pluginName)));
        const tools = new Set(bindings.map((binding) => binding.tool));
        const snapshot = withPluginMcpRuntime(overlay, [
            ...overlay.turnCapabilities.runtimeTools,
            ...current.runtimeTools.filter((tool) => tools.has(tool)),
        ], [...overlay.turnCapabilities.runtimeToolBindings, ...bindings], current.diagnostics);
        return { snapshot, stale };
    }
    /** Lists the session's previews again under the names the published snapshot gives them. */
    rebase(sessionId, layer) {
        if (layer.rebasing || this.closed)
            return;
        layer.rebasing = true;
        settleInBackground((async () => {
            // A failure is left to the next composition against the published snapshot.
            try {
                await this.mutate(sessionId, () => undefined);
            }
            finally {
                layer.rebasing = false;
            }
        })());
    }
    /** Leases a revision: the base generation, and the session's preview generation if composed. */
    retain(revision, base) {
        const parts = splitRevision(revision);
        base.retain(parts.base);
        if (!parts.layer)
            return;
        try {
            const layer = this.layers.get(parts.layer.sessionId);
            if (!layer) {
                throw new PluginSystemError('SNAPSHOT_GENERATION_MISSING', `Preview generation ${parts.layer.revision} is unavailable`);
            }
            layer.generations.retain(parts.layer.revision);
        }
        catch (error) {
            base.release(parts.base);
            throw error;
        }
    }
    release(revision, base) {
        const parts = splitRevision(revision);
        if (parts.layer) {
            this.layers.get(parts.layer.sessionId)?.generations.release(parts.layer.revision);
        }
        base.release(parts.base);
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.layers.keys()].map((sessionId) => this.deleteSession(sessionId)));
    }
    mutate(sessionId, change) {
        if (this.closed)
            throw new PluginSystemError('DISPOSED', 'Plugin session overlays are closed');
        const layer = this.layers.get(sessionId) ?? this.createLayer(sessionId);
        const prior = layer.queue;
        const run = (async () => {
            await settled(prior);
            return this.republish(layer, change);
        })();
        layer.queue = run;
        return run;
    }
    createLayer(sessionId) {
        const revision = layerRevision(sessionId, 0);
        const layer = {
            previews: new Map(),
            generations: new PluginCapabilityGenerationRegistry(revision, this.deps.createRuntime()),
            current: {
                revision,
                previews: [],
                runtimeTools: [],
                runtimeToolBindings: [],
                diagnostics: [],
                nameKeys: '',
            },
            seq: 0,
            queue: Promise.resolve(),
            rebasing: false,
        };
        this.layers.set(sessionId, layer);
        return layer;
    }
    /** A new MCP generation for the session's previews; the prior one retires once unleased. */
    async republish(layer, change) {
        const next = new Map(layer.previews);
        change(next);
        const previews = [...next.values()];
        layer.seq += 1;
        const revision = layerRevision(sessionIdOf(layer.current.revision), layer.seq);
        const runtime = this.deps.createRuntime();
        let reconciled;
        let servers;
        try {
            servers = this.deps.builder
                .overlaySession(this.deps.currentBase(), previews, revision)
                .mcpServers.filter((entry) => entry.source === 'LOCAL_PREVIEW');
            reconciled = await runtime.reconcile(servers, { inventoryMode: 'discover' });
        }
        catch (error) {
            await settled(runtime.close());
            throw error;
        }
        layer.previews.clear();
        for (const [key, preview] of next)
            layer.previews.set(key, preview);
        layer.generations.replace(revision, runtime);
        layer.current = {
            revision,
            previews,
            runtimeTools: reconciled.runtimeTools,
            runtimeToolBindings: reconciled.runtimeToolBindings ?? [],
            diagnostics: reconciled.diagnostics,
            nameKeys: nameKeysOf(servers),
        };
        return reconciled.diagnostics;
    }
}
function readPreviewPackage(input) {
    // The extension service already refused the mismatch; this only keeps the overlay honest.
    if (normalizedPluginName(input.candidate.name) !== normalizedPluginName(input.pluginName)) {
        throw new PluginSystemError('PLUGIN_NAME_MISMATCH', `The preview package is named ${input.candidate.name}, not ${input.pluginName}`);
    }
    return { plugin: input.candidate.plugin, contentDigest: input.contentDigest };
}
function nameKeysOf(servers) {
    return JSON.stringify(servers.map(pluginMcpServerNameKey).sort());
}
async function settled(work) {
    try {
        await work;
    }
    catch {
        // The caller only needs the work to be over.
    }
}
function layerRevision(sessionId, seq) {
    return `${sessionId}/${seq}`;
}
function sessionIdOf(revision) {
    return revision.slice(0, revision.lastIndexOf('/'));
}
function splitRevision(revision) {
    const at = revision.lastIndexOf(LAYER_MARK);
    if (at < 0)
        return { base: revision };
    const layer = revision.slice(at + LAYER_MARK.length);
    return { base: revision.slice(0, at), layer: { sessionId: sessionIdOf(layer), revision: layer } };
}
//# sourceMappingURL=session-overlays.js.map