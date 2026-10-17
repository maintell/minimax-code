/**
 * In-memory clipboard used by native-headless evaluation. It deliberately
 * never calls a platform clipboard API, so parallel cases cannot leak text to
 * the developer machine or to one another.
 */
export class IsolatedClipboardProvider {
    current;
    constructor(initial = {}) {
        this.current = normalizeSnapshot(initial);
    }
    async read() {
        return { ...this.current };
    }
    async write(snapshot) {
        this.current = normalizeSnapshot(snapshot);
    }
    async snapshot() {
        return { ...this.current };
    }
    async restore(snapshot) {
        this.current = normalizeSnapshot(snapshot);
    }
}
function normalizeSnapshot(snapshot) {
    const text = typeof snapshot.text === 'string' ? snapshot.text : '';
    const html = typeof snapshot.html === 'string' ? snapshot.html : undefined;
    return html === undefined ? { text } : { text, html };
}
//# sourceMappingURL=clipboard.js.map