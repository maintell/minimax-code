import { LocalMavisToolDef } from '@mavis/agent-tools/namespaced-tools';
import { createPtcMavisTools } from '@mavis/agent-tools/ptc';
import { registerPtcNativeCatalog, registerPtcTurnReminder } from '../../execution/ptc/catalog.js';
import { isPtcChildTool, isPtcDirectTool, logPtcOnDemandTools, splitPtcOnDemandTools, } from '../../runner/policy/local-turn-tool-ptc-policy.js';
import { runCodeMavisRefusalTool } from '../../runner/policy/mavis-moved-refusal.js';
import { coordinatorHiddenToolRefusalTools, ptcMcpInvokeRefusalTool, } from './ptc-unavailable-tools.js';
import { createPtcRunCodeTool, } from '../../runner/ptc/run-code-tool.js';
import { isPtcSaveScriptAllowed, ptcScriptSupport, } from './local-turn-tool-ptc-scripts.js';
export function resolvedTurnCatalog(tools, ptc, options) {
    return ptc
        ? buildPtcCatalog(tools, {
            trustedNativeTools: options.trustedNativeTools,
            input: options.input,
            coordinator: options.coordinator,
            rules: options.rules,
            gates: options.gates,
        })
        : { tools, reminder: '', childTools: [] };
}
/**
 * Absent rules leave the children and the trusted native list untouched, which is
 * what a Host without its own variants (TUI, cloud) saw before.
 */
function withPtcChildVariants(rules, ptcChildren, trustedNativeTools) {
    return (rules?.ptcChildVariants?.(ptcChildren, trustedNativeTools) ?? {
        childTools: ptcChildren,
        trustedNativeTools,
    });
}
/**
 * The Host owns the factory: the tool it returns writes files directly, so the
 * harness reaches it through the script port instead of importing agent-tools'
 * desktop entry, which carries the Node IO behind that write.
 */
function ptcSaveTool(scripts, host) {
    return scripts && host ? host.createSaveTool(scripts.save) : undefined;
}
/**
 * The options run_code is created with on this Turn. Every host field is
 * conditional on what the Turn carries, so an absent one leaves run_code as it
 * was instead of spreading an explicit `undefined` over its default.
 */
