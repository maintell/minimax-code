import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { appendJsonl, publishFileIfAbsent, publishJsonlIfAbsent, readJsonl, replaceFileAtomically, } from '../../../infra/file/jsonl.js';
import { resolveSessionHistoryPaths } from '../../session-system/index.js';
import { payloadPath, publishRequestPayload, RequestChainIndex, RequestChainReader, } from './request-payload-chain.js';
import { decodeEvent, decodeSessionDiscoveredRecord, hasErrorCode, readEvents, } from './records.js';
const INSPECTOR_DIRECTORY = 'llm-context-inspector';
const EVENT_FILE = 'events.jsonl';
const PAYLOAD_DIRECTORY = 'payloads';
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_DIRECTORY = join('v2', INSPECTOR_DIRECTORY, 'sessions');
/** Session-owned, append-only Inspector history. */
export class LlmContextInspectorHistoryStore {
    options;
    lane = new KeyedOperationLane();
    mutationIdentities = new Map();
    constructor(options) {
        this.options = options;
    }
    persistSettledCall(record) {
        return this.lane.run(record.sessionId, async () => {
            const paths = await this.paths(record.sessionId);
            if (!paths)
                return;
            const identities = await this.loadMutationIdentities(record.sessionId, paths.events);
            if (identities.callIds.has(record.callId))
                return;
            const request = boundedPayload(record.request);
            const response = boundedPayload(record.response);
            const requestDelta = request.state === 'AVAILABLE' && request.json !== undefined
                ? await publishRequestPayload({
                    payloadDirectory: paths.payloads,
                    index: identities.requests,
                    callId: record.callId,
                    json: request.json,
                })
                : undefined;
            await publishPayload(paths.payloads, record.callId, 'response', response);
            await this.publishSessionIndex(record.sessionId);
            const event = toCallEvent(record, request, response, requestDelta);
            await appendJsonl(paths.events, [event]);
            identities.callIds.add(record.callId);
            recordStoredRequest(identities.requests, event);
        });
    }
    async listSessions() {
        let entries;
        try {
            entries = await readdir(this.sessionIndexDirectory());
        }
        catch (error) {
            if (hasErrorCode(error, 'ENOENT'))
                return [];
            throw error;
        }
        const sessions = await Promise.all(entries
            .filter((entry) => entry.endsWith('.jsonl'))
            .map(async (entry) => {
            try {
                const records = await readJsonl(join(this.sessionIndexDirectory(), entry), decodeSessionDiscoveredRecord);
                const discovered = records[0];
                if (!discovered || records.length !== 1)
                    return undefined;
                const session = await this.options.resolveSession(discovered.sessionId);
                if (!session || session.sessionId !== discovered.sessionId)
                    return undefined;
                const paths = await this.paths(discovered.sessionId);
                if (!paths)
                    return undefined;
                const eventInfo = await stat(paths.events);
                if (eventInfo.size === 0)
                    return undefined;
                return {
                    ...session,
                    updatedAtMs: Math.trunc(eventInfo.mtimeMs),
                    source: discovered.source,
                };
            }
            catch {
                return undefined;
            }
        }));
        return sessions
            .filter((session) => session !== undefined)
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    }
    recordToolStarted(input) {
        return this.lane.run(input.sessionId, async () => {
            const paths = await this.paths(input.sessionId);
            if (!paths)
                return;
            await appendJsonl(paths.events, [
                {
                    v: 1,
                    type: 'tool.execution_started',
                    callId: input.callId,
                    toolCallId: input.toolCallId,
                    startedAtMs: input.startedAtMs,
                    ...(input.child
                        ? { parentToolCallId: input.child.parentToolCallId, toolName: input.child.toolName }
                        : {}),
                },
            ]);
        });
    }
    recordToolCompleted(input) {
        return this.lane.run(input.sessionId, async () => {
            const paths = await this.paths(input.sessionId);
            if (!paths)
                return;
            await appendJsonl(paths.events, [
                {
                    v: 1,
                    type: 'tool.execution_completed',
                    callId: input.callId,
                    toolCallId: input.toolCallId,
                    endedAtMs: input.endedAtMs,
                    isError: input.isError,
                },
            ]);
        });
    }
    recordCompletedCompaction(input) {
        return this.lane.run(input.sessionId, async () => {
            const paths = await this.paths(input.sessionId);
            if (!paths)
                return;
            const identities = await this.loadMutationIdentities(input.sessionId, paths.events);
            if (identities.compactionAttemptIds.has(input.attemptId))
                return;
            await appendJsonl(paths.events, [
                {
                    v: 1,
                    type: 'compaction.completed',
                    attemptId: input.attemptId,
                    completedAtMs: input.completedAtMs,
                    captureEpoch: input.captureEpoch,
                },
            ]);
            identities.compactionAttemptIds.add(input.attemptId);
        });
    }
    readRevision(sessionId) {
        return this.lane.run(sessionId, async () => {
            const paths = await this.paths(sessionId);
            if (!paths)
                return '0';
            try {
                const info = await stat(paths.events, { bigint: true });
                return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
            }
            catch (error) {
                if (hasErrorCode(error, 'ENOENT'))
                    return '0';
                throw error;
            }
        });
    }
    async readOverview(sessionId) {
        const snapshot = await this.readOverviewSnapshot(sessionId);
        return snapshot.overview;
    }
    readOverviewSnapshot(sessionId) {
        return this.lane.run(sessionId, async () => {
            const paths = await this.paths(sessionId);
            if (!paths) {
                return { overview: { turns: [] }, readRequestJson: async () => undefined };
            }
            const events = await readEvents(paths.events);
            const requests = requestReader(paths.payloads, events);
            return {
                overview: projectOverview(events),
                // The service reads requests in capture order, so each delta reuses the
                // request rebuilt just before it.
                readRequestJson: async (callId) => (await requests.read(callId))?.toString('utf8'),
            };
        });
    }
    readCall(sessionId, callId) {
        return this.lane.run(sessionId, async () => {
            const paths = await this.paths(sessionId);
            if (!paths)
                return undefined;
            const events = await readEvents(paths.events);
            const event = events.find((candidate) => candidate.type === 'call.captured' && candidate.callId === callId);
            if (!event)
                return undefined;
            return {
                callId,
                providerId: event.providerId,
                modelId: event.modelId,
                apiId: event.apiId,
                request: await readRequest(requestReader(paths.payloads, events), event),
                response: await readPayload({
                    payloadDirectory: paths.payloads,
                    callId,
                    side: 'response',
                    state: event.responseState,
                    byteLength: event.responseByteLength,
                }),
            };
        });
    }
    deleteTurns(sessionId, turnIds) {
        if (turnIds.length === 0)
            return Promise.resolve();
        const deletedTurnIds = new Set(turnIds);
        return this.lane.run(sessionId, async () => {
            const paths = await this.paths(sessionId);
            if (!paths)
                return;
            const events = await readEvents(paths.events);
            const deletedCallIds = new Set(events.flatMap((event) => event.type === 'call.captured' && deletedTurnIds.has(event.turnId) ? [event.callId] : []));
            if (deletedCallIds.size === 0)
                return;
            // Survivors whose delta base is about to go are rebuilt into keyframes first,
            // while every base file is still on disk.
            const { retainedEvents, materializedCallIds } = await materializeOrphanedDeltas(paths.payloads, events, deletedCallIds);
            if (retainedEvents.length === 0) {
                await rm(paths.events, { force: true });
            }
            else {
                await replaceFileAtomically(paths.events, `${retainedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, async (temporaryPath) => {
                    await readJsonl(temporaryPath, decodeEvent);
                });
            }
            await Promise.all([
                ...[...deletedCallIds].flatMap((callId) => ['request', 'request-delta', 'response'].map((file) => rm(payloadPath(paths.payloads, callId, file), { force: true }))),
                ...materializedCallIds.map((callId) => rm(payloadPath(paths.payloads, callId, 'request-delta'), { force: true })),
            ]);
            this.mutationIdentities.delete(sessionId);
        });
    }
    clearSession(sessionId) {
        return this.lane.run(sessionId, async () => {
            const paths = await this.paths(sessionId);
            this.mutationIdentities.delete(sessionId);
            if (!paths)
                return;
            await rm(paths.directory, { recursive: true, force: true });
            await rm(this.sessionIndexPath(sessionId), { force: true });
        });
    }
    async publishSessionIndex(sessionId) {
        await publishJsonlIfAbsent(this.sessionIndexPath(sessionId), [
            {
                v: 1,
                type: 'session.discovered',
                sessionId,
                source: this.options.runtimeOwnerKind,
            },
        ]);
    }
    sessionIndexDirectory() {
        return join(this.options.dataDir, SESSION_INDEX_DIRECTORY);
    }
    sessionIndexPath(sessionId) {
        return join(this.sessionIndexDirectory(), `${Buffer.from(sessionId, 'utf8').toString('base64url')}.jsonl`);
    }
    async loadMutationIdentities(sessionId, eventPath) {
        const cached = this.mutationIdentities.get(sessionId);
        if (cached)
            return cached;
        const identities = {
            callIds: new Set(),
            compactionAttemptIds: new Set(),
            requests: new RequestChainIndex(),
        };
        for (const event of await readEvents(eventPath)) {
            if (event.type === 'call.captured') {
                identities.callIds.add(event.callId);
                recordStoredRequest(identities.requests, event);
            }
            else if (event.type === 'compaction.completed') {
                identities.compactionAttemptIds.add(event.attemptId);
            }
        }
        this.mutationIdentities.set(sessionId, identities);
        return identities;
    }
    async paths(sessionId) {
        const session = await this.options.resolveSession(sessionId);
        if (!session || session.sessionId !== sessionId)
            return undefined;
        const sessionDirectory = resolveSessionHistoryPaths(this.options.dataDir, session).sessionDir;
        const directory = join(sessionDirectory, INSPECTOR_DIRECTORY);
        return {
            directory,
            events: join(directory, EVENT_FILE),
            payloads: join(directory, PAYLOAD_DIRECTORY),
        };
    }
}
function recordStoredRequest(index, event) {
    if (event.requestState !== 'AVAILABLE')
        return;
    index.record(event.callId, {
        ...(event.requestByteLength === undefined ? {} : { byteLength: event.requestByteLength }),
        ...(event.requestDelta ? { delta: event.requestDelta } : {}),
    });
}
function requestReader(payloadDirectory, events) {
    const index = new RequestChainIndex();
    for (const event of events) {
        if (event.type === 'call.captured')
            recordStoredRequest(index, event);
    }
    return new RequestChainReader(payloadDirectory, (callId) => index.lookup(callId));
}
async function readRequest(requests, event) {
    const byteLength = event.requestByteLength;
    const sized = byteLength === undefined ? {} : { byteLength };
    if (event.requestState !== 'AVAILABLE')
        return { state: event.requestState, ...sized };
    const bytes = await requests.read(event.callId);
    if (!bytes)
        return { state: 'CAPTURE_FAILED', ...sized };
    return {
        state: 'AVAILABLE',
        json: bytes.toString('utf8'),
        byteLength: byteLength ?? bytes.length,
    };
}
function isDeletedEvent(event, deletedCallIds) {
    return event.type !== 'compaction.completed' && deletedCallIds.has(event.callId);
}
async function materializeOrphanedDeltas(payloadDirectory, events, deletedCallIds) {
    const requests = requestReader(payloadDirectory, events);
    const retainedEvents = [];
    const materializedCallIds = [];
    for (const event of events) {
        if (isDeletedEvent(event, deletedCallIds))
            continue;
        const orphaned = event.type === 'call.captured' &&
            event.requestDelta !== undefined &&
            deletedCallIds.has(event.requestDelta.baseCallId);
        const bytes = orphaned ? await requests.read(event.callId) : undefined;
        if (event.type !== 'call.captured' || !bytes) {
            // A survivor that cannot be rebuilt was already unreadable and stays so.
            retainedEvents.push(event);
            continue;
        }
        await publishFileIfAbsent(payloadPath(payloadDirectory, event.callId, 'request'), bytes);
        retainedEvents.push(asKeyframeEvent(event));
        materializedCallIds.push(event.callId);
    }
    return { retainedEvents, materializedCallIds };
}
function asKeyframeEvent(event) {
    const keyframe = {
        ...event,
    };
    delete keyframe.requestDelta;
    return keyframe;
}
function toCallEvent(record, request, response, requestDelta) {
    return {
        v: 1,
        type: 'call.captured',
        callId: record.callId,
        turnId: record.turnId,
        startedAtMs: record.startedAtMs,
        durationMs: record.durationMs,
        providerId: record.providerId,
        modelId: record.modelId,
        apiId: record.apiId,
        attemptCount: record.attemptCount,
        ...(record.attemptStartedAtMs === undefined
            ? {}
            : { attemptStartedAtMs: record.attemptStartedAtMs }),
        ...(record.firstEventAtMs === undefined ? {} : { firstEventAtMs: record.firstEventAtMs }),
        ...(record.usage ? { usage: record.usage } : {}),
        expectedTools: record.expectedTools,
        requestState: request.state,
        ...(request.byteLength === undefined ? {} : { requestByteLength: request.byteLength }),
        ...(requestDelta ? { requestDelta } : {}),
        responseState: response.state,
        ...(response.byteLength === undefined ? {} : { responseByteLength: response.byteLength }),
        captureEpoch: record.captureEpoch,
        ...(record.outcome === 'error' ? { outcome: 'error' } : {}),
    };
}
function boundedPayload(payload) {
    if (payload.state !== 'AVAILABLE' || payload.json === undefined)
        return payload;
    const byteLength = Buffer.byteLength(payload.json, 'utf8');
    return byteLength > MAX_PAYLOAD_BYTES
        ? { state: 'OMITTED_TOO_LARGE', byteLength }
        : { state: 'AVAILABLE', json: payload.json, byteLength };
}
async function publishPayload(payloadDirectory, callId, side, payload) {
    if (payload.state !== 'AVAILABLE' || payload.json === undefined)
        return;
    await publishFileIfAbsent(payloadPath(payloadDirectory, callId, side), payload.json);
}
async function readPayload(input) {
    const { payloadDirectory, callId, side, state, byteLength } = input;
    if (state !== 'AVAILABLE') {
        return { state, ...(byteLength === undefined ? {} : { byteLength }) };
    }
    try {
        const json = await readFile(payloadPath(payloadDirectory, callId, side), 'utf8');
        return {
            state: 'AVAILABLE',
            json,
            byteLength: byteLength ?? Buffer.byteLength(json, 'utf8'),
        };
    }
    catch {
        return { state: 'CAPTURE_FAILED', ...(byteLength === undefined ? {} : { byteLength }) };
    }
}
function projectOverview(events) {
    const turns = new Map();
    const callsById = new Map();
    let pendingCompactionEpoch;
    for (const event of events) {
        if (event.type === 'compaction.completed') {
            pendingCompactionEpoch = event.captureEpoch;
            continue;
        }
        if (event.type === 'tool.execution_started' || event.type === 'tool.execution_completed') {
            applyToolEvent(callsById.get(event.callId), event);
            continue;
        }
        let turn = turns.get(event.turnId);
        if (!turn) {
            turn = { turnId: event.turnId, turnOrdinal: turns.size + 1, calls: [] };
            turns.set(event.turnId, turn);
        }
        const call = storedCall(event, turn.calls.length + 1, pendingCompactionEpoch);
        turn.calls.push(call);
        callsById.set(event.callId, call);
        pendingCompactionEpoch = undefined;
    }
    return { turns: [...turns.values()] };
}
function storedCall(event, callOrdinal, pendingCompactionEpoch) {
    return {
        callId: event.callId,
        callOrdinal,
        startedAtMs: event.startedAtMs,
        durationMs: event.durationMs,
        providerId: event.providerId,
        modelId: event.modelId,
        apiId: event.apiId,
        attemptCount: event.attemptCount,
        ...(event.attemptStartedAtMs === undefined
            ? {}
            : { attemptStartedAtMs: event.attemptStartedAtMs }),
        ...(event.firstEventAtMs === undefined ? {} : { firstEventAtMs: event.firstEventAtMs }),
        ...(event.usage ? { usage: event.usage } : {}),
        tools: event.expectedTools.map((tool) => ({ ...tool })),
        hasCompactionBefore: pendingCompactionEpoch === event.captureEpoch,
        captureEpoch: event.captureEpoch,
        ...(event.outcome === 'error' ? { outcome: 'error' } : {}),
    };
}
function applyToolEvent(call, event) {
    if (call && event.type === 'tool.execution_started' && event.parentToolCallId) {
        appendChildTool(call, event.toolCallId, event.parentToolCallId, event.toolName);
    }
    projectToolEvent(call, event);
}
function projectToolEvent(call, event) {
    if (!call)
        return;
    const matches = call.tools.filter((tool) => tool.toolCallId === event.toolCallId);
    if (matches.length !== 1)
        return;
    const tool = matches[0];
    if (event.type === 'tool.execution_started') {
        if (tool.startedAtMs === undefined)
            tool.startedAtMs = event.startedAtMs;
        return;
    }
    if (tool.startedAtMs === undefined ||
        tool.durationMs !== undefined ||
        event.endedAtMs < tool.startedAtMs) {
        return;
    }
    tool.durationMs = event.endedAtMs - tool.startedAtMs;
    tool.isError = event.isError;
}
/**
 * A PTC child is not in the Response, so its first start event adds it after
 * the declared tools. The parent must be a declared, non-child tool of the same
 * Call; anything else stays out of the projection like other orphan events.
 */
function appendChildTool(call, toolCallId, parentToolCallId, toolName) {
    if (!toolName)
        return;
    const parentMatches = call.tools.filter((tool) => tool.toolCallId === parentToolCallId && tool.parentToolCallId === undefined);
    if (parentMatches.length !== 1)
        return;
    if (call.tools.some((tool) => tool.toolCallId === toolCallId))
        return;
    call.tools.push({
        toolCallId,
        toolName,
        parentToolCallId,
    });
}
//# sourceMappingURL=history-store.js.map