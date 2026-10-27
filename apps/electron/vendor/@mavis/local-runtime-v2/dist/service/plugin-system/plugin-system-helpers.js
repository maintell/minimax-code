import { settleInBackground as settleDetached } from '../../infra/async/settle.js';
import { PluginSystemError } from './errors.js';
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
export async function runAfter(prior, operation) {
    await prior;
    return operation();
}
/**
 * Apps are discovered and called through mcode-tools. Turn admission never resolves a Connector
 * catalog, so a slow or failed discovery cannot delay the turn or change its tool prefix.
 */
export function capturePluginSystemTurnCapabilities(snapshot) {
    const toolNames = new Set();
    const bindingNames = new Set();
    return freeze({
        ...snapshot,
        runtimeTools: freeze(snapshot.runtimeTools.filter((tool) => keepFirstName(tool.def.name, toolNames))),
        runtimeToolBindings: freeze(snapshot.runtimeToolBindings.filter((binding) => keepFirstName(binding.tool.def.name, bindingNames))),
    });
}
function keepFirstName(name, names) {
    const key = name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
    if (names.has(key))
        return false;
    names.add(key);
    return true;
}
export function assertPluginSystemPublicationAttached(attached) {
    if (!attached) {
        throw new PluginSystemError('NOT_ATTACHED', 'PluginSystem publication port is not attached');
    }
}
export async function ignoreFailure(promise) {
    try {
        await promise;
    }
    catch {
        // Queue and shutdown cleanup deliberately continue after an operation fails.
    }
}
export async function runAllFinally(operations) {
    let hasError = false;
    let firstError;
    for (const operation of operations) {
        try {
            await operation();
        }
        catch (error) {
            if (!hasError)
                firstError = error;
            hasError = true;
        }
    }
    if (hasError)
        throw firstError;
}
/** Waits for best-effort background work without allowing it to block admission forever. */
export async function waitUntilSettledOrDeadline(promise, timeoutMs) {
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    try {
        await Promise.race([promise, deadline]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export function waitForScopedOperation(operation, currentScopeKey, timeoutMs = 20_000) {
    if (!operation || operation.scopeKey !== currentScopeKey)
        return Promise.resolve();
    return waitUntilSettledOrDeadline(ignoreFailure(operation.operation), timeoutMs);
}
export function settleInBackground(promise) {
    if (promise)
        settleDetached(promise);
}
/** Lets accepted official Mini App roots outlive cache pruning when the reconciler retains them. */
export function officialPackageRetentionOption(reconciler) {
    const retain = reconciler?.retainPackageRoot?.bind(reconciler);
    return retain ? { retainOfficialPackage: retain } : {};
}
export function findEnabledCachedPackage(installations, contentDigest) {
    for (const installation of installations.values()) {
        if (!installation.installed || !installation.enabled)
            continue;
        const cached = installation.cachedPackages.find((item) => item.contentDigest === contentDigest);
        if (cached)
            return cached;
    }
    return undefined;
}
export function resolvePluginRepositoryScope(input) {
    const principalId = input.authContextGetter()?.realUserID?.trim();
    const target = input.deploymentGetter().trim();
    return principalId && target ? { principalId, deployment: target } : undefined;
}
export function scopeKey(scope) {
    return scope ? `${scope.principalId}\0${scope.deployment}` : 'custom-only';
}
export function normalizedPluginName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
export function findLocalPlugin(snapshot, pluginName) {
    const key = normalizedPluginName(pluginName);
    return snapshot.localPlugins.find((plugin) => normalizedPluginName(plugin.name) === key);
}
export function assertPluginNameAvailable(pluginName, officialInstallations, snapshot) {
    const key = normalizedPluginName(pluginName);
    if (officialInstallations.some((item) => item.installed && normalizedPluginName(item.name) === key) ||
        snapshot.localPlugins.some((item) => normalizedPluginName(item.name) === key)) {
        throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin name is already installed');
    }
}
function freeze(value) {
    return Object.freeze(value);
}
/** Explicit disable/uninstall revokes persisted selections before publishing the new snapshot. */
export async function revokeOfficialPluginSelection(onRevoked, mutation, scope) {
    if (!mutation.installExists || !mutation.enabled) {
        await onRevoked?.({
            pluginName: mutation.pluginName,
            scope,
            reason: mutation.installExists ? 'disabled' : 'uninstalled',
        });
    }
}
/** Fence explicit mutations against both the active publication and current identity. */
export function assertOfficialMutationScope(expected, desiredKey, current) {
    if (scopeKey(expected) !== desiredKey || scopeKey(expected) !== scopeKey(current)) {
        throw new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed');
    }
}
//# sourceMappingURL=plugin-system-helpers.js.map