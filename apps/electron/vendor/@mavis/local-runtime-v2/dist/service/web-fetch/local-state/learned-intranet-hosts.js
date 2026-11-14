import { CoalescedStateWriter, isRecord, readWebFetchStateFile } from './web-fetch-state-file.js';
/** A learned host is asked about again after this long, so a wrong guess heals by itself. */
const ENTRY_TTL_MS = 15 * 24 * 60 * 60_000;
/**
 * Misses in a row before a host is learned. `unreachable` also covers a provider
 * timeout, so one miss is not enough to stop asking the server about a host.
 */
const MISSES_TO_LEARN = 2;
const MAX_ENTRIES = 1_000;
/**
 * Hosts this device has shown to be reachable only from here: the server could
 * not read them twice in a row, and the local fetches that followed succeeded.
 * Once learned, a host is read on this device without asking the server again.
 *
 * The list is per profile and lives in the profile data dir. It is learned, not
 * configured; there is no built-in company list.
 */
export class LearnedIntranetHosts {
    stateFilePath;
    now;
    /** host -> when it was learned, as persisted. */
    hosts;
    /** Misses since the server last read a host. In memory only: a restart starts over. */
    misses = new Map();
    writer;
    constructor(options = {}) {
        this.stateFilePath = options.stateFilePath ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.writer = new CoalescedStateWriter({
            filePath: this.stateFilePath,
            snapshot: () => ({ hosts: Object.fromEntries(this.keepNewestEntries()) }),
            now: this.now,
        });
    }
    /** Writes any entries still in flight; the Runtime awaits this when closing. */
    flush() {
        return this.writer.flush();
    }
    has(host) {
        const hosts = this.load();
        const learnedAt = hosts.get(host);
        if (learnedAt === undefined)
            return false;
        if (isFresh(learnedAt, this.now()))
            return true;
        hosts.delete(host);
        this.writer.markDirty();
        return false;
    }
    /** The server could not reach a host this device just read. */
    recordServerMiss(host) {
        const misses = (this.misses.get(host) ?? 0) + 1;
        if (misses >= MISSES_TO_LEARN) {
            this.misses.delete(host);
            this.learn(host);
            return;
        }
        if (this.misses.size >= MAX_ENTRIES)
            this.dropOldestMiss();
        this.misses.set(host, misses);
    }
    /** The server read this host, so its earlier misses said nothing about reachability. */
    recordServerRead(host) {
        this.misses.delete(host);
    }
    learn(host) {
        const hosts = this.load();
        hosts.set(host, this.now());
        if (hosts.size > MAX_ENTRIES)
            this.keepNewestEntries();
        this.writer.markDirty();
    }
    dropOldestMiss() {
        const oldest = this.misses.keys().next().value;
        if (oldest !== undefined)
            this.misses.delete(oldest);
    }
    load() {
        if (this.hosts)
            return this.hosts;
        const filePath = this.stateFilePath();
        const stored = filePath ? readWebFetchStateFile(filePath) : undefined;
        this.hosts = new Map(readEntries(stored, this.now()));
        return this.hosts;
    }
    keepNewestEntries() {
        const kept = [...(this.hosts ?? [])]
            .sort((left, right) => right[1] - left[1])
            .slice(0, MAX_ENTRIES);
        this.hosts = new Map(kept);
        return kept;
    }
}
/** A time ahead of the clock means the clock moved back; such an entry must not outlive the TTL. */
function isFresh(learnedAt, nowMs) {
    const ageMs = nowMs - learnedAt;
    return ageMs >= 0 && ageMs <= ENTRY_TTL_MS;
}
function readEntries(stored, nowMs) {
    const hosts = isRecord(stored) && isRecord(stored.hosts) ? stored.hosts : {};
    return Object.entries(hosts).filter((entry) => typeof entry[1] === 'number' && isFresh(entry[1], nowMs));
}
//# sourceMappingURL=learned-intranet-hosts.js.map