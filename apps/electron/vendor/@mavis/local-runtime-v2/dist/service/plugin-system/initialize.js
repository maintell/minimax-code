import path from 'node:path';
import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import { initializeHostConnectorSystem } from '../host-connector-system/index.js';
import { ConnectorCloudClient } from './app/cloud-client.js';
import { DesktopConnectorRuntime } from './app/runtime.js';
import { PluginSystemCloudTransport } from './cloud-transport.js';
import { PluginMcpRuntime } from './mcp/runtime.js';
import { GithubPluginImporter } from './plugin/import/github-plugin-importer.js';
import { PluginDesktopFacade } from './plugin/runtime/desktop-facade.js';
import { OfficialPluginAuthBarrier, resolveOfficialPluginAuthState, } from './plugin/runtime/official-operations.js';
import { OfficialPluginReconciler } from './plugin/runtime/official-reconciler.js';
import { PluginRegistryClient } from './plugin/runtime/registry-client.js';
import { SqlitePluginRepository } from './plugin/runtime/repository.js';
import { PluginSystem } from './plugin-system.js';
/** Assembles Plugin/App state over public host ports and existing v2 MCP/Skill owners. */
export function initializePluginService(dependencies, turnCapabilities, onPluginDeactivated) {
    const metricTags = {
        incr: (name, tags) => dependencies.metrics.counter(name, 1, tags ?? {}),
        latency: (name, durationMs, tags) => dependencies.metrics.histogram(name, durationMs, tags ?? {}),
        gauge: (name, value, tags) => dependencies.metrics.gauge(name, value, tags ?? {}),
    };
    const deploymentGetter = () => `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`;
    const officialAuthState = () => resolveOfficialPluginAuthState(dependencies.authContextGetter());
    const officialAuthBarrier = new OfficialPluginAuthBarrier({
        isReady: () => officialAuthState() === 'ready' && Boolean(deploymentGetter().trim()),
        isLoggedOut: () => officialAuthState() === 'logged_out',
        metrics: metricTags,
    });
    const createPluginMcpRuntime = () => new PluginMcpRuntime({
        names: dependencies.mcp.getRuntimeNameRegistry(),
        logger: {
            info: (message, fields) => dependencies.logger.info(fields ?? {}, message),
            warn: (message, fields) => dependencies.logger.warn(fields ?? {}, message),
            error: (message, fields) => dependencies.logger.error(fields ?? {}, message),
        },
        metrics: metricTags,
    });
    const pluginMcpRuntime = createPluginMcpRuntime();
    const repository = new SqlitePluginRepository(dependencies.database);
    const cloudTransport = new PluginSystemCloudTransport({
        baseUrl: resolveCloudBaseUrl(),
        fetchImpl: dependencies.fetchImpl,
        authContextGetter: dependencies.authContextGetter,
        appVersion: dependencies.appVersion,
        previewSecret: process.env.PREVIEW_SECRET,
        lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
    });
    const registryClient = new PluginRegistryClient(cloudTransport);
    const githubImporter = new GithubPluginImporter({
        dataDir: dependencies.dataDir,
        fetchImpl: dependencies.fetchImpl,
    });
    const connectorClient = new ConnectorCloudClient(cloudTransport);
    const hostConnectorSystem = initializeHostConnectorSystem({
        client: connectorClient.asHostProcessClient(),
        credentialGetter: dependencies.authContextGetter,
        audit: {
            record: (event) => dependencies.logger.info({ ...event }, 'Host-process Connector audit'),
        },
        onAuditFailure: (error) => dependencies.logger.warn({ errorType: error instanceof Error ? error.name : typeof error }, 'Host-process Connector audit failed'),
    });
    const connectorRuntime = new DesktopConnectorRuntime({
        client: connectorClient,
        logger: {
            warn: (message, fields) => dependencies.logger.warn(fields ?? {}, message),
        },
        metrics: metricTags,
        scopeKeyGetter: () => {
            const principalId = dependencies.authContextGetter()?.realUserID?.trim();
            const deployment = `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`;
            return principalId ? JSON.stringify([principalId, deployment]) : 'custom-only';
        },
    });
    const officialCacheRoot = path.join(dependencies.dataDir, 'v2', 'plugin-cache', 'official');
    const system = new PluginSystem({
        onPluginDeactivated,
        onOfficialPluginRevoked: dependencies.onOfficialPluginRevoked,
        onCapabilitiesChanged: dependencies.onCapabilitiesChanged,
        mcpNames: dependencies.mcp.getRuntimeNameRegistry(),
        dataDir: dependencies.dataDir,
        officialCacheRoot,
        repository,
        authContextGetter: dependencies.authContextGetter,
        deploymentGetter,
        listReservations: dependencies.listReservations,
        connectorRuntime,
        mcpRuntime: pluginMcpRuntime,
        mcpRuntimeFactory: createPluginMcpRuntime,
        officialReconciler: new OfficialPluginReconciler({
            cacheRoot: officialCacheRoot,
            repository,
            client: registryClient,
        }),
        githubImporter,
        metrics: metricTags,
    });
    const unsubscribeMcpChanges = dependencies.mcp.onDidChangeServers(() => system.markReservationsDirty());
    const unsubscribeSkillChanges = dependencies.skill.onDidChangeRuntimeSkills?.(() => system.markReservationsDirty()) ??
        (() => undefined);
    system.attachPublicationPort(turnCapabilities.attach(system));
    const plugin = new PluginDesktopFacade({
        system,
        registryClient,
        listStandaloneSkills: (input) => dependencies.listStandaloneSkills(input),
        standaloneSkillIdentities: dependencies.standaloneSkillIdentities,
        waitForOfficialAuth: () => officialAuthBarrier.waitUntilReady(),
        githubImporter,
        metrics: metricTags,
    });
    let readyPromise;
    let closePromise;
    return {
        plugin,
        mcp: dependencies.mcp,
        skill: dependencies.skill,
        hostConnectorGateway: hostConnectorSystem.gateway,
        attachMiniAppPublication: (input) => system.miniAppPublication.attach(input),
        listAcceptedMiniApps: () => system.miniAppPublication.listAcceptedMiniApps(),
        isAcceptedMiniAppRunning: (pluginId) => system.miniAppPublication.isAcceptedMiniAppRunning(pluginId),
        listAvailableMiniApps: () => system.miniAppPublication.listAvailableMiniApps(),
        activateMiniApp: (input) => system.miniAppPublication.activate(input),
        ensureMiniAppStarted: (input) => system.miniAppPublication.ensureStarted(input),
        prepareMiniAppTurn: (input) => system.prepareMiniAppTurn(input),
        initializeWorkspaceMiniApp: (input) => system.miniAppPublication.initializeWorkspace(input),
        publishWorkspaceMiniApp: (input) => system.miniAppPublication.publishWorkspace(input),
        restartMiniApp: (input) => system.miniAppPublication.restart(input),
        stopMiniApp: (input) => system.miniAppPublication.stop(input),
        verifyMiniAppCandidate: (candidate) => system.miniAppPublication.verifyCandidate(candidate),
        materializeMiniAppRuntimePackage: (input) => system.miniAppPublication.materializeRuntimePackage(input),
        authContextChanged: () => {
            officialAuthBarrier.authContextChanged();
            hostConnectorSystem.authContextChanged();
            connectorRuntime.authContextChanged();
            system.authContextChanged();
        },
        enabledHookPluginNames: () => new Set((system.currentSnapshot.turnCapabilities.hooks ?? []).map((handler) => handler.pluginName)),
        ready: () => {
            readyPromise ??= system.initialize();
            return readyPromise;
        },
        close: () => {
            closePromise ??= (async () => {
                officialAuthBarrier.dispose();
                unsubscribeMcpChanges();
                unsubscribeSkillChanges();
                try {
                    await system.dispose();
                }
                finally {
                    await hostConnectorSystem.close();
                }
            })();
            return closePromise;
        },
    };
}
function resolveCloudBaseUrl() {
    const configured = process.env.NEXT_PUBLIC_DOMAIN_URL?.trim();
    if (configured)
        return configured;
    const region = getRuntimeRegion();
    const build = getRuntimeBuildEnv();
    if (region === 'cn') {
        if (build === 'test' || build === 'dev')
            return 'https://matrix-test.xaminim.com';
        if (build === 'staging')
            return 'https://matrix-pre.xaminim.com';
        return 'https://agent.minimax.cn';
    }
    if (build === 'test' || build === 'dev')
        return 'https://matrix-overseas-test.xaminim.com';
    if (build === 'staging')
        return 'https://matrix-overseas-pre.xaminim.com';
    return 'https://agent.minimax.io';
}
/** Standalone Skill and ordinary MCP names reserve the namespace before Plugin snapshots are built. */
export function createPluginNameReservations(skill, mcp) {
    return async () => {
        const [skills, servers] = await Promise.all([skill.listRuntimeSkills(), mcp.listServers()]);
        return {
            skillNames: skills.skills.map((entry) => entry.name),
            mcpServerNames: servers.flatMap((server) => server['enabled'] !== false && typeof server['name'] === 'string' ? [server['name']] : []),
            toolNames: [],
        };
    };
}
//# sourceMappingURL=initialize.js.map