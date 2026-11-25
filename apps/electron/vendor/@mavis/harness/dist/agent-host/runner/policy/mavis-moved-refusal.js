import { LocalMavisToolDef, mavisCoordinatorRefusal, mavisToolMovedMessage, mavisToolMovedRefusalTool, } from '@mavis/agent-tools/namespaced-tools';
/**
 * A legacy top-level `mavis({ command })` call is answered by a resolver in
 * both tool-call modes, so the refusal reaches the arguments the model sent.
 * The missing-tool message only ever sees a name, which is why it cannot name
 * the tool that replaced the command.
 *
 * A trusted coordinator reads its own refusals instead. The three session
 * commands its assignment tools replaced — `session_create`, `session_send`
 * and `session_interrupt` — answer with that assignment tool, and a command
 * no table maps answers with a moved message whose Skill list drops
 * `session-dispatch`. Neither answer names a tool or a Skill that is hidden
 * from a coordinator's catalog.
 */
export function legacyMavisToolRefusal(toolName, metrics, coordination) {
    return toolName === LocalMavisToolDef.name
        ? mavisToolMovedRefusalTool(LocalMavisToolDef, metrics, coordination)
        : undefined;
}
/**
 * The `mavis` refusal a run_code program reaches on a Turn whose catalog has
 * no `mavis` tool at all.
 *
 * Without it `tools.mavis(...)` is QuickJS's "not a function", which names
 * neither the tool that replaced the command nor the Skill to load first. The
 * same `mavisToolMovedRefusalTool` answers here, so the wording, the
 * coordinator variant and the moved-command counter are the ones every other
 * legacy `mavis` call already gets.
 */
export function runCodeMavisRefusalTool(metrics, coordination) {
    return mavisToolMovedRefusalTool(LocalMavisToolDef, metrics, coordination);
}
/**
 * The model reaching the composite `mavis` tool through the top-level
 * `mcp_invoke` gateway.
 *
 * `mavis` is in no Agent's catalog, so the gateway is the one route left to
 * it, and that route skips the direct-call resolver which answers a legacy
 * `mavis({ command })` call. Every command is refused here, including the ones no
 * migrated tool owns (`agent help`, `cron list`): the tool itself is gone,
 * and a command that still has an answer is no reason to leave a second
 * top-level entry to a tool the model can no longer see.
 *
 * A migrated tool is unaffected: `mcp_invoke({ tool_name: 'session_list' })`
 * arrives under its own name and resolves to that very tool, so the permission
 * gate and the hooks see `session_list` with its own arguments.
 */
export function mcpInvokeMavisRefusal(gatewayInput, coordination) {
    const input = recordValue(gatewayInput);
    if (input.tool_name !== LocalMavisToolDef.name)
        return undefined;
    const command = recordValue(input.arguments).command;
    return mavisCoordinatorRefusal(command, coordination) ?? mavisToolMovedMessage(command);
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=mavis-moved-refusal.js.map