import { NotImplementedError } from '../errors.js';
export class LlmContextInspectorControllerBase {
    async getLlmContextCapture(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getLlmContextCapture');
    }
    async putLlmContextCapture(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('putLlmContextCapture');
    }
    async getLlmContextSessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getLlmContextSessions');
    }
    async getSessionLlmContextOverview(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSessionLlmContextOverview');
    }
    async getSessionLlmContextCall(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getSessionLlmContextCall');
    }
    async clearSessionLlmContextHistory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('clearSessionLlmContextHistory');
    }
}
//# sourceMappingURL=llm-context-inspector-controller-base.gen.js.map