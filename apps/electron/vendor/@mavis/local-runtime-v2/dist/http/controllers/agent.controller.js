import { AgentImportService, AgentServiceError, redactedAgentRef, redactedErrorFacts, } from '../../service/agent/index.js';
import { AgentControllerBase } from '../generated/agent-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
/** V2 Agent RPC adapter. All persistence and root sequencing stays in AgentApplication. */
export class AgentController extends AgentControllerBase {
    application;
    constructor(application) {
        super();
        this.application = application;
    }
    async listAgents(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'list_agents' }, async () => {
            const include = readInclude(req.include);
            const options = {
                ...(req.search === undefined ? {} : { search: req.search }),
                includeAliases: false,
            };
            const listed = await application.list(options);
            const filtered = listed.filter((agent) => !(req.excludePrimary === true && agent.canonicalViewName === 'mavis'));
            const offset = Math.max(0, req.offset ?? 0);
            const limit = req.limit === undefined ? undefined : Math.max(0, req.limit);
            const page = filtered.slice(offset, limit === undefined ? undefined : offset + limit);
            const agents = await Promise.all(page.map(async (agent) => {
                const detail = include.persona || include.systemPrompt
                    ? await application.get(agent.requestRef, { includeContent: true })
                    : agent;
                return toAgentDetail(detail, include);
            }));
            return { agents };
        });
    }
    async createAgent(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'create_agent', agentRef: req.name }, async () => {
            const input = {
                ...(req.name === undefined ? {} : { name: req.name }),
                ...(req.displayName === undefined ? {} : { displayName: req.displayName }),
                ...(req.persona === undefined ? {} : { persona: req.persona }),
                ...(req.systemPrompt === undefined ? {} : { systemPrompt: req.systemPrompt }),
                ...(req.description === undefined ? {} : { description: req.description }),
                ...(req.avatar === undefined ? {} : { avatar: req.avatar }),
                ...(req.defaultWorkspaceDir === undefined
                    ? {}
                    : { defaultWorkspaceDir: req.defaultWorkspaceDir }),
                ...(req.initialDefinition === undefined
                    ? {}
                    : { initialDefinition: fromDesktopConfiguredDefinition(req.initialDefinition) }),
            };
            // Product decision 2026-09-04 (desktop and cloud agree): manual Agent
            // creation is definition-only — no Root Session, no greeting. The first
            // message from Chat creates the Session lazily. The legacy `create`
            // (Root materialization) path is retired; `definitionOnly` is accepted
            // but no longer consulted (renderer already always sent true; no other
            // shipped client calls this endpoint without it).
            const created = await application.createDefinition(input);
            return {
                name: created.exactOwnerName,
                ...(created.rootSessionId === undefined ? {} : { rootSessionId: created.rootSessionId }),
            };
        });
    }
    async getAgent(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'get_agent', agentRef: req.name }, async () => {
            const name = requireText(req.name, 'name');
            const include = readInclude(req.include);
            const agent = await application.get(name, {
                includeContent: include.persona || include.systemPrompt,
            });
            return { agent: toAgentDetail(agent, include) };
        });
    }
    async updateAgent(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'update_agent', agentRef: req.name }, async () => {
            const raw = req;
            const name = requireText(req.name, 'name');
            const updated = await application.update({
                requestRef: name,
                ...(raw.displayName === undefined ? {} : { displayName: raw.displayName }),
                ...(req.persona === undefined ? {} : { persona: req.persona }),
                ...(req.systemPrompt === undefined ? {} : { systemPrompt: req.systemPrompt }),
                ...(req.description === undefined ? {} : { description: req.description }),
                ...(req.avatar === undefined ? {} : { avatar: req.avatar }),
            });
            const detail = await application.get(updated.requestRef, { includeContent: true });
            return { success: true, agent: toAgentDetail(detail, ALL_INCLUDE) };
        });
    }
    async deleteAgent(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'delete_agent', agentRef: req.name }, async () => {
            await application.delete(requireText(req.name, 'name'));
            return { success: true };
        });
    }
    async getAgentLegacyHistoryNotice(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'get_agent_legacy_history_notice', agentRef: req.name }, async () => {
            const sessionId = await application.getLegacyHistoryNotice(requireText(req.name, 'name'));
            return sessionId === undefined ? {} : { sessionId };
        });
    }
    async getAgentConfig(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'get_agent_config', agentRef: req.name }, async () => ({
            config: toDesktopAgentConfigDocument(await application.getConfigDocument(requireText(req.name, 'name'))),
        }));
    }
    async putAgentConfig(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'put_agent_config', agentRef: req.name }, async () => {
            if (typeof req.content !== 'string') {
                throw new AppError(400, 'VALIDATION_ERROR', 'content is required');
            }
            const config = await application.putConfigDocument({
                requestRef: requireText(req.name, 'name'),
                content: req.content,
                expectedRevision: requireText(req.expectedRevision, 'expectedRevision'),
                ...(req.expectedOwnerInstanceId === undefined
                    ? {}
                    : { expectedOwnerInstanceId: req.expectedOwnerInstanceId }),
            });
            return { config: toDesktopAgentConfigDocument(config) };
        });
    }
    async readClaudeCodeAgentImport(ctx, req) {
        return mapAgentErrors(ctx, { operation: 'read_agent_import' }, async () => ({
            preview: toDesktopImportPreview(new AgentImportService().preview('claude-code', requireText(req.content, 'content'))),
        }));
    }
    async readCodexAgentImport(ctx, req) {
        return mapAgentErrors(ctx, { operation: 'read_codex_agent_import' }, async () => ({
            preview: toDesktopImportPreview(new AgentImportService().preview('codex', requireText(req.content, 'content'))),
        }));
    }
    async createImportedAgent(ctx, req) {
        const application = this.requireApplication();
        return mapAgentErrors(ctx, { operation: 'create_imported_agent', agentRef: req.targetName }, async () => {
            const created = await application.createImportedDefinition({
                format: requireImportFormat(req.format),
                content: requireText(req.content, 'content'),
                expectedDigest: requireText(req.expectedDigest, 'expectedDigest'),
                targetName: requireText(req.targetName, 'targetName'),
                ...(req.acceptedIssueIds === undefined
                    ? {}
                    : { acceptedIssueIds: [...req.acceptedIssueIds] }),
            });
            return {
                agent: toAgentDetail(created.agent, ALL_INCLUDE),
                config: toDesktopAgentConfigDocument(created.config),
            };
        });
    }
    requireApplication() {
        if (!this.application)
            throw new NotImplementedError('agent application');
        return this.application;
    }
}
/** Legacy/non-owner hosts keep the generated route fail-closed. */
export const agentController = new AgentController();
export function createAgentController(application) {
    return new AgentController(application);
}
const ALL_INCLUDE = { identity: true, persona: true, systemPrompt: true };
function readInclude(raw) {
    const tokens = new Set((raw ?? '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean));
    const all = tokens.has('all') || tokens.has('*');
    return {
        identity: all || tokens.has('identity'),
        persona: all || tokens.has('persona'),
        systemPrompt: all || tokens.has('prompt') || tokens.has('system_prompt') || tokens.has('systemprompt'),
    };
}
function requireText(value, field) {
    if (value !== undefined && value.trim() !== '')
        return value;
    throw new AppError(400, 'VALIDATION_ERROR', `${field} is required`);
}
function requireImportFormat(value) {
    if (value === 'claude-code' || value === 'codex')
        return value;
    throw new AppError(400, 'VALIDATION_ERROR', 'format must be claude-code or codex');
}
function toAgentDetail(agent, include) {
    return {
        ...toAgentIdentity(agent, include),
        ...toAgentContent(agent, include),
    };
}
function toAgentIdentity(agent, include) {
    return {
        name: agent.name,
        displayName: agent.displayName,
        agentRole: agent.agentRole,
        ...(agent.rootSessionId === undefined ? {} : { rootSessionId: agent.rootSessionId }),
        ...(agent.agentConfigDir === undefined ? {} : { agentConfigDir: agent.agentConfigDir }),
        createdAt: agent.createdAtMs,
        updatedAt: agent.updatedAtMs,
        ...(agent.defaultWorkspaceDir === undefined
            ? {}
            : {
                defaultWorkspaceDir: agent.defaultWorkspaceDir,
                userDefaultWorkspaceDir: agent.defaultWorkspaceDir,
            }),
        creationSource: toCreationSource(agent.creationSource),
        ...(include.identity
            ? {
                ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
                ...(agent.description === undefined ? {} : { description: agent.description }),
            }
            : {}),
    };
}
function toAgentContent(agent, include) {
    return {
        ...(include.persona && agent.persona !== undefined ? { persona: agent.persona } : {}),
        ...(include.systemPrompt && agent.systemPrompt !== undefined
            ? { systemPrompt: agent.systemPrompt }
            : {}),
    };
}
function toCreationSource(source) {
    switch (source) {
        case 'manual':
            return 1;
        case 'auto':
            return 2;
        case 'builtin':
            return 3;
        default:
            return 0;
    }
}
function toDesktopAgentConfigDocument(input) {
    return {
        exactOwnerName: input.exactOwnerName,
        ...(input.ownerInstanceId === undefined ? {} : { ownerInstanceId: input.ownerInstanceId }),
        ownerKind: input.ownerKind,
        persistence: input.persistence,
        appliesTo: input.appliesTo,
        revision: input.revision,
        content: input.content,
        configured: toDesktopConfiguredDefinition(input.configured),
        effectiveForNewSession: toDesktopEffectiveConfig(input.effectiveForNewSession),
        ...(input.diagnostics.length === 0
            ? {}
            : {
                diagnostics: input.diagnostics.map((diagnostic) => ({
                    code: diagnostic.code,
                    fieldPath: diagnostic.fieldPath,
                })),
            }),
        ...(input.baselineContent === undefined ? {} : { baselineContent: input.baselineContent }),
    };
}
function toDesktopEffectiveConfig(input) {
    return {
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: [...input.mcpServers] }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
        ...(input.extensionSkills === undefined ? {} : { extensionSkills: [...input.extensionSkills] }),
    };
}
function toDesktopConfiguredDefinition(input) {
    return {
        name: input.name,
        description: input.description,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: [...input.mcpServers] }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
        ...(input.mavis === undefined ? {} : { mavis: toDesktopMavisConfig(input.mavis) }),
        systemPrompt: input.systemPrompt,
    };
}
function fromDesktopConfiguredDefinition(input) {
    return {
        name: input.name,
        description: input.description,
        ...fromDesktopDefinitionFields(input),
        ...(input.mavis === undefined ? {} : { mavis: fromDesktopMavisConfig(input.mavis) }),
        systemPrompt: input.systemPrompt,
    };
}
function fromDesktopDefinitionFields(input) {
    return {
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: [...input.mcpServers] }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
    };
}
function fromDesktopMavisConfig(input) {
    return {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.defaultWorkspaceDir === undefined
            ? {}
            : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
        ...(input.extensionSkills === undefined ? {} : { extensionSkills: [...input.extensionSkills] }),
    };
}
function toDesktopMavisConfig(input) {
    return {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.defaultWorkspaceDir === undefined
            ? {}
            : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
        ...(input.extensionSkills === undefined ? {} : { extensionSkills: [...input.extensionSkills] }),
    };
}
function toDesktopImportPreview(input) {
    return {
        format: input.format,
        sourceDigest: input.sourceDigest,
        proposedName: input.proposedName,
        candidate: toDesktopConfiguredDefinition(input.candidate),
        canonicalContent: input.canonicalContent,
        ...(input.report.length === 0
            ? {}
            : {
                report: input.report.map((issue) => ({
                    issueId: issue.issueId,
                    category: issue.category,
                    fieldPath: issue.fieldPath,
                    code: issue.code,
                    ...(issue.acknowledgementRequired ? { acknowledgementRequired: true } : {}),
                })),
            }),
    };
}
/**
 * Maps Agent service failures onto the RPC error contract.
 *
 * `AppError` and `AgentServiceError` already carry a diagnosable code, so they
 * pass through untouched. Everything else used to be replaced by a bare
 * `500 INTERNAL_ERROR` with no trace at all, which made production Agent
 * failures unreproducible: the client saw "internal error" and the runtime log
 * held nothing. The unknown branch therefore records bounded, redacted error
 * facts plus the operation and Agent reference *before* the message is
 * discarded.
 */
