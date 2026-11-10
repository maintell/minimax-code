/**
 * `mavis session ...` 命令组 —— list / get / update / messages。模型侧 delete 已移除。
 *
 * 一期不含 abort / search / queue(见 mavis-tool-def
 * description "EXCLUDED"段);后续按需扩。
 *
 * `handleSessionMessages` 暂以 plain (ctx, args) 签名暴露而不是
 * `CommandHandler<typeof sessionMessagesSchema>`,因为对应 zod schema
 * 由后续 schemas.ts 统一注册步骤(A track)落地;handler 在本文件先就位,
 * 注册后 dispatcher 自动绑定。
 */
import { ArchiveFilter, } from '../../runtime-types.js';
import { failure, success } from '../output.js';
import { baseRespOrSuccess } from './types.js';
export const handleSessionList = async (ctx, args, signal) => {
    if (args.mode === 'peers') {
        const resp = await ctx.archonServer.callRpc('ListPeerSessions', { session_id: args.session_id }, signal);
        return success(ctx.command, projectPeerSessions(resp));
    }
    const archiveFilter = args.archive_filter
        ? ArchiveFilter[args.archive_filter]
        : undefined;
    const resp = await ctx.archonServer.callRpc('ListSessions', {
        ...(args.parent_session_id ? { parent_session_id: args.parent_session_id } : {}),
        page: { cursor: args.cursor, limit: args.limit },
        ...(archiveFilter !== undefined ? { archive_filter: archiveFilter } : {}),
        ...(args.agent_id ? { agent_id: args.agent_id } : {}),
    }, signal);
    return success(ctx.command, resp);
};
function projectPeerSessions(resp) {
    return {
        ...(resp.base_resp ? { base_resp: resp.base_resp } : {}),
        sessions: (resp.sessions ?? []).map(projectPeerSession),
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
export const handleSessionGet = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('GetSession', { session_id: args.session_id }, signal);
    if (!resp.session) {
        return failure(ctx.command, 'archon_server', 'session not found', {
            session_id: args.session_id,
            ...(resp.base_resp ? { status_code: resp.base_resp.status_code } : {}),
        });
    }
    return success(ctx.command, resp);
};
export const handleSessionUpdate = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('UpdateSession', {
        session_id: args.session_id,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.extra_data_json !== undefined ? { extra_data_json: args.extra_data_json } : {}),
        ...(args.agent_id ? { agent_id: args.agent_id } : {}),
        ...(args.archived !== undefined ? { archived: args.archived } : {}),
    }, signal);
    return baseRespOrSuccess(ctx.command, resp, '/api/v1/sessions/update');
};
/**
 * `mavis session messages` —— thin wrap archon-server `GetSessionMessages`
 * RPC,返回某 session 最近 N 条消息(按 seq 升序,已 filter `recalled=0`)。
 *
 * - `args.limit` 默认 20(daemon 侧 `mavis session messages --limit 20` 对齐);
 *   archon-server 服务端用 `page.limit` 字段读 limit。
 * - 返回 `{ messages, has_more }`,`messages` 元素跟 daemon 的
 *   `AgentMessageProtocol` 字面对齐(`role` / `msg_type` / `msg_content` /
 *   `timestamp` / `tool_calls` / `thinking_content` / ...)。
 *
 * Track A 在 `schemas.ts` 已注册 `sessionMessagesSchema`,该 schema 字段
 * 集合为 `{ session_id, limit? }`,与本 handler 的 args 形状一致;Dispatcher
 * 透传 zod-parsed args(zod schema 字段是 super-set,handler 取 session_id /
 * limit)。
 *
 * 跟 team engine 端的 `getRecentMessages` 使用同一个 `GetSessionMessages`
 * RPC,这里直接返回完整 `AgentMessageProtocol`,给 LLM consumer 看 session
 * messages 内容。
 */
export async function handleSessionMessages(ctx, args, signal) {
    const limit = args.limit ?? 20;
    const resp = await ctx.archonServer.callRpc('GetSessionMessages', {
        session_id: args.session_id,
        page: { limit },
    }, signal);
    if (resp.base_resp && resp.base_resp.status_code !== 0) {
        return failure(ctx.command, 'archon_server', resp.base_resp.status_msg ?? 'unknown', {
            session_id: args.session_id,
            status_code: resp.base_resp.status_code,
            path: '/api/v1/sessions/messages/get',
        });
    }
    return success(ctx.command, {
        messages: resp.messages ?? [],
        ...(resp.has_more !== undefined ? { has_more: resp.has_more } : {}),
    });
}
//# sourceMappingURL=session.js.map