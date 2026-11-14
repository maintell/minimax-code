/** @internal Route path shared with the wake route regression tests. */
export const QUOTA_AUTO_RESUME_WAKE_PATH = '/mavis/api/quota-auto-resume/wake';
/**
 * System wake: a suspended process does not advance its timers, so every stored
 * plan is recomputed against the wall clock before it can fire late. A body of
 * `{ "reason": "quota-reset" }` comes from a reset card restoring the quota early,
 * and continues every plan whose quota already has room. Mounted
 * before the legacy fallback so an uncomposed owner answers 503 instead of
 * falling through to the v1 handler.
 */
export function mountQuotaAutoResumeWakeRoute(app, quotaAutoResume) {
    app.post(QUOTA_AUTO_RESUME_WAKE_PATH, async (context) => {
        if (!quotaAutoResume) {
            return context.json({ ok: false, error: 'quota_auto_resume_unavailable' }, 503);
        }
        await quotaAutoResume.service.reconcile(await readWakeReason(context.req.raw));
        return context.json({ ok: true });
    });
}
/** The system-wake caller sends no body; only a reset card names `quota-reset`. */
async function readWakeReason(request) {
    try {
        const body = (await request.json());
        return body?.reason === 'quota-reset' ? 'quota-reset' : 'wake';
    }
    catch {
        return 'wake';
    }
}
//# sourceMappingURL=quota-auto-resume-wake.js.map