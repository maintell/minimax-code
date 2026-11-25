import { Type } from '@sinclair/typebox';
import { createPtcMavisChildTool, describeProperties, ptcMavisRunCodeCall, zodToJsonSchema, } from '../../shared/ptc-mavis-child.js';
import { COMMAND_SCHEMAS } from './schemas.js';
/**
 * The cloud mavis tool on a PTC Turn (Programmatic Tool Calling).
 *
 * run_code lists one tool per flattened cloud command instead of one
 * `tools.mavis({ command, args })`, each with that command's own arguments,
 * converted from the zod schema the cloud dispatcher validates with, so the
 * signature a program reads is the one it is checked against. The top-level
 * mavis keeps only agent create and the agent help.
 *
 * The cloud command set is not the Desktop one: there is no session send, no
 * mcp group, no cron and no drive — drive is the standalone `space_*` tool
 * group. Session list, get, update and messages are standalone on-demand tools
 * (`session_*` through tool_search, called inside run_code on a PTC Turn), so
 * they are not flattened here.
 *
 * A mavis_* tool is a name, never an identity: run_code sends each call to the
 * executor as the mavis call it stands for, `mavis({ command, args })`, so
 * permission rules, Plugin hook matchers, history and display keep seeing tool
 * `mavis` with its command. Its own execute only refuses.
 */
/**
 * The run_code tools of a PTC Turn with the cloud mavis tool: one per command,
 * each with that command's own argument schema. Delete commands are flattened
 * too, so a program can batch them; the top-level mavis keeps only the command
 * that creates an Agent, which spawns a new Agent with its root Session.
 */
export const CLOUD_PTC_MAVIS_CHILD_TOOLS = [
    { name: 'mavis_agent_list', command: 'agent list' },
    { name: 'mavis_agent_get', command: 'agent get' },
    { name: 'mavis_agent_update', command: 'agent update' },
    { name: 'mavis_agent_delete', command: 'agent delete' },
];
/** Cloud mavis commands a PTC Turn keeps on the top-level mavis tool. */
export const CLOUD_PTC_MAVIS_DIRECT_COMMANDS = ['agent create', 'agent help'];
const AGENT_NAME = 'Agent display name, or "me" for the current Agent.';
const CURSOR = 'Opaque pagination cursor.';
const LIMIT = 'Non-negative integer page size.';
const DELETE_APPROVAL = 'Use it only after the user explicitly asks for or approves the deletion.';
/** Wording follows the cloud mavis description and the command's help entry. */
const CHILD_SPECS = {
    mavis_agent_list: {
        description: "Search or page through the current user's Mavis agents. Use a row's display name as agent_name.",
        fields: { cursor: CURSOR, limit: LIMIT },
    },
    mavis_agent_get: {
        description: "Read one agent's configuration.",
        fields: { agent_name: AGENT_NAME },
    },
    mavis_agent_update: {
        description: "Patch an agent's identity, persona or system prompt fields.",
        fields: {
            agent_name: AGENT_NAME,
            new_name: 'Replacement display name.',
            system_prompt: 'Agent system prompt.',
            persona: 'Agent persona.',
            description: 'Human-readable description.',
            avatar: 'Avatar URL or asset id.',
        },
    },
    mavis_agent_delete: {
        description: `Delete an agent. ${DELETE_APPROVAL}`,
        fields: { agent_name: AGENT_NAME },
    },
};
let cachedDefinitions;
/** Built once: the schemas are static and the catalog asks on every PTC Turn. */
function cloudPtcMavisChildDefinitions() {
    cachedDefinitions ??= CLOUD_PTC_MAVIS_CHILD_TOOLS.map(({ name, command }) => {
        const spec = CHILD_SPECS[name];
        const schema = describeProperties(zodToJsonSchema(COMMAND_SCHEMAS[command]), name, spec.fields);
        // Plain JSON Schema, no TypeBox Kind: Pi and the Host validators compile it like an MCP schema.
        return { name, command, description: spec.description, schema: schema };
    });
    return cachedDefinitions;
}
/**
 * The top-level mavis description on a PTC Turn. The kept paragraphs are the
 * cloud mavis description's own lines; the list, read, update and delete
 * guidance moved to the mavis_* tool comments, where those calls are made.
 * Session commands are not here at all: they are standalone on-demand tools,
 * and messages go through the standalone `communicate` tool.
 */
const CLOUD_PTC_TOP_LEVEL_DESCRIPTION = `Manage Mavis Agents on behalf of the current user. Use "agent help" for command details and examples.

agent — your roster
  Suggest agent creation or tool setup only after repeated work shows a need, supported by facts from memory; do not promote setup flows.
  Use agent create only after the user explicitly asks for or approves creating an agent.

Listing, reading, updating and deleting agents are run_code tools in this turn: ${ptcMavisRunCodeCall('mavis_agent_list')} and the other mavis_* tools.
Session list, get, update and messages are standalone on-demand tools: search for session_* with the top-level tool_search, then call ${ptcMavisRunCodeCall('session_list')} and the other session_* tools inside run_code. Sending messages to peer sessions uses the standalone \`communicate\` tool.

OUTPUT
  Success: { ok: true, command, response: <archon-server response object> }
  Failure: { ok: false, command, error: { kind: "validation"|"archon_server"|"workspace"|"unknown", message: string, ...details } }
  Help:    { ok: true, command, response: { group, summary, commands: [{ command, summary, args: [...], examples: [...] }] } }

ID fields (node_id, ...) are always JSON strings to preserve snowflake int64 precision — never pass them as numbers.`;
const CLOUD_PTC_TOP_LEVEL_COMMANDS = `Subcommand in "<group> <action>" form:
agent create — Create an agent.
agent help — Show agent command details and examples.`;
const CLOUD_PTC_TOP_LEVEL_ARGS = 'Arguments for the selected command; omit unused fields. Use {} or omit args for help. agent create requires a nonblank name.';
let cachedTopLevelSchema;
/**
 * Same shape as the cloud mavis schema (command plus open args), with only the
 * arguments of agent create, so a kept call validates exactly as before. The
 * dispatcher still enforces the command's own zod schema.
 */
function cloudPtcTopLevelSchema() {
    cachedTopLevelSchema ??= Type.Object({
        command: Type.String({ description: CLOUD_PTC_TOP_LEVEL_COMMANDS }),
        args: Type.Optional(Type.Object({
            name: Type.Optional(Type.String({ description: 'agent create: display name; required and nonblank.' })),
            system_prompt: Type.Optional(Type.String({ description: 'agent create: system prompt.' })),
            persona: Type.Optional(Type.String({ description: 'agent create: persona.' })),
            description: Type.Optional(Type.String({ description: 'agent create: human-readable description.' })),
            avatar: Type.Optional(Type.String({ description: 'agent create: avatar URL or asset id.' })),
        }, { additionalProperties: true, description: CLOUD_PTC_TOP_LEVEL_ARGS })),
    });
    return cachedTopLevelSchema;
}
/** Splits the Turn's cloud mavis tool for a PTC Turn; a PTC-off Turn never calls this. */
export function createCloudPtcMavisTools(mavis) {
    return {
        direct: {
            ...mavis,
            def: {
                ...mavis.def,
                description: CLOUD_PTC_TOP_LEVEL_DESCRIPTION,
                schema: cloudPtcTopLevelSchema(),
            },
        },
        children: cloudPtcMavisChildDefinitions().map((definition) => createPtcMavisChildTool(mavis, definition)),
    };
}
//# sourceMappingURL=ptc.js.map