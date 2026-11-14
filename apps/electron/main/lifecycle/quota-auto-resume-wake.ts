/**
 * A suspended process does not advance its timers, so a plan whose reset time
 * passed while the machine slept would fire against a stale clock. Resume asks
 * the Runtime to recompute every stored plan against the wall clock.
 *
 * Best effort: the caller logs whatever this reports and carries on, because a
 * wake that fails leaves the plans for the next wake or restart.
 */
export async function reconcileQuotaAutoResumePlansAfterResume(invoke) {
    const response = await invoke(new Request('http://127.0.0.1/mavis/api/quota-auto-resume/wake', { method: 'POST' }));
    if (!response.ok) {
        throw new Error(`Token Plan auto-resume wake failed with ${response.status}`);
    }
}
