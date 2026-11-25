import { settleInBackground } from '../../../infra/async/settle.js';
/**
 * Turn end for previews (two.md §10.2 「turn 结束自动重载」): only the turn-terminal event of a
 * session reloads its changed previews, never a file change mid-turn. The reload is silent: a
 * reloaded preview reaches the renderer through `entries-changed`, and a kept one leaves its
 * diagnostics with the revision that stays live, for `inspect`.
 */
export class ExtensionTurnEnd {
    deps;
    running = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** One reload per session at a time; a turn that ends during a reload reloads after it. */
    onTurnEnded(sessionId) {
        const run = this.reloadAfter(this.running.get(sessionId), sessionId);
        this.running.set(sessionId, run);
        settleInBackground(this.forgetWhenDone(sessionId, run));
        return run;
    }
    async reloadAfter(prior, sessionId) {
        try {
            await prior;
        }
        catch {
            // The earlier reload reported its own failure.
        }
        const results = await this.deps.reloadSession(sessionId);
        for (const result of results) {
            if (result.status !== 'kept')
                continue;
            this.deps.findings.keptReload(sessionId, result.pluginId, result.artifactDigest, {
                at: this.deps.nowMs(),
                diagnostics: result.diagnostics,
            });
        }
    }
    async forgetWhenDone(sessionId, run) {
        try {
            await run;
        }
        catch {
            // The caller of `onTurnEnded` sees the failure.
        }
        finally {
            if (this.running.get(sessionId) === run)
                this.running.delete(sessionId);
        }
    }
}
//# sourceMappingURL=turn-end.js.map