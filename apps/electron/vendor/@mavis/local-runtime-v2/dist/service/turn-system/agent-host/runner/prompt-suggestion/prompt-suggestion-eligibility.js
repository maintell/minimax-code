/**
 * Runtime gate for the composer's next-message suggestion.
 *
 * The extra generation is billed to the signed-in account, so it only runs for
 * a confirmed subscription. Every uncertain path — no session, transport
 * failure, a `base_resp` rejection, a plan we cannot name, or a login change
 * during the read — resolves to "not eligible" and no model request is issued.
 * The UI hint is advisory; this gate is the only enforcement point.
 */
/** A slow membership read must not hold the suggestion back for long. */
const MEMBERSHIP_CHECK_TIMEOUT_MS = 1_500;
/** Plan fields only. Remaining credit, gifts or trial counters never qualify. */
const ELIGIBLE_SUBSCRIPTION_TYPES = new Set(['mplan', 'token_plan', 'agent_plan']);
export function createPromptSuggestionEligibility(commerce) {
    return {
        async check(signal) {
            const before = commerce.readAuthSnapshot();
            if (!before.accessToken?.trim())
                return 'not_signed_in';
            const timeout = AbortSignal.timeout(MEMBERSHIP_CHECK_TIMEOUT_MS);
            let facts;
            try {
                facts = await commerce.readMembershipFacts(AbortSignal.any([signal, timeout]));
            }
            catch {
                // Fail closed: an unreachable, slow or rejected membership API must not
                // turn into a model request the account did not ask to pay for.
                return 'unknown';
            }
            if (signal.aborted || timeout.aborted)
                return 'unknown';
            // A logout, account switch or token refresh between the two reads means
            // the facts describe an identity this Turn no longer belongs to.
            const after = commerce.readAuthSnapshot();
            if (after.accessToken !== before.accessToken || after.loginEpoch !== before.loginEpoch)
                return 'unknown';
            if (isEligibleMembership(facts))
                return undefined;
            // A plan we cannot name is not a confirmed refusal, and must not be
            // reported as one; either way no model request follows.
            return facts.subscriptionType === 'unknown' ? 'unknown' : 'no_plan';
        },
    };
}
export function isEligibleMembership(facts) {
    if (facts.hasTokenPlan)
        return true;
    return ELIGIBLE_SUBSCRIPTION_TYPES.has(facts.subscriptionType);
}
//# sourceMappingURL=prompt-suggestion-eligibility.js.map