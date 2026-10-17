/**
 * `mavis cron ...` 命令组 —— 映射到 archon-server Cron V2。
 *
 * **ID 字段 wire 形态**:LLM tool args 拿到的是 string ID(从 Response 出口
 * `coerceI64IdFields` 转的 string),但 archon-server IDL `task_id` / `agent_id`
 * 都是 `i64` 默认 json tag,wire 必须 JSON number,所以这里调 archonServer.callRpc
 * 前显式 `Number(stringId)` 转换。当前 snowflake ID ≤ 49 bits 在
 * Number.MAX_SAFE_INTEGER 内,Number(...) 不丢精度。
 */
import { randomUUID } from 'node:crypto';
import { appendQuietOnSkipPromptSuffix, isCronDedicatedSessionTarget, LocalMavisCronValidationError, parseOnceRunAtMs, everyToCronExpression, } from '../../../shared/cron-schedule-input.js';
import { failure, success } from '../output.js';
import { logger } from '../../runtime-types.js';
import { ENTITLEMENT_DENIED_PROTOCOL_KEY, buildEntitlementLimitReachedEvent, cronEntitlementLimitText, parseEntitlementDenial, parseEntitlementDenialDetail, } from '../../../shared/entitlement.js';
import { baseRespOrSuccess } from './types.js';
/**
 * 云端 cron 创建/启用的限额 denial 分支（方案 §二④b / §四-C5 / §四-D）。
 *
 * denial 的两种到达形态都接受（fail-open，服务端 gate 才是强制点）：
 *   1. cloud-runtime HTTP ProtocolError body `{code, key, message, detail}`，
 *      `key === "ENTITLEMENT_DENIED"` 且 `detail` 是 EntitlementDenial
 *      的 JSON 字符串（§四-C5）；
 *   2. IDL resp 镜像形态：`entitlement_denial` 记录直接挂在 resp 上（§三-3）。
 *
 * 鲁棒性：denial 解析失败 → 用 resp 的 message/status_msg 兜底文案 + 一行
 * 日志，绝不 throw；事件发送失败同样只记日志。非 denial resp 返回 undefined
 * 走既有 `baseRespOrSuccess`。
 */
