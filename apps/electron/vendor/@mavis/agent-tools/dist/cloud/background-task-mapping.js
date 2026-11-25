/**
 * archon-server background task / shell job 与 `@mavis/background-task` 领域模型之间的
 * 纯映射函数，以及两类 client 抛出的错误。
 *
 * 从 cloud-runtime `background-task/archon-background-task-client.ts`、
 * `archon-shell-job-client.ts` 原样搬来，cloud-runtime 原路径改为 re-export；
 * cloud-harness-server 的 run 级 client 复用同一套映射。
 */
import { BackgroundTaskKind, BackgroundTaskStatus, } from './runtime-types.js';
export class ArchonBackgroundTaskError extends Error {
    operation;
    statusCode;
    constructor(operation, message, statusCode) {
        super(`background task ${operation} failed: ${message}`);
        this.name = 'ArchonBackgroundTaskError';
        this.operation = operation;
        this.statusCode = statusCode;
    }
}
export class ArchonShellJobError extends Error {
    operation;
    statusCode;
    constructor(operation, message, statusCode) {
        super(`shell job ${operation} failed: ${message}`);
        this.name = 'ArchonShellJobError';
        this.operation = operation;
        this.statusCode = statusCode;
    }
}
/** base_resp.status_code 非 0 时抛 {@link ArchonBackgroundTaskError}。 */
export function assertBackgroundTaskBaseResp(baseResp, operation) {
    const statusCode = baseResp?.status_code ?? 0;
    if (statusCode !== 0) {
        throw new ArchonBackgroundTaskError(operation, baseResp?.status_msg ?? `archon-server returned status_code=${statusCode}`, statusCode);
    }
}
/** base_resp.status_code 非 0 时抛 {@link ArchonShellJobError}。 */
export function assertShellJobBaseResp(baseResp, operation) {
    const statusCode = baseResp?.status_code ?? 0;
    if (statusCode !== 0) {
        throw new ArchonShellJobError(operation, baseResp?.status_msg ?? `archon-server returned status_code=${statusCode}`, statusCode);
    }
}
/** FinishBackgroundTask 只接受 runner 终态 Succeeded / Failed / Canceled。 */
export function isRunnerTerminalStatus(status) {
    return (status === BackgroundTaskStatus.Succeeded ||
        status === BackgroundTaskStatus.Failed ||
        status === BackgroundTaskStatus.Canceled);
}
/** Extracts the sub-agent sub-session id stashed under metadata.archon. */
export function backgroundTaskSubSessionId(task) {
    const archon = task?.metadata?.archon;
    return typeof archon?.subSessionId === 'string' && archon.subSessionId.length > 0
        ? archon.subSessionId
        : undefined;
}
/** Byte-offset slice of a durable transcript, mirroring the in-memory store. */
export function sliceTranscriptOutput(full, options, outputRef) {
    const buf = Buffer.from(full, 'utf8');
    const offset = Math.min(Math.max(options?.offset ?? 0, 0), buf.length);
    const limit = options?.limitBytes;
    const end = limit !== undefined && limit > 0 ? Math.min(buf.length, offset + limit) : buf.length;
    const content = buf.subarray(offset, end).toString('utf8');
    return {
        content,
        ...(end < buf.length ? { nextOffset: end, truncated: true } : {}),
        ...(outputRef ? { outputRef } : {}),
    };
}
/**
 * Returns the most recent assistant text from a session transcript — the
 * sub-agent's final report. archon-server ListSessionMessages returns the
 * latest N messages (ASC), so the final report is at/near the tail; scan from
 * the end for the last assistant message carrying visible content.
 */
