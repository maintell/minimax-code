/**
 * `mavis communication ...` 命令组 —— Task D real archon-server RPC 实现。
 *
 * 三条 handler 全部走 `archonServer.callRpc(...)`,Communicate 路径填
 * `source = CommunicateSource.ToolCall`(LLM 主动触发的 communicate
 * 调用,跟 team-engine 的 `source = TeamEngine` 区分;见 IDL Task A 注释)。
 *
 * 设计要点:
 *   - peers    → `ListPeerSessions { session_id }`,默认用 ctx.sessionId
 *                (兼容 args.session_id 显式覆盖)。response 投影到稳定
 *                `PeerSessionView` shape,跟 `session list mode=peers` 对齐。
 *   - send     → `Communicate { communication_info: {..., source: ToolCall},
 *                harness_base_req: { session_id: ctx.sessionId } }`;失败时
 *                透传服务端 `resp.message` + `error_code`(跟 cloud-communicate
 *                tool 处理一致,业务失败不抛异常)。
 *   - messages → `GetSessionMessages { session_id, page.limit }`,默认 limit=20;
 *                **filter** 只保留带 `communication_infos` 非空的消息,让
 *                LLM 拿到的是真正的 communication 历史而不是普通 chat。
 *
 * 失败语义全走 DofldOutput 统一通道(`success` / `failure` /
 * `archonBusinessFailure`),handler 不抛 —— dispatcher top-level catch 兜底
 * 仅在意外异常时触发。
 *
 * 注意:
 *   - ctx.sessionId 在 dispatcher 路径上总是有值(DispatchDeps.sessionId 必填),
 *     handler 仍兜底 validation failure,以防直测路径忘了塞 ctx 字段。
 *   - 当前 mavis dispatcher 不透 bizId(symmetry with cloud-communicate.ts
 *     的 ctx.bizId 是后续优化空间;archon-server 端会从 session 反查 biz);
 *     `harness_base_req` 只填 session_id 与设计文档 §4.4 对齐。
 */
import { CommunicateSource } from '../../runtime-types.js';
import { failure, success } from '../output.js';
/**
 * `mavis communication peers` —— ListPeerSessions 真实路径。
 *
 * args.session_id 缺省时回退到 ctx.sessionId(LLM 通常省略,问的就是 "我能
 * 联系谁");两个都缺失时 → validation failure 让模型自我纠正(不抛异常)。
 */
export const handleCommunicationPeers = async (ctx, args, signal) => {
    const sessionId = args.session_id ?? ctx.sessionId;
    if (!sessionId) {
        return failure(ctx.command, 'validation', 'communication peers requires session_id (and ctx has no current session)');
    }
    const resp = await ctx.archonServer.callRpc('ListPeerSessions', { session_id: sessionId }, signal);
    return success(ctx.command, projectPeers(resp));
};
/**
 * `mavis communication send` —— Communicate RPC 真实路径,带
 * `source = CommunicateSource.ToolCall`。
 *
 * 字段装配跟 cloud-communicate.ts(顶层 communicate tool)对齐:caller_chain
 * 暂传空数组,archon-server 端在 INJECT 链路上自填 + 防 loop;biz_id 暂不带
 * (mavis dispatcher 不透 ctx.bizId,服务端从 session 反查)。
 *
 * 失败(`resp.ok === false`)按 `archon_server` failure 透传服务端 message,
 * 不抛异常打断 LLM turn —— 模型可以根据 error_code 决定下一步(retry / 改
 * target / 给用户报错)。
 */
export const handleCommunicationSend = async (ctx, args, signal) => {
    const fromSession = ctx.sessionId;
    if (!fromSession) {
        return failure(ctx.command, 'validation', 'communication send requires ctx.sessionId (caller session) to be set');
    }
    // schema 已经保证 to / content 非空;再加一道 self-target 校验,跟
    // cloud-communicate.ts 行为一致(避免 caller_chain 立刻死循环)。
    if (args.to === fromSession) {
        return failure(ctx.command, 'validation', `cannot communicate with self (to=${args.to} is the current session)`, { to: args.to, from: fromSession });
    }
    const resp = await ctx.archonServer.callRpc('Communicate', {
        communication_info: {
            from_session: fromSession,
            to_session: args.to,
            command: args.command ?? 'prompt',
            content: args.content,
            caller_chain: [],
            source: CommunicateSource.ToolCall,
        },
        // archon-server `Communicate` 的 from_session 真值源(防 caller 伪造)。
        // user_id / biz_id 走 X-Archon-* HTTP header(adapter 注入)。
        session_id: fromSession,
    }, signal);
    if (!resp.ok) {
        return failure(ctx.command, 'archon_server', resp.message, {
            to: args.to,
            from: fromSession,
            ...(resp.error_code !== undefined ? { error_code: resp.error_code } : {}),
            ...(resp.details_json !== undefined ? { details_json: resp.details_json } : {}),
            path: '/archon/internal/api/v1/harness/communicate',
        });
    }
    return success(ctx.command, {
        status: 'delivered',
        to: args.to,
        from: fromSession,
        message: resp.message,
        ...(resp.details_json !== undefined ? { details_json: resp.details_json } : {}),
    });
};
/**
 * `mavis communication messages` —— GetSessionMessages 真实路径,只回传
 * 带 `communication_infos` 非空的消息(communication-only filter)。
 *
 * args.to / args.from 至少必填其一(schema 已 refine);两者都传时优先
 * 用 to(`args.to ?? args.from`)。limit 缺省 20,跟 daemon CLI default
 * + handleSessionMessages 一致。
 *
 * 过滤后保持原 message shape 透传给模型,**不**重塑
 * 字段 —— `communication_infos` 元素 entry 由模型/UI 自行渲染。
 */
export const handleCommunicationMessages = async (ctx, args, signal) => {
    const sessionId = args.to ?? args.from;
    if (!sessionId) {
        // schema refine 应该已经挡住,这里再做一道防御 —— 直测路径或上游 zod
        // version 漂移时不至于抛 undefined。
        return failure(ctx.command, 'validation', 'communication messages requires either `to` or `from`');
    }
    const limit = args.limit ?? 20;
    const resp = await ctx.archonServer.callRpc('GetSessionMessages', { session_id: sessionId, page: { limit } }, signal);
    if (resp.base_resp && resp.base_resp.status_code !== 0) {
        return failure(ctx.command, 'archon_server', resp.base_resp.status_msg ?? 'unknown', {
            session_id: sessionId,
            status_code: resp.base_resp.status_code,
            path: '/api/v1/sessions/messages/get',
        });
    }
    const allMessages = (resp.messages ?? []);
    const messages = allMessages.filter(hasCommunicationInfos);
    return success(ctx.command, {
        session_id: sessionId,
        limit,
        messages,
        total: allMessages.length,
        filtered_out: allMessages.length - messages.length,
        ...(resp.has_more !== undefined ? { has_more: resp.has_more } : {}),
        ...(resp.next_cursor !== undefined ? { next_cursor: resp.next_cursor } : {}),
    });
};
function projectPeers(resp) {
    return {
        peers: (resp.sessions ?? []).map(projectPeerSession),
    };
}
function projectPeerSession(session) {
    return {
        session_id: session.session_id,
        ...(session.parent_session_id !== undefined
            ? { parent_session_id: session.parent_session_id }
            : {}),
        agent_id: session.agent_id,
        ...(session.title !== undefined ? { title: session.title } : {}),
    };
}
function hasCommunicationInfos(msg) {
    return Array.isArray(msg.communication_infos) && msg.communication_infos.length > 0;
}
//# sourceMappingURL=communication.js.map