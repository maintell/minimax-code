export class SessionMemorySourceAdapter {
    port;
    constructor(port) {
        this.port = port;
    }
    readContext(sessionId) {
        return this.port.getSessionContext(sessionId);
    }
    readHistory(input) {
        return this.port.getSessionHistory(input);
    }
    currentRevision(sessionId) {
        return this.port.getCurrentRevision(sessionId);
    }
    listCaptureCandidates(input) {
        return this.port.listCaptureCandidates(input);
    }
}
//# sourceMappingURL=session-source.js.map