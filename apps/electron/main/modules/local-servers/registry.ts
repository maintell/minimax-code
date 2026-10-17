import { extractLocalServerOrigins } from "./url-extractor";
const MAX_SERVERS_PER_SESSION = 20;
const PARTIAL_LINE_CAP = 2048;
const PROBE_CACHE_TTL_MS = 3000;
const PROBE_TIMEOUT_MS = 800;
async function defaultProbe(origin) {
    try {
        // Any HTTP response (any status, including redirects) means something is
        // listening; only network-level failures count as offline.
        await fetch(origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Per-session registry of local dev server origins seen in terminal output.
 * Ingests raw PTY chunks (line-buffered per terminal so URLs split across
 * chunks still match) and probes liveness on demand with caching.
 */
export class LocalServerRegistry {
    constructor(options) {
        this.bySession = new Map();
        this.partialLines = new Map();
        this.probeCache = new Map();
        this.inFlightProbes = new Map();
        this.probe = options?.probe ?? defaultProbe;
        this.now = options?.now ?? Date.now;
    }
    ingest(event) {
        const sessionId = event.sessionId;
        if (!sessionId)
            return;
        const buffered = (this.partialLines.get(event.terminalId) ?? '') + event.data;
        const lines = buffered.split(/\r?\n/);
        // Only scan completed lines: a URL truncated at a chunk boundary
        // (e.g. "http://localhost:51" + "73") must not register a phantom port.
        const remainder = lines.pop() ?? '';
        this.partialLines.set(event.terminalId, remainder.slice(-PARTIAL_LINE_CAP));
        for (const origin of extractLocalServerOrigins(lines.join('\n'))) {
            this.record(sessionId, origin, event.terminalId);
        }
    }
    removeTerminal(terminalId) {
        this.partialLines.delete(terminalId);
    }
    async list(sessionId) {
        if (!sessionId)
            return [];
        const servers = this.bySession.get(sessionId);
        if (!servers || servers.size === 0)
            return [];
        const entries = Array.from(servers.entries());
        const results = await Promise.all(entries.map(async ([url, seen]) => ({
            url,
            online: await this.probeCached(url),
            lastSeenMs: seen.lastSeenMs,
            terminalId: seen.terminalId,
        })));
        return results.sort((a, b) => a.online === b.online ? b.lastSeenMs - a.lastSeenMs : a.online ? -1 : 1);
    }
    record(sessionId, origin, terminalId) {
        let servers = this.bySession.get(sessionId);
        if (!servers) {
            servers = new Map();
            this.bySession.set(sessionId, servers);
        }
        servers.set(origin, { lastSeenMs: this.now(), terminalId });
        if (servers.size > MAX_SERVERS_PER_SESSION) {
            let oldestKey = null;
            let oldestSeen = Infinity;
            for (const [key, value] of servers) {
                if (value.lastSeenMs < oldestSeen) {
                    oldestSeen = value.lastSeenMs;
                    oldestKey = key;
                }
            }
            if (oldestKey)
                servers.delete(oldestKey);
        }
    }
    probeCached(origin) {
        const cached = this.probeCache.get(origin);
        if (cached && this.now() - cached.checkedAtMs < PROBE_CACHE_TTL_MS) {
            return Promise.resolve(cached.online);
        }
        const inFlight = this.inFlightProbes.get(origin);
        if (inFlight)
            return inFlight;
        const promise = this.probe(origin)
            .then((online) => {
            this.probeCache.set(origin, { online, checkedAtMs: this.now() });
            return online;
        })
            .finally(() => {
            this.inFlightProbes.delete(origin);
        });
        this.inFlightProbes.set(origin, promise);
        return promise;
    }
}

let registry = null;
export function getLocalServerRegistry() {
    if (!registry)
        registry = new LocalServerRegistry();
    return registry;
}
