/**
 * Local-runtime utility process entry.
 *
 * Forked by `LocalRuntimeUtilityProcessManager` (utilityProcess.fork) for
 * every Electron local-runtime lifecycle. Keeps itself deliberately thin:
 * all lifecycle logic lives in the unit-tested `utility-server.ts`, all
 * request/stream framing in the runtime package's transport host. This file
 * only binds real process globals and boots the runtime.
 *
 * Environment expectations (injected by the manager via fork env — the
 * utility process has no Electron `app` API):
 * - `MAVIS_SQLITE3_MODULE_PATH` / `NODE_PATH`: native better-sqlite3
 *   resolution, precomputed in main (native-sqlite-env).
 * - `MAVIS_REGION` / `MAVIS_BUILD_ENV` / proxy / CA vars: main's
 *   bootstrapManagedRuntimeEnv output is inherited through the fork env.
 *
 * DNS result order is per-process libuv state (NOT env), so ipv4first must
 * be re-applied here — fork children do not inherit it (proposal §2.6).
 *
 * Electron-only Browser and diagnostics capabilities stay in main and are
 * reached through request-id brokers on the parent control channel.
 */

import dns from "dns";
import { getHeapStatistics } from "node:v8";
import { DEFAULT_COLLECTION_POLICY } from "@mavis/shared/collection-policy";
import { resolveLocalRuntimeV2DirectoryContract } from "../v2-paths";
import { loadWeChatRuntimeSdk } from "../wechat-sdk-wire";
import { startLocalRuntimeUtilityServer } from "./utility-server";
import { UtilityBrowserBrokerClient } from "./browser-broker";
import { UtilityDiagnosticsBrokerClient } from "./diagnostics-broker";
import { UtilityAuthRecoveryBrokerClient } from "./auth-recovery-broker";
import { UtilityMiniAppBrokerServer } from "./miniapp-broker";
import { UtilityMiniAppSurfaceClient } from "./miniapp-surface-broker";
import { createUtilityProxyFetch } from "./proxy-fetch";
import { resolveElectronNetFetch } from "../electron-net-fetch";
import { UtilityRuntimeMemoryMonitor } from "./runtime-memory-monitor";
import { createReconnectingComputerUseClient, UtilityComputerUseBrokerClient } from "./computer-use-broker";
/**
 * Reports a bootstrap milestone to main's stall watchdog.
 *
 * Deliberately independent of the utility server and of the module-scope
 * `parentPort` binding below: the first stage must be sendable before any
 * lifecycle wiring exists. Failures are swallowed — a bootstrap must never
 * die because its liveness ping could not be delivered.
 */
function reportBootstrapProgress(stage) {
    try {
        const port = process.parentPort;
        if (!port)
            return;
        const message = { type: 'runtime-bootstrap-progress', stage };
        port.postMessage(message);
    }
    catch {
        // Best-effort: main falls back to a single no-progress window.
    }
}
// First executable statement of the child: proves the fork produced a running
// Node context before any heavy module work begins.
reportBootstrapProgress('node-entry');
const useVitestImport = process.env.VITEST === 'true';
const EVAL_REPORTER_REQUEST_TIMEOUT_MS = 3500;
const EVAL_REPORTER_FLUSH_TIMEOUT_MS = 4000;
/** `config.yaml` 缺省即开启,与 `@mavis/config` 的 dataContribution 默认值一致。 */
const DATA_CONTRIBUTION_DEFAULT_ENABLED = true;
/**
 * 读取 "数据用于优化体验" 开关,永不抛错。
 *
 * 走 `runtime.getDefaultLocalRuntimeConfig`(即 `@mavis/config` 的 `getConfig`,
 * 带进程内缓存)而不是静态 import,是为了跟 utility 进程既有的动态模块加载保持一致。
 * 上报是 best-effort:任何读取异常都回落到默认值,绝不让遥测把异常抛回运行时。
 */
