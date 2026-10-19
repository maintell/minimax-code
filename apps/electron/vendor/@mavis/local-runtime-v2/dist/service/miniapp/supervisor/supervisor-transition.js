import * as cleanup from './cleanup-settlement.js';
import * as errors from '../errors.js';
import { MiniAppError } from '../errors.js';
const EXPLICIT_START_REQUIRED_FIELD = 'requiresExplicitStart';
/** Cold startup cannot take custody from a running, starting, or retiring generation. */
export function assertColdStartupAvailable(current, runtimeOwners) {
    if (current?.startPromise || current?.idleStopPromise || runtimeOwners.length > 0) {
        throw new MiniAppError('BUSY', 'MiniApp start cannot replace an owned runtime', {
            busyReason: 'operation_busy',
        });
    }
}
export function createSupervisorPreparation(signal) {
    const controller = new AbortController();
    if (!signal) {
        return {
            controller,
            unlinkSignal: () => undefined,
            promise: Promise.resolve(undefined),
        };
    }
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted)
        abort();
    else
        signal.addEventListener('abort', abort, { once: true });
    return {
        controller,
        unlinkSignal: () => signal.removeEventListener('abort', abort),
        promise: Promise.resolve(undefined),
    };
}
export function disablePreparationCancellation() {
    return new MiniAppError('DISABLED', 'Mini App was disabled during preparation');
}
export function disableRolledBackError() {
    return new MiniAppError('SUPERSEDED', 'Mini App disable was rolled back');
}
export function restorePublicationPersistence(input) {
    cleanup.restoreRuntimePersistence({
        previous: input.previous,
        write: (state) => input.stateStore.write(state),
        remove: () => input.stateStore.remove(input.pluginId),
        onFailure: input.onFailure,
    });
}
export function capturePublicationMemory(collections, pluginId) {
    return {
        disabled: collections.disabled.has(pluginId),
        cold: collections.cold.has(pluginId),
        quarantined: collections.quarantined.has(pluginId),
        failureCode: collections.failures.get(pluginId),
        explicitlyStopped: collections.explicitlyStopped.has(pluginId),
    };
}
export function restorePublicationMemory(collections, pluginId, snapshot) {
    restoreSetMembership(collections.disabled, pluginId, snapshot.disabled);
    restoreSetMembership(collections.cold, pluginId, snapshot.cold);
    restoreSetMembership(collections.quarantined, pluginId, snapshot.quarantined);
    restoreMapValue(collections.failures, pluginId, snapshot.failureCode);
    restoreSetMembership(collections.explicitlyStopped, pluginId, snapshot.explicitlyStopped);
}
export function persistedErrorDetail(value) {
    if (!value)
        return { requiresExplicitStart: false };
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { requiresExplicitStart: false };
        }
        const detail = parsed;
        return {
            ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
            requiresExplicitStart: detail[EXPLICIT_START_REQUIRED_FIELD] === true,
        };
    }
    catch {
        return { requiresExplicitStart: false };
    }
}
export function explicitStartRequiredJson(previous, code) {
    const nextCode = code ?? persistedErrorDetail(previous).code;
    return JSON.stringify({
        ...(nextCode ? { code: nextCode } : {}),
        [EXPLICIT_START_REQUIRED_FIELD]: true,
    });
}
export function persistExplicitStartFence(stateStore, pluginId, nowMs) {
    try {
        const state = stateStore.read(pluginId);
        if (!state)
            throw new Error('Mini App accepted state is missing');
        stateStore.write({
            ...state,
            lastErrorJson: explicitStartRequiredJson(state.lastErrorJson),
            updatedAtMs: Math.max(nowMs, state.updatedAtMs),
        });
    }
    catch (cause) {
        throw new MiniAppError('PERSISTENCE_WRITE_FAILED', 'Mini App explicit-start fence could not be persisted', { cause });
    }
}
export async function rollbackCommittedGeneration(input) {
    if (input.active.get(input.pluginId) !== input.committedGeneration) {
        throw new MiniAppError('SUPERSEDED', 'Mini App generation changed before publication rollback');
    }
    if (input.committedGeneration.leases.size !== 0) {
        throw new MiniAppError('SUPERSEDED', 'Mini App generation leases must be released before publication rollback');
    }
    input.committedGeneration.accepting = false;
    input.committedGeneration.idleTimer?.cancel();
    input.committedGeneration.idleTimer = undefined;
    if (input.previousGeneration) {
        removeRetiringGeneration(input.retiring, input.pluginId, input.previousGeneration);
        input.previousGeneration.accepting = input.previousAccepting;
        input.active.set(input.pluginId, input.previousGeneration);
    }
    else {
        input.active.delete(input.pluginId);
    }
    if (input.previousGeneration &&
        input.previousGeneration === input.reusableGeneration &&
        input.runtimeWasReused) {
        input.previousGeneration.runtime = input.committedGeneration.runtime;
    }
    input.restoreMemory();
    const persistence = await cleanup.captureOperation(input.persistenceCompensation);
    const runtimeCleanup = await cleanup.captureOperation(() => input.cleanupRuntime(input.runtimeWasReused ? undefined : input.committedGeneration.runtime));
    errors.assertMiniAppCleanupsProven([runtimeCleanup]);
    if (persistence.status === 'rejected')
        throw persistence.reason;
    if (runtimeCleanup.status === 'rejected')
        throw runtimeCleanup.reason;
}
export function removeRetiringGeneration(retiring, pluginId, generation) {
    generation.retirementPendingFinalization = false;
    const remaining = (retiring.get(pluginId) ?? []).filter((entry) => entry !== generation);
    if (remaining.length === 0)
        retiring.delete(pluginId);
    else
        retiring.set(pluginId, remaining);
}
function restoreSetMembership(set, value, present) {
    if (present)
        set.add(value);
    else
        set.delete(value);
}
function restoreMapValue(map, key, value) {
    if (value === undefined)
        map.delete(key);
    else
        map.set(key, value);
}
//# sourceMappingURL=supervisor-transition.js.map