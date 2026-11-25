import { coordinatorPreloadSkillNames, namespaceForSkill, } from '@mavis/agent-tools/namespaced-tools';
import { clearManagedSkillReceiptsOutsideHistory, } from '@mavis/shared/local-runtime-managed-skills';
import { isTrustedCoordinator } from '../assembly/local-turn-tool-authority.js';
import { renderUnlockedNamespaceTools } from '../assembly/local-turn-tool-managed-skills.js';
/**
 * Renders the full content of every named Skill into the Turn's user message
 * (README "Desktop Local Agent 定义"). A Skill that cannot be found or read is
 * skipped: the Turn still runs, and the failure is remembered so no later Turn
 * of this conversation reads it again. A Skill that owns a namespace also
 * carries that group's tool definitions, the same block a `skill` read
 * appends, and records the receipt its tools' gate checks. There is no size
 * limit; one log line records the names, skip reasons, injected bytes and the
 * trigger, never paths or content.
 */
export async function renderAgentSkillPreload(input) {
    const names = uniqueNames(input.names ?? []);
    if (names.length === 0)
        return '';
    const results = await Promise.all(names.map((name) => readPreloadSkill(input.readSkill, name)));
    const loaded = results.flatMap((result) => (result.kind === 'loaded' ? [result] : []));
    // Read before the render below marks them, so only the receipts this call
    // creates become provisional: a receipt anything else wrote is never dropped.
    const receipted = newlyReceiptedSkills(input, loaded);
    const text = loaded.length === 0
        ? ''
        : [
            [
                '<system-reminder>',
                `This conversation preloads these skills: ${loaded.map(({ name }) => name).join(', ')}. Their full instructions follow. Apply them when relevant; do not load them again with the skill tool.`,
                '</system-reminder>',
            ].join('\n'),
            ...loaded.map(({ name, text: skill }) => [
                `<preloaded-skill name="${escapeAttribute(name)}">`,
                withNamespaceTools(name, skill, input),
                '</preloaded-skill>',
            ].join('\n')),
        ].join('\n\n');
    if (input.turnId)
        input.receipts.recordPreloadReceipts(input.sessionId, input.turnId, receipted);
    rememberFailedPreloads(input, results);
    logPreload(input, {
        requested: names.length,
        loaded: loaded.map(({ name }) => name),
        skipped: results.flatMap((result) => result.kind === 'skipped' ? [{ name: result.name, reason: result.reason }] : []),
        injectedBytes: new TextEncoder().encode(text).length,
    });
    return text;
}
/**
 * Appends a namespace Skill's tool definitions to its preloaded body and
 * records the receipt. Without the receipt the first call of a brand-new
 * Session would still be blocked with `SKILL_REQUIRED`, which is the whole
 * point of preloading the Skill in the first place.
 */
function withNamespaceTools(name, text, input) {
    const namespace = namespaceForSkill(name);
    if (namespace === undefined)
        return text;
    input.receipts.markLoaded(input.sessionId, name);
    const definitions = input.tools
        ? renderUnlockedNamespaceTools(name, namespace, input.tools, {
            ptc: input.ptc === true,
            coordinator: input.coordinator === true,
        })
        : undefined;
    return definitions === undefined ? text : `${text}\n\n${definitions}`;
}
/**
 * The namespace Skills this render is about to write a receipt for. The Turn
 * settles them once its user message is handed to the model, or drops them
 * when it ends first, so a body that never reached the model cannot leave the
 * gate open.
 */
function newlyReceiptedSkills(input, loaded) {
    return loaded
        .map(({ name }) => name)
        .filter((name) => namespaceForSkill(name) !== undefined && !input.receipts.hasLoaded(input.sessionId, name));
}
/**
 * A Skill this process could not read stays unreadable, so the conversation
 * remembers the failure instead of spending a Turn on it again. The store
 * drops it with the conversation's receipts.
 */
