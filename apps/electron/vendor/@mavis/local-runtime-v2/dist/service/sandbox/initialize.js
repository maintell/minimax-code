import { getSandboxConfigDefaults } from '@mavis/config';
import { resolveBashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';
import { createSrtMacosBackend } from './backend/srt-macos.js';
import { createDeferredLocalSandboxBashOperationsFactory, createSandboxBashOperationsFactory, } from './deferred-port.js';
import { createSandboxEvalEventSink } from './observability/eval-adapter.js';
import { LocalSandboxService } from './local-sandbox-service.js';
const SRT_MACOS_BACKEND_DESCRIPTOR = Object.freeze({
    id: 'srt-macos',
    platform: 'darwin',
    priority: 100,
    create: () => createSrtMacosBackend(),
});
export function composeLocalSandboxService(input) {
    const config = input.sandboxConfig ?? getSandboxConfigDefaults(input.platform ?? process.platform);
    const operationsFactory = input.sandboxOperationsFactory ??
        createDeferredLocalSandboxBashOperationsFactory(() => config.enabled, 
        // Production always injects a shim-aware factory via runtime.ts, so this
        // fallback only serves tests/embedders. The v2 service layer must not
        // import v1 runtime values (depcruise: v1-runtime-values-only-runtime-or-index),
        // so the shim PATH policy cannot be resolved here.
        resolveBashEnvPolicy());
    return initializeLocalSandboxService({
        config,
        operationsFactory,
        configWriter: input.configWriter,
        eventSink: input.eventSink ?? createSandboxEvalEventSink(input.evalReporter),
        log: input.log ?? ((event) => input.logger?.info({ ...event }, event.event_type)),
        ...(input.metrics
            ? {
                metrics: {
                    counter: (name, delta, labels) => input.metrics?.counter(name, delta, labels),
                    histogram: (name, value, labels) => input.metrics?.histogram(name, value, labels),
                    gauge: (name, value) => input.metrics?.gauge?.(name, value),
                },
            }
            : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.sandboxDescriptors ? { descriptors: input.sandboxDescriptors } : {}),
    });
}
function initializeLocalSandboxService(input) {
    const service = new LocalSandboxService({
        config: input.config,
        configWriter: input.configWriter,
        observability: { metrics: input.metrics, eventSink: input.eventSink, log: input.log },
        ...(input.nowMs ? { now: input.nowMs } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        descriptors: input.descriptors ?? [SRT_MACOS_BACKEND_DESCRIPTOR],
    });
    input.operationsFactory.bind(createSandboxBashOperationsFactory(service));
    return service;
}
//# sourceMappingURL=initialize.js.map