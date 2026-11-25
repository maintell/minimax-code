/**
 * PTC 安审折叠：程序跑过子调用之后回复被安审拦下时，内核走 `safety-reconcile`，
 * 需要宿主给出这一轮每条消息的清洗函数（`TurnTailRules.sanitizeSafetyMessage`）。
 * 没有它内核直接失败（`Safety Turn tail settlement requires a Host sanitizer`），
 * 被拦内容留在 history 里进下一轮模型上下文。
 *
 * 桌面（local-runtime-v2 service/session-system/messages/ptc/safety-reconcile.ts）与
 * 云端共用这一份：清洗规则与展示副本无关，两个宿主的 canonical history 形状一致。
 *
 * 折叠后的形态：
 * - assistant 只留工具调用本身，`run_code` 的程序源码换成占位；
 * - 带 PTC 执行细节的 toolResult 只留身份字段与一句"输出已被安审扣下"，
 *   `details.ptc` 换成只含宿主执行事实的安全版本（`host_forced_content` 是
 *   `renderPtcExecutionEvidence` 的证据文本）；
 * - 既没有 PTC 细节又不是 `run_code` 结果的消息原样保留。
 */
import { readPtcExecutionDetails, } from '@mavis/agent-core/tools';
import { sanitizePtcExecutionDetailsForSafety } from '@mavis/agent-tools/ptc';
const WITHHELD_PROGRAM = {
    code: '/* Program source withheld after safety review. */',
    description: 'PTC execution evidence retained after safety review',
};
const OUTER_INTERRUPTED_CODE = 'PTC_INTERRUPTED_BY_RUNTIME_RESTART';
const OUTER_INTERRUPTED_MESSAGE = 'This PTC program was interrupted because the previous local runtime stopped. Known child results were preserved; unknown child calls must not be replayed automatically.';
const SAFETY_WITHHELD_CODE = 'PTC_OUTPUT_WITHHELD_BY_SAFETY_REVIEW';
const SAFETY_WITHHELD_MESSAGE = 'PTC output was withheld after safety review. Host-recorded child execution evidence was preserved. Unknown outcomes must not be replayed automatically.';
const MAX_PTC_RECOVERY_SUMMARY_BYTES = 64 * 1024;
const MAX_PTC_RECOVERY_INPUT_BYTES = 2 * 1024;
/**
 * One message of the Turn safety settlement; `undefined` drops the record.
 * Throws when the message has no usable timestamp, which fails the fold closed.
 */
export function sanitizePtcSafetyHistoryMessage(message) {
    if (typeof message['timestamp'] !== 'number') {
        if (message.role === 'compactionSummary')
            return message;
        throw new TypeError('Canonical safety message timestamp is invalid.');
    }
    const timestamp = message['timestamp'];
    if (message.role === 'assistant')
        return safeAssistantMessage(message, timestamp);
    return safeToolResultMessage(message, timestamp);
}
function safeAssistantMessage(message, timestamp) {
    const content = message['content'];
    const calls = Array.isArray(content) ? content.filter(isToolCall) : [];
    if (calls.length === 0)
        return undefined;
    return {
        ...pickFields(message, ['api', 'provider', 'model', 'usage', 'stopReason']),
        role: 'assistant',
        timestamp,
        content: calls.map((call) => ({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.name === 'run_code' ? { ...WITHHELD_PROGRAM } : call.arguments,
        })),
    };
}
function safeToolResultMessage(message, timestamp) {
    const details = readPtcExecutionDetails(message);
    if (!details && !(message.role === 'toolResult' && message['toolName'] === 'run_code')) {
        return message;
    }
    const safe = details ? safeOuterDetails(details) : undefined;
    return {
        ...pickFields(message, ['toolCallId', 'toolName', 'isError', 'timestamp']),
        role: 'toolResult',
        timestamp,
        content: [
            {
                type: 'text',
                text: safe?.host_forced_content ??
                    'PTC output was withheld after safety review. Execution facts are unavailable; verify effects before retrying.',
            },
        ],
        ...(safe ? { details: { ptc: safe } } : {}),
    };
}
function safeOuterDetails(details) {
    const safe = sanitizePtcExecutionDetailsForSafety(details);
    return { ...safe, host_forced_content: renderPtcExecutionEvidence(safe, 'safety-review') };
}
/**
 * The evidence text a withheld or interrupted PTC run leaves behind: which
 * child calls ran, what the host recorded about them, and that nothing is
 * replayed automatically. Counts, statuses and bounded inputs only — never the
 * program source or a child's raw result.
 */
