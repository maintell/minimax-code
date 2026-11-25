import { getMcpInvokeRegistries } from '@mavis/agent-tools/mcp-disclosure';
import { BUNNY_SPACE_TOOL_NAMES, PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES, } from '@mavis/agent-tools/namespaced-tools';
import { normalizeMavisCommand, ptcMavisChildToolName, ptcMavisRunCodeCall, readPtcMavisChildTarget, } from '@mavis/agent-tools/ptc';
const PTC_DIRECT_ONLY_TOOL_NAMES = new Set([
    'ask_user',
    // Bunny's user channel: the display projection rewrites its top-level calls,
    // so it can never be a run_code child.
    'send_to_user',
    // Bunny's ledger writes stay top-level calls in history, like its other product writers.
    'working_state',
    // A namespaced tool this Turn promotes out of the deferred registry: it is
    // listed at the top level under its own name and called directly, so neither
    // mcp_invoke nor run_code is the place for it. The Turn's loading plan keeps
    // it inline (inlineOnDemandToolNames), and its Skill gate is unchanged.
    ...PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES,
    // The coordinator's own space and task model tools stay top-level too: they
    // are its always-loaded vocabulary, like its assignment tools' writes.
    ...BUNNY_SPACE_TOOL_NAMES,
    'request_feature_enable',
    // Creates an inline card anchored to the assistant reply; never from inside run_code.
    'request_plugin',
    'EnterPlanMode',
    'ExitPlanMode',
    'create_goal',
    'get_goal',
    'update_goal',
    'skill',
    // Its hits are definitions the model reads before writing the next program,
    // so inside run_code it could only be returned verbatim. Kept top-level like
    // skill, and the Tool Search hint keeps saying "call tool_search" in both modes.
    'tool_search',
    'website_deploy',
    'task',
    'task_append',
    'code_review',
    // Forwards the whole conversation to another model; a program has nothing to pass it.
    'advisor',
    'run_code',
    // Ends the Turn through ToolResult.terminate, which a run_code child cannot pass on.
    'wrap_up',
]);
export function isPtcDirectTool(tool) {
    return PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.def.name) || tool.def.name === 'mavis';
}
/**
 * Known gap, ignored for now: a PTC turn without bash.
 *
 * The run_code child catalog is whatever this Agent enabled, minus the direct
 * tools above, so it has no bash when a user-built (Custom) Agent drops bash
 * from its tool list and the user talks to that Agent directly (PTC
 * follows the Session mode alone, `isPtcTurnEnabled` in
 * packages/config/src/ptc-turn.ts). The run_code description still names bash in such a turn:
 * "Bash commands belong in tools.bash(...)", the tools.bash git status example
 * and "Bash exit codes are in data.exitCode", the timeout_ms / tools.bash
 * sentences of WALL_CLOCK_HINT, the explicit background Bash line, the shell
 * quoting advice, and "shell commands" in PROMISE_ALL_SCHEDULING
 * (runner/ptc/run-code-tool.ts, runCodeDescription). A model may follow them,
 * call tools.bash, get it rejected and spend one more step; nothing breaks.
 * The PTC section (_v2/PTC_TOOL_CALLS.md.hbs) already prints its bash lines
 * only when bash is enabled; the run_code description does not yet.
 *
 * Not handled because it only appears for a Custom Agent without bash in a
 * direct conversation; the built-in Agents (mavis, worker, verifier,
 * explore) and the evals all have bash. The user decided on 2026-10-15 to
 * ignore it for now. To fix it, make those passages in runCodeDescription
 * depend on whether childTools contains bash, keeping the text byte for
 * byte unchanged when it does.
 *
 * Browser (the native `browser` tool and the Plugin-bound `mcp_browser`) is an
 * ordinary child, so an action and the reads that verify it run in one
 * program instead of one model round trip each. Its stateful-page safety
 * stays with the Browser owner: the tool is sequential, the Skill receipt is
 * per session (children inherit the Session), the Browser turn guard refuses
 * the remaining Browser children of a program after a write fails or a call
 * times out (`BROWSER_PTC_STOPPED`; a read that fails does not stop it).
 * `safety.requiredNextTool` is a prompt signal asking for a direct `ask_user`
 * call outside the program.
 *
 * Computer Use (`computer_*`) is an ordinary child for the same reason: a
 * bounded step (find the window, read it, act, read back) is one program.
 * The shared desktop stays safe the same way: the tools declare no
 * executionMode, so the scheduler runs them one at a time even inside
 * Promise.all, and the Computer Use turn guard refuses the remaining
 * Computer Use children of a program after one fails
 * (`COMPUTER_USE_PTC_STOPPED`).
 */
