export class CronRepositoryError extends Error {
    code;
    name = 'CronRepositoryError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Terminal Run failure when its definition was deleted or cancelled before delivery. */
export const CRON_DEFINITION_DELETED = 'CRON_DEFINITION_DELETED';
export const CRON_DEFINITION_DELETED_ERROR = 'Cron definition was deleted before execution';
/**
 * Terminal Run failure when its definition was paused before delivery. The definition
 * still exists, so this must stay distinct from CRON_DEFINITION_DELETED in run history.
 */
export const CRON_DEFINITION_PAUSED = 'CRON_DEFINITION_PAUSED';
export const CRON_DEFINITION_PAUSED_ERROR = 'Cron definition was paused before delivery';
/** Terminal Run failure when the moment it was scheduled for passed long before delivery. */
export const CRON_RUN_EXPIRED = 'CRON_RUN_EXPIRED';
export const CRON_RUN_EXPIRED_ERROR = 'Cron run expired before delivery';
/** Terminal Run failure when temporary delivery rejections outlasted the retry budget. */
export const CRON_DELIVERY_RETRY_EXHAUSTED = 'CRON_DELIVERY_RETRY_EXHAUSTED';
export const CRON_DELIVERY_RETRY_EXHAUSTED_ERROR = 'Cron delivery retries were exhausted';
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