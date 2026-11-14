import { createMcpInvokeTool, getMcpInvokeRegistries, isPtcMavisDirectCommand, ptcMavisChildToolName, ptcMavisRunCodeCall, resolveMcpInvokeTarget, } from '@mavis/agent-tools';
const PTC_DIRECT_ONLY_TOOL_NAMES = new Set([
    'ask_user',
    // Bunny's user channel: the display projection rewrites its top-level calls,
    // so it can never be a run_code child.
    'send_to_user',
    // Bunny's ledger writes stay top-level calls in history, like its other product writers.
    'working_state',
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
    if (tool.def.name === 'mcp_invoke')
        return hasPtcDirectMcpTarget(tool);
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
 * the remaining Browser children of a program after one fails
 * (`BROWSER_PTC_STOPPED`). `safety.requiredNextTool` is a prompt signal
 * asking for a direct `ask_user` call outside the program.
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
    if (!resolved) {
        return { block: true, reason: 'PTC could not resolve the requested tool in this turn.' };
    }
    if (!input.context.parentToolCallId)
        return evaluatePtcDirectToolPolicy(resolved, input.ptcChildTools);
    return evaluatePtcChildTargetPolicy(resolved);
}
function evaluatePtcChildTargetPolicy(resolved) {
    if ((resolved.tool && !isPtcChildTool(resolved.tool)) ||
        PTC_DIRECT_ONLY_TOOL_NAMES.has(resolved.name) ||
        (resolved.fromMcpInvoke && resolved.name === 'mcp_invoke')) {
        return { block: true, reason: `PTC cannot invoke ${resolved.name} programmatically.` };
    }
    // agent create and session send stay top-level (PTC_MAVIS_DIRECT_COMMANDS);
    // run_code reaches every other command through its mavis_* tool.
    if (resolved.name === 'mavis' && isPtcMavisDirectCommand(mavisCommand(resolved.args))) {
        return { block: true, reason: 'PTC cannot invoke this mavis command programmatically.' };
    }
    return undefined;
}
function evaluatePtcDirectToolPolicy(resolved, ptcChildTools) {
    if (resolved.name === 'mavis') {
        // The top-level mavis of a PTC Turn lists only agent create, session send
        // and their help; the refusal names the run_code tool the model needs. A
        // command this Turn's run_code has no tool for reaches mavis, which answers
        // it (the coordinator's session interrupt gets the assignment tool to use).
        const child = ptcMavisChildToolName(mavisCommand(resolved.args));
        return child && ptcChildTools.some((tool) => tool.def.name === child)
            ? {
                block: true,
                reason: `This mavis command runs inside run_code in a PTC turn: ${ptcMavisRunCodeCall(child)}.`,
            }
            : undefined;
    }
    if (resolved.fromMcpInvoke && isPtcChildTarget(resolved)) {
        return {
            block: true,
            reason: 'This mcp target must be called through run_code in a PTC turn.',
        };
    }
    return undefined;
}
function isPtcChildTarget(resolved) {
    return (resolved.name !== 'mavis' &&
        resolved.name !== 'mcp_invoke' &&
        (!resolved.tool || isPtcChildTool(resolved.tool)));
}
function hasPtcDirectMcpTarget(gateway) {
    const registries = getMcpInvokeRegistries(gateway);
    if (!registries)
        return false;
    const targets = [
        ...registries.registry.values(),
        ...[...registries.referenceRegistry.values()].map((reference) => reference.tool),
    ];
    return targets.some(isPtcDirectMcpTarget);
}
/** An mcp_invoke target that a PTC Turn keeps behind the top-level gateway, never in run_code. */
function isPtcDirectMcpTarget(target) {
    return target.def.name === 'mavis' || !isPtcChildTool(target);
}
function resolveEffectivePtcTarget(input) {
    if (input.originalContext.toolCall.name === 'mcp_invoke') {
        if (input.delegatedTarget) {
            return {
                name: input.delegatedTarget.def.name,
                args: input.context.args,
                tool: input.delegatedTarget,
                fromMcpInvoke: true,
            };
        }
        const gateway = input.tools.find((tool) => tool.def.name === 'mcp_invoke');
        if (!gateway)
            return undefined;
        const resolution = resolveMcpInvokeTarget(gateway, input.originalContext.args);
        return resolution?.kind === 'resolved'
            ? {
                name: resolution.target.def.name,
                args: resolution.arguments,
                tool: resolution.target,
                fromMcpInvoke: true,
            }
            : undefined;
    }
    const tool = input.tools.find((candidate) => candidate.def.name === input.context.toolCall.name);
    return {
        name: input.context.toolCall.name,
        args: input.context.args,
        ...(tool ? { tool } : {}),
        fromMcpInvoke: false,
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
 * own schema, permission source and hooks. mcp_invoke stays only for what it
 * still routes, unchanged: Plugin Skill `tool_ref` references and targets
 * that are not PTC children. With neither, the gateway is removed.
 *
 * Tool loading now attaches an empty gateway to every Turn. When nothing moves
 * (no deferral this Turn) that gateway has no reason on a PTC Turn either and
 * is removed, so run_code gains no `tools.mcp_invoke`. The one exception is
 * the gateway the Host reserves (`reservedByHost`, Desktop): it was on every
 * Desktop Turn before tool loading and stays a run_code child as it was.
 */
export function splitPtcOnDemandTools(tools, reservedByHost) {
    const gateway = tools.find((tool) => tool.def.name === 'mcp_invoke');
    const registries = gateway ? getMcpInvokeRegistries(gateway) : undefined;
    if (!gateway || !registries)
        return { tools, callable: [], nameConflicts: 0 };
    const listedNames = new Set(tools.filter((tool) => tool !== gateway).map((tool) => tool.def.name));
    const { callable, kept, nameConflicts } = partitionGatewayTargets(registries.registry, listedNames);
    const routesSomething = kept.size > 0 || registries.referenceRegistry.size > 0;
    if (callable.length === 0 && (reservedByHost || routesSomething)) {
        return {
            tools,
            callable,
            nameConflicts,
            ...(routesSomething ? {} : { hostReservedOnly: true }),
        };
    }
    const narrowed = narrowedGateway(gateway, kept, registries.referenceRegistry);
    return {
        tools: tools.flatMap((tool) => {
            if (tool !== gateway)
                return [tool];
            return narrowed ? [narrowed] : [];
        }),
        callable,
        nameConflicts,
    };
}
function partitionGatewayTargets(registry, listedNames) {
    const callable = [];
    const kept = new Map();
    let nameConflicts = 0;
    for (const [name, target] of registry) {
        if (isPtcDirectMcpTarget(target)) {
            kept.set(name, target);
        }
        else if (listedNames.has(target.def.name)) {
            // run_code exposes one function per name; a second one would break the
            // guest setup, so this target keeps today's mcp_invoke route.
            kept.set(name, target);
            nameConflicts += 1;
        }
        else {
            callable.push(target);
        }
    }
    return { callable, kept, nameConflicts };
}
/** The gateway for what it still routes, unchanged; undefined when nothing is left. */
function narrowedGateway(gateway, kept, references) {
    if (kept.size === 0 && references.size === 0)
        return undefined;
    return {
        ...createMcpInvokeTool(kept, references),
        ...(gateway.toolCallProvenanceResolver
            ? { toolCallProvenanceResolver: gateway.toolCallProvenanceResolver }
            : {}),
    };
}
/** Counts and booleans only: no tool names, arguments or schemas. */
export function logPtcOnDemandTools(input, split) {
    const gateway = split.tools.find((tool) => tool.def.name === 'mcp_invoke');
    const references = gateway ? getMcpInvokeRegistries(gateway)?.referenceRegistry : undefined;
    try {
        input.logger?.info?.({
            session_id: input.sessionId,
            callable_mcp_tools: split.callable.filter((tool) => tool.source === 'configured').length,
            callable_builtin_tools: split.callable.filter((tool) => tool.source !== 'configured')
                .length,
            mcp_invoke_kept: gateway !== undefined,
            mcp_invoke_tool_ref: (references?.size ?? 0) > 0,
            mcp_invoke_direct_target: gateway ? isPtcDirectTool(gateway) : false,
            ...(split.nameConflicts > 0 ? { name_conflicts: split.nameConflicts } : {}),
            ...(split.hostReservedOnly ? { mcp_invoke_host_reserved: true } : {}),
        }, 'ptc on-demand tools resolved');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
//# sourceMappingURL=local-turn-tool-ptc-policy.js.map