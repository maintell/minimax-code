import { PinControllerBase } from '../generated/pin-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
export class PinController extends PinControllerBase {
    applications;
    constructor(applications) {
        super();
        this.applications = applications;
    }
    async pinAgent(ctx, req) {
        return this.requireApplication().pinAgent(ctx, req);
    }
    async pinSession(ctx, req) {
        return this.requireApplication().pinSession(ctx, req);
    }
    async getPinnedItemsOrder(ctx, req) {
        return this.requireApplication().getPinnedItemsOrder(ctx, req);
    }
    async putPinnedItemsOrder(ctx, req) {
        return this.requireApplication().putPinnedItemsOrder(ctx, req);
    }
    requireApplication() {
        if (!this.applications)
            throw new NotImplementedError('pin applications');
        return this.applications.pin;
    }
}
//# sourceMappingURL=pin.controller.js.map