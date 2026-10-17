/**
 * `mavis agent ...` 命令组 —— 5 个 handler 一一映射到 archon-server agents CRUD。
 *
 * 字段映射:
 *   - LLM args 中的 `agent_id` 是 string(从 Response 出口 `coerceI64IdFields`
 *     转换的形态);archon-server IDL `agent_id` / `template_id` 是 `i64`(默认
 *     json tag,无 `,string`),hertz hbinding 严格 reject 引号字符串。callRpc
 *     前用 `Number(...)` 显式转换;当前 snowflake ID ≤ 49 bits 在
 *     Number.MAX_SAFE_INTEGER 内不丢精度。
 *   - `creation_source` 走 `AgentCreationSource` 枚举映射 string → int wire
 *   - `agent_data` / `agent_data_patch` 是 archon-biz schema 域,archon-server
 *     不感知字段语义,LLM 给 raw JSON string 即可
 */
import { AgentCreationSource } from '../../runtime-types.js';
import { HostToolCapability } from '@mavis/protocol';
import { archonBusinessFailure, failure, success } from '../output.js';
import { baseRespOrSuccess } from './types.js';
/**
 * 新 agent 默认开放的 capability 集合 —— `agent create` 链路在用户没显式声明
 * `tools[]` 时下发这四个 capability,等同覆盖 daemon 主链路同源的"开箱即用"
 * 工具面:
 *   - SHELL: bash / grep / glob
 *   - FILE : read / write / edit
 *   - WEB  : web_fetch / web_search(matrix-tools 代理)
 *   - BASE : skill / todowrite / task / secret
 *
 * 不默认开放的:
 *   - MAVIS_BASE: archon-server 管理 RPC(mavis/team/communicate),按需开
 *   - MEMORY    : memory_* 四件套,按需开
 *   - OTHER     : matrix-tools 媒体生成类,按需开
 *
 * 序列化形态:archon-biz 的 agent_data 是 JSON string envelope,反序列化后映射
 * 到 IAgentConfig.tools(IToolConfig[])。`capability` 走 thrift int enum
 * (SHELL=1 / FILE=3 / WEB=5 / BASE=7),JSON 形态保持 int —— 如果 archon-biz
 * 端 JsonUnmarshal 改成 string-name 形式(`"SHELL"`),这里要同步切换。
 */
const DEFAULT_AGENT_TOOL_CAPABILITIES = [
    HostToolCapability.SHELL,
    HostToolCapability.FILE,
    HostToolCapability.WEB,
    HostToolCapability.BASE,
];
function buildDefaultAgentTools() {
    return DEFAULT_AGENT_TOOL_CAPABILITIES.map((capability) => ({ capability }));
}
/**
 * `Mavis` 是当前 cloud-runtime 部署对外暴露的 agent 名,即"自己"。任何
 * agent CRUD 链路上都不允许 LLM 看到或改成这个名字 —— 否则 agent 会:
 *   1. 通过 `agent list` 把自己当成可调度的 peer 推荐给用户
 *   2. 通过 `agent update` 把另一个 agent 改名成 Mavis,跟自己撞名,
 *      下游 `agent_name` lookup(GetAgent / spawn)直接歧义
 *
 * 用 trim 后大小写敏感比较 —— display_name 历史数据里有 `'Mavis '`
 * (LLM 拼字符串常带尾空格)的样本,要一并 reject。大小写敏感是因为
 * `Mavis` 这条产品名约定就是全小写,大小写不同的 agent name 视为合法的
 * 不同 agent,不强制保留。
 */
