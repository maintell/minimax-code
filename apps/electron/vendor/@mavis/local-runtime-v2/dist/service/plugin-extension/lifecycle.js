import { rm } from 'node:fs/promises';
/**
 * The two lifecycle entries (four.md #83): session deletion removes the pieces a preview leaves
 * (preview records, dev directory, store overlay, `ctx.state`, candidate snapshots nothing else
 * holds), and runtime start rebuilds the installed tier (reconciling previews it installed) and
 * the sessions' previews. The user's approval is a permission rule the permission owner keeps and
 * deletes with the session; nothing here holds it.
 */
export class ExtensionLifecycle {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async onSessionDeleted(sessionId) {
        const candidates = this.deps.preview.candidateRootsOf(sessionId);
        await this.deps.preview.deleteSession(sessionId);
        this.deps.bindings.deleteSession(sessionId);
        await this.deps.devDirectories.deleteSession(sessionId);
        await this.deps.deleteSessionState(sessionId);
        // Content-addressed: another session may hold the same snapshot; only unheld ones go.
        await this.deps.discardCandidates(this.deps.preview.unheldCandidateRoots(candidates));
    }
    async onRuntimeStart() {
        // Candidate snapshots are rebuilt from source; none from an earlier process is still bound.
        await rm(this.deps.candidatesRoot, { recursive: true, force: true });
        this.deps.installedTier.reset();
        await this.deps.installedTier.reload();
        for (const record of this.deps.bindings.list()) {
            if (!(await this.deps.sessionExists(record.sessionId))) {
                await this.onSessionDeleted(record.sessionId);
                continue;
            }
            // Bound to the installed version: installed, its merge still pending (the reconcile deletes
            // the record once it merged), so there is no preview left to restore.
            if (record.boundDigest === this.deps.installedTier.installedDigest(record.pluginId))
                continue;
            try {
                await this.deps.preview.restore(record.sessionId, record.pluginId);
            }
            catch {
                // One unreadable preview must not block the others; the next `preview` call retries it.
            }
        }
        // A withdrawn preview keeps its store overlay for the next `preview` in the same session;
        // the overlay of a session deleted while the runtime was down goes.
        for (const overlay of await this.deps.store.listOverlays()) {
            if (!(await this.deps.sessionExists(overlay.sessionId))) {
                await this.deps.store.discardOverlay(overlay.pluginId, overlay.sessionId);
            }
        }
    }
}
//# sourceMappingURL=lifecycle.js.map