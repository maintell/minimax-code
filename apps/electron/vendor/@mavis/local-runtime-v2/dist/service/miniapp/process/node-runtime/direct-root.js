/**
 * Stops only the Host-spawned Node root. Descendant lifecycle belongs to the plugin.
 * A direct-child `exit` is the ownership proof on both POSIX and Windows.
 */
export function createDirectNodeRootTerminator(child, options = {}) {
    const wait = options.wait ?? defaultWait;
    const platform = options.platform ?? process.platform;
    const graceMs = options.graceMs ?? 2_000;
    const settlementMs = options.settlementMs ?? 4_000;
    const pollMs = options.pollMs ?? 25;
    let spawned = child.pid !== undefined;
    let failedBeforeSpawn = false;
    let exited = (child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined);
    let proven;
    let inFlight;
    child.once('exit', () => {
        exited = true;
    });
    child.once('spawn', () => {
        spawned = true;
    });
    child.once('error', () => {
        if (!spawned && child.pid === undefined)
            failedBeforeSpawn = true;
    });
    const rootAbsentOrExited = () => failedBeforeSpawn || exited;
    const waitForExit = async (timeoutMs) => {
        let elapsed = 0;
        while (!rootAbsentOrExited() && elapsed < timeoutMs) {
            const interval = Math.min(pollMs, timeoutMs - elapsed);
            await wait(interval);
            elapsed += interval;
        }
        return rootAbsentOrExited();
    };
    return {
        async stop() {
            if (proven)
                return proven;
            if (inFlight)
                return inFlight;
            const attempt = (async () => {
                if (rootAbsentOrExited() || (await waitForExit(graceMs)))
                    return { proven: true };
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    // The exit event remains authoritative.
                }
                if (platform === 'win32')
                    return { proven: await waitForExit(settlementMs) };
                const termSettlementMs = Math.ceil(settlementMs / 2);
                if (await waitForExit(termSettlementMs))
                    return { proven: true };
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // The bounded exit wait below remains authoritative.
                }
                return { proven: await waitForExit(settlementMs - termSettlementMs) };
            })();
            inFlight = attempt;
            try {
                const result = await attempt;
                if (result.proven)
                    proven = { proven: true };
                return result;
            }
            finally {
                if (inFlight === attempt)
                    inFlight = undefined;
            }
        },
    };
}
function defaultWait(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}
//# sourceMappingURL=direct-root.js.map