import { observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
/** The compaction metadata fields that persist a segment (Bunny) rebuild plan. */
export function segmentPlanFields(plan) {
    return {
        // New host records are -1 so runner placement can still match the current
        // user by its source index and move it behind a placed marker.
        replacementSourceIndexes: Array.isArray(plan?.sourceIndexes)
            ? plan.sourceIndexes.map((index) => index ?? -1)
            : plan?.sourceIndexes,
        segmentCoveredCount: plan?.coveredCount,
        segmentPrefixDigest: plan?.prefixDigest,
        segmentExpectedId: plan?.expectedSegmentId,
        ...(plan?.background ? { segmentBackground: true } : {}),
        ...(plan?.hidden ? { segmentHidden: true } : {}),
    };
}
/**
 * Reads the persisted segment fields of compaction metadata; undefined when
 * invalid. `replacementSourceIndexes` holds the source index of each kept
 * record and -1 for a new host record; `sourceCount` is how many of the
 * replacement messages it describes (all of them unless runner placement
 * moved the current user behind its markers).
 */
export function readSegmentCheckpointPlan(value, sourceCount) {
    const sourceIndexes = Reflect.get(value, 'replacementSourceIndexes');
    const coveredCount = Reflect.get(value, 'segmentCoveredCount');
    const prefixDigest = Reflect.get(value, 'segmentPrefixDigest');
    const expectedSegmentId = Reflect.get(value, 'segmentExpectedId');
    if (!isSegmentSourceIndexes(sourceIndexes, sourceCount) ||
        !isNonNegativeInteger(coveredCount) ||
        typeof prefixDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(prefixDigest) ||
        !isSegmentId(expectedSegmentId)) {
        return undefined;
    }
    return Object.freeze({
        sourceIndexes: Object.freeze(sourceIndexes.map((index) => (index === -1 ? null : index))),
        coveredCount,
        prefixDigest,
        expectedSegmentId,
        background: Reflect.get(value, 'segmentBackground') === true,
        ...(Reflect.get(value, 'segmentHidden') === true ? { hidden: true } : {}),
    });
}
/** Exactly `sourceCount` entries, a new header first (-1), then -1 or a source index. */
function isSegmentSourceIndexes(value, sourceCount) {
    return (Array.isArray(value) &&
        value.length === sourceCount &&
        value[0] === -1 &&
        value.every((index) => Number.isSafeInteger(index) && index >= -1));
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isSegmentId(value) {
    return value === null || (typeof value === 'string' && value.length > 0);
}
/**
 * A background segment rebuild commits without the compaction card; a hidden
 * one (an emergency rebuild) has no display record even when it fails.
 */
export function readBackgroundSegment(value, method) {
    if (method !== 'llm_segment_checkpoint')
        return {};
    return {
        ...(Reflect.get(value, 'segmentBackground') === true ? { background: true } : {}),
        ...(Reflect.get(value, 'segmentHidden') === true ? { hidden: true } : {}),
    };
}
const WAIT_RESULTS = {
    replaceMessages: 'replaced',
    continue: 'continued',
    skip: 'skipped',
    abort: 'aborted',
};
/**
 * Wraps a segment (Bunny) Turn's before-LLM decision so the time its request was held for a
 * compaction it had to wait for is observed in `bunny_turn_compaction_wait_ms`: from the
 * decision to the request going out (or the Turn giving up), only when a foreground compaction
 * started. A rebuild that runs in the background while the request is sent holds nothing and is
 * not counted; `bunny_compaction_run_ms` measures the compaction itself. The decision itself is
 * returned or thrown unchanged.
 */
export function timeSegmentCompactionWait(metrics, decide) {
    return async (input) => {
        const wait = { started: false };
        const startedAtMs = Date.now();
        let decision;
        try {
            decision = await decide(input, wait);
            return decision;
        }
        finally {
            if (wait.started)
                recordSegmentCompactionWaitBestEffort(metrics, {
                    phase: input.phase,
                    decision,
                    waitedMs: Math.max(0, Date.now() - startedAtMs),
                });
        }
    };
}
function recordSegmentCompactionWaitBestEffort(metrics, input) {
    // A metric never changes the compaction outcome: observeMetric never throws.
    observeMetric(metrics, 'bunny_turn_compaction_wait_ms', input.waitedMs, {
        phase: input.phase === 'iteration' ? 'iteration' : 'initial',
        result: input.decision ? (WAIT_RESULTS[input.decision.type] ?? 'other') : 'error',
    });
}
//# sourceMappingURL=segment-checkpoint-plan.js.map