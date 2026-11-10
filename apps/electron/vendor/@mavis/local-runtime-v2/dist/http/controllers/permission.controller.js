import { BatchPermissionDecision, PermissionReply, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError, NotImplementedError } from '../errors.js';
import { PermissionControllerBase } from '../generated/permission-controller-base.gen.js';
/** Generated DesktopService adapter over Runtime's process-local permission application. */
export class PermissionController extends PermissionControllerBase {
    facade;
    configuration;
    constructor(facade, configuration) {
        super();
        this.facade = facade;
        this.configuration = configuration;
    }
    async getPermissionMode(_ctx, _req) {
        const configuration = this.requireConfiguration('getPermissionMode');
        return this.mapErrors(async () => ({
            mode: requirePermissionMode(await configuration.getPermissionMode()),
        }));
    }
    async setPermissionMode(_ctx, req) {
        const configuration = this.requireConfiguration('setPermissionMode');
        const mode = req.mode;
        // Internal CLI modes are readable for truthful display, but cannot be
        // activated through a product transport or used to bypass Plan review.
        if (mode !== 'default' && mode !== 'auto' && mode !== 'bypassPermissions') {
            throw new AppError(400, 'PERMISSION_MODE_INVALID', 'Unsupported permission mode');
        }
        return this.mapErrors(async () => ({
            mode: requirePermissionMode(await configuration.setPermissionMode({ mode })),
        }));
    }
    async replyPermission(_ctx, req) {
        const facade = this.requireFacade('replyPermission');
        return this.mapErrors(async () => {
            const result = await facade.reply({
                requestIds: [req.requestId],
                decision: toPermissionDecision(req.reply),
            });
            return { success: result.processed.includes(req.requestId) };
        });
    }
    async replyQuestion(_ctx, req) {
        const facade = this.requireFacade('replyQuestion');
        return this.mapErrors(async () => {
            // The DesktopService contract keeps answers for compatibility. Permission
            // asks are settled by the decision field; no answer payload is consumed.
            const result = await facade.reply({
                requestIds: [req.requestId],
                decision: 'allowOnce',
            });
            return { success: result.processed.includes(req.requestId) };
        });
    }
    async rejectQuestion(_ctx, req) {
        const facade = this.requireFacade('rejectQuestion');
        return this.mapErrors(async () => {
            const result = await facade.reply({ requestIds: [req.requestId], decision: 'deny' });
            return { success: result.processed.includes(req.requestId) };
        });
    }
    async listPendingPermissions(_ctx, _req) {
        const facade = this.requireFacade('listPendingPermissions');
        return this.mapErrors(async () => {
            const requests = await facade.listPending();
            return { requests: requests.map(toPendingPermissionItem) };
        });
    }
    async dismissPermission(_ctx, req) {
        const facade = this.requireFacade('dismissPermission');
        const dismiss = facade.dismiss;
        if (!dismiss)
            throw new NotImplementedError('dismissPermission');
        const dismissRequest = dismiss;
        return this.mapErrors(async () => ({
            success: await dismissRequest({ requestId: req.requestId }),
        }));
    }
    async batchReplyPermissions(_ctx, req) {
        const facade = this.requireFacade('batchReplyPermissions');
        return this.mapErrors(async () => {
            const result = await facade.reply({
                requestIds: req.requestIds,
                decision: toBatchPermissionDecision(req.decision),
            });
            return { processed: [...result.processed], skipped: [...result.skipped] };
        });
    }
    requireFacade(method) {
        if (this.facade)
            return this.facade;
        throw new NotImplementedError(method);
    }
    requireConfiguration(method) {
        if (this.configuration)
            return this.configuration;
        throw new NotImplementedError(method);
    }
    async mapErrors(operation) {
        try {
            return await operation();
        }
        catch (error) {
            throw mapPermissionError(error);
        }
    }
}
/** Non-owner hosts keep the generated route fail-closed. */
export const permissionController = new PermissionController();
export function createPermissionController(facade, configuration) {
    return new PermissionController(facade, configuration);
}
function requirePermissionMode(mode) {
    if (mode === 'default' ||
        mode === 'auto' ||
        mode === 'bypassPermissions' ||
        mode === 'acceptEdits' ||
        mode === 'off')
        return mode;
    throw new AppError(500, 'PERMISSION_MODE_UNAVAILABLE', 'Runtime permission mode is unavailable');
}
function toPermissionDecision(reply) {
    switch (reply) {
        case PermissionReply.AllowAlways:
            return 'allowAlways';
        case PermissionReply.Deny:
            return 'deny';
        case PermissionReply.AllowOnce:
            return 'allowOnce';
        default:
            throw new AppError(400, 'PERMISSION_REPLY_INVALID', `Unsupported permission reply: ${reply}`);
    }
}
function toBatchPermissionDecision(decision) {
    switch (decision) {
        case BatchPermissionDecision.BatchAllowAlways:
            return 'allowAlways';
        case BatchPermissionDecision.BatchDeny:
            return 'deny';
        case BatchPermissionDecision.BatchAllowOnce:
            return 'allowOnce';
        default:
            throw new AppError(400, 'PERMISSION_DECISION_INVALID', `Unsupported batch permission decision: ${decision}`);
    }
}
function toPendingPermissionItem(item) {
    return {
        requestId: item.requestId,
        toolName: item.toolName,
        ruleContents: [...item.ruleContents],
        ...(item.toolInput !== undefined ? { toolInput: item.toolInput } : {}),
        ...(item.toolDescription !== undefined ? { toolDescription: item.toolDescription } : {}),
        reason: item.reason,
        sessionId: item.sessionId,
        agentName: item.agentName,
        allowAlwaysSupported: item.allowAlwaysSupported,
        createdAt: item.createdAt,
    };
}
function mapPermissionError(error) {
    if (error instanceof AppError)
        return error;
    if (!isRecord(error))
        return error;
    const status = error.status;
    const code = error.code;
    const message = error.message;
    if (typeof status === 'number' &&
        Number.isSafeInteger(status) &&
        status >= 400 &&
        status <= 599 &&
        typeof code === 'string' &&
        typeof message === 'string') {
        return new AppError(status, code, message);
    }
    return error;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=permission.controller.js.map