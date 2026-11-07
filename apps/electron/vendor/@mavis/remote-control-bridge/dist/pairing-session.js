import { describeBindingForLog } from './audit-redaction.js';
import { PairingClientError } from './pairing-client.js';
export const DEFAULT_PAIRING_POLL_INTERVAL_MS = 1_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 30;
const MIN_CODE_REISSUE_INTERVAL_MS = 5_000;
const STILL_PAIRING_LOG_INTERVAL_MS = 15_000;
/** Owns legacy pairing HTTP/polling attempts and their cancellation, not durable identity. */
export class RcPairingSession {
    opts;
    session;
    constructor(opts) {
        this.opts = opts;
    }
    isActive() {
        return this.session !== undefined;
    }
    invalidate() {
        const session = this.session;
        this.session = undefined;
        if (!session)
            return;
        if (session.timer)
            clearInterval(session.timer);
        session.controller.abort();
    }
    begin() {
        this.invalidate();
        const session = {
            controller: new AbortController(),
            userId: this.opts.getCurrentUserId(),
            busy: false,
            failures: 0,
            lastCodeIssueMs: 0,
            lastLogMs: 0,
        };
        this.session = session;
        return session;
    }
    isCurrent(session) {
        if (this.session !== session || session.controller.signal.aborted)
            return false;
        if (session.userId === this.opts.getCurrentUserId())
            return true;
        this.invalidate();
        return false;
    }
    async checkBinding() {
        const session = this.begin();
        try {
            this.opts.ensureIdentity();
            const info = await this.opts.client.getBinding(session.controller.signal);
            if (!this.isCurrent(session))
                return;
            this.opts.logger.info(`[rc.proxy] checkBinding: ${describeBindingForLog(info)}`);
            if (info.state === 'bound' && info.binding_id !== undefined)
                this.opts.acceptBinding(info, session.userId, false);
            else
                this.opts.publish({ phase: 'idle' });
        }
        catch (error) {
            if (!this.isCurrent(session))
                return;
            const { code, message } = pairingErrorInfo(error);
            this.opts.logger.warn(`[rc.proxy] checkBinding failed: ${code} ${message}`);
            this.opts.publish({ phase: 'idle' });
        }
        finally {
            if (this.session === session)
                this.invalidate();
        }
    }
    async requestCode() {
        const session = this.begin();
        try {
            this.opts.ensureIdentity();
            await this.issueCode(session);
            if (!this.isCurrent(session))
                return;
            session.timer = setInterval(() => {
                void this.poll(session);
            }, this.opts.pollIntervalMs ?? DEFAULT_PAIRING_POLL_INTERVAL_MS);
        }
        catch (error) {
            if (!this.isCurrent(session))
                return;
            const { code, message } = pairingErrorInfo(error);
            this.invalidate();
            this.opts.logger.error(`[rc.proxy] requestPairingCode failed: ${code} ${message}`);
            this.opts.publish({ phase: 'error', last_error: { code, message } });
        }
    }
    /** A superseded HTTP result cannot authorize clearing a newer local binding. */
    async unbind(bindingId, commit) {
        const session = this.begin();
        try {
            let result;
            try {
                result = await this.opts.client.unbind(bindingId, session.controller.signal);
            }
            catch (error) {
                if (!this.isCurrent(session))
                    return;
                this.opts.publish({
                    phase: 'error',
                    binding_id: bindingId,
                    last_error: pairingErrorInfo(error),
                });
                throw error;
            }
            if (!this.isCurrent(session))
                return;
            if (!result.ok) {
                const error = new PairingClientError('unbind_rejected', 'The server did not confirm unbinding');
                this.opts.publish({
                    phase: 'error',
                    binding_id: bindingId,
                    last_error: pairingErrorInfo(error),
                });
                throw error;
            }
            // Validation and durable publication share one synchronous commit point.
            // A disk error is still a failure even when commit invalidates this scope.
            commit();
        }
        finally {
            if (this.session === session)
                this.invalidate();
        }
    }
    async issueCode(session) {
        if (!this.isCurrent(session))
            return;
        const result = await this.opts.client.createPairingCode(session.controller.signal);
        if (!this.isCurrent(session))
            return;
        session.lastCodeIssueMs = Date.now();
        session.deadlineMs = Date.now() + result.expires_in_s * 1000;
        this.opts.logger.info(`[rc.proxy] pairing code issued (expires_in_s=${result.expires_in_s})`);
        this.opts.publish({
            phase: 'pairing',
            pairing_code: result.pairing_code,
            expires_in: result.expires_in_s,
        });
    }
    async poll(session) {
        if (!this.isCurrent(session) || session.busy)
            return;
        session.busy = true;
        try {
            const info = await this.opts.client.getBinding(session.controller.signal);
            if (!this.isCurrent(session))
                return;
            session.failures = 0;
            if (info.state === 'bound' && info.binding_id !== undefined) {
                this.opts.logger.info(`[rc.proxy] pairing confirmed: ${describeBindingForLog(info)}`);
                // Publish only after the coordinator's durable write succeeds.
                this.opts.acceptBinding(info, session.userId, true);
                if (this.session === session)
                    this.invalidate();
                return;
            }
            if (info.expires_at_ms !== undefined)
                session.deadlineMs = info.expires_at_ms;
            const expired = session.deadlineMs !== undefined && Date.now() >= session.deadlineMs;
            if (info.state === 'none' || expired) {
                if (Date.now() - session.lastCodeIssueMs >= MIN_CODE_REISSUE_INTERVAL_MS)
                    await this.issueCode(session);
                return;
            }
            const remaining = session.deadlineMs === undefined
                ? undefined
                : Math.max(0, Math.round((session.deadlineMs - Date.now()) / 1000));
            if (Date.now() - session.lastLogMs >= STILL_PAIRING_LOG_INTERVAL_MS) {
                session.lastLogMs = Date.now();
                this.opts.logger.debug(`[rc.proxy] pairing still pending state=${info.state ?? 'unknown'} remaining_s=${remaining ?? 'unknown'}`);
            }
            // Preserve the code while refreshing only its countdown.
            if (remaining !== undefined)
                this.opts.publish({ phase: 'pairing', expires_in: remaining });
        }
        catch (error) {
            if (!this.isCurrent(session))
                return;
            const { code, message } = pairingErrorInfo(error);
            session.failures += 1;
            this.opts.logger.warn(`[rc.proxy] pairing poll failure ${session.failures}/${MAX_CONSECUTIVE_POLL_FAILURES}: ${code}`);
            if (code === 'token_expired' ||
                code === 'not_authenticated' ||
                session.failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                this.invalidate();
                this.opts.publish({ phase: 'error', last_error: { code, message } });
            }
        }
        finally {
            session.busy = false;
        }
    }
}
export function pairingErrorInfo(error) {
    if (error instanceof PairingClientError)
        return { code: error.code, message: error.message };
    return {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
    };
}
//# sourceMappingURL=pairing-session.js.map