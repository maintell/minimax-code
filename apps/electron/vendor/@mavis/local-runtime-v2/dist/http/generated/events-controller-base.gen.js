import { NotImplementedError } from '../errors.js';
export class EventsControllerBase {
    async subscribeGlobalEvents(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('subscribeGlobalEvents');
    }
}
//# sourceMappingURL=events-controller-base.gen.js.map