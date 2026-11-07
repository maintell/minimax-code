import { LocalPermissionRuleError, LocalPermissionRuleStore, serializeLocalPermissionRule, } from '../rules/rules.js';
import { buildLocalPermissionRuleContents } from '../host-rules.js';
import { readPermissionDecision, } from '../request-contracts.js';
import { json, makeId, notFound, readFirstString, readJsonBody, readRecord, safeJsonStringify, } from '../../../infra/transport/host-http.js';
import { readLocalPermissionMode } from '../request-contracts.js';
import { buildPermissionToolDescription, } from './permission-request-helpers.js';
export async function routeLocalPermissionApi(...args) {
    const [ctx, method, request, parts, url] = args;
    return routeLocalPermissionApiInput({ ctx, method, request, parts, url });
}
async function routeLocalPermissionApiInput(input) {
    const { ctx, method, request, parts, url } = input;
    try {
        const primary = await routePrimaryPermissionApi({ ctx, method, request, parts, url });
        if (primary)
            return primary;
    }
    catch (err) {
        if (err instanceof LocalPermissionRuleError) {
            return json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
    const secondary = await routeSecondaryPermissionApi({ ctx, method, request, parts });
    if (secondary)
        return secondary;
    return notFound(`/permission/${parts.slice(1).join('/')}`);
}
async function routeSecondaryPermissionApi(input) {
    const { ctx, method, request, parts } = input;
    if (method === 'GET' && parts[1] === 'requests') {
        return json({ requests: ctx.approvalService.listPending() });
    }
    if (method === 'DELETE' && parts[1] === 'requests' && parts[2]) {
        ctx.approvalService.dismiss(parts[2]);
        return json({ success: true });
    }
    if (method === 'POST' && parts[1] === 'batch-reply') {
        return replyLocalPermissionBatch(ctx, request);
    }
    return undefined;
}
async function routePrimaryPermissionApi(input) {
    const { ctx, method, request, parts, url } = input;
    if (method === 'GET' && parts[1] === 'rules')
        return listLocalPermissionRules(ctx, url);
    if (method === 'POST' && parts[1] === 'check')
        return checkLocalPermission(ctx, request);
    if (method === 'POST' && parts[1] === 'update') {
        await ctx.permissionRules.applyUpdate(await readJsonBody(request));
        return json({ success: true });
    }
    return undefined;
}
async function listLocalPermissionRules(ctx, url) {
    const rules = await ctx.permissionRules.listRules({
        source: url.searchParams.get('source'),
        agentName: url.searchParams.get('agentName'),
        sessionId: url.searchParams.get('sessionId'),
    });
    return json({
        rules: rules.map(serializeLocalPermissionRule),
        mode: readLocalPermissionMode(ctx.configGetter().permissionMode),
    });
}
async function checkLocalPermission(ctx, request) {
    const body = await readJsonBody(request);
    const toolName = readFirstString(body, ['tool_name', 'toolName']);
    if (!toolName)
        return json({ error: 'Missing tool_name' }, { status: 400 });
    const input = readRecord(body.input);
    const sessionId = readFirstString(body, ['session_id', 'sessionId']);
    const agentName = readFirstString(body, ['agent_name', 'agentName']);
    const permissionMode = readLocalPermissionMode(ctx.configGetter().permissionMode);
    // Decision brain: ported agent-core PermissionService.
    const decision = await ctx.permissionService.checkPermission({
        toolName,
        input,
        agentName,
        sessionId,
        permissionModeOverride: permissionMode,
    });
    if (decision.behavior === 'deny' || decision.behavior === 'allow') {
        return json({ behavior: decision.behavior, reason: decision.reason });
    }
    if (sessionId) {
        const pending = ctx.approvalService.begin({
            sessionId,
            agentName: agentName ?? ctx.agentName,
            turnId: readFirstString(body, ['turn_id', 'turnId']) ?? makeId('turn'),
            toolName,
            toolInput: safeJsonStringify(input),
            toolDescription: buildPermissionToolDescription(input),
            ruleContents: decision.ruleContents ?? buildLocalPermissionRuleContents(toolName, input),
            persistWholeToolRuleOnReply: true,
            reason: decision.reason,
        });
        return json({
            behavior: 'ask',
            reason: decision.reason,
            requestId: pending.requestId,
            request_id: pending.requestId,
        });
    }
    return json({ behavior: decision.behavior, reason: decision.reason });
}
async function replyLocalPermissionBatch(ctx, request) {
    const body = await readJsonBody(request);
    const decision = readPermissionDecision(body);
    if (!decision) {
        return json({ error: 'Invalid permission decision; expected allowAlways, allowOnce, or deny.' }, { status: 400 });
    }
    const requestIds = Array.isArray(body.requestIds) ? body.requestIds.filter(isString) : [];
    // Per-item permission.processed / permission.skipped logs are emitted inside
    // replyLocalPermissionRequests below (higher fidelity than a summary line).
    const { processed, skipped } = await replyLocalPermissionRequests(ctx, requestIds, decision);
    return json({ processed, skipped });
}
export async function replyLocalPermissionRequests(ctx, requestIds, decision) {
    return ctx.approvalService.reply(requestIds, decision);
}
export function abortLocalPermissionRequests(ctx, sessionId) {
    ctx.approvalService.abortSession(sessionId);
}
/** Hosted-v2 approval port over the shared local approval service. */
export function requestLocalPermissionApproval(ctx, input, signal) {
    return ctx.approvalService.begin(input, signal).promise;
}
function isString(value) {
    return typeof value === 'string';
}
//# sourceMappingURL=permissions.js.map