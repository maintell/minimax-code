const SESSION_STREAM_MAX_FRAMES = 2_000;
const SESSION_STREAM_MAX_BYTES = 8 * 1_024 * 1_024;
const COMPLETED_MESSAGE_RETENTION = 2;
export class SessionFrameRetention {
    completed = new Set();
    active;
    classify(frame) {
        const signal = messageSignal(frame);
        this.activate(signal.groupId, frame.turnId);
        signal.completedIds.forEach((id) => this.completed.add(id));
        const messageGroupId = signal.groupId ?? this.activeForTurn(frame.turnId);
        if (messageGroupId && isCompletionBoundary(frame)) {
            this.completed.add(messageGroupId);
        }
        return {
            frame,
            ...(messageGroupId ? { messageGroupId } : {}),
        };
    }
    selectEvictionCount(snapshot) {
        const groups = groupSpans(snapshot.entries.map(({ value }) => value));
        this.pruneCompleted(groups);
        const completed = groups.filter(({ id }) => this.completed.has(id));
        const oldestCompleted = completed[0];
        if (completed.length > COMPLETED_MESSAGE_RETENTION && oldestCompleted) {
            return oldestCompleted.lastIndex + 1;
        }
        const overBounds = snapshot.entries.length > snapshot.maxItems || snapshot.retainedBytes > snapshot.maxBytes;
        if (!overBounds)
            return 0;
        return oldestCompleted ? oldestCompleted.lastIndex + 1 : 1;
    }
    activate(groupId, turnId) {
        if (!groupId)
            return;
        if (this.active && this.active.id !== groupId && !this.completed.has(this.active.id)) {
            this.completed.add(this.active.id);
        }
        this.active = { id: groupId, ...(turnId ? { turnId } : {}) };
    }
    activeForTurn(turnId) {
        if (!this.active)
            return undefined;
        return !turnId || !this.active.turnId || turnId === this.active.turnId
            ? this.active.id
            : undefined;
    }
    pruneCompleted(groups) {
        const retained = new Set(groups.map(({ id }) => id));
        this.completed.forEach((id) => {
            if (!retained.has(id) && this.active?.id !== id)
                this.completed.delete(id);
        });
    }
}
export function sessionRingOptions(options) {
    return {
        ...options,
        maxItems: cappedLimit(options?.maxItems, SESSION_STREAM_MAX_FRAMES),
        maxBytes: cappedLimit(options?.maxBytes, SESSION_STREAM_MAX_BYTES),
    };
}
function messageSignal(frame) {
    const data = parseRecord(frame.data);
    if (frame.kind === 'runtime-event') {
        const chunk = parseRecord(data?.['agent_message_chunk']);
        const chunkId = readString(chunk, 'msg_id');
        if (chunkId) {
            return {
                groupId: chunkId,
                completedIds: chunk?.['finish'] === true ? [chunkId] : [],
            };
        }
        const message = parseRecord(data?.['agent_message']);
        const messageId = readString(message, 'msg_id');
        if (messageId)
            return { groupId: messageId, completedIds: [messageId] };
    }
    if (isHistoryBoundary(frame)) {
        const messageIds = frame.kind === 'messages-rewound'
            ? recordStringArray(data, 'messageIds')
            : frameMessageIds(data);
        return { groupId: messageIds.at(-1), completedIds: messageIds };
    }
    return { completedIds: [] };
}
function groupSpans(frames) {
    const byId = frames.reduce((groups, frame, index) => {
        if (!frame.messageGroupId)
            return groups;
        const existing = groups.get(frame.messageGroupId);
        groups.set(frame.messageGroupId, {
            id: frame.messageGroupId,
            firstIndex: existing?.firstIndex ?? index,
            lastIndex: index,
        });
        return groups;
    }, new Map());
    return Array.from(byId.values()).sort((left, right) => left.firstIndex - right.firstIndex);
}
function frameMessageIds(data) {
    const messages = Array.isArray(data?.['messages']) ? data['messages'] : [];
    return messages.flatMap((message) => {
        const id = readString(parseRecord(message), 'msg_id');
        return id ? [id] : [];
    });
}
function recordStringArray(data, key) {
    const values = Array.isArray(data?.[key]) ? data[key] : [];
    return values.filter((value) => typeof value === 'string' && value.length > 0);
}
function isCompletionBoundary(frame) {
    return frame.kind === 'turn-terminal' || isHistoryBoundary(frame);
}
function isHistoryBoundary(frame) {
    return (frame.kind === 'message-committed' ||
        frame.kind === 'messages-replaced' ||
        frame.kind === 'messages-rewound');
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
function readString(value, key) {
    const selected = value?.[key];
    return typeof selected === 'string' && selected.length > 0 ? selected : undefined;
}
function cappedLimit(value, hardLimit) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Math.floor(value), hardLimit)
        : hardLimit;
}
//# sourceMappingURL=session-frame-retention.js.map