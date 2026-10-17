import { SessionControllerBase } from '../generated/session-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
const CRON_DELIVERY_UNAVAILABLE = 'CRON_DELIVERY_UNAVAILABLE';
export class SessionController extends SessionControllerBase {
    applications;
    cronDelivery;
    conversation;
    constructor(options = {}) {
        super();
        if (options.applications)
            this.applications = options.applications;
        if (options.cronDelivery)
            this.cronDelivery = options.cronDelivery;
        if (options.conversation)
            this.conversation = options.conversation;
    }
    async getRootSession(ctx, req) {
        return this.requireApplications().session.root.getRootSession(ctx, req);
    }
    async replaceRootSession(ctx, req) {
        return this.requireApplications().session.root.replaceRootSession(ctx, req);
    }
    async listSessions(ctx, req) {
        return this.requireApplications().session.query.listSessions(ctx, req);
    }
    async createSession(ctx, req) {
        return this.requireApplications().session.lifecycle.createSession(ctx, req);
    }
    async getSidebarSessionTree(ctx, req) {
        return this.requireApplications().session.query.getSidebarSessionTree(ctx, req);
    }
    async getSessionTree(ctx, req) {
        return this.requireApplications().session.query.getSessionTree(ctx, req);
    }
    async searchSessions(ctx, req) {
        return this.requireApplications().session.query.searchSessions(ctx, req);
    }
    async getSession(ctx, req) {
        return this.requireApplications().session.query.getSession(ctx, req);
    }
    async updateSession(ctx, req) {
        return this.requireApplications().session.lifecycle.updateSession(ctx, req);
    }
    async getSessionForkOptions(ctx, req) {
        return this.requireApplications().session.conversationMutation.getSessionForkOptions(ctx, req);
    }
    async forkSession(ctx, req) {
        return this.requireApplications().session.conversationMutation.forkSession(ctx, req);
    }
    async getSessionRewindPreview(ctx, req) {
        return this.requireApplications().session.conversationMutation.getSessionRewindPreview(ctx, req);
    }
    async rewindSession(ctx, req) {
        return this.requireApplications().session.conversationMutation.rewindSession(ctx, req);
    }
    async editSessionMessage(ctx, req) {
        return this.requireApplications().session.conversationMutation.editSessionMessage(ctx, req);
    }
    async getSessionUsage(ctx, req) {
        return this.requireApplications().session.content.getSessionUsage(ctx, req);
    }
    async getPeekContext(ctx, req) {
        return this.requireApplications().session.content.getPeekContext(ctx, req);
    }
    async getSessionDiff(ctx, req) {
        return this.requireApplications().session.diff.getSessionDiff(ctx, req);
    }
    async deleteSession(ctx, req) {
        return this.requireApplications().session.lifecycle.deleteSession(ctx, req);
    }
    async archiveSession(ctx, req) {
        return this.requireApplications().session.lifecycle.archiveSession(ctx, req);
    }
    async compressSession(ctx, req) {
        return this.requireApplications().session.lifecycle.compressSession(ctx, req);
    }
    async getMessages(ctx, req) {
        return this.requireApplications().session.content.getMessages(ctx, req);
    }
    async listSessionSourceHistory(ctx, req) {
        return this.requireApplications().session.content.listSessionSourceHistory(ctx, req);
    }
    async getSessionSourceDetail(ctx, req) {
        return this.requireApplications().session.content.getSessionSourceDetail(ctx, req);
    }
    async listSessionInputSummaries(ctx, req) {
        return this.requireApplications().session.content.listSessionInputSummaries(ctx, req);
    }
    async abortSession(ctx, req) {
        return this.requireConversation().abortSession(ctx, req);
    }
    async steerSession(ctx, req) {
        return this.requireConversation().steerSession(ctx, req);
    }
    async listQueueMessages(ctx, req) {
        return this.requireApplications().queue.listQueueMessages(ctx, req);
    }
    async getQueueItem(ctx, req) {
        return this.requireApplications().queue.getQueueItem(ctx, req);
    }
    async enqueueMessage(ctx, req) {
        return this.requireConversation().enqueueMessage(ctx, req);
    }
    async updateQueueItem(ctx, req) {
        return this.requireApplications().queue.updateQueueItem(ctx, req);
    }
    async reorderQueue(ctx, req) {
        return this.requireApplications().queue.reorderQueue(ctx, req);
    }
    async deleteQueueItem(ctx, req) {
        return this.requireApplications().queue.deleteQueueItem(ctx, req);
    }
    async getTurnDiff(ctx, req) {
        return this.requireApplications().session.diff.getTurnDiff(ctx, req);
    }
    async requestRotation(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('requestRotation');
    }
    async requestCompaction(ctx, req) {
        return this.requireConversation().requestCompaction(ctx, req);
    }
    async revertTurnDiff(ctx, req) {
        return this.requireApplications().session.diff.revertTurnDiff(ctx, req);
    }
    async reapplyTurnDiff(ctx, req) {
        return this.requireApplications().session.diff.reapplyTurnDiff(ctx, req);
    }
    async listSessionFiles(ctx, req) {
        return this.requireApplications().session.content.listSessionFiles(ctx, req);
    }
    /**
     * 把一个 Cron 提示轮次投递到已解析的会话。本方法只承担传输衔接：校验强类型请求，
     * 并委托给组合层绑定的 {@link CronTurnDeliveryPort}。宿主未持有 Cron 执行器且
     * 端口未绑定时，返回稳定的不可用结果，严禁转入旧后备链路。
     */
    async deliverCron(ctx, req) {
        void ctx;
        if (!this.cronDelivery) {
            return {
                delivered: false,
                errorCode: CRON_DELIVERY_UNAVAILABLE,
                error: 'Cron delivery is not available on this runtime host',
            };
        }
        const cronId = requireNonEmpty(req.cronId);
        const runId = requireNonEmpty(req.runId);
        const sessionId = requireNonEmpty(req.sessionId);
        if (cronId === undefined || runId === undefined || sessionId === undefined) {
            return {
                delivered: false,
                errorCode: 'CRON_DELIVERY_INVALID_ARGUMENT',
                error: 'Cron delivery requires cronId, runId and sessionId',
            };
        }
        return this.cronDelivery.deliver({ cronId, runId, sessionId, text: req.text });
    }
    async sendMessage(ctx, req) {
        return this.requireConversation().sendMessage(ctx, req);
    }
    async resumeSession(ctx, req) {
        return this.requireConversation().resumeSession(ctx, req);
    }
    async inspectTurnContinuation(ctx, req) {
        return this.requireConversation().inspectTurnContinuation(ctx, req);
    }
    async continueTurn(ctx, req) {
        return this.requireConversation().continueTurn(ctx, req);
    }
    requireConversation() {
        if (!this.conversation)
            throw new NotImplementedError('conversation');
        return this.conversation;
    }
    requireApplications() {
        if (!this.applications)
            throw new NotImplementedError('session applications');
        return this.applications;
    }
}
export const sessionController = new SessionController();
/** 使用组合层绑定的 Cron 投递端口创建 SessionController。 */
export function createSessionController(options) {
    return new SessionController(options);
}
function requireNonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : value;
}
//# sourceMappingURL=session.controller.js.map