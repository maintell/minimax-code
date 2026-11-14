import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import { parseBackgroundTaskDeliveryOrigin, parsePeerSessionOrigin } from '../contracts.js';
import { WAKE_LINE_PREFIX } from '../execution/turn-state-layer/state-delta-message.js';
/** Rendering order of the `<wake reasons>` list. */
const WAKE_REASON_ORDER = [
    'user',
    'user_answer',
    'task_report',
    'cron',
    'self_reminder',
    'background_task',
    'peer',
];
/** System events a Turn may end on without saying anything. */
const SILENCEABLE_WAKE_REASONS = new Set([
    'task_report',
    'cron',
    'self_reminder',
    'background_task',
    'peer',
]);
/** Hidden canonical message that carries a `<wake>` line before steered user input. */
export const WAKE_LINE_CUSTOM_TYPE = 'wake_reasons';
/** The reason one delivered input stands for, or undefined for an unknown producer. */
export function resolveInputWakeReason(input) {
    const { source } = input.provenance;
    const origin = input.provenance.sourceContext?.['origin'] ?? input.origin;
    const fromOrigin = originWakeReason(source, origin);
    if (fromOrigin)
        return fromOrigin;
    if (isUserSource(source))
        return 'user';
    switch (source) {
        case 'questionnaire':
            return 'user_answer';
        case 'cron':
            return isSelfReminderId(readString(input.provenance.sourceContext?.['cronId']))
                ? 'self_reminder'
                : 'cron';
        case 'background-task':
            return 'background_task';
        // Another session's `mavis session send`.
        case 'communication':
            return 'peer';
        default:
            return undefined;
    }
}
/**
 * Wake reasons of a Turn from its starting batch. An immediate-send batch is
 * judged member by member (its own provenance is the merged envelope); merged
 * `queuedMessages` companions count as user input unless their origin says
 * otherwise.
 */
export function resolveTurnWakeReasons(request) {
    const members = request.immediateSendBatch?.members ?? [];
    const reasons = members.length > 0
        ? members.map((member) => resolveInputWakeReason({ provenance: member.provenance }))
        : [
            resolveInputWakeReason({
                // Direct test seams may omit provenance.
                provenance: request.provenance ?? { source: '' },
                origin: request.input?.origin,
            }),
        ];
    for (const companion of request.input?.queuedMessages ?? []) {
        reasons.push(companionWakeReason(companion));
    }
    return orderWakeReasons(reasons);
}
/**
 * Sources a person starts in a client that wake no user reason: an edited and
 * resent message, a Mini App action, `/review`. Only the `wake` metrics
 * label reads them. `USER_TYPED_SOURCES` of Bunny's round status
 * (assignment/orchestration/status.service.ts) lists api,
 * conversation-mutation and miniapp; the label takes api together with IM
 * and questionnaire answers through their wake reasons instead, and adds
 * code_review.
 */
const CLIENT_STARTED_SOURCES = new Set([
    'conversation-mutation',
    'miniapp',
    'code_review',
]);
/**
 * The `wake` label of a Turn's first-output metrics: `user` when a person
 * started any input of its starting batch in a client, `system` otherwise.
 * An input counts when its wake reason is user or user_answer (composer, TUI,
 * ACP, IM, questionnaire answers; queued companions by their origin) or its
 * source is one of {@link CLIENT_STARTED_SOURCES}. Bunny's wake line and
 * silence keep reading {@link resolveTurnWakeReasons}.
 */
export function resolveTurnWakeLabel(request) {
    const members = request.immediateSendBatch?.members ?? [];
    const starters = members.length > 0
        ? members.map((member) => ({ provenance: member.provenance }))
        : [{ provenance: request.provenance ?? { source: '' }, origin: request.input?.origin }];
    const clientStarted = starters.some((input) => isUserSourcedWakeReason(resolveInputWakeReason(input)) ||
        CLIENT_STARTED_SOURCES.has(input.provenance.source)) ||
        (request.input?.queuedMessages ?? []).some((companion) => isUserSourcedWakeReason(companionWakeReason(companion)));
    return clientStarted ? 'user' : 'system';
}
/** True for input the person gave: a typed or steered message, or a questionnaire answer. */
export function isUserSourcedWakeReason(reason) {
    return reason === 'user' || reason === 'user_answer';
}
/** Spec 5.1 condition 1 (and 2, since the starting batch feeds the reasons). */
export function wakeReasonsAllowSilence(reasons) {
    return reasons.length > 0 && reasons.every((reason) => SILENCEABLE_WAKE_REASONS.has(reason));
}
/**
 * A silent Turn: woken only by system events, never consumed user input,
 * finished normally and showed the user no text. Its finish event carries
 * `silent: true` so clients neither notify nor mark it unread.
 */
export function isSilentTurn(input) {
    return (input.status === 'completed' &&
        !input.consumedUserInput &&
        !input.visibleText &&
        input.wakeReasons !== undefined &&
        wakeReasonsAllowSilence(input.wakeReasons));
}
export function renderWakeLine(reasons) {
    return `${WAKE_LINE_PREFIX}${orderWakeReasons(reasons).join(' ')}" />`;
}
/** Hidden, history-persisted `<wake>` line written right before a steered user message. */
export function createWakeLineMessage(reasons, timestamp) {
    return {
        role: 'custom',
        customType: WAKE_LINE_CUSTOM_TYPE,
        content: renderWakeLine(reasons),
        display: false,
        timestamp,
    };
}
function orderWakeReasons(reasons) {
    const present = new Set(reasons);
    return WAKE_REASON_ORDER.filter((reason) => present.has(reason));
}
/**
 * Origins are written by the runtime's own producers; each is trusted only
 * with the source that producer uses, so a forged origin on another source
 * cannot turn a user message into a silent system wake.
 */
function originWakeReason(source, origin) {
    if (!isRecord(origin))
        return undefined;
    return ORIGIN_WAKE_RULES.find((rule) => rule.sources.has(source) && rule.matches(origin))?.reason;
}
const ORIGIN_WAKE_RULES = [
    {
        reason: 'task_report',
        sources: new Set(['communication']),
        matches: (origin) => 'assignmentReport' in origin,
    },
    {
        reason: 'peer',
        sources: new Set(['communication']),
        matches: (origin) => parsePeerSessionOrigin(origin) !== undefined,
    },
    // A questionnaire answer requeued after its Turn closed comes back as `api`.
    {
        reason: 'user_answer',
        sources: new Set(['api', 'questionnaire']),
        matches: isOrdinaryQuestionnaireResponseOrigin,
    },
];
function companionWakeReason(companion) {
    const origin = companion.origin;
    if (parseBackgroundTaskDeliveryOrigin(origin))
        return 'background_task';
    if (parsePeerSessionOrigin(origin))
        return 'peer';
    if (isOrdinaryQuestionnaireResponseOrigin(origin))
        return 'user_answer';
    return 'user';
}
/** Composer and IM input; code review, Mini App and Goal Turns are their own producers. */
function isUserSource(source) {
    return (source === 'api' ||
        source === 'user' ||
        source === 'chat' ||
        source === 'channel' ||
        source.startsWith('channel:'));
}
function readString(value) {
    return typeof value === 'string' ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=turn-wake-reasons.js.map