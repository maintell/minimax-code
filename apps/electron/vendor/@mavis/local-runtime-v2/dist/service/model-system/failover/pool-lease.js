import { settleInBackground } from '../../../infra/async/settle.js';
import { readLLMStreamFailureKind, } from '@mavis/agent-core/pi-turn-runner';
import { classifyGenericFailure, contentRefused, edgeBlocked, effortRefused, failureEvidence, firstTokenTimeout, plainForbidden, proxyDown, signInRevokedSaid, FAILOVER_DEFAULT_COOLDOWN_MS, } from './failure-rules.js';
import { readModelAccessMetadata } from '../model-access/projection.js';
import { failoverPlan } from './pool-config.js';
import { availableMembers, earliestRecovery, probeMember, } from './pool-selector.js';
import { bindingStamp, FailoverPoolState } from './pool-state.js';
import { ModelAccessFailoverError, sealedFetch } from './sealed-content.js';
/** A model a member refused is left alone this long when the vendor names no time. */
const FAILOVER_MODEL_COOLDOWN_MS = 30 * 60_000;
/**
 * A borrowed sign-in that is no longer valid is asked again after this: the user may sign in
 * again in the other application, which MCode only notices on its next read.
 */
const FAILOVER_BORROWED_REAUTH_MS = 5 * 60_000;
/** How long a call waits for usage readings when no member is free (then it probes). */
const FAILOVER_USAGE_WAIT_MS = 5_000;
/** One usage reading's own bound. */
const FAILOVER_USAGE_TIMEOUT_MS = 10_000;
/**
 * Whether a usage reading shows an allowance again: at least
 * one window with a known use and limit, and none of those still at its limit unless its reset
 * has passed. A reading with no such window (credits only, failed, unsupported) says nothing.
 * @internal Exported for focused tests.
 */
export function quotaRenewed(usage, now) {
    if (usage.status !== 'available')
        return false;
    const measured = usage.windows.filter((window) => typeof window.used === 'number' && typeof window.limit === 'number' && window.limit > 0);
    if (measured.length === 0)
        return false;
    return measured.every((window) => window.used < window.limit || (window.resetAt !== undefined && window.resetAt <= now));
}
/** Host codes that mean this member's own sign-in is no longer valid. */
const REAUTH_CODES = new Set([
    'request_expired',
    'request_renewal_commit_failed',
    'request_signin_revoked',
    'request_identity_changed',
    'borrow_expired',
    'secret_missing',
    'secret_invalid',
    'credential_invalid',
]);
/** Codes that end the logical call (cancellation, closing, package/runtime state, host bugs). */
const TERMINAL_CODES = new Set([
    'subscription_disabled',
    'request_closed',
    'request_unavailable',
    'request_busy',
    'request_invalid',
    'request_transport_invalid',
    'request_cleanup_failed',
    'borrow_closed',
    'borrow_invalid',
    'dependency_unavailable',
    'operation_invalidated',
    'renewal_closed',
    'renewal_invalidated',
    'service_closed',
    'failover_unavailable',
    'failover_foreign_compaction',
]);
/** Known host codes that mean "try again later" (a renewal that did not complete). */
const COOLDOWN_CODES = new Set(['request_renewal_network']);
function errorCode(error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    return typeof code === 'string' ? code : undefined;
}
/** What a member's prepare/recovery failure means for the pool. @internal */
export function memberFailure(error) {
    const code = errorCode(error);
    if (code !== undefined && REAUTH_CODES.has(code))
        return 'reauth';
    if (code !== undefined && TERMINAL_CODES.has(code))
        return 'terminal';
    // Network, secret store, a source that failed to read: back off.
    return 'cooldown';
}
/** A host code on neither list: worth adding to one (the code only, never the error's words). */
function unlistedCode(error) {
    const code = errorCode(error);
    return code !== undefined &&
        !REAUTH_CODES.has(code) &&
        !TERMINAL_CODES.has(code) &&
        !COOLDOWN_CODES.has(code)
        ? code.slice(0, 64)
        : undefined;
}
export function createModelAccessFailoverPort(deps, state = new FailoverPoolState()) {
    return {
        plan: (primaryKey) => failoverPlan(deps, readModelAccessMetadata(deps.config().custom_provider?.[primaryKey])?.groupEntryKey ??
            primaryKey),
        state,
        catalog: deps.catalog,
        bindingStamp: (providerKey) => {
            const binding = deps.binding(providerKey);
            return binding ? bindingStamp(binding) : undefined;
        },
        ...(deps.installationActive ? { installationActive: deps.installationActive } : {}),
        ...(deps.ready ? { ready: deps.ready } : {}),
    };
}
const ERROR_KIND = {
    quota: 'usage_limit',
    credit: 'credits_exhausted',
    'rate-limit': 'rate_limited',
    restricted: 'usage_limit',
    slow: 'timeout',
    model: 'not_found',
    reauth: 'auth',
    unavailable: 'unknown',
};
/** A provider code for an account the vendor restricted (canonical `<id>_account_restricted`). */
const RESTRICTED_CODE = /(^|_)account_restricted$/u;
/** A provider code for a sign-in the vendor revoked. */
const REVOKED_CODE = /revoked/u;
/** The member's sign-in marked as needing a new one, at its stored binding stamp. */
function markReauth(port, key, binding, revoked) {
    const { state } = port;
    // The stored stamp now, not the call's snapshot: a rotation observed during this call must
    // not make the mark stale before it is ever read.
    state.markReauth(key, port.bindingStamp(key) ?? bindingStamp(binding), binding.kind === 'borrowed-current' ? state.now() + FAILOVER_BORROWED_REAUTH_MS : Infinity, 
    // Only a direct sign-in's revocation is kept: a borrowed one belongs to another app.
    revoked && binding.kind === 'direct-owned');
}
/** Puts a member (or its model) aside for the reason it failed; shared by pools and singles. */
function recordRest(state, at, rest, free = () => false) {
    const { key, modelId } = at;
    const { reason, retryAt } = rest;
    const now = state.now();
    if (reason === 'model')
        state.coolModel(key, modelId, retryAt ?? now + FAILOVER_MODEL_COOLDOWN_MS, 'model');
    else if (reason === 'rate-limit')
        state.rateLimitMember(key, retryAt);
    else if (reason === 'restricted')
        state.restrictMember(key, retryAt);
    else if (reason === 'slow')
        state.slowStart(key, modelId);
    else {
        const until = retryAt ?? now + FAILOVER_DEFAULT_COOLDOWN_MS[reason];
        // A free model (creditMultiplier 0) refused for allowance rests alone: its refusal says
        // nothing about the account's paid models.
        if (free(key, modelId))
            state.coolModel(key, modelId, until, reason);
        else
            state.coolMember(key, until, reason);
    }
}
/**
 * Whether an account-level failure says the sign-in was revoked: the
 * owned renewal said so, the provider's code does, or a 401 carries the vendor's revoked words.
 */
