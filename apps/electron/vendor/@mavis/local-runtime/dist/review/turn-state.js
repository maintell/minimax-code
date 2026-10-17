export class ReviewTurnState {
    currentPhase = 'idle';
    preparedReview;
    acceptedText;
    acceptedOutcome;
    pendingReviewProjection;
    invalidCandidateAttempts = 0;
    contextDelivery = 'full';
    fullReminder;
    compactReminder;
    get phase() {
        return this.currentPhase;
    }
    get prepared() {
        return this.preparedReview;
    }
    get projectedText() {
        return this.acceptedText;
    }
    get outcome() {
        return this.acceptedOutcome;
    }
    get delivery() {
        return this.contextDelivery;
    }
    get renderedFullReminder() {
        return this.fullReminder;
    }
    get renderedCompactReminder() {
        return this.compactReminder;
    }
    isReviewActivated() {
        return this.currentPhase !== 'idle';
    }
    activate(prepared, reminders, initialDelivery = 'full') {
        this.preparedReview = prepared;
        this.acceptedText = undefined;
        this.acceptedOutcome = undefined;
        this.pendingReviewProjection = undefined;
        this.invalidCandidateAttempts = 0;
        this.contextDelivery = initialDelivery;
        this.fullReminder = reminders?.fullReminder;
        this.compactReminder = reminders?.compactReminder;
        this.currentPhase = prepared.mode === 'subagent' ? 'subagent_running' : 'inline_active';
    }
    useGitDiscovery() {
        this.contextDelivery = 'git-discovery';
    }
    isProjectionActive() {
        return (this.currentPhase === 'inline_active' ||
            this.currentPhase === 'subagent_running' ||
            this.currentPhase === 'subagent_result_ready');
    }
    setSubagentResult(projectedText) {
        if (!this.preparedReview || this.preparedReview.mode !== 'subagent') {
            throw new Error('Cannot attach a subagent result to an inactive inline review');
        }
        this.acceptedText = projectedText;
        this.currentPhase = 'subagent_result_ready';
    }
    getSubagentResult() {
        return this.currentPhase === 'subagent_result_ready' ? this.acceptedText : undefined;
    }
    setPendingProjection(projection) {
        if (!this.isProjectionActive()) {
            throw new Error('Cannot save Review candidates outside an active Review turn');
        }
        this.pendingReviewProjection = projection;
    }
    getPendingProjection() {
        return this.pendingReviewProjection;
    }
    clearPendingProjection() {
        this.pendingReviewProjection = undefined;
    }
    consumeInvalidCandidateRetry() {
        if (this.invalidCandidateAttempts >= 1)
            return false;
        this.invalidCandidateAttempts += 1;
        return true;
    }
    finalize(projectedText, outcome) {
        if (projectedText !== undefined)
            this.acceptedText = projectedText;
        if (outcome !== undefined)
            this.acceptedOutcome = outcome;
        this.pendingReviewProjection = undefined;
        this.currentPhase = 'finalized';
    }
}
//# sourceMappingURL=turn-state.js.map