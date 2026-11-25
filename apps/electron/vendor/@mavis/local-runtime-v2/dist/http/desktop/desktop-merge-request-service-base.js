import { DesktopPendingContractsBase } from './desktop-pending-contracts-base.js';
/**
 * The merge request panel belongs to the v2 MergeRequestController; v1 never
 * serves it, so every method of the panel answers unavailable here.
 */
export class DesktopMergeRequestServiceBase extends DesktopPendingContractsBase {
    listSessionMergeRequests = () => this.unimplementedGeneratedMethod('listSessionMergeRequests');
    batchGetSessionMergeRequestBadges = () => this.unimplementedGeneratedMethod('batchGetSessionMergeRequestBadges');
    getMergeRequestJobLog = () => this.unimplementedGeneratedMethod('getMergeRequestJobLog');
    linkSessionMergeRequest = () => this.unimplementedGeneratedMethod('linkSessionMergeRequest');
    unlinkSessionMergeRequest = () => this.unimplementedGeneratedMethod('unlinkSessionMergeRequest');
    getCodeHostingStatus = () => this.unimplementedGeneratedMethod('getCodeHostingStatus');
    getMergeRequestChanges = () => this.unimplementedGeneratedMethod('getMergeRequestChanges');
    getMergeRequestMergeOptions = () => this.unimplementedGeneratedMethod('getMergeRequestMergeOptions');
    mergeMergeRequest = () => this.unimplementedGeneratedMethod('mergeMergeRequest');
    getMergeRequestCleanupPlan = () => this.unimplementedGeneratedMethod('getMergeRequestCleanupPlan');
    cleanupMergeRequestWorktree = () => this.unimplementedGeneratedMethod('cleanupMergeRequestWorktree');
    retryMergeRequestPipeline = () => this.unimplementedGeneratedMethod('retryMergeRequestPipeline');
    replyMergeRequestDiscussion = () => this.unimplementedGeneratedMethod('replyMergeRequestDiscussion');
    resolveMergeRequestDiscussion = () => this.unimplementedGeneratedMethod('resolveMergeRequestDiscussion');
    addMergeRequestComment = () => this.unimplementedGeneratedMethod('addMergeRequestComment');
    updateMergeRequest = () => this.unimplementedGeneratedMethod('updateMergeRequest');
    searchMergeRequestReviewers = () => this.unimplementedGeneratedMethod('searchMergeRequestReviewers');
    getMergeRequestCreateDefaults = () => this.unimplementedGeneratedMethod('getMergeRequestCreateDefaults');
    createMergeRequest = () => this.unimplementedGeneratedMethod('createMergeRequest');
    searchMergeRequestLinkCandidates = () => this.unimplementedGeneratedMethod('searchMergeRequestLinkCandidates');
}
//# sourceMappingURL=desktop-merge-request-service-base.js.map