function revokedSignIn(error, classified, failure) {
    return (errorCode(error) === 'request_signin_revoked' ||
        (classified !== undefined && REVOKED_CODE.test(classified.code)) ||
        (failure !== undefined && signInRevokedSaid(failureEvidence(failure))));
}
/**
 * What a provider-classified failure means for the account (shared by pools and single
 * accounts). Undefined: the request, not the account.
 */
function accountVerdict(classified, failure, base, now) {
    const generic = () => classifyGenericFailure(failureEvidence(failure), now);
    switch (classified?.category) {
        case 'quota':
        case 'rate-limit':
            return accountSwitch(classified, generic(), now);
        case 'model':
            return { kind: 'model', retryAt: later(now, classified.retryAfterMs) };
        case 'identity':
            return { kind: 'reauth' };
        case 'credential':
            // The member's own recovery runs first; only a credential it cannot recover leaves.
            return base.kind === 'recover' ? undefined : { kind: 'reauth' };
        case undefined:
        case 'request':
        case 'network':
            return genericSwitch(generic(), failure);
        default:
            // refusal, dependency, platform: the request, not the account.
            return undefined;
    }
}
/**
 * One logical call over a pool. Exactly one member call is open at a time; a switch decided in
 * classifyFailure/recover is carried out by the next attempt (old call closed before the new one
 * opens), so every switch spends agent-core's own retry budget. A committed attempt never comes
 * back here, so nothing already shown is ever replayed on another account.
 */
