import { settleInBackground, } from '../plugin-system/index.js';
/**
 * The installed tier follows the published plugin snapshot: an extension is installed when its
 * package is an effective installed Plugin, whatever its source (official marketplace, local
 * `<dataDir>/plugins/`, or a linked root), so installing, updating, disabling
 * and uninstalling all reach the host through the snapshot. Reloads run one at a time.
 *
 * After each reload it reconciles the previews: a session whose preview is bound to exactly the
 * installed version has had it installed, so its store overlay merges into the installed data and
 * the preview withdraws, deleting its record; a preview of any other version keeps overriding the
 * installed one in its session. A record is deleted only after its overlay merged, so a merge
 * that fails is retried at the next reload.
 */
export class InstalledExtensionTier {
    deps;
    queue = Promise.resolve();
    unsubscribe;
    /** Package identity each plugin was last validated from; a new identity validates again. */
    validated = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** Follows snapshot publications until `stop`. */
    start() {
        this.unsubscribe ??= this.deps.source.subscribe(() => settleInBackground(this.reload()));
    }
    stop() {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }
    /** Validates every installed package again at the next reload (their snapshots were removed). */
    reset() {
        this.validated.clear();
    }
    /** Brings the installed records to the snapshot and reconciles previews; resolves once done. */
    reload() {
        const run = this.reloadAfter(this.queue);
        this.queue = settled(run);
        return run;
    }
    /** The installed version of `pluginId` every session without a preview of it runs. */
    installedDigest(pluginId) {
        return this.deps.activations.installedOf(pluginId)?.artifactDigest;
    }
    async reloadAfter(prior) {
        await prior;
        await this.apply(this.deps.source.current());
        await this.reconcile();
    }
    /**
     * A new revision that fails to compile or whose `register` throws does not replace the record
     * it would have (R10); that plugin keeps its prior record, or none, and announces nothing.
     */
    async apply(entries) {
        const next = [];
        const changed = new Set();
        const listed = new Set(entries.map((entry) => entry.pluginName));
        for (const entry of entries) {
            const prior = this.deps.activations.installedOf(entry.pluginName);
            const activation = (await this.replacement(entry, prior)) ?? prior;
            if (!activation)
                continue;
            next.push(activation);
            if (activation !== prior)
                changed.add(entry.pluginName);
        }
        for (const pluginId of this.validated.keys()) {
            if (!listed.has(pluginId))
                this.validated.delete(pluginId);
        }
        for (const retired of this.deps.activations.replaceInstalled(next)) {
            changed.add(retired.pluginId);
        }
        for (const pluginId of changed)
            this.deps.emit({ type: 'entries-changed', pluginId });
    }
    /** A new registered revision of a changed package, or undefined to keep `prior`. */
    async replacement(entry, prior) {
        const identity = `${entry.rootPath}\u0000${entry.packageContentDigest}`;
        if (this.validated.get(entry.pluginName) === identity)
            return undefined;
        this.validated.set(entry.pluginName, identity);
        const activation = await this.revision(entry);
        if (!activation || activation.artifactDigest === prior?.artifactDigest)
            return undefined;
        return (await this.deps.prepare(activation)) ? undefined : activation;
    }
    async revision(entry) {
        let validation;
        try {
            validation = await this.deps.validate({
                pluginId: entry.pluginName,
                sourceDir: entry.rootPath,
            });
        }
        catch {
            return undefined;
        }
        const { artifact } = validation;
        if (!artifact)
            return undefined;
        return {
            pluginId: artifact.pluginId,
            tier: 'installed',
            // The source its MCP servers are published under, so `mcp.call` finds its own servers.
            source: entry.source,
            artifactDigest: artifact.digest,
            root: artifact.candidateRoot,
            entry: artifact.entry,
            files: artifact.files,
            scan: artifact.scan,
            compiled: artifact.compiled,
            compilerFingerprint: artifact.compilerFingerprint,
            sdkVersion: artifact.sdkVersion,
            activatedAt: this.deps.nowMs(),
        };
    }
    /** Idempotent: an interrupted merge completes the next time it runs. */
    async reconcile() {
        for (const record of this.deps.bindings.list()) {
            if (record.boundDigest !== this.installedDigest(record.pluginId))
                continue;
            try {
                await this.deps.store.mergeOverlay(record.pluginId, record.sessionId);
                await this.deps.withdrawPreview(record.sessionId, record.pluginId, record.boundDigest);
            }
            catch {
                // The next reload (or start) completes it; the other sessions still reconcile.
            }
        }
    }
}
async function settled(work) {
    try {
        await work;
    }
    catch {
        // The next reload only waits for this one to be over.
    }
}
//# sourceMappingURL=installed-tier.js.map