export class LocalMcpPublicFacade {
    owner;
    constructor(owner) {
        this.owner = owner;
    }
    async listLocalMcpServers(req) {
        const keyword = req.keyword?.trim().toLocaleLowerCase();
        const servers = await this.owner.listPublicServerStatuses();
        return {
            servers: servers
                .filter((server) => !keyword || server.name.toLocaleLowerCase().includes(keyword))
                .map(toPublicSummary),
        };
    }
    async listMcpCapabilities(req) {
        const keyword = req.keyword?.trim().toLocaleLowerCase();
        const [builtin, configuredStatuses] = await Promise.all([
            this.owner.listBuiltinPublicServerCapabilities(),
            this.owner.listPublicServerStatuses(),
        ]);
        const project = req.context ? await this.owner.inspectProjectMcp(req.context) : undefined;
        const session = req.context?.sessionId
            ? this.owner.getSessionMcpServers(req.context.sessionId)
            : undefined;
        const projected = (project?.servers ?? []).map((server) => ({
            name: server.name,
            sourceKind: 'configured',
            sourceScope: 'project',
            managed: false,
            transport: server.transport === 'streamable-http' ? 'http' : publicTransport(server.transport),
            enabled: server.status !== 'disabled' && server.status !== 'error',
            status: server.status,
            available: server.status === 'available',
            tools: [],
            description: project?.path,
            ...(server.error ? { error: server.error } : {}),
        }));
        const client = Object.entries(session ?? {}).map(([name, config]) => ({
            name,
            sourceKind: 'configured',
            sourceScope: 'session',
            managed: false,
            transport: publicTransport(config.type),
            enabled: true,
            status: 'configured',
            available: false,
            tools: [],
        }));
        const overrides = new Set([...projected, ...client].map((server) => server.name));
        const sessionNames = new Set(client.map((server) => server.name));
        const configured = [
            ...configuredStatuses
                .filter((server) => !overrides.has(server.name))
                .map(toConfiguredCapability),
            ...projected.filter((server) => !sessionNames.has(server.name)),
            ...client,
        ];
        return {
            servers: [...builtin, ...configured].flatMap((server) => filterCapability(server, keyword)),
        };
    }
    inspectProjectMcp(context) {
        return this.owner.inspectProjectMcp(context);
    }
    configureSessionServers(input) {
        return this.owner.configureSessionServers(input.sessionId, input.servers);
    }
    clearSessionServers(sessionId) {
        return this.owner.clearSessionServers(sessionId);
    }
}
function toConfiguredCapability(server) {
    return {
        ...server,
        sourceKind: 'configured',
        managed: false,
        tools: [],
    };
}
function filterCapability(server, keyword) {
    if (!keyword || server.name.toLocaleLowerCase().includes(keyword))
        return [server];
    const tools = server.tools.filter((tool) => tool.name.toLocaleLowerCase().includes(keyword) ||
        tool.description?.toLocaleLowerCase().includes(keyword));
    return tools.length > 0 ? [{ ...server, tools }] : [];
}
function toPublicSummary(server) {
    return {
        name: server.name,
        enabled: server.enabled,
        transport: server.transport,
        ...(server.description ? { description: server.description } : {}),
        configJson: JSON.stringify({
            status: server.status,
            available: server.available,
            ...(server.error ? { error: server.error } : {}),
        }),
    };
}
function publicTransport(type) {
    if (type === 'streamable-http')
        return 'http';
    return type === 'stdio' || type === 'http' || type === 'sse' ? type : 'none';
}
//# sourceMappingURL=public-facade.js.map