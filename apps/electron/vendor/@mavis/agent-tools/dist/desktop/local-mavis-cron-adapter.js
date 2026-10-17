import { appendQuietOnSkipPromptSuffix, LocalMavisCronValidationError, parseOnceRunAtMs, everyToCronExpression, } from '../shared/cron-schedule-input.js';
import { CRON_REQUEST_SOURCE_HEADER } from '@mavis/protocol';
export { LocalMavisCronValidationError, parseOnceRunAtMs, everyToCronExpression, } from '../shared/cron-schedule-input.js';
const CronScheduleKind = { Recurring: 0, Once: 1 };
const CronSessionTargetMode = { New: 0, SessionId: 1 };
const CronRunStatus = { Pending: 0, Delivered: 1, Failed: 2 };
const CronTriggerSource = { Manual: 0, Scheduled: 1 };
/**
 * 调用方绕过 Tool schema，直接传入 Cron v2 领域明确不支持的参数时抛出的稳定错误。
 * 当前仅保留 `active_hours` 的明确拒绝。
 *
 * `dispatchLocalMavis` 根据现有 `status`/`code` 错误结构，将其映射为
 * `validation` 失败返回。
 */
export class LocalMavisCronUnsupportedError extends Error {
    status = 400;
    statusCode = 400;
    code = 'CRON_PARAM_UNSUPPORTED';
    parameter;
    constructor(parameter, detail) {
        super(`unsupported cron parameter: ${parameter} — ${detail}`);
        this.name = 'LocalMavisCronUnsupportedError';
        this.parameter = parameter;
    }
}
const NOT_FOUND_CODES = new Set(['CRON_NOT_FOUND', 'NOT_FOUND', 'CRON_DEFINITION_NOT_FOUND']);
/**
 * 创建 {@link LocalMavisCronAdapter}，把旧 Local Mavis Cron 命令转发到生成的
 * `DesktopService` Cron v2 客户端。
 *
 * 成功返回和失败返回继续兼容 MR2 前的 Local Mavis Tool 契约。
 * 映射规则遵循任务 §8.5：
 *   - `session.mode=new` → 显式新会话目标
 *   - `session.mode=sessionId` → 显式固定会话目标
 *   - `cron self` → 使用当前 `sessionId` 作为固定会话目标
 *   - `enabled=false` → paused，`enabled=true` → active/resume
 *   - `cron delete` → 仅删除 Definition，保留 CronRun 与聊天 Session
 *   - `cron sessions` → CronRun 历史记录，每次运行包含 `sessionId`
 *   - recurring 创建/更新 → recurring 调度
 *   - `cron once` → once 调度
 *
 * `active_hours` 会通过 {@link LocalMavisCronUnsupportedError} 明确拒绝。
 */
