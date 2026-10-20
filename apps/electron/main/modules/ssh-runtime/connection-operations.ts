const PROGRESS_TICK_MS = 2000;
const INSTALL_ESTIMATE_MS = 120000;
const VERIFY_ESTIMATE_MS = 30000;
function estimatedProgress(phase, elapsedMs) {
    if (phase === 'installing') {
        return Math.min(84, 1 + Math.floor(84 * (1 - Math.exp(-elapsedMs / INSTALL_ESTIMATE_MS))));
    }
    return Math.min(95, 85 + Math.floor(11 * (1 - Math.exp(-elapsedMs / VERIFY_ESTIMATE_MS))));
}
/** One coordinator per Main/profile. UI lifetimes never own an installation. */
export class SshConnectionOperations {
    constructor() {
        this.revision = 0;
        this.states = new Map();
        this.tokens = new Map();
        this.probes = new Map();
        this.installs = new Map();
        this.progressTimers = new Map();
        this.listeners = new Set();
        this.runtimeSnapshots = new Map();
        this.retiredEpochs = new Map();
        this.forgotten = new Set();
    }
    /** Main-only input; probe must be the Registry's validated ready capability cache. */
    observeRuntimeSnapshot(alias, snapshot, probe) {
        if (snapshot.hostId !== alias || this.forgotten.has(alias))
            return;
        const previous = this.runtimeSnapshots.get(alias);
        if (this.retiredEpochs.get(alias)?.has(snapshot.controllerEpoch))
            return;
        if (previous) {
            if (snapshot.configRevision < previous.configRevision)
                return;
            if (snapshot.controllerEpoch === previous.controllerEpoch) {
                if (snapshot.configRevision !== previous.configRevision ||
                    snapshot.revision <= previous.revision ||
                    snapshot.generation < previous.generation)
                    return;
            }
            else
                this.retireRuntime(alias);
        }
        const hostConnection = { ...snapshot, error: snapshot.error ? { ...snapshot.error } : null };
        this.runtimeSnapshots.set(alias, hostConnection);
        const current = this.states.get(alias);
        const next = {
            alias,
            phase: current?.phase ?? (snapshot.state === 'disabled' ? 'disabled' : 'idle'),
            ...current,
            hostConnection,
            ...(snapshot.state === 'ready' && probe?.alias === alias && probe.status === 'ready'
                ? { probe }
                : {}),
        };
        // A new connection attempt supersedes a completed installation failure.
        // Clear Main's retained result as well, so reopening Settings cannot revive it.
        const setupFailure = current?.setupResult?.success === false ? current.setupResult : undefined;
        const serviceVersionUpdated = snapshot.state === 'ready' &&
            probe?.alias === alias &&
            probe.status === 'ready' &&
            !!setupFailure?.probe?.mcodeVersion &&
            probe.mcodeVersion === setupFailure.probe.mcodeVersion;
        if (current?.phase === 'idle' &&
            (snapshot.state === 'connecting' || snapshot.state === 'ready') &&
            setupFailure &&
            (setupFailure.error !== 'service_version_pending' || serviceVersionUpdated)) {
            delete next.setupResult;
        }
        this.publish(next);
    }
    snapshot() {
        return [...this.states.values()];
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    isInstalling(alias) {
        return this.installs.has(alias);
    }
    /** Keep async validation from changing a removed, replaced, or now-busy connection. */
    checkpoint(alias) {
        const token = this.tokens.get(alias) ?? {};
        this.tokens.set(alias, token);
        return () => this.tokens.get(alias) === token;
    }
    forget(alias) {
        this.retireRuntime(alias);
        this.forgotten.add(alias);
        this.stopProgress(alias);
        this.tokens.delete(alias);
        this.probes.delete(alias);
        this.states.delete(alias);
    }
    seed(alias, probe, enabled = true) {
        this.retireRuntime(alias);
        this.forgotten.delete(alias);
        this.states.delete(alias);
        this.stopProgress(alias);
        this.tokens.set(alias, {});
        this.probes.delete(alias);
        this.publish({ alias, phase: enabled ? 'idle' : 'disabled', ...(probe ? { probe } : {}) });
    }
    probe(alias, work) {
        const install = this.installs.get(alias);
        if (install)
            return install.then((result) => result.probe ?? { alias, status: 'probe_failed' });
        const pending = this.probes.get(alias);
        if (pending)
            return pending;
        const token = {};
        const hostAtStart = this.states.get(alias)?.hostConnection;
        this.tokens.set(alias, token);
        this.publish({ alias, phase: 'probing', probe: this.states.get(alias)?.probe });
        const task = Promise.resolve()
            .then(work)
            .catch(() => ({ alias, status: 'probe_failed' }))
            .then((probe) => {
            if (this.tokens.get(alias) === token) {
                const current = this.states.get(alias);
                const newerReady = current?.hostConnection?.state === 'ready' &&
                    current.probe?.status === 'ready' &&
                    current.hostConnection !== hostAtStart;
                this.publish({ alias, phase: 'idle', probe: newerReady ? current.probe : probe });
            }
            return probe;
        })
            .finally(() => {
            if (this.probes.get(alias) === task)
                this.probes.delete(alias);
        });
        this.probes.set(alias, task);
        return task;
    }
    install(alias, work) {
        const pending = this.installs.get(alias);
        if (pending)
            return pending;
        const token = {};
        this.tokens.set(alias, token);
        this.probes.delete(alias);
        const previousProbe = this.states.get(alias)?.probe;
        let phase = 'installing';
        let phaseStartedAt = Date.now();
        this.publish({ alias, phase, probe: previousProbe, progressPercent: 1 });
        const timer = setInterval(() => {
            if (this.tokens.get(alias) !== token)
                return;
            const percent = estimatedProgress(phase, Date.now() - phaseStartedAt);
            const current = this.states.get(alias);
            if (current?.phase === phase && percent > (current.progressPercent ?? 0)) {
                this.publish({ alias, phase, probe: current.probe, progressPercent: percent });
            }
        }, PROGRESS_TICK_MS);
        timer.unref?.();
        this.progressTimers.set(alias, timer);
        const task = Promise.resolve()
            .then(() => work(() => {
            if (this.tokens.get(alias) === token) {
                phase = 'verifying';
                phaseStartedAt = Date.now();
                this.publish({
                    alias,
                    phase,
                    probe: this.states.get(alias)?.probe,
                    progressPercent: 85,
                });
            }
        }))
            .catch(() => ({
            success: false,
            error: 'install_failed',
            stage: 'install',
        }))
            .then((result) => {
            if (this.tokens.get(alias) === token) {
                this.publish({
                    alias,
                    phase: 'idle',
                    probe: result.probe ?? this.states.get(alias)?.probe ?? previousProbe,
                    setupResult: result,
                });
            }
            return result;
        })
            .finally(() => {
            if (this.progressTimers.get(alias) === timer)
                this.stopProgress(alias);
            if (this.installs.get(alias) === task)
                this.installs.delete(alias);
        });
        this.installs.set(alias, task);
        return task;
    }
    publish(state) {
        const hostConnection = state.hostConnection ?? this.states.get(state.alias)?.hostConnection;
        const next = {
            ...state,
            ...(hostConnection ? { hostConnection } : {}),
            revision: ++this.revision,
        };
        this.states.set(state.alias, next);
        for (const listener of this.listeners) {
            // A disappearing renderer must never fail the underlying operation.
            try {
                listener(next);
            }
            catch {
                /* IPC owner cleans up its subscription. */
            }
        }
    }
    retireRuntime(alias) {
        const snapshot = this.runtimeSnapshots.get(alias);
        if (!snapshot)
            return;
        let retired = this.retiredEpochs.get(alias);
        if (!retired)
            this.retiredEpochs.set(alias, (retired = new Set()));
        retired.add(snapshot.controllerEpoch);
    }
    stopProgress(alias) {
        const timer = this.progressTimers.get(alias);
        if (timer)
            clearInterval(timer);
        this.progressTimers.delete(alias);
    }
}

