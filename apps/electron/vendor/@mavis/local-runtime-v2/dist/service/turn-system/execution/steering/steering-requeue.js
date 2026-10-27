import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createUserMessageId, isQueueMessageSource } from '../../../session-system/index.js';
import { isTeardownDurableSteeringProducer } from '../../agent-host/contracts.js';
import { queueModelFromAgentHost } from '../../agent-host/index.js';
import { pausesQueueOnAbort } from '../queue-pause-on-abort.js';
// Wake publications may legitimately outlive `drain` — they await
// `turnReleased`, which a timed-out shutdown abort never resolves — and they
// manage their own errors; collecting them makes the detach explicit.
const detachedWakes = new WeakSet();
/** Upper bound for the pre-release commit; release liveness beats the write. */
const PRERELEASE_COMMIT_TIMEOUT_MS = 2_000;
/**
 * Routes admitted-but-unconsumed user steering of an ended Turn (Decision v5):
 * exit-close batches return to the Session queue as queued items and wake the
 * dispatcher; abort/abnormal-seal batches fall into the conversation instead.
 * Non-user producers keep drop semantics on both lanes, except the teardown-
 * durable machine producers (AskUser v2 answers): the user already answered,
 * so dropping the steer would lose the answer for good.
 */
export function createSteeringRequeue(options) {
    const inflight = new Map();
    const settled = new WeakMap();
    const pending = new Map();
    // Never rejects: the persist lanes shield their own failures and the wake
    // is detached above, so `drain` can `Promise.all` the tracked entries safely.
    const persistTracked = async (key, retry) => {
        try {
            if (retry.route === 'teardown') {
                const { committed, committedIdentities } = await persistTeardown(options, retry.batch, retry.messages);
                // Trim the durable prefix so a retry resumes at the failure position
                // and the requeue fallback cannot duplicate committed identities. An
                // all-committed report counts as success even when the sink reported
                // failure afterwards: nothing is left to retry or requeue.
                retry.messages = withoutCommitted(retry.messages, committedIdentities);
                if (committed || retry.messages.length === 0) {
                    pending.delete(key);
                    markSettled(settled, retry.batch, key);
                }
                return;
            }
            const committed = await persistRequeue(options, retry.batch, retry.messages);
            if (committed > 0) {
                pending.delete(key);
                markSettled(settled, retry.batch, key);
                // Only the exit-close lane wakes dispatch. A teardown batch that fell
                // back here after failed conversation commits stays parked as a queued
                // item: settlement may already have judged an empty queue, and a wake
                // would auto-dispatch the instruction the user just stopped. The
                // user-stop pause restore lives inside `persistRequeue`.
                if (resolveCause(retry.batch) === 'exit-close') {
                    detachedWakes.add(wakeQueueAfterRelease(options, retry.batch));
                }
            }
        }
        finally {
            inflight.delete(key);
        }
    };
    const start = (key, retry) => {
        const running = inflight.get(key);
        if (running)
            return running;
        const task = persistTracked(key, retry);
        inflight.set(key, task);
        return task;
    };
    // Decision v5 pre-release lane: every pending teardown batch of one Turn
    // commits as a single send-ordered write, so a restore+abort discard order
    // can never reorder the canonical rows (TS-76). Never rejects.
    const commitMergedTeardown = async (entries) => {
        try {
            const [, first] = entries[0];
            const messages = entries
                .flatMap(([, retry]) => retry.messages)
                .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
            const { committed, committedIdentities } = await persistTeardown(options, first.batch, messages);
            for (const [key, retry] of entries) {
                // A partially committed merge settles the fully durable batches and
                // trims the rest, so their retries and fallbacks skip fallen rows.
                retry.messages = withoutCommitted(retry.messages, committedIdentities);
                if (!committed && retry.messages.length > 0)
                    continue;
                pending.delete(key);
                markSettled(settled, retry.batch, key);
            }
        }
        finally {
            for (const [key] of entries)
                inflight.delete(key);
        }
    };
    return {
        discard(batch) {
            const messages = batch.messages
                .flatMap((message) => message.batchMembers ?? [message])
                .filter((message) => isTeardownDurableSteeringProducer(message.producerId, batch.workClosed === true))
                .map((message) => ({ ...message, createdAt: message.createdAt ?? Date.now() }));
            if (messages.length === 0)
                return;
            const key = batchIdentity(batch, messages);
            if (pending.has(key) || settled.get(batch.turnReleased)?.has(key))
                return;
            const retry = { batch, messages, route: resolveRoute(batch) };
            pending.set(key, retry);
            if (retry.route === 'requeue') {
                const firstAttempt = start(key, retry);
                // Settlement is the normal handoff boundary; it also resolves claimed
                // send-now rows before one bounded retry. Shutdown is a separate fallback.
                detachedWakes.add((async () => {
                    try {
                        await batch.turnReleased;
                        await firstAttempt;
                        if (pending.has(key))
                            await start(key, retry);
                    }
                    catch {
                        // A rejected release leaves the in-memory batch for drain.
                    }
                })());
                return;
            }
            // Fall-to-session normally lands through the coordinator's pre-release
            // `commitDiscardedBeforeRelease` call (after the assistant tail
            // reconciled, before admission opens). This detached lane is the
            // post-release fallback for a failed or timed-out pre-release commit.
            // Shutdown never waits — `drain` forces the commit instead.
            detachedWakes.add((async () => {
                try {
                    await batch.turnReleased;
                }
                catch {
                    // A rejected release still tears the Turn down; commit anyway.
                }
                if (pending.has(key))
                    await start(key, retry);
                if (pending.has(key))
                    await start(key, retry);
                if (pending.has(key)) {
                    // Bounded retries exhausted: return to the queue rather than
                    // dropping an admitted user message (the only non-exit-close
                    // requeue remnant, Decision v5 rule 4).
                    retry.route = 'requeue';
                    await start(key, retry);
                }
            })());
        },
        async commitDiscardedBeforeRelease({ sessionId, turnId, timeoutMs }) {
            if (!options.teardown)
                return;
            const { waits, ready } = collectPreReleaseWork(pending, inflight, sessionId, turnId);
            if (ready.length > 0) {
                const task = commitMergedTeardown(ready);
                for (const [key] of ready)
                    inflight.set(key, task);
                waits.push(task);
            }
            if (waits.length === 0)
                return;
            await boundedSettle(Promise.all(waits), timeoutMs ?? PRERELEASE_COMMIT_TIMEOUT_MS);
        },
        async drain() {
            await Promise.all([...inflight.values()]);
            // Shutdown commits sequentially; send order across batches of the same
            // Turn follows the earliest admitted member, not the discard order.
            for (const [key, retry] of drainOrder(pending)) {
                await start(key, retry);
                if (retry.route === 'teardown' && pending.has(key)) {
                    retry.route = 'requeue';
                    await start(key, retry);
                }
            }
            await Promise.all([...inflight.values()]);
        },
    };
}
/** A missing cause degrades by abortReason presence instead of throwing. */
function resolveCause(batch) {
    return batch.cause ?? (batch.abortReason !== undefined ? 'abort' : 'exit-close');
}
/** Splits a Turn's pending teardown batches into already-running and mergeable work. */
function collectPreReleaseWork(pending, inflight, sessionId, turnId) {
    const waits = [];
    const ready = [];
    for (const [key, retry] of pending) {
        if (retry.route !== 'teardown')
            continue;
        if (retry.batch.sessionId !== sessionId || retry.batch.turnId !== turnId)
            continue;
        const running = inflight.get(key);
        if (running) {
            waits.push(running);
            continue;
        }
        ready.push([key, retry]);
    }
    return { waits, ready };
}
/** Bounded, non-throwing wait: a hung or failed commit never blocks release. */
async function boundedSettle(pendingWork, timeoutMs) {
    const swallowed = async () => {
        try {
            await pendingWork;
        }
        catch {
            // Failures stay owned by the tracked lanes; this wait only bounds them.
        }
    };
    let timer;
    try {
        await Promise.race([
            swallowed(),
            new Promise((resolve) => {
                timer = setTimeout(resolve, Math.max(1, timeoutMs));
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function drainOrder(pending) {
    return [...pending].sort(([, a], [, b]) => earliestCreatedAt(a.messages) - earliestCreatedAt(b.messages));
}
function earliestCreatedAt(messages) {
    return messages.reduce((earliest, message) => Math.min(earliest, message.createdAt ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
}
function resolveRoute(batch) {
    return resolveCause(batch) === 'exit-close' ? 'requeue' : 'teardown';
}
function markSettled(settled, batch, key) {
    const completed = settled.get(batch.turnReleased) ?? new Set();
    completed.add(key);
    settled.set(batch.turnReleased, completed);
}
async function persistTeardown(options, batch, messages) {
    const committedIdentities = new Set();
    if (!options.teardown) {
        // No sink wired: degrade to the requeue lane rather than losing input.
        options.logger?.warn({ sessionId: batch.sessionId, turnId: batch.turnId }, 'Steering teardown sink is missing; falling back to the queue lane');
        return { committed: false, committedIdentities };
    }
    try {
        if (await options.teardown.commit({
            sessionId: batch.sessionId,
            turnId: batch.turnId,
            messages,
            onCommitted: (message) => {
                // A malformed report is ignored: an untrimmed message only risks a
                // duplicate on the fallback lane, never a lost user message.
                const identity = messageIdentity(message);
                if (identity !== undefined)
                    committedIdentities.add(identity);
            },
        })) {
            return { committed: true, committedIdentities };
        }
    }
    catch (error) {
        options.logger?.warn({
            sessionId: batch.sessionId,
            turnId: batch.turnId,
            producerIds: messages.map((message) => message.producerId),
            error: `${error}`,
        }, 'Unconsumed steering could not be committed into the conversation');
    }
    return { committed: false, committedIdentities };
}
/** Identity used to match teardown progress against tracked batch members. */
function messageIdentity(message) {
    if (typeof message?.producerId !== 'string' || typeof message.idempotencyKey !== 'string') {
        return undefined;
    }
    return JSON.stringify([message.producerId, message.idempotencyKey]);
}
/**
 * Drops members the teardown already committed into the conversation so
 * retries and the fallback requeue cannot resend them. Missing or malformed
 * progress keeps the full batch: a duplicate beats a dropped user message.
 */
function withoutCommitted(messages, committedIdentities) {
    if (committedIdentities.size === 0)
        return messages;
    return messages.filter((message) => {
        const identity = messageIdentity(message);
        return identity === undefined || !committedIdentities.has(identity);
    });
}
async function persistRequeue(options, batch, messages) {
    let committed = 0;
    try {
        const session = await options.queue.requireMutableSession(batch.sessionId);
        const result = await options.queue.enqueue(toBatchRequeueInput(batch, session.agentName, messages));
        if (result === undefined)
            throw new Error('Immediate-send batch enqueue rejected');
        // An abort that pauses settlement — a user stop, or leaving the conversation
        // (TUI `/clear`, switching Sessions), which still stops the live Turn — must
        // leave the queue paused when its steering falls back to the queue, exactly
        // like settling over pending items: settlement may have judged the pause with
        // an empty queue before this detached requeue landed, and without the pause a
        // later wake (e.g. a dependency release) would auto-dispatch an instruction
        // the user just stopped or walked away from. `pausesQueueOnAbort` is the
        // predicate settlement uses, so the two decisions cannot diverge. Exit-close
        // batches never carry an abortReason, so the wake lane is unaffected. A pause
        // failure keeps this persist uncommitted so the batch stays on the
        // pending/drain retry lanes — the enqueued row is durable and a retried
        // enqueue of the same identity is absorbed by the queue's clientRequestId
        // replay / itemId restore, so the replay costs one write and buys back the
        // lost pause. Pausing real queued items at settlement stays with the
        // execution coordinator.
        if (pausesQueueOnAbort(batch.abortReason)) {
            await options.queue.pauseIfPending({
                sessionId: batch.sessionId,
                cause: 'user-stop',
                triggerTurnId: batch.turnId,
            });
        }
        committed = 1;
    }
    catch (error) {
        // Keep this admitted batch in memory for a later hand-off/drain retry.
        // Only successfully persisted items are promised across process restart.
        options.logger?.warn({
            sessionId: batch.sessionId,
            turnId: batch.turnId,
            producerIds: messages.map((message) => message.producerId),
            error: `${error}`,
        }, 'Aborted Turn steering could not be returned to the Session queue');
    }
    return committed;
}
function batchIdentity(batch, messages) {
    return `steer-batch:${createHash('sha256')
        .update(JSON.stringify([
        batch.sessionId,
        batch.turnId,
        messages.map((message) => [message.producerId, message.idempotencyKey]),
    ]))
        .digest('hex')}`;
}
function toBatchRequeueInput(batch, agentName, messages) {
    const id = batchIdentity(batch, messages);
    const members = messages.map((message) => {
        const input = toRequeueInput(batch.sessionId, agentName, message);
        const messageKey = message.messageKey ?? `steer:${message.producerId}:${message.idempotencyKey}`;
        return {
            message: input.message,
            userMessageId: message.userMessageId ?? createUserMessageId({ sessionId: batch.sessionId, messageKey }),
            messageKey,
            ...(message.unstartedFromTurnIds?.length
                ? { unstartedFromTurnIds: message.unstartedFromTurnIds }
                : {}),
            unconsumedFromTurnIds: [...new Set([...(message.unconsumedFromTurnIds ?? []), batch.turnId])],
            ...(message.queueClaim ? { queueClaim: message.queueClaim } : {}),
            createdAt: message.createdAt ?? Date.now(),
            ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId } : {}),
            provenance: {
                ...message.provenance,
                source: isQueueMessageSource(message.provenance.source) ? message.provenance.source : 'api',
            },
            ...(input.model ? { model: input.model } : {}),
        };
    });
    const first = members[0];
    const model = [...members].reverse().find((member) => member.model)?.model;
    return {
        ...toRequeueInput(batch.sessionId, agentName, messages[0]),
        source: requeueSource(messages),
        itemId: messages[0].queueClaim?.itemId ?? messages[0].sourceMessageId ?? id,
        clientRequestId: id,
        userMessageId: first.userMessageId,
        createdAt: first.createdAt,
        immediateSendBatch: { id, members },
        message: batchQueueMessage(members),
        ...(model ? { model } : {}),
    };
}
/**
 * Requeued user steering is the user's own composer input, except a batch of only Mini App text:
 * it stays the Mini App's, which keeps it out of the user's editable queue.
 */
function requeueSource(messages) {
    return messages.every((message) => message.provenance.source === 'miniapp') ? 'miniapp' : 'api';
}
function batchQueueMessage(members) {
    if (members.length === 1)
        return members[0].message;
    return {
        content: members.map((member) => member.message.content).join('\n\n'),
        attachments: members.flatMap((member) => member.message.attachments),
        ...(members.some((member) => member.message.computerUse?.enable === true)
            ? { computerUse: { enable: true } }
            : {}),
        hideUserMessage: members.every((member) => member.message.hideUserMessage === true),
        ...(members.some((member) => member.message.displayContent !== undefined)
            ? {
                displayContent: members
                    .map((member) => member.message.displayContent ?? member.message.content)
                    .join('\n\n'),
            }
            : {}),
        ...(members.some((member) => member.message.displayAttachments !== undefined)
            ? {
                displayAttachments: members.flatMap((member) => member.message.displayAttachments ??
                    member.message.attachments.map((attachment) => ({ ...attachment }))),
            }
            : {}),
    };
}
/**
 * An aborted Turn settles without publishing a Queue wake, and enqueue only
 * records committed facts, so an idle dispatcher would never see the requeued
 * items. Publish one wake — after the Turn released its Session ownership so
 * dispatch cannot lose an `active-turn` admission race against settlement.
 */
async function wakeQueueAfterRelease(options, batch) {
    try {
        await batch.turnReleased;
        await options.released.publish(batch.sessionId);
    }
    catch {
        // The requeued items are durable; a later Queue wake retries dispatch.
    }
}
function toRequeueInput(sessionId, agentName, message) {
    const input = message.message;
    const delivery = message.delivery;
    const origin = message.provenance.sourceContext?.origin ?? input.origin;
    return {
        session: { sessionId, agentName },
        ...toRequeueIdentity(message),
        source: 'api',
        queuePlacement: 'front',
        message: {
            content: input.text,
            attachments: (input.attachments ?? []).flatMap(toRequeueAttachment),
            ...(input.computerUse ? { computerUse: { ...input.computerUse } } : {}),
            ...(delivery?.hideUserMessage !== undefined
                ? { hideUserMessage: delivery.hideUserMessage }
                : {}),
            ...(delivery?.displayContent !== undefined
                ? { displayContent: delivery.displayContent }
                : {}),
            ...(delivery?.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
            ...(origin !== undefined ? { origin } : {}),
            ...(input.quotedMessage ? { quotedMessage: { ...input.quotedMessage } } : {}),
        },
        // Activation-only delivery stripped the explicit model before the join;
        // the requeued follow-up query must restore the user's choice.
        ...toRequeueModel(message.requeueModel ?? input.model),
    };
}
/**
 * A send-now steer consumed a Queue item; restoring that identity keeps the
 * dispatched user row on the sourceMessageId the client's optimistic bubble
 * reconciles against (otherwise the same send renders twice).
 */
function toRequeueIdentity(message) {
    return {
        ...(message.sourceMessageId ? { itemId: message.sourceMessageId } : {}),
        ...(message.userMessageId ? { userMessageId: message.userMessageId } : {}),
    };
}
function toRequeueModel(model) {
    const override = queueModelFromAgentHost(model);
    return override ? { model: override } : {};
}
function toRequeueAttachment(input) {
    const filePath = (input.filePath ?? '').trim();
    const optional = optionalAttachmentFields(input);
    if (!filePath && !optional.dataUrl && !optional.assetId && !optional.error)
        return [];
    const mimeType = (input.mimeType ?? '').trim();
    return [
        {
            type: requeueAttachmentType(input.type, mimeType),
            fileName: requeueAttachmentFileName(input.fileName, filePath),
            mimeType,
            filePath,
            ...optional,
        },
    ];
}
function optionalAttachmentFields(input) {
    const dataUrl = input.dataUrl?.trim();
    return {
        ...(dataUrl ? { dataUrl } : {}),
        ...(input.assetId ? { assetId: input.assetId } : {}),
        ...(input.error ? { error: input.error } : {}),
    };
}
function requeueAttachmentType(type, mimeType) {
    return type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
}
function requeueAttachmentFileName(fileName, filePath) {
    return fileName?.trim() || basename(filePath) || 'attachment';
}
//# sourceMappingURL=steering-requeue.js.map