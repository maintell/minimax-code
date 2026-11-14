import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { ASK_USER_TOOL_NAME } from '@mavis/shared/questionnaire';
import { hasVisibleAssistantText, isSilentTurn, isUserSourcedWakeReason, resolveInputWakeReason, wakeReasonsAllowSilence, } from '../../service/turn-system/index.js';
/** Turns whose terminal never arrived are dropped oldest first past this many. */
const MAX_TRACKED_SILENCE_FACTS = 512;
/**
 * Bunny's silent Turns (spec 5.1): a Bunny Turn woken by system events alone
 * that consumed no user input and showed no text finishes silent, which its
 * `session.finish` carries. It observes the Turn's events next to the shared
 * lifecycle observer and adds `silent` to the terminal event through that
 * observer's terminal extension.
 */
export class BunnyTurnSilenceObserver {
    options;
    silenceFacts = new Map();
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * Steering consumption callback: a Turn that took in user input (a steered
     * message, a questionnaire answer, an IM follow-up) is never silent. Peer,
     * cron and background-task steering are system input.
     */
    recordConsumedSteering(input) {
        const reason = resolveInputWakeReason({
            provenance: input.message.provenance,
            origin: input.message.message.origin,
        });
        if (isUserSourcedWakeReason(reason))
            this.silenceFactsFor(input).consumedUserInput = true;
        if (isImportantUpdate(reason))
            this.silenceFactsFor(input).importantUpdate = true;
    }
    /**
     * A user's answer to `ask_user` that came back as the tool result (the
     * in-Turn wait) never passes the steering callback; the committed result
     * marks the Turn as having consumed user input. A deadline answer is the
     * runtime's, not the user's.
     */
    observeHistoryCommitted(input) {
        if (input.change.messages.some(isUserAnsweredAskUserResult)) {
            this.silenceFactsFor(input.context).consumedUserInput = true;
        }
    }
    /**
     * Only a system-woken Bunny Turn can be silent (`tracked`); every Bunny Turn
     * records when its first visible text arrived (spec 17.1). Recorded
     * synchronously: events arrive in order, so the terminal decision always
     * sees every earlier text event.
     */
    observeRuntimeEvent(input) {
        const { context, event } = input;
        if (context.resourceAgentName !== BUNNY_AGENT_NAME)
            return;
        const facts = this.silenceFactsFor(context);
        const now = this.options.nowMs ?? Date.now;
        facts.startedAtMs ??= now();
        if (tracksSilence(context))
            facts.tracked = true;
        if (context.wakeReasons?.some(isImportantUpdate))
            facts.importantUpdate = true;
        if (!hasVisibleAssistantText(event))
            return;
        // The visible-text predicate has already validated this projected message.
        const response = JSON.parse(event.payload.stream_resp);
        facts.notificationMessageId = response.agent_message?.msg_id;
        facts.visibleText = true;
        facts.firstVisibleTextAtMs ??= now();
    }
    payload(turn) {
        if (turn.status !== 'completed' || turn.agentName !== BUNNY_AGENT_NAME)
            return undefined;
        if (this.isSilent(turn))
            return { silent: true };
        const facts = this.silenceFacts.get(turnKey(turn.context));
        // Acknowledgements and ordinary progress do not need a system notification.
        return facts?.importantUpdate && facts.notificationMessageId
            ? { bunnyNotification: { messageId: facts.notificationMessageId } }
            : undefined;
    }
    published(turn) {
        const { context, status } = turn;
        const key = turnKey(context);
        try {
            const report = this.options.turnEnded;
            if (!report || turn.agentName !== BUNNY_AGENT_NAME)
                return;
            const facts = this.silenceFacts.get(key);
            report({
                sessionId: context.sessionId,
                turnId: context.turnId,
                status,
                silent: status === 'completed' && this.isSilent(turn),
                consumedUserInput: consumedUserInput(context, facts),
                wakeReasons: context.wakeReasons ?? [],
                ...firstVisibleText(facts),
                ...turnModel(context),
            });
        }
        catch {
            // The trace never changes how the Turn ends.
        }
        finally {
            this.silenceFacts.delete(key);
        }
    }
    /** Spec 5.1: only a Bunny Turn can be silent, and only on a normal finish. */
    isSilent(turn) {
        if (turn.agentName !== BUNNY_AGENT_NAME)
            return false;
        const facts = this.silenceFacts.get(turnKey(turn.context));
        if (!facts?.tracked)
            return false;
        return isSilentTurn({
            wakeReasons: turn.context.wakeReasons,
            consumedUserInput: facts.consumedUserInput,
            visibleText: facts.visibleText,
            status: turn.status,
        });
    }
    silenceFactsFor(turn) {
        const key = turnKey(turn);
        let facts = this.silenceFacts.get(key);
        if (!facts) {
            facts = { tracked: false, consumedUserInput: false, visibleText: false };
            this.silenceFacts.set(key, facts);
            if (this.silenceFacts.size > MAX_TRACKED_SILENCE_FACTS) {
                this.silenceFacts.delete(this.silenceFacts.keys().next().value);
            }
        }
        return facts;
    }
}
function tracksSilence(context) {
    return (context.resourceAgentName === BUNNY_AGENT_NAME &&
        context.wakeReasons !== undefined &&
        wakeReasonsAllowSilence(context.wakeReasons));
}
/**
 * Spec 17.1 "是否消费过用户来源的输入": the starting batch carried user input,
 * or the Turn took in a steered message or an answer from the user.
 */
function consumedUserInput(context, facts) {
    return (facts?.consumedUserInput === true ||
        (context.wakeReasons ?? []).some((reason) => isUserSourcedWakeReason(reason)));
}
function firstVisibleText(facts) {
    if (facts?.startedAtMs === undefined || facts.firstVisibleTextAtMs === undefined)
        return {};
    return { firstVisibleTextMs: Math.max(0, facts.firstVisibleTextAtMs - facts.startedAtMs) };
}
/** The ID of the model the Turn ran on, as its execution context resolved it. */
function turnModel(context) {
    const id = context.executionModel
        ? Reflect.get(context.executionModel, 'id')
        : undefined;
    return typeof id === 'string' && id.trim() ? { model: id.trim() } : {};
}
function isUserAnsweredAskUserResult(message) {
    if (!message || typeof message !== 'object')
        return false;
    if (Reflect.get(message, 'role') !== 'toolResult')
        return false;
    if (Reflect.get(message, 'toolName') !== ASK_USER_TOOL_NAME)
        return false;
    const details = Reflect.get(message, 'details');
    return (!!details &&
        typeof details === 'object' &&
        Reflect.get(details, 'answered') === true &&
        Reflect.get(details, 'auto_selected') !== true);
}
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
function isImportantUpdate(reason) {
    return (reason !== undefined &&
        ['task_report', 'cron', 'self_reminder', 'background_task'].includes(reason));
}
//# sourceMappingURL=bunny-turn-silence.js.map