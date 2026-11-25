import { createDefaultTokenEstimator, renderLocalSkillsCatalogResult, resolveSkillCatalogBudgetTokens, } from '@mavis/context-manager';
import { skillAvailability, skillDeviation, skillSnapshot, } from './deviation.js';
import { renderSkillAvailabilityNotice } from './notice.js';
import { commitSkillCatalogTurn, noteSkillCatalogNoticeInHistory, peekSkillCatalogSessionState, skillCatalogSessionState, skillToldState, } from './state.js';
/** Metric label of each window start or resync reason, as both runtimes report it. */
export const SKILL_CATALOG_WINDOW_REASON_LABELS = {
    first: 'first',
    compaction: 'compaction',
    'context-window': 'context_window',
    'upstream-changed': 'upstream_changed',
    'no-state': 'no_state',
    error: 'error',
};
const DEFAULT_TOKEN_ESTIMATOR = createDefaultTokenEstimator();
const NO_DEVIATION = new Map();
const NO_ADDED = new Map();
/**
 * The catalog a Turn's system prompt carries and the update its user message
 * appends. A window starts on the Session's first Turn, after a compaction, or
 * when the context window or the prompt before the catalog changed (the prefix
 * cache is lost then anyway); otherwise the Turn repeats the frozen catalog and
 * states the complete deviation in a skill-availability update when it differs
 * from what the model was last told. Usage is read only when a window starts.
 */
