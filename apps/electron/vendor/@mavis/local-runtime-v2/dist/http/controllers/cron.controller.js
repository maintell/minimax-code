import { CRON_REQUEST_SOURCE_HEADER, isCronRequestSource, } from '@mavis/protocol';
import { CronRunStatus, CronScheduleKind, CronSessionTargetMode, CronTriggerSource, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../errors.js';
import { CronControllerBase } from '../generated/cron-controller-base.gen.js';
import { AgentServiceError } from '../../service/agent/index.js';
function isDomainError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        typeof err.code === 'string' &&
        typeof err.message === 'string');
}
/** 把稳定的领域错误码映射为强类型契约错误。未知错误码保持通用形式，避免泄露内部信息。 */
const DOMAIN_ERROR_STATUS = {
    CONTENT_POLICY_VIOLATION: 422,
    CRON_INVALID: 400,
    CRON_NOT_FOUND: 404,
    CRON_DEFINITION_NOT_FOUND: 404,
    CRON_CONFLICT: 409,
    SELF_REMINDER_EXISTS: 409,
    CRON_INVALID_STATE: 409,
    SCHEDULER_INVALID: 400,
    SCHEDULER_NOT_FOUND: 404,
    SCHEDULER_INVALID_STATE: 409,
    // 领域层暴露的 targetSession 校验错误。
    CRON_TARGET_SESSION_NOT_FOUND: 404,
    CRON_TARGET_SESSION_AGENT_MISMATCH: 409,
};
function toAppError(err) {
    if (err instanceof AppError)
        return err;
    if (err instanceof AgentServiceError) {
        return new AppError(err.status, err.code, err.message);
    }
    if (isDomainError(err)) {
        // 公开契约严禁暴露 CAS/revision 错误码；领域门面不会发出这些错误，
        // 此处继续通过拒绝映射形成保护。
        const status = DOMAIN_ERROR_STATUS[err.code] ?? 500;
        if (status === 500) {
            return new AppError(500, 'INTERNAL_ERROR', 'internal error');
        }
        return new AppError(status, err.code, err.message);
    }
    return new AppError(500, 'INTERNAL_ERROR', 'internal error');
}
async function mapDomainErrors(operation) {
    try {
        return await operation();
    }
    catch (err) {
        throw toAppError(err);
    }
}
function requireText(value, field) {
    if (value !== undefined && value.trim() !== '')
        return value;
    throw new AppError(400, 'VALIDATION_ERROR', `${field} is required`);
}
function normalizeLimit(limit) {
    if (limit === undefined)
        return undefined;
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'limit must be a positive integer');
    }
    return limit;
}
/** 把契约调度配置转换为 Cron service 调度配置。 */
function toDomainSchedule(schedule) {
    if (!schedule)
        throw new AppError(400, 'VALIDATION_ERROR', 'schedule is required');
    if (schedule.kind === CronScheduleKind.Recurring) {
        const expression = requireText(schedule.expression, 'schedule.expression');
        return {
            kind: 'recurring',
            expression,
            ...(schedule.timezone?.trim() ? { timezone: schedule.timezone } : {}),
        };
    }
    if (schedule.kind === CronScheduleKind.Once) {
        const runAtMs = schedule.runAtMs;
        if (runAtMs === undefined || !Number.isFinite(runAtMs)) {
            throw new AppError(400, 'VALIDATION_ERROR', 'schedule.runAtMs is required for a once schedule');
        }
        return { kind: 'once', runAtMs };
    }
    throw new AppError(400, 'VALIDATION_ERROR', 'schedule.kind is invalid');
}
/** 把 Cron service 调度配置转换为契约调度配置。 */
function toContractSchedule(schedule) {
    if (schedule.kind === 'recurring') {
        return {
            kind: CronScheduleKind.Recurring,
            expression: schedule.expression,
            ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
        };
    }
    return { kind: CronScheduleKind.Once, runAtMs: schedule.runAtMs };
}
function toDomainSessionTarget(target) {
    if (!target)
        throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget is required');
    if (target.mode === CronSessionTargetMode.New) {
        if (target.sessionId !== undefined) {
            throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget.sessionId is not allowed for New mode');
        }
        return { mode: 'new' };
    }
    if (target.mode === CronSessionTargetMode.SessionId) {
        return {
            mode: 'sessionId',
            sessionId: requireText(target.sessionId, 'sessionTarget.sessionId'),
        };
    }
    throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget.mode is invalid');
}
function toDomainCreateSessionTarget(target) {
    if (!target)
        throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget is required');
    if (target.mode === CronSessionTargetMode.New) {
        if (target.sessionId !== undefined) {
            throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget.sessionId is not allowed for New mode');
        }
        return { mode: 'new' };
    }
    if (target.mode === CronSessionTargetMode.SessionId) {
        return target.sessionId === undefined
            ? { mode: 'sessionId' }
            : { mode: 'sessionId', sessionId: requireText(target.sessionId, 'sessionTarget.sessionId') };
    }
    throw new AppError(400, 'VALIDATION_ERROR', 'sessionTarget.mode is invalid');
}
function toContractSessionTarget(target) {
    if (target.mode === 'new')
        return { mode: CronSessionTargetMode.New };
    return { mode: CronSessionTargetMode.SessionId, sessionId: target.sessionId };
}
function toContractDefinition(view) {
    return {
        cronId: view.cronId,
        name: view.name,
        agentName: view.agentName,
        schedule: toContractSchedule(view.schedule),
        enabled: view.enabled,
        prompt: view.prompt,
        sessionTarget: toContractSessionTarget(view.sessionTarget),
        ...(view.project === undefined || view.project === null ? {} : { project: view.project }),
        ...(view.model === undefined || view.model === null ? {} : { model: view.model }),
        createdAt: view.createdAtMs,
        updatedAt: view.updatedAtMs,
        ...(view.nextRunAtMs === undefined ? {} : { nextRunAt: view.nextRunAtMs }),
        ...(view.consumedAtMs === undefined ? {} : { consumedAt: view.consumedAtMs }),
        ...(view.deletedAtMs === undefined ? {} : { deletedAt: view.deletedAtMs }),
    };
}
const RUN_STATUS_TO_CONTRACT = {
    pending: CronRunStatus.Pending,
    delivered: CronRunStatus.Delivered,
    failed: CronRunStatus.Failed,
};
const RUN_SOURCE_TO_CONTRACT = {
    manual: CronTriggerSource.Manual,
    scheduled: CronTriggerSource.Scheduled,
};
function toContractRun(view) {
    return {
        runId: view.runId,
        cronId: view.cronId,
        triggerSource: RUN_SOURCE_TO_CONTRACT[view.triggerSource],
        status: RUN_STATUS_TO_CONTRACT[view.status],
        createdAt: view.createdAtMs,
        ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
        ...(view.deliveredAtMs === undefined ? {} : { deliveredAt: view.deliveredAtMs }),
        ...(view.failedAtMs === undefined ? {} : { failedAt: view.failedAtMs }),
        ...(view.errorCode === undefined ? {} : { errorCode: view.errorCode }),
        ...(view.error === undefined ? {} : { error: view.error }),
    };
}
function pageMeta(page) {
    return {
        count: page.items.length,
        hasMore: page.hasMore,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
}
function legacyUnsupported(command) {
    return new AppError(501, 'CRON_LEGACY_UNSUPPORTED', `${command} is superseded by the Cron Definition/Run API in local-runtime-v2`);
}
/**
 * DesktopService Cron 传输实现。遵循 DesktopService ownership ADR，只承担契约衔接：
 * 校验强类型请求、映射到精简的 `CronService`、把领域错误转换为契约错误。
 * 本层不展开 store、runtime、session-resolver 或 Scheduler 状态维护。
 */
class CronController extends CronControllerBase {
    service;
    disabledLegacyCronCount;
    constructor(service, options = {}) {
        super();
        this.service = service;
        this.disabledLegacyCronCount = options.disabledLegacyCronCount ?? 0;
    }
    // Cron v2 定义与运行接口.
    async listCronDefinitions(_ctx, req) {
        const limit = normalizeLimit(req.limit);
        return mapDomainErrors(() => {
            const page = this.service.listDefinitions({
                ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
                ...(limit === undefined ? {} : { limit }),
                ...(req.includeDeleted === undefined ? {} : { includeDeleted: req.includeDeleted }),
                ...(req.agentName === undefined ? {} : { agentName: req.agentName }),
            });
            const disabledLegacyCronCount = this.disabledLegacyCronCount;
            this.disabledLegacyCronCount = 0;
            return {
                definitions: page.items.map(toContractDefinition),
                ...pageMeta(page),
                ...(disabledLegacyCronCount > 0 ? { baseResp: { disabledLegacyCronCount } } : {}),
            };
        });
    }
    async getCronDefinition(_ctx, req) {
        const cronId = requireText(req.cronId, 'cronId');
        return mapDomainErrors(() => {
            const view = this.service.getDefinition(cronId);
            if (!view)
                throw new AppError(404, 'CRON_NOT_FOUND', `cron definition not found: ${cronId}`);
            return { definition: toContractDefinition(view) };
        });
    }
    async createCronDefinition(ctx, req) {
        const name = requireText(req.name, 'name');
        const agentName = requireText(req.agentName, 'agentName');
        const prompt = requireText(req.prompt, 'prompt');
        const schedule = toDomainSchedule(req.schedule);
        const sessionTarget = toDomainCreateSessionTarget(req.sessionTarget);
        return mapDomainErrors(async () => {
            const view = await this.service.createDefinition({
                name,
                // `main` remains a logical root reference. Cron session creation resolves
                // it for every Run so a later root switch redirects subsequent executions.
                agentName,
                prompt,
                schedule,
                sessionTarget,
                ...(req.project === undefined ? {} : { project: req.project }),
                ...(req.model === undefined ? {} : { model: req.model }),
                ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
            }, { mutationSource: cronRequestSource(ctx) });
            return { definition: toContractDefinition(view) };
        });
    }
    async updateCronDefinition(ctx, req) {
        const cronId = requireText(req.cronId, 'cronId');
        const sessionTarget = req.sessionTarget === undefined ? undefined : toDomainSessionTarget(req.sessionTarget);
        const schedule = req.schedule === undefined ? undefined : toDomainSchedule(req.schedule);
        return mapDomainErrors(async () => {
            const view = await this.service.updateDefinition({
                cronId,
                ...(req.name === undefined ? {} : { name: req.name }),
                ...(schedule === undefined ? {} : { schedule }),
                ...(req.prompt === undefined ? {} : { prompt: req.prompt }),
                ...(req.enabled === undefined ? {} : { enabled: req.enabled }),
                ...(sessionTarget === undefined ? {} : { sessionTarget }),
                ...(req.model === undefined ? {} : { model: req.model }),
                ...(req.project === undefined ? {} : { project: req.project }),
            }, { mutationSource: cronRequestSource(ctx) });
            return { definition: toContractDefinition(view) };
        });
    }
    async deleteCronDefinition(ctx, req) {
        const cronId = requireText(req.cronId, 'cronId');
        return mapDomainErrors(async () => {
            await this.service.deleteDefinition({ cronId }, { mutationSource: cronRequestSource(ctx) });
            return { success: true };
        });
    }
    async triggerCronRun(ctx, req) {
        const cronId = requireText(req.cronId, 'cronId');
        const requestId = triggerRequestId(req);
        return mapDomainErrors(async () => {
            const run = await this.service.triggerManualRun(cronId, {
                triggerSource: cronRequestSource(ctx),
                ...(requestId === undefined ? {} : { requestId }),
            });
            return { run: toContractRun(run) };
        });
    }
    async listCronRuns(_ctx, req) {
        const cronId = requireText(req.cronId, 'cronId');
        const limit = normalizeLimit(req.limit);
        return mapDomainErrors(() => {
            const page = this.service.listRuns({
                cronId,
                ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
                ...(limit === undefined ? {} : { limit }),
            });
            return { runs: page.items.map(toContractRun), ...pageMeta(page) };
        });
    }
    // 旧版 v1 形态的 Cron 接口。
    // v1 CronTask/ActiveHours/keepSessions 结构包含 v2 领域按 §9 移除的能力。
    // 这些路由继续保留在生成契约中，并返回稳定的不支持错误，避免有损映射到新领域。
    // Local Mavis Tool 按 §8 调用 v2 方法。
    async listCrons(_ctx, _req) {
        throw legacyUnsupported('listCrons');
    }
    async listCronSessions(_ctx, _req) {
        throw legacyUnsupported('listCronSessions');
    }
    async createCron(_ctx, _req) {
        throw legacyUnsupported('createCron');
    }
    async triggerCron(_ctx, _req) {
        throw legacyUnsupported('triggerCron');
    }
    async updateCron(_ctx, _req) {
        throw legacyUnsupported('updateCron');
    }
    async deleteCron(_ctx, _req) {
        throw legacyUnsupported('deleteCron');
    }
}
export function createCronController(service, options = {}) {
    return new CronController(service, options);
}
function cronRequestSource(ctx) {
    const source = ctx.requestHeaders.get(CRON_REQUEST_SOURCE_HEADER);
    return isCronRequestSource(source) ? source : 'http_api';
}
function triggerRequestId(req) {
    const value = req.requestId;
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'requestId must be a non-empty string');
    }
    return value;
}
//# sourceMappingURL=cron.controller.js.map