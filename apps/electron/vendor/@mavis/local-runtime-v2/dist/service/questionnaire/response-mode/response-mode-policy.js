import { parseAskUserConfig, resolveAskUserPolicyContext, resolveAskUserResponseMode, resolveEffectiveAskUserPolicy, } from '@mavis/config';
import { logger } from '../../../infra/logging/logger.js';
import { GOAL_SKIP_AUTO_SELECT_MS, } from '../../../infra/legacy-db/questionnaire-action-contracts.js';
/**
 * Decides, when ask_user is called, whether this call creates a v2
 * questionnaire and whether it waits (sync) or returns at once (async).
 *
 * Enablement: Desktop (electron) runtime, a Turn that did not come from an IM
 * channel, a Session that is not a Mini App's, and the ordinary questionnaire
 * mode. Everything else keeps the legacy protocol untouched (no
 * response_mode). There is no feature switch. A Mini App gets the question from
 * its run result (`pendingQuestion`), which exists only once the Turn ends, so
 * a sync wait there would hold the Turn open with nobody able to answer.
 *
 * Policy: config is read now, not at Turn start, so a setting changed
 * mid-Turn applies to the next question. Plan comes from the Turn's session
 * interaction mode (the same fact the <ask-user-policy> reminder reads; entering
 * or leaving Plan always ends the Turn, so it cannot change mid-Turn). Goal
 * comes from the v2 Goal owner via `isGoalActive`, the same row the reminder
 * reads; a failed read counts as "not in Goal", matching the reminder.
 */
export async function decideQuestionnaireResponseMode(deps, input) {
    const mode = input.toolInput.mode ?? 'questionnaire';
    const skip = (reason) => {
        logger.info({ sessionId: input.sessionId, mode, reason }, 'ask_user uses the legacy questionnaire protocol');
        return { v2: false, reason };
    };
    if (deps.responseModeEnabled !== true)
        return skip('not_desktop_runtime');
    if (input.fromImChannel)
        return skip('im_channel_turn');
    if (input.fromMiniAppSession === true)
        return skip('miniapp_session');
    if (mode !== 'questionnaire')
        return skip('not_questionnaire_mode');
    const goalActive = input.planActive ? false : await isGoalActive(deps, input.sessionId);
    const context = resolveAskUserPolicyContext({ planActive: input.planActive, goalActive });
    const config = parseAskUserConfig({ askUser: readAskUserConfig(deps, input.sessionId) });
    const effectivePolicy = resolveEffectiveAskUserPolicy(config, context);
    const { responseMode, autoSelectAfterMs } = resolvePolicyResponseMode(context, effectivePolicy, input.toolInput.async);
    const requestedMode = input.toolInput.async === true ? 'async' : 'sync';
    const policyOverridden = requestedMode !== responseMode;
    // Omitted and `false` both run sync, so `requestedAsync` records both as
    // false and an eval cannot tell "the model chose sync" from "the model never
    // considered async". `asyncParam` keeps the three cases apart; it is a string
    // so log queries match readable values. `requestedAsync` stays for existing
    // queries.
    const asyncParam = describeAsyncParam(input.toolInput.async);
    logger.info({
        sessionId: input.sessionId,
        askUserContext: context,
        effectivePolicy,
        asyncParam,
        requestedAsync: input.toolInput.async === true,
        responseMode,
        policyOverridden,
        ...(autoSelectAfterMs !== undefined ? { autoSelectAfterMs } : {}),
    }, 'ask_user response mode decided');
    return {
        v2: true,
        responseMode,
        effectivePolicy,
        context,
        policyOverridden,
        ...(autoSelectAfterMs !== undefined ? { autoSelectAfterMs } : {}),
    };
}
/**
 * Goal + skip waits in the Turn for at most GOAL_SKIP_AUTO_SELECT_MS, then
 * the runtime answers with the recommended options. Answering at once (the
 * async result) made models present the recommended option as the user's
 * choice; legacy Goal questionnaires likewise adopted it only after a timeout.
 */
function resolvePolicyResponseMode(context, effectivePolicy, requestedAsync) {
    if (context === 'goal' && effectivePolicy === 'skip') {
        return { responseMode: 'sync', autoSelectAfterMs: GOAL_SKIP_AUTO_SELECT_MS };
    }
    return { responseMode: resolveAskUserResponseMode(effectivePolicy, requestedAsync) };
}
function describeAsyncParam(value) {
    if (value === true)
        return 'true';
    if (value === false)
        return 'false';
    return 'omitted';
}
/**
 * A broken config read must not fail the ask_user call. It falls back to the
 * default policies, which the Turn-start reminder also falls back to, so the
 * two agree and no setting is invented.
 */
function readAskUserConfig(deps, sessionId) {
    try {
        return deps.configGetter().askUser;
    }
    catch (error) {
        logger.warn({ sessionId, reason: 'config_read_failed', err: error }, 'ask_user config read failed; using default ask_user policies');
        return undefined;
    }
}
async function isGoalActive(deps, sessionId) {
    try {
        return (await deps.isGoalActive?.(sessionId)) === true;
    }
    catch (error) {
        logger.warn({ sessionId, reason: 'goal_read_failed', err: error }, 'ask_user goal lookup failed; treating the call as outside Goal');
        return false;
    }
}
//# sourceMappingURL=response-mode-policy.js.map