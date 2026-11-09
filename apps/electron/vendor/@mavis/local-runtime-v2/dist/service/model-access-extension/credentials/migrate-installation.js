/**
 * Rewrites bindings of the listed providers to the new installation. The credential envelope is
 * untouched: identity hashes do not include the installation, so an owned payload stays valid.
 */
function planInstallationMove(state, move) {
    const moved = [];
    const kept = [];
    const bindings = state.bindings.map((binding) => {
        if (binding.installationId !== move.fromInstallationId ||
            !move.providerIds.includes(binding.providerId))
            return binding;
        if (!move.accepts(binding)) {
            kept.push(binding.providerKey);
            return binding;
        }
        moved.push(binding.providerKey);
        const next = binding.kind === 'borrowed-current'
            ? {
                ...binding,
                installationId: move.toInstallationId,
                sourceRef: { ...binding.sourceRef, installationId: move.toInstallationId },
            }
            : { ...binding, installationId: move.toInstallationId };
        return Object.freeze(next);
    });
    return { bindings, moved, kept };
}
/** Copies the user's capability switches of the moved sources to the new installation. */
function moveCapabilityTargets(targets, input) {
    const existing = new Set(targets
        .filter((item) => item.installationId === input.toInstallationId)
        .map((item) => JSON.stringify([item.sourceId, item.capability, item.entryId, item.target])));
    const copies = targets
        .filter((item) => item.installationId === input.fromInstallationId && input.sourceIds.has(item.sourceId))
        .filter((item) => !existing.has(JSON.stringify([item.sourceId, item.capability, item.entryId, item.target])))
        .map((item) => ({ ...item, installationId: input.toInstallationId }));
    return [...targets, ...copies];
}
/**
 * Whether the new package can take this binding as it is: same provider with the same credential
 * kind and schema, and for a borrowed binding the same source, variant and target.
 */
function manifestAccepts(manifest, binding) {
    const provider = manifest.providers.find((item) => item.id === binding.providerId);
    if (!provider ||
        provider.credentialSchema !== binding.credentialSchema ||
        !provider.credentialKinds.includes(binding.kind))
        return false;
    if (binding.kind !== 'borrowed-current')
        return true;
    const source = manifest.sources.find((item) => item.id === binding.sourceRef.sourceId);
    return (source?.capabilities.subscriptionBorrow?.variants.some((variant) => variant.id === binding.sourceRef.variant &&
        variant.targets.includes(binding.sourceRef.target)) === true);
}
/** Moves bindings of `providerIds` from package `from` to the active official package `to`. */
export async function migrateInstallationCredentials(host, input) {
    const source = host.installations().find((item) => item.name === input.from);
    const target = host.installations().find((item) => item.name === input.to);
    const manifest = target && host.manifestOf(target.installationId);
    if (!source || !target || !manifest || !host.isOfficial(target.installationId))
        return { moved: [], kept: [] };
    const before = host.credentials();
    const plan = planInstallationMove(before, {
        fromInstallationId: source.installationId,
        toInstallationId: target.installationId,
        providerIds: input.providerIds,
        accepts: (binding) => manifestAccepts(manifest, binding),
    });
    const current = host.preferences();
    const targets = moveCapabilityTargets(current.targets, {
        fromInstallationId: source.installationId,
        toInstallationId: target.installationId,
        sourceIds: new Set(manifest.sources.map((item) => item.id)),
    });
    // Switches move even when no binding does (API-key readers of a package without providers).
    if (plan.moved.length === 0 && targets.length === current.targets.length)
        return { moved: [], kept: plan.kept };
    const preferences = { ...current, targets };
    await host.commit(before, { bindings: plan.bindings }, preferences);
    for (const providerId of input.providerIds)
        host.invalidate(providerId, source.installationId);
    return { moved: plan.moved, kept: plan.kept };
}
//# sourceMappingURL=migrate-installation.js.map