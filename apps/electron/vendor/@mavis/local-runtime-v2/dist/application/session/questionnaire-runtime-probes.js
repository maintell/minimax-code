/** Bind existing owner inspection to the local questionnaire capability. */
export function bindAskUserRuntimeProbes(target, turns) {
    const inspection = turns?.inspection;
    if (!inspection)
        return;
    target.isQuestionnaireOriginTurnRunning = (sessionId, turnId) => inspection.activeTurnId(sessionId) === turnId;
    if (inspection.hasPendingUserSteering)
        target.hasPendingUserSteeringProbe = inspection.hasPendingUserSteering.bind(inspection);
    if (inspection.hasQueuedUserInputSince)
        target.hasQueuedUserInputSinceProbe = inspection.hasQueuedUserInputSince.bind(inspection);
}
//# sourceMappingURL=questionnaire-runtime-probes.js.map