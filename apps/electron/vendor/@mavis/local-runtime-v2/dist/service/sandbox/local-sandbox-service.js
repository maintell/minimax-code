import { createHash, randomUUID } from 'node:crypto';
import { normalizeSandboxSettings } from '@mavis/config/sandbox-settings';
import { assertSandboxBackendCapabilities, selectSandboxBackendCandidate, } from './backend/selector.js';
import { activationForChangedFields, asSandboxConfigInvalid, parseSandboxCandidate, sandboxChangedFields, } from './config-commit.js';
import { compileSandboxEffectivePolicy, withReadOnlyFilesystem } from './effective-policy.js';
import { CurrentEffectiveStateStore, } from './backend/effective-state.js';
import { resolveSandboxInvocationContext, SandboxSessionTempManager, } from './invocation-context.js';
import { SandboxError } from './sandbox-errors.js';
import { sandboxErrorOutcome, } from './observability/invocation-trace.js';
import { SandboxObservability, } from './observability/sandbox-observability.js';
export class LocalSandboxService {
    #config;
    #descriptors;
    #platform;
    #tempManager;
    #observability;
    #now;
    #closeJoinTimeoutMs;
    #configWriter;
    #effectiveState;
    #backendRecords = new Map();
    #activeInvocations = new Map();
    #activeInvocationsByCommandId = new Map();
    #lifecycle = 'disabled';
    #admissionOpen = true;
    #initializePromise;
    #resetPromise;
    #closePromise;
    #failure;
    #activation;
    #transactionTail = Promise.resolve();
    #commitGate;
    #releaseCommitGate;
    constructor(options) {
        this.#config = structuredClone(options.config);
        const settings = normalizeSandboxSettings({
            enabled: this.#config.enabled,
            filesystemMode: this.#config.filesystem.policy.mode,
        });
        this.#config.enabled = settings.enabled;
        this.#config.filesystem.policy = { mode: settings.filesystemMode };
        this.#descriptors = options.descriptors ?? [];
        this.#platform = options.platform ?? process.platform;
        this.#tempManager = options.tempManager ?? new SandboxSessionTempManager();
        this.#observability = new SandboxObservability({
            ...options.observability,
            ...(options.now ? { nowMs: options.now } : {}),
        });
        this.#now = options.now ?? Date.now;
        this.#closeJoinTimeoutMs = options.closeJoinTimeoutMs ?? 5_000;
        this.#configWriter = options.configWriter;
        const policy = compileSandboxEffectivePolicy(this.#config);
        this.#effectiveState = new CurrentEffectiveStateStore(disabledState(policy));
    }
    lifecycleState() {
        return this.#lifecycle;
    }
    currentEffectiveState() {
        return this.#effectiveState.load();
    }
    failure() {
        return this.#failure;
    }
    status() {
        const state = this.#effectiveState.load();
        const currentRecord = state.backendHandle
            ? this.#backendRecords.get(state.backendHandle.id)
            : undefined;
        const versions = currentRecord?.backend.describeVersions();
        const policy = state.compiledBackendPolicy;
        return Object.freeze({
            surface: 'bash-only',
            state: this.#lifecycle,
            ...(this.#hasDesiredMacBackend() ? { desiredBackend: 'srt-macos' } : {}),
            ...(currentRecord?.backend.id === 'srt-macos'
                ? { effectiveBackend: 'srt-macos' }
                : {}),
            ...(versions ? { backendVersion: versions.backendVersion } : {}),
            ...(versions?.upstreamVersion ? { upstreamVersion: versions.upstreamVersion } : {}),
            effectiveGeneration: state.effectiveGeneration,
            ...(this.#activation ? { activation: this.#activation } : {}),
            activeInvocations: [...this.#activeInvocations.values()].filter((invocation) => this.#backendRecords.get(invocation.backendHandleId)?.current).length,
            retiringInvocations: [...this.#activeInvocations.values()].filter((invocation) => !this.#backendRecords.get(invocation.backendHandleId)?.current).length,
            ...(policy
                ? {
                    filesystemMode: policy.filesystem.mode,
                    networkMode: policy.network.mode,
                    localAccess: policy.localAccess,
                    deniedDomainRuleCount: policy.network.deniedDomains.length,
                    denyReadRuleCount: policy.filesystem.denyRead.length,
                }
                : {}),
            ...(this.#failureCode() ? { lastErrorCode: this.#failureCode() } : {}),
        });
    }
    observationSnapshot() {
        const state = this.#effectiveState.load();
        const status = this.status();
        return {
            configured_value_source: 'runtime_committed',
            configured_enabled: this.#config.enabled,
            configured_filesystem_mode: this.#config.filesystem.policy.mode,
            runtime_state: status.state,
            effective_enabled: state.enabled,
            effective_generation: state.effectiveGeneration,
            filesystem_mode: state.invocationPolicy.filesystem.mode,
            network_mode: state.compiledBackendPolicy?.network.mode ?? null,
            local_access: state.wrapLocalAccess,
            backend: status.effectiveBackend ?? null,
            backend_version: status.backendVersion ?? null,
            upstream_version: status.upstreamVersion ?? null,
            deny_read_rule_count: state.invocationPolicy.filesystem.denyRead.length,
            deny_write_rule_count: state.invocationPolicy.filesystem.denyWrite.length,
            denied_domain_rule_count: state.compiledBackendPolicy?.network.deniedDomains.length ?? 0,
            last_error_code: status.lastErrorCode ?? null,
        };
    }
    observeTurn(identity) {
        this.#observability.event('sandbox.state_observed', this.observationSnapshot(), { identity });
    }
    violations() {
        return this.#observability.listViolations();
    }
    initialize() {
        if (this.#initializePromise)
            return this.#initializePromise;
        if (this.#lifecycle === 'closed' || this.#lifecycle === 'closing') {
            return Promise.reject(new SandboxError('SANDBOX_CLOSING', 'close', 'Sandbox is closing'));
        }
        this.#initializePromise = this.#performInitialize();
        return this.#initializePromise;
    }
    applyConfig(candidate) {
        const previous = this.#transactionTail;
        const run = this.#applyConfigAfter(previous, candidate);
        this.#transactionTail = this.#settleConfigTransaction(run);
        return run;
    }
    async #applyConfigAfter(previous, candidate) {
        await previous;
        const before = this.observationSnapshot();
        const observation = { stage: 'prepare', persisted: false };
        try {
            const result = await this.#performApplyConfig(candidate, observation);
            this.#observability.runtimeChange('sandbox.config_changed', {
                before,
                candidate: observation.candidate,
                after: this.observationSnapshot(),
                result: 'success',
                persisted: observation.persisted,
                changed_fields: result.changedFields,
                activation: result.activation,
            });
            return result;
        }
        catch (error) {
            this.#observability.reconfigure(observation.changedFields
                ? activationForChangedFields(observation.changedFields)
                : 'unknown', 'failure');
            const outcome = sandboxErrorOutcome(error, 'CONFIG_COMMIT_FAILED');
            this.#observability.runtimeChange('sandbox.config_changed', {
                before,
                candidate: observation.candidate,
                after: this.observationSnapshot(),
                result: 'failure',
                persisted: observation.persisted,
                changed_fields: observation.changedFields ?? [],
                reason_code: outcome.reasonCode,
                error_stage: outcome.errorStage ?? observation.stage,
            }, true);
            throw error;
        }
    }
    async #settleConfigTransaction(run) {
        try {
            await run;
        }
        catch {
            // The caller receives the rejection; the serialization tail must remain usable.
        }
    }
    async beginInvocation(input) {
        const trace = this.#observability.startInvocation(input.identity, this.observationSnapshot());
        try {
            return await this.#admitInvocation(input, trace);
        }
        catch (error) {
            trace.finish(sandboxErrorOutcome(error));
            throw error;
        }
    }
    #assertNativeAdmission() {
        if (this.#config.enabled) {
            throw new SandboxError('SANDBOX_UNAVAILABLE', 'invocation', 'Sandbox is not initialized');
        }
    }
    #invocationPolicy(identity, configuredPolicy) {
        return identity.forceReadOnlyFilesystem === true
            ? withReadOnlyFilesystem(configuredPolicy)
            : configuredPolicy;
    }
    async #admitInvocation(input, trace) {
        await this.#waitForCommitGate();
        this.#assertInvocationAdmission();
        const snapshot = this.#effectiveState.load();
        if (!snapshot.enabled) {
            this.#assertNativeAdmission();
            trace.policy({
                ...this.observationSnapshot(),
                execution_mode: 'native',
                reason_code: 'SANDBOX_DISABLED',
            });
            return {
                sandboxed: false,
                trace,
                finish: async (_handle, outcome) => {
                    trace.finish(outcome ?? { termination: 'unknown', reasonCode: 'EXECUTION_OUTCOME_UNKNOWN' });
                },
            };
        }
        if (this.#lifecycle !== 'ready' || !snapshot.backendHandle || !snapshot.compiledBackendPolicy) {
            throw new SandboxError('SANDBOX_UNAVAILABLE', 'invocation', 'Sandbox service is unavailable');
        }
        const backendRecord = this.#backendRecords.get(snapshot.backendHandle.id);
        if (!backendRecord) {
            throw new SandboxError('SANDBOX_UNAVAILABLE', 'invocation', 'Sandbox backend is unavailable');
        }
        const invocationPolicy = this.#invocationPolicy(input.identity, snapshot.compiledBackendPolicy);
        assertSandboxBackendCapabilities(backendRecord.backend, invocationPolicy);
        const key = invocationKey(input.identity);
        const srtCommandId = createSrtCommandId(input.identity);
        if (this.#activeInvocations.has(key) || this.#activeInvocationsByCommandId.has(srtCommandId)) {
            throw new SandboxError('SANDBOX_UNAVAILABLE', 'invocation', 'Duplicate sandbox invocation');
        }
        this.#observability.bindInvocation(srtCommandId, snapshot.effectiveGeneration, trace);
        trace.policy({
            ...this.observationSnapshot(),
            execution_mode: 'sandboxed',
            filesystem_mode: invocationPolicy.filesystem.mode,
            filesystem_generation: snapshot.effectiveGeneration,
            // Git config writes are always allowed; the toggle no longer exists.
            allow_git_config: true,
            network_policy_scope: 'live-global',
            network_decision_generation: null,
        });
        backendRecord.references += 1;
        const abortController = new AbortController();
        let resolveSettled = () => undefined;
        const settled = new Promise((resolvePromise) => {
            resolveSettled = resolvePromise;
        });
        const active = {
            key,
            srtCommandId,
            identity: Object.freeze({ ...input.identity }),
            generation: snapshot.effectiveGeneration,
            backendHandleId: backendRecord.handle.id,
            startedAt: this.#now(),
            abortController,
            settled,
            resolveSettled,
        };
        this.#activeInvocations.set(key, active);
        this.#activeInvocationsByCommandId.set(srtCommandId, active);
        this.#observability.activeInvocations(this.#activeInvocations.size);
        let finished = false;
        const finish = async (handle, outcome = {
            termination: 'unknown',
            reasonCode: 'EXECUTION_OUTCOME_UNKNOWN',
        }) => {
            if (finished)
                return;
            finished = true;
            if (handle)
                active.backendInvocationHandle = handle;
            let cleanup = 'success';
            try {
                if (active.backendInvocationHandle) {
                    await backendRecord.backend.onInvocationEnd(active.backendInvocationHandle);
                }
            }
            catch {
                cleanup = 'failure';
            }
            finally {
                this.#activeInvocations.delete(key);
                this.#activeInvocationsByCommandId.delete(srtCommandId);
                backendRecord.references -= 1;
                active.resolveSettled();
                this.#observability.activeInvocations(this.#activeInvocations.size);
                try {
                    await this.#cleanupRetiredBackendIfIdle(backendRecord);
                }
                catch {
                    cleanup = 'failure';
                }
                trace.finish({ ...outcome, cleanup });
            }
        };
        try {
            const sessionTempDir = await this.#tempManager.sessionDir(input.identity.sessionId);
            const context = await resolveSandboxInvocationContext({
                workspaceRoot: input.workspaceRoot,
                cwd: input.cwd,
                sessionTempDir,
                runtimeTempInstanceDir: this.#tempManager.instanceDir,
                sandboxTempRoot: this.#tempManager.totalRoot,
                policy: invocationPolicy,
            });
            this.#assertInvocationStillAdmitted(abortController.signal);
            return {
                sandboxed: true,
                generation: snapshot.effectiveGeneration,
                filesystemMode: invocationPolicy.filesystem.mode,
                srtCommandId,
                backend: backendRecord.backend,
                context,
                signal: abortController.signal,
                trace,
                finish,
            };
        }
        catch (error) {
            await finish(undefined, abortController.signal.aborted
                ? { termination: 'aborted', reasonCode: 'RUNTIME_SHUTDOWN' }
                : sandboxErrorOutcome(error));
            throw error;
        }
    }
    debugActiveInvocations() {
        return [...this.#activeInvocations.values()].map((record) => Object.freeze({
            identity: Object.freeze({ ...record.identity }),
            generation: record.generation,
            backendHandleId: record.backendHandleId,
            startedAt: record.startedAt,
            aborted: record.abortController.signal.aborted,
        }));
    }
    reset() {
        if (this.#closePromise)
            return this.#closePromise;
        if (this.#resetPromise)
            return this.#resetPromise;
        this.#resetPromise = this.#performReset();
        return this.#resetPromise;
    }
    close() {
        if (this.#closePromise)
            return this.#closePromise;
        this.#closePromise = this.#performClose();
        return this.#closePromise;
    }
    async #performInitialize() {
        this.#lifecycle = 'initializing';
        this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
        try {
            // A disabled sandbox owns no temp roots and publishes no profile, so it
            // must not be parked in `failed` by a temp-manager failure it never needs.
            if (!this.#config.enabled) {
                this.#lifecycle = 'disabled';
                this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
                return;
            }
            await this.#tempManager.initialize();
            const policy = compileSandboxEffectivePolicy(this.#config);
            const backend = selectSandboxBackendCandidate({
                descriptors: this.#descriptors,
                platform: this.#platform,
            });
            let initialized = false;
            try {
                await backend.validatePolicy(policy);
                assertSandboxBackendCapabilities(backend, policy);
                await backend.initialize(policy, this.#observability.backendHooks());
                initialized = true;
                const preparedNetwork = await backend.prepareNetworkPolicy(policy.network);
                const record = this.#registerBackend(backend);
                backend.publishNetworkPolicy(preparedNetwork);
                this.#effectiveState.publish(enabledState(1, policy, record.handle, preparedNetwork));
                this.#activation = 'initialized';
                this.#lifecycle = 'ready';
                this.#observability.initialization('success');
                this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
            }
            catch (error) {
                if (initialized)
                    await this.#resetBackendIgnoringFailure(backend);
                throw error;
            }
        }
        catch (error) {
            this.#failure = error;
            this.#lifecycle = 'failed';
            this.#observability.initialization('failure', error instanceof SandboxError ? error.code : 'SANDBOX_INITIALIZATION_FAILED');
            this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot(), true);
            throw error;
        }
    }
    async #performApplyConfig(candidate, observation) {
        if (!this.#admissionOpen || this.#isClosingOrClosed()) {
            throw new SandboxError('SANDBOX_CLOSING', 'close', 'Sandbox is closing');
        }
        const prepared = await this.#prepareConfigChange(candidate, observation);
        if (!this.#admissionOpen || this.#isClosingOrClosed()) {
            await this.#discardPreparedBackend(prepared);
            throw new SandboxError('SANDBOX_CLOSING', 'close', 'Sandbox is closing');
        }
        this.#enterCommitGate();
        try {
            observation.stage = 'persist';
            await this.#commitConfigFile(prepared);
            observation.persisted = true;
            observation.stage = 'publish';
            return prepared.parsed.enabled
                ? this.#publishEnabledConfig(prepared)
                : this.#publishDisabledConfig(prepared);
        }
        finally {
            this.#leaveCommitGate();
        }
    }
    async #prepareConfigChange(candidate, observation) {
        const parsed = this.#parseCandidate(candidate);
        observation.candidate = {
            enabled: parsed.enabled,
            filesystem_mode: parsed.filesystem.policy.mode,
            network_mode: parsed.network.policy.mode,
            local_access: parsed.localAccess,
            // Git config writes are always allowed; the toggle no longer exists.
            allow_git_config: true,
            deny_read_rule_count: parsed.filesystem.denyRead.length,
            deny_write_rule_count: parsed.filesystem.denyWrite.length,
            denied_domain_rule_count: parsed.network.deniedDomains.length,
        };
        observation.changedFields = sandboxChangedFields(this.#config, parsed);
        const previousLifecycle = this.#lifecycle;
        await this.#prepareCandidateTempRoot(parsed);
        const policy = this.#compileCandidate(parsed);
        const base = {
            parsed,
            policy,
            previousLifecycle,
            previousState: this.#effectiveState.load(),
            changedFields: sandboxChangedFields(this.#config, parsed),
            initializedForCommit: false,
        };
        if (!parsed.enabled)
            return base;
        return { ...base, ...(await this.#prepareEnabledBackend(policy, previousLifecycle)) };
    }
    /**
     * A disabled candidate never reaches a backend profile, so it needs no temp
     * root and stays applicable after a temp-manager failure — that rollback is
     * the only in-product way out of `failed`. An enabled candidate must first
     * hold the real canonical root, so it re-runs the idempotent temp
     * initialization and is rejected when that still fails. The rejection leaves
     * the lifecycle untouched: nothing was committed, and a failed enable attempt
     * must not close native Bash for a disabled service.
     */
    async #prepareCandidateTempRoot(parsed) {
        if (!parsed.enabled)
            return;
        try {
            await this.#tempManager.initialize();
        }
        catch {
            this.#observability.initialization('failure', 'SANDBOX_INITIALIZATION_FAILED');
            throw new SandboxError('SANDBOX_INITIALIZATION_FAILED', 'init', 'Sandbox temp root preparation failed');
        }
    }
    #parseCandidate(candidate) {
        try {
            return parseSandboxCandidate(candidate);
        }
        catch (error) {
            this.#observability.configRejected('product-parser');
            throw error;
        }
    }
    #compileCandidate(parsed) {
        try {
            return compileSandboxEffectivePolicy(parsed);
        }
        catch (error) {
            this.#observability.configRejected('policy-compile');
            throw asSandboxConfigInvalid(error);
        }
    }
    async #prepareEnabledBackend(policy, previousLifecycle) {
        const candidateBackend = this.#selectBackendForConfig();
        const backendRecord = this.#findReusableBackend(candidateBackend.id);
        const backend = backendRecord?.backend ?? candidateBackend;
        await this.#validateBackendForConfig(backend, policy);
        const initializedForCommit = await this.#initializeBackendForCommit(backend, backendRecord, policy);
        try {
            const preparedNetwork = await backend.prepareNetworkPolicy(policy.network);
            return { backend, backendRecord, preparedNetwork, initializedForCommit };
        }
        catch (error) {
            this.#observability.configRejected('backend-schema');
            if (initializedForCommit)
                await this.#resetBackendIgnoringFailure(backend);
            this.#lifecycle = previousLifecycle;
            throw asSandboxConfigInvalid(error, 'sandbox.network');
        }
    }
    #selectBackendForConfig() {
        try {
            return selectSandboxBackendCandidate({
                descriptors: this.#descriptors,
                platform: this.#platform,
            });
        }
        catch (error) {
            this.#observability.configRejected('backend-select');
            throw asSandboxConfigInvalid(error, 'sandbox.enabled');
        }
    }
    async #validateBackendForConfig(backend, policy) {
        try {
            await backend.validatePolicy(policy);
        }
        catch (error) {
            this.#observability.configRejected('backend-schema');
            throw asSandboxConfigInvalid(error);
        }
        try {
            assertSandboxBackendCapabilities(backend, policy);
        }
        catch (error) {
            this.#observability.configRejected('capability');
            throw asSandboxConfigInvalid(error);
        }
    }
    async #initializeBackendForCommit(backend, backendRecord, policy) {
        if (backendRecord)
            return false;
        this.#lifecycle = 'initializing';
        try {
            await backend.initialize(policy, this.#observability.backendHooks());
            this.#observability.initialization('success');
            return true;
        }
        catch (error) {
            this.#failure = error;
            this.#lifecycle = 'failed';
            this.#observability.initialization('failure', error instanceof SandboxError ? error.code : 'SANDBOX_INITIALIZATION_FAILED');
            throw error;
        }
    }
    async #discardPreparedBackend(prepared) {
        if (prepared.initializedForCommit && prepared.backend) {
            await this.#resetBackendIgnoringFailure(prepared.backend);
        }
    }
    async #commitConfigFile(prepared) {
        try {
            await this.#configWriter(prepared.parsed);
        }
        catch (error) {
            if (prepared.initializedForCommit && prepared.backend) {
                await this.#resetInitializedBackendOrFail(prepared.backend);
            }
            this.#lifecycle = prepared.previousLifecycle;
            throw error;
        }
    }
    async #publishDisabledConfig(prepared) {
        const nextGeneration = prepared.previousState.effectiveGeneration + 1;
        const previousRecord = prepared.previousState.backendHandle
            ? this.#backendRecords.get(prepared.previousState.backendHandle.id)
            : undefined;
        if (previousRecord)
            previousRecord.current = false;
        this.#effectiveState.publish(disabledState(prepared.policy, nextGeneration));
        this.#config = structuredClone(prepared.parsed);
        this.#failure = undefined;
        if (!this.#isClosingOrClosed())
            this.#lifecycle = 'disabled';
        if (previousRecord)
            await this.#cleanupRetiredBackendBestEffort(previousRecord);
        return this.#recordApplyResult({
            effectiveGeneration: nextGeneration,
            activation: 'disabled-retiring',
            changedFields: prepared.changedFields,
        });
    }
    #publishEnabledConfig(prepared) {
        const { backend, preparedNetwork } = prepared;
        if (!backend || !preparedNetwork) {
            throw new SandboxError('SANDBOX_INITIALIZATION_FAILED', 'commit', 'Prepared sandbox backend is missing');
        }
        try {
            if (!prepared.initializedForCommit)
                backend.updateConfig(prepared.policy);
            backend.publishNetworkPolicy(preparedNetwork);
        }
        catch (error) {
            this.#failure = error;
            this.#lifecycle = 'failed';
            throw new SandboxError('SANDBOX_INITIALIZATION_FAILED', 'commit', 'Sandbox policy publication failed after config commit');
        }
        const record = prepared.backendRecord ?? this.#registerBackend(backend);
        record.current = true;
        const nextGeneration = prepared.previousState.effectiveGeneration + 1;
        this.#effectiveState.publish(enabledState(nextGeneration, prepared.policy, record.handle, preparedNetwork));
        this.#config = structuredClone(prepared.parsed);
        this.#failure = undefined;
        if (!this.#isClosingOrClosed())
            this.#lifecycle = 'ready';
        return this.#recordApplyResult({
            effectiveGeneration: nextGeneration,
            activation: prepared.initializedForCommit
                ? 'initialized'
                : activationForChangedFields(prepared.changedFields),
            changedFields: prepared.changedFields,
        });
    }
    #recordApplyResult(result) {
        this.#activation = result.activation;
        this.#observability.reconfigure(result.activation, 'success');
        return result;
    }
    async #performReset() {
        this.#admissionOpen = false;
        await this.#transactionTail;
        this.#abortAllInvocations();
        await this.#joinActiveInvocations();
        for (const record of this.#backendRecords.values())
            record.current = false;
        await Promise.allSettled([...this.#backendRecords.values()].map((record) => this.#cleanupBackend(record)));
        if (this.#lifecycle !== 'closing' && this.#lifecycle !== 'closed') {
            this.#lifecycle = this.#config.enabled ? 'failed' : 'disabled';
            this.#admissionOpen = !this.#config.enabled;
            this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
        }
    }
    async #performClose() {
        this.#admissionOpen = false;
        this.#lifecycle = 'closing';
        this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
        await this.#transactionTail;
        if (this.#resetPromise)
            await this.#resetPromise;
        this.#abortAllInvocations();
        try {
            await this.#joinActiveInvocations();
        }
        finally {
            for (const record of this.#backendRecords.values())
                record.current = false;
            await Promise.allSettled([...this.#backendRecords.values()].map((record) => this.#cleanupBackend(record)));
            try {
                await this.#tempManager.close();
            }
            catch {
                // Backend cleanup evidence is retained; temp cleanup is best-effort on close.
            }
            this.#lifecycle = 'closed';
            this.#observability.runtimeChange('sandbox.lifecycle_changed', this.observationSnapshot());
            this.#observability.close();
        }
    }
    #assertInvocationAdmission() {
        if (!this.#admissionOpen || this.#isClosingOrClosed()) {
            throw new SandboxError('SANDBOX_CLOSING', 'close', 'Sandbox is closing');
        }
        if (this.#lifecycle === 'failed' || this.#lifecycle === 'initializing') {
            throw new SandboxError('SANDBOX_INITIALIZATION_FAILED', 'init', 'Sandbox is not ready');
        }
    }
    #assertInvocationStillAdmitted(signal) {
        if (!this.#admissionOpen || signal.aborted) {
            throw new SandboxError('SANDBOX_CLOSING', 'close', 'Sandbox is closing');
        }
    }
    #registerBackend(backend) {
        const handle = Object.freeze({ id: randomUUID(), backendId: backend.id });
        const record = { handle, backend, references: 0, current: true };
        this.#backendRecords.set(handle.id, record);
        return record;
    }
    async #resetBackendIgnoringFailure(backend) {
        try {
            await backend.reset();
        }
        catch {
            // Preserve the primary initialize/validation/closing failure.
        }
    }
    async #resetInitializedBackendOrFail(backend) {
        try {
            await backend.reset();
        }
        catch (error) {
            this.#failure = error;
            this.#lifecycle = 'failed';
            throw error;
        }
    }
    async #cleanupRetiredBackendBestEffort(record) {
        try {
            await this.#cleanupRetiredBackendIfIdle(record);
        }
        catch (error) {
            this.#failure = error;
        }
    }
    #findReusableBackend(backendId) {
        return [...this.#backendRecords.values()].find((record) => record.backend.id === backendId && !record.cleanup);
    }
    #isClosingOrClosed() {
        return this.#lifecycle === 'closing' || this.#lifecycle === 'closed';
    }
    #enterCommitGate() {
        if (this.#commitGate)
            throw new Error('Sandbox commit gate is already closed');
        this.#commitGate = new Promise((resolvePromise) => {
            this.#releaseCommitGate = resolvePromise;
        });
    }
    #leaveCommitGate() {
        this.#releaseCommitGate?.();
        this.#releaseCommitGate = undefined;
        this.#commitGate = undefined;
    }
    async #waitForCommitGate() {
        await this.#commitGate;
    }
    #abortAllInvocations() {
        for (const invocation of this.#activeInvocations.values()) {
            invocation.abortController.abort(new Error('Sandbox service is closing'));
        }
    }
    async #joinActiveInvocations() {
        const active = [...this.#activeInvocations.values()];
        if (active.length === 0)
            return;
        // Clear the timer when the join wins the race; leaving it pending would
        // hold the event loop open for the whole join timeout after close()
        // already returned.
        let timer;
        try {
            await Promise.race([
                Promise.allSettled(active.map((invocation) => invocation.settled)),
                new Promise((resolvePromise) => {
                    timer = setTimeout(resolvePromise, this.#closeJoinTimeoutMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async #cleanupRetiredBackendIfIdle(record) {
        if (!record.current && record.references === 0)
            await this.#cleanupBackend(record);
    }
    #cleanupBackend(record) {
        if (record.cleanup)
            return record.cleanup;
        record.cleanup = (async () => {
            await record.backend.onProcessCleanup();
            await record.backend.reset();
            this.#backendRecords.delete(record.handle.id);
        })();
        return record.cleanup;
    }
    #failureCode() {
        if (this.#failure instanceof SandboxError)
            return this.#failure.code;
        if (this.#failure)
            return 'SANDBOX_INITIALIZATION_FAILED';
        return undefined;
    }
    #hasDesiredMacBackend() {
        if (!this.#config.enabled)
            return false;
        return this.#descriptors.some((descriptor) => descriptor.platform === this.#platform && descriptor.id === 'srt-macos');
    }
}
function disabledState(policy, generation = 0) {
    return {
        effectiveGeneration: generation,
        enabled: false,
        invocationPolicy: { filesystem: policy.filesystem },
        wrapLocalAccess: policy.localAccess,
        compiledBackendPolicy: policy,
    };
}
function enabledState(generation, policy, handle, network) {
    return {
        effectiveGeneration: generation,
        enabled: true,
        backendHandle: handle,
        invocationPolicy: { filesystem: policy.filesystem },
        liveNetworkPolicy: network,
        wrapLocalAccess: policy.localAccess,
        compiledBackendPolicy: policy,
    };
}
function invocationKey(identity) {
    return [identity.operationClass, identity.sessionId, identity.turnId, identity.invocationId].join('\0');
}
/** Unique opaque id per execution attempt, including retries of the same tool call. */
function createSrtCommandId(identity) {
    const payload = [
        identity.operationClass,
        identity.sessionId,
        identity.turnId,
        identity.invocationId,
        randomUUID(),
    ].join('\0');
    return `sbx_${createHash('sha256').update(payload).digest('hex')}`;
}
//# sourceMappingURL=local-sandbox-service.js.map