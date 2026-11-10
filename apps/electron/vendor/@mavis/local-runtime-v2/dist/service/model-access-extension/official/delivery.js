import { OfficialModelAccessSync } from './sync.js';
import { OfficialSyncScheduler } from './scheduler.js';
import { settleInBackground } from '../../../infra/async/settle.js';
/** Environment variable that turns remote delivery on (`1`) or off (`0`), over the UI switch. */
export const MODEL_ACCESS_REMOTE_ENV = 'MAVIS_MODEL_ACCESS_REMOTE';
/**
 * Development override for the archon_biz lane of model access. Without it, model access follows
 * the client's swim lane (Developer Tools / `mcode --lane`), like every other managed request.
 */
const MODEL_ACCESS_CLOUD_LANE_ENV = 'MAVIS_MODEL_ACCESS_CLOUD_LANE';
/** The lane model access requests go to now: the explicit override, else the client's lane. @internal */
export function resolveModelAccessCloudLane(override, clientLane) {
    return override?.trim() || clientLane?.trim() || undefined;
}
/** Reads the lane live from the host's routing context, so a lane switch needs no restart. */
export function modelAccessCloudLaneGetter(routingContext) {
    return () => resolveModelAccessCloudLane(process.env[MODEL_ACCESS_CLOUD_LANE_ENV], routingContext?.()?.bedrockLane);
}
/**
 * Remote delivery is the default for every product owner. `MAVIS_MODEL_ACCESS_REMOTE=0` and the
 * Developer Tools switch exist only for development troubleshooting; the env value wins.
 */
export function resolveRemoteDeliverySwitch(env, optIn) {
    const value = env?.trim();
    if (value === '1' || value === '0')
        return { enabled: value === '1', source: 'env' };
    if (optIn !== undefined)
        return { enabled: optIn, source: 'developer-tools' };
    return { enabled: true, source: 'default' };
}
/** Owner of the remote channel for Electron, CLI and TUI. */
export class OfficialModelAccessDelivery {
    options;
    sync;
    scheduler;
    started = false;
    closed = false;
    lastLane;
    constructor(options) {
        this.options = options;
        this.lastLane = options.lane?.();
        this.sync = new OfficialModelAccessSync(options.host, options.client, options.archive, {
            lane: () => options.lane?.(),
        });
        this.scheduler = new OfficialSyncScheduler({
            run: (signal) => this.sync.run(signal),
            authenticated: () => options.authenticated(),
            record: (outcome) => this.record(outcome),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        });
    }
    switch() {
        return resolveRemoteDeliverySwitch((this.options.env ?? (() => process.env[MODEL_ACCESS_REMOTE_ENV]))(), this.options.optIn());
    }
    /** Apply local remote rules immediately, then start syncing once login is ready. */
    async start() {
        if (this.started || this.closed)
            return;
        this.started = true;
        this.options.refresh();
        if (!this.switch().enabled)
            return;
        try {
            await this.sync.enforceLocal();
        }
        catch {
            /* Revocation enforcement retries on the first sync. */
        }
        settleInBackground(this.scheduler.trigger('startup'));
    }
    authContextChanged() {
        if (!this.started || this.closed || !this.switch().enabled)
            return;
        settleInBackground(this.scheduler.trigger('auth'));
    }
    /** The client switched or cleared its swim lane: ask the new lane now, not at the next poll. */
    laneChanged() {
        const lane = this.options.lane?.();
        if (lane === this.lastLane)
            return;
        this.lastLane = lane;
        if (!this.started || this.closed || !this.switch().enabled)
            return;
        settleInBackground(this.scheduler.trigger('lane'));
    }
    async syncNow() {
        if (this.closed)
            return;
        if (!this.switch().enabled)
            return;
        await this.scheduler.trigger('manual');
    }
    /** Developer Tools switch; persisted per profile, ignored while the env variable is set. */
    async setOptIn(enabled) {
        await this.options.host.updateRemoteDelivery((current) => ({ ...current, optIn: enabled }));
        this.options.refresh();
        if (!this.started)
            return;
        if (this.switch().enabled) {
            try {
                await this.sync.enforceLocal();
            }
            catch {
                /* Retried by the sync below. */
            }
            settleInBackground(this.scheduler.trigger('manual'));
        }
    }
    status() {
        const state = this.options.host.remoteDelivery();
        const { enabled, source } = this.switch();
        return {
            available: true,
            enabled,
            switchSource: source,
            ...(state.sequence !== undefined ? { sequence: state.sequence } : {}),
            ...(state.environment ? { environment: state.environment } : {}),
            ...(state.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}),
            ...(state.lastErrorCode ? { lastErrorCode: state.lastErrorCode } : {}),
            ...(state.nextRetryAt !== undefined ? { nextRetryAt: state.nextRetryAt } : {}),
        };
    }
    async close() {
        this.closed = true;
        await this.scheduler.close();
    }
    async record(outcome) {
        await this.options.host.updateRemoteDelivery((current) => {
            const rest = { ...current };
            delete rest.lastErrorCode;
            return {
                ...rest,
                ...(outcome.success ? { lastSuccessAt: outcome.at } : {}),
                ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
                nextRetryAt: outcome.nextAt,
            };
        });
    }
}
//# sourceMappingURL=delivery.js.map