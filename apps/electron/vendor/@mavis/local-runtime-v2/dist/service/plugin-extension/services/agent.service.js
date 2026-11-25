import { KeyedOperationQueue } from '../../../infra/util/keyed-operation-queue.js';
import { SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE } from '../../background-bash/index.js';
import { ExtensionServiceError } from '../errors.js';
import { parseAgentSpawnSpec } from '../sdk/agent-request.js';
const UNKNOWN_AGENT_PREFIX = 'Unknown agent';
/**
 * `ctx.agent.spawn`: starts a background sub-agent in the invocation's session and returns the
 * receipt without asking the user or waiting for the child. The child belongs to the session, so
 * the invocation ending never stops it. A session's spawns of one plugin are admitted one at a
 * time: the count and the start would otherwise race past the cap.
 */
export class ExtensionAgentService {
    deps;
    admissions = new KeyedOperationQueue();
    constructor(deps) {
        this.deps = deps;
    }
    list(callId) {
        return this.deps.boundary.run({ callId, domain: 'agent', method: 'list' }, (invocation) => this.deps.port.list(invocation.origin.sessionId));
    }
    spawn(callId, raw) {
        return this.deps.boundary.run({ callId, domain: 'agent', method: 'spawn' }, async (invocation, detail) => {
            const request = parseAgentSpawnSpec(raw);
            detail.agent = { agentType: request.agentType };
            const receipt = await this.admitted(invocation, () => this.start(callId, invocation, request));
            detail.agent = { agentType: request.agentType, agentId: receipt.agentId };
            return receipt;
        });
    }
    async admitted(invocation, work) {
        const { sessionId, pluginId } = invocation.origin;
        const key = JSON.stringify([sessionId, pluginId]);
        return this.admissions.run(key, work);
    }
    async start(callId, invocation, request) {
        const { sessionId, pluginId, activationId } = invocation.origin;
        if (invocation.signal?.aborted) {
            throw new ExtensionServiceError('CANCELLED', 'the invocation ended before the spawn');
        }
        const { port } = this.deps;
        const { limit } = port;
        const active = await port.countActive(sessionId, pluginId);
        if (active >= limit) {
            throw new ExtensionServiceError('AGENT_CONCURRENCY_LIMIT', `${active} running, limit ${limit}`);
        }
        let started;
        try {
            started = await port.start({
                sessionId,
                spawnedBy: { kind: 'plugin-extension', pluginId, activationGeneration: activationId },
                turnId: `ext:${pluginId}:${callId}`,
                taskInput: {
                    description: request.description,
                    prompt: request.prompt,
                    agent_name: request.agentType,
                    ...(request.model === undefined ? {} : { model: request.model }),
                },
            });
        }
        catch (error) {
            throw startFailed(error instanceof Error ? error.message : String(error), request.prompt);
        }
        if (started.status !== 'started' || !started.subSessionId)
            throw refusal(started, request);
        return {
            agentId: started.subSessionId,
            model: (await readModel(port, started.subSessionId)) ?? request.model ?? '',
        };
    }
}
/** The child already runs; a failed read only leaves the receipt without the resolved model. */
async function readModel(port, subSessionId) {
    try {
        return await port.resolvedModel(subSessionId);
    }
    catch {
        return undefined;
    }
}
function refusal(started, request) {
    const message = started.errorMessage ?? 'the task runner did not start the sub-agent';
    if (started.errorCode === SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE) {
        return new ExtensionServiceError('AGENT_CONCURRENCY_LIMIT', message);
    }
    if (message.startsWith(UNKNOWN_AGENT_PREFIX)) {
        return new ExtensionServiceError('AGENT_UNKNOWN_TYPE', message);
    }
    return startFailed(message, request.prompt);
}
/** Runner errors should not repeat the prompt; this holds even if one does. */
function startFailed(message, prompt) {
    return new ExtensionServiceError('AGENT_START_FAILED', message.split(prompt).join('<prompt>'));
}
//# sourceMappingURL=agent.service.js.map