async function cronEntitlementDenialFailure(ctx, resp, action) {
    const isEntitlementRejection = resp.key === ENTITLEMENT_DENIED_PROTOCOL_KEY || resp.entitlement_denial !== undefined;
    if (!isEntitlementRejection)
        return undefined;
    const denial = parseEntitlementDenial(resp.entitlement_denial) ?? parseEntitlementDenialDetail(resp.detail);
    if (!denial) {
        logger.warn(`[mavis-cron] stage=entitlement_denial_parse code=ENTITLEMENT_DENIAL_UNUSABLE ` +
            `command=${ctx.command} session_id=${ctx.sessionId}`);
        const fallbackMessage = stringField(resp.message) ??
            stringField(resp.base_resp?.status_msg) ??
            'cloud cron entitlement limit reached; ask the user to review their plan limits';
        return failure(ctx.command, 'archon_server', fallbackMessage, {
            error_code: ENTITLEMENT_DENIED_PROTOCOL_KEY,
        });
    }
    let eventEmitted = false;
    if (ctx.reporter && ctx.sessionId && ctx.turnId) {
        try {
            await ctx.reporter.appendEvents([
                buildEntitlementLimitReachedEvent({
                    sessionId: ctx.sessionId,
                    turnId: ctx.turnId,
                    reporter: ctx.reporter,
                    denial,
                }),
            ]);
            eventEmitted = true;
        }
        catch {
            logger.warn(`[mavis-cron] stage=entitlement_event_emit code=ENTITLEMENT_EVENT_EMIT_FAILED ` +
                `command=${ctx.command} session_id=${ctx.sessionId} turn_id=${ctx.turnId}`);
        }
    }
    return failure(ctx.command, 'archon_server', cronEntitlementLimitText(denial, action), {
        error_code: ENTITLEMENT_DENIED_PROTOCOL_KEY,
        entitlement_key: denial.entitlement_key,
        limit: denial.limit,
        current: denial.current,
        event_emitted: eventEmitted,
    });
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
/**
 * 非 2xx 到达路径:archon-server 对限额拒绝返回 HTTP 402 + ProtocolError
 * body,cloud-runtime remote adapter 把可辨识的结构化 body 附着在抛出错误的
 * `protocolError` 字段上(见 cloud-runtime remote.ts)。这里结构化嗅探该
 * 字段 —— agent-tools 不依赖 cloud-runtime 的错误类型(依赖方向相反),
 * 形态不符返回 undefined,caller 原样 rethrow 走既有归一化路径。
 */
function thrownProtocolError(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const protocolError = error.protocolError;
    return typeof protocolError === 'object' &&
        protocolError !== null &&
        !Array.isArray(protocolError)
        ? protocolError
        : undefined;
}
/**
 * callRpc 的 denial 收口:resolved body(2xx)与 thrown 402(protocolError
 * 附着)两条到达路径共用 `cronEntitlementDenialFailure`。非 denial 的 throw
 * 原样传播,保持 dispatcher 既有的 MAVIS_COMMAND_FAILED 归一化行为。
 */
async function callCronRpcWithEntitlementGate(ctx, action, call) {
    let resp;
    try {
        resp = await call();
    }
    catch (error) {
        const protocolError = thrownProtocolError(error);
        if (protocolError) {
            const denialFailure = await cronEntitlementDenialFailure(ctx, protocolError, action);
            if (denialFailure)
                return { kind: 'denial', failure: denialFailure };
        }
        throw error;
    }
    const denialFailure = await cronEntitlementDenialFailure(ctx, resp, action);
    return denialFailure ? { kind: 'denial', failure: denialFailure } : { kind: 'resp', resp };
}
function parseProjectId(value) {
    if (typeof value !== 'number' && typeof value !== 'string')
        return undefined;
    const normalized = typeof value === 'string' ? value.trim() : value;
    if (normalized === '')
        return undefined;
    const projectId = Number(normalized);
    return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : undefined;
}
function parseModelSelection(model) {
    const separator = model.indexOf('/');
    return {
        provider_id: model.slice(0, separator),
        model_id: model.slice(separator + 1),
    };
}
class ProjectNotFoundError extends Error {
    constructor(project) {
        super(`project not found: ${project}`);
    }
}
async function resolveExplicitProjectId(ctx, project, signal) {
    const directId = parseProjectId(project);
    if (directId !== undefined) {
        const resp = await ctx.archonServer.callRpc('GetProject', { project_id: directId }, signal);
        if (resp.base_resp && resp.base_resp.status_code !== 0) {
            throw new Error(resp.base_resp.status_msg ?? `project not found: ${project}`);
        }
        if (parseProjectId(resp.project?.id) !== directId) {
            throw new ProjectNotFoundError(project);
        }
        return directId;
    }
    let cursor;
    do {
        const resp = await ctx.archonServer.callRpc('ListProjects', { page: { cursor, limit: 100 } }, signal);
        if (resp.base_resp && resp.base_resp.status_code !== 0) {
            throw new Error(resp.base_resp.status_msg ?? 'failed to list projects');
        }
        const matched = (resp.projects ?? []).find((candidate) => candidate.name === project.trim());
        const matchedId = parseProjectId(matched?.id);
        if (matchedId !== undefined)
            return matchedId;
        cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
    throw new ProjectNotFoundError(project);
}
async function resolveCurrentSessionProjectId(ctx, signal) {
    if (!ctx.sessionId)
        return undefined;
    const resp = await ctx.archonServer.callRpc('GetSession', { session_id: ctx.sessionId }, signal);
    if (resp.base_resp && resp.base_resp.status_code !== 0) {
        throw new Error(resp.base_resp.status_msg ?? 'failed to get current session');
    }
    return parseProjectId(resp.session?.project_id);
}
export const handleCronList = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('ListCronTasks', {
        ...(args.agent_id ? { agent_id: args.agent_id } : {}),
        page: { cursor: args.cursor, limit: args.limit },
    }, signal);
    return success(ctx.command, resp);
};
export const handleCronGet = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('GetCronTask', { task_id: args.task_id }, signal);
    if (!resp.task) {
        return failure(ctx.command, 'archon_server', 'cron task not found', {
            task_id: args.task_id,
            ...(resp.base_resp ? { status_code: resp.base_resp.status_code } : {}),
        });
    }
    return success(ctx.command, resp);
};
export const handleCronCreate = async (ctx, args, signal) => {
    let projectId;
    try {
        projectId = args.project
            ? await resolveExplicitProjectId(ctx, args.project, signal)
            : await resolveCurrentSessionProjectId(ctx, signal);
    }
    catch (error) {
        if (error instanceof ProjectNotFoundError) {
            return failure(ctx.command, 'validation', error.message, {
                code: 'project_not_found',
                project: args.project,
                requires_user_confirmation: true,
                guidance: 'Ask the user whether to create this project, choose an existing project, or change the intended project assignment. Wait for their confirmation before proceeding. Do not drop or replace project and retry on your own. Project creation is not available through this tool; if the user chooses to create it, guide them to create it in the UI, then retry with the confirmed project. Omitting project inherits the current session project.',
            });
        }
        return failure(ctx.command, 'validation', error instanceof Error ? error.message : String(error), args.project ? { project: args.project } : { session_id: ctx.sessionId });
    }
    const model = args.model ? parseModelSelection(args.model) : ctx.currentModel;
    // `fixed` means "give this task its own conversation, reused by every run".
    // archon-server binds that conversation on the first execution, so the tool
    // only has to hand over an unbound target — the sentinel itself never
    // reaches the task request, and no session is created here.
    const dedicatedTarget = isCronDedicatedSessionTarget(args.session);
    // A dedicated conversation has no existing target to derive an owner from, so
    // the agent is required and nothing is read before validating it.
    const agentId = dedicatedTarget
        ? args.agent_id
        : args.session?.mode === 'sessionId'
            ? await resolveSessionOwner(ctx, args.session.session_id, signal)
            : args.agent_id;
    if (!agentId)
        throw new Error('new mode and a dedicated conversation both require an agent');
    const session = dedicatedTarget
        ? { mode: 'sessionId' }
        : (args.session ?? { mode: 'new' });
    const gate = await callCronRpcWithEntitlementGate(ctx, 'create', () => ctx.archonServer.callRpc('CreateCronTask', {
        agent_id: agentId,
        cron_name: args.cron_name,
        schedule: args.schedule,
        ...(args.schedule_kind !== undefined ? { schedule_kind: args.schedule_kind } : {}),
        ...(args.run_at !== undefined ? { run_at: args.run_at } : {}),
        prompt: args.prompt,
        ...(projectId !== undefined ? { project_id: projectId } : {}),
        ...((args.timezone ?? ctx.timezone) ? { timezone: args.timezone ?? ctx.timezone } : {}),
        ...(args.active_hours ? { active_hours: args.active_hours } : {}),
        session,
        ...(model ? { model } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    }, signal));
    if (gate.kind === 'denial')
        return gate.failure;
    return baseRespOrSuccess(ctx.command, gate.resp, '/api/v1/cron/create');
};
async function resolveSessionOwner(ctx, sessionId, signal) {
    if (!sessionId?.trim())
        throw new LocalMavisCronValidationError('A target session is required');
    const response = await ctx.archonServer.callRpc('GetSession', { session_id: sessionId }, signal);
    if (response.base_resp?.status_code)
        throw new Error(response.base_resp.status_msg || 'Failed to read target session');
    const session = response.session;
    if (!session || session.archived || !session.agent_id)
        throw new LocalMavisCronValidationError('Target session must exist, be unarchived and have an Agent');
    return String(session.agent_id);
}
export const handleCronOnce = async (ctx, args, signal) => {
    const runAt = parseOnceRunAtMs({ ...args, timezone: args.timezone ?? ctx.timezone }, Date.now());
    return handleCronCreate(ctx, {
        ...args,
        agent_id: args.agent_id,
        cron_name: args.cron_name || 'One-time reminder',
        schedule: '',
        schedule_kind: 1,
        run_at: runAt,
    }, signal);
};
export const handleCronSelf = async (ctx, args, signal) => {
    const sessionId = args.session_id ?? ctx.sessionId;
    const prompt = appendQuietOnSkipPromptSuffix(args.prompt, args.quiet_on_skip ?? true);
    return handleCronCreate(ctx, {
        ...args,
        cron_name: args.cron_name || 'Check progress',
        schedule: everyToCronExpression(args.every),
        prompt,
        session: { mode: 'sessionId', session_id: sessionId },
    }, signal);
};
export const handleCronUpdate = async (ctx, args, signal) => {
    if (args.session?.mode === 'sessionId') {
        const owner = await resolveSessionOwner(ctx, args.session.session_id, signal);
        const current = await ctx.archonServer.callRpc('GetCronTask', { task_id: args.task_id }, signal);
        if (current.base_resp?.status_code || !current.task || String(current.task.agent_id) !== owner)
            throw new LocalMavisCronValidationError('Target session must belong to the task Agent');
    }
    // D9：update 路径的限额 denial 只发生在 enabled false→true 的启用分支。
    const gate = await callCronRpcWithEntitlementGate(ctx, 'enable', () => ctx.archonServer.callRpc('UpdateCronTask', {
        task_id: args.task_id,
        ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...((args.timezone ?? ctx.timezone) ? { timezone: args.timezone ?? ctx.timezone } : {}),
        ...(args.active_hours ? { active_hours: args.active_hours } : {}),
        ...(args.session ? { session: args.session } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    }, signal));
    if (gate.kind === 'denial')
        return gate.failure;
    return baseRespOrSuccess(ctx.command, gate.resp, '/api/v1/cron/update');
};
export const handleCronDelete = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('DeleteCronTask', { task_id: args.task_id }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/cron/delete');
};
export const handleCronTrigger = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('TriggerCronTask', {
        task_id: args.task_id,
        request_id: ctx.toolCallId ? `${ctx.sessionId ?? 'cron'}:${ctx.toolCallId}` : randomUUID(),
    }, signal);
    // request_id 选择 V2 持久化 Run 路径；受理成功与执行完成分别表达。
    return baseRespOrSuccess(ctx.command, { ...resp, ...(resp.run?.run_id ? { run_id: resp.run.run_id } : {}) }, '/api/v1/cron/trigger');
};
export const handleCronSessions = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('ListCronRuns', {
        task_id: args.task_id,
        page: { cursor: args.cursor, limit: args.limit },
    }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/cron/runs/list');
};
//# sourceMappingURL=cron.js.map