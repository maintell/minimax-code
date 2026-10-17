const DEFAULT_ARRIVAL_TIMEOUT_MS = 1500;
function finitePoint(point) {
    return Number.isFinite(point.x) && Number.isFinite(point.y);
}
/**
 * Owns the main-process cursor state and the foreground arrival barrier.
 *
 * Rendering is delegated to a fixed isolated-world control object. Arrival
 * receipts are advisory only: bridge failures and timeouts never prevent the
 * real browser input from being dispatched.
 */
export class AgentCursorController {
    constructor(options) {
        this.state = {
            x: 0,
            y: 0,
            visible: false,
            animateMovement: false,
            moveSequence: 0,
        };
        this.pending = null;
        this.evaluate = options.evaluate;
        this.isEnabled = options.isEnabled ?? (() => true);
        this.isVisible = options.isVisible;
        this.identity = options.identity;
        this.arrivalTimeoutMs = options.arrivalTimeoutMs ?? DEFAULT_ARRIVAL_TIMEOUT_MS;
        this.diagnose = options.diagnose ?? (() => undefined);
    }
    async prepareMove(point, options) {
        if (!finitePoint(point))
            throw new Error('Agent cursor coordinates must be finite');
        if (!this.isEnabled()) {
            if (this.state.visible)
                await this.hide();
            return;
        }
        const identity = this.identity();
        const foreground = Boolean(identity && this.isVisible());
        const animateMovement = foreground && options.animate;
        const waitForArrival = foreground && animateMovement && options.waitForArrival !== false;
        const moveSequence = this.state.moveSequence + 1;
        this.state = {
            ...point,
            visible: true,
            animateMovement,
            moveSequence,
        };
        this.cancelPending();
        let arrival = null;
        if (waitForArrival && identity) {
            arrival = new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.pending?.moveSequence !== moveSequence)
                        return;
                    this.pending = null;
                    this.diagnose('arrival-timeout');
                    resolve();
                }, this.arrivalTimeoutMs);
                this.pending = { ...identity, moveSequence, resolve, timeout };
            });
        }
        const delivered = await this.send({
            type: 'move',
            ...this.state,
            ...(identity ?? {}),
        });
        if (!delivered) {
            this.cancelPending();
            this.diagnose('bridge-unavailable');
            return;
        }
        await arrival;
    }
    handleArrival(arrival) {
        const pending = this.pending;
        if (!pending ||
            pending.sessionId !== arrival.sessionId ||
            pending.tabId !== arrival.tabId ||
            pending.moveSequence !== arrival.moveSequence) {
            return false;
        }
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.resolve();
        return true;
    }
    async hide() {
        this.cancelPending();
        if (!this.state.visible)
            return;
        this.state = { ...this.state, visible: false, animateMovement: false };
        await this.send({ type: 'hide', moveSequence: this.state.moveSequence });
    }
    async reset() {
        this.cancelPending();
        const wasVisible = this.state.visible;
        this.state = {
            x: 0,
            y: 0,
            visible: false,
            animateMovement: false,
            moveSequence: this.state.moveSequence,
        };
        if (!wasVisible)
            return;
        await this.send({ type: 'reset', moveSequence: this.state.moveSequence });
    }
    async withHiddenForCapture(capture) {
        const restore = { ...this.state };
        if (!restore.visible)
            return capture();
        await this.send({ type: 'hide', moveSequence: restore.moveSequence });
        try {
            return await capture();
        }
        finally {
            if (restore.visible) {
                await this.send({
                    type: 'move',
                    ...restore,
                    animateMovement: false,
                    restore: true,
                });
            }
        }
    }
    cancelPending() {
        const pending = this.pending;
        if (!pending)
            return;
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.resolve();
    }
    async send(command) {
        const script = `globalThis.__mavisEmbeddedBrowserAgentCursorControl?.dispatch(${JSON.stringify(command)}) === true`;
        try {
            const result = await this.evaluate(script);
            return result.success && result.result === true;
        }
        catch {
            return false;
        }
    }
}

