import { randomUUID } from 'node:crypto';
import { SessionKind as DesktopSessionKind, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { LocalRunLocationError, SESSION_KINDS, SessionServiceError, readLocalRunLocationInput, } from '../../service/session-system/index.js';
import { LocalModelProviderError, AgentModelSelectionError, } from '../../service/model-system/index.js';
import { AgentServiceError } from '../../service/agent/index.js';
import { AppError } from '../errors.js';
import { publishBestEffort } from '../events.js';
import { countApplicationMetric } from './metrics.js';
import { toSessionInfoView } from './wire.js';
const ARCHIVE_PLUGIN_HOOK_FOREGROUND_BUDGET_MS = 5_000;
function publishModelUpdated(publish, session, replacedFrom) {
    const model = toSessionInfoView(session).model;
    if (!model?.providerId || !model.modelId)
        return;
    publishBestEffort(publish, {
        type: 'session.model_updated',
        payload: {
            sessionId: session.sessionId,
            agentName: session.agentName,
            providerId: model.providerId,
            modelId: model.modelId,
            ...(model.variant !== undefined ? { variant: model.variant } : {}),
            ...(model.thinking?.effort !== undefined
                ? { thinking: { effort: model.thinking.effort } }
                : {}),
            ...(replacedFrom ? { replacedFrom } : {}),
        },
    });
}
function publishSessionCreated(publish, session) {
    publishBestEffort(publish, {
        type: 'session.created',
        payload: {
            sessionId: session.sessionId,
            agentName: session.agentName,
            sessionType: session.sessionType,
            sessionKind: session.sessionKind,
            visibility: session.visibility ?? 'visible',
            ...whenDefined('title', session.title),
            ...whenDefined('parentSessionId', session.parentSessionId),
        },
    });
}
/** Projects only admitted public events from already-committed Session facts. */
export class SessionLifecycleEventProjector {
    options;
    constructor(options) {
        this.options = options;
    }
    handle(fact) {
        switch (fact.kind) {
            case 'created':
                publishSessionCreated(this.options.publish, fact.session);
                break;
            case 'visibility-updated':
                publishBestEffort(this.options.publish, {
                    type: 'session.visibility_updated',
                    payload: {
                        sessionId: fact.session.sessionId,
                        agentName: fact.session.agentName,
                        visibility: fact.session.visibility ?? 'visible',
                    },
                });
                break;
            case 'title-updated':
                publishBestEffort(this.options.publish, {
                    type: 'session.title_updated',
                    payload: {
                        sessionId: fact.session.sessionId,
                        agentName: fact.session.agentName,
                        title: fact.title,
                    },
                });
                break;
            case 'model-updated':
                publishModelUpdated(this.options.publish, fact.session, fact.replacedFrom);
                break;
            case 'interaction-mode-updated':
                publishBestEffort(this.options.publish, {
                    type: 'session.interaction_mode.changed',
                    payload: {
                        sessionId: fact.session.sessionId,
                        interactionMode: fact.session.interactionMode ?? 'default',
                    },
                });
                break;
            case 'deleted':
                publishBestEffort(this.options.publish, {
                    type: 'session.deleted',
                    payload: { sessionId: fact.sessionId, previousMainSessionId: fact.previousMainSessionId },
                });
                break;
            case 'archive-changed':
                // No target consumer admits session.archive_changed.
                break;
        }
    }
}
/** Owns generated lifecycle mapping and the required fenced deletion workflow. */
export class SessionLifecycleApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async createSession(context, req) {
        return this.createSessionWithWorkspaceIdentity(context, req);
    }
    async createExplicitWorkspaceSession(context, req) {
        return this.createSessionWithWorkspaceIdentity(context, req, false);
    }
    async createSessionWithWorkspaceIdentity(_context, req, isDefaultWorkspace) {
        rejectUnsupportedProjectId(req);
        return this.countBuiltinCommand('new', () => this.withSessionLifecycle('create', async () => {
            const created = await this.invoke(async () => {
                if (isBtwSideSessionRequest(req)) {
                    const parentSessionId = req.parentSessionId;
                    if (!parentSessionId || !this.options.sideFork) {
                        throw new AppError(400, 'BTW_SIDE_SESSION_UNAVAILABLE', 'BTW side sessions require a parent Session and Runtime Fork support');
                    }
                    return this.options.sideFork.create({
                        operationId: `btw:${randomUUID()}`,
                        parentSessionId,
                        purpose: req.purpose ?? BTW_SIDE_SESSION_PURPOSE,
                        ...(req.title ? { title: req.title } : {}),
                    });
                }
                const input = toCreateInput(req);
                return this.options.lifecycle.createSession({
                    ...input,
                    ...whenDefined('isDefaultWorkspace', isDefaultWorkspace),
                    agentName: await this.options.resolveAgentWriteTarget(input.agentName),
                });
            });
            return {
                agentName: created.agentName,
                sessionId: created.sessionId,
                session: toSessionInfoView(created),
            };
        }));
    }
    async updateSession(_context, req) {
        const updated = await this.invoke(() => this.options.lifecycle.mutateSession(req.id, {
            ...whenDefined('title', req.title),
            ...whenDefined('memoryPolicy', req.memoryPolicy),
        }));
        return { session: toSessionInfoView(updated) };
    }
    async deleteSession(_context, req) {
        return this.withSessionLifecycle('delete', async () => {
            await this.deleteSessionById(req.id);
            return { success: true };
        });
    }
    archiveSession(_context, req) {
        const archived = req.archived !== false;
        return this.withSessionLifecycle(archived ? 'archive' : 'unarchive', () => this.setArchived(req.id, archived));
    }
    compressSession(_context, req) {
        return this.setArchived(req.id, req.archived !== false);
    }
    async archiveSessionById(sessionId) {
        await this.setArchived(sessionId, true);
    }
    async archiveSessionWithinMaintenance(sessionId, lane) {
        await this.setArchived(sessionId, true, lane);
    }
    async deleteSessionById(sessionId) {
        await this.options.assertSessionDeletionAllowed?.(sessionId);
        await this.invoke(() => this.options.deletion.deleteSession(sessionId));
    }
    /** Used by the owning scheduled-task lifecycle after its definition is removed. */
    async deleteTaskOwnedSessionById(sessionId) {
        await this.invoke(() => this.options.deletion.deleteSession(sessionId));
    }
    async setArchived(sessionId, archived, maintenanceLane) {
        const operation = async () => {
            const pluginHookDeadlineAtMs = Date.now() + ARCHIVE_PLUGIN_HOOK_FOREGROUND_BUDGET_MS;
            if (archived && this.options.preparePluginHookSessionEnd) {
                await waitWithinForegroundBudget(this.options.preparePluginHookSessionEnd(sessionId, 'archive'), pluginHookDeadlineAtMs);
            }
            if (maintenanceLane) {
                await this.options.lifecycle.archiveSessionInMaintenanceLane(sessionId, maintenanceLane);
            }
            else {
                await this.options.lifecycle.archiveSession(sessionId, archived);
            }
            if (archived && this.options.endPluginHookSession) {
                await waitWithinForegroundBudget(this.options.endPluginHookSession(sessionId, 'archive'), pluginHookDeadlineAtMs);
            }
            return { success: true };
        };
        if (!archived || !this.options.runPluginHookSessionEndFence) {
            return await this.invoke(operation);
        }
        return await this.invoke(() => this.options.runPluginHookSessionEndFence?.(sessionId, operation) ?? operation());
    }
    async invoke(operation) {
        try {
            return await operation();
        }
        catch (error) {
            throw toApplicationError(error);
        }
    }
    async countBuiltinCommand(command, operation) {
        countApplicationMetric(this.options.metrics, 'builtin_command_total', {
            command,
            status: 'started',
        });
        try {
            const result = await operation();
            countApplicationMetric(this.options.metrics, 'builtin_command_total', {
                command,
                status: 'succeeded',
            });
            return result;
        }
        catch (error) {
            countApplicationMetric(this.options.metrics, 'builtin_command_total', {
                command,
                status: 'failed',
            });
            throw error;
        }
    }
    async withSessionLifecycle(action, operation) {
        try {
            const result = await operation();
            countApplicationMetric(this.options.metrics, 'session_lifecycle_total', {
                action,
                status: 'ok',
            });
            return result;
        }
        catch (error) {
            countApplicationMetric(this.options.metrics, 'session_lifecycle_total', {
                action,
                status: 'error',
            });
            throw error;
        }
    }
}
async function waitWithinForegroundBudget(operation, deadlineAtMs) {
    const remainingMs = Math.max(0, deadlineAtMs - Date.now());
    let timer;
    try {
        await Promise.race([
            operation,
            new Promise((resolve) => {
                timer = setTimeout(resolve, remainingMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
const BTW_SIDE_SESSION_PURPOSE = 'peek_btw_session';
function isBtwSideSessionRequest(req) {
    return req.purpose === BTW_SIDE_SESSION_PURPOSE;
}
function rejectUnsupportedProjectId(req) {
    if (req.projectId === undefined || req.projectId === 0)
        return;
    throw new AppError(400, 'VALIDATION_ERROR', 'project_id is not supported by desktop local-runtime');
}
function toCreateInput(req) {
    const sessionKind = req.sessionKind === undefined ? undefined : fromDesktopSessionKind(req.sessionKind);
    if (req.sessionKind !== undefined && !sessionKind) {
        throw new AppError(400, 'INVALID_SESSION_KIND', `Unsupported Session kind: ${String(req.sessionKind)}`);
    }
    const runLocation = readLocalRunLocationInput(req.runLocation);
    return {
        agentName: req.name,
        ...whenDefined('workspaceDir', req.workspaceDir),
        ...whenDefined('title', req.title),
        ...whenDefined('parentSessionId', req.parentSessionId),
        ...whenDefined('visibility', validVisibility(req.visibility)),
        ...whenDefined('purpose', req.purpose),
        ...whenDefined('sessionKind', sessionKind),
        ...whenDefined('appMode', resolveRequestedAppMode(req.appMode)),
        ...whenDefined('runLocation', runLocation),
        ...whenDefined('model', toModelInput(req.model)),
    };
}
function validVisibility(value) {
    return value === 'visible' || value === 'hidden' ? value : undefined;
}
function resolveRequestedAppMode(value) {
    if (value === undefined)
        return undefined;
    return value === 'work' ? 'work' : 'coding';
}
function toModelInput(model) {
    if (!model)
        return undefined;
    return {
        ...whenDefined('providerId', model.providerId),
        ...whenDefined('modelId', model.modelId),
        ...whenDefined('variant', model.variant ?? undefined),
        ...whenDefined('reasoning', model.reasoning ?? undefined),
        ...whenDefined('contextLimit', model.contextLimit ?? undefined),
        ...(model.thinking?.effort == null ? {} : { thinking: { effort: model.thinking.effort } }),
    };
}
function whenDefined(key, value) {
    return value === undefined ? {} : { [key]: value };
}
function fromDesktopSessionKind(value) {
    if (typeof value === 'string' && SESSION_KINDS.some((kind) => kind === value)) {
        return value;
    }
    if (value === DesktopSessionKind.Unknown)
        return 'unknown';
    if (value === DesktopSessionKind.Conversation)
        return 'conversation';
    if (value === DesktopSessionKind.Task)
        return 'task';
    if (value === DesktopSessionKind.Peek)
        return 'peek';
    if (value === DesktopSessionKind.Channel)
        return 'channel';
    if (value === DesktopSessionKind.Cron)
        return 'cron';
    return undefined;
}
function toApplicationError(error) {
    if (error instanceof AppError)
        return error;
    if (error instanceof LocalModelProviderError || error instanceof AgentModelSelectionError) {
        return new AppError(400, 'VALIDATION_ERROR', error.message);
    }
    if (error instanceof AgentServiceError) {
        return new AppError(error.status, error.code, error.message);
    }
    if (error instanceof SessionServiceError) {
        const mapping = lifecycleFailureMapping(error.reason);
        return new AppError(mapping.status, error.detailCode ?? mapping.key, error.message);
    }
    if (error instanceof LocalRunLocationError) {
        return new AppError(400, error.code, error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
}
const LIFECYCLE_FAILURES = {
    'agent-not-found': { status: 404, key: 'AGENT_NOT_FOUND' },
    'workspace-required': { status: 400, key: 'WORKSPACE_REQUIRED' },
    'parent-not-found': { status: 404, key: 'SESSION_PARENT_NOT_FOUND' },
    'invalid-session-kind': { status: 400, key: 'INVALID_SESSION_KIND' },
    'parent-required': { status: 400, key: 'SESSION_PARENT_REQUIRED' },
    'session-not-found': { status: 404, key: 'SESSION_NOT_FOUND' },
    'session-busy': { status: 409, key: 'SESSION_BUSY' },
    'maintenance-lease-lost': { status: 409, key: 'SESSION_MAINTENANCE_LEASE_LOST' },
    'content-policy-rejected': { status: 422, key: 'CONTENT_POLICY_VIOLATION' },
    'runtime-unsupported': { status: 409, key: 'OPENCODE_MUTATION_UNAVAILABLE' },
    'session-id-conflict': { status: 409, key: 'SESSION_ID_CONFLICT' },
    'memory-recall-locked': { status: 409, key: 'MEMORY_RECALL_LOCKED' },
    'run-location-invalid': { status: 400, key: 'RUN_LOCATION_INVALID' },
    'task-agent-capture-unavailable': { status: 503, key: 'TASK_AGENT_CAPTURE_UNAVAILABLE' },
};
function lifecycleFailureMapping(reason) {
    return LIFECYCLE_FAILURES[reason];
}
//# sourceMappingURL=lifecycle-application.js.map