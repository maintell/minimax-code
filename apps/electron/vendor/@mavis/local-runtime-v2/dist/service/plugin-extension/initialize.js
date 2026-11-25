import path from 'node:path';
import { EXTENSION_DEV_ROOT_SEGMENTS } from '@mavis/permission';
import { createSiteTable } from '@mavis/shared/plugin-extension';
import { isObserveEventName, matchesObserveHook, } from './sdk/contracts/events.js';
import { settleInBackground } from '../../infra/async/settle.js';
import { logger } from '../../infra/logging/logger.js';
import { computePluginDirectoryDigest } from '../plugin-system/index.js';
import { ExtensionAuthoringService } from './authoring/authoring.service.js';
import { refreshPreviewEditorTypes, setSeededBuiltinSkillsDir } from './authoring/editor-types.js';
import { createTestWorkerFactory } from './authoring/testing/file-supervisor.js';
import { ExtensionServiceError } from './errors.js';
import { isJsonObject, toJsonText } from './json-value.js';
import { ExtensionHost } from './host/host.js';
import { createNodeWorkerFactory } from './host/supervisor.js';
import { InstalledExtensionTier } from './installed-tier.js';
import { ExtensionLifecycle } from './lifecycle.js';
import { ExtensionTurnObserver } from './turn-observer.js';
import { ExtensionActivations } from './preview/activations.js';
import { PreviewBindingService } from './preview/binding.service.js';
import { ExtensionPreviewFindings } from './preview/findings.js';
import { HostActivationSync } from './preview/host-sync.js';
import { createExtensionPreviewPort } from './preview/preview-port.js';
import { ExtensionPreviewService } from './preview/preview.service.js';
import { ExtensionTurnEnd } from './preview/turn-end.js';
import { CallBoundary, loggerAuditSink } from './services/call-boundary.js';
import { ExtensionMcpCallService } from './services/mcp/call.service.js';
import { ExtensionAgentService } from './services/agent.service.js';
import { ExtensionModelCompleteService } from './services/model-complete.service.js';
import { createLocalMcpPermissionDecider } from './services/mcp/permission.adapter.js';
import { ExtensionQueryService } from './services/query.service.js';
import { ExtensionSessionUsageService } from './services/session-usage.service.js';
import { ExtensionStateService } from './services/state.service.js';
import { ExtensionStoreService } from './services/store.service.js';
import { ExtensionPaneRoster, ExtensionUiService } from './services/ui.service.js';
import { ExtensionRendererSurfaceService } from './renderer-surface.js';
import { computeExtensionSourceDigest, discardExtensionCandidates } from './workspace/candidate.js';
import { ExtensionDevDirectories } from './workspace/dev-directory.js';
import { currentCompilerFingerprint, validateExtensionSource } from './workspace/validate.js';
export function initializePluginExtension(options, overrides = {}) {
    setSeededBuiltinSkillsDir(options.builtinSkillsDir);
    const v2 = path.join(options.dataDir, 'v2');
    const candidatesRoot = path.join(v2, 'plugin-dev', '.candidates');
    const nowMs = overrides.nowMs ?? Date.now;
    const siteTable = overrides.siteTable ?? createSiteTable();
    const { stream, subscribe, clear } = createStreamHub(overrides.stream);
    const activations = new ExtensionActivations();
    const invocations = new HostInvocationTable();
    const panes = new ExtensionPaneRoster();
    const audit = overrides.audit ?? loggerAuditSink;
    const services = createCtxServices({
        options,
        overrides,
        stream,
        panes,
        boundary: new CallBoundary(invocations, audit),
        invocations,
        diagnose: (entry) => host.diagnose(entry),
        nowMs,
        listensToMeasure: (sessionId) => measureListenerSignature(hostSync, sessionId),
        dispatchMeasure: (sessionId, payload) => {
            // Installed records reach a session the renderer has not listed yet.
            hostSync.list(sessionId);
            return host.observe({ sessionId, event: 'session.measure', payload, match: {} });
        },
    });
    const host = new ExtensionHost({
        services: bindHostPort(services, invocations, stream, options.sessionFacts),
        sites: siteTable.slots.flatMap((slot) => siteTable.get(slot) ?? []),
        workerFactory: createNodeWorkerFactory(overrides.workerEntry),
        log: logger,
    });
    const hostSync = new HostActivationSync(host, activations, (sessionId, identity) => services.store.disposeActivation(activationIdOf(sessionId, identity)), 
    // Open windows close the tabs now; a window that subscribes later gets the roster's snapshot.
    (sessionId, pluginId) => {
        for (const { id } of panes.withdraw(sessionId, pluginId)) {
            stream.emit({ type: 'ui.close', sessionId, pluginId, id });
        }
    });
    const validate = (request) => validateExtensionSource({ ...request, candidatesRoot, siteTable });
    const bindings = new PreviewBindingService(options.db, nowMs);
    const devDirectories = new ExtensionDevDirectories(path.join(options.dataDir, ...EXTENSION_DEV_ROOT_SEGMENTS));
    // A changed record reaches the host's session activations at once.
    const refresh = (event) => {
        if (event.type === 'entries-changed')
            hostSync.refresh(event.sessionId);
        stream.emit(event);
    };
    const findings = new ExtensionPreviewFindings();
    // Only a session's turn-terminal event reloads its previews (`onTurnEnded`).
    const turns = new ExtensionTurnEnd({
        reloadSession: (sessionId) => preview.reloadSession(sessionId),
        findings,
        nowMs,
    });
    // A revision goes live only after its module loaded and `register` ran in the host.
    const prepare = (activation) => hostSync.prepare(activation);
    const preview = new ExtensionPreviewService({
        validate,
        sourceDigest: computeExtensionSourceDigest,
        snapshotDigest: async (root) => (await computePluginDirectoryDigest(root, { rejectHardlinks: true })).contentDigest,
        compilerFingerprint: currentCompilerFingerprint,
        prepare,
        bindings,
        activations,
        devDirectories,
        names: options.names,
        emit: refresh,
        nowMs,
        overlay: options.sessionOverlay,
        onOverlayFindings: (activation, overlay) => findings.overlay(activation.sessionId ?? '', activation.pluginId, activation.artifactDigest, overlay),
        refreshEditorTypes: (sourceDir) => refreshPreviewEditorTypes(sourceDir, path.join(options.dataDir, 'plugins')),
        onEditorTypes: (activation, failure) => findings.editorTypes(activation.sessionId ?? '', activation.pluginId, activation.artifactDigest, failure),
    });
    const surface = new ExtensionRendererSurfaceService({
        host,
        sites: siteTable,
        listActivations: (sessionId) => hostSync.list(sessionId),
        subscribe,
        panes,
        audit,
        answerQuery: (input) => services.query.answer(input),
        sessionExists: options.sessionExists,
        nowMs,
    });
    // The published plugin snapshot is the only source of the installed tier.
    const installedTier = new InstalledExtensionTier({
        source: options.installed,
        validate,
        activations,
        bindings,
        store: services.store.kv,
        withdrawPreview: (sessionId, pluginId, boundDigest) => preview.yieldToInstalled(sessionId, pluginId, boundDigest),
        emit: refresh,
        nowMs,
        prepare,
    });
    installedTier.start();
    const authoring = new ExtensionAuthoringService({
        devRoot: devDirectories.root,
        validate,
        sourceDigest: computeExtensionSourceDigest,
        host,
        sites: siteTable,
        testWorker: { factory: createTestWorkerFactory(overrides.testWorkerEntry) },
        preview: createExtensionPreviewPort({
            preview,
            activations,
            findings,
        }),
    });
    const lifecycle = new ExtensionLifecycle({
        bindings,
        preview,
        installedTier,
        devDirectories,
        store: services.store.kv,
        deleteSessionState: async (sessionId) => {
            findings.deleteSession(sessionId);
            surface.deleteSession(sessionId);
            services.query.abortSession(sessionId);
            hostSync.deleteSession(sessionId);
            services.state.deleteSession(sessionId);
            services.session.deleteSession(sessionId);
            await services.store.kv.discardSession(sessionId);
        },
        sessionExists: options.sessionExists,
        candidatesRoot,
        discardCandidates: (roots) => discardExtensionCandidates(candidatesRoot, roots),
    });
    const turnObserver = new ExtensionTurnObserver({
        sessionParent: options.sessionParent,
        anyObserver: () => [...activations.list(''), ...activations.allPreviews()].some(registersObserveEvent),
        observes: (sessionId) => activations.list(sessionId).some(registersObserveEvent),
        observesContent: (sessionId) => activations.list(sessionId).some(registersContent),
        listens: (sessionId, event, match) => activations.list(sessionId).some((activation) => claims(activation, event, match)),
        dispatch: (sessionId, events) => {
            // Installed records reach a session the renderer has not listed yet.
            hostSync.list(sessionId);
            for (const event of events)
                settleInBackground(host.observe({ sessionId, ...event }));
        },
        onMainTurnComplete: (sessionId) => services.session.measure(sessionId),
        spawnedAnswer: options.spawnedAnswer,
        observesTurnComplete: (sessionId, pluginId) => activations
            .list(sessionId)
            .some((activation) => activation.pluginId === pluginId && registers(activation, 'turn.complete')),
        onError: (error) => host.diagnose({
            code: 'EXTENSION_OBSERVE_FAILED',
            message: error instanceof Error ? error.message : String(error),
        }),
        nowMs,
    });
    overrides.expose?.({ host, listActivations: (sessionId) => hostSync.list(sessionId) });
    return {
        onTurnEnded: (sessionId) => turns.onTurnEnded(sessionId),
        observeTurnFrame: (frame) => turnObserver.observe(frame),
        observesTurnContent: (sessionId) => turnObserver.observesTurnContent(sessionId),
        surface,
        authoring,
        onSessionDeleted: (sessionId) => lifecycle.onSessionDeleted(sessionId),
        onRuntimeStart: () => lifecycle.onRuntimeStart(),
        close: async () => {
            installedTier.stop();
            surface.close();
            clear();
            await host.close();
        },
    };
}
function measureListenerSignature(hostSync, sessionId) {
    return hostSync
        .list(sessionId)
        .filter((activation) => registers(activation, 'session.measure'))
        .map((activation) => `${activation.pluginId}@${hostSync.epoch(sessionId, activation.pluginId)}`)
        .sort()
        .join(',');
}
function registersContent(activation) {
    return (registers(activation, 'tool.call') ||
        registers(activation, 'tool.result') ||
        registers(activation, 'turn.start'));
}
/** The same claim `host/observe.ts` applies when it dispatches the event. */
/** Whether one of the activation's hooks claims the event under its matcher. */
function claims(activation, event, match) {
    return (activation.compiled !== undefined &&
        activation.scan.hooks.some((hook) => matchesObserveHook(hook, event, match)));
}
function registers(activation, event) {
    return (activation.compiled !== undefined && activation.scan.hooks.some((hook) => hook.slot === event));
}
function registersObserveEvent(activation) {
    return (activation.compiled !== undefined &&
        activation.scan.hooks.some((hook) => isObserveEventName(hook.slot)));
}
/**
 * The host stamps a numeric call id and full identity on each `ctx` call; the `ctx` services
 * resolve string call ids through this table. Entries live until the Invocation's signal aborts,
 * and store listeners registered here receive the `store-change` launches.
 */
