import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AUTH_LEASE_AUDIENCE, AUTH_LEASE_PROTOCOL_VERSION, AUTH_LEASE_SCOPES, AuthLeaseProtocolError, startNodeAuthLeaseServer, } from '@mavis/oauth-lease-protocol';
import { allocateBrokerEndpoint } from './broker-endpoint.js';
import { authFailureFields } from './auth-failure.js';
const NOOP_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
};
export async function startMcodeToolsAuthLeaseBroker(options) {
    const endpoint = await allocateBrokerEndpoint(options.dataDir, process.platform, options.isolateInstance);
    const capability = randomBytes(32).toString('base64url');
    const now = options.now ?? Date.now;
    const brokerLogger = options.logger ?? NOOP_LOGGER;
    let cachedLease;
    let inFlight;
    let epoch = 0;
    let minimumGeneration = 0;
    let pendingGeneration;
    let statusRevision = 0;
    const waitTimeoutMs = options.leaseWaitTimeoutMs ?? 25_000;
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0 || waitTimeoutMs > 25_000)
        throw new TypeError('Invalid auth lease wait timeout.');
    let admissionOpen = true;
    let disposed = false;
    let server;
    let stopWatching;
    function invalidate() {
        epoch += 1;
        cachedLease = undefined;
    }
    async function loadValidatedLease(minValidityMs, requestEpoch) {
        const lease = await loadLease(options.session, minValidityMs);
        assertFixedLease(lease);
        if (lease.generation < (pendingGeneration ?? 0)) {
            const revision = statusRevision;
            const status = await options.session.getStatus();
            assertRequestCurrent(requestEpoch);
            if (revision === statusRevision) {
                if (isSignedOut(status.status))
                    throw new AuthLeaseProtocolError('AUTH_REQUIRED');
                if (status.status === 'authenticated' && status.generation === lease.generation) {
                    pendingGeneration = undefined;
                }
            }
        }
        assertLeaseCurrent(lease, requestEpoch);
        cachedLease = lease;
        return lease;
    }
    function assertLeaseCurrent(lease, requestEpoch) {
        assertRequestCurrent(requestEpoch);
        if (lease.generation < minimumGeneration)
            throw new AuthLeaseProtocolError('AUTH_REQUIRED');
        if (lease.generation < (pendingGeneration ?? 0))
            throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    }
    function assertRequestCurrent(requestEpoch) {
        if (disposed)
            throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
        if (requestEpoch !== epoch || !admissionOpen) {
            throw new AuthLeaseProtocolError('AUTH_REQUIRED');
        }
    }
    async function acquireLease(minValidityMs) {
        const requestEpoch = epoch;
        const deadline = performance.now() + waitTimeoutMs;
        const remaining = () => Math.max(0, deadline - performance.now());
        assertRequestCurrent(requestEpoch);
        if (cachedLease &&
            !inFlight &&
            admissionOpen &&
            cachedLease.generation >= minimumGeneration &&
            cachedLease.generation >= (pendingGeneration ?? 0) &&
            isUsableLease(cachedLease, minValidityMs, now())) {
            const candidate = cachedLease;
            // A different process may have reserved/committed a refresh before the
            // polling watch runs. Never let the memory cache bypass that shared fence.
            const status = await waitForLease(options.session.getStatus(), remaining());
            assertRequestCurrent(requestEpoch);
            if (!inFlight &&
                cachedLease === candidate &&
                status.status === 'authenticated' &&
                status.generation === candidate.generation &&
                isUsableLease(candidate, minValidityMs, now()))
                return candidate;
            cachedLease = undefined;
        }
        // A lower-validity request may return an existing token without refreshing.
        // Its stricter waiter gets one bounded acquisition at its own requirement;
        // a response already requested at that requirement must never loop/rotate again.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (remaining() <= 0)
                throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
            const current = getOrStartLeaseRequest(minValidityMs);
            const lease = await waitForLease(current.promise, remaining());
            assertRequestCurrent(requestEpoch);
            // Watch notifications may invalidate a validated grant before its waiter
            // resumes. Check the original epoch as well as the current admission floor.
            assertLeaseCurrent(lease, current.epoch);
            if (isUsableLease(lease, minValidityMs, now()))
                return lease;
            if (current.minValidityMs >= minValidityMs)
                break;
        }
        throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    }
    function getOrStartLeaseRequest(minValidityMs) {
        if (inFlight)
            return inFlight;
        cachedLease = undefined;
        const requestEpoch = epoch;
        const request = loadValidatedLease(minValidityMs, requestEpoch);
        const current = { epoch: requestEpoch, minValidityMs, promise: request };
        inFlight = current;
        void request
            .finally(() => {
            if (inFlight === current)
                inFlight = undefined;
        })
            .catch(() => undefined);
        return current;
    }
    async function handleRequest(request) {
        if (disposed)
            throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
        if (request.method === 'status')
            return await getCredentialFreeStatus(options.session);
        if (request.method === 'lease') {
            const lease = await acquireLease(request.minValidityMs);
            return {
                method: 'lease',
                accessToken: lease.accessToken,
                expiresAtMs: lease.expiresAtMs,
                generation: lease.generation,
                audience: AUTH_LEASE_AUDIENCE,
                scopes: AUTH_LEASE_SCOPES,
            };
        }
        invalidate();
        const action = await options.session.handleUnauthorized(request.generation);
        return { method: 'unauthorized', action };
    }
    try {
        await atomicWriteCapability(endpoint.capabilityFile, capability);
    }
    catch (error) {
        await endpoint.cleanup();
        throw error;
    }
    try {
        server = await startNodeAuthLeaseServer({
            endpoint: endpoint.endpoint,
            capability,
            handler: async (request) => {
                try {
                    return await handleRequest(request);
                }
                catch (error) {
                    brokerLogger.warn(`[auth-lease-broker] request_failed ${JSON.stringify({ requestId: request.requestId, method: request.method, pid: process.pid, ...authFailureFields(error) })}`);
                    throw error;
                }
            },
        });
        stopWatching = options.session.watch((status) => {
            statusRevision += 1;
            // A refreshing generation is a reservation. A failed HTTP request may
            // restore the still-valid prior generation; do not make its floor permanent.
            pendingGeneration = status.status === 'refreshing' ? status.generation : undefined;
            if (status.status === 'authenticated' || isSignedOut(status.status))
                minimumGeneration = Math.max(minimumGeneration, status.generation);
            const generationChanged = cachedLease !== undefined && cachedLease.generation < minimumGeneration;
            const admissionClosed = isSignedOut(status.status);
            admissionOpen = !admissionClosed;
            if (admissionClosed)
                invalidate();
            else if (generationChanged || status.status !== 'authenticated')
                cachedLease = undefined;
        });
    }
    catch (error) {
        await server?.close().catch(() => undefined);
        await removeEndpointFiles();
        throw error;
    }
    brokerLogger.info(`[auth-lease-broker] ready protocol=${AUTH_LEASE_PROTOCOL_VERSION}`);
    return {
        endpoint: endpoint.endpoint,
        capabilityFile: endpoint.capabilityFile,
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            invalidate();
            stopWatching?.();
            stopWatching = undefined;
            try {
                await server?.close();
            }
            catch {
                brokerLogger.warn('[auth-lease-broker] dispose transport_error');
            }
            finally {
                server = undefined;
                await removeEndpointFiles();
            }
            brokerLogger.info(`[auth-lease-broker] disposed protocol=${AUTH_LEASE_PROTOCOL_VERSION}`);
        },
    };
    async function removeEndpointFiles() {
        try {
            await rm(endpoint.capabilityFile, { force: true });
        }
        finally {
            await endpoint.cleanup();
        }
    }
}
async function getCredentialFreeStatus(session) {
    const status = await session.getStatus();
    return {
        method: 'status',
        status: status.status,
        generation: status.generation,
        ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
    };
}
async function loadLease(session, minValidityMs) {
    try {
        return await session.getAccessToken(minValidityMs);
    }
    catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined;
        if (typeof code === 'string' &&
            !['AUTH_REQUIRED', 'AUTH_SCOPE_UPGRADE_REQUIRED', 'AUTH_RESOURCE_CONTRACT_MISMATCH'].includes(code))
            throw error;
        const status = await readStatusAfterLeaseFailure(session);
        if (code || (status && isSignedOut(status.status))) {
            const mapped = new AuthLeaseProtocolError('AUTH_REQUIRED');
            mapped.cause = error;
            throw mapped;
        }
        throw error;
    }
}
function isSignedOut(status) {
    return [
        'anonymous',
        'authorizing',
        'logging_out',
        'logout_pending',
        'scope_upgrade_required',
    ].includes(status);
}
async function waitForLease(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const error = new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
            error.cause = Object.assign(new Error('Authentication credential wait timed out.'), {
                code: 'AUTH_LEASE_WAIT_TIMEOUT',
            });
            reject(error);
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function readStatusAfterLeaseFailure(session) {
    try {
        return await session.getStatus();
    }
    catch {
        return undefined;
    }
}
function isUsableLease(lease, minValidityMs, nowMs) {
    return lease.expiresAtMs - nowMs >= minValidityMs;
}
function assertFixedLease(lease) {
    if (lease.audience !== AUTH_LEASE_AUDIENCE ||
        lease.scopes.length !== 1 ||
        lease.scopes[0] !== AUTH_LEASE_SCOPES[0]) {
        throw new AuthLeaseProtocolError('INTERNAL_ERROR');
    }
}
async function atomicWriteCapability(capabilityFile, capability) {
    const directory = path.dirname(capabilityFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32')
        await chmod(directory, 0o700);
    const temporaryFile = `${capabilityFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
        handle = await open(temporaryFile, 'wx', 0o600);
        await handle.writeFile(`${capability}\n`, 'utf8');
        await handle.sync();
        if (process.platform !== 'win32')
            await handle.chmod(0o600);
        await handle.close();
        handle = undefined;
        await rename(temporaryFile, capabilityFile);
        if (process.platform !== 'win32')
            await chmod(capabilityFile, 0o600);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporaryFile, { force: true });
        throw error;
    }
}
//# sourceMappingURL=lease-broker.js.map