import { NotImplementedError } from '../errors.js';
export class QuestionnaireControllerBase {
    async beginQuestionnaire(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('beginQuestionnaire');
    }
    async replyQuestionnaire(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('replyQuestionnaire');
    }
    async dismissQuestionnaire(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('dismissQuestionnaire');
    }
    async getPendingQuestionnaire(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getPendingQuestionnaire');
    }
    async getQuestionnaire(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getQuestionnaire');
    }
    async getLatestPlanReview(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getLatestPlanReview');
    }
}
//# sourceMappingURL=questionnaire-controller-base.gen.js.map