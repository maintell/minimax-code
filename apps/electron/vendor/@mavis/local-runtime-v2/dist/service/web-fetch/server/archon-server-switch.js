import { logger } from '../../../infra/logging/logger.js';
import { CoalescedStateWriter, isRecord, readWebFetchStateFile, } from '../local-state/web-fetch-state-file.js';
/** archon_biz endpoint answering whether the signed-in user may use the server reader. */
export const WEB_FETCH_CONFIG_PATH = '/archon/api/v1/web-fetch/config';
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const MAX_STORED_USERS = 8;
/** An answer this old is no answer: a switch nobody can refresh must not stay on for good. */
const MAX_ANSWER_AGE_MS = 7 * 24 * 60 * 60_000;
/**
 * The archon_biz switch, read per user. Reads never wait on the network: they
 * answer from memory (seeded from disk) and start a background refresh on the
 * first read after Runtime start, after a login or account switch, and when the
 * answer is six hours old. Token refreshes do not refetch. A failed refresh
 * keeps the last answer and is retried ten minutes later; a user never answered
 * for, or last answered for over seven days ago, is off.
 */
export class ArchonServerSwitch {
    fetchConfig;
    currentLogin;
    stateFilePath;
    now;
    users;
    nextAttemptMs = new Map();
    askedForLogin = new Map();
    inFlight = new Map();
    writer;
    constructor(options) {
        this.fetchConfig = options.fetchConfig;
        this.currentLogin = options.currentLogin;
        this.stateFilePath = options.stateFilePath ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.writer = new CoalescedStateWriter({
            filePath: this.stateFilePath,
            snapshot: () => ({ users: Object.fromEntries(this.keepNewestUsers()) }),
            now: this.now,
        });
    }
    /** Writes any answers still in flight; the Runtime awaits this when closing. */
    flush() {
        return this.writer.flush();
    }
    serverReaderEnabled(userKey) {
        if (this.isNewLogin(userKey) || this.isDue(userKey))
            this.startRefresh(userKey);
        const answer = this.load().get(userKey);
        return answer !== undefined && answer.enabled && !this.isExpired(answer);
    }
    /** Fetches the switch for this user now; concurrent callers share one request. */
    refresh(userKey) {
        this.startRefresh(userKey);
        return this.inFlight.get(userKey) ?? Promise.resolve();
    }
    isExpired(answer) {
        return this.now() - answer.fetchedAtMs > MAX_ANSWER_AGE_MS;
    }
    isNewLogin(userKey) {
        const login = this.currentLogin();
        if (login?.userKey !== userKey)
            return false;
        if (this.askedForLogin.has(userKey) && this.askedForLogin.get(userKey) === login.loginEpoch) {
            return false;
        }
        this.askedForLogin.set(userKey, login.loginEpoch);
        return true;
    }
    isDue(userKey) {
        return (this.nextAttemptMs.get(userKey) ?? 0) <= this.now();
    }
    startRefresh(userKey) {
        if (this.inFlight.has(userKey))
            return;
        // A failure leaves this retry window in place; a success replaces it.
        this.nextAttemptMs.set(userKey, this.now() + RETRY_AFTER_FAILURE_MS);
        this.inFlight.set(userKey, this.fetchAndStore(userKey));
    }
    async fetchAndStore(userKey) {
        try {
            const response = await this.fetchConfig();
            // The login may have changed while the request was in flight; the answer
            // then belongs to someone else.
            if (this.currentLogin()?.userKey !== userKey)
                return;
            const enabled = readServerReaderEnabled(response);
            if (enabled === undefined) {
                logger.warn({}, 'web_fetch server switch answer unusable, keeping the last one');
                return;
            }
            this.load().set(userKey, { enabled, fetchedAtMs: this.now() });
            this.nextAttemptMs.set(userKey, this.now() + REFRESH_INTERVAL_MS);
            this.writer.markDirty();
        }
        catch (error) {
            // Keep the last answer; the next read after the retry window asks again,
            // which also paces this warning.
            logger.warn({ error_name: error instanceof Error ? error.name : 'unknown' }, 'web_fetch server switch refresh failed, keeping the last answer');
        }
        finally {
            this.inFlight.delete(userKey);
        }
    }
    load() {
        if (this.users)
            return this.users;
        const filePath = this.stateFilePath();
        // A stored answer serves reads until this Runtime has asked once itself.
        this.users = new Map(readStoredUsers(filePath ? readWebFetchStateFile(filePath) : undefined));
        return this.users;
    }
    keepNewestUsers() {
        const kept = [...(this.users ?? [])]
            .sort((left, right) => right[1].fetchedAtMs - left[1].fetchedAtMs)
            .slice(0, MAX_STORED_USERS);
        this.users = new Map(kept);
        return kept;
    }
}
/** `undefined` when the body is not a successful answer, so the last one is kept. */
function readServerReaderEnabled(response) {
    const baseResp = isRecord(response.base_resp) ? response.base_resp : undefined;
    if (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0)
        return undefined;
    const enabled = response.server_reader_enabled;
    return typeof enabled === 'boolean' ? enabled : undefined;
}
function readStoredUsers(stored) {
    const users = isRecord(stored) && isRecord(stored.users) ? stored.users : {};
    const entries = [];
    for (const [userKey, value] of Object.entries(users)) {
        if (!isRecord(value) || typeof value.enabled !== 'boolean')
            continue;
        const fetchedAtMs = typeof value.fetchedAtMs === 'number' ? value.fetchedAtMs : 0;
        entries.push([userKey, { enabled: value.enabled, fetchedAtMs }]);
    }
    return entries;
}
//# sourceMappingURL=archon-server-switch.js.map