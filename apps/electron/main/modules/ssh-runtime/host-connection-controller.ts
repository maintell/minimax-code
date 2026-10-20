import { randomUUID } from "node:crypto";
import { sshFailureDetails } from "./errors.js";
import { isUnknownHostRecoveryError, classifyHostRecoveryError, hostRecoveryDelayMs } from "./recovery-policy.js";
const CANCELLED = { code: 'ssh_cancelled', message: 'The SSH connection was cancelled.' };
const defaultClock = {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
};
/** Share one scheduler per Registry/profile, never one scheduler per host. */
export class HostConnectionScheduler {
    constructor(maxConcurrent = 3) {
        this.maxConcurrent = maxConcurrent;
        this.active = 0;
        this.queue = [];
        this.foregroundAdmissions = 0;
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
            throw new Error('Invalid host concurrency');
    }
    async run(signal, operation, getPriority = () => 'background') {
        const release = await this.acquire(signal, getPriority);
        try {
            if (signal.aborted)
                throw CANCELLED;
            return await operation();
        }
        finally {
            release();
        }
    }
    acquire(signal, getPriority) {
        return new Promise((resolve, reject) => {
            const cancel = () => {
                const index = this.queue.indexOf(entry);
                if (index !== -1)
                    this.queue.splice(index, 1);
                reject(CANCELLED);
            };
            const start = () => {
                signal.removeEventListener('abort', cancel);
                if (signal.aborted) {
                    reject(CANCELLED);
                    return;
                }
                this.active += 1;
                resolve(() => {
                    this.active -= 1;
                    this.startNext();
                });
            };
            const entry = { start, getPriority };
            if (signal.aborted) {
                reject(CANCELLED);
                return;
            }
            if (this.active < this.maxConcurrent)
                start();
            else {
                this.queue.push(entry);
                signal.addEventListener('abort', cancel, { once: true });
            }
        });
    }
    startNext() {
        const foreground = this.queue.findIndex((entry) => entry.getPriority() === 'foreground');
        const background = this.queue.findIndex((entry) => entry.getPriority() === 'background');
        // Give a waiting background host a slot after at most three foreground admissions.
        // Array order preserves FIFO within each current priority, including reprioritization.
        const preferForeground = foreground !== -1 && (background === -1 || this.foregroundAdmissions < 3);
        const index = preferForeground ? foreground : background;
        this.foregroundAdmissions =
            preferForeground && background !== -1 ? this.foregroundAdmissions + 1 : 0;
        if (index !== -1)
            this.queue.splice(index, 1)[0].start();
    }
}

