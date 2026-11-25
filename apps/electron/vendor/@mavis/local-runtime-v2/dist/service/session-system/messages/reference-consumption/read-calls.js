/**
 * Recognise the calls that read a session's messages, and decide which of them
 * targeted the referenced session.
 *
 * Five paths count, because the Bunny prompt allows more than one: the
 * `session_messages` tool under its own name (top level or inside `run_code`),
 * and the same tool reached through `mcp_invoke` on a turn that has no run_code
 * path to it. `mavis_session_messages` and the `mavis` tool's
 * `session messages` command are the names earlier turns were recorded under;
 * both stay recognised so persisted history still reads as consumption. The shell
 * and run_code-source paths are bounded fallbacks: they only match when the text
 * also names the target session, so a missing child record degrades to evidence
 * rather than to a false negative.
 */
import { isRecord, parseJsonValue, readString } from './values.js';
/**
 * The tools whose whole job is reading a session's messages. The legacy PTC
 * child name stays in the list so turns recorded before the namespace split
 * still read as consumption.
 */
const MESSAGE_READ_TOOLS = ['session_messages', 'mavis_session_messages'];
const MAVIS_TOOL = 'mavis';
const MCP_INVOKE_TOOL = 'mcp_invoke';
const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'run_shell']);
const RUN_CODE_TOOL = 'run_code';
const SESSION_MESSAGES_COMMAND = /session\s+messages/u;
const CLI_SESSION_MESSAGES = /\bmavis\s+session\s+messages\b|\bmcode\b[^\n]*\bsession\s+messages\b/u;
/** Bounds for the walks over tool payloads; results can carry whole histories. */
const MAX_WALK_DEPTH = 6;
const MAX_WALK_NODES = 20_000;
/** The read call this record represents, or nothing when it reads no messages. */
export function observeReadCall(call, target, options) {
    const matchedBy = readCallMatch(call);
    if (!matchedBy)
        return [];
    const sessionIdArg = readSessionIdArg(call, matchedBy);
    const resolvedSessionId = resolveSessionId(sessionIdArg, options.currentSessionId);
    const searchText = readSearchText(call, matchedBy);
    return [
        {
            toolName: call.toolName,
            ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
            ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
            fromPtcChild: call.fromPtcChild,
            matchedBy,
            ...(sessionIdArg ? { sessionIdArg } : {}),
            ...(resolvedSessionId ? { resolvedSessionId } : {}),
            ...(searchText ? { searchText } : {}),
            resolution: readResolution(matchedBy, resolvedSessionId),
            outcome: call.outcome,
            matchedMessageIds: matchMessageIds(call, target),
        },
    ];
}
/** Whether this read call went after the referenced session or quoted message. */
export function matchesTarget(call, target) {
    if (target.sessionId && matchesSession(call, target.sessionId))
        return true;
    return (target.messageIds?.length ?? 0) > 0 && call.matchedMessageIds.length > 0;
}
function matchesSession(call, sessionId) {
    if (call.resolvedSessionId === sessionId)
        return true;
    // A shell command or run_code body naming the session is direct evidence.
    if (call.resolution !== 'not_addressable')
        return false;
    return call.searchText?.includes(sessionId) === true;
}
function readCallMatch(call) {
    if (MESSAGE_READ_TOOLS.includes(call.toolName))
        return 'session_messages_tool';
    if (call.toolName === MCP_INVOKE_TOOL)
        return matchMcpInvoke(call.args);
    if (call.toolName === MAVIS_TOOL)
        return matchMavisTool(call.args);
    if (SHELL_TOOLS.has(call.toolName))
        return matchShellTool(call.args);
    if (call.toolName === RUN_CODE_TOOL)
        return matchRunCode(call.args);
    return undefined;
}
/**
 * A turn with no run_code path to `session_messages` reaches it through the
 * `mcp_invoke` gateway, where the record's own name is the gateway and the read
 * tool sits in `tool_name`. Without this the call is invisible and the probe
 * under-counts consumption on exactly those turns.
 */