function runCodeOptions(facts) {
    const { input, rules, scripts, hiddenChildTools, directToolNames } = facts;
    return {
        workerUrl: input.ptc?.workerUrl,
        unavailableMessage: input.ptc?.unavailableMessage,
        maxComputeMs: input.ptc?.maxComputeMs,
        ...(rules?.runCodeParagraphs ? { runCodeParagraphs: rules.runCodeParagraphs } : {}),
        ...(input.writePtcReturnArtifact ? { writeReturnArtifact: input.writePtcReturnArtifact } : {}),
        ...(input.ptcSessionStore ? { sessionStore: input.ptcSessionStore } : {}),
        ...(hiddenChildTools.length > 0 ? { hiddenChildTools } : {}),
        ...(scripts ? { scriptRoots: scripts.roots } : {}),
        directToolNames,
    };
}
function buildPtcCatalog(tools, options) {
    const { trustedNativeTools, input, coordinator, rules, gates } = options;
    const onDemand = splitPtcOnDemandTools(tools);
    logPtcOnDemandTools(input, onDemand);
    const ptcChildren = onDemand.tools.filter(isPtcChildTool);
    const observable = withPtcChildVariants(rules, ptcChildren, trustedNativeTools);
    const { childTools, directTools } = withPtcMavisTools(observable.childTools, onDemand.tools.filter(isPtcDirectTool), observable.trustedNativeTools, { coordinator, rules });
    // The save tool is a run_code child like any other, so it is listed with them
    // and gated like one: the `tools` allowlist, `disallowedTools`, the model's
    // suppressed names, the canonical role ceiling and the Agent authority rules
    // all decide it, because it never passes through the inventory above.
    const scripts = ptcScriptSupport(input);
    // The Host owns the factory: the tool it returns writes files directly, so the
    // harness reaches it through the script port instead of importing agent-tools'
    // desktop entry, which carries the Node IO behind that write.
    const saveTool = ptcSaveTool(scripts, input.ptcScripts);
    // The Agent and model gate belongs to the Turn catalog, which passes it in;
    // ptc-scripts owns the save tool's two-step decision and takes the gate as an
    // argument, so neither module has to import the other.
    const isSaveScriptAllowedByTurn = gates.isSaveScriptAllowedByTurn;
    const listedChildTools = [
        ...childTools,
        ...(saveTool && isPtcSaveScriptAllowed(saveTool, input.agentProfile, isSaveScriptAllowedByTurn)
            ? [saveTool]
            : []),
    ];
    // A Turn whose catalog carries no `mavis` at all — the Desktop PTC shape,
    // where the composite tool is split into `mavis_*` children and trimmed
    // top-level commands — still answers a legacy `tools.mavis({ command })`
    // call from run_code. The name is neither listed nor enumerable, and the
    // host refusal names the tool that replaced the command and the Skill to
    // load first, instead of QuickJS's "not a function". A Turn that does offer
    // `mavis` (a Host with its own `ptcMavisTools`) keeps its catalog unchanged.
    const hasMavisTool = [...listedChildTools, ...directTools].some((tool) => tool.def.name === LocalMavisToolDef.name);
    // The names a program can still reach although this Turn offers no tool
    // behind them: the legacy `mavis` call, an `mcp_invoke` this Turn has no
    // gateway for, and — for the trusted coordinator — every namespaced tool its
    // allowlist keeps from it. Each answers with what to do instead.
    const hiddenChildTools = [
        ...(hasMavisTool
            ? []
            : [runCodeMavisRefusalTool(input.metricsClient, input.agentProfile?.coordination)]),
        ptcMcpInvokeRefusalTool(),
        ...(coordinator ? coordinatorHiddenToolRefusalTools() : []),
    ];
    // Name the hidden tools so the model does not spend a turn calling one directly
    // (the pilot lost three turns that way). Catalog order matches the run_code SDK.
    const childToolNames = listedChildTools.map((tool) => tool.def.name);
    const reminder = [
        'PTC is enabled for this turn. Use run_code with await tools.<name>(args) for eligible ordinary tools and explicitly return a JSON result. Keep the visible control tools as direct calls. Do not call run_code from inside run_code.',
        ...(childToolNames.length > 0
            ? [
                `These tools are only callable inside run_code in this turn: ${childToolNames.join(', ')}.`,
            ]
            : []),
    ].join(' ');
    // The same string goes into the user prompt prefix and onto run_code, so the
    // executor can put it back verbatim after compaction drops that user message.
    // The long tail is callable but stays out of this list and the run_code SDK:
    // listing it would put back the definitions Tool Search keeps out.
    const runCode = registerPtcNativeCatalog(registerPtcTurnReminder(createPtcRunCodeTool(listedChildTools, runCodeOptions({
        input,
        rules,
        scripts,
        hiddenChildTools,
        // A program calling one of these gets "<name> 只能直接调用" instead of "not a function".
        directToolNames: [
            ...directTools.map((tool) => tool.def.name),
            ...(input.appendedDirectToolNames ?? []),
        ],
    }), observable.trustedNativeTools, onDemand.callable), reminder), tools);
    return { tools: [runCode, ...directTools], reminder, childTools: listedChildTools };
}
/**
 * The Desktop mavis tool on a PTC Turn: run_code lists one mavis_* tool per
 * orchestrable command (createPtcMavisTools) in place of one mavis child, so a
 * program reads each command's own arguments, and the top-level mavis keeps
 * only agent create, session send and their help. Without this the same
 * mavis was listed in both places with every command, and a call in the wrong
 * place was refused only after the model had made it. run_code still runs
 * each call as mavis({ command, args }), so permission rules and Plugin hooks
 * keep matching tool `mavis`. Only the trusted native mavis is split; a Turn
 * without it (TUI, PTC off) keeps its catalog byte for byte.
 *
 * Which commands are flattened is the Host's: `rules.ptcMavisTools` when the
 * Host provides one (cloud splits its own command set), otherwise the Desktop
 * split. Both register their children the same way, so the policy, the SDK and
 * the executor resolve them without knowing which Host built them. The Desktop
 * split takes no coordinator variant: the coordinator's own space and task
 * model operations are standalone top-level tools, not mavis subcommands, so
 * `coordinator` only reaches a Host that asked for it through `ptcMavisTools`.
 */
function withPtcMavisTools(childTools, directTools, trustedNativeTools, facts) {
    const { coordinator, rules } = facts;
    const trusted = new Set(trustedNativeTools);
    const mavis = directTools.find((tool) => tool.def.name === 'mavis' && trusted.has(tool));
    if (!mavis || !childTools.includes(mavis))
        return { childTools, directTools };
    const split = rules?.ptcMavisTools
        ? rules.ptcMavisTools(mavis, { coordinator })
        : createPtcMavisTools(mavis);
    return {
        childTools: childTools.flatMap((tool) => (tool === mavis ? split.children : [tool])),
        directTools: directTools.map((tool) => (tool === mavis ? split.direct : tool)),
    };
}
//# sourceMappingURL=ptc-turn-catalog.js.map