export function createLocalMavisCronAdapter(client, options = {}) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const onceName = options.onceNameFactory ?? (() => `once-${randomSlug()}`);
    const selfName = options.selfNameFactory ?? (() => `watch-${randomSlug()}`);
    const callOptions = (signal) => (signal ? { signal } : undefined);
    const mutationCallOptions = (signal) => ({
        ...(signal ? { signal } : {}),
        headers: { [CRON_REQUEST_SOURCE_HEADER]: 'agent_tool' },
    });
    return {
        async resolveModel(req, signal) {
            const response = await client.listModels({ ...(req.sessionId ? { sessionId: req.sessionId } : {}) }, callOptions(signal));
            return resolveModelFromCatalog(response.models, req.model);
        },
        async listCrons(req, signal) {
            const resp = await client.listCronDefinitions({
                ...(req.agentName === undefined ? {} : { agentName: req.agentName }),
                ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
                ...(req.limit === undefined ? {} : { limit: req.limit }),
            }, callOptions(signal));
            return {
                tasks: (resp.definitions ?? []).map(toCronTask),
                ...(resp.count === undefined ? {} : { count: resp.count }),
                ...(resp.hasMore === undefined ? {} : { hasMore: resp.hasMore }),
                ...(resp.nextCursor === undefined ? {} : { nextCursor: resp.nextCursor }),
            };
        },
        async getCron(req, signal) {
            try {
                const resp = await client.getCronDefinition({ cronId: req.cronId }, callOptions(signal));
                return { task: toCronTask(resp.definition) };
            }
            catch (error) {
                if (isNotFound(error))
                    return {};
                throw error;
            }
        },
        async createCron(req, signal) {
            rejectActiveHours(req.activeHours);
            const sessionTarget = mapCreationSessionTarget(req.session);
            const resp = await client.createCronDefinition({
                name: req.cronName,
                agentName: req.agentName,
                schedule: recurringSchedule(req.schedule, req.timezone),
                prompt: req.prompt,
                sessionTarget,
                ...(req.project === undefined ? {} : { project: req.project }),
                ...(req.model === undefined ? {} : { model: req.model }),
                ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
            }, mutationCallOptions(signal));
            return { task: toCronTask(resp.definition) };
        },
        async createSelfReminder(req, signal) {
            const name = req.cronName?.trim() || selfName();
            // 自提醒必须携带所属智能体。生成的 createCronDefinition 契约会以 400
            // 拒绝空 agentName，Cron 执行器创建会话时也会再次校验。
            // 调用方负责解析当前会话的智能体并传入此处。
            const agentName = req.agentName.trim();
            if (!agentName) {
                throw new LocalMavisCronValidationError('cron self requires a non-empty agent name');
            }
            const resp = await client.createCronDefinition({
                name,
                agentName,
                schedule: recurringSchedule(everyToCronExpression(req.every), req.timezone),
                prompt: appendQuietOnSkipPromptSuffix(req.prompt, req.quietOnSkip ?? true),
                sessionTarget: { mode: CronSessionTargetMode.SessionId, sessionId: req.sessionId },
                ...(req.project === undefined ? {} : { project: req.project }),
                ...(req.model === undefined ? {} : { model: req.model }),
            }, mutationCallOptions(signal));
            const definition = resp.definition;
            return {
                agentName: definition.agentName,
                cronName: definition.name,
                schedule: definition.schedule.expression ?? '',
                sessionId: definition.sessionTarget.mode === CronSessionTargetMode.SessionId
                    ? requireSessionTargetId(definition.sessionTarget)
                    : req.sessionId,
                task: toCronTask(definition),
            };
        },
        async createOnceCron(req, signal) {
            const sessionTarget = mapCreationSessionTarget(req.session);
            const runAtMs = parseOnceRunAtMs(req, nowMs());
            const resp = await client.createCronDefinition({
                name: req.cronName?.trim() || onceName(),
                agentName: req.agentName,
                schedule: { kind: CronScheduleKind.Once, runAtMs },
                prompt: req.prompt,
                sessionTarget,
                ...(req.project === undefined ? {} : { project: req.project }),
                ...(req.model === undefined ? {} : { model: req.model }),
            }, mutationCallOptions(signal));
            const definition = resp.definition;
            return {
                agentName: definition.agentName,
                cronName: definition.name,
                runAtMs: definition.schedule.runAtMs ?? runAtMs,
                // A once task created with a dedicated conversation has no real target
                // until its first run, so the top-level id is only present once bound.
                ...(definition.sessionTarget.mode === CronSessionTargetMode.SessionId &&
                    definition.sessionTarget.sessionId?.trim()
                    ? { sessionId: requireSessionTargetId(definition.sessionTarget) }
                    : {}),
                task: toCronTask(definition),
            };
        },
        async updateCron(req, signal) {
            rejectActiveHours(req.activeHours);
            const targetFields = req.session === undefined ? {} : { sessionTarget: mapSessionTarget(req.session) };
            const resp = await client.updateCronDefinition({
                cronId: req.cronId,
                ...(req.schedule === undefined
                    ? {}
                    : { schedule: recurringSchedule(req.schedule, req.timezone) }),
                ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
                ...targetFields,
                ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
            }, mutationCallOptions(signal));
            return { task: toCronTask(resp.definition) };
        },
        async deleteCron(req, signal) {
            const resp = await client.deleteCronDefinition({ cronId: req.cronId }, mutationCallOptions(signal));
            return { success: resp.success };
        },
        async triggerCron(req, signal) {
            const resp = await client.triggerCronRun({ cronId: req.cronId }, mutationCallOptions(signal));
            const run = resp.run;
            return {
                success: run.status !== CronRunStatus.Failed,
                runId: run.runId,
                ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
                createdAt: run.createdAt,
                status: runStatusLabel(run.status),
                triggerSource: triggerSourceLabel(run.triggerSource),
                ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
                ...(run.status === CronRunStatus.Failed && run.error !== undefined
                    ? { reason: run.error }
                    : {}),
            };
        },
        async listCronSessions(req, signal) {
            const resp = await client.listCronRuns({
                cronId: req.cronId,
                ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
                ...(req.limit === undefined ? {} : { limit: req.limit }),
            }, callOptions(signal));
            return {
                sessions: (resp.runs ?? []).map(toRunSession),
                ...(resp.count === undefined ? {} : { total: resp.count }),
                ...(resp.hasMore === undefined ? {} : { hasMore: resp.hasMore }),
                ...(resp.nextCursor === undefined ? {} : { nextCursor: resp.nextCursor }),
            };
        },
    };
}
function resolveModelFromCatalog(catalog, rawModel) {
    const input = rawModel.trim();
    if (!input)
        return { kind: 'not_found' };
    const exactKey = uniqueModelMatches(catalog.filter((model) => modelKey(model).toLowerCase() === input.toLowerCase()));
    if (exactKey)
        return exactKey;
    const exactName = uniqueModelMatches(catalog.filter((model) => model.modelId.toLowerCase() === input.toLowerCase() ||
        model.displayName?.toLowerCase() === input.toLowerCase()));
    if (exactName)
        return exactName;
    const shorthand = normalizeModelSearchText(input);
    if (shorthand.length < 2)
        return { kind: 'not_found' };
    return (uniqueModelMatches(catalog.filter((model) => [model.modelId, model.displayName].some((value) => value && normalizeModelSearchText(value).includes(shorthand)))) ?? { kind: 'not_found' });
}
function uniqueModelMatches(models) {
    const candidates = [...new Set(models.map(modelKey))];
    const [model] = candidates;
    if (candidates.length === 1 && model !== undefined)
        return { kind: 'resolved', model };
    if (candidates.length > 1)
        return { kind: 'ambiguous', candidates };
    return undefined;
}
function modelKey(model) {
    return model.modelConfigId?.trim() || `${model.providerId}/${model.modelId}`;
}
function normalizeModelSearchText(value) {
    return (value
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []).join('');
}
function mapSessionTarget(session) {
    if (!session) {
        throw new LocalMavisCronValidationError('cron create requires an explicit session target');
    }
    if (session.mode === 'new')
        return { mode: CronSessionTargetMode.New };
    if (session.mode !== 'sessionId') {
        throw new LocalMavisCronValidationError(`unknown session.mode: ${JSON.stringify(session.mode)}`);
    }
    const sessionId = session.sessionId?.trim();
    if (!sessionId) {
        throw new LocalMavisCronValidationError('session.mode=sessionId requires a non-empty session_id');
    }
    return { mode: CronSessionTargetMode.SessionId, sessionId };
}
function mapCreationSessionTarget(session) {
    if (!session) {
        throw new LocalMavisCronValidationError('cron create requires an explicit session target');
    }
    if (session.mode === 'new')
        return { mode: CronSessionTargetMode.New };
    const sessionId = session.sessionId?.trim();
    return {
        mode: CronSessionTargetMode.SessionId,
        ...(sessionId ? { sessionId } : {}),
    };
}
function rejectActiveHours(activeHours) {
    if (activeHours === undefined)
        return;
    throw new LocalMavisCronUnsupportedError('active_hours', 'active-hours windows are not supported; the cron fires on its schedule regardless of time of day');
}
function recurringSchedule(expression, timezone) {
    return {
        kind: CronScheduleKind.Recurring,
        expression,
        ...(timezone === undefined ? {} : { timezone }),
    };
}
function toCronTask(definition) {
    const once = definition.schedule.kind === CronScheduleKind.Once;
    return {
        cronId: definition.cronId,
        cronName: definition.name,
        agentName: definition.agentName,
        scheduleType: once ? 'once' : 'cron',
        ...(definition.schedule.expression === undefined
            ? {}
            : { schedule: definition.schedule.expression }),
        ...(definition.schedule.runAtMs === undefined ? {} : { runAtMs: definition.schedule.runAtMs }),
        ...(definition.schedule.timezone === undefined
            ? {}
            : { timezone: definition.schedule.timezone }),
        enabled: definition.enabled,
        prompt: definition.prompt,
        session: toCronSessionTarget(definition.sessionTarget),
        ...(definition.project ? { project: definition.project } : {}),
        ...(definition.model ? { model: definition.model } : {}),
        ...(definition.nextRunAt === undefined ? {} : { nextRun: definition.nextRunAt }),
        status: definitionStatus(definition),
    };
}
/**
 * 读取路径忠实映射定义。`sessionId` 模式在首次执行绑定前没有真实 ID，
 * 此时按 pending 形态返回；绑定后自然带回真实 ID。自提醒等必须拿到真实 ID
 * 的写入路径继续使用 `requireSessionTargetId()`。
 */
