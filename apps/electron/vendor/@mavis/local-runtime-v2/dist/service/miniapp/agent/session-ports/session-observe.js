import { MINIAPP_AGENT_SESSION_LIST_LIMIT, } from '../contracts.js';
import { modelSelectionFromRecord } from '../model-selection.js';
import { createFrameProjector, finalAssistantText, readTurnTerminal, } from './projection.js';
/** Assistant messages read back to find the latest reply of a whole session. */
const RECENT_ASSISTANT_MESSAGES = 20;
/** Kinds the user's own session list leaves out: scheduled runs and peek side sessions. */
const UNLISTED_SESSION_KINDS = ['peek', 'cron'];
/**
 * The user's conversations, as their session list shows them: not hidden (every Mini App's own
 * session is), not a delegated child, not a scheduled (cron) run nor a peek.
 */
function isListed(record) {
    return unlistedReason(record) === undefined;
}
function unlistedReason(record) {
    if (record.visibility === 'hidden')
        return 'hidden';
    if (record.parentSessionId)
        return 'child';
    if (record.miniAppOrigin)
        return 'miniapp-origin';
    if (UNLISTED_SESSION_KINDS.includes(record.sessionKind))
        return 'session-kind';
    return record.originCronId ? 'cron-origin' : undefined;
}
const SESSION_STATUS = {
    idle: 'idle',
    started: 'running',
    error: 'error',
    aborted: 'aborted',
    interrupted: 'aborted',
};
function toSummary(record) {
    return {
        sessionId: record.sessionId,
        ...(record.title ? { title: record.title } : {}),
        agent: record.agentName,
        status: SESSION_STATUS[record.status],
        workspaceDir: record.workspaceDir,
        isDefaultWorkspace: record.isDefaultWorkspace === true,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
    };
}
/** What `session` adds to the summary from the record: its model, and the error of a failed session. */
function toDetail(record) {
    const model = modelSelectionFromRecord(record);
    const message = record.status === 'error' ? record.errorMessage : undefined;
    return { ...(model ? { model } : {}), ...(message ? { error: { message } } : {}) };
}
export async function listObservableSessions(options) {
    const records = await options.repository.list({
        includeHidden: false,
        parentSessionId: null,
        archived: false,
        excludeSessionKinds: UNLISTED_SESSION_KINDS,
        originCronId: null,
        limit: MINIAPP_AGENT_SESSION_LIST_LIMIT,
    });
    // The query already excludes everything `isListed` does (a Mini App's own session is hidden);
    // a record still dropped here came from a creation path that broke that rule and shortens the list.
    return records
        .filter((record) => {
        const reason = unlistedReason(record);
        if (reason) {
            options.logger.warn({ stage: 'observe-list', sessionId: record.sessionId, reason }, 'Mini App Agent session list query returned a session it should have excluded');
        }
        return !reason;
    })
        .map(toSummary);
}
export async function findObservableSession(options, sessionId) {
    const record = await options.repository.get(sessionId);
    if (!record)
        return undefined;
    const ownerPluginId = record.miniAppOrigin?.pluginId;
    return {
        summary: toSummary(record),
        detail: toDetail(record),
        ...(ownerPluginId ? { ownerPluginId } : {}),
        listed: isListed(record),
    };
}
export async function lastAssistantText(options, sessionId) {
    return finalAssistantText(await options.messages.listRecent(sessionId, {
        limit: RECENT_ASSISTANT_MESSAGES,
        role: 'assistant',
    }));
}
function isLifecycleEvent(event) {
    return (event.type === 'session.start' ||
        event.type === 'session.finish' ||
        event.type === 'session.error' ||
        event.type === 'session.abort');
}
/**
 * Projects turn lifecycle of every listed session from the global events until `signal`
 * aborts. Events are projected one at a time so each session's turns keep their order.
 */
