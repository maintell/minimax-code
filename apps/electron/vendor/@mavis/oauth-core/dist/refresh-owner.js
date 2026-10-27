import { performance } from 'node:perf_hooks';
const owner = {
    pid: process.pid,
    startedAtMs: Math.trunc(performance.timeOrigin),
};
export function currentRefreshOwner() {
    return { ...owner };
}
/** Unknown/foreign reused PIDs stay live; only positive evidence may discard a grant. */
export function isRefreshOwnerAlive(candidate) {
    if (!candidate)
        return true; // Intermediate development builds wrote fences without an owner.
    if (candidate.pid === owner.pid)
        return candidate.startedAtMs === owner.startedAtMs;
    try {
        process.kill(candidate.pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
//# sourceMappingURL=refresh-owner.js.map