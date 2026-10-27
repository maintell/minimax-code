import { MiniAppAgentError, } from '../contracts.js';
import { createFrameProjector, finalAssistantText, readTurnTerminal } from './projection.js';
/** A failure before anything was dispatched: nothing ran, so the caller may retry. */
export async function beforeDispatch(options, context, lookup) {
    try {
        return await lookup();
    }
    catch (error) {
        if (error instanceof MiniAppAgentError)
            throw error;
        options.logger.warn({ ...context, ...errorFields(error) }, 'Mini App Agent lookup failed before dispatch');
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent session is unavailable', true);
    }
}
/** Unknown outcome: something may have run or been recorded, so a blind retry is not safe. */
export function outcomeUnknown(message) {
    return new MiniAppAgentError('AGENT_OUTCOME_UNKNOWN', message);
}
export function errorFields(error) {
    return error instanceof Error
        ? { errorName: error.name, error: error.message }
        : { errorName: typeof error, error: String(error) };
}
/** Reads the next frame unless `stop` settles first; an unread frame stays for the next read. */
export async function read(source, stop) {
    source.pending ??= source.current.next();
    const result = await Promise.race([source.pending, stop]);
    if (typeof result !== 'symbol')
        source.pending = undefined;
    return result;
}
/** How long a cancelled run waits for its own terminal so the session is idle afterwards. */
export const ABORT_SETTLE_TIMEOUT_MS = 15_000;
/** Opens the session stream and the abort watch for one run; both are released when it settles. */
export async function withTurnStream(options, input, follow) {
    const source = {
        current: options.stream.resume({ sessionId: input.sessionId, waitForTerminal: true }),
    };
    const aborted = abortPromise(input.signal);
    try {
        return await follow(source, aborted.promise);
    }
    finally {
        aborted.dispose();
        await source.current.return?.();
    }
}
export async function pendingQuestionOf(options, agentName, sessionId) {
    const request = await options.questionnaires.getPending({ agentName, sessionId });
    return request
        ? { requestId: request.id, mode: request.mode ?? 'questionnaire', request }
        : undefined;
}
export async function followOwnedTurn(options, input, run) {
    try {
        return await followTurn(options, input, run);
    }
    catch (error) {
        // A Mini App Agent error here is raised after the turn ended or after its abort was
        // requested; anything else means the dispatched turn is no longer observed, so do not
        // leave it running without a caller.
        if (!(error instanceof MiniAppAgentError)) {
            await abortQuietly(options, input.sessionId, run.turnId);
        }
        throw error;
    }
}
export async function abortQuietly(options, sessionId, turnId) {
    try {
        await options.turns.abort({ sessionId, turnId, reason: 'miniapp-stream-lost' });
    }
    catch (error) {
        // Best effort; the original failure is what the caller sees.
        options.logger.warn({ stage: 'abort-unobserved-turn', sessionId, turnId, ...errorFields(error) }, 'Mini App Agent could not abort a turn it no longer observes');
    }
}
export function rejectedTurn() {
    return new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent turn was rejected', true);
}
/**
 * A delivery the caller no longer admits. Named `AbortError` so the turn system projects the
 * withdrawn turn as aborted, not failed; the caller sees the refusal itself.
 */
class DeliveryWithdrawnError extends Error {
    refusal;
    name = 'AbortError';
    constructor(refusal) {
        super('Mini App Agent delivery was withdrawn');
        this.refusal = refusal;
    }
}
/**
 * The gateway's last check as the TurnService `preDelivery` hook, which runs right before the
 * text reaches a turn, after every await inside the steer / submit; a throw withdraws it.
 */
