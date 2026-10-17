import { assertMiniAppCleanupsProven, isMiniAppCleanupUnproven, MiniAppCleanupUnprovenError, MiniAppError, } from '../errors.js';
async function settleCleanupOperations(operations, timeoutMs, timeoutMessage) {
    const settlement = Promise.allSettled(operations);
    if (await settleWithin(settlement, timeoutMs))
        return { results: await settlement };
    const timeout = new MiniAppCleanupUnprovenError(timeoutMessage, {
        cause: new Error('Mini App cleanup settlement timed out'),
    });
    return { results: [{ status: 'rejected', reason: timeout }], timeout };
}
export async function settleDisableCleanup(input) {
    const lifecycle = await settleCleanupOperations([
        input.preparation,
        ...(input.restart ? [input.restart] : []),
        ...(input.delegation ? [input.delegation] : []),
    ], input.timeoutMs, 'Mini App lifecycle cleanup did not settle before disable');
    const startup = input.startup
        ? await settleCleanupOperations([input.startup], input.timeoutMs, 'Mini App startup cleanup did not settle before disable')
        : { results: [] };
    const generationResults = input.cleanupGeneration
        ? await Promise.allSettled([input.cleanupGeneration()])
        : [];
    return {
        proofResults: [...lifecycle.results, ...startup.results],
        generationResults,
        timeouts: [lifecycle.timeout, startup.timeout].filter((error) => Boolean(error)),
    };
}
export async function captureOperation(operation) {
    try {
        return { status: 'fulfilled', value: await operation() };
    }
    catch (reason) {
        return { status: 'rejected', reason };
    }
}
export function startOwnedOperation(owner, operation) {
    let resolveOwned = () => undefined;
    let rejectOwned = () => undefined;
    const promise = new Promise((resolve, reject) => {
        resolveOwned = resolve;
        rejectOwned = reject;
    });
    owner.promise = promise;
    owner.observation = settleOwnedOperation(operation, resolveOwned, rejectOwned);
    return promise;
}
async function settleOwnedOperation(operation, resolve, reject) {
    try {
        resolve(await operation());
    }
    catch (reason) {
        reject(reason);
    }
}
async function throwPrimaryAfterCleanup(primary, cleanupOperation, compensationOperation) {
    throw await selectFailureAfterCleanup(primary, cleanupOperation, compensationOperation);
}
export async function selectFailureAfterCleanup(primary, cleanupOperation, compensationOperation) {
    const compensationResult = compensationOperation
        ? await captureOperation(compensationOperation)
        : undefined;
    const cleanupResult = await captureOperation(cleanupOperation);
    if (cleanupResult.status === 'rejected' && isMiniAppCleanupUnproven(cleanupResult.reason)) {
        return cleanupResult.reason;
    }
    if (compensationResult?.status === 'rejected')
        return compensationResult.reason;
    return primary;
}
export async function acceptAndAdmitRuntime(input) {
    const compensate = await input.accept();
    try {
        await settleRetirementOwners(input.retirementOwners?.() ?? []);
        if (input.isQuarantined?.()) {
            throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
        }
        input.assertCurrent();
        input.admit();
    }
    catch (primary) {
        await throwPrimaryAfterCleanup(primary, input.cleanup, input.shouldCompensate() ? compensate : undefined);
    }
    return compensate;
}
export async function acceptRuntimePersistence(input) {
    if (input.quarantined) {
        await throwPrimaryAfterCleanup(new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven'), input.cleanup);
    }
    let previous;
    let previousRead = false;
    try {
        previous = input.readPrevious();
        previousRead = true;
        input.writeAccepted(previous);
    }
    catch (cause) {
        await throwPrimaryAfterCleanup(new MiniAppError('PERSISTENCE_WRITE_FAILED', 'Mini App acceptance state could not be persisted', { cause }), input.cleanup, previousRead ? () => input.restore(previous) : undefined);
    }
    try {
        input.activate?.();
    }
    catch (cause) {
        await throwPrimaryAfterCleanup(new MiniAppError('ACTIVATION_FAILED', 'Mini App Host Connector activation failed', {
            cause,
        }), input.cleanup, () => input.restore(previous));
    }
    let compensated = false;
    return () => {
        if (compensated)
            return;
        compensated = true;
        input.restore(previous);
    };
}
export function restoreRuntimePersistence(input) {
    try {
        if (input.previous)
            input.write(input.previous);
        else
            input.remove();
    }
    catch (cause) {
        const failure = new MiniAppError('PERSISTENCE_COMPENSATION_FAILED', 'Mini App acceptance state could not be restored', { cause });
        input.onFailure(failure);
        throw failure;
    }
}
async function settleRetirementOwners(owners) {
    await Promise.all(owners.flatMap((owner) => (owner.retirementPromise ? [owner.retirementPromise] : [])));
}
export async function cleanupRuntime(runtime) {
    if (!runtime)
        return;
    const result = await runtime.stop();
    if (!result.proven) {
        throw new MiniAppCleanupUnprovenError('Mini App direct Node root termination could not be proven');
    }
}
export async function collectRuntimeCleanupFailures(runtime, terminalFailure) {
    const cleanupResult = await captureOperation(() => cleanupRuntime(runtime));
    return [
        ...(cleanupResult.status === 'rejected' ? [cleanupResult.reason] : []),
        ...(terminalFailure ? [terminalFailure] : []),
    ];
}
export async function settlePreparedTransitionCleanup(preparation, timeoutMs) {
    const settlement = await settleCleanupOperations([cleanupPreparedTransition(preparation)], timeoutMs, 'Mini App preparation cleanup did not settle in time');
    if (settlement.timeout)
        throw settlement.timeout;
    const [result] = settlement.results;
    if (result?.status === 'rejected')
        throw result.reason;
}
async function cleanupPreparedTransition(preparation) {
    try {
        const transition = await preparation;
        await transition.rollback();
    }
    catch (error) {
        if (!isExpectedCancellation(error))
            throw error;
    }
}
export function settleSupervisorClose(input) {
    return settleCleanupOperations([
        ...input.preparations.map(({ pluginId, promise }) => cleanupClosePreparation(pluginId, promise, input.onPreparationFailure)),
        ...input.generations.map(cleanupCloseGeneration),
    ], input.timeoutMs, 'Mini App cleanup did not settle before close');
}
async function cleanupClosePreparation(pluginId, preparation, onFailure) {
    try {
        await cleanupPreparedTransition(preparation);
    }
    catch (error) {
        onFailure(pluginId, error);
        throw error;
    }
}
async function cleanupCloseGeneration(generation) {
    const lifecycleResults = await Promise.allSettled([generation.startPromise, generation.retirementPromise, generation.idleStopPromise].filter((operation) => Boolean(operation)));
    const runtimeCleanup = await captureOperation(() => cleanupRuntime(generation.runtime));
    const results = [...lifecycleResults, runtimeCleanup];
    assertMiniAppCleanupsProven(results);
    throwUnexpectedCleanupFailure(results);
}
function throwFirstRejected(results) {
    const failure = results.find((result) => result.status === 'rejected');
    if (failure)
        throw failure.reason;
}
export function throwUnexpectedCleanupFailure(results) {
    const failure = results.find((result) => result.status === 'rejected' && !isExpectedCancellation(result.reason));
    if (failure)
        throw failure.reason;
}
export function throwPrioritizedCleanupFailure(proofResults, ordinaryResults, trailingResults) {
    assertMiniAppCleanupsProven([...proofResults, ...ordinaryResults]);
    throwFirstRejected(ordinaryResults);
    throwUnexpectedCleanupFailure(proofResults);
    throwFirstRejected(trailingResults);
}
export async function ignoreRejected(operation) {
    if (!operation)
        return;
    try {
        await operation;
    }
    catch {
        // The operation owner records its typed failure.
    }
}
export async function clearAfterSettlement(operation, clear) {
    try {
        await operation;
    }
    catch {
        // The original operation remains the caller-visible rejection.
    }
    finally {
        clear();
    }
}
async function settleWithin(operation, timeoutMs) {
    let timer;
    const settled = await Promise.race([
        resolvesTrue(operation),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
            timer.unref();
        }),
    ]);
    if (timer)
        clearTimeout(timer);
    return settled;
}
async function resolvesTrue(operation) {
    await operation;
    return true;
}
function isExpectedCancellation(error) {
    return (error instanceof MiniAppError &&
        (error.code === 'CLOSED' || error.code === 'DISABLED' || error.code === 'SUPERSEDED'));
}
//# sourceMappingURL=cleanup-settlement.js.map