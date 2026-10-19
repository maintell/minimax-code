/**
 * Power Management Module
 *
 * Owns the lifecycle of Electron's `powerSaveBlocker` assertion(s). The
 * effective assertion is derived from two independent inputs:
 *
 * - `keepAwakeEnabled` — user-controlled toggle (`config.keepAwake`).
 * - `computerUseActive` — true while an eligible Turn may drive the screen,
 *   so the display must NOT sleep.
 *
 * Effective mode table (see `computeMode`):
 *
 *   keepAwake | cuActive | mode
 *   ----------|----------|-------------------------
 *   false     |  false   | 'off'           (no assertion)
 *   false     |  true    | 'display-sleep' (CU must keep screen awake;
 *                                          user's keepAwake=false
 *                                          intent is overridden while
 *                                          CU is steering the desktop)
 *   true      |  false   | 'app-suspension' (background agent / IM;
 *                                            screen may still dim/sleep)
 *   true      |  true    | 'display-sleep'  (both keep app awake AND
 *                                            prevent screen sleep)
 *
 * Invariants enforced by `reconcile`:
 *   1. Mode switches start the new assertion BEFORE stopping the old one
 *      so the process never holds zero assertions during the transition
 *      (avoids a momentary gap where the OS could decide to sleep).
 *   2. Same-mode reconciliation is a no-op — no churn on the underlying
 *      `powerSaveBlocker` id.
 *   3. `'off'` releases all assertions; subsequent re-enable starts a
 *      fresh id.
 *
 * Callers MUST NOT touch `electron.powerSaveBlocker` directly — go
 * through `setKeepAwakeEnabled` / `setComputerUseActive`. The legacy
 * `start/stop/isActive` helpers have been removed; there is no
 * compatibility wrapper.
 */

import { powerSaveBlocker } from "electron";
import logger from "../../utils/logger";
// Module-level state — single source of truth for the reconciler.
const state = {
    keepAwakeEnabled: false,
    computerUseActive: false,
};
let currentMode = 'off';
let currentBlockerId = null;
/**
 * Derive the effective `powerSaveBlocker` mode from the two inputs.
 *
 * CU active forces `'display-sleep'` regardless of `keepAwakeEnabled`,
 * because CU is actively driving the mouse/keyboard/screen — letting
 * the display sleep mid-action breaks user-visible behavior even more
 * than the user's stated "let me sleep" preference.
 */
function computeMode(input) {
    if (input.computerUseActive)
        return 'display-sleep';
    if (input.keepAwakeEnabled)
        return 'app-suspension';
    return 'off';
}
/**
 * Reconcile the OS-level assertion to match the effective mode.
 *
 * Order matters: start the new assertion FIRST, then stop the old one,
 * so the process is never in a zero-assertion state during the swap.
 * If the new mode is `'off'`, we just stop the current id (no new
 * assertion to acquire).
 */
function reconcile() {
    const nextMode = computeMode(state);
    if (nextMode === currentMode) {
        // Same mode — no churn. Common during repeated identical setter
        // calls (e.g. UI re-emit on focus, daemon echo).
        return;
    }
    let nextBlockerId = null;
    if (nextMode !== 'off') {
        const electronType = nextMode === 'app-suspension' ? 'prevent-app-suspension' : 'prevent-display-sleep';
        try {
            nextBlockerId = powerSaveBlocker.start(electronType);
            logger.info(`[Power] Started ${nextMode} blocker (id: ${nextBlockerId})`);
        }
        catch (error) {
            logger.error(`[Power] Failed to start ${nextMode} blocker: ${error}`);
            // Bail out — leave the previous assertion in place rather than
            // dropping into 'off' silently. Next setter call will retry.
            return;
        }
    }
    // Release the old assertion AFTER the new one is held. If start()
    // above threw, we returned early and the old one is still active.
    if (currentBlockerId !== null) {
        try {
            if (powerSaveBlocker.isStarted(currentBlockerId)) {
                powerSaveBlocker.stop(currentBlockerId);
                logger.info(`[Power] Stopped ${currentMode} blocker (id: ${currentBlockerId})`);
            }
        }
        catch (error) {
            // Log but don't throw — the new assertion (if any) is already
            // held; failing to release the old one is a leak, not a safety
            // issue, and Electron normally cleans them up on app exit.
            logger.error(`[Power] Failed to stop ${currentMode} blocker: ${error}`);
        }
    }
    currentMode = nextMode;
    currentBlockerId = nextBlockerId;
}
/**
 * Set the user's keep-awake preference (mirrors `config.keepAwake`).
 *
 * Idempotent: passing the current value reconciles to the same mode
 * (no-op at the OS layer).
 */
export function setKeepAwakeEnabled(enabled) {
    state.keepAwakeEnabled = enabled;
    reconcile();
}
/**
 * Set the Computer Use active flag.
 *
 * Called only from Electron main's CUA utility lifecycle. The sibling driver
 * reports its authoritative in-flight request count; renderer state must never
 * write this flag. Idempotent repeated values are a no-op at the OS layer.
 */
export function setComputerUseActive(active) {
    state.computerUseActive = active;
    reconcile();
}
/**
 * Release all power save assertions held by this module. Called on
 * app quit so the OS doesn't think we're still pinning the system
 * awake after the process exits (Electron normally cleans up, but
 * being explicit makes shutdown traces easier to read).
 */
export function stopPowerSaveBlocker() {
    state.keepAwakeEnabled = false;
    state.computerUseActive = false;
    reconcile();
}
/**
 * Test-only inspector: report the effective mode currently held.
 * Production code should not branch on this — always go through the
 * setters and let the reconciler do the work.
 */
export function getCurrentPowerSaveMode() {
    return currentMode;
}