export function preDeliveryCheck(beforeDelivery) {
    if (!beforeDelivery)
        return {};
    return {
        preDelivery: {
            accept: () => {
                try {
                    beforeDelivery();
                }
                catch (error) {
                    throw new DeliveryWithdrawnError(error);
                }
            },
        },
    };
}
/** Runs one steer / submit; a withdrawn delivery rejects with the gateway's refusal itself. */
export async function deliverChecked(deliver) {
    try {
        return await deliver();
    }
    catch (error) {
        if (error instanceof DeliveryWithdrawnError)
            throw error.refusal;
        throw error;
    }
}
async function followTurn(options, input, run) {
    const { sessionId } = input;
    const { source, turnId } = run;
    const projector = createFrameProjector(sessionId, turnId, input.model);
    for (;;) {
        const next = await read(source, run.aborted);
        if (next === ABORTED) {
            const abort = await options.turns.abort({ sessionId, turnId, reason: 'miniapp-cancelled' });
            const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
            return finish(input, confirmCancelled(options, { sessionId, turnId, abort, terminal }));
        }
        if (next.done)
            throw new Error('Session stream ended before the Mini App Agent turn terminal');
        const frame = next.value;
        // Frames without a turnId are session-level; frames of other turns are not this run's.
        if (frame.turnId !== undefined && frame.turnId !== turnId) {
            await resumeAfterStaleTerminal(options, sessionId, source, frame);
            continue;
        }
        if (frame.kind === 'turn-terminal') {
            return settleTerminal(options, input, run, frame.data);
        }
        emit(input.onEvent, projector.project(frame));
    }
}
/**
 * The resume iterator closes on any turn-terminal; a stale one from an earlier turn must not
 * end this run, so continue from its cursor (the ring replays what followed).
 */
export async function resumeAfterStaleTerminal(options, sessionId, source, frame) {
    if (frame.kind !== 'turn-terminal' || !frame.cursor)
        return;
    await source.current.return?.();
    source.current = options.stream.resume({
        sessionId,
        afterCursor: frame.cursor,
        waitForTerminal: true,
    });
}
/** A turn that ended on a questionnaire it raised reports it before `turn.finished`. */
async function settleTerminal(options, input, run, data) {
    const { sessionId } = input;
    const { turnId } = run;
    const result = await terminalResult(options, sessionId, turnId, data);
    if (result.status === 'aborted')
        return finish(input, result);
    let question;
    try {
        question = await findPendingQuestion(options, input, run);
    }
    catch (error) {
        options.logger.warn({ stage: 'pending-question-lookup', sessionId, turnId, ...errorFields(error) }, 'Mini App Agent pending questionnaire lookup failed');
        // The turn did end: deliver its terminal, but not as proof that nothing is pending.
        finish(input, result);
        throw outcomeUnknown('The Agent turn ended, but whether a question is pending could not be determined; ' +
            'inspect the session, then continue with run({ sessionId }) or answer');
    }
    if (!question)
        return finish(input, result);
    emit(input.onEvent, [
        {
            type: 'question.requested',
            sessionId,
            turnId,
            requestId: question.requestId,
            mode: question.mode,
            request: question.request,
        },
    ]);
    return finish(input, { ...result, pendingQuestion: question });
}
/**
 * Only a questionnaire created during this turn is its question; an older one left unanswered
 * is not re-reported.
 */
async function findPendingQuestion(options, input, run) {
    const { sessionId } = input;
    const agentName = (await options.repository.get(sessionId))?.agentName;
    const question = agentName ? await pendingQuestionOf(options, agentName, sessionId) : undefined;
    const createdAt = question?.request.createdAt;
    return createdAt === undefined || createdAt >= run.startedAtMs ? question : undefined;
}
/** Reads until the first turn-scoped frame, or the `stop` symbol; session-level frames have no turn. */
export async function nextTurnFrame(source, stop) {
    for (;;) {
        const next = await read(source, stop);
        if (typeof next === 'symbol')
            return next;
        if (next.done)
            throw new Error('Session stream ended before the Mini App Agent turn started');
        const frame = next.value;
        if (frame.turnId !== undefined)
            return { ...frame, turnId: frame.turnId };
    }
}
/**
 * A cancel is reported `aborted` only when the runtime acknowledged the abort or the turn's
 * own `aborted` terminal was seen. A timeout, an ended stream, or a turn that was no longer
 * running (it may have finished on its own) does not prove the abort.
 */
