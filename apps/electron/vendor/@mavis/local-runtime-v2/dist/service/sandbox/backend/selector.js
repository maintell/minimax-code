import { SandboxError } from '../sandbox-errors.js';
export function selectSandboxBackendCandidate(input) {
    const candidates = input.descriptors.filter((descriptor) => descriptor.platform === input.platform &&
        (input.requestedBackendId === undefined || descriptor.id === input.requestedBackendId));
    candidates.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const descriptor = candidates[0];
    if (!descriptor) {
        throw new SandboxError('SANDBOX_UNSUPPORTED_PLATFORM', 'init', 'No sandbox backend is registered for this platform');
    }
    const backend = descriptor.create();
    if (backend.id !== descriptor.id) {
        throw new SandboxError('SANDBOX_CONFIG_INVALID', 'parse', 'Sandbox backend descriptor identity mismatch');
    }
    return backend;
}
export function assertSandboxBackendCapabilities(backend, policy) {
    const unsupportedField = findUnsupportedField(backend, policy);
    if (!unsupportedField)
        return;
    throw new SandboxError('SANDBOX_CONFIG_INVALID', 'parse', 'Sandbox backend cannot enforce the requested policy', unsupportedField);
}
function findUnsupportedField(backend, policy) {
    const capabilities = backend.capabilities;
    if (!capabilities.perCallFilesystem)
        return 'sandbox.filesystem.policy';
    if (!capabilities.filesystemModes.includes(policy.filesystem.mode)) {
        return 'sandbox.filesystem.policy.mode';
    }
    if (policy.filesystem.mode === 'delete_guard' &&
        capabilities.operationScopedDelete !== 'source-unlink') {
        return 'sandbox.filesystem.policy.mode';
    }
    if (!capabilities.networkModes.includes(policy.network.mode)) {
        return 'sandbox.network.policy.mode';
    }
    if (!capabilities.liveNetworkRuleSwap)
        return 'sandbox.network.policy';
    if (!capabilities.localAccessLevels.includes(policy.localAccess)) {
        return 'sandbox.localAccess';
    }
    return undefined;
}
//# sourceMappingURL=selector.js.map