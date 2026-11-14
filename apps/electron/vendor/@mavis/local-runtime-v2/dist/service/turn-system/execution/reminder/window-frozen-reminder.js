import { fitsReminderInFinalRequest } from './reminder-admission.js';
/**
 * A hidden message appended near the start of the model-visible context and
 * frozen for one context window: the copy in context stays byte-identical even
 * after the source changes, so the prompt cache keeps hitting, and the current
 * text only replaces it once compaction has summarized the old copy away.
 *
 * The Memory summary and the PTC script catalog share this; each owns only its
 * own `customType` and its own loader.
 */
export async function prepareWindowFrozenReminder(input) {
    const { customType, hookInput, usageAnchor } = input;
    const keepOne = createKeepWindowCopyHook(customType);
    const carried = carriesInWindow(customType, hookInput.canonicalMessages);
    // Without access no copy may reach the model, whatever the window already
    // carries. This is checked before the lazy branch below, so a window that
    // holds a copy stops sending it the moment access is lost instead of
    // freezing it until the next compaction. Deciding it is cheap: the caller
    // only reads the Session's own mode, never the source of the text.
    if (input.content.status === 'withdrawn') {
        return { beforeUserMessages: [], hooks: [createWithdrawAllHook(customType)] };
    }
    if (carried && input.loadContentWhenRestoring) {
        return {
            beforeUserMessages: [],
            hooks: [
                keepOne,
                createRestoreHook(customType, input.loadContentWhenRestoring, usageAnchor, input.onInjected),
            ],
        };
    }
    const ready = input.content.status === 'ready' ? input.content.content : undefined;
    if (ready === undefined) {
        // Nothing to place now. A caller that can read the source again still gets
        // a restore hook: the window may gain its first entry later in this very
        // Turn, and a compaction then rebuilds the window from the prefix, so
        // without the hook the new window would carry nothing at all. A caller
        // without a loader (the Memory summary) keeps the plain keep-one hook.
        return {
            beforeUserMessages: [],
            hooks: nothingPlacedHooks({
                customType,
                loadContentWhenRestoring: input.loadContentWhenRestoring,
                usageAnchor,
                onInjected: input.onInjected,
                canonicalMessages: hookInput.canonicalMessages,
            }),
        };
    }
    // A caller that can read the source again gets the current text restored,
    // because a compaction inside the Turn that placed the copy must not replay
    // a stale one: a script saved later in this very Turn would be missing from
    // the new window, and a deleted one would still be listed. A caller without
    // a loader (the Memory summary) replays exactly what it placed.
    const replayPlaced = () => ({ status: 'ready', content: ready });
    const restore = createRestoreHook(customType, input.loadContentWhenRestoring ?? replayPlaced, usageAnchor, input.onInjected);
    // A window that already carries a copy keeps it frozen; nothing is placed.
    if (carried)
        return { beforeUserMessages: [], hooks: [keepOne, restore] };
    const marker = createMarker(customType, ready);
    const fits = fitsReminderInFinalRequest(hookInput, marker, usageAnchor);
    if (fits)
        input.onInjected?.();
    return { beforeUserMessages: fits ? [marker] : [], hooks: [keepOne, restore] };
}
/** Request-only: without access no copy may reach the model. */
function createWithdrawAllHook(customType) {
    return (input) => withdrawAllDecision(customType, input.messages);
}
function withdrawAllDecision(customType, messages) {
    if (!messages.some((message) => isMarker(customType, message)))
        return undefined;
    return {
        type: 'replaceRequestMessages',
        reason: `${customType}_withdrawn`,
        messages: messages.filter((message) => !isMarker(customType, message)),
    };
}
/**
 * Request-only: sends exactly the frozen copy of the current window. Earlier
 * Runtimes appended a fresh copy whenever the text changed; keeping the latest
 * one matches what they sent, so upgrading does not move the prefix.
 */
function createKeepWindowCopyHook(customType) {
    return (input) => {
        const keep = latestIndexInWindow(customType, input.messages);
        const extra = (message, index) => isMarker(customType, message) && index !== keep;
        if (!input.messages.some(extra))
            return undefined;
        return {
            type: 'replaceRequestMessages',
            reason: `${customType}_deduplicated`,
            messages: input.messages.filter((message, index) => !extra(message, index)),
        };
    };
}
/**
 * What a restore hook does once it has the source's current content: withdraw
 * every copy when access is gone, place nothing when there is nothing to place,
 * and otherwise append the frozen marker when it still fits.
 *
 * The two restore hooks differ only in when they decide to read the source
 * again — one when the window carries no copy, one when the compaction boundary
 * moved — so everything after that read lives here and the two cannot drift
 * apart.
 */
