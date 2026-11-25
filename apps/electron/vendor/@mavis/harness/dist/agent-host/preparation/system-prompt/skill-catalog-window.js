import { createHash } from 'node:crypto';
import { planSkillCatalogWindow, SKILL_CATALOG_WINDOW_REASON_LABELS, } from '@mavis/agent-tools/skill-catalog-window';
import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
import { composeSystemPrompt } from './compose-system-prompt.js';
/**
 * A Host whose Sessions outlive the process (the cloud Host) restores a Session's window
 * state before the first preparation of a run and exports it when the run ends; it checks
 * its stored history for updates as the desktop preparation does.
 */
export { exportSkillCatalogSession, messagesHaveSkillAvailabilityNotice, restoreSkillCatalogSession, } from '@mavis/agent-tools/skill-catalog-window';
/**
 * Coordinator (Bunny) Sessions freeze their whole prompt in `FrozenTurnPrefixes`, so the
 * prompt before their catalog never restarts a skill catalog window.
 */
const COORDINATOR_UPSTREAM_FINGERPRINT = 'coordinator';
/**
 * The `<available_skills>` text of one prompt build: frozen for the context window on
 * a real Turn (`commit`), read-only for side calls such as manual compaction, title or
 * advisor builds. A window start or resync is reported once, by the Turn that commits it.
 */
async function planTurnSkillCatalog(input) {
    const plan = await planSkillCatalogWindow({
        sessionId: input.sessionId,
        entries: input.entries,
        ...(input.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: input.contextWindowTokens }),
        upstreamFingerprint: input.coordinator
            ? COORDINATOR_UPSTREAM_FINGERPRINT
            : createHash('sha256').update(input.upstreamPrompt).digest('hex'),
        readUsage: (entries) => input.usage?.readCatalogUsage(entries.map((entry) => entry.name), input.nowMs, input.commit) ?? new Map(),
        commit: input.commit,
        freeze: input.freeze,
        nowMs: input.nowMs,
        ...(input.firstTurn === undefined ? {} : { firstTurn: input.firstTurn }),
        ...(input.historyHasNotice ? { historyHasNotice: input.historyHasNotice } : {}),
    });
    if (input.commit)
        reportWindow(input, plan);
    return plan;
}
/**
 * The Turn's `<available_skills>` planned from its system prompt facts, and the
 * availability update a real Turn (`commit`) appends; side builds only read the window.
 */
export async function planPromptSkillCatalog(input) {
    const { promptFacts, ...window } = input;
    const coordinator = promptFacts.coordinatorIdentity === true;
    const plan = await planTurnSkillCatalog({
        ...window,
        coordinator,
        // Only the subagent catalog and the coordinator memory tail follow the Skills catalog.
        upstreamPrompt: coordinator
            ? ''
            : composeSystemPrompt({
                ...promptFacts,
                skillsCatalog: '',
                subagentCatalog: '',
                coordinatorMemory: '',
            }).text,
    });
    return { catalog: plan.catalog, ...(input.commit && plan.notice ? { notice: plan.notice } : {}) };
}
function reportWindow(input, plan) {
    const { outcome, render } = plan;
    const shadow = outcome.shadow ? 'true' : 'false';
    const { metrics } = input;
    // Every committed Turn: a nonzero count is a catalog change the freeze kept out of the prefix.
    for (const kind of ['added', 'removed', 'changed']) {
        const count = outcome.sinceLastTurn[kind];
        if (count > 0) {
            incrementMetric(metrics, 'skill_catalog_window_deviation_total', count, { kind, shadow });
        }
    }
    if (outcome.event === 'continued')
        return;
    incrementMetric(metrics, 'skill_catalog_window_total', 1, {
        event: outcome.event,
        reason: SKILL_CATALOG_WINDOW_REASON_LABELS[outcome.reason ?? 'first'],
        shadow,
    });
    observeMetric(metrics, 'skill_catalog_skill_items', input.entries.length, { shadow });
    incrementMetric(metrics, 'skill_catalog_tokens_total', render.catalogTokens, { shadow });
    if (render.descriptionsDropped > 0) {
        incrementMetric(metrics, 'skill_catalog_descriptions_dropped_total', render.descriptionsDropped, { shadow });
    }
    if (render.descriptionCapTruncated) {
        incrementMetric(metrics, 'skill_catalog_description_cap_total', 1, { shadow });
    }
    try {
        input.logger?.info?.({
            event: 'skill_catalog_window',
            session_id: input.sessionId,
            ...(input.turnId ? { turn_id: input.turnId } : {}),
            window_event: outcome.event,
            reason: outcome.reason,
            shadow: outcome.shadow,
            added: outcome.added,
            removed: outcome.removed,
            changed: outcome.changed,
            skills: input.entries.length,
            catalog_tokens: render.catalogTokens,
            descriptions_dropped: render.descriptionsDropped,
        }, '[skill-catalog] window planned');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
//# sourceMappingURL=skill-catalog-window.js.map