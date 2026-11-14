import { streamSimple, } from '@earendil-works/pi-ai';
import { readTurnRequestPhase } from './turn-timing.js';
export function createLLMCallPreemption(options) {
    let target;
    return {
        ...(options?.onResponseDiscarded ? { onResponseDiscarded: options.onResponseDiscarded } : {}),
        ...(options?.onResendFallback ? { onResendFallback: options.onResendFallback } : {}),
        ...(options?.wakeReasons ? { wakeReasons: options.wakeReasons } : {}),
        ...(options?.interruptedUserMessage
            ? { interruptedUserMessage: options.interruptedUserMessage }
            : {}),
        ...(options?.deliversOnToolStart ? { deliversOnToolStart: options.deliversOnToolStart } : {}),
        request: () => target?.preempt() ?? 'not-streaming',
        bind(next) {
            target = next;
            return () => {
                if (target === next)
                    target = undefined;
            };
        },
    };
}
export const LLM_CALL_PREEMPTED_CUSTOM_TYPE = 'llm_call_preempted';
export const LLM_CALL_PREEMPTED_NOTICE = 'Your previous response was interrupted by a new user message before it finished. ' +
    'It was discarded and not saved: none of its text was delivered and none of its tool ' +
    'calls ran. Anything it was about to write or change did not happen. Tool results that ' +
    'appear earlier in this conversation did complete.';
const LLM_CALL_PREEMPTED_AFTER_DELIVERY_NOTICE = 'Your previous response was interrupted by a new user message before it finished. ' +
    'Part of it had already been shown to the user, so do not assume the user saw nothing. ' +
    'Calls that had not started did not run. Tool results that appear earlier in this ' +
    'conversation did complete.';
const MAX_SUMMARY_BLOCK_CHARS = 800;
const MAX_INTERRUPTED_MESSAGE_CHARS = 1200;
const MAX_SUMMARY_CHARS = 2400;
/** The work a non-user wake reason stands for; an unknown reason is shown as it is. */
const INTERRUPTED_WORK = {
    task_report: 'a task report',
    cron: 'a scheduled run',
    self_reminder: 'a reminder you set',
    background_task: 'a finished background task',
    peer: 'a message from another session',
};
export function llmCallPreemptedNotice(input) {
    const draft = input.discardedSummary
        ? 'What the discarded response was generating (your own unfinished draft, not a new ' +
            `request):\n<discarded_response>\n${input.discardedSummary}\n</discarded_response>`
        : undefined;
    return {
        role: 'custom',
        customType: LLM_CALL_PREEMPTED_CUSTOM_TYPE,
        content: [
            input.delivered ? LLM_CALL_PREEMPTED_AFTER_DELIVERY_NOTICE : LLM_CALL_PREEMPTED_NOTICE,
            owedToUser(input),
            ...interruptedWork(input.interruptedUserMessage),
            ...(draft ? [draft] : []),
        ].join('\n\n'),
        display: false,
        timestamp: input.timestamp,
    };
}
/**
 * The earlier user message next to the new one: what it asked for is checked
 * against what the conversation shows was done, so finished work is not
 * repeated and unfinished work is not dropped.
 */
