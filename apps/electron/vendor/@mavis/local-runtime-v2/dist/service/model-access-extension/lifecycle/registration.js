import { randomUUID } from 'node:crypto';
import { desktopVersionSatisfies } from '@minimax/model-access-sdk';
import { assertPackageNamespace, ModelAccessPackageError } from '../errors.js';
import { keptDigestOf } from '../installation/user-packages.js';
import { modelAccessSnapshotPath, previewLocalModelAccessPackage, } from '../package-snapshot.adapter.js';
function assertHostVersion(manifest, hostVersion) {
    const floor = manifest.engines.desktop;
    if (floor && hostVersion && !desktopVersionSatisfies(floor, hostVersion))
        throw new ModelAccessPackageError('unsupported_host_version');
}
/**
 * The stored snapshot of `digest` is intact, belongs to this installation, runs on this platform
 * and host, and still declares every credential schema already bound to the installation.
 */
export async function validateModelAccessSnapshot(options, item, digest, credentials) {
    const directory = modelAccessSnapshotPath(options.root, digest);
    const preview = await previewLocalModelAccessPackage(directory);
    if (preview.digest !== digest || preview.manifest.name !== item.name)
        throw new ModelAccessPackageError('integrity_failed');
    if (!preview.manifest.platforms.includes(options.platform))
        throw new ModelAccessPackageError('unsupported_platform');
    assertHostVersion(preview.manifest, options.hostVersion);
    const schemas = [
        ...(await options.credentialSchemas(item.installationId)),
        ...(credentials?.bindings ?? [])
            .filter((binding) => binding.installationId === item.installationId)
            .map((binding) => ({ providerId: binding.providerId, schema: binding.credentialSchema })),
    ];
    const declared = (binding) => preview.manifest.providers.some((provider) => provider.id === binding.providerId && provider.credentialSchema === binding.schema);
    if (!schemas.every(declared))
        throw new ModelAccessPackageError('credential_schema_mismatch');
    return { preview, directory };
}
/** A freshly snapshotted package may be registered on this platform and host under `trustSource`. */
export function assertRegistrable(manifest, trustSource, options) {
    if (!manifest.platforms.includes(options.platform))
        throw new ModelAccessPackageError('unsupported_platform');
    assertPackageNamespace(manifest.name, trustSource);
    assertHostVersion(manifest, options.hostVersion);
}
/** New content for an existing installation, trusted and staged for the next activation. */
export function restagedInstallation(previous, digest, trustSource) {
    return {
        ...previous,
        pendingDigest: digest,
        generation: previous.generation + 1,
        trustedDigests: [...new Set([...previous.trustedDigests, digest])],
        status: previous.enabled ? 'pending-restart' : 'registered',
        errorCode: undefined,
        trustSource,
        keptDigest: keptDigestOf(previous, trustSource),
    };
}
export function newInstallation(name, digest, trustSource) {
    return {
        installationId: randomUUID(),
        name,
        generation: 1,
        pendingDigest: digest,
        enabled: false,
        trustedDigests: [digest],
        status: 'registered',
        trustSource,
    };
}
/** Every source id the borrowed source's host agent declares (they share one sign-in). */
export async function borrowSourcesOfAgent(input, current) {
    let { manifest } = current;
    if (!manifest) {
        // Uninstall revokes every persisted borrow target for the removed installation.
        if (!current.installation)
            return [input.sourceId];
        const digest = current.installation.activeDigest ?? current.installation.pendingDigest;
        if (!digest)
            throw new ModelAccessPackageError('installation_missing');
        manifest = (await current.validate(digest)).preview.manifest;
    }
    const source = manifest.sources.find((item) => item.id === input.sourceId);
    if (!source)
        throw new ModelAccessPackageError('installation_missing');
    return manifest.sources
        .filter((item) => item.hostAgentId === source.hostAgentId)
        .map((item) => item.id);
}
/** The digest to activate next; it must be one the user trusted. */
export function trustedActivationDigest(item) {
    const digest = item.pendingDigest ?? item.activeDigest;
    if (!digest || !item.trustedDigests.includes(digest))
        throw new ModelAccessPackageError('trust_required');
    return digest;
}
//# sourceMappingURL=registration.js.map