export function observeAllSessions(options, input) {
    const { signal } = input;
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        let open = true;
        let tail = Promise.resolve();
        const sink = eventSink(options, input.onEvent, () => open);
        const deliver = (event) => sink([event]);
        const unsubscribe = options.eventBus.subscribe({
            next(event) {
                if (!open || !isLifecycleEvent(event))
                    return;
                tail = projectAfter(tail, () => projectLifecycle(options, event, deliver));
            },
        });
        signal.addEventListener('abort', () => {
            open = false;
            unsubscribe();
            resolve();
        }, { once: true });
    });
}
async function projectAfter(previous, next) {
    await previous;
    await next();
}
/** The terminal a global terminal event reports; `session.error` carries its error source. */
function lifecycleTerminal(event) {
    if (event.type === 'session.finish')
        return { status: 'finished' };
    if (event.type === 'session.abort')
        return { status: 'aborted' };
    return (readTurnTerminal({ status: 'failed', errorSource: event.payload.errorSource }) ?? {
        status: 'aborted',
    });
}
async function projectLifecycle(options, event, deliver) {
    const { sessionId, turnId } = event.payload;
    if (!turnId)
        return;
    try {
        const record = await options.repository.get(sessionId);
        if (!record || !isListed(record))
            return;
        const titled = record.title ? { title: record.title } : {};
        if (event.type === 'session.start') {
            const model = modelSelectionFromRecord(record);
            deliver({ type: 'turn.started', sessionId, turnId, ...(model ? { model } : {}), ...titled });
            return;
        }
        await deliverTerminal(options, { sessionId, turnId, titled }, lifecycleTerminal(event), deliver);
    }
    catch (error) {
        options.logger.warn({
            stage: 'observe-lifecycle',
            sessionId,
            turnId,
            eventType: event.type,
            ...errorFields(error),
        }, 'Mini App Agent session observer could not project an event');
    }
}
async function deliverTerminal(options, turn, terminal, deliver) {
    const { sessionId, turnId, titled } = turn;
    const text = await readFinalText(options, sessionId, turnId, terminal);
    if (text)
        deliver({ type: 'message.committed', sessionId, turnId, text, ...titled });
    deliver({
        type: 'turn.finished',
        sessionId,
        turnId,
        ...terminal,
        ...(text ? { text } : {}),
        ...titled,
    });
}
const STOPPED = Symbol('stopped');
/**
 * Follows every turn of one session until `signal` aborts or its stream ends (the session
 * was deleted or the runtime is closing). Each resume iterator closes on a turn terminal, so
 * the next turn is picked up by resuming from that terminal's cursor. Every read races the
 * signal, and nothing is delivered once it aborted.
 */
