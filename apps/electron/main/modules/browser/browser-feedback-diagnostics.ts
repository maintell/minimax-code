import { browserBackendPolicy } from "./browser-backend-policy.js";
import { browserGuestRegistry } from "./browser-guest-registry.js";
import { browserTelemetry } from "./browser-telemetry-runtime.js";
function safe(read, fallback) {
    try {
        return read();
    }
    catch {
        return fallback;
    }
}
/**
 * Builds the Browser section of a user feedback upload. Includes the page host
 * (never path or query) because it is only uploaded with the user's consent.
 */
export async function collectBrowserFeedbackDiagnostics(sources) {
    const now = sources.now?.() ?? Date.now();
    browserTelemetry.sampleResources('feedback');
    const policy = safe(() => browserBackendPolicy.diagnosticSnapshot(), null);
    const renderer = await safe(() => sources.requestRenderer
        ? sources.requestRenderer(sources.renderer?.())
        : Promise.resolve(null), Promise.resolve(null)).catch(() => null);
    const telemetry = safe(() => browserTelemetry.snapshot(), null);
    return {
        schemaVersion: 1,
        generatedAt: now,
        appVersion: sources.appVersion ?? null,
        platform: sources.platform ?? null,
        backend: policy
            ? {
                launchBackend: policy.launchBackend,
                launchSource: policy.launchSource,
                latestBackend: policy.latestBackend,
                pendingRestart: policy.launchBackend !== null &&
                    policy.latestBackend !== null &&
                    policy.latestBackend !== policy.launchBackend,
                policyRevision: policy.revision,
                configured: policy.configured,
                accountBound: policy.accountBound,
            }
            : 'unavailable',
        pages: safe(() => sources.pages?.() ?? [], 'unavailable'),
        guestHosts: safe(() => browserGuestRegistry.diagnostics(), 'unavailable'),
        resources: telemetry?.lastResources ?? null,
        renderer: renderer ?? 'unavailable',
        session: telemetry?.sessions ?? 'unavailable',
        recentEvents: telemetry?.recentEvents ?? [],
    };
}
