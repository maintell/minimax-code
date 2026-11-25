import { createAgentRuntime } from '@mavis/agent-runtime';
import { ContextCompactionAttemptFactory } from '../../agent-host/compaction/context-compaction.js';
import { assertAgentHostCapabilityAvailable } from '../../agent-host/empty-dependencies.js';
import { RequiredAgentEventDelivery } from '../../agent-host/events/required-agent-event-delivery.js';
import { DurableCanonicalHistoryStore, } from '../../agent-host/history/durable-canonical-history-store.js';
import { LocalPluginHooks } from '../../agent-host/assembly/local-turn-plugin-hooks.js';
import { disposePtcCompactionReminderSession } from '../../agent-host/execution/ptc/compaction-reminder.js';
import { PtcPrefixBaselines } from '../../agent-host/runner/observability/ptc-prefix-fingerprint.js';
import { disposeToolSearchSession } from '../../agent-host/tools/tool-search.js';
import { disposeSkillCatalogSession } from '../../agent-host/tools/skill-catalog-window.js';
import { resetPromptSectionBaseline } from '../../agent-host/runner/observability/prompt-section-change.js';
import { ContextUsageAnchorState, createCompactionTriggerAtGetter, } from '../../compaction/index.js';
import { ActiveRunScopes } from './active-runs.js';
import { CompactionMetrics } from './compaction-metrics.js';
import { withDefaultExtensions } from './default-extensions.js';
/**
 * State one harness instance keeps across runs. Ordering state is memoized
 * per Host port object (WeakMap by identity), so it lives exactly as long as
 * the Host keeps that port and is never shared between two ports.
 */
export class HarnessInstanceState {
    dependencies;
    /** Scopes of the runs in flight; extensions read run capabilities through it. */
    runs = new ActiveRunScopes();
    usageAnchor = new ContextUsageAnchorState();
    compactionAttempts = new ContextCompactionAttemptFactory();
    /** Compaction metrics; attempt start times are kept across this instance's runs. */
    compactionMetrics = new CompactionMetrics();
    compactionTriggerAt;
    /** One Plugin Hook coordinator shared by every run, compaction and Session action. */
    pluginHooks;
    ptcPrefixBaselines = new PtcPrefixBaselines();
    histories = new WeakMap();
    deliveries = new WeakMap();
    extensions;
    runtime;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.compactionTriggerAt = createCompactionTriggerAtGetter(dependencies.compaction.compactionTriggerAt, dependencies.observability?.logger);
        this.pluginHooks = new LocalPluginHooks(dependencies.pluginHooks);
        // Built with the instance: an extension may read Host config once when it is created.
        this.extensions = withDefaultExtensions(dependencies.extensions?.(this.runs) ?? [], dependencies, this.runs);
    }
    /** The normal-turn Agent runtime, initialized on first use. */
    agentRuntime() {
        this.runtime ??= createAgentRuntime({ base: this.extensions });
        return this.runtime;
    }
    history(provider) {
        return memo(this.histories, provider, () => new DurableCanonicalHistoryStore(provider));
    }
    /** Required event delivery; it also settles history failures. */
    events(ports) {
        assertAgentHostCapabilityAvailable('history-failure-projector', typeof ports?.historyFailures?.projectHistoryFailure === 'function');
        return memo(this.deliveries, ports, () => new RequiredAgentEventDelivery(ports));
    }
    async disposeSession(sessionId) {
        this.ptcPrefixBaselines.reset(sessionId);
        this.usageAnchor.reset(sessionId);
        resetPromptSectionBaseline(sessionId);
        // Process-wide Session state of Tool Search, the skill catalog window and the PTC compaction reminder.
        disposeToolSearchSession(sessionId);
        disposeSkillCatalogSession(sessionId);
        disposePtcCompactionReminderSession(sessionId);
        await Promise.all([
            this.disposeRuntimeSession(sessionId),
            this.dependencies.pools.disposeSession(sessionId),
        ]);
    }
    /**
     * Releases what the instance owns: its Plugin Hook coordinator. The Host's
     * pools and extensions stay with the Host.
     */
    async release() {
        await this.pluginHooks.dispose();
    }
    async disposeRuntimeSession(sessionId) {
        let runtime;
        try {
            runtime = await this.runtime;
        }
        catch {
            // A runtime that failed to initialize holds no Session state.
            return;
        }
        runtime?.disposeSession(sessionId);
    }
}
function memo(cache, key, create) {
    let value = cache.get(key);
    if (value === undefined) {
        value = create();
        cache.set(key, value);
    }
    return value;
}
//# sourceMappingURL=instance-state.js.map