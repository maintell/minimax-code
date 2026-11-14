import { estimateCharsToTokensCjkAware } from '@mavis/context-manager';
import { GLOBAL_CONSTRAINTS_TITLE, globalConstraintLine, ledgerDeltaLine, ledgerHeaderText, ledgerOmittedLine, } from '../coordinator-text/index.js';
import { CLOSED_ENTRY_INJECTION_MS, FULL_BLOCK_LEDGER_TOKENS, GLOBAL_CONSTRAINT_EXCERPT_TOKENS, } from './contracts.js';
/**
 * Truncation tiers, cut first to last (13.4): closed entries, open questions, context gaps,
 * then corrections and constraints. Within a tier the oldest go first.
 */
const TRUNCATION_TIERS = [
    (entry) => entry.status !== 'active',
    (entry) => entry.kind === 'open_question',
    (entry) => entry.kind === 'context_gap',
    () => true,
];
/** @internal Exported only for focused tests. */
export function estimateWorkingStateTokens(text) {
    return estimateCharsToTokensCjkAware(text);
}
/**
 * Entries the model still sees: active ones, and closed ones for 7 days after closing,
 * marked closed (13.3). Superseded entries are represented by the entry that replaced them.
 */
export function isInjectedWorkingStateEntry(entry, nowMs) {
    if (entry.status === 'active')
        return true;
    if (entry.status !== 'done')
        return false;
    return nowMs - (entry.closedAtMs ?? entry.updatedAtMs) < CLOSED_ENTRY_INJECTION_MS;
}
function byAge(left, right) {
    return left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
}
/** Removes entries tier by tier, oldest first, until `fits` holds; returns the kept and cut count. */
function truncateByTiers(entries, fits) {
    let kept = [...entries];
    let truncated = 0;
    for (const tier of TRUNCATION_TIERS) {
        for (const victim of kept.filter(tier)) {
            if (fits(kept, truncated))
                break;
            kept = kept.filter((entry) => entry !== victim);
            truncated += 1;
        }
    }
    return { kept, truncated };
}
/**
 * The ledger part of a handoff header (12.9): injected entries in section order, cut to
 * `budgetTokens` by 13.4 with the cut count and the `working_state list` hint.
 */
export function renderWorkingStateHeader(entries, input) {
    const { kept, truncated } = truncateByTiers(entries.filter((entry) => isInjectedWorkingStateEntry(entry, input.nowMs)).sort(byAge), (candidates, cut) => estimateWorkingStateTokens(ledgerHeaderText(candidates, cut)) <= input.budgetTokens);
    const text = ledgerHeaderText(kept, truncated);
    return {
        text,
        entryIds: kept.map((entry) => entry.id),
        truncated,
        tokens: estimateWorkingStateTokens(text),
    };
}
/**
 * What the delta block compares with the delivery baseline: an entry is redelivered only
 * when one of these changes. Confirming an inferred entry does not change it.
 * @internal Exported only for focused tests.
 */
export function workingStateDeliveryKey(entry) {
    return JSON.stringify([
        entry.status,
        entry.closeReason ?? null,
        entry.closeNote ?? null,
        entry.kind,
        entry.scope,
        entry.text,
        entry.replaces ?? null,
        entry.expiresAtMs ?? null,
    ]);
}
/**
 * The delta block's ledger lines (9.2): changes Bunny did not make itself — the user's
 * additions, edits and closures in "近期约定", expiries, and entries the compactor wrote
 * that have not reached Bunny in a handoff header. Bunny's own writes are already in
 * history: they advance the baseline silently. Without a baseline every injected entry is
 * listed as the current state (9.4), cut like the handoff header to
 * {@link FULL_BLOCK_LEDGER_TOKENS} with a count of the rest (dogfood fixes spec 8.4). Cut
 * entries still enter the baseline, so a later change to one is reported as a change.
 */
export function renderWorkingStateDelta(entries, input) {
    const baseline = input.delivered;
    if (baseline === undefined)
        return renderFullLedger(entries, input.nowMs, input.fullBudgetTokens);
    const lines = [];
    const delivered = new Map();
    for (const entry of [...entries].sort(byAge)) {
        const key = workingStateDeliveryKey(entry);
        if (baseline.get(entry.id) === key)
            continue;
        delivered.set(entry.id, key);
        if (!isInjectedWorkingStateEntry(entry, input.nowMs))
            continue;
        const silent = entry.updatedBy === 'front' ||
            (entry.updatedBy === 'compactor' && entry.handoffAtMs !== undefined);
        const line = silent ? undefined : ledgerDeltaLine(entry, false);
        if (line)
            lines.push(line);
    }
    return { lines, delivered };
}
function renderFullLedger(entries, nowMs, budgetTokens = FULL_BLOCK_LEDGER_TOKENS) {
    const delivered = new Map();
    for (const entry of entries)
        delivered.set(entry.id, workingStateDeliveryKey(entry));
    const listed = entries.filter((entry) => isInjectedWorkingStateEntry(entry, nowMs)).sort(byAge);
    const linesOf = (kept, truncated) => [
        ...kept.flatMap((entry) => ledgerDeltaLine(entry, true) ?? []),
        ...(truncated ? [ledgerOmittedLine(truncated)] : []),
    ];
    const { kept, truncated } = truncateByTiers(listed, (candidates, cut) => estimateWorkingStateTokens(linesOf(candidates, cut).join('\n')) <= budgetTokens);
    return { lines: linesOf(kept, truncated), delivered };
}
/**
 * The active global constraints a dispatched task follows (13.8), newest first, within the
 * token limit. Corrections, open questions and space-scoped entries stay with Bunny.
 */
export function renderGlobalConstraintExcerpt(entries, maxTokens = GLOBAL_CONSTRAINT_EXCERPT_TOKENS) {
    const title = GLOBAL_CONSTRAINTS_TITLE;
    const lines = [];
    let tokens = estimateWorkingStateTokens(title);
    const candidates = entries
        .filter((entry) => entry.status === 'active' && entry.scope === 'global' && entry.kind === 'constraint')
        .sort((left, right) => byAge(right, left));
    for (const entry of candidates) {
        const line = globalConstraintLine(entry);
        const cost = estimateWorkingStateTokens(`\n${line}`);
        if (tokens + cost > maxTokens)
            continue;
        tokens += cost;
        lines.push(line);
    }
    return lines.length ? [title, ...lines] : [];
}
//# sourceMappingURL=render.js.map