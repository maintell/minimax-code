import { createPtcToolFactCollector, } from '@mavis/agent-core/tools';
import { applyProcessLocalToolResultPolicy } from '../../runner/policy/process-local-tool-result-policy.js';
import { observePtcAdmission } from '../../runner/observability/ptc-admission-observability.js';
import { createPtcToolLabeler, createPtcTurnObserver, } from '../../runner/ptc/ptc-observability.js';
import { isNativeTaskOutputTool, readPtcChildTools, readPtcNativeCatalog, readPtcTurnReminder, registerPtcTurnChildTodoWrite, } from './catalog.js';
import { createPtcChildDisplayPreview } from './child/child-display-preview.js';
import { createPtcCompactionReminderRestorer, } from './compaction-reminder.js';
import { ptcStoredValuesBlock } from './session-store/index.js';
/** The PTC reminder restorer for a Turn; undefined when the Turn has no PTC reminder. */
export function createPtcTurnCompactionReminder(input, options) {
    const store = options.ptcSessionStore;
    return createPtcCompactionReminderRestorer(input.lease.sessionId, readPtcReminderForRestore(input, options.logger), 
    // Production binds this to fitsReminderInFinalRequest, a generic
    // "does this marker still fit the final request" check.
    options.canAppendExecutionBudgetReminder, {
        ...(options.logger ? { logger: options.logger } : {}),
        // Read once per compaction generation, at restore time.
        ...(store ? { storedValues: () => readStoredValues(store, input.lease.sessionId) } : {}),
    });
}
/**
 * The Session's stored-values block for one compaction generation.
 *
 * A Session that still owes a rebuild may be holding keys a rewind is about to
 * drop, so this generation lists none: the block sits after the summary, and a
 * list that changes once the rebuild lands would change the whole prefix
 * behind it. The next compaction reads the filtered list.
 *
 * @internal Exported for focused tests.
 */
export function readStoredValues(store, sessionId) {
    if (store.needsRebuild(sessionId))
        return undefined;
    return ptcStoredValuesBlock(store.index(sessionId));
}
/**
 * buildPtcCatalog registers the reminder on the run_code it creates, and the
 * executor's own PTC wiring (readPtcChildTools) already relies on that object
 * reaching `assembly.tools` unchanged. A PTC Turn without a registered reminder
 * means that chain broke somewhere; say so instead of silently skipping the
 * restore.
 */
function readPtcReminderForRestore(input, logger) {
    const reminder = readPtcTurnReminder(input.assembly.tools);
    if (reminder === undefined && readPtcChildTools(input.assembly.tools) !== undefined) {
        try {
            logger?.warn?.({ session_id: input.lease.sessionId, turn_id: input.lease.turnId }, 'ptc reminder unavailable for compaction restore');
        }
        catch {
            // Diagnostics must not affect the Turn.
        }
    }
    return reminder;
}
export function preparePtcExecution(tools, nativeTools, options, input) {
    const rawPtcTools = readPtcChildTools(tools);
    const ptcTools = rawPtcTools
        ? applyProcessLocalToolResultPolicy(rawPtcTools, options.cliProductPolicy === true)
        : undefined;
    const ptcFactCollector = createPtcToolFactCollector();
    const ptcResultProjection = options.createPtcResultProjection?.(ptcFactCollector);
    // Only PTC Turns get an observer, so only they report program-level metrics.
    const labelTool = createPtcToolLabeler(input.desktopCapabilities?.runtimeToolBindings);
    const ptcObserver = ptcTools ? createTurnObserver(input, options, labelTool) : undefined;
    // Only a PTC Turn has children, so only it shortens a child display copy.
    const childDisplay = childDisplayPreview(input, options, ptcTools, labelTool);
    return {
        ptcTools,
        canConsumeNativeTaskOutput: (ptcTools ?? nativeTools).some(isNativeTaskOutputTool),
        ptcFactCollector,
        context: {
            ptcFactCollector,
            ...(ptcResultProjection ? { ptcResultProjection } : {}),
            // Only PTC turns get the logger: run_code and direct calls of its children use it.
            ...(ptcTools && options.logger ? { ptcLogger: options.logger } : {}),
            ...(ptcObserver ? { ptcObserver } : {}),
            ...(childDisplay
                ? {
                    shapePtcChildDisplayResult: childDisplay.shape,
                    ptcChildDisplayStats: childDisplay.stats,
                }
                : {}),
        },
    };
}
/**
 * The child display-copy preview for this Turn. Only a PTC Turn has children,
 * and only a Host that opted in shortens a child copy; every other Host keeps
 * the whole copy, so it gets no shaper at all.
 */
function childDisplayPreview(input, options, ptcTools, labelTool) {
    if (ptcTools === undefined || options.ptcChildDisplayPreview !== true)
        return undefined;
    return createPtcChildDisplayPreview({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        labelTool,
        ...(options.writePtcChildDisplayArtifact
            ? { writeArtifact: options.writePtcChildDisplayArtifact }
            : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.metricsClient ? { metrics: options.metricsClient } : {}),
    });
}
/**
 * Records the catalog's decision for a PTC-mode Session Turn once the request
 * prefix is final (system prompt and tools exactly as sent), so the admission
 * line can carry the prefix fingerprint. The native catalog is buildPtcCatalog's
 * input on a PTC Turn and the assembled catalog itself otherwise.
 */
export function observePtcTurnAdmission(input, ptc, options, prefix) {
    // Every Turn, PTC or not: the fixed Todo cadence hook reads this back to
    // know whether TodoWrite is reachable through run_code on this Turn.
    registerPtcTurnChildTodoWrite(input.lease.sessionId, input.assembly.tools);
    observePtcAdmission(input, ptc.ptcTools !== undefined, options, {
        ...prefix,
        nativeCatalog: readPtcNativeCatalog(input.assembly.tools) ?? input.assembly.tools,
    });
}
function createTurnObserver(input, options, labelTool) {
    return createPtcTurnObserver({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
        ...(options.ptcSurface ? { surface: options.ptcSurface } : {}),
        // A child Agent runs in its own Session, so its Turn labels its own saves.
        // Only a Task sub-Agent Session counts: Peek, side chat and fork Sessions
        // carry a parentSessionId too, but they are the user's own conversation, so
        // their saves belong to the root caller.
        scriptCaller: input.session.sessionKind === 'task' ? 'subagent' : 'root',
        labelTool,
    });
}
//# sourceMappingURL=turn-preparation.js.map