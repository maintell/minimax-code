/**
 * Entry records by scope (two.md §12): installed records are seen by every session; a preview
 * record lives in its session's overlay and replaces the installed record of the same name there.
 */
export class ExtensionActivations {
    previews = new Map();
    installed = new Map();
    /** What `list({ sessionId })` returns: the overlay applied. */
    list(sessionId) {
        const previews = this.previews.get(sessionId);
        const installed = [...this.installed.values()].filter((activation) => !previews?.has(activation.pluginId));
        return [...installed, ...(previews?.values() ?? [])].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    }
    effective(sessionId, pluginId) {
        return this.preview(sessionId, pluginId) ?? this.installedOf(pluginId);
    }
    installedOf(pluginId) {
        return this.installed.get(pluginId);
    }
    preview(sessionId, pluginId) {
        return this.previews.get(sessionId)?.get(pluginId);
    }
    previewsOf(sessionId) {
        return [...(this.previews.get(sessionId)?.values() ?? [])];
    }
    allPreviews() {
        return [...this.previews.values()].flatMap((byPlugin) => [...byPlugin.values()]);
    }
    /** Returns the activation it replaced, which the caller retires. */
    putPreview(activation) {
        if (activation.tier !== 'preview' || !activation.sessionId) {
            throw new TypeError('a preview activation needs its session');
        }
        const byPlugin = this.previews.get(activation.sessionId) ?? new Map();
        const prior = byPlugin.get(activation.pluginId);
        byPlugin.set(activation.pluginId, activation);
        this.previews.set(activation.sessionId, byPlugin);
        return prior;
    }
    removePreview(sessionId, pluginId) {
        const byPlugin = this.previews.get(sessionId);
        const prior = byPlugin?.get(pluginId);
        byPlugin?.delete(pluginId);
        if (byPlugin?.size === 0)
            this.previews.delete(sessionId);
        return prior;
    }
    removeSession(sessionId) {
        const removed = this.previewsOf(sessionId);
        this.previews.delete(sessionId);
        return removed;
    }
    /** Replaces the installed records; returns those that changed revision or disappeared. */
    replaceInstalled(next) {
        const retired = [];
        const keep = new Map(next.map((activation) => [activation.pluginId, activation]));
        for (const [pluginId, prior] of this.installed) {
            const replacement = keep.get(pluginId);
            if (replacement?.artifactDigest === prior.artifactDigest) {
                keep.set(pluginId, prior);
            }
            else {
                retired.push(prior);
            }
        }
        this.installed.clear();
        for (const [pluginId, activation] of keep)
            this.installed.set(pluginId, activation);
        return retired;
    }
}
//# sourceMappingURL=activations.js.map