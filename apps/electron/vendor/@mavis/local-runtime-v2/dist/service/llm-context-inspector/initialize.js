import { getRuntimeBuildEnv, isInternalBuild } from '@mavis/config';
import { createLlmCaptureRecorder, wrapResolvedFetchForCapture, } from './capture-recorder.js';
import { LlmContextInspectorHistoryStore } from './history-store.js';
import { LlmContextInspectorService } from './service.js';
/** Internal Electron builds, plus explicitly opted-in TUI processes, can capture. */
export function composeLlmContextInspector(options) {
    const forceCaptureEnabled = options.runtimeOwnerKind === 'tui' && process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR === '1';
    if (options.runtimeOwnerKind !== 'electron' && !forceCaptureEnabled)
        return undefined;
    const buildVariant = options.buildVariantOverride ?? resolveBuildVariant();
    if (buildVariant === 'unavailable' && !forceCaptureEnabled)
        return undefined;
    return composeAvailableInspector(options, buildVariant === 'unavailable' ? 'internal' : buildVariant, forceCaptureEnabled);
}
async function composeAvailableInspector(options, buildVariant, forceCaptureEnabled) {
    const store = new LlmContextInspectorHistoryStore({
        dataDir: options.dataDir,
        resolveSession: options.resolveSession,
        runtimeOwnerKind: options.runtimeOwnerKind === 'tui' ? 'tui' : 'electron',
    });
    const service = new LlmContextInspectorService(store, options.db, buildVariant, Date.now);
    await service.initialize(forceCaptureEnabled);
    return {
        service,
        createRecorder: (input) => createLlmCaptureRecorder({
            sessionId: input.sessionId,
            turnId: input.turnId,
            sink: {
                persistSettledCall: (record) => store.persistSettledCall(record),
                recordToolStarted: (event) => store.recordToolStarted(event),
                recordToolCompleted: (event) => store.recordToolCompleted(event),
            },
            captureState: () => service.captureState(),
            nowMs: Date.now,
        }),
        wrapResolvedFetch: wrapResolvedFetchForCapture,
    };
}
function resolveBuildVariant() {
    switch (getRuntimeBuildEnv()) {
        case 'dev':
            return 'dev';
        case 'test':
            return 'test';
        case 'staging':
            return 'internal';
        case 'prod':
            return isInternalBuild() ? 'internal' : 'unavailable';
        default:
            return 'unavailable';
    }
}
//# sourceMappingURL=initialize.js.map