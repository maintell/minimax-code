import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { BUNNY_MAVIS_COMMAND_SCHEMAS, SPACE_CONTEXT_SUMMARY_MAX } from './local-mavis-bunny.js';
import { BUNNY_MAVIS_COMMAND_DOCS, mavisRecoveryInstruction } from './local-mavis-commands.js';
import { describeProperties } from './local-mavis-schema-docs.js';
import { zodToJsonSchema } from './local-mavis-ptc.js';
import { dispatchBunnyCommand, endsTurnAfterWrite, endTurn, limitMavisToolResult, } from './local-mavis.js';
/** The namespace these tools are grouped under; `bunny-task` is its Skill. */
const BUNNY_TASK_NAMESPACE = 'bunny.task';
const SPACE_ID = '事项 ID，取自 bunny_task_space_list。';
const GOAL = '事项目标，同步写进 context.md 的 <goal>。';
const PROJECTS = '关联项目，取自 project_list。';
/** How a space is named: the same rule the system prompt's <naming> spells out. */
const NAMING = '名词短语标签：对象 +（需要时）工作类型，不写成句子；规则见系统提示 <naming>。';
/** Every coordinator operation, in the order the coordinator reads them. */
export const BUNNY_SPACE_TOOL_SPECS = [
    { name: 'bunny_task_space_list', command: 'space list', fields: {} },
    { name: 'bunny_task_space_get', command: 'space get', fields: { space_id: SPACE_ID } },
    {
        name: 'bunny_task_space_create',
        command: 'space create',
        fields: { name: `事项名称，必填。${NAMING}`, goal: GOAL, projects: PROJECTS },
    },
    {
        name: 'bunny_task_space_update',
        command: 'space update',
        fields: { space_id: SPACE_ID, name: `新的事项名称。${NAMING}`, goal: GOAL, projects: PROJECTS },
    },
    {
        name: 'bunny_task_space_context_read',
        command: 'space context read',
        fields: { space_id: SPACE_ID },
    },
    {
        name: 'bunny_task_space_context_write',
        command: 'space context write',
        fields: {
            space_id: SPACE_ID,
            summary: `整段新的 context.md <summary>，不含标签，最多 ${SPACE_CONTEXT_SUMMARY_MAX} 字符。和 sections 只给一个。`,
            sections: '只改这几节，和 summary 只给一个。[{ heading, content }]：heading 是标题整行，按整行匹配，一节到下一个同级或更高级标题为止，传入的一节整段替换原节，要保留的旧条目和新内容一起写进去；content 为空删掉这一节；找不到的标题加在末尾。',
            revision: '必填，取自最近一次 bunny_task_space_context_read 返回的 revision。',
            end_turn: 'true 时写成功后立即结束这一轮；默认 false。',
        },
    },
    { name: 'bunny_task_model_list', command: 'task model list', fields: {} },
    {
        name: 'bunny_task_model_set',
        command: 'task model set',
        fields: { model: '用户选的模型名或在“其他”里填的内容，原样传。' },
    },
];
/** Every coordinator tool name, in the order the coordinator reads them. */
export const BUNNY_SPACE_TOOL_NAMES = BUNNY_SPACE_TOOL_SPECS.map((spec) => spec.name);
/** The tool that replaced a coordinator operation; undefined for any other command. */
export function bunnySpaceToolForCommand(command) {
    return typeof command === 'string'
        ? BUNNY_SPACE_TOOL_SPECS.find((spec) => spec.command === command)
        : undefined;
}
/** The coordinator's own tools, each running the operation it stands for. */
export function buildLocalBunnySpaceTools(agentAdapter, sessionAdapter) {
    return BUNNY_SPACE_TOOL_SPECS.map((spec) => {
        const def = {
            name: spec.name,
            // Default-loaded on purpose: the Skill gate covers on-demand tools only,
            // so grouping these under `bunny.task` costs the coordinator nothing.
            loading: 'default',
            namespace: BUNNY_TASK_NAMESPACE,
            description: `${BUNNY_MAVIS_COMMAND_DOCS[spec.command].summary}仅 Bunny 可调用。`,
            schema: toolSchema(spec),
        };
        return {
            def,
            impl: {
                execute: async (ctx, input, signal) => {
                    const args = isRecord(input) ? input : {};
                    const output = await dispatchBunnyCommand({
                        agentAdapter,
                        sessionAdapter,
                        ...(ctx.agentName ? { currentAgentName: ctx.agentName } : {}),
                        ...(isCoordinatorAgent(ctx.coordination) ? { currentCoordinator: true } : {}),
                        ...(ctx.sessionId ? { currentSessionId: ctx.sessionId } : {}),
                        ...(ctx.turnId ? { currentTurnId: ctx.turnId } : {}),
                    }, spec.command, args, signal);
                    const text = JSON.stringify(output, null, 2);
                    // The same cap the mavis executor applies, so a space listing with
                    // thousands of open tasks cannot fill the model's context.
                    const result = limitMavisToolResult(ctx, {
                        tool_name: spec.name,
                        text,
                        content: [{ type: 'text', text }],
                        details: {
                            command: output.command,
                            output: JSON.parse(text),
                        },
                        ...(output.ok ? {} : { isError: true }),
                    }, output, {
                        toolName: spec.name,
                        preserveArgs: Object.keys(args),
                        recovery: mavisRecoveryInstruction(spec.command, undefined, false, spec.name),
                    });
                    // The same rule the composite mavis executor applies: a coordinator's
                    // successful space context write with end_turn ends the Turn, so
                    // writing context.md after the answer needs no closing reply.
                    return isCoordinatorAgent(ctx.coordination) &&
                        output.ok &&
                        endsTurnAfterWrite(spec.command, args)
                        ? endTurn(result)
                        : result;
                },
            },
        };
    });
}
let cachedSchemas;
/** The operation's zod schema as JSON Schema, with one line per argument. */
function toolSchema(spec) {
    cachedSchemas ??= new Map(BUNNY_SPACE_TOOL_SPECS.map((entry) => [
        entry.name,
        describeProperties(zodToJsonSchema(BUNNY_MAVIS_COMMAND_SCHEMAS[entry.command]), entry.name, entry.fields),
    ]));
    return cachedSchemas.get(spec.name);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=local-bunny-space-tools.js.map