function readUtilityDataContributionEnabled(runtime) {
    try {
        const value = runtime.getDefaultLocalRuntimeConfig()?.dataContribution?.enabled;
        return typeof value === 'boolean' ? value : DATA_CONTRIBUTION_DEFAULT_ENABLED;
    }
    catch {
        return DATA_CONTRIBUTION_DEFAULT_ENABLED;
    }
}
function importEsm(specifier) {
    if (useVitestImport) {
        return import(specifier);
    }
    // eslint-disable-next-line no-new-func -- Preserve native dynamic import in the CJS utility bundle.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport(specifier);
}
async function prepareRuntime(init, brokers, transferredPorts) {
    // Per-process libuv state; must run in THIS process (see header).
    try {
        dns.setDefaultResultOrder('ipv4first');
    }
    catch {
        // Best-effort: older Node builds without the API just keep defaults.
    }
    const proxyFetch = createUtilityFetchAdapter();
    try {
        return await prepareRuntimeWithProxyFetch(init, brokers, proxyFetch, transferredPorts);
    }
    catch (error) {
        try {
            await proxyFetch?.close();
        }
        catch {
            warn('utility proxy dispatcher close after prepare failure failed');
        }
        // The failure diagnostic itself is emitted by the utility server's
        // init handler (always on, sanitized) — see utility-server.ts.
        throw error;
    }
}
function createUtilityFetchAdapter() {
    const electronFetch = resolveElectronNetFetch(reportElectronNetFetchDiagnostic);
    if (electronFetch) {
        return {
            fetch: electronFetch,
            close: async () => { },
        };
    }
    return createUtilityProxyFetch(process.env, warn);
}
async function prepareRuntimeWithProxyFetch(init, brokers, proxyFetch, transferredPorts) {
    // The dominant cold-start cost: two dynamic ESM graphs plus the native
    // better-sqlite3 binding they pull in (slow disks and Windows AV scanning
    // land here). A single 'modules-loaded' ping made this whole segment a black
    // box, so each import reports its OWN completion.
    //
    // Promise.all is kept deliberately: the two graphs load concurrently and
    // sequentializing them to get ordered reporting would serialize exactly the
    // disk I/O that is slow on the machines this watchdog exists for. The price
    // is that completion order is nondeterministic, so these substages are
    // reported per-import rather than as a linear sequence, and main treats any
    // first-seen substage as forward progress (control.ts shares their rank).
    const [runtime, common] = await Promise.all([
        importEsm('@mavis/local-runtime-v2').then((module) => {
            reportBootstrapProgress('modules-runtime-v2-done');
            return module;
        }),
        importEsm('@mavis/local-runtime/common').then((module) => {
            reportBootstrapProgress('modules-common-done');
            return module;
        }),
    ]);
    // Terminal marker for the phase: keeps the ordering contract with
    // 'sqlite-ready' and stays meaningful for an old main that knows only the
    // three original stages.
    reportBootstrapProgress('modules-loaded');
    runtime.resetDefaultLocalRuntimeConfig?.();
    const runtimeMode = runtime.resolveLocalRuntimeMode();
    const runtimeLogsDir = resolveLocalRuntimeV2DirectoryContract(init.dataDir).logs;
    try {
        common.configureLocalRuntimeLogging({
            dir: runtimeLogsDir,
            onError: () => warn('runtime disk logger write failed'),
        });
        common.configureImLogger({
            dir: runtimeLogsDir,
            onError: () => warn('IM disk logger write failed'),
        });
    }
    catch {
        warn('utility disk logger configuration failed');
    }
    let authContext = (init.authContext ?? null);
    let routingContext = init.routingContext;
    let contextWindowUsageEnabled = init.contextWindowUsageEnabled !== false;
    let runawayGuardConfig = init.runawayGuardConfig ?? {};
    let toolResultCompactionConfig = init.toolResultCompactionConfig ?? {};
    // Main only ever sends a complete, validated policy. An older main that sends
    // none leaves the built-in policy in force — never an empty one.
    let collectionPolicy = init.collectionPolicy ?? DEFAULT_COLLECTION_POLICY;
    // The iLink WeChat SDK uses electron's `net` module, which IS available
    // in utility processes (proposal §2.7) — same dynamic-import isolation
    // and stub fallback as the in-process path.
    let wechatRuntimeSdk;
    try {
        wechatRuntimeSdk = await loadWeChatRuntimeSdk(importEsm);
    }
    catch {
        warn('WeChat iLink SDK unavailable, falling back to stub');
    }
    let activeComputerUseClient = runtime.createUnavailableComputerUseClient();
    const computerUseClient = createReconnectingComputerUseClient(brokers.computerUse, () => activeComputerUseClient);
    const computerPort = transferredPorts?.[0];
    if (computerPort && init.computerUseGeneration) {
        common.logger.info({ generation: init.computerUseGeneration, source: 'runtime-init' }, 'Computer Use channel attached during runtime init');
        activeComputerUseClient = runtime.createComputerUsePortClient({
            port: computerPort,
            generation: init.computerUseGeneration,
            logger: common.logger,
            onClose: () => brokers.computerUse.markUnavailable(),
        });
        brokers.computerUse.markReady();
    }
    const host = await runtime.createLocalRuntimeHost({
        dataDir: init.dataDir,
        onDatabaseMigration: (event) => {
            try {
                const message = {
                    type: 'runtime-database-migration',
                    event,
                };
                process.parentPort?.postMessage(message);
            }
            catch {
                // Telemetry cannot block or fail database migration.
            }
        },
        runtimeMode,
        capabilities: { electronHost: true, asr: true },
        runtimeOwnerKind: 'electron',
        appVersion: init.appVersion,
        runtimeStartupToken: init.runtimeStartupToken,
        startupExecutionPolicy: init.startupExecutionPolicy ?? 'enabled',
        computerUseClient,
        configGetter: () => ({ ...runtime.getDefaultLocalRuntimeConfig(), dataDir: init.dataDir }),
        authContextGetter: () => authContext,
        authContextInvalidator: async (rejectedAccessToken, loginEpoch) => {
            if (!rejectedAccessToken)
                return;
            try {
                const recovered = (await brokers.auth.recover(rejectedAccessToken, loginEpoch));
                // A newer login/logout notification may arrive while the reply is in transit.
                if (!loginEpoch ||
                    authContext?.loginEpoch !== loginEpoch ||
                    recovered?.loginEpoch !== loginEpoch)
                    return;
                authContext = recovered;
            }
            catch {
                warn('Desktop auth recovery broker request failed');
            }
        },
        ...(init.promptConfigKey ? { promptConfigKey: Uint8Array.from(init.promptConfigKey) } : {}),
        routingContextGetter: () => routingContext,
        skillRegistryDiagnostics: brokers.reportSkillRegistryDiagnostic,
        isContextWindowUsageEnabled: () => contextWindowUsageEnabled,
        getRunawayGuardConfig: () => runawayGuardConfig,
        getToolResultCompactionConfig: () => toolResultCompactionConfig,
        getCollectionPolicy: () => collectionPolicy,
        createWorkspaceIndexingObservationSink: () => {
            const ownerUserId = authContext?.realUserID;
            if (!ownerUserId)
                return undefined;
            return (event) => brokers.reportWorkspaceIndexingObservation({
                type: 'runtime-workspace-indexing-observation',
                ownerUserId,
                event,
            });
        },
        ...(proxyFetch ? { fetchImpl: proxyFetch.fetch } : {}),
        ...(init.evalCapture
            ? {
                evalCapture: {
                    // 每次求值,读 `config.yaml` 的 `dataContribution.enabled`(默认开启)。
                    // 设置面板改完开关后 configUpdater 会就地 resetConfig(),同在 utility
                    // 进程的上报链路下一次求值即可看到新值,无需重启运行时。
                    enabled: () => readUtilityDataContributionEnabled(runtime),
                    endpoint: init.evalCapture.endpoint,
                    requestTimeoutMs: EVAL_REPORTER_REQUEST_TIMEOUT_MS,
                    getAccessToken: () => authContext?.accessToken,
                    getMetaInfo: (workspaceDir, onObservation) => runtime.collectEvalMetaInfo({
                        runtime: 'desktop',
                        runtimeVersion: init.appVersion,
                        workspaceDir,
                        policy: collectionPolicy,
                        ...(onObservation ? { onObservation } : {}),
                    }),
                    clio: {
                        // Separate from raw Eval capture, but shares the user-facing
                        // `dataContribution.enabled` consent switch: durable QA records
                        // are produced only while the build-level Session Clio switch is
                        // on AND the user keeps "数据用于优化体验" enabled. Re-evaluated on
                        // every call so a settings change applies without a runtime
                        // restart, and turning it off also stops queued outbox uploads.
                        enabled: () => init.evalCapture?.sessionClioEnabled === true &&
                            readUtilityDataContributionEnabled(runtime),
                        // Uploads stay off until desktop auth has actually settled, so a
                        // pending or logged-out window queues records instead of dropping
                        // them or shipping them under the wrong identity.
                        isReady: () => authContext?.authState !== 'pending' && authContext?.authState !== 'logged_out',
                    },
                    ...(proxyFetch ? { fetchImpl: proxyFetch.fetch } : {}),
                },
            }
            : {}),
        telemetry: (event) => {
            const fields = {
                runtime: event.runtime,
                sessionId: event.sessionId,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                phase: event.phase,
                ...(event.message ? { reason: event.message } : {}),
            };
            if (event.phase === 'failure') {
                common.logger.error(fields, 'utility runtime turn failed');
            }
            else if (event.phase === 'disabled') {
                common.logger.warn(fields, 'utility runtime turn disabled');
            }
            else {
                common.logger.info(fields, 'utility runtime turn lifecycle');
            }
        },
        mcpLogger: {
            info: (message, fields) => common.logger.info({ ...(fields ?? {}) }, `utility MCP: ${message}`),
            warn: (message, fields) => common.logger.warn({ ...(fields ?? {}) }, `utility MCP: ${message}`),
            error: (message, fields) => common.logger.error({ ...(fields ?? {}) }, `utility MCP: ${message}`),
        },
        ...(init.hostCapabilities.browser ? { browserAdapter: brokers.browser.adapter } : {}),
        ...(init.hostCapabilities.diagnostics
            ? { hostDiagnosticsProvider: brokers.diagnostics.provider }
            : {}),
        ...(init.hostCapabilities.miniAppSurface
            ? { miniAppSurface: brokers.miniAppSurface.port }
            : {}),
        enableLiveMcp: true,
        ...(wechatRuntimeSdk ? { wechatRuntimeSdk } : {}),
    });
    // The host owns SQLite: opening the dataDir, running migrations and starting
    // background infra all completed by the time this resolves.
    reportBootstrapProgress('sqlite-ready');
    await host.apiHost.ensureBuiltinAgents();
    brokers.miniApp.bind(host.application?.miniApps, host.application?.miniAppAgent);
    return {
        handleRequest: (request) => host.apiHost.handleRequest(request),
        createTransportHost: runtime.createRuntimeTransportHost,
        createStreamCoordinator: runtime.createRuntimeTransportStreamCoordinator,
        collectSessionReport: async (sessionId) => {
            const diagnostics = host.application?.diagnostics;
            if (!diagnostics?.collectSessionReport) {
                throw new Error('session_report_capability_unavailable');
            }
            return diagnostics.collectSessionReport(sessionId);
        },
        setAuthContext: async (next) => {
            const changed = JSON.stringify(authContext) !== JSON.stringify(next ?? null);
            authContext = (next ?? null);
            if (!changed)
                return;
            await host.notifyAuthContextChanged?.(authContext?.authState);
            if (authContext?.authState === 'pending')
                return;
            try {
                await host.apiHost.retryBuiltinGreetings();
            }
            catch {
                warn('builtin greeting retry after auth rotation failed');
            }
        },
        setRoutingContext: (next) => {
            routingContext = next;
        },
        setContextWindowUsageEnabled: (enabled) => {
            contextWindowUsageEnabled = enabled;
        },
        setComputerUsePort: (port, generation) => {
            common.logger.info({ generation, source: 'runtime-computer-use-connect' }, 'Computer Use channel attached to ready runtime');
            activeComputerUseClient = runtime.createComputerUsePortClient({
                port,
                generation,
                logger: common.logger,
                onClose: () => brokers.computerUse.markUnavailable(),
            });
            brokers.computerUse.markReady();
        },
        setRunawayGuardConfig: (config) => {
            runawayGuardConfig = config;
        },
        setToolResultCompactionConfig: (config) => {
            toolResultCompactionConfig = config;
        },
        setCollectionPolicy: (policy) => {
            collectionPolicy = policy;
            host.apiHost.workspaceIndexingRemoteWorker.notifyCollectionPolicyChanged();
        },
        shutdown: async () => {
            brokers.auth.close();
            brokers.browser.close();
            brokers.diagnostics.close();
            brokers.miniApp.close();
            brokers.miniAppSurface.close();
            try {
                try {
                    await host.apiHost.shutdownChannelSubsystem?.();
                }
                catch {
                    warn('channel subsystem shutdown failed');
                }
                try {
                    // Local Runtime V2 owns PluginSystem through RuntimeServices; its
                    // unified apiHost.close() drains services before closing the v1 host.
                    await host.apiHost.close?.();
                }
                catch {
                    warn('runtime API host close failed');
                }
                try {
                    await host.evalReporterFactory?.flush(EVAL_REPORTER_FLUSH_TIMEOUT_MS);
                }
                catch {
                    warn('eval reporter flush failed');
                }
                try {
                    await proxyFetch?.close();
                }
                catch {
                    warn('utility proxy dispatcher close failed');
                }
            }
            finally {
                await Promise.allSettled([common.flushLocalRuntimeLogging(), common.flushImLogger()]);
                await Promise.allSettled([common.shutdownLocalRuntimeLogging(), common.shutdownImLogger()]);
            }
        },
    };
}
function reportElectronNetFetchDiagnostic(diagnostic) {
    warn('electron net.fetch response header rejected', diagnostic);
}
function warn(message, fields) {
    if (fields)
        console.warn(`[LocalRuntimeUtility] ${message}`, fields);
    else
        console.warn(`[LocalRuntimeUtility] ${message}`);
}
const parentPort = process.parentPort;
if (parentPort) {
    const auth = new UtilityAuthRecoveryBrokerClient({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const browser = new UtilityBrowserBrokerClient({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const diagnostics = new UtilityDiagnosticsBrokerClient({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const miniApp = new UtilityMiniAppBrokerServer({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const miniAppSurface = new UtilityMiniAppSurfaceClient({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const memoryMonitor = new UtilityRuntimeMemoryMonitor({
        postMessage: (message) => parentPort.postMessage(message),
    });
    const computerUse = new UtilityComputerUseBrokerClient({
        postMessage: (message) => parentPort.postMessage(message),
    });
    startLocalRuntimeUtilityServer({
        parentPort,
        prepareRuntime: async (init, ports) => {
            memoryMonitor.setOutputDirectory(resolveLocalRuntimeV2DirectoryContract(init.dataDir).diagnostics);
            const surface = await prepareRuntime(init, {
                auth,
                browser,
                diagnostics,
                computerUse,
                reportSkillRegistryDiagnostic: (event) => {
                    try {
                        const message = {
                            type: 'runtime-skill-registry-diagnostic',
                            event,
                        };
                        parentPort.postMessage(message);
                    }
                    catch {
                        // Diagnostics must never affect Skill registry behavior.
                    }
                },
                miniApp,
                miniAppSurface,
                reportWorkspaceIndexingObservation: (message) => {
                    try {
                        parentPort.postMessage(message);
                    }
                    catch {
                        // Product observation must not affect capture or search.
                    }
                },
            }, ports);
            return {
                ...surface,
                shutdown: async () => {
                    memoryMonitor.dispose();
                    await surface.shutdown();
                },
            };
        },
        handleMainMessage: (message) => auth.handleMessage(message) ||
            browser.handleMessage(message) ||
            diagnostics.handleMessage(message) ||
            computerUse.handleMessage(message) ||
            miniApp.handleMessage(message) ||
            miniAppSurface.handleMessage(message) ||
            memoryMonitor.handleMessage(message),
        exit: (code) => process.exit(code),
        sampleHealth: () => {
            const memory = process.memoryUsage();
            let cpu = { user: 0, system: 0 };
            try {
                cpu = process.cpuUsage();
            }
            catch {
                // Optional diagnostics must not suppress the existing health heartbeat.
            }
            return {
                timestampMs: Date.now(),
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal,
                heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
                rssBytes: memory.rss,
                externalBytes: memory.external,
                arrayBuffersBytes: memory.arrayBuffers,
                cpuUserMicros: cpu.user,
                cpuSystemMicros: cpu.system,
            };
        },
        flushLogs: async () => {
            // The dynamic import is cached after the first call; before the
            // runtime ever loaded the module, both flush functions are safe
            // no-ops (disk transports not configured yet).
            const common = await importEsm('@mavis/local-runtime/common');
            await Promise.allSettled([common.flushLocalRuntimeLogging(), common.flushImLogger()]);
        },
        log: (message, fields) => {
            if (fields)
                console.warn(`[LocalRuntimeUtility] ${message}`, fields);
            else
                console.warn(`[LocalRuntimeUtility] ${message}`);
        },
    });
}
