/**
 * Findings about a live preview revision that no `preview` answer carried: Skills / MCP servers
 * that did not enter the session, the turn-end reload that kept the revision, and editor types
 * that could not be refreshed. Nothing is
 * posted to the session; `inspect` reads them for the live revision only.
 */
export class ExtensionPreviewFindings {
    revisions = new Map();
    overlay(sessionId, pluginId, artifactDigest, findings) {
        this.revision(sessionId, pluginId, artifactDigest).overlay = findings;
    }
    keptReload(sessionId, pluginId, artifactDigest, reload) {
        this.revision(sessionId, pluginId, artifactDigest).keptReload = reload;
    }
    /** `undefined` clears an earlier failure of the same revision. */
    editorTypes(sessionId, pluginId, artifactDigest, failure) {
        this.revision(sessionId, pluginId, artifactDigest).editorTypes = failure;
    }
    report(sessionId, pluginId, artifactDigest) {
        const found = this.revisions.get(revisionKey(sessionId, pluginId));
        if (found?.artifactDigest !== artifactDigest)
            return undefined;
        return {
            ...(found.overlay ? { overlay: found.overlay } : {}),
            ...(found.keptReload ? { keptReload: found.keptReload } : {}),
            ...(found.editorTypes ? { editorTypes: found.editorTypes } : {}),
        };
    }
    deleteSession(sessionId) {
        for (const key of [...this.revisions.keys()]) {
            if (JSON.parse(key)[0] === sessionId)
                this.revisions.delete(key);
        }
    }
    /** A new revision replaces the findings of the previous one. */
    revision(sessionId, pluginId, artifactDigest) {
        const key = revisionKey(sessionId, pluginId);
        const found = this.revisions.get(key);
        if (found?.artifactDigest === artifactDigest)
            return found;
        const fresh = { artifactDigest };
        this.revisions.set(key, fresh);
        return fresh;
    }
}
function revisionKey(sessionId, pluginId) {
    return JSON.stringify([sessionId, pluginId]);
}
//# sourceMappingURL=findings.js.map