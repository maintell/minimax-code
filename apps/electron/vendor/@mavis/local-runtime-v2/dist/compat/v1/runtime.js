import { createDeferredPluginHookPermissionCapability, } from '@mavis/permission/plugin-hook-permission-port';
import { createDeferredContentSafetyCapability } from '@mavis/shared/local-runtime-safety';
import { createDeferredSkillRuntimeCapability } from '@mavis/shared/local-runtime-skills';
import { emitSubagentTelemetry, roleClass, SUBAGENT_TELEMETRY_EVENT, } from '../../service/agent/index.js';
import { createV1CronAgentCleanupBridge, createV1MavisCronAdapterBridge } from './cron.js';
/** These bridges carry references only. Host composition creates and owns every service. */
export function createV1RuntimeBridges(conversation) {
    return {
        cron: createV1MavisCronAdapterBridge(),
        cronAgentCleanup: createV1CronAgentCleanupBridge(),
        events: createDeferredGlobalEventPublisher(),
        mcp: createDeferredMcpRuntimeCapability(),
        skill: createDeferredSkillRuntimeCapability(),
        pluginHookPermissions: createDeferredPluginHookPermissionCapability(),
        safety: createDeferredContentSafetyCapability(),
        conversation,
    };
}
function createDeferredGlobalEventPublisher() {
    let publisher;
    return {
        publish: (event) => publisher?.(event),
        bindPublisher: (next) => {
            publisher = next;
            return () => {
                if (publisher === next)
                    publisher = undefined;
            };
        },
    };
}
/** Old consumers borrow the V2 MCP owner; this bridge has no settings, pool or registry. */
function createDeferredMcpRuntimeCapability() {
    let current;
    const requireOwner = () => {
        if (!current)
            throw new Error('MCP runtime is not initialized or has been closed');
        return current;
    };
    return {
        capability: {
            isBuiltinMatrixAvailable: () => requireOwner().isBuiltinMatrixAvailable(),
            readConfiguredServerNames: () => requireOwner().readConfiguredServerNames(),
            createMavisAdapter: (emit) => requireOwner().createMavisAdapter(emit),
            listToolEntriesForTurn: (input) => requireOwner().listToolEntriesForTurn(input),
        },
        bind: (value) => {
            if (current)
                throw new Error('MCP runtime is already bound');
            current = value;
            return () => {
                if (current === value)
                    current = undefined;
            };
        },
    };
}
/** Agent facts emitted before binding or after close remain best-effort. */
export function createDeferredAgentRuntimeTelemetry() {
    let sink;
    let closed = false;
    return {
        facts: {
            onNameCompatResolve: (fact) => emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.nameCompatResolve, {
                intent: fact.intent,
                canonical_class: fact.canonicalClass,
                source: fact.source,
                success: fact.success,
                ...(fact.memberCountBucket ? { member_count_bucket: fact.memberCountBucket } : {}),
                ...(fact.errorCode ? { error_code: fact.errorCode } : {}),
            }),
            onAgentRoleObservation: (fact) => emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.agentRoleObservation, {
                status: fact.status,
                source: fact.source,
                role_class: roleClass(fact.role),
            }),
            onPrimaryProfileOverlay: (fact) => emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.primaryProfileOverlay, {
                outcome: fact.outcome,
                adopted_fields: fact.adoptedFields.join(','),
                adopted_count: fact.adoptedFields.length,
                display_name_locked: fact.displayNameLocked,
            }),
        },
        bind: (input) => {
            if (closed)
                return;
            const client = input.metricsClient;
            sink = {
                metrics: {
                    incr: (name, labels) => client.counter(name, 1, labels),
                    gauge: (name, value, labels) => client.gauge(name, value, labels),
                    latency: (name, durationMs, labels) => client.histogram(name, durationMs, labels),
                },
                ...(input.emitBusEvent ? { emitBusEvent: input.emitBusEvent } : {}),
            };
        },
        close: () => {
            closed = true;
            sink = undefined;
        },
    };
}
//# sourceMappingURL=runtime.js.map