function rememberFailedPreloads(input, results) {
    for (const result of results) {
        if (result.kind === 'skipped')
            input.receipts.markPreloadFailed(input.sessionId, result.name);
    }
}
async function readPreloadSkill(readSkill, name) {
    if (!readSkill)
        return { kind: 'skipped', name, reason: 'reader_unavailable' };
    try {
        const skill = await readSkill(name);
        if (!skill)
            return { kind: 'skipped', name, reason: 'not_found' };
        return { kind: 'loaded', name, text: formatSkillContent(name, skill.content, skill.location) };
    }
    catch {
        return { kind: 'skipped', name, reason: 'read_failed' };
    }
}
/** The same header the `skill` tool puts on a Skill it loads. */
function formatSkillContent(name, content, location) {
    const header = [`# Skill: ${name}`];
    if (location)
        header.push(`Location: ${location}`);
    return `${header.join('\n')}\n\n${content}`;
}
function logPreload(input, outcome) {
    try {
        input.logger?.info?.({
            event: 'agent_skill_preload',
            trigger: input.trigger,
            session_id: input.sessionId,
            ...(input.turnId ? { turn_id: input.turnId } : {}),
            ...(input.agentName ? { agent_name: input.agentName } : {}),
            requested: outcome.requested,
            loaded: outcome.loaded,
            skipped: outcome.skipped,
            injected_bytes: outcome.injectedBytes,
        }, '[local-runtime-v2] agent skill preload');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
function uniqueNames(values) {
    const seen = new Set();
    const names = [];
    for (const value of values) {
        const name = value.trim();
        const key = name.normalize('NFKC').toLocaleLowerCase('en-US');
        if (!name || seen.has(key))
            continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}
function escapeAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
/**
 * Renders the Skills this Turn must carry in its user message.
 *
 * The Session's first Turn preloads what the Agent's `skills` list names. A
 * trusted coordinator also preloads again on any later Turn that is missing a
 * namespace Skill receipt: its main Session outlives the history that carried
 * those bodies, so a compaction or a rewind leaves it holding neither the body
 * nor the receipt, and the gate would then spend one of its Turn budget on
 * reloading what it reaches for on nearly every Turn. Only the receipts decide
 * — history is never scanned here, and the restart restore already ran inside
 * `buildLocalTurnToolCatalog`, before the gate was installed.
 */
export async function renderTurnSkillPreload(preload) {
    const plan = turnSkillPreloadPlan(preload);
    if (!plan)
        return '';
    const { input, tools, receipts, readSkill, logger } = preload;
    return await renderAgentSkillPreload({
        sessionId: input.sessionId,
        turnId: input.turnId,
        agentName: input.agentName,
        names: plan.names,
        trigger: plan.trigger,
        ...(readSkill ? { readSkill } : {}),
        receipts,
        tools,
        ...(input.ptcEnabled ? { ptc: true } : {}),
        ...(isTrustedCoordinator(input.agentProfile) ? { coordinator: true } : {}),
        ...(logger ? { logger } : {}),
    });
}
/**
 * A committed compaction rewrote the history, so the model lost every Skill body
 * it carried: the receipts for bodies that history no longer holds go with them,
 * and the next prompted Turn preloads those Skills again.
 */
export function clearCompactedSkillReceipts(input) {
    clearManagedSkillReceiptsOutsideHistory(input.receipts, {
        sessionId: input.sessionId,
        messages: input.messages,
        reason: 'compaction',
        ...(input.logger ? { logger: input.logger } : {}),
    });
}
/**
 * Which Skills this Turn preloads, and why; absent means it preloads nothing.
 *
 * The candidate list is built exactly as on the first Turn — the Agent's own
 * `skills` beside the coordinator's namespace Skills — but a later Turn renders
 * only what this conversation no longer holds, and only a missing namespace
 * receipt triggers it at all: a Skill outside a namespace records no receipt,
 * so it can never be the reason to re-inject.
 */
function turnSkillPreloadPlan(preload) {
    const { input, tools, receipts } = preload;
    // Nothing rendered here reaches the model without a user message to carry it,
    // so this assembly records no receipt: the gate keeps answering
    // `SKILL_REQUIRED` and the next prompted Turn preloads the bodies for real.
    if (input.sendsUserMessage === false)
        return undefined;
    const coordinatorSkills = coordinatorPreloadSkills(input, tools);
    const names = [...(input.agentProfile?.configSelection?.skills ?? []), ...coordinatorSkills];
    if (input.sessionFirstTurn)
        return { names, trigger: 'first_turn' };
    // Every other Agent keeps the first-Turn rule.
    if (!isTrustedCoordinator(input.agentProfile))
        return undefined;
    if (!coordinatorSkills.some((name) => stillMissing(receipts, input.sessionId, name))) {
        return undefined;
    }
    const missing = names.filter((name) => stillMissing(receipts, input.sessionId, name));
    return missing.length === 0 ? undefined : { names: missing, trigger: 'receipt_missing' };
}
/**
 * A trusted coordinator reaches for the sidebar's projects and its own chats on
 * nearly every turn, so its first Turn preloads those Skills rather than making
 * it load them, and a later Turn preloads them again once their receipts are
 * gone. Every other Agent preloads only what its own `skills` lists.
 */
function coordinatorPreloadSkills(input, tools) {
    if (!isTrustedCoordinator(input.agentProfile))
        return [];
    return coordinatorPreloadSkillNames(tools.map((tool) => tool.def.name));
}
/**
 * A Skill this conversation holds neither a receipt for nor a recorded read
 * failure. A failed read is as final as a receipt for this decision: the Skill
 * stays unreadable for the life of the process, so it can never be the reason
 * to re-inject, and treating it as missing would inject every Turn.
 */
function stillMissing(receipts, sessionId, name) {
    return !receipts.hasLoaded(sessionId, name) && !receipts.hasPreloadFailed(sessionId, name);
}
//# sourceMappingURL=agent-skill-preload.js.map