export function confirmCancelled(options, cancel) {
    const { sessionId, turnId, abort, terminal } = cancel;
    if (abort?.status === 'aborted' || terminal?.status === 'aborted') {
        return { turnId, status: 'aborted' };
    }
    options.logger.warn({
        stage: 'cancel-confirmation',
        sessionId,
        turnId,
        abortStatus: abort?.status ?? 'not-requested',
        terminalStatus: terminal ? (terminal.status ?? 'missing') : 'not-observed',
    }, 'Mini App Agent cancel was not confirmed');
    const observed = terminal?.status;
    throw outcomeUnknown(observed === undefined
        ? 'Mini App Agent run was cancelled but the abort was not confirmed'
        : `Mini App Agent run was cancelled but the turn ended on its own first (terminal status: ${observed}); inspect the session before continuing`);
}
export function prepend(frame, rest) {
    let head = frame;
    const iterator = {
        [Symbol.asyncIterator]: () => iterator,
        next() {
            if (!head)
                return rest.next();
            const value = head;
            head = undefined;
            return Promise.resolve({ done: false, value });
        },
        return: () => rest.return?.() ?? Promise.resolve({ done: true, value: undefined }),
    };
    return iterator;
}
/**
 * Waits (bounded) for the aborted turn's own terminal so a follow-up run finds the session
 * idle; undefined when it was not seen (timeout or the stream ended).
 */
export async function settleAbortedTurn(options, sessionId, source, turnId) {
    const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
    try {
        for (;;) {
            const next = await read(source, deadline.promise);
            if (next === TIMED_OUT || next.done)
                return undefined;
            if (next.value.kind === 'turn-terminal' && next.value.turnId === turnId) {
                return { status: readString(next.value.data, 'status') };
            }
            if (next.value.turnId !== turnId) {
                await resumeAfterStaleTerminal(options, sessionId, source, next.value);
            }
        }
    }
    finally {
        deadline.dispose();
    }
}
export const TIMED_OUT = Symbol('timed-out');
export function timeoutPromise(ms) {
    let timer;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return { promise, dispose: () => clearTimeout(timer) };
}
export const ABORTED = Symbol('aborted');
function abortPromise(signal) {
    if (!signal)
        return { promise: new Promise(() => undefined), dispose: () => undefined };
    let onAbort = () => undefined;
    const promise = new Promise((resolve) => {
        onAbort = () => resolve(ABORTED);
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
    return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}
/**
 * The final event carries the settled result, so it is emitted only once that result exists;
 * a result without a turn (nothing ran) has no `turn.finished`.
 */
export function finish(input, result) {
    if (result.turnId === undefined)
        return result;
    const reported = { ...result, model: input.model };
    emit(input.onEvent, [
        {
            type: 'turn.finished',
            sessionId: input.sessionId,
            turnId: result.turnId,
            status: result.status,
            ...(result.text === undefined ? {} : { text: result.text }),
            ...(result.error ? { error: result.error } : {}),
        },
    ]);
    return reported;
}
export function emit(onEvent, events) {
    if (!onEvent)
        return;
    for (const event of events) {
        try {
            onEvent(event);
        }
        catch {
            // A listener failure must not break the run.
        }
    }
}
async function terminalResult(options, sessionId, turnId, data) {
    const terminal = readTurnTerminal(data);
    if (!terminal) {
        // Malformed terminal data says nothing about how the turn ended.
        options.logger.warn({
            stage: 'turn-terminal',
            sessionId,
            turnId,
            terminalStatus: readField(data, 'status') ?? null,
        }, 'Mini App Agent turn terminal has no known status');
        throw outcomeUnknown('Mini App Agent turn ended with an unreadable result');
    }
    if (terminal.status !== 'finished')
        return { turnId, ...terminal };
    const text = finalAssistantText(await options.messages.listTurn(sessionId, turnId));
    return { turnId, status: 'finished', ...(text ? { text } : {}) };
}
export function readString(value, key) {
    const field = readField(value, key);
    return typeof field === 'string' ? field : undefined;
}
export function readNumber(value, key) {
    const field = readField(value, key);
    return typeof field === 'number' ? field : undefined;
}
export function readField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    return value[key];
}
//# sourceMappingURL=turn-follow.js.map