export const RESERVED_AGENT_NAME = 'Mavis';
export function isReservedAgentName(name) {
    if (!name)
        return false;
    return name.trim() === RESERVED_AGENT_NAME;
}
export const handleAgentList = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('ListAgent', { page: { cursor: args.cursor, limit: args.limit } }, signal);
    // 过滤掉名字撞 `Mavis` 的 agent(就是自己)—— archon-server ListAgent
    // 是用户全量列表,会带上当前 cloud-runtime 自身那条记录,LLM 不应该把
    // 自己当成可调度的 peer。同时把 `Mavis `(尾空格)样本也清掉,避免
    // LLM 借此绕过过滤。filter 只在响应侧做,不影响分页 cursor 语义 ——
    // cursor 仍由 archon-server 按全量行号生成,我们只是在客户端隐藏。
    const filteredAgents = Array.isArray(resp.agents)
        ? resp.agents.filter((a) => !isReservedAgentName(a?.display_name))
        : resp.agents;
    const filteredResp = filteredAgents === resp.agents ? resp : { ...resp, agents: filteredAgents };
    return success(ctx.command, filteredResp);
};
export const handleAgentGet = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('GetAgent', { agent_id: args.agent_id }, signal);
    if (resp.base_resp && resp.base_resp.status_code !== 0) {
        return archonBusinessFailure(ctx.command, resp.base_resp, '/api/v1/agents/get');
    }
    if (!resp.agent) {
        return failure(ctx.command, 'archon_server', 'agent not found', { agent_id: args.agent_id });
    }
    return success(ctx.command, resp);
};
export const handleAgentCreate = async (ctx, args, signal) => {
    // LLM 看到的是扁平的 system_prompt / persona;archon-server 那侧用单一
    // `agent_data` JSON 信封承载 archon-biz 字段。两端都没有的字段不写进
    // payload,避免空字符串覆盖默认值。`tools` 默认下发 SHELL/FILE/WEB/BASE
    // 四个 capability —— 现在 agentCreateSchema 不暴露 tools,所以一律走默认值,
    // 后续接入用户自定义入口后改成"args 显式给就用 args、没给才兜默认"即可。
    const agentDataPayload = {};
    if (args.system_prompt)
        agentDataPayload.system_prompt = args.system_prompt;
    if (args.persona)
        agentDataPayload.persona = args.persona;
    agentDataPayload.tools = buildDefaultAgentTools();
    const agentData = JSON.stringify(agentDataPayload);
    const resp = await ctx.archonServer.callRpc('CreateAgent', {
        display_name: args.name,
        agent_data: agentData,
        ...(args.description ? { description: args.description } : {}),
        ...(args.avatar ? { avatar: args.avatar } : {}),
        creation_source: AgentCreationSource.Manual,
    }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/agents/create');
};
export const handleAgentUpdate = async (ctx, args, signal) => {
    // reserved-name guard:trim 后撞 Mavis 的改名请求一律拒掉(参见
    // RESERVED_AGENT_NAME 的注释)。本地短路返回结构化失败,不发 RPC,
    // 避免把脏数据写到 archon-server。kind 用 `validation`(本地参数校验失败,
    // 跟 archon_server 业务错误区分);具体语义放在 message + extra.reason。
    if (isReservedAgentName(args.new_name)) {
        return failure(ctx.command, 'validation', `agent name '${RESERVED_AGENT_NAME}' is reserved and cannot be assigned`, {
            agent_id: args.agent_id,
            requested_name: args.new_name,
            reason: 'reserved_name',
        });
    }
    // 与 create 对称:LLM 扁平字段 → archon-biz `agent_data_patch` 信封。
    // archon-server 把 `agent_data_patch` 当作字段级 merge,只 patch 给出的 key,
    // 没传的字段保留 server 现状,所以这里也只塞用户实际给的字段。
    const agentDataPatch = {};
    if (args.system_prompt !== undefined)
        agentDataPatch.system_prompt = args.system_prompt;
    if (args.persona !== undefined)
        agentDataPatch.persona = args.persona;
    // display_name 经 trim 之后再下发,避免 LLM 顺手在尾部带空格导致跟
    // `Mavis`/其他 agent 形态相近(`'foo '` 跟 `'foo'` 在 ListAgent 看来是
    // 两个 agent,UI 上分辨不出)。
    const displayName = args.new_name !== undefined ? args.new_name.trim() : undefined;
    const resp = await ctx.archonServer.callRpc('UpdateAgent', {
        agent_id: args.agent_id,
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        ...(Object.keys(agentDataPatch).length > 0 ? { agent_data_patch: agentDataPatch } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.avatar !== undefined ? { avatar: args.avatar } : {}),
    }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/agents/update');
};
export const handleAgentDelete = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('DeleteAgent', { agent_id: args.agent_id }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/agents/delete');
};
//# sourceMappingURL=agent.js.map