import { OUTPUT_LIMIT_EXHAUSTED_REASON } from '@mavis/context-manager';
import { classifyLLMErrorToCode, normalizeLLMError, toLLMMetricErrorKind, toLLMProtocolClassification, } from '@mavis/shared/llm-error-classifier';
/** Longest excerpt of the provider's words in the incident note (spec 5.1). */
const EXCERPT_CHARS = 200;
/**
 * Failures of the host's own steps around a model request (spec 2.4, the host
 * internal row). A history write that failed is not one of them: the Turn
 * cannot be recovered after it, so it fails as it does today.
 */
const HOST_STEP_PREFIXES = [
    'before_llm_checkpoint_aborted:',
    'after_commit append message invalid:',
    'after_llm_call_failed:',
];
const HISTORY_WRITE_PREFIXES = [
    'before_llm_checkpoint_persistence_failed:',
    'before_llm_append_persistence_failed:',
];
/** Gateway 400 text that names a content filter or policy (spec 2.4, the safety row). */
const CONTENT_FILTER_TEXT = /content[\s_-]?(?:filter|policy|moderation)|blocked by (?:the )?(?:safety|policy|content)/iu;
/**
 * A refusal that names its category (`stop_reason: refusal; category: cyber`),
 * read the way the chat surface reads it. The model declines the topic, so a
 * new context cannot fix it (dogfood fixes spec 5.1).
 */
const TOPIC_REFUSAL_TEXT = /stop_reason:\s*refusal;\s*category:\s*[^\s)]/iu;
/** Error kinds a new context cannot fix (spec 2.2). */
const ENVIRONMENTAL_KINDS = new Set([
    'abort',
    'timeout',
    'rate_limited',
    'tpm_rate_limited',
    'usage_limit',
    'credits_exhausted',
    'auth',
    'not_found',
    'overloaded',
    'network',
]);
/**
 * Classifies a Turn failure by its normalized signals (spec 2.1): undefined for
 * environmental failures and the ones the emergency rebuild does not handle,
 * which fail as they do today.
 */
export function classifyTurnFailure(failure) {
    if (failure.kind === 'response_rejected') {
        return failure.reason === OUTPUT_LIMIT_EXHAUSTED_REASON
            ? classified('output_limit_exhausted', failure.reason)
            : classified('host_internal', failure.reason);
    }
    if (failure.kind === 'hook_error')
        return classified('host_internal', failure.errorMessage);
    const text = failure.errorMessage;
    if (HISTORY_WRITE_PREFIXES.some((prefix) => text.startsWith(prefix)))
        return undefined;
    if (HOST_STEP_PREFIXES.some((prefix) => text.startsWith(prefix))) {
        return classified('host_internal', text);
    }
    const normalized = failure.normalized ?? normalizeLLMError({ errorMessage: text });
    if (!emergencyCanHelp(normalized, text))
        return undefined;
    const { facts } = normalized;
    const code = toLLMProtocolClassification(normalized)?.code ?? classifyLLMErrorToCode(text)?.status_code;
    const category = providerCategory({ facts, status: httpStatus(facts), text });
    return classified(category, normalized.sanitizedMessage ?? text, code);
}
/** Signals and statuses of a failure a new context cannot fix (spec 2.2). */
const ENVIRONMENTAL_SIGNALS = [
    'network',
    'usage_limit',
    'credits_exhausted',
    'tpm_rate_limit',
];
const ENVIRONMENTAL_STATUSES = new Set([401, 403, 404, 429, 529]);
function isEnvironmental(facts) {
    if (facts.explicitAbort || facts.timeout)
        return true;
    if (ENVIRONMENTAL_SIGNALS.some((signal) => facts.signals.has(signal)))
        return true;
    const status = httpStatus(facts);
    if (status !== undefined && ENVIRONMENTAL_STATUSES.has(status))
        return true;
    return ENVIRONMENTAL_KINDS.has(toLLMMetricErrorKind(facts));
}
/**
 * A new context cannot fix an environmental failure, nor a refusal that names
 * its category: that Turn fails as it does today and the user picks another model.
 */
function emergencyCanHelp(normalized, text) {
    const { facts } = normalized;
    return !isEnvironmental(facts) && !isTopicRefusal(facts, [text, normalized.sanitizedMessage]);
}
/** A refusal whose words name its category (dogfood fixes spec 5.1). */
function isTopicRefusal(facts, texts) {
    return (facts.signals.has('refusal') && texts.some((text) => text && TOPIC_REFUSAL_TEXT.test(text)));
}
/** Spec 2.4, row by row: the first that matches decides; none is `unknown`. */
const PROVIDER_CATEGORIES = [
    [({ facts }) => facts.signals.has('refusal') || facts.signals.has('content_filter'), 'safety'],
    [({ status, text }) => status === 400 && CONTENT_FILTER_TEXT.test(text), 'safety'],
    [({ facts }) => facts.signals.has('context_overflow'), 'context_overflow'],
    [({ facts }) => facts.signals.has('image_limit'), 'image_limit'],
    [
        ({ facts, status }) => facts.signals.has('request_too_large') || status === 413,
        'request_too_large',
    ],
    [({ facts }) => facts.signals.has('incomplete_stream'), 'incomplete_stream'],
    [({ facts }) => facts.signals.has('empty_response'), 'empty_response'],
    // Another 4xx is not "another 400": with no signal it is unclassified.
    [({ status }) => status === 400, 'bad_request'],
    [({ status }) => status !== undefined && status >= 500, 'server_error'],
];
function providerCategory(failure) {
    return PROVIDER_CATEGORIES.find(([matches]) => matches(failure))?.[1] ?? 'unknown';
}
function classified(category, text, errorCode) {
    return {
        category,
        level: levelOf(category),
        resendFirst: RESEND_FIRST.has(category),
        ...(errorCode === undefined ? {} : { errorCode }),
        excerpt: excerptOf(text),
    };
}
const RESEND_FIRST = new Set([
    'server_error',
    'incomplete_stream',
    'empty_response',
    'unknown',
    'host_internal',
]);
function levelOf(category) {
    switch (category) {
        case 'context_overflow':
            return 'standard';
        case 'request_too_large':
        case 'image_limit':
            return 'image';
        case 'safety':
            return 'safety';
        default:
            return 'tight';
    }
}
/** The first 200 characters (code points) of the failure's words, trimmed (spec 5.1). */
function excerptOf(text) {
    return Array.from(text.trim()).slice(0, EXCERPT_CHARS).join('');
}
/** The status the classifier would act on: a valid upstream status first. */
function httpStatus(facts) {
    const upstream = facts.upstreamStatusCode;
    return upstream !== undefined && upstream >= 100 && upstream <= 599 ? upstream : facts.httpStatus;
}
//# sourceMappingURL=turn-failure-classification.js.map