export function renderPtcExecutionEvidence(details, reason) {
    const forced = [
        ...(details.host_forced_content ? [details.host_forced_content] : []),
        ...details.retained_facts.flatMap((fact) => fact.kind === 'plugin_feedback' && fact.text ? [fact.text] : []),
    ];
    const childLines = details.child_calls.map(describeRecoveredChild);
    const childEffects = details.child_calls.flatMap(describeRecoveredChildEffects);
    const factLines = details.retained_facts.flatMap(describeRetainedFact);
    const errorCode = reason === 'runtime-restart' ? OUTER_INTERRUPTED_CODE : SAFETY_WITHHELD_CODE;
    const message = reason === 'runtime-restart' ? OUTER_INTERRUPTED_MESSAGE : SAFETY_WITHHELD_MESSAGE;
    return truncateRecoverySummary([
        `<ptc_error code="${errorCode}">${message}</ptc_error>`,
        '<ptc_recovery>',
        'The program was not replayed. Treat unknown child outcomes as non-retryable until you verify their effects.',
        ...(childLines.length > 0 ? ['Child calls:', ...childLines] : []),
        ...(factLines.length > 0 ? ['Preserved execution facts:', ...factLines] : []),
        ...(childEffects.length > 0 ? ['Preserved child effects:', ...childEffects] : []),
        ...(forced.length > 0 ? ['Preserved plugin feedback:', ...forced] : []),
        '</ptc_recovery>',
    ]);
}
function describeRecoveredChild(call) {
    const status = {
        unknown: 'outcome unknown; do not replay automatically',
        failed: 'failed',
        completed: 'completed',
    }[call.status];
    return `- ${call.tool_name} (${call.child_tool_call_id}): ${status}`;
}
function describeRecoveredChildEffects(call) {
    const input = call.input ? `input=${boundedJson(call.input, MAX_PTC_RECOVERY_INPUT_BYTES)}` : '';
    const resultRef = call.result_ref ? `result_ref=${call.result_ref}` : '';
    const effects = [input, resultRef].filter(Boolean);
    return effects.length > 0
        ? [`- ${call.tool_name} (${call.child_tool_call_id}): ${effects.join('; ')}`]
        : [];
}
function describeRetainedFact(fact) {
    switch (fact.kind) {
        case 'terminate_agent':
            return ['- A trusted plugin requested that the outer agent stop.'];
        case 'outcome_unknown':
            return [`- ${fact.child_tool_call_id}: outcome unknown; do not replay automatically.`];
        case 'child_error':
            return [
                `- ${fact.child_tool_call_id}: child error ${fact.code}${fact.cancelled ? ' (cancelled)' : ''}.`,
            ];
        case 'background_task':
            return [`- ${fact.child_tool_call_id}: background task ${fact.task_id} was started.`];
        case 'bash_exit':
            return [`- ${fact.child_tool_call_id}: bash exit code ${String(fact.exit_code)}.`];
        case 'approval':
            return [`- ${fact.child_tool_call_id}: approval was ${fact.status}.`];
        case 'budget_exceeded':
            return [`- PTC budget exceeded: ${fact.budget}.`];
        default:
            return describeDeliveryFact(fact);
    }
}
function describeDeliveryFact(fact) {
    switch (fact.kind) {
        case 'truncation':
            // Same rule as the live run_code result (run-code-tool.ts truncationSummary):
            // only a real cut is worth a line. "unknown" mostly means a non-builtin
            // result the host never cuts; the fact itself stays in details.
            return fact.truncated === 'true'
                ? [
                    `- ${fact.child_tool_call_id}: output completeness is truncated${fact.continuation ? `; continuation=${boundedJson(fact.continuation, MAX_PTC_RECOVERY_INPUT_BYTES)}` : ''}.`,
                ]
                : [];
        case 'media_delivery':
            return [`- ${fact.child_tool_call_id}: media delivery ${fact.status}.`];
        case 'plugin_feedback':
            return fact.text
                ? [`- ${fact.child_tool_call_id}: plugin ${fact.phase} feedback was recorded.`]
                : [`- ${fact.child_tool_call_id}: plugin ${fact.phase} feedback was preserved.`];
        case 'delivery_incomplete':
            return [
                `- Outer delivery was incomplete (${fact.reason})${fact.reference ? `; reference=${fact.reference}` : ''}.`,
            ];
        default:
            return [];
    }
}
function boundedJson(value, maximumBytes) {
    const json = JSON.stringify(value);
    return truncateUtf8(json, maximumBytes, '…[truncated]');
}
function truncateRecoverySummary(lines) {
    return truncateUtf8(lines.join('\n'), MAX_PTC_RECOVERY_SUMMARY_BYTES, '\n<ptc_recovery_summary_truncated/>');
}
function truncateUtf8(value, maximumBytes, marker) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength <= maximumBytes)
        return value;
    const markerBytes = new TextEncoder().encode(marker);
    if (maximumBytes <= markerBytes.byteLength) {
        return new TextDecoder().decode(markerBytes.slice(0, maximumBytes), { stream: true });
    }
    const prefix = new TextDecoder().decode(bytes.slice(0, maximumBytes - markerBytes.byteLength), {
        stream: true,
    });
    return `${prefix}${marker}`;
}
function pickFields(value, fields) {
    return Object.fromEntries(fields.flatMap((field) => (value[field] === undefined ? [] : [[field, value[field]]])));
}
function isToolCall(value) {
    return (isRecord(value) &&
        value['type'] === 'toolCall' &&
        typeof value['id'] === 'string' &&
        typeof value['name'] === 'string');
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=ptc-safety-reconcile.js.map