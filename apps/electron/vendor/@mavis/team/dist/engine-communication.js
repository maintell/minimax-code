export class EngineMessenger {
    communication;
    ownerSessionId;
    ownerAgentName;
    constructor(communication, ownerSessionId, ownerAgentName) {
        this.communication = communication;
        this.ownerSessionId = ownerSessionId;
        this.ownerAgentName = ownerAgentName;
    }
    async sendPrompt(toSession, content) {
        return normalizeSendResult(await this.communication.send(this.ownerSessionId, toSession, 'prompt', content, undefined, this.engineMetadata()));
    }
    async sendOwnerPrompt(content) {
        return normalizeSendResult(await this.communication.send(this.ownerSessionId, this.ownerSessionId, 'prompt', content, undefined, { ...this.engineMetadata(), source: 'team-engine' }));
    }
    async sendAbort(toSession) {
        return normalizeSendResult(await this.communication.send(this.ownerSessionId, toSession, 'abort'));
    }
    engineMetadata() {
        return { senderAgentName: this.ownerAgentName, isEngineMessage: true };
    }
}
export function createEngineMessenger(communication, ownerSessionId, ownerAgentName) {
    return new EngineMessenger(communication, ownerSessionId, ownerAgentName ?? 'engine');
}
export function sendFailed(result) {
    return result.status === 'failed';
}
export function sendError(result) {
    return result.error ?? 'unknown error';
}
function normalizeSendResult(result) {
    // Unit tests historically mocked CommunicationManager.send as resolving void.
    // The real implementation returns CommunicationResult; keep the wrapper tolerant
    // so tests for unrelated engine behavior don't need to care about transport shape.
    return result ?? { status: 'delivered' };
}
//# sourceMappingURL=engine-communication.js.map