class HostInvocationTable {
    active = new Map();
    storeListeners = new Map();
    listenerSeq = 0;
    track(identity) {
        const callId = String(identity.callId);
        if (this.active.has(callId) || identity.signal.aborted)
            return callId;
        this.active.set(callId, {
            callId,
            kind: identity.kind,
            origin: originOf(identity, identity),
            signal: identity.signal,
        });
        identity.signal.addEventListener('abort', () => this.active.delete(callId), { once: true });
        return callId;
    }
    addStoreListener(listener) {
        this.listenerSeq += 1;
        this.storeListeners.set(this.listenerSeq, listener);
        return this.listenerSeq;
    }
    removeStoreListener(handle) {
        this.storeListeners.delete(handle);
    }
    lookup(callId) {
        const invocation = this.active.get(callId);
        return invocation ? { status: 'active', invocation } : { status: 'unknown' };
    }
    launch(request) {
        this.storeListeners.get(request.handle)?.({
            key: request.change.key,
            value: request.change.value,
        });
    }
}
function originOf(activation, site) {
    return {
        pluginId: activation.pluginId,
        source: activation.source,
        tier: activation.tier,
        artifactDigest: site.artifactDigest,
        activationId: activationIdOf(activation.sessionId, {
            pluginId: activation.pluginId,
            tier: activation.tier,
            source: activation.source,
            artifactDigest: site.artifactDigest,
        }),
        sessionId: activation.sessionId,
        slot: site.slot ?? '',
        key: site.key ?? '',
    };
}
/** One activation of a session: the same content under another tier or source is another. */
function activationIdOf(sessionId, identity) {
    const { pluginId, tier, source, artifactDigest } = identity;
    return JSON.stringify([sessionId, pluginId, tier, source, artifactDigest]);
}
/** Every stream event goes to the extra sink, then to each subscriber. */
function createStreamHub(extra) {
    const listeners = new Set();
    const stream = {
        emit: (event) => {
            extra?.emit(event);
            for (const listener of listeners) {
                try {
                    listener(event);
                }
                catch {
                    // A failing subscriber must not block the others.
                }
            }
        },
    };
    const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };
    return { stream, subscribe, clear: () => listeners.clear() };
}
function createCtxServices(input) {
    const { options, overrides, boundary, diagnose, nowMs } = input;
    const query = new ExtensionQueryService({ stream: input.stream });
    return {
        agent: new ExtensionAgentService({ boundary, port: options.agentSpawn }),
        model: new ExtensionModelCompleteService({
            boundary,
            resolver: options.modelResolver,
            nowMs,
            ...(overrides.modelStream ? { stream: overrides.modelStream } : {}),
        }),
        store: new ExtensionStoreService(boundary, input.invocations, {
            root: path.join(options.dataDir, 'v2', 'plugin-data', 'extensions'),
            ...(overrides.storeLimits ? { limits: overrides.storeLimits } : {}),
        }),
        state: new ExtensionStateService({ boundary, diagnose }),
        mcp: new ExtensionMcpCallService({
            boundary,
            targets: options.mcpTargets,
            permission: createLocalMcpPermissionDecider(options.permission),
            nowMs,
        }),
        query,
        session: new ExtensionSessionUsageService({
            boundary,
            port: options.sessionUsage,
            listens: input.listensToMeasure,
            dispatch: input.dispatchMeasure,
            onError: (error) => diagnose({
                code: 'EXTENSION_OBSERVE_FAILED',
                message: error instanceof Error ? error.message : String(error),
            }),
        }),
        ui: new ExtensionUiService({
            boundary,
            stream: input.stream,
            panes: input.panes,
            query,
            diagnose,
            nowMs,
        }),
    };
}
/**
 * Adapts the host's per-call identity and positional `ctx` arguments to the `ctx` services. The
 * host keeps its own render dependencies and invalidation, so render reads are not recorded here
 * and `ctx.state` versions are the bucket version for every key.
 */
