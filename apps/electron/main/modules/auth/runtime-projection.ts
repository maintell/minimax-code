import { requiresInteractiveLogin, assertSameLoginEpoch } from "@mavis/oauth-core";
import { setLocalRuntimeAuthContext } from "../local-runtime";
import { DesktopAccountIdentityUnauthorizedError } from "./account-identity.js";
const activeRuntimeRecoveries = new WeakMap();
let projectionTail = Promise.resolve();
function serializeProjection(operation) {
    const pending = projectionTail.catch(() => undefined).then(operation);
    projectionTail = pending.catch(() => undefined);
    return pending;
}
export async function projectSharedAccessTokenLeaseToRuntime(session, lease) {
    await synchronizeProjection(session, lease);
}
function synchronizeProjection(session, observedLease) {
    return serializeProjection(async () => {
        try {
            let lease = observedLease;
            let recoveredUnauthorized = false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                // Queued callbacks and account HTTP responses can outlive a shared login.
                lease = await session.getAccessToken(0);
                let identity;
                try {
                    identity = (await session.resolveRuntimeIdentity?.(lease)) ?? {};
                }
                catch (error) {
                    if (error instanceof DesktopAccountIdentityUnauthorizedError &&
                        !recoveredUnauthorized &&
                        session.handleUnauthorized) {
                        recoveredUnauthorized = true;
                        await session.handleUnauthorized(lease.generation, lease.loginEpoch);
                        continue;
                    }
                    throw error;
                }
                const current = await session.getAccessToken(0);
                if (current.generation !== lease.generation || current.accessToken !== lease.accessToken) {
                    continue;
                }
                session.applyRuntimeIdentity?.(identity);
                await setLocalRuntimeAuthContext({
                    accessToken: lease.accessToken,
                    expiresAtMs: lease.expiresAtMs,
                    loginEpoch: lease.loginEpoch,
                    ...identity,
                }, { prepare: false, persistence: 'memory-only' });
                return { lease, identity };
            }
            throw new Error('Desktop account changed while resolving its identity. Please retry.');
        }
        catch (error) {
            await setLocalRuntimeAuthContext({}, { prepare: false, persistence: 'memory-only' });
            throw error;
        }
    });
}
export async function refreshSharedRuntimeProjection(session, options = {}) {
    let lease;
    try {
        lease = await session.getAccessToken(30000);
    }
    catch (error) {
        if (!options.allowAnonymous || !requiresInteractiveLogin(error))
            throw error;
        await clearSharedRuntimeProjection();
        return undefined;
    }
    try {
        return (await synchronizeProjection(session, lease)).lease;
    }
    catch (error) {
        if (options.allowAnonymous && requiresInteractiveLogin(error))
            return undefined;
        throw error;
    }
}
export function recoverSharedRuntimeProjection(session, rejectedAccessToken, loginEpoch) {
    const normalizedRejectedToken = rejectedAccessToken.trim();
    const active = activeRuntimeRecoveries.get(session);
    if (active) {
        if (active.rejectedAccessToken === normalizedRejectedToken && active.loginEpoch === loginEpoch)
            return active.promise;
        return active.promise.then(() => recoverSharedRuntimeProjection(session, normalizedRejectedToken, loginEpoch));
    }
    const recovery = runSharedRuntimeRecovery(session, normalizedRejectedToken, loginEpoch).finally(() => {
        if (activeRuntimeRecoveries.get(session)?.promise === recovery) {
            activeRuntimeRecoveries.delete(session);
        }
    });
    activeRuntimeRecoveries.set(session, {
        rejectedAccessToken: normalizedRejectedToken,
        loginEpoch,
        promise: recovery,
    });
    return recovery;
}
async function runSharedRuntimeRecovery(session, rejectedAccessToken, loginEpoch) {
    let lease = await session.getAccessToken(0);
    const requestEpoch = loginEpoch ?? (lease.accessToken === rejectedAccessToken ? lease.loginEpoch : undefined);
    assertSameLoginEpoch(requestEpoch, lease.loginEpoch);
    if (lease.accessToken === rejectedAccessToken.trim()) {
        const action = await session.handleUnauthorized(lease.generation, requestEpoch);
        if (action !== 'retry') {
            try {
                lease = await session.getAccessToken(30000);
            }
            catch (error) {
                if (!requiresInteractiveLogin(error))
                    throw error;
                await clearSharedRuntimeProjection();
                return undefined;
            }
        }
        else {
            lease = await session.getAccessToken(30000);
        }
    }
    assertSameLoginEpoch(requestEpoch, lease.loginEpoch);
    const projected = await synchronizeProjection(session, lease);
    assertSameLoginEpoch(requestEpoch, projected.lease.loginEpoch);
    return {
        accessToken: projected.lease.accessToken,
        loginEpoch: projected.lease.loginEpoch,
        ...projected.identity,
    };
}
export async function clearSharedRuntimeProjection() {
    await serializeProjection(() => setLocalRuntimeAuthContext({}, { prepare: false, persistence: 'memory-only' }));
}
export function watchSharedRuntimeProjection(session) {
    let revision = 0;
    let stopped = false;
    let mutationTail = Promise.resolve();
    const enqueueMutation = (eventRevision, mutation) => {
        mutationTail = mutationTail
            .catch(() => undefined)
            .then(async () => {
            if (stopped || eventRevision !== revision)
                return;
            await mutation();
        })
            .catch(() => undefined);
    };
    const unsubscribe = session.watch((status) => {
        if (status.status === 'refreshing' || status.status === 'expired')
            return;
        const eventRevision = ++revision;
        if (status.status !== 'authenticated') {
            enqueueMutation(eventRevision, clearSharedRuntimeProjection);
            return;
        }
        // Notifications project the current lease; requests own proactive renewal.
        void session.getAccessToken(0).then((lease) => {
            enqueueMutation(eventRevision, async () => {
                if (lease.generation < status.generation)
                    return;
                await projectSharedAccessTokenLeaseToRuntime(session, lease);
            });
        }, (error) => {
            if (requiresInteractiveLogin(error)) {
                enqueueMutation(eventRevision, clearSharedRuntimeProjection);
            }
        });
    });
    return () => {
        if (stopped)
            return;
        stopped = true;
        revision += 1;
        unsubscribe();
    };
}