export function isPtcChildTool(tool) {
    return !PTC_DIRECT_ONLY_TOOL_NAMES.has(tool.def.name);
}
export function evaluatePtcChildToolPolicy(input) {
    if (!input.ptcChildTools)
        return undefined;
    const resolved = resolveEffectivePtcTarget(input);
    if (!input.context.parentToolCallId)
        return evaluatePtcDirectToolPolicy(resolved, input.ptcChildTools);
    return evaluatePtcChildTargetPolicy(resolved);
}
function evaluatePtcChildTargetPolicy(resolved) {
    if ((resolved.tool && !isPtcChildTool(resolved.tool)) ||
        PTC_DIRECT_ONLY_TOOL_NAMES.has(resolved.name)) {
        return { block: true, reason: `PTC cannot invoke ${resolved.name} programmatically.` };
    }
    return undefined;
}
function evaluatePtcDirectToolPolicy(resolved, ptcChildTools) {
    if (resolved.name !== 'mavis')
        return undefined;
    // The top-level mavis of a PTC Turn lists only the commands its Host keeps
    // out of run_code; the refusal names the run_code tool the model needs. A
    // command this Turn's run_code has no tool for reaches mavis, which answers
    // it (the coordinator's session interrupt gets the assignment tool to use).
    const child = ptcMavisChildToolForCommand(ptcChildTools, mavisCommand(resolved.args));
    return child
        ? {
            block: true,
            reason: `This mavis command runs inside run_code in a PTC turn: ${ptcMavisRunCodeCall(child)}.`,
        }
        : undefined;
}
/**
 * The run_code tool standing for this mavis command on this Turn, read from the
 * Turn's own child catalog so a Host with its own split (cloud) is answered with
 * its own mavis_* name. Undefined for a top-level command and for a Turn whose
 * run_code lists no tool for it.
 *
 * A Host-built child carries the command it stands for (`createPtcMavisChildTool`),
 * which is what a Host with its own split is answered from. A Desktop-split child
 * is a plain `mavis_*` tool that carries no such binding, so the fixed table
 * names it — still only when this Turn's run_code really lists that tool, so a
 * command the catalog dropped keeps reaching the top-level mavis.
 */
function ptcMavisChildToolForCommand(childTools, command) {
    if (typeof command !== 'string')
        return undefined;
    const normalized = normalizeMavisCommand(command);
    const hosted = childTools.find((tool) => readPtcMavisChildTarget(tool)?.command === normalized);
    if (hosted)
        return hosted.def.name;
    const desktop = ptcMavisChildToolName(normalized);
    return desktop && childTools.some((tool) => tool.def.name === desktop) ? desktop : undefined;
}
function resolveEffectivePtcTarget(input) {
    const tool = input.tools.find((candidate) => candidate.def.name === input.context.toolCall.name);
    return {
        name: input.context.toolCall.name,
        args: input.context.args,
        ...(tool ? { tool } : {}),
    };
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function mavisCommand(value) {
    return recordValue(value).command;
}
/**
 * Tool Search's result decides the long tail; no PTC-specific rule is added.
 * After buildToolLoadingCatalog the mcp_invoke name registry holds exactly
 * this Turn's deferred tools: MCP and App tools plus on-demand built-ins (cron_*).
 * Inside a program a name-routed gateway is a needless hop, so every target
 * that is an ordinary PTC child becomes a run_code child of its own, with its
 * own schema, permission source and hooks. The gateway itself never survives a
 * PTC Turn, whatever it still holds: a name the Turn keeps at the top level, or
 * one a listed tool already answers, is dropped and counted; a Plugin Skill
 * `tool_ref` is published under the target's own name instead
 * (`HostCapabilityRegistry.prepare`, `ptc`), so no reference is left to route.
 *
 * Tool loading attaches an empty gateway to every Turn and a Host may reserve
 * one of its own (Desktop). Keeping either made the run_code SDK and the child
 * list carry a name no call can reach, and made that list change mid-window as
 * soon as a slow MCP server showed up.
 */
export function splitPtcOnDemandTools(tools) {
    const gateway = tools.find((tool) => tool.def.name === 'mcp_invoke');
    const registries = gateway ? getMcpInvokeRegistries(gateway) : undefined;
    if (!gateway || !registries) {
        return { tools, callable: [], droppedDirectTargets: 0, nameConflicts: 0 };
    }
    const listedNames = new Set(tools.filter((tool) => tool !== gateway).map((tool) => tool.def.name));
    const { callable, droppedDirectTargets, nameConflicts } = partitionGatewayTargets(registries.registry, listedNames);
    // The gateway never survives a PTC Turn: what it used to route is either a
    // run_code child now, or a name this Turn answers another way.
    return {
        tools: tools.filter((tool) => tool !== gateway),
        callable,
        droppedDirectTargets,
        nameConflicts,
    };
}
function partitionGatewayTargets(registry, listedNames) {
    const callable = [];
    let droppedDirectTargets = 0;
    let nameConflicts = 0;
    for (const target of registry.values()) {
        if (isPtcDirectTool(target)) {
            // A PTC Turn calls a top-level tool by its own name, so a deferred tool
            // carrying one of those names is an impostor (a configured tool named
            // `website_deploy`). It is dropped rather than kept behind a gateway:
            // the real tool already answers the name, and an unroutable second entry
            // only invites the model to call it.
            droppedDirectTargets += 1;
        }
        else if (listedNames.has(target.def.name)) {
            // run_code exposes one function per name; a second one would break the
            // guest setup, and the listed tool already answers that name.
            nameConflicts += 1;
        }
        else {
            callable.push(target);
        }
    }
    return { callable, droppedDirectTargets, nameConflicts };
}
/** Counts and booleans only: no tool names, arguments or schemas. */
export function logPtcOnDemandTools(input, split) {
    try {
        input.logger?.info?.({
            session_id: input.sessionId,
            callable_mcp_tools: split.callable.filter((tool) => tool.source === 'configured').length,
            callable_builtin_tools: split.callable.filter((tool) => tool.source !== 'configured')
                .length,
            ...(split.droppedDirectTargets > 0
                ? { dropped_direct_targets: split.droppedDirectTargets }
                : {}),
            ...(split.nameConflicts > 0 ? { name_conflicts: split.nameConflicts } : {}),
        }, 'ptc on-demand tools resolved');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
//# sourceMappingURL=local-turn-tool-ptc-policy.js.map