function bindHostPort(services, invocations, stream, sessionFacts) {
    return {
        sessionFacts,
        state: {
            declare: (pluginId, artifactDigest, defaults) => {
                const spec = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { default: value }]));
                services.state.declare(pluginId, artifactDigest, spec);
            },
            snapshot: (activation) => {
                const snapshot = services.state.snapshot({
                    pluginId: activation.pluginId,
                    sessionId: activation.sessionId,
                    artifactDigest: activation.artifact.digest,
                });
                const versions = Object.fromEntries(Object.keys(snapshot.values).map((key) => [key, snapshot.version]));
                return { values: snapshot.values, versions };
            },
            set: (identity, key, value) => services.state.set(invocations.track(identity), key, value),
        },
        call: (identity, method, args, signal) => CALL_HANDLERS[method](services, invocations.track(identity), args, signal),
        subscribeStore: (identity, listener) => {
            const handle = invocations.addStoreListener(listener);
            const subscription = services.store.onDidChange(invocations.track(identity), handle);
            return () => {
                invocations.removeStoreListener(handle);
                services.store.unsubscribe(activationIdOf(identity.sessionId, identity), subscription);
            };
        },
        emit: (event) => stream.emit(event),
    };
}
const done = async (work) => {
    await work;
    return undefined;
};
/** Positional Worker arguments → `ctx` service calls. */
const CALL_HANDLERS = {
    'agent.spawn': async (services, callId, [spec]) => JSON.parse(toJsonText(await services.agent.spawn(callId, spec ?? null), 'spawn receipt')),
    'agent.list': async (services, callId) => JSON.parse(toJsonText(await services.agent.list(callId), 'agent list')),
    'model.complete': async (services, callId, [request], signal) => JSON.parse(toJsonText(await services.model.complete(callId, request ?? null, signal), 'model result')),
    'store.get': (services, callId, [key]) => services.store.get(callId, text(key)),
    'store.set': (services, callId, [key, value]) => done(services.store.set(callId, text(key), value ?? null)),
    'store.delete': (services, callId, [key]) => done(services.store.delete(callId, text(key))),
    'store.keys': (services, callId) => services.store.keys(callId),
    'mcp.call': async (services, callId, [server, tool, args], signal) => {
        const result = await services.mcp.call(callId, {
            server: text(server),
            tool: text(tool),
            ...(args === undefined || args === null ? {} : { args }),
            ...(signal ? { signal } : {}),
        });
        return JSON.parse(toJsonText(result, 'mcp result'));
    },
    'ui.toast': (services, callId, [message, opts]) => done(services.ui.toast(callId, text(message), isJsonObject(opts) ? opts : undefined)),
    'ui.open': (services, callId, [options]) => done(services.ui.open(callId, options ?? null)),
    'ui.close': (services, callId, [id]) => done(services.ui.close(callId, id ?? null)),
    'prompt.fill': (services, callId, [args]) => {
        const mode = field(args, 'mode');
        return services.ui.fill(callId, {
            text: text(field(args, 'text')),
            ...(mode === undefined || mode === null ? {} : { mode: text(mode) }),
        });
    },
    'prompt.suggest': (services, callId, [args]) => services.ui.suggest(callId, args),
    'prompt.read': (services, callId) => services.ui.read(callId),
    'session.usage': async (services, callId) => JSON.parse(toJsonText(await services.session.usage(callId), 'session usage')),
};
function field(value, name) {
    return isJsonObject(value) ? value[name] : undefined;
}
function text(value) {
    if (typeof value !== 'string')
        throw new ExtensionServiceError('ARGUMENT_INVALID', 'expected a string');
    return value;
}
//# sourceMappingURL=initialize.js.map