import { normalizeTakeoverPillAppearance } from "./agent-takeover-pill-bridge";
/** Minimum gap between repeated `show` refreshes while the user keeps hovering. */
export let TAKEOVER_PILL_REFRESH_MS = 250;
/** Grace after the pointer leaves the page, so a quick exit and return does not flicker. */
export let TAKEOVER_PILL_HIDE_DELAY_MS = 300;
/**
 * Main-side state of the takeover pill. It shows while the user hovers the
 * web page the Agent controls and disappears once the pointer leaves or the
 * Agent no longer holds that page. The press on its button is a trusted mouse
 * event seen here, so the takeover never depends on page script.
 */
export class EmbeddedBrowserTakeoverPill {
    constructor(deps) {
        this.deps = deps;
        this.appearance = null;
        this.states = new Map();
    }
    /** Renderer-resolved theme and copy. Returns false when the payload is rejected. */
    setAppearance(value) {
        const appearance = normalizeTakeoverPillAppearance(value);
        if (!appearance)
            return false;
        this.appearance = appearance;
        for (const tabId of this.states.keys()) {
            const tab = this.deps.getTab(tabId);
            if (tab && this.deps.isEligible(tab))
                this.show(tab, this.states.get(tabId));
        }
        return true;
    }
    noteUserHover(tab) {
        if (!this.appearance || typeof tab.sessionId !== 'string' || !this.deps.isEligible(tab))
            return;
        const existing = this.states.get(tab.tabId);
        const state = existing ?? {
            lastShowAt: 0,
            pointerOnAction: false,
            swallowMouseUp: false,
            hideTimer: null,
        };
        if (!existing)
            this.states.set(tab.tabId, state);
        if (state.hideTimer)
            clearTimeout(state.hideTimer);
        state.hideTimer = null;
        if (existing && this.now() - state.lastShowAt < TAKEOVER_PILL_REFRESH_MS)
            return;
        this.show(tab, state);
    }
    noteUserLeave(tab) {
        const state = this.states.get(tab.tabId);
        if (!state)
            return;
        state.pointerOnAction = false;
        if (state.hideTimer)
            clearTimeout(state.hideTimer);
        state.hideTimer = setTimeout(() => this.dismiss(tab.tabId), TAKEOVER_PILL_HIDE_DELAY_MS);
    }
    /** Page report: the pointer entered or left the pill's take-over button. */
    notePointerOnAction(tab, inside) {
        const state = this.states.get(tab.tabId);
        if (state)
            state.pointerOnAction = inside && this.deps.isEligible(tab);
    }
    /**
     * A user press on the take-over button. The caller blocks the press and
     * takes over; the matching release is swallowed too, so the page never
     * sees half a click.
     */
    claimActionPress(tab) {
        const state = this.states.get(tab.tabId);
        if (!state?.pointerOnAction || !this.deps.isEligible(tab))
            return false;
        state.pointerOnAction = false;
        state.swallowMouseUp = true;
        return true;
    }
    consumeSwallowedMouseUp(tab) {
        const state = this.states.get(tab.tabId);
        if (!state?.swallowMouseUp)
            return false;
        state.swallowMouseUp = false;
        if (!this.deps.isEligible(tab))
            this.forget(tab.tabId);
        return true;
    }
    /** Hide the pill on every tracked page the user is no longer locked out of. */
    sync() {
        for (const tabId of [...this.states.keys()]) {
            const tab = this.deps.getTab(tabId);
            if (!tab || !this.deps.isEligible(tab))
                this.dismiss(tabId, { keepSwallow: true });
        }
    }
    dismiss(tabId, options) {
        const state = this.states.get(tabId);
        if (!state)
            return;
        if (state.hideTimer)
            clearTimeout(state.hideTimer);
        state.hideTimer = null;
        state.pointerOnAction = false;
        if (options?.keepSwallow && state.swallowMouseUp) {
            // Keep the entry only to swallow the release of the take-over press.
            state.lastShowAt = 0;
        }
        else {
            this.states.delete(tabId);
        }
        void this.deps
            .getTab(tabId)
            ?.controller.hideTakeoverPill?.({ immediate: options?.immediate === true })
            .catch(() => undefined);
    }
    forget(tabId) {
        const state = this.states.get(tabId);
        if (state?.hideTimer)
            clearTimeout(state.hideTimer);
        this.states.delete(tabId);
    }
    show(tab, state) {
        const appearance = this.appearance;
        if (!appearance || typeof tab.sessionId !== 'string')
            return;
        state.lastShowAt = this.now();
        void tab.controller
            .showTakeoverPill?.({ sessionId: tab.sessionId, tabId: tab.tabId, appearance })
            .catch(() => undefined);
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
}

