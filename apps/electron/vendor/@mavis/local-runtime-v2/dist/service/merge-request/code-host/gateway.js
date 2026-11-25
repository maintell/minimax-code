import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metrics';
import { emptyHostQueryResult, mergeHostQueryResults, } from './adapter.js';
import { classifyCliFailure, CodeHostRequestError, parseIncludedResponse, } from './cli-runner.js';
import { createGitHubAdapter } from './github.js';
import { createGitLabAdapter } from './gitlab.js';
import { CodeHostScheduler, ageMs } from './host-scheduler.js';
import { classifyWellKnownHost, loginCommand } from './urls.js';
import { settleInBackground } from '../../../infra/async/settle.js';
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TTL_MS = 10 * 60_000;
const CONFIGURED_HOSTS_TTL_MS = 10 * 60_000;
const JOB_LOG_TTL_MS = 5_000;
/** Every request to GitLab or GitHub goes through here: batching, budget, backoff, CLI probes. */
export class CodeHostGateway {
    options;
    scheduler;
    adapters;
    probes = new Map();
    probing = new Map();
    /** Numbers uncached actions so identical writes never share one request. */
    actions = 0;
    /** The hosts each CLI holds a login for, and when that list was read. */
    hostLists = new Map();
    hostListReads = new Map();
    stateListener;
    constructor(options) {
        this.options = options;
        this.scheduler = new CodeHostScheduler({
            nowMs: options.nowMs,
            budgetPerHour: () => options.limits().requestBudgetPerHour,
            onBudgetSkip: () => incrementMetric(options.metrics, 'merge_request_budget_skip_total', 1, {}),
        });
        this.adapters = options.adapters ?? {
            gitlab: createGitLabAdapter(options.nowMs),
            github: createGitHubAdapter(options.nowMs),
        };
    }
    async fetch(platform, host, projects, options) {
        // The host can come from a link in a command's output or from a remote, so a
        // background read must not invent a request to an arbitrary host: glab and gh
        // read tokens from the environment for any hostname. Only the hosts a CLI holds
        // a login for are read without the user asking. A user action is theirs to make.
        if (options.priority !== 'user' && !(await this.readableWithoutAsking(host, platform))) {
            incrementMetric(this.options.metrics, 'merge_request_cli_request_total', 1, {
                platform,
                purpose: 'refresh',
                outcome: 'not_authenticated',
            });
            return {
                result: emptyHostQueryResult(),
                error: new CodeHostRequestError('not_authenticated', 'No CLI is logged in to this host'),
            };
        }
        const adapter = this.adapters[platform];
        const call = this.call(platform, options.priority === 'user' ? 'user' : 'refresh', host);
        const settled = await Promise.allSettled(adapter.plan(projects).map((plan) => this.scheduler.run(host, `${platform}:${plan.query}`, async () => {
            // The platform reads its data after the request leaves, so the answer is at
            // least as new as this. Time of sending, not of answering, orders two reads.
            const sentAtMs = this.options.nowMs();
            return { ...(await adapter.execute(host, plan, call)), fetchedAtMs: sentAtMs };
        }, options)));
        const results = [];
        let error;
        for (const outcome of settled) {
            if (outcome.status === 'fulfilled')
                results.push(outcome.value);
            else
                error ??= this.observeFailure(platform, host, outcome.reason);
        }
        return { result: mergeHostQueryResults(results), ...(error ? { error } : {}) };
    }
    async jobLog(ref, jobId, options = {}) {
        const full = options.full === true;
        return this.act(ref, `log:${ref.projectPath}:${jobId}:${full ? 'full' : 'tail'}`, (adapter, call) => adapter.jobLog(ref, jobId, call, full ? { full } : undefined), { cacheTtlMs: JOB_LOG_TTL_MS });
    }
    /**
     * A user action on one host: a write, or a read the user asked for. It waits
     * its turn in the host's queue at user priority, so it is never turned away by
     * the hourly budget, and counts against it. Without `cacheTtlMs` every call goes
     * out, so two writes are never merged into one; with it, identical reads within
     * the window share one answer.
     */
    async act(at, label, work, options = {}) {
        const { platform, host } = at;
        const adapter = this.adapters[platform];
        const cached = options.cacheTtlMs !== undefined && options.cacheTtlMs > 0;
        this.actions += 1;
        const key = cached
            ? `act:${platform}:${label}`
            : `act:${platform}:${label}#${String(this.actions)}`;
        try {
            return await this.scheduler.run(host, key, () => work(adapter, this.call(platform, 'user', host)), {
                cacheTtlMs: cached ? (options.cacheTtlMs ?? 0) : 0,
                priority: 'user',
            });
        }
        catch (error) {
            throw this.observeFailure(platform, host, error);
        }
    }
    async status(platform, host, refresh = false) {
        const adapter = this.adapters[platform];
        const key = `${platform}:${host}`;
        const cached = this.probes.get(key);
        let probe;
        if (refresh || !cached) {
            probe = await this.probe(platform, host);
        }
        else {
            // An old check still answers at once, so a panel never waits on glab / gh
            // reporting what they reported last time; the check runs again behind it.
            probe = cached.probe;
            if (ageMs(cached.atMs, this.options.nowMs()) >= PROBE_TTL_MS)
                settleInBackground(this.reprobe(platform, host));
        }
        const checkedAtMs = this.probes.get(key)?.atMs;
        const usage = this.scheduler.usage(host);
        return {
            host,
            platform,
            cli: adapter.cli,
            cliState: !probe.installed ? 'not_installed' : probe.auth,
            loginCommand: loginCommand(platform, host),
            ...(probe.version ? { cliVersion: probe.version } : {}),
            ...(probe.accountLogin ? { accountLogin: probe.accountLogin } : {}),
            ...(probe.message ? { message: probe.message } : {}),
            ...(checkedAtMs !== undefined ? { checkedAtMs } : {}),
            ...(usage.rateLimitedUntilMs !== undefined
                ? { rateLimitedUntilMs: usage.rateLimitedUntilMs }
                : {}),
            requestsThisHour: usage.requestsThisHour,
            requestBudgetPerHour: this.options.limits().requestBudgetPerHour,
        };
    }
    /**
     * Whether a background read may go to this host. A name that merely looks like a
     * code host is not enough: glab and gh hand the token from the environment to
     * whatever hostname they are given, so a link in a command's output must not turn
     * into a request. Only github.com and hosts a CLI actually holds a login for pass;
     * the user can still reach any host they link by asking for a refresh.
     */
    async readableWithoutAsking(host, platform) {
        if (host === 'github.com')
            return true;
        if (platform)
            return (await this.hostsOf(platform)).has(host);
        return (await this.configuredHosts()).has(host);
    }
    /**
     * The platform behind a host: well-known names first, then the hosts glab / gh
     * hold a login for. Both lists are read at once and glab is consulted first, so
     * a GitLab host does not wait for "gh auth status", which alone takes about 1.5 s.
     */
    async platformOf(host) {
        const known = classifyWellKnownHost(host);
        if (known)
            return known;
        const gitlab = this.hostsOf('gitlab');
        const github = this.hostsOf('github');
        if ((await gitlab).has(host))
            return 'gitlab';
        if ((await github).has(host))
            return 'github';
        return undefined;
    }
    /**
     * The hosts glab / gh hold a login for; a refresh asks the CLIs again. An old
     * list still answers at once and is asked for again behind it: "gh auth status"
     * alone takes about 1.5 s because it checks every host over the network.
     */
    async configuredHosts(refresh = false) {
        const [github, gitlab] = await Promise.all([
            this.hostsOf('github', refresh),
            this.hostsOf('gitlab', refresh),
        ]);
        const hosts = new Map();
        for (const host of github)
            hosts.set(host, 'github');
        for (const host of gitlab)
            hosts.set(host, 'gitlab');
        return hosts;
    }
    /** Calls `listener` whenever a CLI check or a host list changes, so they can be kept on disk. */
    watchState(listener) {
        this.stateListener = listener;
    }
    /** CLI checks and host lists, to keep between runs. */
    exportState() {
        return {
            probes: [...this.probes].map(([key, entry]) => ({
                key,
                atMs: entry.atMs,
                probe: entry.probe,
            })),
            hostLists: [...this.hostLists].map(([platform, list]) => ({
                platform,
                atMs: list.atMs,
                hosts: [...list.hosts],
            })),
        };
    }
    /** Restores what an earlier run knew; anything this run already learned wins. */
    importState(state) {
        for (const { key, atMs, probe } of state.probes) {
            if (!this.probes.has(key))
                this.probes.set(key, { probe, atMs });
        }
        for (const { platform, atMs, hosts } of state.hostLists) {
            if (!this.hostLists.has(platform))
                this.hostLists.set(platform, { atMs, hosts: new Set(hosts) });
        }
    }
    /** The hosts one CLI holds a login for. An old list answers at once and is read again behind it. */
    async hostsOf(platform, refresh = false) {
        const known = this.hostLists.get(platform);
        if (refresh || !known)
            return this.readHostsOf(platform);
        if (ageMs(known.atMs, this.options.nowMs()) >= CONFIGURED_HOSTS_TTL_MS)
            settleInBackground(this.rereadHostsOf(platform));
        return known.hosts;
    }
    /** One read per CLI at a time; callers arriving meanwhile share it. */
    readHostsOf(platform) {
        let reading = this.hostListReads.get(platform);
        if (!reading) {
            reading = this.askHosts(platform);
            this.hostListReads.set(platform, reading);
        }
        return reading;
    }
    async askHosts(platform) {
        try {
            let hosts;
            try {
                hosts = new Set(await this.adapters[platform].configuredHosts(this.call(platform, 'probe')));
            }
            catch {
                // A missing CLI simply contributes no hosts.
                hosts = new Set();
            }
            this.hostLists.set(platform, { atMs: this.options.nowMs(), hosts });
            this.stateListener?.();
            return hosts;
        }
        finally {
            this.hostListReads.delete(platform);
        }
    }
    /** Behind an answer that used the old list; a failure keeps the old list. */
    async rereadHostsOf(platform) {
        try {
            await this.readHostsOf(platform);
        }
        catch {
            // The old list keeps answering until a read succeeds.
        }
    }
    /** Behind an answer that used the old check; a failure keeps the old check. */
    async reprobe(platform, host) {
        try {
            await this.probe(platform, host);
        }
        catch {
            // The old check keeps answering until a probe succeeds.
        }
    }
    pollAfterMs(hosts, baseMs) {
        return this.scheduler.pollAfterMs(hosts, baseMs);
    }
    async probe(platform, host) {
        const key = `${platform}:${host}`;
        const pending = this.probing.get(key);
        if (pending)
            return pending;
        const run = this.runProbe(platform, host, key);
        this.probing.set(key, run);
        try {
            return await run;
        }
        finally {
            this.probing.delete(key);
        }
    }
    async runProbe(platform, host, key) {
        let probe;
        try {
            probe = await this.adapters[platform].probe(host, this.call(platform, 'probe'));
        }
        catch (error) {
            probe = {
                installed: true,
                auth: 'unavailable',
                message: error instanceof Error ? error.message : String(error),
            };
        }
        incrementMetric(this.options.metrics, 'merge_request_cli_probe_total', 1, {
            platform,
            state: probe.installed ? probe.auth : 'not_installed',
        });
        this.probes.set(key, { probe, atMs: this.options.nowMs() });
        this.stateListener?.();
        return probe;
    }
    /** A failure that says the CLI went away or logged out invalidates the cached probe. */
    observeFailure(platform, host, error) {
        const failure = error instanceof CodeHostRequestError
            ? error
            : new CodeHostRequestError('upstream', error instanceof Error ? error.message : String(error));
        if (failure.kind === 'cli_missing' || failure.kind === 'not_authenticated') {
            this.probes.delete(`${platform}:${host}`);
        }
        return failure;
    }
    /**
     * Runs the platform's CLI. A request to a host counts against its hourly
     * budget, every page of a read included; CLI checks and host lookups do not.
     */
    call(platform, purpose, host) {
        const cli = this.adapters[platform].cli;
        return async (args, callOptions = {}) => {
            if (host !== undefined)
                this.scheduler.countRequest(host);
            const startedAtMs = this.options.nowMs();
            const result = await this.options.exec(cli, args, {
                timeoutMs: REQUEST_TIMEOUT_MS,
                ...(callOptions.stdin !== undefined ? { stdin: callOptions.stdin } : {}),
            });
            if (callOptions.raw)
                return { result };
            const response = callOptions.include ? parseIncludedResponse(result.stdout) : undefined;
            const failure = classifyCliFailure(result, response, this.options.nowMs());
            this.recordRequest(platform, purpose, failure?.kind ?? 'ok', startedAtMs);
            if (failure)
                throw failure;
            return response ? { result, response } : { result };
        };
    }
    recordRequest(platform, purpose, outcome, startedAtMs) {
        const metrics = this.options.metrics;
        incrementMetric(metrics, 'merge_request_cli_request_total', 1, { platform, purpose, outcome });
        observeMetric(metrics, 'merge_request_cli_request_ms', this.options.nowMs() - startedAtMs, {
            platform,
            outcome,
        });
    }
}
//# sourceMappingURL=gateway.js.map