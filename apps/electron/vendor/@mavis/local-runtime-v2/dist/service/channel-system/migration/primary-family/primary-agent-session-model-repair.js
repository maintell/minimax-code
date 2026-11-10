/**
 * Migration copy (MR1) of v1 `channels/primary-agent-session-model-repair.ts`.
 */
import { getRuntimePresetKey, resolveModelReplacement } from '@mavis/config';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Bounded repair event (plan §13): session / source / preset / from / to model. */
const MODEL_REPAIR_EVENT = 'session_model_repaired';
/**
 * Repair the historical Session models that the surviving channel path can
 * reach on THIS boot (plan §8.4, last paragraph).
 *
 * Scope is deliberately tiny: only the keeper Root. Every historical Session
 * is repaired lazily by the same rule at its first Turn, so a large install
 * does not pay a full-table scan at startup.
 *
 * The rule is the shared replacement rule (`resolveModelReplacement`): an
 * official Session model the catalog no longer lists falls back to the
 * callable `defaultModel`, else the delivered default; the variant is cleared
 * (it belonged to the retired model), the change is persisted through the
 * existing lifecycle, and `session_model_repaired` is logged. A VALID override that merely differs from the default is preserved —
 * boot must not force every Root onto the default model.
 */
export async function repairPrimaryFamilySessionModels(input, sessionIds) {
    if (sessionIds.length === 0) {
        logger.info({ outcome: 'skipped', reason: 'empty_scope' }, MODEL_REPAIR_EVENT);
        return { checked: 0, repaired: 0 };
    }
    const config = input.config();
    const preset = getRuntimePresetKey();
    let repaired = 0;
    for (const sessionId of sessionIds) {
        if (await repairOne({ input, config, preset, sessionId }))
            repaired += 1;
    }
    logger.info({ outcome: 'ok', checked: sessionIds.length, repaired, preset }, MODEL_REPAIR_EVENT);
    return { checked: sessionIds.length, repaired };
}
async function repairOne(scope) {
    const { input, config, preset, sessionId } = scope;
    const session = await input.sessions.getSession(sessionId);
    if (!session) {
        throw new Error(`PRIMARY_AGENT_SESSION_MODEL_MISSING: ${sessionId}`);
    }
    const override = parseModelKey(session.effectiveModel);
    if (!override) {
        // No Session-level pin: the Turn resolves `config.defaultModel`, which is
        // the Turn gate's business. Startup must not fail a boot over it.
        logger.info({ session_id: sessionId, reason: 'no_session_override' }, MODEL_REPAIR_EVENT);
        return false;
    }
    const outcome = resolveModelReplacement({
        config,
        providerId: override.providerId,
        modelId: override.modelId,
        preset,
        fallbacks: [parseModelKey(config.defaultModel)],
    });
    if (outcome.kind !== 'replaced') {
        // Valid, or not ours to replace (non-official route / empty catalog):
        // boot never fails over a Session model; the Turn sends it unchanged.
        logger.info({
            session_id: sessionId,
            reason: outcome.kind === 'available' ? 'session_override_valid' : outcome.reason,
            route: outcome.route,
        }, MODEL_REPAIR_EVENT);
        return false;
    }
    const repairedModel = `${outcome.model.providerId}/${outcome.model.modelId}`;
    await input.sessions.updateSession(sessionId, {
        effectiveModel: repairedModel,
        effectiveModelVariant: null,
    });
    logger.info({
        session_id: sessionId,
        source: 'session_override',
        preset,
        tier: outcome.tier,
        from_model: `${override.providerId}/${override.modelId}`,
        to_model: repairedModel,
    }, MODEL_REPAIR_EVENT);
    return true;
}
function parseModelKey(value) {
    const raw = value?.trim();
    const slash = raw?.indexOf('/') ?? -1;
    if (!raw || slash <= 0 || slash === raw.length - 1)
        return undefined;
    return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}
//# sourceMappingURL=primary-agent-session-model-repair.js.map