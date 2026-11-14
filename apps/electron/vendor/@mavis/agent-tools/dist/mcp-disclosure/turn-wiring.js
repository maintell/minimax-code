import { modelInWhitelist } from './plan.js';
import { readToolSearchTurnFacts } from './turn-facts.js';
import { commitToolSearchWindow, recordDiscoveredTools, toolSearchWindowOf, } from './session-state.js';
/**
 * Session-level Tool Search wiring for one catalog build: the Session's prefix
 * window (`ToolSearchWindow`: declarations frozen until the next compaction,
 * changes announced in the next user message), discovered-tool tracking for
 * carry-over, and the diagnostics `emitDiagnostic` and the logger receive.
 * A Session's PTC mode only changes at a committed compaction, which also ends
 * the window; a mismatch anyway resets it (`options or model changed`).
 */
export function toolSearchTurnWiring(input, options, ptc) {
    const budgetTokens = ptc ? undefined : options.deferBudgetTokens;
    return {
        mergeInput: {
            window: toolSearchWindowOf(input.sessionId),
            onToolSearch: (_ctx, observation) => {
                if (options.carryAcrossCompaction) {
                    recordDiscoveredTools(input.sessionId, observation.returnedNames);
                }
                logToolSearchObservation(input, observation);
            },
        },
        settle: ({ plan, tools }, model) => {
            if (input.commitWindow !== false) {
                // No window while Tool Search is off for this model: nothing is frozen. The
                // notice needs the Turn's `tool_search` to ride on; without one it waits.
                const text = readToolSearchTurnFacts(tools)?.windowUpdate;
                const notice = text && plan.availability ? { text, availability: plan.availability } : undefined;
                const outcome = plan.window;
                commitToolSearchWindow(input.sessionId, outcome?.window, notice, Date.now(), outcome && outcome.event !== 'continued'
                    ? () => logWindowStart(input, outcome)
                    : undefined);
                logWindowEvents(input, outcome, notice?.availability);
            }
            const diagnostic = {
                sessionId: input.sessionId,
                deferred: plan.deferred,
                whitelisted: modelInWhitelist(model.provider, model.id, options.modelWhitelist),
                model: `${model.provider}/${model.id}`,
                ...(plan.deferred ? plan.stats : {}),
            };
            input.emitDiagnostic?.('mcp.tools_deferred', diagnostic);
            logToolsDeferred(input, diagnostic, options, {
                autoDecision: plan.autoDecision,
                budgetTokens,
                thresholdTokens: plan.thresholdTokens,
            });
        },
    };
}
/** A window the Turn started or reset took effect: its first request was answered. */
function logWindowStart(input, outcome) {
    input.logger?.info?.({
        session_id: input.sessionId,
        inline_candidates: outcome.window.inline.size,
        deferred: outcome.window.deferred.size,
        auto_decision: outcome.window.autoDecision ?? 'none',
    }, 'tool search window started');
}
/** One line per window reset and notice the Turn plans; tool names and counts only. */
function logWindowEvents(input, outcome, notice) {
    const session_id = input.sessionId;
    const lines = [];
    if (outcome?.reset) {
        lines.push([
            {
                session_id,
                reason: outcome.reset.reason,
                count: outcome.reset.tools.length,
                tools: outcome.reset.tools,
            },
            'tool search window reset',
        ]);
    }
    if (notice) {
        lines.push([
            {
                session_id,
                added: notice.added.map((entry) => entry.tool.def.name),
                unavailable: notice.unavailable,
                changed: notice.changed,
                available_again: notice.availableAgain,
            },
            'tool search availability notice',
        ]);
    }
    try {
        for (const [fields, message] of lines)
            input.logger?.info?.(fields, message);
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
/**
 * `emitDiagnostic` is not wired in production, so Tool Search facts also go to the
 * runtime logger: counts, flags and tool names only, never arguments or queries.
 */
function logToolsDeferred(input, diagnostic, options, decision) {
    try {
        const { sessionId, ...fields } = diagnostic;
        input.logger?.info?.({
            session_id: sessionId,
            ...fields,
            auto_decision: decision.autoDecision ?? 'none',
            catalog: options.catalog === true,
            exact_select: options.exactSelect === true,
            direct_call: options.directCall === true,
            defer_budget_tokens: decision.budgetTokens ?? null,
            threshold_tokens: decision.thresholdTokens ?? null,
            carry_across_compaction: options.carryAcrossCompaction === true,
        }, 'mcp tools deferred');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
function logToolSearchObservation(input, observation) {
    try {
        input.logger?.info?.({
            session_id: input.sessionId,
            mode: observation.mode,
            total: observation.total,
            returned: observation.returnedNames.length,
            not_found: observation.notFoundCount,
            zero_hit: observation.total === 0,
        }, 'tool search result');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
//# sourceMappingURL=turn-wiring.js.map