function toCronSessionTarget(target) {
    if (target.mode === CronSessionTargetMode.New)
        return { mode: 'new' };
    const sessionId = target.sessionId?.trim();
    return { mode: 'sessionId', ...(sessionId ? { sessionId } : {}) };
}
function requireSessionTargetId(target) {
    const sessionId = target.sessionId?.trim();
    if (!sessionId) {
        throw new LocalMavisCronValidationError('sessionTarget.sessionId is required for SessionId mode');
    }
    return sessionId;
}
function definitionStatus(definition) {
    if (definition.deletedAt !== undefined)
        return 'deleted';
    if (definition.consumedAt !== undefined)
        return 'consumed';
    return definition.enabled ? 'active' : 'paused';
}
function toRunSession(run) {
    return {
        runId: run.runId,
        createdAt: run.createdAt,
        status: runStatusLabel(run.status),
        triggerSource: triggerSourceLabel(run.triggerSource),
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        ...(run.deliveredAt === undefined ? {} : { deliveredAt: run.deliveredAt }),
        ...(run.failedAt === undefined ? {} : { failedAt: run.failedAt }),
        ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
        ...(run.error === undefined ? {} : { error: run.error }),
    };
}
function runStatusLabel(status) {
    switch (status) {
        case CronRunStatus.Delivered:
            return 'delivered';
        case CronRunStatus.Failed:
            return 'failed';
        default:
            return 'pending';
    }
}
function triggerSourceLabel(triggerSource) {
    return triggerSource === CronTriggerSource.Manual ? 'manual' : 'scheduled';
}
function isNotFound(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    if (candidate.status === 404 || candidate.statusCode === 404)
        return true;
    return typeof candidate.code === 'string' && NOT_FOUND_CODES.has(candidate.code);
}
function randomSlug() {
    return Math.random().toString(36).slice(2, 8);
}
//# sourceMappingURL=local-mavis-cron-adapter.js.map