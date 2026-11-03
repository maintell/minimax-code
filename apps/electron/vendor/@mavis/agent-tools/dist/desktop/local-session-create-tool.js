import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { sessionCommandErrorKind } from './local-mavis.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
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
        location: Type.Optional(Type.Object({
            mode: Type.Union([
                Type.Literal('current'),
                Type.Literal('new_worktree'),
                Type.Literal('existing_worktree'),
            ], {
                description: 'current: work in the workspace itself. new_worktree: git worktree add from the workspace repository. existing_worktree: work in worktree_dir.',
            }),
            branch: Type.Optional(Type.String({
                description: 'new_worktree only. New branch name. Omit to generate one.',
            })),
            base: Type.Optional(Type.String({ description: 'new_worktree only. Start point ref. Omit for HEAD.' })),
            worktree_dir: Type.Optional(Type.String({
                description: 'existing_worktree only, required. Absolute worktree path.',
            })),
        }, {
            description: 'Where the new session works. Omit to work in the workspace itself. Use a worktree only when the user asks for one; the workspace must be a git repository.',
        })),
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
            const location = readLocation(input.location);
            if (typeof location === 'string')
                return failure('SESSION_CREATE_INVALID_LOCATION', location);
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
                    ...(location ? { location } : {}),
                    ...(input.model ? { model: input.model } : {}),
                }, signal);
                return ok({
                    session_id: created.sessionId,
                    agent_name: created.agentName,
                    turn: { turn_id: created.turnId, mode: created.mode },
                    location: {
                        mode: RESULT_LOCATION_MODE[created.location.mode],
                        workspace_dir: created.location.workspaceDir,
                        ...(created.location.branch ? { branch: created.location.branch } : {}),
                    },
                });
            }
            catch (error) {
                return failureFromError(error);
            }
        },
    });
}
const RESULT_LOCATION_MODE = {
    current: 'current',
    'new-worktree': 'new_worktree',
    'existing-worktree': 'existing_worktree',
};
/** Returns the adapter location, or the message naming the field combination it rejects. */
function readLocation(input) {
    if (!input)
        return undefined;
    const branch = input.branch?.trim();
    const base = input.base?.trim();
    const worktreeDir = input.worktree_dir?.trim();
    if (input.mode === 'current') {
        return branch || base || worktreeDir
            ? 'location.mode=current 不接受其他字段'
            : { mode: 'current' };
    }
    if (input.mode === 'new_worktree') {
        if (worktreeDir)
            return 'location.worktree_dir 只用于 existing_worktree';
        return {
            mode: 'new-worktree',
            ...(branch ? { branch } : {}),
            ...(base ? { base } : {}),
        };
    }
    if (branch || base)
        return 'location.branch 和 location.base 只用于 new_worktree';
    if (!worktreeDir)
        return 'location.mode=existing_worktree 需要 worktree_dir';
    return { mode: 'existing-worktree', worktreeDir };
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
    const body = { ok: true, ...result };
    const text = JSON.stringify(body);
    // The whole result object is the text; nothing is cut.
    return withDesktopCompletenessReport(SessionCreateToolDef.name, { tool_name: SessionCreateToolDef.name, text, content: [{ type: 'text', text }] }, { data: body });
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
        // PTC failures keep only the outcome; the reason is r.error.
        programmatic: { data: { ok: false } },
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