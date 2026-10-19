import { getRuntimeBuildEnv } from '@mavis/config';
import { ContextUsageCalibrationCoordinator, } from '../context/context-usage-calibration.js';
import { HttpRemoteTokenCounter, } from '../context/remote-token-counter.js';
export function createContextUsageRuntime(options) {
    const calibrationCoordinator = new ContextUsageCalibrationCoordinator(options.contextUsageCalibrationCounter ??
        new HttpRemoteTokenCounter({
            timeoutMs: 3_000,
            ...(options.fetchImpl ? { fetchFn: options.fetchImpl } : {}),
        }));
    const providerDiagnosticCounter = getRuntimeBuildEnv() !== 'prod' &&
        (options.contextUsageProviderDiagnosticCounter ||
            process.env.MAVIS_CONTEXT_USAGE_PROVIDER_DIAGNOSTICS === '1')
        ? (options.contextUsageProviderDiagnosticCounter ??
            new HttpRemoteTokenCounter({
                timeoutMs: 10_000,
                ...(options.fetchImpl ? { fetchFn: options.fetchImpl } : {}),
            }))
        : undefined;
    return {
        ...(providerDiagnosticCounter ? { providerDiagnosticCounter } : {}),
        calibrationCoordinator,
        getCachedToolCalibration: (input) => calibrationCoordinator.getCachedToolCalibration(input),
    };
}
//# sourceMappingURL=context-usage-runtime.js.map