export async function planSkillCatalogWindow(input) {
    const live = skillSnapshot(input.entries);
    if (!input.commit)
        return planReadOnly(input, live);
    const state = skillCatalogSessionState(input.sessionId);
    if (input.historyHasNotice)
        noteSkillCatalogNoticeInHistory(input.sessionId, input.historyHasNotice);
    const turnChange = { previous: state.turn?.live, live };
    const current = state.window;
    let reason;
    if (!current)
        reason = startReason(state, input.firstTurn);
    // The prompt showed fresh renders, not this window's catalog.
    else if (input.freeze && state.turn?.shadow)
        reason = 'no-state';
    // Only the budget the window derives from it shapes the catalog.
    else if (resolveSkillCatalogBudgetTokens(current.contextWindowTokens) !==
        resolveSkillCatalogBudgetTokens(input.contextWindowTokens)) {
        reason = 'context-window';
    }
    else if (current.upstreamFingerprint !== input.upstreamFingerprint)
        reason = 'upstream-changed';
    // Turning the freeze off (the rollback switch) shows the live catalog from now
    // on, but the newest update may still say a Skill is unavailable: one all-clear
    // update supersedes it, then shadow Turns send none.
    const leavingFreeze = !input.freeze && state.turn !== undefined && !state.turn.shadow;
    let continued;
    if (current && !reason) {
        try {
            const deviation = skillDeviation(current.entries, live, state.addedInWindow);
            const availability = input.freeze
                ? skillAvailability(skillToldState(state), deviation, live, state.changedInWindow)
                : leavingFreeze
                    ? skillAvailability(skillToldState(state), NO_DEVIATION, live)
                    : undefined;
            const render = input.freeze ? current.render : freshRender(input, current);
            continued = {
                deviation,
                noticeDeviation: input.freeze ? deviation : NO_DEVIATION,
                render,
                view: viewOf(input, live, render, current),
                ...noticeFor(input, availability),
            };
        }
        catch {
            reason = 'error';
        }
    }
    if (continued) {
        commitSkillCatalogTurn(state, {
            window: undefined,
            notice: continued.notice
                ? { text: continued.notice, deviation: continued.noticeDeviation }
                : undefined,
            view: continued.view,
        });
        return {
            catalog: continued.render.catalog,
            ...(continued.notice ? { notice: continued.notice } : {}),
            render: continued.render,
            outcome: outcomeOf('continued', undefined, continued.deviation, input, turnChange),
        };
    }
    const window = await startWindow(input, live);
    // A new window shows every Skill as it is; an update still supersedes earlier ones.
    const notice = input.freeze || leavingFreeze
        ? noticeFor(input, skillAvailability(skillToldState(state), NO_DEVIATION, live)).notice
        : undefined;
    commitSkillCatalogTurn(state, {
        window,
        notice: notice ? { text: notice, deviation: NO_DEVIATION } : undefined,
        view: viewOf(input, live, window.render, window),
    });
    const restart = reason ?? 'error';
    return {
        catalog: window.render.catalog,
        ...(notice ? { notice } : {}),
        render: window.render,
        outcome: outcomeOf(restart === 'first' || restart === 'compaction' || restart === 'no-state'
            ? 'started'
            : 'resynced', restart, NO_DEVIATION, input, undefined),
    };
}
/** A read-only build: the frozen catalog (fresh in shadow mode), never an update or a state change. */
async function planReadOnly(input, live) {
    const state = peekSkillCatalogSessionState(input.sessionId);
    if (state?.window) {
        const current = state.window;
        const render = input.freeze ? current.render : freshRender(input, current);
        const deviation = skillDeviation(current.entries, live, state.addedInWindow);
        return {
            catalog: render.catalog,
            render,
            outcome: outcomeOf('continued', undefined, deviation, input, undefined),
        };
    }
    const { render } = await startWindow(input, live);
    return {
        catalog: render.catalog,
        render,
        outcome: outcomeOf('started', startReason(state, input.firstTurn), NO_DEVIATION, input, undefined),
    };
}
/** Why a Session without a window in effect starts one. */
function startReason(state, firstTurn) {
    if (state?.endedByCompaction)
        return 'compaction';
    if (state?.everEffective)
        return 'no-state';
    // A later Turn whose Session had a window no process remembers: restart or eviction.
    return firstTurn === false ? 'no-state' : 'first';
}
async function startWindow(input, live) {
    let usage = new Map();
    try {
        usage = await input.readUsage(input.entries);
    }
    catch {
        // Without usage (and so without first sight), descriptions keep by tier and name.
    }
    const render = renderLocalSkillsCatalogResult(input.entries, {
        ...(input.contextWindowTokens !== undefined
            ? { contextWindowTokens: input.contextWindowTokens }
            : {}),
        ...(input.tokenEstimator ? { tokenEstimator: input.tokenEstimator } : {}),
        usage,
        nowMs: input.nowMs,
    });
    return {
        entries: live,
        usage,
        render,
        listing: listingOf(render, live),
        contextWindowTokens: input.contextWindowTokens,
        upstreamFingerprint: input.upstreamFingerprint,
        startedAtMs: input.nowMs,
    };
}
/** Shadow mode's catalog: the live Skills, ranked by the window's usage as of its start. */
function freshRender(input, window) {
    return renderLocalSkillsCatalogResult(input.entries, {
        ...(input.contextWindowTokens !== undefined
            ? { contextWindowTokens: input.contextWindowTokens }
            : {}),
        ...(input.tokenEstimator ? { tokenEstimator: input.tokenEstimator } : {}),
        usage: window.usage,
        nowMs: window.startedAtMs,
    });
}
function noticeFor(input, availability) {
    if (!availability)
        return {};
    return {
        notice: renderSkillAvailabilityNotice(availability, {
            budgetTokens: resolveSkillCatalogBudgetTokens(input.contextWindowTokens),
            estimator: input.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR,
        }),
    };
}
/** How the catalog lists each Skill: a name-only line, or one with its description. */
function listingOf(render, live) {
    return new Map([...live].map(([key, { entry }]) => [
        key,
        render.nameOnly.has(entry.name) ? 'name_only' : 'described',
    ]));
}
/** What the Turn's prompt shows: the frozen listing, or in shadow mode the fresh render's. */
function viewOf(input, live, render, window) {
    return {
        listing: render === window.render ? window.listing : listingOf(render, live),
        live,
        shadow: !input.freeze,
    };
}
function outcomeOf(event, reason, deviation, input, turnChange) {
    const counts = (of) => {
        const count = (status) => [...of.values()].filter((entry) => entry.status === status).length;
        return { added: count('added'), removed: count('removed'), changed: count('changed') };
    };
    const sinceLastTurn = turnChange?.previous
        ? counts(skillDeviation(turnChange.previous, turnChange.live, NO_ADDED))
        : { added: 0, removed: 0, changed: 0 };
    return {
        event,
        ...(reason ? { reason } : {}),
        ...counts(deviation),
        sinceLastTurn,
        shadow: !input.freeze,
    };
}
//# sourceMappingURL=plan.js.map