import { LocalWebFetchClient } from '../local-web-fetch-client.js';
import { join } from 'node:path';
import { IntranetGuard, intranetHostOf } from './intranet-guard.js';
import { WebFetchClientConfigCache } from '../server/client-config.js';
import { anyServerSwitch, buildEnvServerSwitch, } from '../server/build-env-switch.js';
import { ArchonServerSwitch, WEB_FETCH_CONFIG_PATH } from '../server/archon-server-switch.js';
import { LocalMatrixClient } from '../../matrix/index.js';
import { LearnedIntranetHosts } from '../local-state/learned-intranet-hosts.js';
import { WebFetchDailyUsage, WEB_FETCH_USER_DAILY_CALLS_METRIC, } from '../local-state/daily-usage.js';
import { NonHtmlHint } from './non-html-hint.js';
import { ServerWebFetchReader, } from '../server/server-web-fetch-reader.js';
/** Consecutive server failures that open the breaker. */
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
/** Backoff after a 402, which carries no server-supplied window. */
const QUOTA_BACKOFF_MS = 10 * 60_000;
/**
 * Server answers that, followed by a usable local read, count as a miss toward
 * learning an intranet host. `invalid_url` and `empty_content` are left out: a
 * malformed URL, a provider parameter error or a page without readable text say
 * nothing about where the host is reachable from.
 */
const SERVER_CANNOT_REACH = new Set(['unreachable']);
/**
 * Server answers that say nothing about the host being reachable only from here,
 * which starts a miss count over. `blocked` is usually the target refusing the
 * reader, so the reader got there.
 */
const SERVER_REACHED_HOST = new Set(['non_html', 'empty_content', 'blocked']);
/** The server reader returns Markdown, whatever the page was. */
const SERVER_CONTENT_TYPE = 'text/markdown';
/**
 * Providers the server can name. Anything else becomes one `other` series, so a
 * response cannot mint metric series.
 */
const KNOWN_PROVIDERS = new Set(['open_platform', 'aliyun', 'jina']);
const LOCAL_FALLBACK = {
    routeReason: 'server_fallback_local',
    health: 'healthy',
};
/**
 * Every non-`ok` status the server can answer with. A status is only unhealthy
 * when the server itself failed; a page it could not read says nothing about
 * whether the next one will succeed.
 */
const SERVER_STATUS_HANDLING = {
    non_html: { routeReason: 'server_non_html', health: 'healthy' },
    unreachable: LOCAL_FALLBACK,
    empty_content: LOCAL_FALLBACK,
    blocked: LOCAL_FALLBACK,
    invalid_url: LOCAL_FALLBACK,
    provider_error: { routeReason: 'server_fallback_local', health: 'unhealthy' },
    busy: { routeReason: 'server_busy', health: 'capacity' },
    quota_exceeded: { routeReason: 'server_quota_fallback', health: 'quota' },
    not_enabled: { routeReason: 'server_disabled', health: 'disabled' },
};
/**
 * `status` stays unset: the default provider cannot report the target's HTTP
 * status for a successful read, and a made-up 200 would claim what nobody saw.
 */
function serverResult(outcome) {
    return {
        via: 'server',
        routeReason: 'server_ok',
        content: outcome.content,
        contentType: SERVER_CONTENT_TYPE,
        ...(outcome.title ? { title: outcome.title } : {}),
        ...(outcome.finalUrl ? { finalUrl: outcome.finalUrl } : {}),
        retrievalOutcome: 'usable_content',
        base_resp: { status_code: 0 },
        server: {
            ...(outcome.provider ? { provider: outcome.provider } : {}),
            ...(outcome.cacheHit !== undefined ? { cacheHit: outcome.cacheHit } : {}),
            ...(outcome.fetchedAtMs !== undefined ? { fetchedAtMs: outcome.fetchedAtMs } : {}),
        },
    };
}
/**
 * Decides, per call, whether `web_fetch` reads a page on this machine or through
 * the server reader, and falls back to this machine whenever the server cannot
 * serve the request.
 *
 * One instance per Runtime: backoff and circuit state must outlive a Turn. That
 * state is keyed by platform user, so a login change needs no reset.
 */