/** Bookkeeping never changes the call's outcome. */
async function observe(promise) {
    try {
        await promise;
    }
    catch {
        /* Swallowed on purpose. */
    }
}
function later(now, ms) {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? now + ms : undefined;
}
/** A used-up or rate-limited account; credit when the words or the code say money. */
function accountSwitch(classified, generic, now) {
    let kind = 'rate-limit';
    if (RESTRICTED_CODE.test(classified.code) || generic.kind === 'restricted')
        kind = 'restricted';
    else if (classified.category === 'quota')
        kind = generic.kind === 'credit' || /credit/u.test(classified.code) ? 'credit' : 'quota';
    return { kind, retryAt: later(now, classified.retryAfterMs) ?? generic.retryAtMs };
}
/**
 * The generic rules only ever add an account-level reason, and only where the status itself
 * says so: 402 / 429 for quota, credit or rate limits, a 5xx carrying a quota code, 403 / 404
 * for a model the account does not serve. A 400-class error that merely mentions a limit, or a
 * failure with no status, stays on the account (an unsure verdict never moves the call).
 */
function genericSwitch(generic, failure) {
    // No first token within agent-core's watchdog: the next member is asked;
    // from the second in a row the member's model rests (pool-state slowStart).
    if (failure && firstTokenTimeout(failure))
        return { kind: 'slow' };
    const statuses = ACCOUNT_STATUS[generic.kind];
    if (!statuses || !statuses(generic.status))
        return undefined;
    const kind = generic.kind;
    return { kind, ...(generic.retryAtMs ? { retryAt: generic.retryAtMs } : {}) };
}
const usedUpStatus = (status) => status === 402 || status === 429 || (status !== undefined && status >= 500);
/** Which statuses let a generic verdict move the call to another account. */
const ACCOUNT_STATUS = {
    // The rule itself already needs an error status or MCode's own restricted marker.
    restricted: () => true,
    quota: usedUpStatus,
    credit: usedUpStatus,
    'rate-limit': usedUpStatus,
    model: (status) => status === 403 || status === 404,
};
export class ModelAccessFailoverLease {
    input;
    signal;
    controller = new AbortController();
    tried = new Set();
    opened = [];
    current;
    /** A switch the next attempt makes; `from` is the member that asked for it. */
    pending;
    /** A member that failed while preparing its credential and already gave up its call. */
    prepareLeft;
    lastReason;
    /** The one resting member this call asks, once every member rests. */
    probed;
    /** When the current attempt began: a rest set before it ends when it answers. */
    attemptAt = 0;
    /** The reasoning level the current attempt asked for (an account's plan may not take it). */
    attemptEffort;
    /**
     * Members that refused this call's content (protection, a safety filter) or its reasoning
     * level: the request, not the account; they don't rest and their mates go last.
     */
    requestRefused = new Set();
    /** The providers whose account refused this call's content (their mates go last). */
    refusedBy = new Set();
    /** Plain 403s this call met, by member, with the rest each took. */
    forbidden = [];
    switches = 0;
    requirement;
    fatal;
    closing;
    closed = false;
    constructor(input) {
        this.input = input;
        this.signal = AbortSignal.any([input.signal, this.controller.signal]);
    }
    static async open(input) {
        const lease = new ModelAccessFailoverLease(input);
        try {
            await lease.openNext();
            return lease;
        }
        catch (error) {
            await lease.close();
            throw error;
        }
    }
    selection() {
        const { port, plan, modelId, sessionId } = this.input;
        return {
            plan: plan.grouped ? (port.plan(plan.primaryKey) ?? { ...plan, members: [] }) : plan,
            state: port.state,
            modelId,
            sessionId,
            catalog: (key, id) => port.catalog(key, id),
            bindingStamp: (key) => port.bindingStamp(key),
            ...(port.installationActive
                ? { installationActive: (id) => port.installationActive(id) }
                : {}),
            ...(port.ready ? { ready: (key) => port.ready(key) } : {}),
            ...(this.probed ? { probe: this.probed } : {}),
            ...(this.refusedBy.size ? { matesLast: this.refusedBy } : {}),
            exclude: this.tried,
            ...(this.requirement ? { requirement: this.requirement } : {}),
        };
    }
    unavailable() {
        const { reason, retryAt } = earliestRecovery({
            ...this.selection(),
            exclude: undefined,
            probe: undefined,
        });
        return new ModelAccessFailoverError('failover_unavailable', reason, retryAt);
    }
    /**
     * The members to try now. With nobody free, a quota rest whose window a fresh usage reading
     * shows renewed is lifted first; failing that, the member back soonest is probed once.
     */
    async candidates() {
        const members = availableMembers(this.selection());
        // Probing is for opening a call only (switches go to free members, see nextAvailable).
        if (members.length > 0 || this.probed || this.current || this.opened.length > 0)
            return members;
        if (await this.refreshQuotaRests()) {
            const renewed = availableMembers(this.selection());
            if (renewed.length > 0)
                return renewed;
        }
        const probe = probeMember(this.selection());
        if (!probe)
            return [];
        this.probed = probe.providerKey;
        this.input.logger?.info({
            event: 'model_access_failover_probe',
            scope: this.input.scope,
            primaryProvider: this.input.plan.primaryKey,
            memberProvider: probe.providerKey,
        }, 'model access failover probing the account back soonest');
        return [probe];
    }
    /**
     * When no member is free, each member resting out of quota is asked
     * for its usage (at most once a minute each, bounded wait); a reading whose windows are no
     * longer full lifts the rest at once. Returns whether a rest was lifted.
     */
    async refreshQuotaRests() {
        const { state } = this.input.port;
        const resting = this.selection().plan.members.filter((member) => !this.tried.has(member.providerKey) &&
            state.memberCooldown(member.providerKey)?.reason === 'quota' &&
            state.claimUsageProbe(member.providerKey));
        if (resting.length === 0)
            return false;
        const work = Promise.all(resting.map((member) => this.readUsage(member.providerKey)));
        const timer = new Promise((resolve) => {
            const handle = setTimeout(() => resolve([]), FAILOVER_USAGE_WAIT_MS);
            handle.unref?.();
        });
        return (await Promise.race([work, timer])).some(Boolean);
    }
    async readUsage(key) {
        const { state } = this.input.port;
        const readAt = state.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FAILOVER_USAGE_TIMEOUT_MS);
        timer.unref?.();
        try {
            const opened = await this.input.open(key, AbortSignal.any([this.signal, controller.signal]), {});
            try {
                if (!quotaRenewed(await opened.call.usage(), state.now()))
                    return false;
            }
            finally {
                await observe(opened.lease.close());
            }
            const lifted = state.liftQuotaRest(key, readAt);
            if (lifted)
                this.input.logger?.info({ event: 'model_access_failover_quota_renewed', memberProvider: key }, 'model access failover found a used-up window renewed');
            return lifted;
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Opens the first member that may take the call; the first admission error wins if none can. */
    async openNext() {
        let firstError;
        for (const member of await this.candidates()) {
            if (this.closed || this.signal.aborted)
                throw this.abortError();
            this.tried.add(member.providerKey);
            try {
                this.current = await this.openMember(member);
                return;
            }
            catch (error) {
                if (this.closed || this.signal.aborted)
                    throw error;
                firstError ??= error;
            }
        }
        throw firstError ?? this.unavailable();
    }
    abortError() {
        const reason = this.signal.reason;
        return reason instanceof Error ? reason : new Error('LLM request was cancelled');
    }
    async openMember(member) {
        const release = this.input.port.state.acquire(member.providerKey);
        let opened;
        const holder = {};
        const hooks = {
            onPrepareFailure: (error) => {
                if (holder.entry)
                    this.prepareFailed(holder.entry, error);
            },
        };
        try {
            opened = await this.input.open(member.providerKey, this.signal, hooks);
        }
        catch (error) {
            release();
            throw error;
        }
        // A member call that is invalidated on its own (identity change, package disabled) ends the
        // logical call, exactly as a single provider would; closing it for a switch does not.
        const onAbort = () => this.controller.abort(opened.call.signal.reason);
        opened.call.signal.addEventListener('abort', onAbort, { once: true });
        const detach = () => opened.call.signal.removeEventListener('abort', onAbort);
        const entry = {
            member,
            call: opened.call,
            lease: opened.lease,
            streams: new WeakMap(),
            release,
            detach,
        };
        holder.entry = entry;
        this.opened.push(entry);
        if (this.closed) {
            await this.closeMember(entry);
            throw this.abortError();
        }
        if (opened.call.signal.aborted)
            onAbort();
        return entry;
    }
    memberInner(member) {
        return (inner) => (model, context, options) => inner(model, context, {
            ...options,
            ...(options?.fetch
                ? {
                    fetch: sealedFetch({
                        fetch: options.fetch,
                        api: model.api,
                        sessionId: this.input.sessionId,
                        primaryKey: this.input.plan.primaryKey,
                        member: member.providerKey,
                        state: this.input.port.state,
                        onFatal: (error) => {
                            this.fatal = error;
                        },
                    }),
                }
                : {}),
        });
    }
    async closeMember(entry) {
        entry.detach();
        try {
            await entry.lease.close();
        }
        finally {
            entry.release();
        }
    }
    wrapAttempt(inner) {
        return (async (model, context, options) => {
            if (this.closed)
                throw this.abortError();
            if (this.input.plan.grouped) {
                this.requirement = {
                    effort: options?.reasoning,
                    images: context.messages.some((message) => Array.isArray(message.content) &&
                        message.content.some((part) => part.type === 'image')),
                    context: model.contextWindow,
                    output: options?.maxTokens ?? model.maxTokens,
                };
                const eligible = availableMembers({ ...this.selection(), exclude: undefined });
                if (this.current &&
                    !eligible.some((m) => m.providerKey === this.current?.member.providerKey)) {
                    await this.closeMember(this.current);
                    this.current = undefined;
                    await this.openNext();
                }
            }
            await this.takePending();
            const current = this.current;
            if (!current)
                throw this.unavailable();
            this.attemptAt = this.input.port.state.now();
            this.attemptEffort = typeof options?.reasoning === 'string' ? options.reasoning : undefined;
            const stream = await this.memberStream(current, inner)(model, context, options);
            this.observeSettled(current, stream);
            return stream;
        });
    }
    /** The member lease's attempt stream for this inner stream (built once per member). */
    memberStream(current, inner) {
        let fn = current.streams.get(inner);
        if (!fn) {
            fn = current.lease.wrapAttempt(this.memberInner(current.member)(inner));
            current.streams.set(inner, fn);
        }
        return fn;
    }
    /** The latest success bookkeeping; never awaited by the call and never rejects. */
    bookkeeping = Promise.resolve();
    observeSettled(current, stream) {
        this.bookkeeping = observe(this.settled(current, stream));
    }
    /** After a successful reply: bind the session and say which account served (no content). */
    async settled(current, stream) {
        let final;
        try {
            final = await stream.result();
        }
        catch {
            return;
        }
        if (final.stopReason === 'error' || final.stopReason === 'aborted')
            return;
        this.input.port.state.servedMember(current.member.providerKey, this.input.modelId);
        // It answered: whatever rested it before this attempt began (a probe's rest) is over.
        this.input.port.state.liftRestsBefore(current.member.providerKey, this.input.modelId, this.attemptAt);
        this.input.port.state.liftReauthBefore(current.member.providerKey, this.attemptAt);
        this.input.port.state.bindSession(this.input.sessionId, this.input.plan.primaryKey, current.member.providerKey);
        this.input.logger?.info({
            event: 'model_access_failover_served',
            scope: this.input.scope,
            primaryProvider: this.input.plan.primaryKey,
            memberProvider: current.member.providerKey,
            switched: this.switches > 0,
            switches: this.switches,
            ...(this.lastReason ? { reason: this.lastReason } : {}),
        }, 'model access failover member served the call');
    }
    /** Closes the member that failed, then opens the next one that may take the call. */
    /** The switch a failed attempt asked for, made before the next attempt. */
    async takePending() {
        const pending = this.pending;
        this.pending = undefined;
        if (!pending)
            return;
        // The group step may already have left the member that asked for the switch (it rested, so
        // it is no longer eligible): that was the switch. Switching again would close the member just
        // opened before it was ever asked.
        if (pending.from && pending.from !== this.current?.member.providerKey)
            this.countSwitch(pending.from, pending.reason);
        else
            await this.switchMember(pending.reason);
    }
    /** Counts and logs one switch away from `from`. */
    countSwitch(from, reason) {
        this.switches += 1;
        this.lastReason = reason;
        this.input.logger?.info({
            event: 'model_access_failover_switch',
            scope: this.input.scope,
            primaryProvider: this.input.plan.primaryKey,
            fromProvider: from,
            reason,
        }, 'model access failover switching account');
    }
    async switchMember(reason) {
        const previous = this.current;
        this.current = undefined;
        if (previous)
            await this.closeMember(previous);
        if (this.closed || this.signal.aborted)
            throw this.abortError();
        this.countSwitch(previous?.member.providerKey, reason);
        try {
            await this.openNext();
        }
        catch (error) {
            if (this.closed || this.signal.aborted)
                throw error;
            throw error instanceof ModelAccessFailoverError ? error : this.unavailable();
        }
    }
    /**
     * Another member may take the call now. A resting member is only probed when a call opens
     * with nobody free; within a call, nobody free means the failing account acts alone.
     */
    nextAvailable() {
        return availableMembers(this.selection()).length > 0;
    }
    /** Records why a member left: a sign-in to renew (by binding stamp) or a backed-off rest. */
    markMember(entry, kind, error, revoked = revokedSignIn(error)) {
        const key = entry.member.providerKey;
        if (kind === 'cooldown') {
            const code = unlistedCode(error);
            if (code)
                this.input.logger?.debug?.({ event: 'model_access_failover_unknown_code', code }, 'model access failover met an unlisted error code');
            this.input.port.state.backOffMember(key);
            return;
        }
        markReauth(this.input.port, key, entry.call.binding, revoked);
    }
    /**
     * The member's credential could not be prepared (borrowed source signed out, owned renewal
     * fenced, store failure). With another member to take the call, this member's own teardown is
     * not the call's: it is detached and left. Without one, nothing changes (single-provider path).
     */
    prepareFailed(entry, error) {
        if (this.closed || this.signal.aborted || entry !== this.current)
            return;
        const verdict = memberFailure(error);
        if (verdict === 'terminal')
            return;
        this.markMember(entry, verdict, error);
        if (!this.nextAvailable())
            return;
        entry.detach();
        this.prepareLeft = { entry, reason: verdict === 'reauth' ? 'reauth' : 'unavailable' };
    }
    /** Puts the member aside for the reason it failed. */
    rest(current, reason, retryAt, revoked = false) {
        if (reason === 'reauth')
            this.markMember(current, 'reauth', undefined, revoked);
        else if (reason === 'unavailable')
            this.markMember(current, 'cooldown');
        else
            recordRest(this.input.port.state, { key: current.member.providerKey, modelId: this.input.modelId }, { reason, retryAt }, (key, id) => this.input.port.catalog(key, id)?.creditMultiplier === 0);
    }
    /** Marks the failing member, then decides: switch now, act as a single account, or end. */
    leave(reason, retryAt, base, revoked = false) {
        const current = this.current;
        const others = this.nextAvailable();
        // Nobody else may take it: a retryable failure is retried on this account, as without a pool.
        // A slow start is still counted (restSlow), and a rate limit still rests (rateRest), as a
        // lone account records them too.
        if (!others && (base.kind === 'retry' || base.kind === 'recover')) {
            if (reason === 'slow' || reason === 'rate-limit') {
                this.rest(current, reason, retryAt);
                // The last one left is tried anyway: its new rest does not drop it from this call.
                this.probed = current.member.providerKey;
            }
            return base;
        }
        this.rest(current, reason, retryAt, revoked);
        if (!others) {
            const exhausted = this.unavailable();
            this.input.logger?.warn({
                event: 'model_access_failover_exhausted',
                scope: this.input.scope,
                primaryProvider: this.input.plan.primaryKey,
                reason,
                ...(exhausted.retryAt ? { retryAt: exhausted.retryAt } : {}),
            }, 'model access failover has no account left for this call');
            return { kind: 'terminal', errorKind: ERROR_KIND[reason] };
        }
        this.pending = { kind: 'switch', reason, from: current.member.providerKey };
        return {
            kind: 'retry',
            errorKind: ERROR_KIND[reason],
            retryReason: 'rate_limited',
            retryAfterMs: 0,
        };
    }
    async classifyFailure(failure) {
        const current = this.current;
        const left = this.takePrepareLeft(current);
        if (left)
            return left;
        if (!current || this.ended(failure))
            return this.terminal();
        // agent-core's empty reply: another account is asked, and the one that
        // answered empty does not rest; with nobody else, agent-core asks the same account again.
        if (readLLMStreamFailureKind(failure) === 'llm_empty_response')
            return this.switchAway({ kind: 'retry', errorKind: 'unknown' }, 'unknown');
        const base = await current.call.classifyFailure(failure);
        const provider = await current.call.classifyProvider?.(failure);
        if (!provider || provider.host)
            return base;
        return (this.requestVerdict(current, failure, base, provider.classified) ??
            this.accountDecision(failure, base, provider.classified));
    }
    ended(failure) {
        return !!this.fatal || failure.thrown instanceof ModelAccessFailoverError || this.closed;
    }
    terminal() {
        return {
            kind: 'terminal',
            errorKind: this.lastReason ? ERROR_KIND[this.lastReason] : 'unknown',
        };
    }
    /** Ask the next account at once; `none` when nobody is left. */
    switchAway(none, errorKind) {
        if (!this.nextAvailable())
            return none;
        this.pending = {
            kind: 'switch',
            reason: 'unavailable',
            from: this.current?.member.providerKey,
        };
        return { kind: 'retry', errorKind, retryAfterMs: 0 };
    }
    /** What the provider named about the account decides: rest it and leave, or keep `base`. */
    accountDecision(failure, base, classified) {
        const decided = accountVerdict(classified, failure, base, this.input.port.state.now());
        if (!decided)
            return base;
        return this.leave(decided.kind, decided.retryAt, base, decided.kind === 'reauth' && revokedSignIn(undefined, classified, failure));
    }
    /**
     * Failures that are the request's, not the account's:
     * - the account's plan doesn't take the reasoning level sent (effort_accounts.go): the next
     *   account is asked, and this one does not rest;
     * - the content was turned away (protection, a safety filter): the provider's other accounts
     *   would turn it away alike, so none of them rests and they are asked only after any other;
     * - the proxy itself is down: nobody rests, nothing is switched;
     * - the vendor's firewall blocked this address (EdgeBlocked): its other accounts go last, as
     *   for refused content, and none rests;
     * - a plain 403 a mate already answered alike: the request was refused, the rest that 403 took
     *   is taken back and nobody else rests (forbiddenAlike / unforbid).
     * Undefined when the failure says none of these.
     */
    requestVerdict(current, failure, base, classified) {
        // What the provider itself named about the account (quota, a restriction, a model it doesn't
        // serve, a sign-in) stands; only a failure it calls the request's, or names nothing of, is
        // read here.
        if (classified && classified.category !== 'request' && classified.category !== 'network')
            return undefined;
        const evidence = failureEvidence(failure);
        if (proxyDown(evidence))
            return base;
        const refused = this.refusedRequest(current, evidence, base);
        if (refused)
            return refused;
        if (plainForbidden(evidence, this.input.port.state.now()))
            return this.forbiddenVerdict(current, evidence, failure, base);
        return undefined;
    }
    /** The plan refused the reasoning level, or the content was turned away: ask another account. */
    refusedRequest(current, evidence, base) {
        const effort = effortRefused(evidence, this.attemptEffort);
        const content = !effort && (contentRefused(evidence) || edgeBlocked(evidence));
        if (!effort && !content)
            return undefined;
        this.requestRefused.add(current.member.providerKey);
        // Content another account of the same extension would refuse alike: its mates go last.
        if (content && current.member.providerId)
            this.refusedBy.add(current.member.providerId);
        // A refused content goes to members of other installations first; mates stay last.
        return this.switchAway(base, base.errorKind);
    }
    /** A plain 403: refused for the request when a mate already got it alike, else this account's. */
    forbiddenVerdict(current, evidence, failure, base) {
        const { state } = this.input.port;
        const key = current.member.providerKey;
        const mates = this.forbidden.filter((f) => f.key !== key);
        if (mates.length > 0) {
            // Alike from another account of the pool: the request is refused, not each account.
            // Neither rests (the mate's rest is taken back); the call goes on to whoever is left.
            for (const f of mates)
                if (f.rest)
                    state.unrest(f.key, f.rest);
            this.forbidden.length = 0;
            this.requestRefused.add(key);
            return this.switchAway({ kind: 'terminal', errorKind: base.errorKind }, base.errorKind);
        }
        const decided = genericSwitch(classifyGenericFailure(evidence, state.now()), failure);
        const before = state.memberCooldown(key);
        const verdict = this.leave(decided?.kind ?? 'unavailable', decided?.retryAt, base);
        const rest = state.memberCooldown(key);
        this.forbidden.push({ key, rest: rest !== before ? rest : undefined });
        return verdict;
    }
    /** A member that already left while preparing its credential: switch on the next attempt. */
    takePrepareLeft(current) {
        const left = this.prepareLeft;
        this.prepareLeft = undefined;
        if (!left || left.entry !== current || this.closed || this.signal.aborted)
            return undefined;
        this.pending = { kind: 'switch', reason: left.reason, from: left.entry.member.providerKey };
        return {
            kind: 'retry',
            errorKind: ERROR_KIND[left.reason],
            retryReason: 'rate_limited',
            retryAfterMs: 0,
        };
    }
    async recover(input) {
        const current = this.current;
        if (!current)
            throw this.unavailable();
        try {
            await current.call.recover(input);
        }
        catch (error) {
            // Cancellation or the call's own deadline ends the call exactly as without a pool.
            if (this.closed ||
                this.signal.aborted ||
                input.signal.aborted ||
                Date.now() >= input.deadlineAt)
                throw error;
            const verdict = memberFailure(error);
            if (verdict === 'terminal')
                throw error;
            // Only a sign-in that is no longer valid needs a new one; a network failure only rests.
            this.markMember(current, verdict, error);
            if (!this.nextAvailable())
                throw error;
            this.pending = {
                kind: 'switch',
                reason: verdict === 'reauth' ? 'reauth' : 'unavailable',
                from: current.member.providerKey,
            };
        }
    }
    close() {
        this.closed = true;
        this.closing ??= (async () => {
            const outcomes = await Promise.allSettled(this.opened.map((entry) => this.closeMember(entry)));
            this.current = undefined;
            const failed = outcomes.find((outcome) => outcome.status === 'rejected');
            if (failed && failed.status === 'rejected')
                throw failed.reason;
        })();
        return this.closing;
    }
}
/**
 * A single account (no pool) still records what its failures say — rests, slow starts and a
 * revoked direct sign-in — so a later pool, the view and the next call see them. Only a revoked sign-in changes what a single account
 * does: it is refused before any vendor request until the user signs in again (the binding
 * stamp changes). Rests never block a single account: its only account is always asked.
 */
export class ModelAccessRecordingLease {
    inner;
    port;
    providerKey;
    modelId;
    signal;
    attemptAt = 0;
    constructor(inner, port, providerKey, modelId) {
        this.inner = inner;
        this.port = port;
        this.providerKey = providerKey;
        this.modelId = modelId;
        this.signal = inner.lease.signal;
    }
    /** Refuses a revoked direct sign-in without opening a call. */
    static async open(input) {
        const stamp = input.port.bindingStamp(input.providerKey);
        if (stamp !== undefined && input.port.state.revoked(input.providerKey, stamp))
            throw new ModelAccessSignInRevokedError();
        const holder = {};
        const opened = await input.open({
            onPrepareFailure: (error) => holder.lease?.credentialFailed(error),
        });
        holder.lease = new ModelAccessRecordingLease(opened, input.port, input.providerKey, input.modelId);
        return holder.lease;
    }
    wrapAttempt(innerStream) {
        const wrapped = this.inner.lease.wrapAttempt(innerStream);
        return (async (model, context, options) => {
            this.attemptAt = this.port.state.now();
            const stream = await wrapped(model, context, options);
            settleInBackground(this.settled(stream));
            return stream;
        });
    }
    async settled(stream) {
        const final = await stream.result();
        if (final.stopReason === 'error' || final.stopReason === 'aborted')
            return;
        this.port.state.servedMember(this.providerKey, this.modelId);
        this.port.state.liftRestsBefore(this.providerKey, this.modelId, this.attemptAt);
    }
    async classifyFailure(failure) {
        const base = await this.inner.call.classifyFailure(failure);
        try {
            const provider = await this.inner.call.classifyProvider?.(failure);
            if (!provider || provider.host)
                return base;
            const verdict = accountVerdict(provider.classified, failure, base, this.port.state.now());
            if (verdict)
                this.record(verdict.kind, verdict.retryAt, provider.classified, failure);
        }
        catch {
            /* Bookkeeping never changes the decision. */
        }
        return base;
    }
    async recover(input) {
        try {
            await this.inner.call.recover(input);
        }
        catch (error) {
            this.credentialFailed(error);
            throw error;
        }
    }
    close() {
        return this.inner.lease.close();
    }
    credentialFailed(error) {
        if (revokedSignIn(error))
            this.markRevoked();
    }
    record(kind, retryAt, classified, failure) {
        if (kind === 'reauth') {
            if (revokedSignIn(undefined, classified, failure))
                this.markRevoked();
            return;
        }
        if (kind === 'unavailable')
            return;
        recordRest(this.port.state, { key: this.providerKey, modelId: this.modelId }, { reason: kind, retryAt }, (key, id) => this.port.catalog(key, id)?.creditMultiplier === 0);
    }
    markRevoked() {
        const binding = this.inner.call.binding;
        if (binding.kind !== 'direct-owned')
            return;
        markReauth(this.port, this.providerKey, binding, true);
    }
}
/** A direct sign-in the vendor revoked, refused before any request until a new sign-in. */
class ModelAccessSignInRevokedError extends Error {
    code = 'request_signin_revoked';
    hostFailure = true;
    constructor() {
        super('request_signin_revoked');
        this.name = 'ModelAccessRequestError';
    }
}
//# sourceMappingURL=pool-lease.js.map