/** Owns transport recovery only: it never replays a request, task, upload or install. */
export class HostConnectionController {
    constructor(options) {
        this.options = options;
        this.demands = new Set();
        this.priority = 'background';
        this.failures = 0;
        this.unknownFailures = 0;
        this.lastHintAt = Number.NEGATIVE_INFINITY;
        this.disposed = false;
        this.clock = options.clock ?? defaultClock;
        this.scheduler = options.scheduler ?? new HostConnectionScheduler();
        this.snapshot = {
            hostId: options.hostId,
            controllerEpoch: randomUUID(),
            configRevision: options.configRevision,
            revision: 0,
            generation: 0,
            attemptId: null,
            phase: 'idle',
            phaseStartedAtMs: this.clock.now(),
            lastSuccessAtMs: null,
            attempt: 0,
            nextRetryAtMs: null,
            demandCount: 0,
            state: 'idle',
            daemonInstanceId: null,
            error: null,
        };
    }
    getSnapshot() {
        return { ...this.snapshot, error: this.snapshot.error ? { ...this.snapshot.error } : null };
    }
    /** Reprioritize queued work without changing intent, retry timing, or running attempts. */
    setPriority(priority) {
        if (!this.disposed)
            this.priority = priority;
    }
    /** Retain intent without starting I/O; connect() starts or joins the attempt. */
    retainDemand(key) {
        if (this.disposed || this.demands.has(key))
            return;
        this.demands.add(key);
        this.publish({ demandCount: this.demands.size });
    }
    /** Without a key this is a one-shot connection: failure does not create retry intent. */
    connect(demandKey) {
        if (demandKey !== undefined)
            this.retainDemand(demandKey);
        if (this.disposed)
            return Promise.resolve(this.cancelledResult());
        if (this.pending)
            return this.pending.promise;
        if (this.value)
            return Promise.resolve({ connected: true, value: this.value.current });
        if (this.snapshot.state === 'action_required' ||
            this.snapshot.state === 'disabled' ||
            this.snapshot.state === 'retry_wait') {
            return Promise.resolve({ connected: false, error: this.snapshot.error });
        }
        return this.startAttempt();
    }
    releaseDemand(key) {
        if (!this.demands.delete(key))
            return;
        if (this.demands.size > 0) {
            this.publish({ demandCount: this.demands.size });
            return;
        }
        this.invalidate();
        this.resetFailures();
        this.publish({
            state: 'idle',
            phase: 'idle',
            error: null,
            demandCount: 0,
            nextRetryAtMs: null,
            attempt: 0,
        });
    }
    markLost(error) {
        if (this.disposed || this.snapshot.state !== 'ready')
            return;
        if (this.readySince !== undefined &&
            this.clock.monotonicNow() - this.readySince >= (this.options.stableReadyMs ?? 30000)) {
            this.resetFailures();
            this.snapshot = { ...this.snapshot, attempt: 0 };
        }
        const pending = this.pending;
        this.invalidate(false);
        const failure = this.recordFailure(error);
        pending?.resolve({ connected: false, error: failure });
    }
    hint(reason) {
        if (this.disposed || this.demands.size === 0 || this.pending || this.value)
            return;
        if (this.snapshot.state === 'disabled')
            return;
        if (this.snapshot.state === 'action_required' && reason !== 'manual')
            return;
        if (this.clock.monotonicNow() - this.lastHintAt < 1000)
            return;
        this.lastHintAt = this.clock.monotonicNow();
        if (reason === 'manual') {
            this.resetFailures();
            this.snapshot = { ...this.snapshot, attempt: 0 };
        }
        void this.startAttempt();
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.demands.clear();
        this.invalidate();
        this.publish({
            state: 'disabled',
            phase: 'stopped',
            error: null,
            demandCount: 0,
            nextRetryAtMs: null,
        });
    }
    startAttempt() {
        this.clearTimer();
        const generation = this.snapshot.generation + 1;
        const attemptId = randomUUID();
        const configuredTimeout = this.options.attemptTimeoutMs;
        const timeoutMs = (typeof configuredTimeout === 'function' ? configuredTimeout() : configuredTimeout) ?? 60000;
        const deadline = this.clock.monotonicNow() + timeoutMs;
        let resolve;
        const promise = new Promise((finish) => {
            resolve = finish;
        });
        const attempt = { controller: new AbortController(), generation, promise, resolve };
        this.pending = attempt;
        this.timer = this.clock.setTimeout(() => {
            if (this.isCurrent(attempt))
                this.failAttempt(attempt, {
                    code: 'host_connection_timeout',
                    message: 'The SSH connection attempt timed out.',
                });
        }, timeoutMs);
        this.publish({
            generation,
            attemptId,
            attempt: this.snapshot.attempt + 1,
            state: 'connecting',
            sshVerifiedAtMs: undefined,
            phase: 'queued',
            error: null,
            nextRetryAtMs: null,
        });
        const context = {
            signal: attempt.controller.signal,
            attemptId,
            generation,
            remainingMs: () => Math.max(0, deadline - this.clock.monotonicNow()),
            setPhase: (phase) => {
                if (this.isCurrent(attempt))
                    this.publish({
                        phase,
                        ...(phase === 'starting' ? { sshVerifiedAtMs: this.clock.now() } : {}),
                    });
            },
        };
        void this.scheduler
            .run(context.signal, async () => {
            if (!this.isCurrent(attempt))
                throw CANCELLED;
            context.setPhase('preparing');
            return this.options.run(context);
        }, () => this.priority)
            .then(async (value) => {
            if (!this.isCurrent(attempt)) {
                this.disposeValue(value);
                return;
            }
            this.value = { current: value };
            this.readySince = this.clock.monotonicNow();
            this.publish({
                state: 'ready',
                daemonInstanceId: this.options.getDaemonInstanceId?.(value) ?? null,
                phase: 'ready',
                lastSuccessAtMs: this.clock.now(),
                error: null,
            });
            if (!this.isCurrent(attempt))
                return;
            await this.options.onReady?.(value, this.getSnapshot());
            if (!this.isCurrent(attempt))
                return;
            this.clearTimer();
            this.pending = undefined;
            attempt.resolve({ connected: true, value });
        })
            .catch((error) => {
            if (this.isCurrent(attempt))
                this.failAttempt(attempt, error);
        });
        return promise;
    }
    failAttempt(attempt, error) {
        this.invalidate(false);
        const failure = this.recordFailure(error);
        attempt.resolve({ connected: false, error: failure });
    }
    recordFailure(error) {
        this.failures += 1;
        if (isUnknownHostRecoveryError(error))
            this.unknownFailures += 1;
        const failure = classifyHostRecoveryError(error, this.unknownFailures);
        if (!failure.details && this.snapshot.sshVerifiedAtMs !== undefined) {
            failure.details = sshFailureDetails(failure.code, {
                sshVerified: true,
                stage: this.snapshot.phase === 'initializing' ? 'initialize' : 'bootstrap',
            });
        }
        this.offlineSince ?? (this.offlineSince = this.clock.monotonicNow());
        const retry = failure.disposition === 'retry' && this.demands.size > 0;
        const delay = hostRecoveryDelayMs(this.failures, this.clock.monotonicNow() - this.offlineSince, this.options.random);
        if (retry) {
            this.timer = this.clock.setTimeout(() => {
                this.timer = undefined;
                void this.startAttempt();
            }, delay);
        }
        this.publish({
            state: retry
                ? 'retry_wait'
                : failure.disposition === 'stopped'
                    ? 'disabled'
                    : failure.disposition === 'action_required'
                        ? 'action_required'
                        : 'idle',
            phase: retry ? 'retry_wait' : 'stopped',
            error: failure,
            nextRetryAtMs: retry ? this.clock.now() + delay : null,
        });
        return failure;
    }
    invalidate(cancelPending = true) {
        this.clearTimer();
        // Invalidate readiness before cleanup: closing a transport can synchronously emit onLost.
        this.snapshot = {
            ...this.snapshot,
            generation: this.snapshot.generation + 1,
            state: 'idle',
            daemonInstanceId: null,
        };
        const pending = this.pending;
        this.pending = undefined;
        pending?.controller.abort();
        if (cancelPending)
            pending?.resolve(this.cancelledResult());
        const value = this.value;
        this.value = undefined;
        this.readySince = undefined;
        if (value)
            this.disposeValue(value.current);
    }
    disposeValue(value) {
        try {
            void Promise.resolve(this.options.disposeValue?.(value)).catch((error) => {
                this.options.onCleanupError?.(error);
            });
        }
        catch (error) {
            this.options.onCleanupError?.(error);
        }
    }
    isCurrent(attempt) {
        return (!this.disposed && this.pending === attempt && this.snapshot.generation === attempt.generation);
    }
    resetFailures() {
        this.failures = 0;
        this.unknownFailures = 0;
        this.offlineSince = undefined;
    }
    cancelledResult() {
        return { connected: false, error: classifyHostRecoveryError(CANCELLED) };
    }
    clearTimer() {
        if (this.timer !== undefined)
            this.clock.clearTimeout(this.timer);
        this.timer = undefined;
    }
    publish(patch) {
        this.snapshot = {
            ...this.snapshot,
            ...patch,
            ...((patch.state ?? this.snapshot.state) === 'ready' ? {} : { daemonInstanceId: null }),
            revision: this.snapshot.revision + 1,
            phaseStartedAtMs: patch.phase !== undefined && patch.phase !== this.snapshot.phase
                ? this.clock.now()
                : this.snapshot.phaseStartedAtMs,
        };
        this.options.onSnapshot?.(this.getSnapshot());
    }
}

