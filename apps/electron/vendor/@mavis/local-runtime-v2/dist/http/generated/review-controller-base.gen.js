import { NotImplementedError } from '../errors.js';
export class ReviewControllerBase {
    async getReviewPreferences(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getReviewPreferences');
    }
    async updateReviewPreferences(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('updateReviewPreferences');
    }
    async resolveAnnotationTarget(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('resolveAnnotationTarget');
    }
}
//# sourceMappingURL=review-controller-base.gen.js.map