const DEFAULT_DEDUP_TTL_MS = 5 * 60_000;
const DEFAULT_DEDUP_MAX_ENTRIES = 1000;
const DEDUP_EVICT_RATIO = 0.25;
/**
 * Inbound access control. Runs in this order (D3 + D2):
 *
 * 1. **Dedup** — if `eventId` is present, look up the composite key
 *    `${platform}:${clientName}:${eventId}` in `dedupCache`. A hit inside
 *    `dedupTtlMs` returns `'dedup'` (no work performed).
 * 2. **Group hard-block** — for platforms that require the owner gate, any
 *    non-p2p event returns `'deny'` *before* the owner check. This is the
 *    safe default: `@bot` mention in a group is a trigger, not an
 *    authorisation, and group allowlist support is deferred to Phase 5.
 * 3. **Owner gate** — if the platform requires it, ask the owner store to
 *    claim or compare. The owner store serialises per `clientName` so two
 *    concurrent first-DM events cannot both bootstrap ownership.
 * 4. **Allow** — for platforms that do not require the owner gate, the
 *    message passes through (e.g. WeChat iLink Bot is p2p-only).
 */
export async function checkChannelAccess(ctx, eventId, dedupCache, options) {
    if (!ctx.clientName || !ctx.senderId) {
        return 'deny';
    }
    // 1. Dedup — composite key avoids cross-platform / cross-bot id collisions
    //    (D3). `eventId` is optional, so a missing id simply skips dedup.
    if (checkDedupHit(ctx, eventId, dedupCache, options))
        return 'dedup';
    // 2 + 3. Group hard-block + owner gate.
    const gateDecision = await runOwnerGates(ctx, options);
    if (gateDecision === 'deny')
        return 'deny';
    // 4. Record the event id for future dedup, *after* the owner check has
    //    succeeded. A denied event must not poison the dedup cache, otherwise
    //    a retried-but-now-owner event would be silently dropped.
    if (eventId && !options.skipDedupCheck) {
        const dedupKey = buildDedupKey(ctx.platform, ctx.clientName, eventId);
        dedupCache.set(dedupKey, Date.now());
        evictIfNeeded(dedupCache, options.dedupMaxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES);
    }
    return 'allow';
}
/** Step 1: replay suppression. A hit refreshes the entry (LRU via Map order). */
function checkDedupHit(ctx, eventId, dedupCache, options) {
    if (!eventId || options.skipDedupCheck)
        return false;
    const dedupKey = buildDedupKey(ctx.platform, ctx.clientName, eventId);
    if (!isDedupHit(dedupCache, dedupKey, options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS))
        return false;
    // Refresh the entry so repeated-but-allowed traffic does not evict the
    // legitimate key. The set-also-keeps-insertion-order Map semantics
    // implement the LRU.
    dedupCache.set(dedupKey, Date.now());
    return true;
}
/** Steps 2+3: non-p2p hard-block then the per-client owner gate (both optional). */
async function runOwnerGates(ctx, options) {
    const requiresGate = options.requiresOwnerGate?.(ctx.platform) ?? false;
    if (!requiresGate)
        return 'allow';
    if (!options.skipGroupHardBlock && !isP2pChat(ctx.chatType))
        return 'deny';
    if (options.skipOwnerGate)
        return 'allow';
    if (!options.ownerStore) {
        // No owner store configured → fail closed. This matches the principle
        // that the gate must not silently disappear if a wiring step is missed.
        return 'deny';
    }
    const decision = await options.ownerStore.checkAndBootstrap(ctx.clientName, ctx.senderId, undefined);
    return decision === 'deny' ? 'deny' : 'allow';
}
function buildDedupKey(platform, clientName, eventId) {
    return `${platform}:${clientName}:${eventId}`;
}
function isDedupHit(cache, key, ttlMs) {
    const storedAt = cache.get(key);
    if (storedAt === undefined)
        return false;
    if (Date.now() - storedAt > ttlMs) {
        cache.delete(key);
        return false;
    }
    return true;
}
function evictIfNeeded(cache, maxEntries) {
    if (cache.size <= maxEntries)
        return;
    const dropCount = Math.ceil(cache.size * DEDUP_EVICT_RATIO);
    let dropped = 0;
    for (const key of cache.keys()) {
        cache.delete(key);
        dropped += 1;
        if (dropped >= dropCount)
            break;
    }
}
export function isP2pChat(chatType) {
    if (!chatType)
        return false;
    const normalized = chatType.trim().toLowerCase();
    return normalized === 'p2p' || normalized === 'private' || normalized === 'dm';
}
//# sourceMappingURL=access.js.map