export async function observeOneSession(options, input) {
    if (input.signal.aborted)
        return;
    const follower = createSessionFollower(options, input);
    try {
        if (!(await follower.stillExists()))
            return;
        for (;;) {
            const frame = await follower.next();
            if (!frame || !(await follower.handle(frame)))
                return;
        }
    }
    finally {
        await follower.close();
    }
}
/** One single-session subscription: the resume iterator, the turn it is in, and the stop race. */
function createSessionFollower(options, input) {
    const { sessionId, signal } = input;
    const stopped = stopPromise(signal);
    const untilStopped = (work) => Promise.race([work, stopped.promise]);
    const deliver = eventSink(options, input.onEvent, () => !signal.aborted);
    const resume = (afterCursor) => options.stream.resume({
        sessionId,
        ...(afterCursor ? { afterCursor } : {}),
        waitForTerminal: true,
    });
    let source = resume(undefined);
    let pending;
    let turn;
    // Checked after each resume: resuming a deleted session would wait forever, while a session
    // deleted after the check ends the iterator just opened.
    const stillExists = async () => (await untilStopped(sessionExists(options, sessionId))) === true;
    const reopen = async (afterCursor) => {
        await source.return?.();
        pending = undefined;
        turn = undefined;
        source = resume(afterCursor);
        return stillExists();
    };
    /** The turn a frame belongs to; the model is read as the turn starts (a run may switch it). */
    const enterTurn = async (turnId) => {
        if (turn?.turnId === turnId)
            return turn;
        const model = await untilStopped(readSessionModel(options, sessionId));
        if (model === STOPPED)
            return undefined;
        turn = { turnId, projector: createFrameProjector(sessionId, turnId, model) };
        return turn;
    };
    return {
        stillExists,
        /** The next frame; undefined once stopped or the stream ended. */
        async next() {
            pending ??= source.next();
            const next = await untilStopped(pending);
            pending = undefined;
            return next === STOPPED || next.done ? undefined : next.value;
        },
        /** False once the subscription is over. */
        async handle(frame) {
            if (frame.kind === 'resync-required')
                return reopen(undefined);
            if (frame.turnId === undefined)
                return true;
            const current = await enterTurn(frame.turnId);
            if (!current)
                return false;
            if (frame.kind !== 'turn-terminal') {
                deliver(current.projector.project(frame));
                return true;
            }
            const finished = await untilStopped(readTurnFinished(options, sessionId, current.turnId, frame.data));
            if (finished === STOPPED)
                return false;
            if (finished)
                deliver([finished]);
            return reopen(frame.cursor);
        },
        async close() {
            stopped.dispose();
            await source.return?.();
        },
    };
}
/** A failed lookup counts as present: the stream itself ends if the session is gone. */
async function sessionExists(options, sessionId) {
    try {
        return (await options.repository.get(sessionId)) !== undefined;
    }
    catch (error) {
        options.logger.warn({ stage: 'observe-session', sessionId, ...errorFields(error) }, 'Mini App Agent session observer could not confirm the session');
        return true;
    }
}
/** The session's current model; undefined when it cannot be read, so `turn.started` omits it. */
async function readSessionModel(options, sessionId) {
    try {
        const record = await options.repository.get(sessionId);
        return record ? modelSelectionFromRecord(record) : undefined;
    }
    catch (error) {
        options.logger.warn({ stage: 'observe-model', sessionId, ...errorFields(error) }, 'Mini App Agent session observer could not read the session model');
        return undefined;
    }
}
/** `turn.finished` with the final reply of a finished turn; undefined for unknown terminal data. */
async function readTurnFinished(options, sessionId, turnId, data) {
    const terminal = readTurnTerminal(data);
    if (!terminal)
        return undefined;
    const text = await readFinalText(options, sessionId, turnId, terminal);
    return { type: 'turn.finished', sessionId, turnId, ...terminal, ...(text ? { text } : {}) };
}
/**
 * The final reply of a finished turn; nothing for other outcomes. The reply is optional: a failed
 * read still lets the turn finish, just without text.
 */
async function readFinalText(options, sessionId, turnId, terminal) {
    if (terminal.status !== 'finished')
        return undefined;
    try {
        return finalAssistantText(await options.messages.listTurn(sessionId, turnId));
    }
    catch (error) {
        options.logger.warn({ stage: 'observe-final-text', sessionId, turnId, ...errorFields(error) }, 'Mini App Agent session observer could not read the final reply');
        return undefined;
    }
}
function stopPromise(signal) {
    let onAbort = () => undefined;
    const promise = new Promise((resolve) => {
        onAbort = () => resolve(STOPPED);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}
/**
 * Delivers events while `isOpen()`. A subscriber failure never ends the subscription; the first
 * one is logged so a broken handler is visible on the Host.
 */
function eventSink(options, onEvent, isOpen) {
    let reported = false;
    return (events) => {
        for (const event of events) {
            if (!isOpen())
                return;
            try {
                onEvent(event);
            }
            catch (error) {
                if (reported)
                    continue;
                reported = true;
                options.logger.warn({ stage: 'observe-deliver', sessionId: event.sessionId, ...errorFields(error) }, 'Mini App Agent session observer subscriber threw; later failures are not logged');
            }
        }
    };
}
function errorFields(error) {
    return error instanceof Error
        ? { errorName: error.name, error: error.message }
        : { errorName: typeof error, error: String(error) };
}
//# sourceMappingURL=session-observe.js.map