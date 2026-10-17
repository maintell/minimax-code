/**
 * Skill-evolve configuration types + lifecycle helpers. Extracted from
 * `config.ts` to keep the main schema file under the 2_000-line guard.
 *
 * The runtime parser `parseSkillEvolveConfig` and `DEFAULTS.skillEvolve`
 * remain in `config.ts` because they depend on `parseBetaConfig`,
 * `collectModelIds`, and a shared `DEFAULTS` constant — moving them
 * here would create a circular import.
 */
/**
 * v3 helper: check whether an agent is in the proposal eligibility list.
 *
 * - `["*"]` matches every agent
 * - Otherwise an exact name match
 *
 * Empty list always returns false.
 */
export function isProposalEligibleAgent(agentName, eligibleAgents) {
    if (eligibleAgents.length === 0)
        return false;
    if (eligibleAgents.includes('*'))
        return true;
    return eligibleAgents.includes(agentName);
}
//# sourceMappingURL=skill-evolve-config.js.map