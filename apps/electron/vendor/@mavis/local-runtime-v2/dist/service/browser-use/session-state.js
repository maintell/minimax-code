import { createHash } from 'node:crypto';
export class BrowserSkillSessionStore {
    loadedContentDigests = new Map();
    hasLoaded(sessionId, expectedContent) {
        return (this.loadedContentDigests.has(sessionId) &&
            (expectedContent === undefined ||
                this.loadedContentDigests.get(sessionId) === contentDigest(expectedContent)));
    }
    markLoaded(sessionId, content) {
        this.loadedContentDigests.set(sessionId, content === undefined ? undefined : contentDigest(content));
    }
    clearSession(sessionId) {
        this.loadedContentDigests.delete(sessionId);
    }
    clear() {
        this.loadedContentDigests.clear();
    }
}
function contentDigest(content) {
    return createHash('sha256').update(content).digest('hex');
}
export class BrowserTurnContextStore {
    records = new Map();
    record(input) {
        if (!input.sessionId.trim())
            throw new TypeError('sessionId must be a non-empty string');
        if (!input.turnId.trim())
            throw new TypeError('turnId must be a non-empty string');
        assertInAppBrowserSurfaceState(input.inAppBrowser);
        this.records.set(input.sessionId, {
            turnId: input.turnId,
            inAppBrowser: { ...input.inAppBrowser },
        });
    }
    read(sessionId, turnId) {
        if (!turnId)
            return undefined;
        const record = this.records.get(sessionId);
        if (!record || record.turnId !== turnId)
            return undefined;
        return { ...record.inAppBrowser };
    }
    clearSession(sessionId) {
        this.records.delete(sessionId);
    }
    clear() {
        this.records.clear();
    }
}
function assertInAppBrowserSurfaceState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('inAppBrowser must be an object');
    }
    const state = value;
    if (typeof state.visible !== 'boolean') {
        throw new TypeError('inAppBrowser.visible must be a boolean');
    }
    if (typeof state.selectedTab !== 'boolean') {
        throw new TypeError('inAppBrowser.selectedTab must be a boolean');
    }
}
//# sourceMappingURL=session-state.js.map