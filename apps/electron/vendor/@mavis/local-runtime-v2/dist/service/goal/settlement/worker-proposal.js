import { createHash } from 'node:crypto';
import { normalizeThreadGoalWorkerProposalSummary } from '../persistence/store-worker-proposal.js';
export function threadGoalWorkerProposalInput(signal, turnId) {
    if (!signal)
        return undefined;
    return {
        type: signal.type === 'completion_proposed' ? 'complete' : 'blocked',
        turnId,
        ...(signal.summary ? { summary: signal.summary } : {}),
    };
}
function threadGoalWorkerProposalObservation(signal) {
    // Hash the exact bounded representation retained for consent-only diagnostics.
    const summary = normalizeThreadGoalWorkerProposalSummary(signal.summary);
    return {
        proposal: signal.type === 'completion_proposed' ? 'complete' : 'blocked',
        summaryPresent: Boolean(summary),
        ...(summary ? { summaryDigest: createHash('sha256').update(summary).digest('hex') } : {}),
    };
}
export function emitThreadGoalWorkerProposalDecision(input) {
    if (!input.signal)
        return;
    const observation = threadGoalWorkerProposalObservation(input.signal);
    const goal = input.result.goal;
    input.emit({
        type: 'goal.worker_proposal_decided',
        at: input.at,
        payload: {
            goalId: input.signal.goalId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            source: 'worker',
            ...observation,
            disposition: input.result.status === 'settled' ? 'accepted' : 'stale',
            ...(goal ? { resultStatus: goal.status } : {}),
            ...(goal?.statusReason ? { statusReason: goal.statusReason } : {}),
        },
    });
}
//# sourceMappingURL=worker-proposal.js.map