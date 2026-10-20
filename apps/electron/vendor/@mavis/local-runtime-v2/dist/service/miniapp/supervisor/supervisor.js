import { randomUUID } from 'node:crypto';
import * as cleanup from './cleanup-settlement.js';
import * as errors from '../errors.js';
import { MiniAppError } from '../errors.js';
import { assertGenerationRunCurrent, assertReusableRuntimeCurrent, isReusableGeneration, persistedState, publishedView, runtimeLoopbackToken, scheduleTimeout, } from './supervisor-generation.js';
import { assertColdStartupAvailable, capturePublicationMemory, createSupervisorPreparation, disablePreparationCancellation, disableRolledBackError, explicitStartRequiredJson, persistedErrorDetail, persistExplicitStartFence, removeRetiringGeneration, restorePublicationMemory, restorePublicationPersistence, rollbackCommittedGeneration, } from './supervisor-transition.js';
import { SupervisorCutoverCoordinator } from './supervisor-cutover.js';
import { MiniAppSupervisorDiagnostics } from './supervisor-diagnostics.js';
import { admitLease, admitRunningLease, requireActiveGeneration, } from './supervisor-lease.js';
import { statusFor } from './supervisor-status.js';
export class DefaultMiniAppSupervisor {
    options;
    active = new Map();
    retiring = new Map();
    disabled = new Set();
    cold = new Set();
    preparations = new Map();
    failures = new Map();
    quarantined = new Set();
    explicitlyStopped = new Set();
    quiescing = new Map();
    publicationMemory = {
        disabled: this.disabled,
        cold: this.cold,
        quarantined: this.quarantined,
        failures: this.failures,
        explicitlyStopped: this.explicitlyStopped,
    };
    diagnostics;
    observations = new Set();
    cutover;
    closed = false;
    closePromise;
    constructor(options) {
        this.options = options;
        this.diagnostics = new MiniAppSupervisorDiagnostics({
            nodeRuntime: options.nodeRuntime,
            nowMs: () => this.nowMs(),
            ...(options.logger ? { logger: options.logger } : {}),
            ...(options.logCapacity !== undefined ? { logCapacity: options.logCapacity } : {}),
        });
        this.cutover = new SupervisorCutoverCoordinator({
            active: this.active,
            retiring: this.retiring,
            quiescing: this.quiescing,
            explicitlyStopped: this.explicitlyStopped,
            stateStore: options.stateStore,
            nowMs: () => this.nowMs(),
            isClosed: () => this.closed,
            isQuarantined: (pluginId) => this.quarantined.has(pluginId),
            assertCurrentPreparation: (pluginId, preparation) => this.assertCurrentPreparation(pluginId, preparation),
            quarantineCleanupFailure: (pluginId, error) => this.quarantineCleanupFailure(pluginId, error),
        });
    }
    async ready() {
        this.assertOpen();
        for (const state of this.options.stateStore.list()) {
            this.cold.add(state.pluginId);
            const persistedError = persistedErrorDetail(state.lastErrorJson);
            if (persistedError.requiresExplicitStart) {
                this.explicitlyStopped.add(state.pluginId);
                if (persistedError.code)
                    this.failures.set(state.pluginId, persistedError.code);
            }
        }
    }
    prepare(candidate, options = {}) {
        this.assertOpen();
        if (options.forceStart && options.startIfCold) {
            throw new TypeError('MiniApp preparation cannot combine forceStart and startIfCold');
        }
        const existing = this.preparations.get(candidate.pluginId);
        if (options.startIfCold && existing) {
            throw new MiniAppError('BUSY', 'MiniApp start cannot supersede an owned preparation', {
                busyReason: 'operation_busy',
            });
        }
        const preparation = createSupervisorPreparation(options.signal);
        this.preparations.set(candidate.pluginId, preparation);
        preparation.promise = this.prepareAfterSuperseding(candidate, options, preparation, existing);
        return preparation.promise;
    }
    async prepareAfterSuperseding(candidate, options, preparation, existing) {
        if (existing) {
            existing.controller.abort(new MiniAppError('SUPERSEDED', 'Mini App transition was superseded'));
            try {
                const transition = await existing.promise;
                await transition.rollback();
            }
            catch (error) {
                if (!(error instanceof MiniAppError) || error.code !== 'SUPERSEDED') {
                    this.clearPreparation(candidate.pluginId, preparation);
                    throw error;
                }
            }
            finally {
                existing.unlinkSignal();
            }
        }
        return this.prepareOwned(candidate, options, preparation);
    }
    async prepareOwned(candidate, options, preparation) {
        const miniAppGeneration = this.makeMiniAppGeneration();
        let reusable;
        let runtime;
        let ownsRuntime = false;
        let crossedPonr = options.forceStart === true && this.explicitlyStopped.has(candidate.pluginId);
        try {
            this.assertCurrentPreparation(candidate.pluginId, preparation);
            if (this.quarantined.has(candidate.pluginId)) {
                throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
            }
            await this.verifyCandidate(candidate, 'Mini App candidate changed during prepare');
            this.assertCurrentPreparation(candidate.pluginId, preparation);
            reusable = options.forceStart === true ? undefined : this.findReusableRuntime(candidate);
            runtime = await this.prepareCandidateRuntime(candidate, preparation, {
                miniAppGeneration,
                reusable,
                forceStart: [options.forceStart, options.startIfCold].includes(true),
                startIfCold: options.startIfCold === true,
                deadlineMs: this.resolveDrainDeadline(options.deadlineMs),
                onPonr: () => {
                    crossedPonr = true;
                },
            });
            ownsRuntime = Boolean(runtime && !reusable);
            this.assertCurrentPreparation(candidate.pluginId, preparation);
            await this.verifyCandidate(candidate, 'Mini App candidate changed during readiness');
            this.assertCurrentPreparation(candidate.pluginId, preparation);
        }
        catch (error) {
            this.clearPreparation(candidate.pluginId, preparation);
            const reason = preparation.controller.signal.reason;
            const cleanupFailed = this.quarantineCleanupFailure(candidate.pluginId, error);
            const primary = cleanupFailed || !(reason instanceof Error) ? error : reason;
            const failure = await cleanup.selectFailureAfterCleanup(primary, () => this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined));
            if (crossedPonr && !errors.isMiniAppExpectedCancellation(errors.miniAppErrorCode(failure))) {
                this.recordFailure(candidate.pluginId, errors.miniAppErrorCode(failure));
            }
            throw failure;
        }
        const target = publishedView(candidate, miniAppGeneration, runtime);
        let state = 'prepared';
        const commitOwner = {};
        let retiredGeneration;
        let committedGeneration;
        let previousGeneration;
        let previousAccepting = false;
        let persistenceCompensation;
        let memorySnapshot;
        let finalized = false;
        return {
            candidate,
            target,
            ...runtimeLoopbackToken(runtime),
            willPublishCold: !runtime,
            commit: async () => {
                this.assertOpen();
                this.assertCurrentPreparation(candidate.pluginId, preparation);
                if (state === 'rolled-back') {
                    throw new MiniAppError('SUPERSEDED', 'Mini App transition was rolled back');
                }
                if (commitOwner.promise)
                    return commitOwner.promise;
                return cleanup.startOwnedOperation(commitOwner, async () => {
                    try {
                        assertReusableRuntimeCurrent(this.active, candidate, reusable);
                        const previous = this.active.get(candidate.pluginId);
                        previousGeneration = previous;
                        previousAccepting = previous?.accepting ?? false;
                        memorySnapshot = capturePublicationMemory(this.publicationMemory, candidate.pluginId);
                        persistenceCompensation = await cleanup.acceptAndAdmitRuntime({
                            accept: () => this.acceptPreparedRuntime(candidate, runtime, ownsRuntime),
                            retirementOwners: () => this.retiring.get(candidate.pluginId) ?? [],
                            isQuarantined: () => this.quarantined.has(candidate.pluginId),
                            assertCurrent: () => this.assertCurrentPreparation(candidate.pluginId, preparation),
                            admit: () => {
                                retiredGeneration = this.publishPreparedGeneration({
                                    candidate,
                                    target,
                                    runtime,
                                    reusable,
                                });
                                committedGeneration = this.active.get(candidate.pluginId);
                            },
                            shouldCompensate: () => this.active.get(candidate.pluginId) === previous,
                            cleanup: () => this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined),
                        });
                    }
                    catch (error) {
                        state = 'rolled-back';
                        this.clearPreparation(candidate.pluginId, preparation);
                        throw error;
                    }
                    state = 'committed';
                    this.clearPreparation(candidate.pluginId, preparation);
                    return target;
                });
            },
            rollback: async () => {
                if (commitOwner.promise)
                    await commitOwner.promise;
                if (state === 'prepared') {
                    state = 'rolled-back';
                    this.clearPreparation(candidate.pluginId, preparation);
                    await this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined);
                    return;
                }
                if (state !== 'committed' ||
                    finalized ||
                    !committedGeneration ||
                    !memorySnapshot ||
                    !persistenceCompensation) {
                    return;
                }
                const rollbackSnapshot = memorySnapshot;
                try {
                    await rollbackCommittedGeneration({
                        pluginId: candidate.pluginId,
                        active: this.active,
                        retiring: this.retiring,
                        committedGeneration,
                        previousGeneration,
                        previousAccepting,
                        persistenceCompensation,
                        restoreMemory: () => restorePublicationMemory(this.publicationMemory, candidate.pluginId, rollbackSnapshot),
                        reusableGeneration: reusable?.generation,
                        runtimeWasReused: Boolean(reusable),
                        cleanupRuntime: (ownedRuntime) => this.cleanupOrQuarantine(candidate.pluginId, ownedRuntime),
                    });
                }
                finally {
                    state = 'rolled-back';
                }
            },
            finalize: async () => {
                if (state !== 'committed' || finalized)
                    return;
                finalized = true;
                if (!retiredGeneration)
                    return;
                retiredGeneration.retirementPendingFinalization = false;
                await this.removeRetiredIfDrained(candidate.pluginId, retiredGeneration);
            },
        };
    }
    async prepareCandidateRuntime(candidate, preparation, options) {
        if (options.reusable)
            return options.reusable.runtime;
        if (!options.forceStart)
            return undefined;
        const pluginId = candidate.pluginId;
        if (options.startIfCold) {
            assertColdStartupAvailable(this.active.get(pluginId), this.cutover.runtimeOwners(pluginId));
        }
        const current = this.active.get(candidate.pluginId);
        if (current && !options.startIfCold) {
            await this.cutover.settleStarting(candidate.pluginId, current, preparation, options.onPonr);
        }
        for (const generation of this.cutover.runtimeOwners(candidate.pluginId)) {
            await this.cutover.prepare({
                pluginId: candidate.pluginId,
                generation,
                preparation,
                deadlineMs: options.deadlineMs,
                validate: async () => {
                    this.assertCurrentPreparation(candidate.pluginId, preparation);
                    await this.verifyCandidate(candidate, 'Mini App candidate changed before cutover');
                    this.assertCurrentPreparation(candidate.pluginId, preparation);
                },
                onPonr: options.onPonr,
            });
        }
        return this.diagnostics.prepare({
            candidate,
            processGeneration: this.makeProcessGeneration(),
            signal: preparation.controller.signal,
        }, options.miniAppGeneration);
    }
    async acceptPreparedRuntime(candidate, runtime, ownsRuntime) {
        return cleanup.acceptRuntimePersistence({
            quarantined: this.quarantined.has(candidate.pluginId),
            readPrevious: () => this.options.stateStore.read(candidate.pluginId),
            writeAccepted: (previous) => {
                const accepted = persistedState(candidate, runtime, this.nowMs());
                this.options.stateStore.write(!runtime && this.explicitlyStopped.has(candidate.pluginId)
                    ? {
                        ...accepted,
                        lastErrorJson: explicitStartRequiredJson(previous?.lastErrorJson),
                    }
                    : accepted);
            },
            restore: (previous) => this.restorePersistedState(candidate.pluginId, previous),
            ...(ownsRuntime ? { activate: () => runtime?.hostConnectorSession?.activate() } : {}),
            cleanup: () => this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined),
        });
    }
    async cleanupOrQuarantine(pluginId, runtime) {
        try {
            await cleanup.cleanupRuntime(runtime);
        }
        catch (error) {
            this.quarantineCleanupFailure(pluginId, error);
            throw error;
        }
    }
    quarantineCleanupFailure(pluginId, error) {
        if (!errors.isMiniAppCleanupUnproven(error))
            return false;
        this.quarantined.add(pluginId);
        this.recordFailure(pluginId, 'CLEANUP_UNPROVEN');
        return true;
    }
    publishPreparedGeneration(input) {
        const { candidate, target, runtime, reusable } = input;
        const previous = this.active.get(candidate.pluginId);
        if (previous) {
            if (reusable?.generation === previous)
                previous.runtime = undefined;
            this.addRetiring(previous, true);
        }
        this.active.set(candidate.pluginId, {
            candidate,
            view: target,
            leases: new Set(),
            accepting: Boolean(runtime),
            ...(runtime ? { runtime } : {}),
        });
        if (runtime && !reusable)
            this.observeRuntime(candidate.pluginId, runtime);
        if (runtime || !this.explicitlyStopped.has(candidate.pluginId)) {
            this.failures.delete(candidate.pluginId);
        }
        this.quarantined.delete(candidate.pluginId);
        this.disabled.delete(candidate.pluginId);
        this.cold.delete(candidate.pluginId);
        if (runtime)
            this.explicitlyStopped.delete(candidate.pluginId);
        return previous;
    }
    findReusableRuntime(candidate) {
        const generation = this.active.get(candidate.pluginId);
        if (!generation || !isReusableGeneration(generation, candidate))
            return undefined;
        return { generation, runtime: generation.runtime };
    }
    async acquire(input) {
        this.assertOpen();
        const leaseState = {
            disabled: this.disabled,
            quarantined: this.quarantined,
            quiescing: this.quiescing,
            explicitlyStopped: this.explicitlyStopped,
            active: this.active,
        };
        let generation = admitLease(leaseState, input);
        generation.idleTimer?.cancel();
        generation.idleTimer = undefined;
        const runtime = generation.accepting && generation.runtime
            ? generation.runtime
            : await this.ensureOnDemandRuntime(input.pluginId, generation);
        generation = admitRunningLease(leaseState, input, runtime);
        const leaseId = this.options.makeLeaseId?.() ?? randomUUID();
        generation.leases.add(leaseId);
        let released = false;
        return {
            release: async () => {
                if (released)
                    return false;
                released = true;
                generation.leases.delete(leaseId);
                await this.removeRetiredIfDrained(input.pluginId, generation);
                this.scheduleIdleDrain(input.pluginId, generation);
                return true;
            },
        };
    }
    assertCurrentRun(input) {
        return assertGenerationRunCurrent({
            active: this.active,
            pluginId: input.pluginId,
            runId: input.runId,
            unavailable: this.closed || this.disabled.has(input.pluginId) || this.quarantined.has(input.pluginId),
        });
    }
    launchCredential(pluginId) {
        if (this.closed || this.disabled.has(pluginId) || this.quarantined.has(pluginId)) {
            return undefined;
        }
        const generation = this.active.get(pluginId);
        const runtime = generation?.accepting ? generation.runtime : undefined;
        if (!runtime || generation?.view.processGeneration !== runtime.processGeneration) {
            return undefined;
        }
        return {
            processGeneration: runtime.processGeneration,
            origin: runtime.origin,
            loopbackToken: runtime.loopbackToken,
        };
    }
    prepareStop(pluginId, options = {}) {
        this.assertOpen();
        const existing = this.preparations.get(pluginId);
        const preparation = createSupervisorPreparation(options.signal);
        this.preparations.set(pluginId, preparation);
        preparation.promise = this.prepareStopAfterSuperseding(pluginId, options, preparation, existing);
        return preparation.promise;
    }
    async prepareStopAfterSuperseding(pluginId, options, preparation, existing) {
        if (existing) {
            existing.controller.abort(new MiniAppError('SUPERSEDED', 'Mini App transition was superseded'));
            try {
                const transition = await existing.promise;
                await transition.rollback();
            }
            catch (error) {
                if (!(error instanceof MiniAppError) || error.code !== 'SUPERSEDED') {
                    this.clearPreparation(pluginId, preparation);
                    throw error;
                }
            }
            finally {
                existing.unlinkSignal();
            }
        }
        return this.prepareStopOwned(pluginId, options, preparation);
    }
    async prepareStopOwned(pluginId, options, preparation) {
        let crossedPonr = false;
        let generation;
        try {
            this.assertCurrentPreparation(pluginId, preparation);
            if (this.quarantined.has(pluginId)) {
                throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
            }
            generation = requireActiveGeneration(this.active, pluginId);
            await this.cutover.settleStarting(pluginId, generation, preparation, () => {
                crossedPonr = true;
            });
            if (generation.runtime) {
                await this.cutover.prepare({
                    pluginId,
                    generation,
                    preparation,
                    deadlineMs: this.resolveDrainDeadline(options.deadlineMs),
                    validate: async () => undefined,
                    onPonr: () => {
                        crossedPonr = true;
                    },
                });
            }
            else {
                persistExplicitStartFence(this.options.stateStore, pluginId, this.nowMs());
                this.explicitlyStopped.add(pluginId);
                generation.accepting = false;
            }
            this.assertCurrentPreparation(pluginId, preparation);
        }
        catch (error) {
            this.clearPreparation(pluginId, preparation);
            if (crossedPonr && !errors.isMiniAppExpectedCancellation(errors.miniAppErrorCode(error))) {
                this.recordFailure(pluginId, errors.miniAppErrorCode(error));
            }
            throw error;
        }
        const target = generation.view;
        let state = 'prepared';
        return {
            pluginId,
            target,
            commit: async () => {
                if (state === 'committed')
                    return target;
                this.assertOpen();
                if (state === 'rolled-back') {
                    throw new MiniAppError('SUPERSEDED', 'Mini App stop was rolled back');
                }
                this.assertCurrentPreparation(pluginId, preparation);
                if (this.active.get(pluginId) !== generation || generation.runtime) {
                    throw new MiniAppError('SUPERSEDED', 'Mini App changed before stop commit');
                }
                state = 'committed';
                this.clearPreparation(pluginId, preparation);
                return target;
            },
            rollback: async () => {
                if (state === 'rolled-back')
                    return;
                state = 'rolled-back';
                this.clearPreparation(pluginId, preparation);
            },
            finalize: async () => undefined,
        };
    }
    async stop(pluginId, options = {}) {
        const transition = await this.prepareStop(pluginId, options);
        await transition.commit();
        await transition.finalize();
    }
    async prepareDisable(pluginId) {
        let state = 'prepared';
        const commitOwner = {};
        let previousGeneration;
        let previousAccepting = false;
        let previousState;
        let memorySnapshot;
        let finalized = false;
        return {
            pluginId,
            commit: () => {
                if (state === 'rolled-back') {
                    return Promise.reject(disableRolledBackError());
                }
                if (state === 'committed')
                    return Promise.resolve();
                if (commitOwner.promise)
                    return commitOwner.promise;
                return cleanup.startOwnedOperation(commitOwner, async () => {
                    this.assertOpen();
                    await this.cancelPreparation(pluginId, disablePreparationCancellation());
                    if (state !== 'prepared')
                        throw disableRolledBackError();
                    previousGeneration = this.active.get(pluginId);
                    previousAccepting = previousGeneration?.accepting ?? false;
                    previousState = this.options.stateStore.read(pluginId);
                    memorySnapshot = capturePublicationMemory(this.publicationMemory, pluginId);
                    try {
                        this.options.stateStore.remove(pluginId);
                    }
                    catch (cause) {
                        throw new MiniAppError('PERSISTENCE_WRITE_FAILED', 'Mini App disable state could not be persisted', { cause });
                    }
                    if (previousGeneration) {
                        this.active.delete(pluginId);
                        this.addRetiring(previousGeneration, true);
                    }
                    this.cold.delete(pluginId);
                    this.explicitlyStopped.delete(pluginId);
                    this.disabled.add(pluginId);
                    state = 'committed';
                });
            },
            rollback: async () => {
                if (commitOwner.promise)
                    await commitOwner.promise;
                if (state === 'prepared') {
                    state = 'rolled-back';
                    return;
                }
                if (state !== 'committed' || finalized || !memorySnapshot)
                    return;
                if (previousGeneration) {
                    removeRetiringGeneration(this.retiring, pluginId, previousGeneration);
                    previousGeneration.accepting = previousAccepting;
                    this.active.set(pluginId, previousGeneration);
                }
                restorePublicationMemory(this.publicationMemory, pluginId, memorySnapshot);
                this.restorePersistedState(pluginId, previousState);
                state = 'rolled-back';
            },
            finalize: async () => {
                if (state !== 'committed' || finalized)
                    return;
                finalized = true;
                if (!previousGeneration)
                    return;
                previousGeneration.retirementPendingFinalization = false;
                await this.removeRetiredIfDrained(pluginId, previousGeneration);
            },
        };
    }
    async disable(pluginId) {
        this.assertOpen();
        const disableReason = new MiniAppError('DISABLED', 'Mini App was disabled');
        const generation = this.active.get(pluginId);
        if (generation)
            generation.accepting = false;
        generation?.startController?.abort(disableReason);
        const settlement = await cleanup.settleDisableCleanup({
            preparation: this.cancelPreparation(pluginId, disableReason),
            startup: generation?.startPromise,
            cleanupGeneration: async () => {
                const current = this.active.get(pluginId) ?? generation;
                if (!current)
                    return;
                this.active.delete(pluginId);
                this.addRetiring(current);
                await this.removeRetiredIfDrained(pluginId, current);
            },
            timeoutMs: this.options.closeTimeoutMs ?? 5_000,
        });
        for (const timeout of settlement.timeouts)
            this.quarantineCleanupFailure(pluginId, timeout);
        const stateRemoval = await cleanup.captureOperation(() => this.options.stateStore.remove(pluginId));
        if (stateRemoval.status === 'fulfilled') {
            this.cold.delete(pluginId);
            this.explicitlyStopped.delete(pluginId);
            this.disabled.add(pluginId);
        }
        cleanup.throwPrioritizedCleanupFailure(settlement.proofResults, settlement.generationResults, [
            stateRemoval,
        ]);
    }
    canReusePreparedPackage(input) {
        const state = this.options.stateStore.read(input.pluginId);
        return Boolean(state &&
            state.acceptedSourceDigest === input.packageDigest &&
            state.clientDigest === input.clientDigest &&
            state.nodeDigest === input.nodeDigest &&
            persistedErrorDetail(state.lastErrorJson).code !== 'PERSISTENCE_COMPENSATION_FAILED');
    }
    inspect(pluginId) {
        const ids = pluginId
            ? [pluginId]
            : [
                ...new Set([
                    ...this.active.keys(),
                    ...this.retiring.keys(),
                    ...this.disabled,
                    ...this.cold,
                    ...this.preparations.keys(),
                    ...this.failures.keys(),
                    ...this.quarantined,
                    ...this.diagnostics.pluginIds(),
                ]),
            ];
        const statusState = {
            active: this.active,
            retiring: this.retiring,
            failures: this.failures,
            quarantined: this.quarantined,
            disabled: this.disabled,
            preparations: this.preparations,
            cold: this.cold,
        };
        return ids.map((id) => statusFor(statusState, this.diagnostics, id));
    }
    close() {
        this.closePromise ??= this.closeOwned();
        return this.closePromise;
    }
    async closeOwned() {
        this.closed = true;
        const closeReason = new MiniAppError('CLOSED', 'Mini App Supervisor is closed');
        const pendingPreparations = [...this.preparations.entries()];
        for (const [, preparation] of pendingPreparations) {
            preparation.controller.abort(closeReason);
        }
        const knownGenerations = new Set([
            ...this.active.values(),
            ...[...this.retiring.values()].flatMap((entries) => entries),
        ]);
        for (const generation of knownGenerations) {
            generation.idleTimer?.cancel();
            generation.startController?.abort(closeReason);
        }
        const settlement = await cleanup.settleSupervisorClose({
            preparations: pendingPreparations.map(([pluginId, preparation]) => ({
                pluginId,
                promise: preparation.promise,
            })),
            generations: [...knownGenerations],
            timeoutMs: this.options.closeTimeoutMs ?? 5_000,
            onPreparationFailure: (pluginId, error) => {
                if (!this.quarantineCleanupFailure(pluginId, error)) {
                    this.recordFailure(pluginId, errors.miniAppErrorCode(error));
                }
            },
        });
        if (settlement.timeout) {
            const pluginIds = new Set([
                ...pendingPreparations.map(([pluginId]) => pluginId),
                ...[...knownGenerations].map((generation) => generation.candidate.pluginId),
            ]);
            for (const pluginId of pluginIds) {
                this.quarantineCleanupFailure(pluginId, settlement.timeout);
            }
            throw settlement.timeout;
        }
        this.active.clear();
        this.retiring.clear();
        errors.assertMiniAppCleanupsProven(settlement.results);
        cleanup.throwUnexpectedCleanupFailure(settlement.results);
    }
    addRetiring(generation, pendingFinalization = false) {
        generation.accepting = false;
        generation.retirementPendingFinalization ||= pendingFinalization;
        generation.idleTimer?.cancel();
        generation.idleTimer = undefined;
        const entries = this.retiring.get(generation.candidate.pluginId) ?? [];
        entries.push(generation);
        this.retiring.set(generation.candidate.pluginId, entries);
    }
    removeRetiredIfDrained(pluginId, generation) {
        if (generation.leases.size !== 0)
            return Promise.resolve();
        if (generation.retirementPendingFinalization)
            return Promise.resolve();
        if (!(this.retiring.get(pluginId) ?? []).includes(generation))
            return Promise.resolve();
        generation.retirementPromise ??= this.cleanupRetiredGeneration(pluginId, generation);
        return generation.retirementPromise;
    }
    async cleanupRetiredGeneration(pluginId, generation) {
        try {
            await generation.idleStopPromise;
            await cleanup.cleanupRuntime(generation.runtime);
        }
        catch (error) {
            if (!errors.isMiniAppCleanupUnproven(error) && errors.isMiniAppRootTerminationProven(error)) {
                generation.runtime = undefined;
                generation.view = publishedView(generation.candidate, generation.view.miniAppGeneration, undefined);
                removeRetiringGeneration(this.retiring, pluginId, generation);
            }
            if (!this.quarantineCleanupFailure(pluginId, error)) {
                this.recordFailure(pluginId, errors.miniAppErrorCode(error));
            }
            throw error;
        }
        removeRetiringGeneration(this.retiring, pluginId, generation);
    }
    async ensureOnDemandRuntime(pluginId, generation) {
        if (generation.idleStopPromise)
            await generation.idleStopPromise;
        if (this.quarantined.has(pluginId)) {
            throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
        }
        if (generation.runtime)
            return generation.runtime;
        if (generation.startPromise)
            return generation.startPromise;
        const candidate = generation.candidate;
        const controller = new AbortController();
        generation.startController = controller;
        const operation = this.startOnDemandRuntime(pluginId, generation, candidate, controller);
        generation.startPromise = operation;
        const clear = () => {
            if (generation.startPromise === operation) {
                generation.startPromise = undefined;
                generation.startController = undefined;
            }
        };
        this.trackSettlement(operation, clear);
        return operation;
    }
    async startOnDemandRuntime(pluginId, generation, candidate, controller) {
        let runtime;
        let acceptanceAttempted = false;
        try {
            if (!(await this.options.verifyCandidate(candidate))) {
                throw new MiniAppError('CANDIDATE_CHANGED', 'Mini App candidate changed before start');
            }
            runtime = await this.diagnostics.prepare({
                candidate,
                processGeneration: this.makeProcessGeneration(),
                preferredPort: this.options.stateStore.read(pluginId)?.preferredPort,
                signal: controller.signal,
            }, generation.view.miniAppGeneration);
            this.assertGenerationCurrent(pluginId, generation, controller);
            if (!(await this.options.verifyCandidate(candidate))) {
                throw new MiniAppError('CANDIDATE_CHANGED', 'Mini App candidate changed during start');
            }
            this.assertGenerationCurrent(pluginId, generation, controller);
            acceptanceAttempted = true;
            await cleanup.acceptAndAdmitRuntime({
                accept: () => this.acceptPreparedRuntime(candidate, runtime, true),
                retirementOwners: () => this.retiring.get(pluginId) ?? [],
                isQuarantined: () => this.quarantined.has(pluginId),
                assertCurrent: () => this.assertGenerationCurrent(pluginId, generation, controller),
                admit: () => {
                    generation.runtime = runtime;
                    generation.view = publishedView(candidate, generation.view.miniAppGeneration, runtime);
                    generation.accepting = true;
                },
                shouldCompensate: () => this.active.get(pluginId) === generation,
                cleanup: () => this.cleanupOrQuarantine(pluginId, runtime),
            });
            this.failures.delete(pluginId);
            this.observeRuntime(pluginId, runtime);
            return runtime;
        }
        catch (error) {
            const failure = acceptanceAttempted
                ? error
                : await cleanup.selectFailureAfterCleanup(error, () => this.cleanupOrQuarantine(pluginId, runtime));
            const quarantined = this.quarantineCleanupFailure(pluginId, failure);
            const code = errors.miniAppErrorCode(failure);
            if (!quarantined && !errors.isMiniAppExpectedCancellation(code)) {
                this.recordFailure(pluginId, code, !acceptanceAttempted);
            }
            throw errors.normalizeMiniAppRuntimeError(failure, 'Mini App startup failed');
        }
    }
    scheduleIdleDrain(pluginId, generation) {
        if (this.active.get(pluginId) !== generation ||
            generation.leases.size !== 0 ||
            !generation.runtime ||
            generation.idleTimer ||
            generation.idleStopPromise) {
            return;
        }
        const schedule = this.options.scheduleIdle ?? scheduleTimeout;
        generation.idleTimer = schedule(this.options.idleTimeoutMs ?? 30_000, () => {
            generation.idleTimer = undefined;
            const operation = this.drainIdleRuntime(pluginId, generation);
            generation.idleStopPromise = operation;
            const clear = () => {
                if (generation.idleStopPromise === operation)
                    generation.idleStopPromise = undefined;
            };
            this.trackSettlement(operation, clear);
        });
    }
    async drainIdleRuntime(pluginId, generation) {
        const runtime = generation.runtime;
        if (!runtime || this.active.get(pluginId) !== generation || generation.leases.size !== 0) {
            return;
        }
        const clearProvenRuntime = () => {
            if (generation.runtime !== runtime)
                return;
            generation.runtime = undefined;
            generation.view = publishedView(generation.candidate, generation.view.miniAppGeneration, undefined);
        };
        generation.accepting = false;
        try {
            await cleanup.cleanupRuntime(runtime);
            clearProvenRuntime();
        }
        catch (error) {
            if (!errors.isMiniAppCleanupUnproven(error) && errors.isMiniAppRootTerminationProven(error)) {
                clearProvenRuntime();
            }
            if (!this.quarantineCleanupFailure(pluginId, error)) {
                this.recordFailure(pluginId, errors.miniAppErrorCode(error));
            }
            throw error;
        }
    }
    recordFailure(pluginId, code, persist = true) {
        this.failures.set(pluginId, code);
        if (!persist)
            return;
        try {
            const state = this.options.stateStore.read(pluginId);
            if (!state)
                return;
            this.options.stateStore.write({
                ...state,
                lastErrorJson: this.explicitlyStopped.has(pluginId)
                    ? explicitStartRequiredJson(state.lastErrorJson, code)
                    : JSON.stringify({ code }),
                updatedAtMs: Math.max(this.nowMs(), state.updatedAtMs),
            });
        }
        catch {
            // Runtime failure identity remains observable in memory when persistence is unavailable.
        }
    }
    restorePersistedState(pluginId, previous) {
        restorePublicationPersistence({
            stateStore: this.options.stateStore,
            pluginId,
            previous: previous && this.explicitlyStopped.has(pluginId)
                ? {
                    ...previous,
                    lastErrorJson: explicitStartRequiredJson(previous.lastErrorJson),
                }
                : previous,
            onFailure: (failure) => {
                this.quarantined.add(pluginId);
                this.recordFailure(pluginId, failure.code);
            },
        });
    }
    async cancelPreparation(pluginId, reason) {
        const preparation = this.preparations.get(pluginId);
        if (!preparation)
            return;
        preparation.controller.abort(reason);
        try {
            await cleanup.settlePreparedTransitionCleanup(preparation.promise, this.options.closeTimeoutMs ?? 5_000);
        }
        catch (error) {
            if (!errors.isMiniAppCleanupUnproven(error)) {
                this.recordFailure(pluginId, errors.miniAppErrorCode(error));
                throw error;
            }
            this.clearPreparation(pluginId, preparation);
            this.quarantineCleanupFailure(pluginId, error);
            throw error;
        }
    }
    assertGenerationCurrent(pluginId, generation, controller) {
        if (!controller.signal.aborted && !this.closed && this.active.get(pluginId) === generation) {
            return;
        }
        throw errors.cancellationOrSupersededError(controller.signal, 'Mini App runtime operation was superseded');
    }
    trackSettlement(operation, clear) {
        const observed = cleanup.clearAfterSettlement(operation, () => {
            clear();
            this.observations.delete(observed);
        });
        this.observations.add(observed);
    }
    async verifyCandidate(candidate, message) {
        if (!(await this.options.verifyCandidate(candidate))) {
            throw new MiniAppError('CANDIDATE_CHANGED', message);
        }
    }
    nowMs() {
        return this.options.nowMs?.() ?? Date.now();
    }
    makeMiniAppGeneration() {
        return this.options.makeMiniAppGeneration?.() ?? randomUUID();
    }
    makeProcessGeneration() {
        return this.options.makeProcessGeneration?.() ?? randomUUID();
    }
    observeRuntime(pluginId, runtime) {
        this.trackSettlement(this.handleRuntimeExit(pluginId, runtime), () => undefined);
    }
    async handleRuntimeExit(pluginId, runtime) {
        const terminal = await cleanup.captureOperation(() => runtime.closed);
        if (terminal.status === 'rejected') {
            const generation = this.active.get(pluginId);
            if (this.closed || generation?.runtime !== runtime)
                return;
            generation.accepting = false;
            await this.cleanupExitedRuntime(pluginId, runtime, terminal.reason);
            return;
        }
        const exit = terminal.value;
        if (exit.shutdownRequested || this.closed)
            return;
        const generation = this.active.get(pluginId);
        if (generation?.runtime !== runtime)
            return;
        generation.accepting = false;
        this.recordFailure(pluginId, 'RUNTIME_EXITED');
        generation.runtime = undefined;
        generation.view = publishedView(generation.candidate, generation.view.miniAppGeneration, undefined);
        await this.cleanupExitedRuntime(pluginId, runtime);
    }
    async cleanupExitedRuntime(pluginId, runtime, terminalFailure) {
        for (const error of await cleanup.collectRuntimeCleanupFailures(runtime, terminalFailure)) {
            if (!this.quarantineCleanupFailure(pluginId, error)) {
                this.recordFailure(pluginId, errors.miniAppErrorCode(error));
            }
        }
    }
    assertCurrentPreparation(pluginId, preparation) {
        if (this.preparations.get(pluginId) === preparation && !preparation.controller.signal.aborted) {
            return;
        }
        throw errors.cancellationOrSupersededError(preparation.controller.signal, 'Mini App transition was superseded');
    }
    resolveDrainDeadline(deadlineMs) {
        return deadlineMs ?? Date.now() + (this.options.closeTimeoutMs ?? 5_000);
    }
    clearPreparation(pluginId, preparation) {
        if (this.preparations.get(pluginId) !== preparation)
            return;
        this.preparations.delete(pluginId);
        preparation.unlinkSignal();
    }
    assertOpen() {
        if (this.closed)
            throw new MiniAppError('CLOSED', 'Mini App Supervisor is closed');
    }
}
//# sourceMappingURL=supervisor.js.map