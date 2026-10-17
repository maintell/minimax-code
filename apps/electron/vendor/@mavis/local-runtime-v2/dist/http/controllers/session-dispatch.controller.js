import { SessionDispatchControllerBase } from '../generated/session-dispatch-controller-base.gen.js';
import { AppError } from '../errors.js';
export class SessionDispatchController extends SessionDispatchControllerBase {
    applications;
    constructor(applications) {
        super();
        this.applications = applications;
    }
    approveLocalSessionHandoff(ctx, req) {
        return this.requireHandoff().approveLocalSessionHandoff(ctx, req);
    }
    getLocalSessionHandoffEligibility(ctx, req) {
        return this.requireHandoff().getLocalSessionHandoffEligibility(ctx, req);
    }
    getSessionHandoffSummary(ctx, req) {
        return this.requireHandoff().getSessionHandoffSummary(ctx, req);
    }
    downloadSessionResult(ctx, req) {
        return this.requireHandoff().downloadSessionResult(ctx, req);
    }
    overwriteSessionResult(ctx, req) {
        return this.requireHandoff().overwriteSessionResult(ctx, req);
    }
    requireHandoff() {
        const handoff = this.applications?.session.handoff;
        if (!handoff) {
            throw new AppError(503, 'SESSION_HANDOFF_UNAVAILABLE', 'Session handoff is unavailable');
        }
        return handoff;
    }
}
//# sourceMappingURL=session-dispatch.controller.js.map