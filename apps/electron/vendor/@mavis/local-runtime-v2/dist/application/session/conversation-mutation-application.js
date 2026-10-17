import { ApplicationError } from '../conversation/errors.js';
import { CONVERSATION_MUTATION_NOT_SUPPORTED } from './conversation-mutation-errors.js';
export { CONVERSATION_MUTATION_NOT_SUPPORTED } from './conversation-mutation-errors.js';
/** Named application boundary for the production Rewind/Edit/Fork workflows; absent workflow remains fail-closed for non-owner hosts. */
export class SessionConversationMutationApplication {
    port;
    workflow;
    constructor(port, workflow) {
        this.port = port;
        this.workflow = workflow;
    }
    async getSessionForkOptions(ctx, req) {
        return (this.workflow?.getSessionForkOptions(ctx, req) ?? this.unsupported('getSessionForkOptions'));
    }
    async forkSession(ctx, req) {
        return this.workflow?.forkSession(ctx, req) ?? this.unsupported('forkSession');
    }
    async getSessionRewindPreview(ctx, req) {
        return (this.workflow?.getSessionRewindPreview(ctx, req) ??
            this.unsupported('getSessionRewindPreview'));
    }
    async rewindSession(ctx, req) {
        return this.workflow?.rewindSession(ctx, req) ?? this.unsupported('rewindSession');
    }
    async editSessionMessage(ctx, req) {
        return this.workflow?.editSessionMessage(ctx, req) ?? this.unsupported('editSessionMessage');
    }
    async recoverPendingForks() {
        await this.workflow?.recoverPendingForks?.();
    }
    unsupported(method) {
        void this.port;
        throw new ApplicationError(501, CONVERSATION_MUTATION_NOT_SUPPORTED, `${method} is not supported by local-runtime-v2 yet`);
    }
}
//# sourceMappingURL=conversation-mutation-application.js.map