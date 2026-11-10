import { findMcpAuthRequiredError } from '@mavis/mcp';
import { publicAuthTarget } from './bindings.js';
import { McpAuthTargetError, } from './ports.js';
/**
 * Resolves user, project and plugin targets to OAuth bindings for user actions,
 * and turns committed state changes into reconnects and `mcp.auth_updated`.
 */
export class McpAuthService {
    options;
    plugins;
    /** In-flight plugin rediscoveries started after a committed state change. */
    rediscoveries = new Map();
    unsubscribe;
    constructor(options) {
        this.options = options;
        this.unsubscribe = options.oauth.onStateChanged((view, binding) => this.handleStateChanged(view, binding));
    }
    /** Plugins initialize after MCP; their port is bound once available. */
    bindPluginPort(port) {
        this.plugins = port;
        return () => {
            if (this.plugins === port)
                this.plugins = undefined;
        };
    }
    async listStates(input) {
        const project = input.sessionId && input.workspaceRoot
            ? this.options.runtime.listProjectAuthBindings({
                sessionId: input.sessionId,
                workspaceRoot: input.workspaceRoot,
            })
            : Promise.resolve([]);
        const plugin = this.listPluginBindings();
        const bindings = (await Promise.all([this.options.runtime.listUserAuthBindings(), project, plugin])).flat();
        return Promise.all(bindings.map((binding) => this.readState(binding)));
    }
    /** One unreadable credential record shows as unknown instead of failing the whole list. */
    async readState(binding) {
        try {
            return await this.options.oauth.getState(binding);
        }
        catch {
            this.options.logger?.warn('mcp.oauth.state_unreadable', { kind: binding.target.kind });
            return { target: binding.target, authState: 'unknown' };
        }
    }
    async test(target) {
        const binding = await this.requireBinding(target);
        const outcome = await this.probe(binding);
        const state = await this.options.oauth.getState(binding);
        if (outcome === 'connected')
            return { state };
        return {
            state,
            errorCode: findMcpAuthRequiredError(outcome) ? 'MCP_AUTH_REQUIRED' : 'MCP_CONNECTION_FAILED',
        };
    }
    async start(target, options) {
        return this.options.oauth.start(await this.requireBinding(target), options);
    }
    cancel(attemptId) {
        return this.options.oauth.cancel(attemptId);
    }
    complete(attemptId, callbackUrl) {
        return this.options.oauth.complete(attemptId, callbackUrl);
    }
    async clear(target) {
        return this.options.oauth.clear(await this.requireBinding(target));
    }
    async setUserClientSecret(serverName, secret) {
        const binding = await this.options.runtime.resolveUserAuthBinding(serverName);
        if (!binding)
            throw new McpAuthTargetError();
        return this.options.oauth.setUserClientSecret(serverName, secret?.trim() ? secret : undefined);
    }
    /** Waits for background plugin rediscoveries so none outlives the MCP owner. */
    async close() {
        this.unsubscribe();
        await Promise.allSettled(this.rediscoveries.values());
        this.plugins = undefined;
    }
    /** A failing plugin source must not hide user and project states. */
    async listPluginBindings() {
        if (!this.plugins)
            return [];
        try {
            return (await this.plugins.listRemoteServers()).map(({ binding }) => binding);
        }
        catch {
            this.options.logger?.warn('mcp.oauth.plugin_list_failed');
            return [];
        }
    }
    async probe(binding) {
        const target = binding.target;
        if (target.kind !== 'plugin')
            return this.options.runtime.probeAuthTarget(target);
        const plugins = this.plugins;
        if (!plugins)
            throw new McpAuthTargetError();
        // The plugin probe never reports outcomes; user and project probes already did.
        const outcome = await plugins.probe(target);
        const authError = outcome === 'connected' ? undefined : findMcpAuthRequiredError(outcome);
        if (outcome === 'connected')
            await this.options.oauth.markObserved(binding, 'connected');
        else if (authError)
            await this.options.oauth.markObserved(binding, authError);
        return outcome;
    }
    async requireBinding(target) {
        const binding = await this.resolveBinding(target);
        if (!binding)
            throw new McpAuthTargetError();
        return binding;
    }
    async resolveBinding(target) {
        if (target.kind === 'user') {
            return this.options.runtime.resolveUserAuthBinding(target.serverName);
        }
        if (target.kind === 'project') {
            const bindings = await this.options.runtime.listProjectAuthBindings({
                sessionId: target.sessionId,
                workspaceRoot: target.workspaceRoot,
            });
            return bindings.find((binding) => binding.target.serverName === target.serverName);
        }
        return this.plugins?.resolveBinding(target);
    }
    /**
     * User and project servers reconnect before the event so the host refreshes
     * against the new credentials. Plugin rediscovery runs a full discovery, so
     * the completion event goes first and rediscovery continues in the background.
     */
    async handleStateChanged(view, binding) {
        const target = binding.target;
        if (target.kind === 'plugin') {
            this.publishUpdated(view, target);
            const key = Symbol('mcp-plugin-rediscovery');
            this.rediscoveries.set(key, this.rediscoverInBackground(key, target));
            return;
        }
        try {
            await this.options.runtime.reconnectAuthTarget(target);
        }
        catch {
            this.options.logger?.warn('mcp.oauth.reconnect_failed', { kind: target.kind });
        }
        this.publishUpdated(view, target);
    }
    /** Never rejects; failures are logged and the next discovery retries. */
    async rediscoverInBackground(key, target) {
        try {
            await this.plugins?.rediscover(target);
        }
        catch {
            this.options.logger?.warn('mcp.oauth.reconnect_failed', { kind: target.kind });
        }
        finally {
            this.rediscoveries.delete(key);
        }
    }
    publishUpdated(view, target) {
        try {
            this.options.publish?.({
                type: 'mcp.auth_updated',
                payload: {
                    target: publicAuthTarget(target),
                    authState: view.authState,
                    ...(view.reason ? { reason: view.reason } : {}),
                    ...(view.lastAttemptId ? { attemptId: view.lastAttemptId } : {}),
                    ...(view.lastAttemptOutcome ? { attemptOutcome: view.lastAttemptOutcome } : {}),
                    ...(view.lastAttemptErrorCode ? { errorCode: view.lastAttemptErrorCode } : {}),
                },
            });
        }
        catch {
            this.options.logger?.warn('mcp.oauth.publish_failed', { kind: target.kind });
        }
    }
}
//# sourceMappingURL=mcp-auth.service.js.map