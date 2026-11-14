import { refusalCooldownMs } from '@mavis/agent-core/pi-turn-runner';
import { normalizeLLMError, toLLMMetricErrorKind, } from '@mavis/shared/llm-error-classifier';
import { TASK_ERROR_REASON } from '../../coordinator-text/index.js';
/** Longest error text shown when the model service did not report the failure. */
const OTHER_ERROR_CHARS = 200;
const REASON_BY_KIND = {
    abort: TASK_ERROR_REASON.aborted,
    timeout: TASK_ERROR_REASON.network,
    network: TASK_ERROR_REASON.network,
    rate_limited: TASK_ERROR_REASON.busy,
    tpm_rate_limited: TASK_ERROR_REASON.busy,
    overloaded: TASK_ERROR_REASON.busy,
    usage_limit: TASK_ERROR_REASON.quota,
    credits_exhausted: TASK_ERROR_REASON.quota,
    auth: TASK_ERROR_REASON.auth,
    content_filter: TASK_ERROR_REASON.refusal,
    server_error: TASK_ERROR_REASON.server,
    empty_response: TASK_ERROR_REASON.server,
    length: TASK_ERROR_REASON.outputLimit,
    not_found: TASK_ERROR_REASON.notFound,
    bad_request: TASK_ERROR_REASON.badRequest,
};
/**
 * The reason a task report and the state block give for a failed round. A failure the model
 * service reported reads as one plain reason; any other error (the host's own, already written
 * for Bunny) keeps its first line.
 */
export function taskErrorReason(error) {
    if (refusalCooldownMs(error) !== undefined)
        return TASK_ERROR_REASON.refusalCooldown;
    const { facts } = normalizeLLMError({ errorMessage: error });
    if (facts.signals.has('context_overflow') || facts.signals.has('request_too_large')) {
        return TASK_ERROR_REASON.tooLong;
    }
    const reason = REASON_BY_KIND[toLLMMetricErrorKind(facts)];
    if (reason)
        return reason;
    const firstLine = error.trim().split(/\r?\n/u)[0] ?? '';
    return firstLine.length <= OTHER_ERROR_CHARS
        ? firstLine
        : `${firstLine.slice(0, OTHER_ERROR_CHARS - 1)}…`;
}
//# sourceMappingURL=task-error-reason.js.map