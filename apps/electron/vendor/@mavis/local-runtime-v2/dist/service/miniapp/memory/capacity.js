/** Fewest distinct Mini App backends any device may run at once (today's 8 GB baseline). */
const MINIAPP_CAPACITY_FLOOR = 3;
/** Most distinct Mini App backends any device may run at once. */
const MINIAPP_CAPACITY_CEILING = 10;
const GIB = 1024 ** 3;
/**
 * `K_device = clamp(⌊3 × M / 8⌋, 3, 10)` with `M = round(totalBytes / GiB)`. Rounding first keeps a
 * nominal 16 GB machine that reports 15.7 GiB at 6 instead of 5.
 */
export function deviceMiniAppCapacity(totalBytes) {
    const totalGiB = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.round(totalBytes / GIB) : 0;
    const scaled = Math.floor((3 * totalGiB) / 8);
    return Math.min(MINIAPP_CAPACITY_CEILING, Math.max(MINIAPP_CAPACITY_FLOOR, scaled));
}
//# sourceMappingURL=capacity.js.map