export function finalAssistantText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m &&
            m.role === 'assistant' &&
            typeof m.msg_content === 'string' &&
            m.msg_content.length > 0) {
            return m.msg_content;
        }
    }
    return undefined;
}
export function toArchonKind(kind) {
    switch (kind) {
        case 'bash':
            return BackgroundTaskKind.Bash;
        case 'subagent':
            return BackgroundTaskKind.Subagent;
        case 'workflow':
            return BackgroundTaskKind.Workflow;
        case 'custom':
            return BackgroundTaskKind.Custom;
        default:
            throw new ArchonBackgroundTaskError('mapKind', `unknown domain task kind ${String(kind)}`);
    }
}
export function toDomainKind(kind) {
    switch (kind) {
        case BackgroundTaskKind.Bash:
            return 'bash';
        case BackgroundTaskKind.Subagent:
            return 'subagent';
        case BackgroundTaskKind.Workflow:
            return 'workflow';
        case BackgroundTaskKind.Custom:
            return 'custom';
        default:
            throw new ArchonBackgroundTaskError('mapKind', `unknown task kind ${String(kind)}`);
    }
}
export function toArchonStatus(status) {
    switch (status) {
        case 'queued':
            return BackgroundTaskStatus.Queued;
        case 'running':
            return BackgroundTaskStatus.Running;
        case 'stopping':
            return BackgroundTaskStatus.Stopping;
        case 'succeeded':
            return BackgroundTaskStatus.Succeeded;
        case 'failed':
            return BackgroundTaskStatus.Failed;
        case 'canceled':
            return BackgroundTaskStatus.Canceled;
        case 'lost':
            return BackgroundTaskStatus.Lost;
        default:
            throw new ArchonBackgroundTaskError('mapStatus', `unknown domain task status ${String(status)}`);
    }
}
export function toDomainStatus(status) {
    switch (status) {
        case BackgroundTaskStatus.Queued:
            return 'queued';
        case BackgroundTaskStatus.Running:
            return 'running';
        case BackgroundTaskStatus.Stopping:
            return 'stopping';
        case BackgroundTaskStatus.Succeeded:
            return 'succeeded';
        case BackgroundTaskStatus.Failed:
            return 'failed';
        case BackgroundTaskStatus.Canceled:
            return 'canceled';
        case BackgroundTaskStatus.Lost:
            return 'lost';
        default:
            throw new ArchonBackgroundTaskError('mapStatus', `unknown task status ${String(status)}`);
    }
}
export function toDomainTask(task) {
    const outputRef = parseOutputRef(task.output_ref, task.task_id) ?? outputRefFromSubSession(task);
    const lastError = parseTaskError(task.last_error_json);
    return {
        taskId: task.task_id,
        kind: toDomainKind(task.kind),
        status: toDomainStatus(task.status),
        ownerSessionId: task.owner_session_id,
        ...(task.description ? { description: task.description } : {}),
        ...(task.tool_call_id ? { toolCallId: task.tool_call_id } : {}),
        createdAt: task.created_at ?? 0,
        updatedAt: task.updated_at ?? task.created_at ?? 0,
        ...(task.started_at ? { startedAt: task.started_at } : {}),
        ...(task.finished_at ? { endedAt: task.finished_at } : {}),
        ...(outputRef ? { outputRef } : {}),
        ...(lastError ? { lastError } : {}),
        metadata: {
            archon: {
                userId: task.user_id,
                bizLine: task.biz_line,
                ...(task.owner_turn_id ? { ownerTurnId: task.owner_turn_id } : {}),
                ...(task.sub_session_id ? { subSessionId: task.sub_session_id } : {}),
                ...(task.input_json ? { inputJson: task.input_json } : {}),
                ...(task.execution_ref_json ? { executionRefJson: task.execution_ref_json } : {}),
                ...(task.abort_requested === undefined ? {} : { abortRequested: task.abort_requested }),
                ...(task.lease_until === undefined ? {} : { leaseUntil: task.lease_until }),
                ...(task.heartbeat_at === undefined ? {} : { heartbeatAt: task.heartbeat_at }),
                ...(task.sandbox_id ? { sandboxId: task.sandbox_id } : {}),
                ...(task.sandbox_job_id ? { sandboxJobId: task.sandbox_job_id } : {}),
                ...(task.output_ref ? { rawOutputRef: task.output_ref } : {}),
                ...(task.deleted_at === undefined ? {} : { deletedAt: task.deleted_at }),
            },
        },
    };
}
/** ReadShellJobOutput 的 output_ref：JSON TaskOutputRef，或 URI 简写。 */
export function parseShellJobOutputRef(raw, taskId) {
    if (!raw)
        return undefined;
    const parsed = parseJsonOutputRef(raw);
    if (parsed)
        return parsed;
    return {
        taskId,
        kind: raw.startsWith('sandbox://') || raw.startsWith('sandbox-job://') ? 'sandbox_job' : 'memory',
        uri: raw,
    };
}
function parseOutputRef(raw, taskId) {
    if (!raw)
        return undefined;
    return parseJsonOutputRef(raw) ?? { taskId, kind: inferOutputKind(raw), uri: raw };
}
function parseJsonOutputRef(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.taskId === 'string' &&
            typeof parsed.kind === 'string' &&
            typeof parsed.uri === 'string') {
            return parsed;
        }
    }
    catch {
        // Non-JSON output_ref is allowed as a URI shorthand.
    }
    return undefined;
}
function outputRefFromSubSession(task) {
    if (!task.sub_session_id)
        return undefined;
    return {
        taskId: task.task_id,
        kind: 'session_transcript',
        uri: `session://${task.sub_session_id}`,
    };
}
function inferOutputKind(uri) {
    if (uri.startsWith('oss://'))
        return 'oss';
    if (uri.startsWith('sandbox://') || uri.startsWith('sandbox-job://'))
        return 'sandbox_job';
    if (uri.startsWith('session://'))
        return 'session_transcript';
    if (uri.startsWith('file://'))
        return 'file';
    return 'memory';
}
function parseTaskError(raw) {
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.message === 'string') {
            return {
                message: parsed.message,
                ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
                ...(isRecord(parsed.details) ? { details: parsed.details } : {}),
            };
        }
    }
    catch {
        // Fall through and keep raw error text.
    }
    return { message: raw };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=background-task-mapping.js.map