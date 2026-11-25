/**
 * `task` 定义：`agent_name` 必填、没有 `subagent_type`，参数要求对齐桌面 `LocalTaskToolDef`。
 *
 * 与 {@link CloudTaskToolDef} 的差别只有目标字段：v1 保留 `subagent_type` 兼容旧调用，这里只认
 * `agent_name`，并按桌面加 `additionalProperties: false`。不提供桌面的 `model` / `effort`：
 * archon-server 的 StartSubAgentTask 不接受子会话模型，子会话沿用父会话的 effective model。
 *
 * {@link CloudAgentNameSyncTaskToolDef} 是后台关闭时的版本，去掉 `run_in_background`，关系同
 * {@link GatedSyncTaskToolDef} 相对 {@link CloudTaskToolDef}。
 */
import { Type } from '@sinclair/typebox';
import { CLOUD_TASK_TOOL_DESCRIPTION, CloudTaskToolDef } from './builtin-defs.js';
import { GATED_SYNC_TASK_DESCRIPTION } from './cloud-task-control.js';
/**
 * 云端专用 `agent_name` 说明：云端不认桌面那套 `agent:<stable-name>` 规则，只按请求里给出的引用、
 * `<available_subagents>` 列出的值和 `mavis "agent list"` 里的 `agent_name` 原样匹配。
 */
export const CLOUD_TASK_AGENT_NAME_DESCRIPTION = 'The Agent to run, passed exactly as given: the request-ref of an `<agent-reference>` in the user\'s message, a value listed in <available_subagents>, or an agent_name from the mavis "agent list" command when that tool is available.';
const RUN_IN_BACKGROUND_DESCRIPTION = "Optional; defaults to background execution when it is enabled. Omit it when starting several child agents in parallel. Set false only to wait for a single child's final result. True starts background execution and returns a task id immediately. Inspect or control a background task with task_query, task_output, and task_stop.";
const TASK_TARGET_PROPS = {
    description: Type.String({
        minLength: 1,
        description: 'A short (3-5 words) description of the task',
    }),
    prompt: Type.String({
        description: 'The task for the agent to perform',
    }),
    agent_name: Type.String({
        description: CLOUD_TASK_AGENT_NAME_DESCRIPTION,
    }),
};
export const CloudAgentNameTaskToolDef = {
    name: CloudTaskToolDef.name,
    executionMode: CloudTaskToolDef.executionMode,
    description: CLOUD_TASK_TOOL_DESCRIPTION,
    schema: Type.Object({
        ...TASK_TARGET_PROPS,
        run_in_background: Type.Optional(Type.Boolean({ description: RUN_IN_BACKGROUND_DESCRIPTION })),
    }, { additionalProperties: false }),
};
export const CloudAgentNameSyncTaskToolDef = {
    name: CloudTaskToolDef.name,
    executionMode: CloudTaskToolDef.executionMode,
    description: GATED_SYNC_TASK_DESCRIPTION,
    schema: Type.Object(TASK_TARGET_PROPS, { additionalProperties: false }),
};
//# sourceMappingURL=task-agent-name-defs.js.map