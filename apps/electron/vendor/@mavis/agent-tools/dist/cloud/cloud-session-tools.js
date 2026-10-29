import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { dispatchDofld } from './mavis/dispatcher.js';
import { toToolResult } from './mavis/output.js';
const idString = Type.String({ minLength: 1, description: 'Session id, or "me".' });
const sessionListSchema = Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal('sessions'), Type.Literal('peers')], {
        description: 'Default "sessions". Use "peers" to list reachable peer sessions for communicate.',
    })),
    session_id: Type.Optional(idString),
    agent_name: Type.Optional(Type.String({ description: '(sessions mode) Filter by owning agent. "me" supported.' })),
    parent_session_id: Type.Optional(Type.String({ description: '(sessions mode) Filter by parent session. "me" supported.' })),
    archive_filter: Type.Optional(Type.Union([Type.Literal('Unarchived'), Type.Literal('Archived')], {
        description: '(sessions mode) Defaults to Unarchived.',
    })),
    cursor: Type.Optional(Type.String({ description: '(sessions mode) Pagination cursor.' })),
    limit: Type.Optional(Type.Integer({ minimum: 0, description: '(sessions mode) Page size.' })),
}, { additionalProperties: false });
const sessionGetSchema = Type.Object({ session_id: idString }, { additionalProperties: false });
const sessionUpdateSchema = Type.Object({
    session_id: idString,
    title: Type.Optional(Type.String({ description: 'New title.' })),
    extra_data_json: Type.Optional(Type.String({ description: 'Replace the metadata blob with this JSON string.' })),
    agent_name: Type.Optional(Type.String({ description: 'Re-home the session to another agent (display name).' })),
    archived: Type.Optional(Type.Boolean({ description: 'Archive or unarchive.' })),
}, { additionalProperties: false });
const sessionMessagesSchema = Type.Object({
    session_id: idString,
    limit: Type.Optional(Type.Integer({ minimum: 0, description: 'Page size. Defaults to 20.' })),
    before: Type.Optional(Type.String({ description: 'Opaque cursor from the previous page.' })),
}, { additionalProperties: false });
export const CLOUD_SESSION_TOOL_NAMES = [
    'session_list',
    'session_get',
    'session_update',
    'session_messages',
];
const SESSION_TOOL_DEFS = [
    {
        name: 'session_list',
        loading: 'on_demand',
        description: 'List sessions for an agent, or reachable peer sessions. ' +
            'sessions mode (default): filter by agent_name, parent_session_id, archive_filter, cursor, limit. ' +
            'peers mode: pass mode "peers" and session_id ("me" for the current session).',
        schema: sessionListSchema,
        command: 'session list',
    },
    {
        name: 'session_get',
        loading: 'on_demand',
        description: 'Fetch one session by id. session_id "me" means the current session.',
        schema: sessionGetSchema,
        command: 'session get',
    },
    {
        name: 'session_update',
        loading: 'on_demand',
        description: 'Patch session metadata the Cloud backend already supports: title, extra_data_json, agent_name, archived. ' +
            'Only supplied fields change.',
        schema: sessionUpdateSchema,
        command: 'session update',
    },
    {
        name: 'session_messages',
        loading: 'on_demand',
        description: 'Read recent messages of a session. limit defaults to 20. before is an opaque cursor from the previous page.',
        schema: sessionMessagesSchema,
        command: 'session messages',
    },
];
export function buildCloudSessionTools(deps) {
    return SESSION_TOOL_DEFS.map((def) => defineRuntimeTool({
        name: def.name,
        loading: def.loading,
        description: def.description,
        schema: def.schema,
        execute: async (ctx, input, signal) => {
            const output = await dispatchDofld(cloudSessionDeps(deps, ctx), def.command, input, signal);
            return { ...toToolResult(output, def.name), ...(output.ok ? {} : { isError: true }) };
        },
    }));
}
function cloudSessionDeps(deps, ctx) {
    return {
        ...deps,
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        ...(ctx.reporter ? { reporter: ctx.reporter } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        ...(ctx.parentAgentConfig?.display_name
            ? { agentDisplayName: ctx.parentAgentConfig.display_name }
            : {}),
        ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
    };
}
//# sourceMappingURL=cloud-session-tools.js.map