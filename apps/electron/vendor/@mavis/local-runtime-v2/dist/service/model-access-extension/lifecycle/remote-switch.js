import { observeModelAccessWork } from '../core/settlement.js';
/** Rebuild effective remote rules from state; revoke work the new rules no longer admit. */
export function applyRemoteRules(host, delivery, enabled) {
    const wasDisabled = host.remotePolicy.serviceDisabled();
    if (!host.remotePolicy.load(delivery, enabled))
        return;
    const disabled = host.remotePolicy.serviceDisabled();
    if (disabled && !wasDisabled)
        stopForServiceSwitch(host);
    if (!disabled && wasDisabled)
        resumeAfterServiceSwitch(host);
    host.policy().remoteChanged();
    for (const registration of host.registry().list()) {
        for (const provider of registration.manifest.providers) {
            // Pending sign-ins must not commit; running streams finish on their existing lease.
            if (host.remotePolicy.providerBlockFor(registration.installationId, provider.id))
                host.login.invalidateProvider(provider.id, registration.installationId);
        }
    }
    retireRevokedUserPackages(host);
    for (const listener of [...host.listeners])
        listener();
}
/** Stop new work of one registration; subprocess hosts retire once running calls end. */
function retireRegistration(host, installationId) {
    const registration = host.registry().get(installationId);
    for (const provider of registration?.manifest.providers ?? [])
        host.login.invalidateProvider(provider.id, installationId);
    // In-process modules cannot be reloaded in the same process; there, admission alone stops
    // new work. Subprocess hosts retire: new calls are refused, running calls finish.
    if (!host.subprocessMode)
        return;
    host.registry().retire(installationId);
    host.subprocess.retire(installationId);
}
/** Restore enabled installations that have no registration and that `admit` still allows. */
function restoreMissing(host, admit) {
    if (!host.running())
        return;
    for (const item of host.installations()) {
        if (!item.enabled || host.registry().get(item.installationId) || !admit(item))
            continue;
        observeModelAccessWork(host.restore(item.installationId));
    }
}
/**
 * A user/dev package revoked by the catalog stops taking new work at once; running calls finish.
 * Its desired state is kept, so removing the revocation restores it from the local snapshot.
 */
function retireRevokedUserPackages(host) {
    for (const registration of host.registry().list()) {
        const id = registration.installationId;
        if (host.isOfficial(id))
            continue;
        if (host.remotePolicy.userPackageRevoked(registration.manifest.name, registration.digest))
            retireRegistration(host, id);
    }
    if (host.remotePolicy.serviceDisabled())
        return;
    restoreMissing(host, (item) => !host.isOfficial(item.installationId) &&
        !host.remotePolicy.userPackageRevoked(item.name, item.activeDigest));
}
/**
 * Master switch turned off: refuse new work and stop extension hosts once running calls end.
 * Snapshots, credentials, user switches and the persisted desired state are all kept.
 */
function stopForServiceSwitch(host) {
    for (const registration of host.registry().list())
        retireRegistration(host, registration.installationId);
}
/** Master switch back on: restore from the active local snapshots, never re-download. */
function resumeAfterServiceSwitch(host) {
    restoreMissing(host, () => true);
}
/**
 * providerPolicy stops new requests of a provider. accessPolicy `subscriptions` stops account
 * subscriptions like the user's own switch (public services and API imports are unaffected);
 * a borrowed binding additionally follows its source's `subscriptionBorrow` rule.
 */
export function remoteRequestBlock(remote, isOfficial, binding) {
    // Master switch: every model access request is refused, public services included.
    if (remote.serviceDisabled())
        return { code: 'service_disabled' };
    const provider = remote.providerBlockFor(binding.installationId, binding.providerId);
    if (provider)
        return { code: 'provider_disabled', ...(provider.reason ? { reason: provider.reason } : {}) };
    if (binding.kind === 'public')
        return undefined;
    // Official capability rules do not govern user or dev packages.
    if (!isOfficial(binding.installationId))
        return undefined;
    const rule = binding.kind === 'borrowed-current'
        ? remote.capabilityBlockFor(binding.installationId, 'subscriptionBorrow', binding.sourceRef.sourceId, { entryId: binding.sourceRef.variant, target: binding.sourceRef.target })
        : remote.globalBlock('subscriptions');
    return rule
        ? { code: 'remote_disabled', ...(rule.reason ? { reason: rule.reason } : {}) }
        : undefined;
}
/** The master switch is off, or remote policy removed the provider (of this installation). */
export function remoteWithdrawn(remote, extensionProviderId, installationId) {
    if (remote.serviceDisabled())
        return true;
    return installationId === undefined
        ? remote.providerBlock(extensionProviderId) !== undefined
        : remote.providerBlockFor(installationId, extensionProviderId) !== undefined;
}
//# sourceMappingURL=remote-switch.js.map