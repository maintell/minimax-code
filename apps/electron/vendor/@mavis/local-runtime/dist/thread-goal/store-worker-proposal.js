export const THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS = 2_000;
export function normalizeThreadGoalWorkerProposalSummary(summary) {
    const normalized = summary?.trim();
    return normalized
        ? normalized.slice(0, THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS)
        : undefined;
}
/** Materialize a bounded worker proposal at the exact decision epoch that accepted it. */
export function materializeThreadGoalWorkerProposal(input, at) {
    if (!input)
        return undefined;
    const summary = normalizeThreadGoalWorkerProposalSummary(input.summary);
    return {
        v: 1,
        source: 'worker',
        type: input.type,
        turnId: input.turnId,
        ...(summary ? { summary } : {}),
        ...(input.type === 'complete' ? { resultDelivery: 'pending' } : {}),
        at,
    };
}
//# sourceMappingURL=store-worker-proposal.js.map