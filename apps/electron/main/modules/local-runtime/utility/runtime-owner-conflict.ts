/**
 * Rootless V2 runtime-owner conflict: the one utility bootstrap failure that
 * has a user-side fix (another client of the same dataDir still holds the
 * owner lease), lifted out of the raw error chain so main can both act on it
 * and tell the user what to do about it.
 *
 * Why detection is re-implemented here instead of reusing the runtime
 * package's `isOwnersActiveError`: that helper only inspects the TOP-level
 * error, and the fence surfaces this failure in two shapes —
 *   - the generation swap path rethrows the owners-active error unwrapped;
 *   - the checkpoint path wraps it in ROOTLESS_V2_CHECKPOINT_FAILED and keeps
 *     the original on `.cause`.
 * The reports this exists for show the WRAPPED shape ("Rootless V2 checkpoint
 * failed | caused by ... owners are active"), so a top-level-only check misses
 * the case that actually happens. Walking the chain on this side also leaves
 * the runtime package's own throw-site semantics untouched.
 *
 * This module is shared by both processes (the utility classifies, main
 * renders), so it must stay free of electron and app-config imports.
 */

/**
 * Error code minted by the generation fence in @mavis/local-runtime-v2. Mirrored
 * as a literal because the package does not export the constant; it is part of
 * that fence's error contract, so a drift here shows up as owner conflicts
 * silently falling back to the generic retry path.
 */
export let ROOTLESS_V2_OWNERS_ACTIVE_CODE = 'ROOTLESS_V2_OWNERS_ACTIVE';
/**
 * Depth bound for the cause walk. Matches the init diagnostic formatter's own
 * bound so the marker and the `detail` string can never disagree about which
 * links of the chain were examined.
 */
const MAX_OWNER_CONFLICT_SCAN_LINKS = 6;
/**
 * Finds an owners-active error anywhere in `error`'s cause / AggregateError
 * chain and projects it onto the fields main consumes. Returns null when the
 * failure is something else, which keeps every other error on the unchanged
 * retry path.
 */
export function findRuntimeOwnerConflict(error) {
    const seen = new Set();
    const pending = [error];
    let inspected = 0;
    while (pending.length > 0 && inspected < MAX_OWNER_CONFLICT_SCAN_LINKS) {
        const current = pending.shift();
        if (current === undefined || current === null)
            continue;
        if (typeof current === 'object') {
            // Cause chains can be cyclic (a rethrow that re-attaches its own cause);
            // without this the walk never terminates.
            if (seen.has(current))
                continue;
            seen.add(current);
        }
        inspected += 1;
        if (readErrorCode(current) === ROOTLESS_V2_OWNERS_ACTIVE_CODE) {
            const holderPid = readHolderPid(current);
            return holderPid === undefined ? {} : { holderPid };
        }
        const cause = readProperty(current, 'cause');
        if (cause !== undefined)
            pending.push(cause);
        const aggregated = readProperty(current, 'errors');
        if (Array.isArray(aggregated))
            pending.push(...aggregated);
    }
    return null;
}
/**
 * User-facing, actionable text for an owner conflict. Locale is passed in
 * rather than read here: this module is loaded in the utility process too,
 * where the desktop language preference is not available.
 */
export function describeRuntimeOwnerConflict(conflict, isEnglish) {
    // Product name is inlined rather than read from app-identity: that module
    // pulls the electron app config, which this shared module must not depend on.
    const pid = conflict.holderPid;
    if (isEnglish) {
        const holder = pid === undefined ? '' : ` (pid ${pid})`;
        return (`Another MiniMax Agent client${holder} is using the same data directory. ` +
            `Quit it, then try again.`);
    }
    const holder = pid === undefined ? '' : `（pid ${pid}）`;
    return `检测到另一个 MiniMax 客户端${holder}正在使用同一数据目录，请先退出后重试`;
}
function readProperty(value, key) {
    if (typeof value !== 'object' || value === null || !(key in value))
        return undefined;
    return value[key];
}
function readErrorCode(value) {
    const code = readProperty(value, 'code');
    return typeof code === 'string' ? code : undefined;
}
/**
 * Reads the fence's `holderPid`. Rejects anything that is not a plausible pid:
 * the value is rendered straight into an instruction telling the user which
 * process to quit, so a garbage pid is worse than none at all.
 */
function readHolderPid(value) {
    const holderPid = readProperty(value, 'holderPid');
    if (typeof holderPid !== 'number')
        return undefined;
    if (!Number.isSafeInteger(holderPid) || holderPid <= 0)
        return undefined;
    return holderPid;
}
