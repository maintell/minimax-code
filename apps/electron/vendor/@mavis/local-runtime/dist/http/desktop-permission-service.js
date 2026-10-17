// Desktop service permission facade.
//
// Mirrors `desktop-session-service.ts` / `desktop-agent-service.ts` in shape:
// each generated DesktopServiceBase abstract method is implemented as a thin
// adapter over the existing local-runtime ask-UI primitives, so the new IDL
// surface preserves behavior of:
//   - POST /mavis/api/agent/:name/permission/:request_id/reply
//   - POST /mavis/api/agent/:name/question/:request_id/reply
//   - POST /mavis/api/agent/:name/question/:request_id/reject
//   - GET    /mavis/api/permission/requests
//   - DELETE /mavis/api/permission/requests/:request_id
//   - POST   /mavis/api/permission/batch-reply
//
// Behavior intentionally matches the existing routes:
//   * reject_question == reply with decision="deny" (the legacy regex in
//     `api/routes/agents.ts` already collapses these into the same call).
//   * reply_question ignores `answers`; the legacy daemon does the same. The
//     field is kept in the wire shape so ask-UI evolution can adopt it later
//     without breaking the contract.
//   * dismiss is implemented as a removal of the pending entry (matches the
//     legacy DELETE `/permission/requests/:id` semantics).
import { BatchPermissionDecision, PermissionReply, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { replyLocalPermissionRequests } from '../api/routes/permissions.js';
export class DesktopPermissionService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async replyPermission(ctx, req) {
        void ctx;
        const routeContext = this.deps.routeContext();
        const decision = permissionReplyToLocalDecision(req.reply);
        const result = await replyLocalPermissionRequests(routeContext, [req.requestId], decision);
        return { success: result.processed.length > 0 };
    }
    async replyQuestion(ctx, req) {
        void ctx;
        // The legacy daemon treats `question/reply` and `permission/reply` as the
        // same reply path with `decision = "allowOnce"`. `answers` is intentionally
        // unused — see the type doc on `ReplyQuestionReq`.
        void req.answers;
        const routeContext = this.deps.routeContext();
        const result = await replyLocalPermissionRequests(routeContext, [req.requestId], 'allowOnce');
        return { success: result.processed.length > 0 };
    }
    async rejectQuestion(ctx, req) {
        void ctx;
        const routeContext = this.deps.routeContext();
        const result = await replyLocalPermissionRequests(routeContext, [req.requestId], 'deny');
        return { success: result.processed.length > 0 };
    }
    async listPendingPermissions(ctx, req) {
        void ctx;
        void req;
        const routeContext = this.deps.routeContext();
        const requests = [];
        for (const item of routeContext.approvalService.listPending()) {
            requests.push(toPendingPermissionItem(item));
        }
        return { requests };
    }
    async dismissPermission(ctx, req) {
        void ctx;
        const routeContext = this.deps.routeContext();
        return { success: routeContext.approvalService.dismiss(req.requestId) };
    }
    async batchReplyPermissions(ctx, req) {
        void ctx;
        const routeContext = this.deps.routeContext();
        const decision = batchDecisionToLocalDecision(req.decision);
        const { processed, skipped } = await replyLocalPermissionRequests(routeContext, req.requestIds, decision);
        return { processed, skipped };
    }
}
function permissionReplyToLocalDecision(reply) {
    switch (reply) {
        case PermissionReply.AllowAlways:
            return 'allowAlways';
        case PermissionReply.Deny:
            return 'deny';
        case PermissionReply.AllowOnce:
        default:
            return 'allowOnce';
    }
}
function batchDecisionToLocalDecision(decision) {
    switch (decision) {
        case BatchPermissionDecision.BatchAllowAlways:
            return 'allowAlways';
        case BatchPermissionDecision.BatchDeny:
            return 'deny';
        case BatchPermissionDecision.BatchAllowOnce:
        default:
            return 'allowOnce';
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
//# sourceMappingURL=desktop-permission-service.js.map