export class WebFetchRouter {
    localClient;
    configCache;
    guard;
    nonHtmlHint;
    learnedIntranetHosts;
    dailyUsage;
    stateOwners;
    serverReader;
    authContextGetter;
    metrics;
    now;
    state = new Map();
    constructor(options) {
        this.localClient = options.localClient;
        this.configCache = options.configCache;
        this.guard = options.guard;
        this.nonHtmlHint =
            options.nonHtmlHint ?? new NonHtmlHint(options.now ? { now: options.now } : {});
        this.learnedIntranetHosts = options.learnedIntranetHosts;
        this.dailyUsage = options.dailyUsage;
        this.stateOwners = options.stateOwners ?? [];
        this.serverReader = options.serverReader;
        this.authContextGetter = options.authContextGetter;
        this.metrics = options.metrics;
        this.now = options.now ?? Date.now;
    }
    /** Lets in-flight state writes finish before the process exits. */
    async flushState() {
        await Promise.all(this.stateOwners.map((owner) => owner.flush()));
    }
    async fetch(ctx, input, signal) {
        const userKey = platformUserOf(this.authContextGetter?.());
        if (!userKey)
            return this.localClient.fetch(ctx, input, signal);
        this.dailyUsage?.recordCall(userKey);
        if (!this.serverReader || !this.configCache.serverReaderSwitchedOn(userKey)) {
            // The server path is switched off for this Runtime: the router stays
            // transparent so the result matches the pre-router client exactly.
            return this.localClient.fetch(ctx, input, signal);
        }
        return this.routeForUser({ ctx, input, signal }, userKey);
    }
    async routeForUser(call, userKey) {
        const { input } = call;
        if ((input.method ?? 'GET') === 'HEAD') {
            return this.localRouted(call, 'head_method');
        }
        const config = this.configCache.get(userKey);
        if (!config.serverReaderEnabled) {
            return this.localRouted(call, 'server_disabled');
        }
        const state = this.stateFor(userKey);
        const nowMs = this.now();
        if (state.backoffUntilMs > nowMs) {
            return this.localRouted(call, 'server_backoff');
        }
        if (state.circuitOpenUntilMs > nowMs) {
            return this.localRouted(call, 'server_circuit_open');
        }
        if (this.nonHtmlHint.predicts(input.url)) {
            return this.localRouted(call, 'non_html_hint');
        }
        const classification = await this.guard.classify(input.url);
        if (classification !== 'forwardable') {
            return this.localRouted(call, intranetReason(classification));
        }
        // The lookup can outlast a login change. The request would then carry the new
        // account's token while every check above was made for this one.
        if (platformUserOf(this.authContextGetter?.()) !== userKey) {
            return this.localRouted(call, 'server_fallback_local');
        }
        const outcome = await this.readFromServer(call.ctx, input.url, call.signal);
        return this.routeServerOutcome(call, userKey, outcome);
    }
    async readFromServer(ctx, url, signal) {
        try {
            return await this.serverReaderOrThrow().read(ctx, url, signal);
        }
        catch (error) {
            // An abort is the caller's decision, not a server fault: propagate it and
            // do not spend the user's fallback on a request they cancelled.
            if (signal?.aborted)
                throw error;
            return { kind: 'failure' };
        }
    }
    async routeServerOutcome(call, userKey, outcome) {
        if (outcome.kind === 'ok') {
            this.recordSuccess(userKey);
            this.dailyUsage?.recordServerRead(userKey);
            this.withHostOf(call.input.url, (host) => this.learnedIntranetHosts?.recordServerRead(host));
            return this.report(serverResult(outcome));
        }
        if (outcome.kind === 'quota') {
            this.backOff(userKey, outcome.retryAfterMs ?? QUOTA_BACKOFF_MS);
            return this.localRouted(call, 'server_quota_fallback');
        }
        if (outcome.kind === 'failure') {
            this.recordFailure(userKey);
            return this.localRouted(call, 'server_fallback_local');
        }
        if (outcome.status === 'non_html')
            this.nonHtmlHint.remember(call.input.url);
        if (SERVER_REACHED_HOST.has(outcome.status)) {
            this.withHostOf(call.input.url, (host) => this.learnedIntranetHosts?.recordServerRead(host));
        }
        const handling = SERVER_STATUS_HANDLING[outcome.status];
        this.applyServerStatusHandling(handling, userKey, outcome.retryAfterMs);
        const result = await this.localRouted(call, handling.routeReason);
        if (SERVER_CANNOT_REACH.has(outcome.status) && result.retrievalOutcome === 'usable_content') {
            this.withHostOf(call.input.url, (host) => this.learnedIntranetHosts?.recordServerMiss(host));
        }
        return result;
    }
    withHostOf(url, use) {
        const host = intranetHostOf(url);
        if (host)
            use(host);
    }
    /**
     * A status the server answered is not evidence that the server is unhealthy.
     * Only its own faults and transport failures move the breaker.
     */
    applyServerStatusHandling(handling, userKey, retryAfterMs) {
        switch (handling.health) {
            case 'healthy':
                this.recordSuccess(userKey);
                return;
            case 'unhealthy':
                this.recordFailure(userKey);
                return;
            case 'quota':
                this.backOff(userKey, retryAfterMs ?? QUOTA_BACKOFF_MS);
                return;
            case 'disabled':
                this.configCache.disableUntil(userKey, retryAfterMs);
                return;
            default:
                // Capacity, not health: retrying later is worthwhile, so a busy answer
                // clears the failure run without claiming the server is well.
                this.stateFor(userKey).consecutiveFailures = 0;
        }
    }
    async localRouted(call, routeReason) {
        const result = await this.localClient.fetch(call.ctx, call.input, call.signal);
        return this.report({ ...result, via: 'local', routeReason });
    }
    report(result) {
        // The URL is deliberately not reported: route mix is the signal, not which
        // pages were read.
        this.metrics?.incr('web_fetch_route_total', {
            via: result.via ?? 'local',
            route_reason: result.routeReason ?? 'no_user_session',
            ...(result.server?.provider ? { provider: providerLabel(result.server.provider) } : {}),
            ...(result.server?.cacheHit !== undefined
                ? { cache_hit: String(result.server.cacheHit) }
                : {}),
        });
        return result;
    }
    stateFor(userKey) {
        const existing = this.state.get(userKey);
        if (existing)
            return existing;
        const created = {
            consecutiveFailures: 0,
            circuitOpenUntilMs: 0,
            backoffUntilMs: 0,
        };
        this.state.set(userKey, created);
        return created;
    }
    recordSuccess(userKey) {
        const state = this.stateFor(userKey);
        state.consecutiveFailures = 0;
        state.circuitOpenUntilMs = 0;
    }
    recordFailure(userKey) {
        const state = this.stateFor(userKey);
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            state.circuitOpenUntilMs = this.now() + CIRCUIT_OPEN_MS;
            state.consecutiveFailures = 0;
        }
    }
    backOff(userKey, durationMs) {
        this.stateFor(userKey).backoffUntilMs = this.now() + durationMs;
    }
    serverReaderOrThrow() {
        if (!this.serverReader)
            throw new Error('Server web_fetch reader is not configured');
        return this.serverReader;
    }
}
/** Assembles the router for one Runtime. */
export function initializeWebFetchRouter(options = {}) {
    const now = options.now ? { now: options.now } : {};
    const stateFile = (name) => () => {
        const dataDir = options.dataDir?.();
        return dataDir ? join(dataDir, 'web-fetch', name) : undefined;
    };
    const learnedIntranetHosts = new LearnedIntranetHosts({
        stateFilePath: stateFile('intranet-hosts.json'),
        ...now,
    });
    const dailyUsage = buildDailyUsage(options, stateFile('daily-usage.json'));
    dailyUsage?.reportFinishedDays();
    const archonSwitch = buildArchonSwitch(options, stateFile('server-switch.json'));
    return new WebFetchRouter({
        localClient: new LocalWebFetchClient({
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
        configCache: new WebFetchClientConfigCache({
            // The environment override is test-only, until archon_biz serves the test environments.
            serverSwitch: options.serverSwitch ?? anyServerSwitch(buildEnvServerSwitch(), archonSwitch),
            ...now,
        }),
        guard: new IntranetGuard({
            isLearnedIntranetHost: (host) => learnedIntranetHosts.has(host),
            ...now,
        }),
        learnedIntranetHosts,
        ...(dailyUsage ? { dailyUsage } : {}),
        stateOwners: [learnedIntranetHosts, archonSwitch, ...(dailyUsage ? [dailyUsage] : [])],
        serverReader: buildServerReader(options),
        ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
        ...now,
    });
}
/** Timeout for the archon_biz switch read; it never blocks a page read. */
const SWITCH_FETCH_TIMEOUT_MS = 5_000;
function buildArchonSwitch(options, stateFilePath) {
    const client = new LocalMatrixClient({
        ...managedAuth(options),
        routingContextGetter: options.routingContextGetter,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return new ArchonServerSwitch({
        fetchConfig: () => client.getGatewayJson(WEB_FETCH_CONFIG_PATH, undefined, SWITCH_FETCH_TIMEOUT_MS),
        currentLogin: () => {
            const auth = options.authContextGetter?.();
            const userKey = platformUserOf(auth);
            return userKey ? { userKey, loginEpoch: auth?.loginEpoch } : undefined;
        },
        stateFilePath,
        ...(options.now ? { now: options.now } : {}),
    });
}
function buildDailyUsage(options, stateFilePath) {
    const histogram = options.histogram;
    if (!histogram)
        return undefined;
    return new WebFetchDailyUsage({
        observe: (value, labels) => histogram(WEB_FETCH_USER_DAILY_CALLS_METRIC, value, labels),
        stateFilePath,
        ...(options.now ? { now: options.now } : {}),
    });
}
function managedAuth(options) {
    return {
        ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
        ...(options.authContextInvalidator
            ? { authContextInvalidator: options.authContextInvalidator }
            : {}),
    };
}
function buildServerReader(options) {
    return new ServerWebFetchReader({
        ...managedAuth(options),
        routingContextGetter: options.routingContextGetter,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.matrixLogger ? { matrixLogger: options.matrixLogger } : {}),
    });
}
function providerLabel(provider) {
    return KNOWN_PROVIDERS.has(provider) ? provider : 'other';
}
/**
 * The user a call belongs to. Routing state, the stored switch answer and daily
 * counts are all per user, so a call that cannot name one stays on this device:
 * a shared bucket would let one account inherit another's answer.
 */
function platformUserOf(auth) {
    if (auth?.authState === 'logged_out' || !auth?.accessToken?.trim())
        return undefined;
    return auth.realUserID?.trim() || undefined;
}
function intranetReason(classification) {
    switch (classification) {
        case 'learned':
            return 'intranet_learned';
        case 'dns':
            return 'intranet_dns';
        case 'dns_notfound':
            return 'intranet_dns_notfound';
        case 'dns_error':
            return 'intranet_dns_error';
        default:
            return 'intranet_literal';
    }
}
//# sourceMappingURL=web-fetch-router.js.map