import { PluginSystemError } from '../../../errors.js';
import { deferred } from '../../../plugin-system-helpers.js';
import { isPublicationSuperseded } from '../../../publication.js';
import { listEnabledMiniAppDefinitions, sameMiniAppCandidate, } from './candidate.js';
import { buildTargetedMiniAppInputs } from './projection.js';
/** Publishes and starts one definition without admitting the rest of the catalog. */
export async function activateAvailableMiniApp(input, capability) {
    await capability.initialize();
    assertActivationUsable(input, capability);
    if (input.startOnly) {
        await activateColdMiniApp(input, capability);
        return;
    }
    await capability.runExclusive(async () => {
        const target = await readActivationTarget(input, capability);
        if (!target)
            return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await publishActivationTarget(input, capability, target);
                return;
            }
            catch (error) {
                if (!isPublicationSuperseded(error) || attempt === 1)
                    throw error;
            }
        }
    });
}
async function activateColdMiniApp(input, capability) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await prepareAndPublishColdMiniApp(input, capability);
            return;
        }
        catch (error) {
            if (!isPublicationSuperseded(error))
                throw error;
            input.signal?.throwIfAborted();
            if (attempt === 1)
                throw error;
        }
    }
}
async function prepareAndPublishColdMiniApp(input, capability) {
    const target = await capability.runExclusive(() => readActivationTarget(input, capability));
    if (!target)
        return;
    assertActivationUsable(input, capability);
    const prepared = await capability.prepareStart(target.candidate, input.signal);
    let published = false;
    try {
        published = await capability.runExclusive(async () => {
            const latest = await readActivationTarget(input, capability, prepared.candidate);
            if (!latest)
                return false;
            await publishActivationTarget(input, capability, latest, prepared);
            return true;
        });
    }
    finally {
        if (!published)
            await rollbackPreparedStart(prepared);
    }
}
async function readActivationTarget(input, capability, expected) {
    assertActivationUsable(input, capability);
    const available = await capability.readAvailableSnapshot();
    assertActivationUsable(input, capability);
    const candidate = listEnabledMiniAppDefinitions(available).find(({ candidate: item }) => item.pluginId === input.pluginId)?.candidate;
    if (!candidate) {
        throw new PluginSystemError('MINIAPP_NOT_AVAILABLE', 'Enabled MiniApp definition is not available');
    }
    if (expected && !sameMiniAppCandidate(candidate, expected)) {
        throw new PluginSystemError('MINIAPP_CATALOG_STALE', 'Mini App definition changed during startup', {
            reasonCode: 'CANDIDATE_CHANGED',
        });
    }
    if (capability.isAcceptedCandidateRunning(candidate))
        return undefined;
    const context = capability.buildContext(available);
    if (!context) {
        throw new PluginSystemError('MINIAPP_CATALOG_STALE', 'Mini App definition catalog cannot be activated');
    }
    return { available, candidate, context };
}
async function publishActivationTarget(input, capability, target, prepared) {
    assertActivationUsable(input, capability);
    const current = capability.currentSnapshot();
    const currentContext = capability.buildContext(current);
    if (!currentContext) {
        throw new PluginSystemError('MINIAPP_CATALOG_STALE', 'Mini App runtime publication context is not available');
    }
    const candidate = capability.buildSnapshot(buildTargetedMiniAppInputs({
        base: currentContext.input,
        available: target.context.input,
        availableSnapshot: target.available,
        target: target.candidate,
    }), currentContext.options);
    const publicationTarget = prepared
        ? { preparedMiniAppStart: prepared }
        : { forceRuntimePublicationPluginId: input.pluginId };
    try {
        await capability.prepare(candidate, {
            completion: deferred(),
            commit: async () => {
                assertActivationUsable(input, capability);
                if (capability.currentSnapshot().revision !== current.revision) {
                    throw new PluginSystemError('PUBLICATION_SUPERSEDED', 'Mini App activation snapshot was superseded');
                }
            },
            requiredMiniAppPluginId: input.pluginId,
            ...publicationTarget,
            miniAppRosterSource: target.available,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    }
    catch (error) {
        capability.setDesiredSnapshot(capability.currentSnapshot());
        throw error;
    }
}
function assertActivationUsable(input, capability) {
    capability.assertUsable();
    input.signal?.throwIfAborted();
}
async function rollbackPreparedStart(prepared) {
    try {
        await prepared.rollback();
    }
    catch (cause) {
        throw new PluginSystemError('MINIAPP_PREPARATION_FAILED', 'Mini App startup rollback failed', {
            cause,
        });
    }
}
//# sourceMappingURL=activation.js.map