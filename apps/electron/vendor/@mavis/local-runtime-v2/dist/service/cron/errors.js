export class CronRepositoryError extends Error {
    code;
    name = 'CronRepositoryError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** A known temporary admission fence; never a terminal Cron failure. */
export class CronDeliveryDeferredError extends Error {
    code;
    name = 'CronDeliveryDeferredError';
    constructor(code) {
        super(code);
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map