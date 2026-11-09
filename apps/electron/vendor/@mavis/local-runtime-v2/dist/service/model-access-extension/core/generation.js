/**
 * A hot replacement keeps every provider and source of the running generation, except that a
 * provider (and the sources only it used) may be dropped once nothing is bound to it (`retired`):
 * that is how a package split hands providers to another package.
 */
export function assertCompatibleGeneration(previous, next, retired = () => false) {
    if (previous.manifest.name !== next.manifest.name || next.generation <= previous.generation)
        incompatible();
    const dropped = droppedProviders(previous, next, retired);
    for (const source of previous.manifest.sources) {
        // A source the new generation no longer declares may go with providers that were dropped.
        if (dropped.size && !next.manifest.sources.some((item) => item.id === source.id))
            continue;
        compatibleSource(source, next.manifest.sources.find((item) => item.id === source.id));
    }
}
/** Providers the next generation dropped while retired; any other change is incompatible. */
function droppedProviders(previous, next, retired) {
    const dropped = new Set();
    for (const provider of previous.manifest.providers) {
        const candidate = next.manifest.providers.find((item) => item.id === provider.id);
        if (!candidate && retired(provider.id))
            dropped.add(provider.id);
        else if (!candidate ||
            candidate.credentialSchema !== provider.credentialSchema ||
            provider.credentialKinds.some((kind) => !candidate.credentialKinds.includes(kind)))
            incompatible();
    }
    return dropped;
}
function incompatible() {
    throw new Error('generation_incompatible');
}
function compatibleSource(source, candidate) {
    if (!candidate || candidate.hostAgentId !== source.hostAgentId)
        incompatible();
    compatibleEntries(source.capabilities.login?.methods, candidate.capabilities.login?.methods);
    compatibleEntries(source.capabilities.subscriptionBorrow?.variants, candidate.capabilities.subscriptionBorrow?.variants);
    compatibleEntries(source.capabilities.apiKeyScan?.readers, candidate.capabilities.apiKeyScan?.readers);
}
function compatibleEntries(entries, candidates) {
    for (const entry of entries ?? []) {
        const match = candidates?.find((item) => item.id === entry.id);
        if (!match ||
            entry.targets.some((target) => !match.targets.includes(target)) ||
            ('kind' in entry && (!('kind' in match) || entry.kind !== match.kind)))
            incompatible();
    }
}
export async function retainUntilSettled(work, release) {
    try {
        return await work;
    }
    finally {
        release();
    }
}
//# sourceMappingURL=generation.js.map