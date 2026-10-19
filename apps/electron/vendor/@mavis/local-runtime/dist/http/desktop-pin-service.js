import { HTTPException } from 'hono/http-exception';
import { LocalAgentContractError } from '../agent/contract.js';
import { LocalPinContractError } from '../pin/helpers.js';
import { jsonError } from './desktop-service-support.js';
export class DesktopPinService {
    pin;
    constructor(pin) {
        this.pin = pin;
    }
    pinAgent(ctx, req) {
        void ctx;
        return this.mapPinErrors(() => this.requirePin().service.pinAgent(req));
    }
    pinSession(ctx, req) {
        void ctx;
        return this.mapPinErrors(() => this.requirePin().service.pinSession(req));
    }
    getPinnedItemsOrder(ctx, req) {
        void ctx;
        void req;
        return this.mapPinErrors(() => this.requirePin().service.getPinnedItemsOrder());
    }
    putPinnedItemsOrder(ctx, req) {
        void ctx;
        return this.mapPinErrors(() => this.requirePin().service.putPinnedItemsOrder(req));
    }
    removePinnedSession(sessionId) {
        return this.mapPinErrors(() => this.requirePin().service.removePinnedRef({ type: 'session', id: sessionId }));
    }
    requirePin() {
        if (!this.pin) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop pin service is not configured', 'PIN_UNAVAILABLE'),
            });
        }
        return this.pin;
    }
    async mapPinErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            if (err instanceof LocalPinContractError || err instanceof LocalAgentContractError) {
                throw new HTTPException(err.status, {
                    res: jsonError(err.status, err.message, err.code),
                });
            }
            throw err;
        }
    }
}
//# sourceMappingURL=desktop-pin-service.js.map