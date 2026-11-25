import { createHash } from 'node:crypto';
import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
/** Sessions remembered per process; the least recently observed one is dropped first. */
const MAX_TRACKED_SESSIONS = 512;
const DIGEST_LENGTH = 16;
const SECTION_BY_KIND = {
    SKILLS: 'skills',
    MEMORY: 'memory',
    OTHER: 'other',
};
const baselines = new Map();
/**
 * Remembers this request's section digests and counts every section that differs from
 * the Session's previous prepared request: `within_turn` when the same Turn prepared
 * again, `across_turn` otherwise. The first request after a process start, a committed
 * compaction or an eviction only sets the baseline.
 */
export function observePromptSectionChange(input, sinks) {
    try {
        if (!input.ranges) {
            // Without section boundaries there is nothing to compare, nor a baseline to keep.
            baselines.delete(input.sessionId);
            return;
        }
        const digests = sectionDigests(input.systemPrompt, input.ranges);
        const previous = baselines.get(input.sessionId);
        baselines.delete(input.sessionId);
        baselines.set(input.sessionId, { turnId: input.turnId, digests });
        evictOldest();
        if (!previous)
            return;
        const changed = Object.keys(digests).filter((section) => previous.digests[section] !== digests[section]);
        if (changed.length === 0)
            return;
        const scope = previous.turnId === input.turnId ? 'within_turn' : 'across_turn';
        for (const section of changed) {
            incrementMetric(sinks.metricsClient, 'prompt_section_change_total', 1, { section, scope });
        }
        sinks.logger?.info?.({
            event: 'prompt_section_changed',
            session_id: input.sessionId,
            turn_id: input.turnId,
            previous_turn_id: previous.turnId,
            scope,
            changed,
        }, 'system prompt section changed');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
/** Drops the Session's baseline: a committed compaction, a context reset or a deleted Session. */
export function resetPromptSectionBaseline(sessionId) {
    baselines.delete(sessionId);
}
function sectionDigests(systemPrompt, ranges) {
    const parts = { skills: [], memory: [], other: [] };
    for (const range of ranges) {
        parts[SECTION_BY_KIND[range.kind]].push(systemPrompt.slice(range.startOffset, range.endOffset));
    }
    return {
        skills: digest(parts.skills),
        memory: digest(parts.memory),
        other: digest(parts.other),
    };
}
function digest(parts) {
    if (parts.length === 0)
        return 'none';
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, DIGEST_LENGTH);
}
function evictOldest() {
    while (baselines.size > MAX_TRACKED_SESSIONS) {
        const oldest = baselines.keys().next();
        if (oldest.done)
            return;
        baselines.delete(oldest.value);
    }
}
//# sourceMappingURL=prompt-section-change.js.map