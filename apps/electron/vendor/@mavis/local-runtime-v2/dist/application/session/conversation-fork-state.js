/** Adapts owner-level state capabilities into the Application Fork participant. */
export function createForkState(owners) {
    return {
        copy: async ({ operationId, sourceSessionId, targetSessionId, latestBoundary, planState }) => {
            const planCopy = planState
                ? await requirePlanOwner(owners).documents.copyForFork({
                    sourceSessionId,
                    targetSessionId,
                })
                : undefined;
            if (latestBoundary) {
                await owners.questionnaires.copyPendingForFork({
                    operationId,
                    sourceSessionId,
                    targetSessionId,
                    ...(planState
                        ? {
                            prepareSource: preparePlanQuestionnaireFork(planCopy?.copied ? planCopy.canonicalPath : undefined),
                        }
                        : {}),
                });
            }
            if (planState?.interactionMode === 'plan') {
                const transition = await requirePlanOwner(owners).modes.setPlan(targetSessionId);
                if (transition !== 'updated' && transition !== 'already-plan') {
                    throw new Error(`Cannot copy Plan interaction mode to Fork child: ${transition}`);
                }
            }
            await owners.permissions.copyForFork({ sourceSessionId, targetSessionId });
        },
        compensate: async ({ targetSessionId }) => {
            await Promise.all([
                owners.diff.deleteSession(targetSessionId),
                owners.questionnaires.deleteSession(targetSessionId),
                owners.permissions.deleteSession(targetSessionId),
            ]);
        },
    };
}
function preparePlanQuestionnaireFork(targetPlanPath) {
    return (source) => {
        if (source.request.mode !== 'plan')
            return undefined;
        const review = source.request.modePayload?.planReview;
        if (review && !targetPlanPath) {
            throw new Error('Plan Questionnaire Fork requires a copied child plan.md');
        }
        return {
            request: review
                ? withTargetPlanReview(source.request, review, requireCopiedPlanPath(targetPlanPath))
                : source.request,
            preserveExecutionIdentity: false,
        };
    };
}
function withTargetPlanReview(request, review, targetPlanPath) {
    return {
        ...request,
        modePayload: {
            ...request.modePayload,
            planReview: { ...review, path: targetPlanPath },
        },
    };
}
function requireCopiedPlanPath(path) {
    if (path)
        return path;
    throw new Error('Plan Questionnaire Fork requires a copied child plan.md');
}
function requirePlanOwner(owners) {
    if (owners.plan)
        return owners.plan;
    throw new Error('Plan Fork state owner is unavailable');
}
//# sourceMappingURL=conversation-fork-state.js.map