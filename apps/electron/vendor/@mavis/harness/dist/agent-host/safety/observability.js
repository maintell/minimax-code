/** Registered counter of every settled check; the registry owns its label set. */
const SAFETY_CHECK_TOTAL = 'safety_check_total';
/** Registered counter of a stage that failed closed on an unavailable service. */
const SAFETY_UNAVAILABLE_TOTAL = 'safety_unavailable_total';
/** Registered counter of a PTC child call whose tool stage was not sent for review. */
const PTC_CHILD_REVIEW_SKIPPED_TOTAL = 'ptc_child_review_skipped_total';
/**
 * Registry label values are `[a-z0-9_]+`; the harness stage vocabulary uses hyphens.
 * Exhaustive over `SafetyStage`: a new stage does not compile until it is mapped here
 * and declared in the registry.
 */
const METRIC_STAGE = {
    input: 'input',
    output: 'output',
    thinking: 'thinking',
    'tool-args': 'tool_args',
    'tool-result': 'tool_result',
};
export function createSafetyMetrics(sink, host) {
    const label = host ?? 'unknown';
    return {
        check: (stage, verdict) => report(() => sink?.counter(SAFETY_CHECK_TOTAL, 1, {
            stage: METRIC_STAGE[stage],
            verdict,
            host: label,
        })),
        unavailable: (stage) => report(() => sink?.counter(SAFETY_UNAVAILABLE_TOTAL, 1, { stage: METRIC_STAGE[stage], host: label })),
        childCallSkipped: (stage) => report(() => sink?.counter(PTC_CHILD_REVIEW_SKIPPED_TOTAL, 1, {
            stage: METRIC_STAGE[stage],
            host: label,
        })),
    };
}
function report(emit) {
    try {
        emit();
    }
    catch {
        // Metrics must not change the safety outcome.
    }
}
//# sourceMappingURL=observability.js.map