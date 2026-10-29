import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { sessionCommandErrorKind } from './local-mavis.js';
export const SessionCreateToolDef = {
    name: 'session_create',
    loading: 'on_demand',
    description: 'Create a new parallel session and deliver its first message. ' +
        'Call this only when the user explicitly asks for a new session. ' +
        'When the result must come back, say so inside content and name this session: ' +
        'ask the other session to session send the result to this session_id once it is done.',
    schema: Type.Object({
        content: Type.String({ description: 'First message. Empty content is rejected.' }),
        agent_name: Type.Optional(Type.String({
            description: 'Target Agent, or "me" for the current Agent. Omit for the current Agent.',
        })),
        title: Type.Optional(Type.String({ description: 'Session title. Omit to let it be named.' })),
        workspace_dir: Type.Optional(Type.String({ description: 'Absolute workspace path. Omit for the Agent default.' })),
        model: Type.Optional(Type.String({ description: 'Model key as <provider>/<model>. Omit for the Agent default.' })),
    }),
};
export function buildLocalSessionCreateTool(deps) {
    return defineRuntimeTool({
        ...SessionCreateToolDef,
        execute: async (ctx, input, signal) => {
            if (!ctx.sessionId)
                return failure('SESSION_CREATE_NO_CALLER', '当前没有调用方会话');
            const content = input.content.trim();
            if (!content)
                return failure('SESSION_CREATE_INVALID_CONTENT', 'content 为空');
            const agentName = await resolveAgent(deps.agentAdapter, ctx, input.agent_name, signal);
            if (!agentName)
                return failure('SESSION_CREATE_UNKNOWN_AGENT', '无法解析的 agent_name');
            try {
                const created = await deps.sessionAdapter.createSession({
                    callerSessionId: ctx.sessionId,
                    ...(ctx.turnId ? { callerTurnId: ctx.turnId } : {}),
                    agentName,
                    content,
                    ...(input.title ? { title: input.title } : {}),
                    ...(input.workspace_dir ? { workspaceDir: input.workspace_dir } : {}),
                    ...(input.model ? { model: input.model } : {}),
                }, signal);
                return ok({
                    session_id: created.sessionId,
                    agent_name: created.agentName,
                    turn: { turn_id: created.turnId, mode: created.mode },
                });
            }
            catch (error) {
                return failureFromError(error);
            }
        },
    });
}
async function resolveAgent(agentAdapter, ctx, requested, signal) {
    const name = requested?.trim();
    if (!name || name === 'me')
        return ctx.agentName || undefined;
    try {
        return await agentAdapter.resolveAgentWriteTarget(name, signal);
    }
    catch {
        return undefined;
    }
}
function ok(result) {
    const text = JSON.stringify({ ok: true, ...result });
    return { tool_name: SessionCreateToolDef.name, text, content: [{ type: 'text', text }] };
}
function failure(code, message, extra = {}) {
    const reason = typeof extra.reason === 'string' ? extra.reason : undefined;
    const text = JSON.stringify({
        ok: false,
        command: 'session_create',
        error: { kind: sessionCommandErrorKind(code, reason), code, message, ...extra },
    });
    return {
        tool_name: SessionCreateToolDef.name,
        text,
        content: [{ type: 'text', text }],
        isError: true,
    };
}
function failureFromError(error) {
    if (!(error instanceof Error))
        return failure('SESSION_CREATE_UNEXPECTED_ERROR', String(error));
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : undefined;
    const sessionId = 'sessionId' in error && typeof error.sessionId === 'string' ? error.sessionId : undefined;
    return failure(code ?? 'SESSION_CREATE_UNEXPECTED_ERROR', error.message, {
        ...(reason ? { reason } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
    });
}
//# sourceMappingURL=local-session-create-tool.js.map