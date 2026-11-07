import { MiniAppError } from '../errors.js';
export function activeStatusPhase(active, hasFailure) {
    if (active.runtime)
        return 'active';
    if (hasFailure)
        return 'failed';
    return active.startPromise ? 'starting' : 'cold';
}
export function publishedView(candidate, miniAppGeneration, runtime) {
    return {
        pluginId: candidate.pluginId,
        miniAppGeneration,
        packageRoot: candidate.packageRoot,
        packageDigest: candidate.packageDigest,
        clientDigest: candidate.clientDigest,
        surfacePath: candidate.surfacePath,
        ...(candidate.surfaceWindow ? { surfaceWindow: candidate.surfaceWindow } : {}),
        nodeDigest: candidate.nodeDigest,
        lifecycle: candidate.lifecycle,
        ...(runtime ? { processGeneration: runtime.processGeneration, origin: runtime.origin } : {}),
    };
}
/** Keeps the loopback credential beside, never inside, the published view. */
export function runtimeLoopbackToken(runtime) {
    return runtime ? { loopbackToken: runtime.loopbackToken } : {};
}
export function persistedState(candidate, runtime, updatedAtMs) {
    return {
        pluginId: candidate.pluginId,
        acceptedSourceDigest: candidate.packageDigest,
        clientDigest: candidate.clientDigest,
        nodeDigest: candidate.nodeDigest,
        ...(runtime
            ? {
                preferredPort: runtime.port,
            }
            : {}),
        updatedAtMs,
    };
}
export function isReusableGeneration(generation, candidate) {
    if (!generation.runtime || hasRuntimeTransition(generation))
        return false;
    return (sameMiniAppProcessContract(generation.candidate, candidate) &&
        generation.runtime.nodeDigest === candidate.nodeDigest);
}
export function assertReusableRuntimeCurrent(active, candidate, reusable) {
    if (!reusable)
        return;
    const generation = active.get(candidate.pluginId);
    if (generation === reusable.generation &&
        generation &&
        isReusableGeneration(generation, candidate) &&
        generation.runtime === reusable.runtime) {
        return;
    }
    throw new MiniAppError('SUPERSEDED', 'Reusable MiniApp runtime changed before commit');
}
export function assertGenerationRunCurrent(input) {
    const generation = input.active.get(input.pluginId);
    if (!input.unavailable &&
        generation?.accepting &&
        generation.runtime?.processGeneration === input.runId &&
        generation.view.processGeneration === input.runId) {
        return undefined;
    }
    throw new MiniAppError('SERVICE_RESTARTED', 'Mini App service changed before this operation could be dispatched');
}
export function scheduleTimeout(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
}
/** Node process contract: the parts of a candidate a running root cannot change under. */
function sameMiniAppProcessContract(current, candidate) {
    return (current.nodeDigest === candidate.nodeDigest &&
        current.nodeEntry === candidate.nodeEntry &&
        canonicalMcpEndpoints(current) === canonicalMcpEndpoints(candidate) &&
        sameMiniAppAccessPolicy(current, candidate));
}
/**
 * The manifest-level grants a process was started with: Host Connector, Agent and tool access.
 * Every role that reuses a process compares through this one place.
 */
function sameMiniAppAccessPolicy(left, right) {
    return (canonicalHostConnectorPolicy(left) === canonicalHostConnectorPolicy(right) &&
        canonicalAgentPolicy(left) === canonicalAgentPolicy(right) &&
        canonicalToolPolicy(left) === canonicalToolPolicy(right));
}
/**
 * `reuse`: only ordinary package content moved (root/digest); a running root keeps serving.
 * `restart`: the process contract, client assets or surface changed; a running root must be
 * replaced, which a marketplace sync never does on its own.
 */
export function classifyMiniAppCandidateChange(current, next) {
    if (JSON.stringify(current) === JSON.stringify(next))
        return 'none';
    if (sameMiniAppProcessContract(current, next) &&
        current.clientDigest === next.clientDigest &&
        current.surfacePath === next.surfacePath &&
        JSON.stringify(current.surfaceWindow ?? null) === JSON.stringify(next.surfaceWindow ?? null)) {
        return 'reuse';
    }
    return 'restart';
}
function hasRuntimeTransition(generation) {
    return Boolean(generation.startPromise ||
        generation.startController ||
        generation.idleTimer ||
        generation.idleStopPromise);
}
function canonicalMcpEndpoints(candidate) {
    return JSON.stringify(candidate.mcpEndpoints
        .map((endpoint) => [endpoint.id, endpoint.path])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}
function canonicalHostConnectorPolicy(candidate) {
    const policy = candidate.hostConnectorPolicy;
    return policy.kind === 'deny-all'
        ? policy.kind
        : JSON.stringify([policy.kind, [...policy.providers].sort()]);
}
function canonicalAgentPolicy(candidate) {
    const policy = candidate.agentPolicy ?? { kind: 'deny-all' };
    return policy.kind === 'deny-all'
        ? policy.kind
        : JSON.stringify([policy.kind, [...policy.capabilities].sort(), policy.maxConcurrent]);
}
function canonicalToolPolicy(candidate) {
    const policy = candidate.toolPolicy ?? { kind: 'deny-all' };
    return policy.kind === 'deny-all'
        ? policy.kind
        : JSON.stringify([policy.kind, [...policy.capabilities].sort()]);
}
//# sourceMappingURL=supervisor-generation.js.map