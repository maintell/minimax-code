export function resolveLocalRuntimeMode(env = process.env) {
    void env;
    return 'clean';
}
export function isCleanLocalRuntimeMode(mode = resolveLocalRuntimeMode()) {
    return mode === 'clean';
}
export function buildLocalRuntimeCapabilities(mode, overrides = {}) {
    void mode;
    return {
        session: true,
        message: true,
        file: true,
        permission: true,
        queue: true,
        eventBus: true,
        goal: true,
        team: true,
        asr: false,
        skill: true,
        legacyImport: true,
        legacyRuntime: false,
        electronHost: false,
        cliEmbedded: false,
        diagnosticSidecar: false,
        questionnaireReply: true,
        permissionPrompt: true,
        elicitation: true,
        ...overrides,
    };
}
export function buildLocalRuntimeSurfaceCapabilities(mode) {
    void mode;
    const retiredLegacyRuntime = {
        status: 'retired',
        reason: 'Executable legacy runtime rollback has been retired from product surfaces.',
    };
    return {
        'agent.core': { status: 'native' },
        'agent.cron': {
            status: 'native',
            reason: 'Agent cron routes are backed by local-runtime cron host ports.',
        },
        'agent.identity': { status: 'native' },
        'agent.im': { status: 'native' },
        'agent.permissionReply': {
            status: 'native',
            reason: 'Agent permission/question reply routes share the native local-runtime permission request bus.',
        },
        'agent.questionnaire': {
            status: 'native',
            reason: 'Questionnaire is backed by DesktopService APIs and the native ask_user runtime tool.',
        },
        'agent.usage': {
            status: 'native',
            reason: 'Agent usage is projected from native local-runtime token usage records.',
        },
        'browser.management': {
            status: 'native',
            reason: 'Browser management routes are backed by the native local-runtime browser broker.',
        },
        'browser.status': { status: 'native' },
        channelBridge: {
            status: 'native',
            reason: 'Channel bridge infrastructure routes, bindings, lane queues, and native inbound slash commands are available.',
        },
        channelRoute: { status: 'native' },
        'communication.messages': {
            status: 'native',
            reason: 'Communication history is derived from native local-runtime session messages.',
        },
        'communication.peers': { status: 'native' },
        'communication.send': { status: 'native' },
        'config.apiKey': {
            status: 'native',
            reason: 'Local runtime API key mutation updates provider config through the config store.',
        },
        'config.core': { status: 'native' },
        content: { status: 'native' },
        cron: {
            status: 'native',
            reason: 'Cron routes are backed by local-runtime cron host ports.',
        },
        diagnostics: {
            status: 'native',
            reason: 'Diagnostic bundle upload routes dispatch through local-runtime host diagnostics ports.',
        },
        eventBus: { status: 'native' },
        'external.llmProviderDiscovery': { status: 'native' },
        file: { status: 'native' },
        goal: { status: 'native' },
        hooks: {
            status: 'retired',
            reason: 'Standalone user hooks are no longer supported. Custom hooks belong to Plugins.',
        },
        'legacy.import': { status: 'native' },
        'legacy.runtime': {
            ...retiredLegacyRuntime,
        },
        mcp: {
            status: 'native',
            reason: 'MCP registry, route handling, tools cache, and RuntimeTool injection are native.',
        },
        models: { status: 'native' },
        permission: { status: 'native' },
        runtime: { status: 'native' },
        'session.core': { status: 'native' },
        'session.diff': {
            status: 'native',
            reason: 'Session diff and turn-diff are captured through native local-runtime turn artifacts.',
        },
        'session.message': { status: 'native' },
        'session.queue': { status: 'native' },
        'session.resume': { status: 'native' },
        'session.usage': {
            status: 'native',
            reason: 'Session usage is projected from native local-runtime token usage records.',
        },
        'skill.evolve': { status: 'native' },
        'skill.hub': {
            status: 'native',
            reason: 'Skill hub search/install is backed by the native local-runtime skill hub store.',
        },
        team: { status: 'native' },
        usage: {
            status: 'native',
            reason: 'Global usage is projected from native local-runtime token usage records.',
        },
    };
}
export function localRuntimeSurfaceSupportsEmbeddedCli(surface) {
    return surface?.status === 'native' || surface?.status === 'diagnostic';
}
const EXACT_RUNTIME_ROUTES = new Map([
    ['/health', { surface: 'runtime', method: 'GET' }],
    ['/api/version', { surface: 'runtime' }],
    ['/api/update', { surface: 'runtime' }],
    ['/api/events', { surface: 'eventBus', method: 'GET' }],
    ['/api/content', { surface: 'content', method: 'POST' }],
    ['/api/config/api-key', { surface: 'config.apiKey' }],
    [
        '/api/external/llm-provider-discovery',
        { surface: 'external.llmProviderDiscovery', method: 'GET' },
    ],
    ['/api/browser/status', { surface: 'browser.status', method: 'GET' }],
    ['/api/browser/install-info', { surface: 'browser.status', method: 'GET' }],
    ['/api/browser/profiles', { surface: 'browser.status', method: 'GET' }],
    ['/api/communication/send', { surface: 'communication.send', method: 'POST' }],
    ['/api/communication/peers', { surface: 'communication.peers', method: 'GET' }],
    ['/api/communication/messages', { surface: 'communication.messages', method: 'GET' }],
    ['/api/agent', { surface: 'agent.core' }],
    ['/api/session/foreground', { surface: 'session.core' }],
]);
const RUNTIME_ROUTE_FAMILIES = [
    ['/api/config', 'config.core'],
    ['/api/models', 'models'],
    ['/api/permission', 'permission'],
    ['/api/goal', 'goal'],
    ['/api/hooks', 'hooks'],
    ['/api/mcp', 'mcp'],
    ['/api/team', 'team'],
    ['/api/file', 'file'],
    ['/api/fs', 'file'],
    ['/api/diagnostics', 'diagnostics'],
    ['/api/channel-route', 'channelRoute'],
    ['/channel-route', 'channelRoute'],
    ['/api/channel-bridge', 'channelBridge'],
    ['/api/im-bridge', 'channelBridge'],
    ['/api/browser', 'browser.management'],
    ['/api/communication', 'communication.messages'],
    ['/api/cron', 'cron'],
    ['/api/skill-hub', 'skill.hub'],
    ['/api/skill-evolve', 'skill.evolve'],
    ['/api/usage', 'usage'],
];
function isRuntimeRouteFamily(path, root) {
    return path === root || path.startsWith(`${root}/`);
}
export function resolveLocalRuntimeSurfaceForPath(method, pathname) {
    const verb = method.toUpperCase();
    const path = normalizeRuntimeApiPath(pathname);
    const exact = EXACT_RUNTIME_ROUTES.get(path);
    if (exact)
        return !exact.method || exact.method === verb ? exact.surface : undefined;
    if (isRuntimeRouteFamily(path, '/api/runtime'))
        return verb === 'GET' ? 'runtime' : undefined;
    if (path.startsWith('/api/agent/'))
        return resolveAgentRuntimeSurface(path);
    if (path.startsWith('/api/session/'))
        return resolveSessionRuntimeSurface(path);
    if (path.startsWith('/minimax-desktop/api/v1/skill-evolve/'))
        return 'skill.evolve';
    return RUNTIME_ROUTE_FAMILIES.find(([root]) => isRuntimeRouteFamily(path, root))?.[1];
}
const AGENT_RUNTIME_ROUTES = new Map([
    ['identity', 'agent.identity'],
    ['identity/avatar', 'agent.identity'],
    ['avatar', 'agent.identity'],
    ['im', 'agent.im'],
    ['usage', 'agent.usage'],
]);
function resolveAgentRuntimeSurface(path) {
    const segments = path.split('/').filter(Boolean);
    if (segments[2] === 'session')
        return 'agent.core';
    const tail = segments.slice(3).join('/');
    if (/^(permission|question)\/[^/]+\/(reply|reject)$/.test(tail))
        return 'agent.permissionReply';
    if (isRuntimeRouteFamily(tail, 'cron'))
        return 'agent.cron';
    return AGENT_RUNTIME_ROUTES.get(tail) ?? 'agent.core';
}
const SESSION_RUNTIME_ROUTES = new Map([
    ['message', 'session.message'],
    ['resume', 'session.resume'],
    ['diff', 'session.diff'],
    ['usage', 'session.usage'],
]);
function resolveSessionRuntimeSurface(path) {
    const tail = path.split('/').filter(Boolean).slice(3).join('/');
    if (isRuntimeRouteFamily(tail, 'queue'))
        return 'session.queue';
    if (isRuntimeRouteFamily(tail, 'turn-diff'))
        return 'session.diff';
    return SESSION_RUNTIME_ROUTES.get(tail) ?? 'session.core';
}
export function legacyRuntimeEnabledForMode(mode, explicitEnabled) {
    return mode === 'rollback' && explicitEnabled === true;
}
function normalizeRuntimeApiPath(pathname) {
    const path = pathname.split('?')[0]?.replace(/\/+$/, '') || '/';
    if (path.startsWith('/mavis/api/'))
        return `/api/${path.slice('/mavis/api/'.length)}`;
    if (path === '/mavis/api')
        return '/api';
    if (path.startsWith('/mavis/'))
        return path.slice('/mavis'.length) || '/';
    return path;
}
//# sourceMappingURL=mode.js.map