import { logger } from '@mavis/shared/local-runtime-logging';
import { ModelAccessApiScanService } from '../api-scan/api-scan.service.js';
import { ModelAccessBorrowService } from '../borrow/borrow.service.js';
import { ModelAccessBindingService } from '../credentials/binding.service.js';
import { ModelAccessKeepAlive } from '../credentials/keepalive.js';
import { ModelAccessLoginService } from '../login/login.service.js';
import { ModelAccessRequestService } from '../request/request.service.js';
export function composeModelAccessPackageServices(host) {
    const { options } = host;
    const bindings = new ModelAccessBindingService({
        serial: host.serial,
        // A completed renewal may still be written while closing; the repository lock is held
        // until releaseOwnership has waited for in-flight renewals.
        closingSerial: host.enqueue,
        state: host.credentials,
        save: host.saveCredentials,
        assertInstallation: host.assertInstallation,
        acquireGeneration: (id, parent) => host.registry().acquire(id, parent),
        acquireBorrow: (source, signal, generation) => host.policy().acquire({
            installationId: source.installationId,
            sourceId: source.sourceId,
            capability: 'subscriptionBorrow',
            entryId: source.variant,
            targets: [source.target],
            signal,
        }, generation),
        forgetOwned: (binding, payload) => host.housekeeping.forgetOwned(binding, payload),
        warn: (fields, message) => logger.warn(fields, message),
    }, host.secrets);
    const shared = {
        serial: host.serial,
        registry: host.registry,
        policy: host.policy,
        directories: host.directories,
    };
    const login = new ModelAccessLoginService({
        ...shared,
        bindings,
        forgetLate: (input) => host.housekeeping.forgetLateLogin(input),
    }, { timeoutMs: options.loginTimeoutMs, cleanupTimeoutMs: options.loginCleanupTimeoutMs });
    const borrow = new ModelAccessBorrowService({ ...shared, bindings }, options.borrowTimeoutMs);
    const apiScan = new ModelAccessApiScanService({ ...shared, apiScanEnabled: options.apiScanEnabled === true }, { timeoutMs: options.apiScanTimeoutMs, candidateTtlMs: options.apiCandidateTtlMs });
    const requests = new ModelAccessRequestService({
        profileId: options.profileId,
        registry: host.registry,
        bindings,
        subscriptionsEnabled: () => {
            host.refreshShared();
            return host.policy().subscriptionsEnabled();
        },
        remoteBlock: host.remoteBlock,
        borrow,
        directories: host.directories,
    }, options.requestTimeoutMs);
    const keepAlive = options.keepAliveOwned
        ? new ModelAccessKeepAlive({
            bindings: () => host.credentials().bindings,
            usable: (binding) => host.usable() && requests.admits(binding),
            renew: (binding, signal) => requests.keepAliveOwned(binding, signal),
            warn: (fields, message) => logger.warn(fields, message),
        })
        : undefined;
    return { bindings, login, borrow, apiScan, requests, keepAlive };
}
/** Registrations whose installation is no longer enabled lose their leases and requests. */
export function invalidateDisabled(registry, installations, policy, requests) {
    for (const registration of registry.list()) {
        const id = registration.installationId;
        if (installations.some((item) => item.installationId === id && item.enabled))
            continue;
        policy.invalidateInstallation(id);
        for (const provider of registration.manifest.providers)
            requests.invalidateProvider(provider.id, id);
    }
}
//# sourceMappingURL=package-services.js.map