function matchMcpInvoke(args) {
    if (!isRecord(args))
        return undefined;
    const target = readString(args.tool_name);
    return target && MESSAGE_READ_TOOLS.includes(target) ? 'session_messages_tool' : undefined;
}
function matchMavisTool(args) {
    const command = readString(isRecord(args) ? args.command : undefined);
    if (command && SESSION_MESSAGES_COMMAND.test(command))
        return 'mavis_command';
    return undefined;
}
function matchShellTool(args) {
    const command = readCommandText(args);
    if (command && CLI_SESSION_MESSAGES.test(command))
        return 'shell_command';
    return undefined;
}
function matchRunCode(args) {
    const source = readCommandText(args);
    if (source && MESSAGE_READ_TOOLS.some((name) => source.includes(name)))
        return 'run_code_source';
    return undefined;
}
/** Both spellings the tools use for the session a read addresses. */
function readSessionIdField(args) {
    return readString(args.session_id) ?? readString(args.sessionId);
}
/**
 * `mcp_invoke` carries the target's arguments in `arguments`, or encoded as
 * `arguments_json` when exact types have to survive the gateway.
 */
function readGatewayTargetArgs(args) {
    const target = isRecord(args.arguments)
        ? args.arguments
        : parseJsonValue(readString(args.arguments_json));
    return isRecord(target) ? target : undefined;
}
/** The shell and run_code-source paths match on text, so they address no session. */
function addressesNoSession(matchedBy) {
    return matchedBy === 'shell_command' || matchedBy === 'run_code_source';
}
function readSessionIdArg(call, matchedBy) {
    if (addressesNoSession(matchedBy))
        return undefined;
    const args = isRecord(call.args) ? call.args : undefined;
    if (!args)
        return undefined;
    const direct = readSessionIdField(args);
    if (direct)
        return direct;
    // The `mavis` tool nests its command arguments one level down.
    const inner = isRecord(args.args) ? args.args : undefined;
    if (inner)
        return readSessionIdField(inner);
    if (call.toolName !== MCP_INVOKE_TOOL)
        return undefined;
    const target = readGatewayTargetArgs(args);
    return target ? readSessionIdField(target) : undefined;
}
function resolveSessionId(sessionIdArg, currentSessionId) {
    if (!sessionIdArg)
        return undefined;
    if (sessionIdArg !== 'me')
        return sessionIdArg;
    return currentSessionId;
}
function readResolution(matchedBy, resolvedSessionId) {
    if (matchedBy === 'shell_command' || matchedBy === 'run_code_source')
        return 'not_addressable';
    return resolvedSessionId ? 'resolved' : 'alias_unresolved';
}
function readCommandText(args) {
    if (!isRecord(args))
        return undefined;
    return readString(args.command) ?? readString(args.code) ?? readString(args.source);
}
function readSearchText(call, matchedBy) {
    if (matchedBy !== 'shell_command' && matchedBy !== 'run_code_source')
        return undefined;
    return readCommandText(call.args);
}
function matchMessageIds(call, target) {
    const ids = target.messageIds ?? [];
    if (ids.length === 0)
        return [];
    const budget = { nodes: MAX_WALK_NODES };
    return ids.filter((id) => containsValue(call.args, id, 0, budget) || containsValue(call.result, id, 0, budget));
}
function containsValue(value, needle, depth, budget) {
    if (depth > MAX_WALK_DEPTH || budget.nodes <= 0)
        return false;
    if (typeof value === 'string')
        return value.includes(needle);
    if (value === null || typeof value !== 'object')
        return false;
    budget.nodes -= 1;
    const children = Array.isArray(value) ? value : Object.values(value);
    return children.some((item) => containsValue(item, needle, depth + 1, budget));
}
//# sourceMappingURL=read-calls.js.map