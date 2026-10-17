import { BoundedRing, SubscriberRegistry, measureValue, } from '../../../infra/sse/index.js';
import { SessionFrameRetention, sessionRingOptions, } from './session-frame-retention.js';
export class SessionStreamService {
    options;
    states = new Map();
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    write(input) {
        const state = this.state(input.sessionId);
        const value = {
            identity: input.identity,
            sessionId: input.sessionId,
            kind: input.kind,
            data: input.data,
            createdAtMs: input.createdAtMs ?? this.nowMs(),
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(input.messageActionDeltas ? { messageActionDeltas: input.messageActionDeltas } : {}),
        };
        const retained = state.retention.classify(value);
        const appended = state.ring.append({
            identity: input.identity,
            value: retained,
            byteSize: state.measure(value),
        });
        state.hasFrames = true;
        const frame = { ...appended.value.frame, cursor: appended.cursor };
        if (appended.appended)
            state.subscribers.publish(frame, appended.byteSize);
        return { appended: appended.appended, retained: appended.retained, frame };
    }
    reserve(sessionId) {
        const state = this.state(sessionId);
        const subscription = state.subscribers.subscribe();
        state.reservationCount += 1;
        let closed = false;
        const close = () => {
            if (closed)
                return;
            closed = true;
            subscription.close();
            state.reservationCount -= 1;
        };
        const complete = () => {
            if (closed)
                return;
            closed = true;
            subscription.complete();
            state.reservationCount -= 1;
        };
        return {
            source: subscription,
            bindTurn: (turnId) => subscription.setFilter((frame) => frame.turnId === turnId),
            complete,
            close,
            discardIfEmpty: () => {
                close();
                if (!state.hasFrames &&
                    state.reservationCount === 0 &&
                    this.states.get(sessionId) === state) {
                    this.states.delete(sessionId);
                }
            },
        };
    }
    resume(input) {
        return new SessionResumeIterator(this.state(input.sessionId), input, this.options.messages, this.nowMs);
    }
    deleteSession(sessionId) {
        const state = this.states.get(sessionId);
        if (!state)
            return;
        state.deleted = true;
        state.subscribers.close();
        this.states.delete(sessionId);
    }
    dispose() {
        this.states.forEach((state) => {
            state.deleted = true;
            state.subscribers.close();
        });
        this.states.clear();
    }
    state(sessionId) {
        const existing = this.states.get(sessionId);
        if (existing)
            return existing;
        const retention = new SessionFrameRetention();
        const created = {
            ring: new BoundedRing({
                ...sessionRingOptions(this.options.ring),
                cursorScope: `session:${sessionId}`,
            }, (snapshot) => retention.selectEvictionCount(snapshot)),
            subscribers: new SubscriberRegistry(this.options.subscribers),
            retention,
            measure: this.options.ring?.measure ?? measureValue,
            hasFrames: false,
            reservationCount: 0,
            deleted: false,
        };
        this.states.set(sessionId, created);
        return created;
    }
}
class SessionResumeIterator {
    state;
    input;
    messages;
    nowMs;
    live;
    initialized;
    initializationObserver;
    replay = [];
    closeAfterReplay = false;
    closed = false;
    constructor(state, input, messages, nowMs) {
        this.state = state;
        this.input = input;
        this.messages = messages;
        this.nowMs = nowMs;
        this.live = state.subscribers.subscribe();
        this.initialized = this.initialize();
        this.initializationObserver = observeInitialization(this.initialized);
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    async next() {
        if (this.closed || this.state.deleted) {
            this.close();
            return done();
        }
        await this.initialized;
        await this.initializationObserver;
        if (this.closed || this.state.deleted) {
            this.close();
            return done();
        }
        const replayed = this.replay.shift();
        if (replayed)
            return this.frame(replayed);
        if (this.closeAfterReplay) {
            this.close();
            return done();
        }
        try {
            const result = await this.live.next();
            if (result.done)
                this.close();
            return result.done ? result : this.frame(result.value);
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    return() {
        this.close();
        return Promise.resolve(done());
    }
    async initialize() {
        const waitForTerminal = this.input.waitForTerminal ?? true;
        if (this.initializeUnanchored(waitForTerminal))
            return;
        const initial = this.state.ring.replay(this.input.afterCursor);
        if (initial.status !== 'ok') {
            this.finishWithResync(initial.status);
            return;
        }
        if (hasCursor(this.input.afterCursor)) {
            this.finishCursorReplay(initial.entries, waitForTerminal);
            return;
        }
        await this.initializeDurable(initial.entries, waitForTerminal);
    }
    async initializeDurable(initial, waitForTerminal) {
        const initialWatermark = this.state.ring.latestCursor();
        const durable = await this.messages.listAfter(this.input.sessionId, this.input.afterMsgId);
        if (this.closed || this.state.deleted) {
            this.close();
            return;
        }
        if (durable.status === 'missing-anchor') {
            this.finishWithResync('missing-message-anchor');
            return;
        }
        this.finishDurableReplay(initial, initialWatermark, durable);
        if (!waitForTerminal)
            this.finishIdleReplay();
    }
    initializeUnanchored(waitForTerminal) {
        if (hasCursor(this.input.afterCursor) || this.input.afterMsgId)
            return false;
        if (!waitForTerminal)
            this.finishIdleReplay();
        return true;
    }
    finishCursorReplay(entries, waitForTerminal) {
        this.filterLiveAfterReplay(entries);
        this.replay = toFrames(entries);
        if (!waitForTerminal)
            this.finishIdleReplay();
    }
    finishDurableReplay(initial, initialWatermark, durable) {
        const catchup = this.state.ring.replay(initialWatermark);
        if (catchup.status !== 'ok') {
            this.finishWithResync(catchup.status);
            return;
        }
        const captured = [...initial, ...catchup.entries];
        const replayCatchup = throughFirstTerminal(catchup.entries);
        const replayDurable = withoutMessagesCommittedAfterFirstTerminal(catchup.entries, durable.messages);
        this.filterLiveAfterReplay(captured);
        this.replay = stitchDurableReplay({
            sessionId: this.input.sessionId,
            initial,
            catchup: replayCatchup,
            durable: replayDurable,
            nowMs: this.nowMs,
        }).filter((frame) => frame.kind !== 'turn-terminal' || this.state.ring.isAfter(frame.cursor, initialWatermark));
    }
    filterLiveAfterReplay(entries) {
        const replayedCursors = new Set(entries.map(({ cursor }) => cursor));
        this.live.setFilter((frame) => !frame.cursor || !replayedCursors.has(frame.cursor));
    }
    finishWithResync(reason) {
        this.replay = [
            resyncFrame(this.input.sessionId, reason, this.state.ring.latestCursor(), this.nowMs()),
        ];
        this.closeAfterReplay = true;
        this.live.close();
    }
    finishIdleReplay() {
        this.closeAfterReplay = true;
        this.live.close();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.replay.length = 0;
        this.live.close();
    }
    frame(value) {
        if (value.kind === 'turn-terminal') {
            this.replay.length = 0;
            this.closeAfterReplay = true;
            this.live.close();
        }
        return { done: false, value };
    }
}
function durableMessageFrame(sessionId, message, createdAtMs, cursor) {
    const msgId = typeof message.msg_id === 'string' ? message.msg_id : 'unknown';
    const turnId = message.turnId ?? message.meta?.turnId;
    return {
        identity: `durable:${msgId}`,
        sessionId,
        kind: 'durable-message',
        data: message,
        createdAtMs,
        ...(turnId ? { turnId } : {}),
        ...(cursor ? { cursor } : {}),
    };
}
function resyncFrame(sessionId, reason, latestCursor, createdAtMs) {
    return {
        identity: `resync:${reason}:${latestCursor}`,
        sessionId,
        kind: 'resync-required',
        data: { reason },
        cursor: latestCursor,
        createdAtMs,
    };
}
function toFrames(entries) {
    return entries.map((entry) => ({ ...entry.value.frame, cursor: entry.cursor }));
}
function throughFirstTerminal(entries) {
    const terminalIndex = entries.findIndex(({ value }) => value.frame.kind === 'turn-terminal');
    return terminalIndex < 0 ? entries : entries.slice(0, terminalIndex + 1);
}
function withoutMessagesCommittedAfterFirstTerminal(entries, messages) {
    const terminalIndex = entries.findIndex(({ value }) => value.frame.kind === 'turn-terminal');
    if (terminalIndex < 0)
        return messages;
    const excludedMessageIds = new Set(entries
        .slice(terminalIndex + 1)
        .filter(({ value }) => value.frame.kind === 'message-committed')
        .flatMap(({ value }) => frameMessages(value.frame))
        .flatMap((message) => typeof message.msg_id === 'string' && message.msg_id.length > 0 ? [message.msg_id] : []));
    return excludedMessageIds.size === 0
        ? messages
        : messages.filter((message) => !excludedMessageIds.has(message.msg_id ?? ''));
}
function stitchDurableReplay(input) {
    const { sessionId, initial, catchup, durable, nowMs } = input;
    const captured = [...initial, ...catchup];
    const lastBoundary = captured.reduce((last, entry, index) => (isDurableBoundary(entry.value.frame) ? index : last), -1);
    const replayCursor = lastBoundary < 0 ? undefined : captured[lastBoundary]?.cursor;
    const messages = foldCatchupMessages(catchup, durable);
    const durableFrames = messages.map((message, index) => durableMessageFrame(sessionId, message, nowMs(), index === messages.length - 1 ? replayCursor : undefined));
    return [...durableFrames, ...toFrames(captured.slice(lastBoundary + 1))];
}
function foldCatchupMessages(entries, durable) {
    return entries
        .filter(({ value }) => isDurableBoundary(value.frame))
        .reduce((messages, { value }) => {
        if (value.frame.kind === 'messages-rewound') {
            const removed = new Set(frameRewoundMessageIds(value.frame));
            return messages.filter((message) => !removed.has(message.msg_id ?? ''));
        }
        const changed = frameMessages(value.frame);
        return value.frame.kind === 'messages-replaced'
            ? changed
            : mergeCommittedMessages(messages, changed);
    }, [...durable]);
}
function mergeCommittedMessages(messages, changed) {
    return changed.reduce((current, message) => {
        const msgId = typeof message.msg_id === 'string' ? message.msg_id : undefined;
        if (!msgId)
            return [...current, message];
        const existing = current.findIndex((candidate) => candidate.msg_id === msgId);
        if (existing < 0)
            return [...current, message];
        return current.map((candidate, index) => (index === existing ? message : candidate));
    }, [...messages]);
}
function isDurableBoundary(frame) {
    return (frame.kind === 'message-committed' ||
        frame.kind === 'messages-replaced' ||
        frame.kind === 'messages-rewound');
}
function frameMessages(frame) {
    const data = parseRecord(frame.data);
    if (!data)
        return [];
    const messages = Array.isArray(data['messages']) ? data['messages'] : [];
    return messages
        .filter(isDisplayMessageRecord)
        .map((message) => frame.turnId && !message.turnId && !message.meta?.turnId
        ? { ...message, turnId: frame.turnId }
        : message);
}
function frameRewoundMessageIds(frame) {
    const data = parseRecord(frame.data);
    const messageIds = Array.isArray(data?.['messageIds']) ? data['messageIds'] : [];
    return messageIds.filter((messageId) => typeof messageId === 'string' && messageId.length > 0);
}
function isDisplayMessageRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseRecord(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
function hasCursor(cursor) {
    return cursor !== undefined && cursor.length > 0;
}
function done() {
    return { done: true, value: undefined };
}
async function observeInitialization(initialized) {
    try {
        await initialized;
    }
    catch {
        // `next()` owns error delivery; this observer only prevents an unhandled rejection before read.
    }
}
//# sourceMappingURL=session-stream-service.js.map