function restoreDecision(input) {
    const { hookInput, customType, resolved, usageAnchor, onInjected } = input;
    // Access can be lost between placing a copy and restoring it.
    if (resolved.status === 'withdrawn')
        return withdrawAllDecision(customType, hookInput.messages);
    if (resolved.status !== 'ready')
        return undefined;
    const marker = createMarker(customType, resolved.content);
    if (!fitsReminderInFinalRequest(hookInput, marker, usageAnchor))
        return undefined;
    onInjected?.();
    return {
        type: 'appendMessage',
        reason: customType,
        message: marker,
        // Only takes effect after an initial compaction; otherwise the prepared
        // before-user message already covers the first request.
        ...(hookInput.phase === 'initial' ? { placement: 'before-current-user' } : {}),
    };
}
function createRestoreHook(customType, resolveContent, usageAnchor, onInjected) {
    return async (input) => {
        // The window still carries a copy: nothing to restore.
        if (carriesInWindow(customType, input.canonicalMessages))
            return undefined;
        const resolved = await resolveContent();
        return restoreDecision({ hookInput: input, customType, resolved, usageAnchor, onInjected });
    };
}
function createMarker(customType, content) {
    return {
        role: 'custom',
        customType,
        content,
        display: false,
        timestamp: Date.now(),
    };
}
/**
 * The restore hook for a Turn that started with nothing to show. Such a window
 * can still gain its first entry later in the same Turn, and a compaction then
 * rebuilds the window from the prefix, so without this the new window would
 * carry no copy at all.
 *
 * Only a compaction that happened after `prepare` is worth a read:
 * without one the window still holds the prefix this Turn started with, and
 * inserting a copy mid-window would move it. Each new boundary is read once,
 * whatever the read returns, so a still-empty source is not read again on
 * every request of the same window.
 */
function nothingPlacedHooks(input) {
    const keepOne = createKeepWindowCopyHook(input.customType);
    // A caller without a loader (the Memory summary) keeps the plain keep-one
    // hook: there is nothing it could read again.
    if (!input.loadContentWhenRestoring)
        return [keepOne];
    return [
        keepOne,
        createCompactionRestoreHook({
            customType: input.customType,
            loadContentWhenRestoring: input.loadContentWhenRestoring,
            usageAnchor: input.usageAnchor,
            onInjected: input.onInjected,
            preparedBoundary: latestCompactionBoundary(input.canonicalMessages),
        }),
    ];
}
function createCompactionRestoreHook(input) {
    const { customType, loadContentWhenRestoring, usageAnchor, onInjected, preparedBoundary } = input;
    const handled = new Set();
    return async (hookInput) => {
        const boundary = latestCompactionBoundary(hookInput.canonicalMessages);
        if (boundary === preparedBoundary || handled.has(boundary))
            return undefined;
        // Marked before the read, so one boundary is read once whether it comes
        // back ready, none or withdrawn.
        handled.add(boundary);
        const resolved = await loadContentWhenRestoring();
        return restoreDecision({ hookInput, customType, resolved, usageAnchor, onInjected });
    };
}
/**
 * Identifies the latest compaction boundary in a message list, or undefined
 * when the window was never compacted. Two lists reporting the same boundary
 * have the same model-visible prefix; a different one means a compaction
 * happened in between. The markers are the ones `latestIndexInWindow`
 * already treats as starting a fresh context.
 */
function latestCompactionBoundary(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message))
            continue;
        const timestamp = String(message.timestamp ?? '');
        if (message.role === 'compactionSummary') {
            return `summary:${timestamp}:${String(message.summary ?? '')}`;
        }
        if (Object.hasOwn(message, 'archonCompaction')) {
            return `archon:${timestamp}:${JSON.stringify(message.archonCompaction)}`;
        }
    }
    return undefined;
}
/**
 * Whether a copy, whatever its text, is in context after the latest
 * compaction (or anywhere when never compacted).
 */
export function carriesInWindow(customType, messages) {
    return latestIndexInWindow(customType, messages) !== -1;
}
function latestIndexInWindow(customType, messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message))
            continue;
        // Native summaries and legacy (archon) compaction markers both start a
        // fresh model-visible context; anything before them was summarized away.
        if (message.role === 'compactionSummary' || Object.hasOwn(message, 'archonCompaction')) {
            return -1;
        }
        if (isMarker(customType, message))
            return index;
    }
    return -1;
}
function isMarker(customType, message) {
    return isRecord(message) && message.role === 'custom' && message.customType === customType;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=window-frozen-reminder.js.map