async function mapAgentErrors(ctx, context, operation) {
    try {
        return await operation();
    }
    catch (err) {
        if (err instanceof AppError)
            throw err;
        if (err instanceof AgentServiceError) {
            throw new AppError(err.status, err.code, err.message);
        }
        const agentRef = redactedAgentRef(context.agentRef);
        // Fail-open logging: a broken sink must not change the mapped response.
        try {
            ctx.logger.ctxError(ctx, {
                event: 'agent_request_unexpected_failure',
                operation: context.operation,
                ...(agentRef === undefined ? {} : { agent_ref: agentRef }),
                ...redactedErrorFactsFields(err),
            }, 'Agent request failed with an unmapped error; responding 500 INTERNAL_ERROR');
        }
        catch {
            // Ignore: the original failure is what the caller must still receive.
        }
        throw new AppError(500, 'INTERNAL_ERROR', 'internal error');
    }
}
/** snake_case log fields, matching the rest of the V2 runtime log vocabulary. */
function redactedErrorFactsFields(error) {
    const facts = redactedErrorFacts(error);
    return {
        error_name: facts.errorName,
        error_message: facts.errorMessage,
        ...(facts.errorStack === undefined ? {} : { error_stack: facts.errorStack }),
    };
}
//# sourceMappingURL=agent.controller.js.map