function interruptedWork(message) {
    const text = message?.trim();
    if (!text)
        return [];
    const quoted = clipTo(text, MAX_INTERRUPTED_MESSAGE_CHARS).replaceAll('</interrupted_user_message>', '<\\/interrupted_user_message>');
    return [
        'Before the new message you were working on this earlier user message:\n' +
            `<interrupted_user_message>\n${quoted}\n</interrupted_user_message>\n` +
            'Check each thing it asked for against what this conversation shows was done. Do not ' +
            'repeat what is done. Do what is not done yet, including calls in the discarded draft, ' +
            'which did not run, unless the new message changes or cancels them. Then answer the new ' +
            'message.',
    ];
}
/** What the model still owes the user before it answers the message that interrupted it. */
function owedToUser(input) {
    const work = (input.wakeReasons ?? [])
        .filter((reason) => reason !== 'user' && reason !== 'user_answer')
        .map((reason) => INTERRUPTED_WORK[reason] ?? reason);
    if (work.length > 0) {
        const state = input.delivered
            ? 'Its conclusion may have reached the user only in part.'
            : 'Its conclusion has not been told to the user yet.';
        return (`Before the interruption you were handling ${work.join(' and ')}. ${state} Tell the user ` +
            'what they are still missing first, then answer the new message. Skip this only if it ' +
            'holds nothing the user needs.');
    }
    if (input.discardedSummary) {
        return ('What you were about to say may not have reached the user. If the draft below holds ' +
            'something they still need, tell them first, then answer the new message.');
    }
    return 'Read the new user message and continue.';
}
/** A bounded view of a partial response: its text, its tool calls and the end of its thinking. */
export function summarizeDiscardedResponse(message) {
    const parts = (message?.content ?? []).flatMap((block) => {
        if (block.type === 'text')
            return block.text.trim() ? [clip(block.text.trim())] : [];
        if (block.type === 'thinking') {
            const thinking = block.thinking.trim();
            return thinking ? [`[thinking] ${thinking.slice(-MAX_SUMMARY_BLOCK_CHARS)}`] : [];
        }
        return [`[tool call, did not run] ${block.name} ${clip(JSON.stringify(block.arguments))}`];
    });
    if (parts.length === 0)
        return undefined;
    return parts
        .join('\n')
        .slice(0, MAX_SUMMARY_CHARS)
        .replaceAll('</discarded_response>', '<\\/discarded_response>');
}
function clip(text) {
    return clipTo(text, MAX_SUMMARY_BLOCK_CHARS);
}
function clipTo(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
const PREEMPTED = Symbol('llm-call-preempted');
/**
 * Wrap the main stream function so the host can end the call in flight.
 *
 * The inner request is aborted through a linked signal and released without
 * being awaited; the returned stream ends immediately with an empty `stop`
 * response, so Pi neither ends its loop (as it would on `aborted`) nor runs a
 * half-written tool call. The event handler discards that response by
 * identity and the next steering poll resends.
 */
export function withLLMCallPreemption(inner, state, nowMs, readWakeReasons, readInterruptedUserMessage) {
    const base = inner ?? streamSimple;
    return (async (model, context, options) => {
        const controller = new AbortController();
        const callerSignal = options?.signal;
        const onCallerAbort = () => controller.abort(callerSignal?.reason);
        if (callerSignal?.aborted)
            controller.abort(callerSignal.reason);
        else
            callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
        delete state.deliveredInCall;
        const wakeReasons = readWakeReasons?.();
        const interruptedUserMessage = readInterruptedUserMessage?.();
        let partial;
        let finished = false;
        let preempted = false;
        let resolvePreempted;
        const preemptedSignal = new Promise((resolve) => {
            resolvePreempted = resolve;
        });
        const call = {
            preempt: () => {
                // Text the user already read is never retracted: steering waits for the next call.
                if (finished || preempted || controller.signal.aborted || state.deliveredInCall) {
                    return false;
                }
                preempted = true;
                resolvePreempted(PREEMPTED);
                controller.abort(new LLMCallPreemptedError());
                return true;
            },
        };
        const finish = () => {
            if (finished)
                return;
            finished = true;
            callerSignal?.removeEventListener('abort', onCallerAbort);
            if (state.active === call)
                delete state.active;
        };
        const preemptedMessage = () => {
            const message = {
                role: 'assistant',
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'stop',
                timestamp: nowMs(),
            };
            state.discardMessage = message;
            const phase = readTurnRequestPhase(options);
            if (phase)
                state.resendPhase = phase;
            const discardedSummary = summarizeDiscardedResponse(partial);
            state.discarded = {
                ...(discardedSummary ? { discardedSummary } : {}),
                ...(wakeReasons ? { wakeReasons } : {}),
                ...(interruptedUserMessage ? { interruptedUserMessage } : {}),
                ...(state.deliveredInCall ? { delivered: true } : {}),
            };
            return message;
        };
        const preemptedStream = () => {
            finish();
            const message = preemptedMessage();
            const done = { type: 'done', reason: 'stop', message };
            let sent = false;
            return {
                [Symbol.asyncIterator]: () => ({
                    next: async () => {
                        if (sent)
                            return { value: undefined, done: true };
                        sent = true;
                        return { value: done, done: false };
                    },
                }),
                result: async () => message,
            };
        };
        state.active = call;
        let opened;
        try {
            const pending = Promise.resolve(base(model, context, { ...(options ?? {}), signal: controller.signal }));
            pending.catch(() => undefined);
            opened = await Promise.race([preemptedSignal, pending]);
            if (opened === PREEMPTED) {
                void pending.then((late) => releaseIterator(late[Symbol.asyncIterator]()), () => undefined);
            }
        }
        catch (error) {
            if (preempted)
                return preemptedStream();
            finish();
            throw error;
        }
        if (opened === PREEMPTED)
            return preemptedStream();
        const stream = opened;
        let message;
        async function* read() {
            const iterator = stream[Symbol.asyncIterator]();
            let completed = false;
            try {
                for (;;) {
                    const next = await Promise.race([preemptedSignal, iterator.next()]);
                    if (next === PREEMPTED) {
                        finish();
                        message = preemptedMessage();
                        yield { type: 'done', reason: 'stop', message };
                        return;
                    }
                    if (next.done) {
                        completed = true;
                        return;
                    }
                    if ('partial' in next.value)
                        partial = next.value.partial;
                    if (next.value.type === 'done' || next.value.type === 'error') {
                        completed = true;
                        finish();
                    }
                    yield next.value;
                }
            }
            finally {
                finish();
                if (!completed)
                    releaseIterator(iterator);
            }
        }
        const events = read();
        return {
            [Symbol.asyncIterator]: () => events,
            result: async () => {
                if (message)
                    return message;
                const result = stream.result();
                result.catch(() => undefined);
                const final = await Promise.race([preemptedSignal, result]);
                if (final === PREEMPTED) {
                    message ??= preemptedMessage();
                    return message;
                }
                finish();
                return final;
            },
        };
    });
}
/** True for the signal of a call this wrapper ended; its abort is not a Turn failure. */
export function isLLMCallPreempted(signal) {
    return signal?.reason instanceof LLMCallPreemptedError;
}
export class LLMCallPreemptedError extends Error {
    name = 'AbortError';
    constructor() {
        super('LLM call preempted by new user input');
    }
}
/** Ask the inner stream to stop without waiting on one that may never settle. */
function releaseIterator(iterator) {
    void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
}
//# sourceMappingURL=llm-preemption.js.map