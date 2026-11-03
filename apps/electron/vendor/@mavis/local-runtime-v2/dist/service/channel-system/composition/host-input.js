import { TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER } from '@mavis/conversation-contract';
import { isAgentNotFoundError, } from '../../agent/index.js';
import { applyPermissionReplyFromChannel } from '../../permission/index.js';
import { LocalQuestionnaireError, LocalQuestionnaireService, } from '../../questionnaire/index.js';
import { classifyQuestionnaireReplyError } from '../../questionnaire/index.js';
import { canonicalProjectWorkspaceDir, projectKeyForWorkspace, workspaceDirFromProjectKey, } from '../../../infra/legacy-db/project-canonical-workspace.js';
import { hostCreateRootSession } from '../../session-system/index.js';
import { makeId } from '../../../infra/transport/host-http.js';
import { routeChannelFollowMessage, submitChannelMessage, } from '../ingress/follow-up/channel-follow-send.js';
/**
 * Rootless routing contract error thrown by the wire closures (MR3: local
 * definition — the v1 channels implementation is gone). The NAME and the
 * status/code fields are the stable cross-package contract: the v2 channel
 * system recognizes wire-borne instances structurally, never by class
 * identity.
 * @internal Exported only for focused tests.
 */
export class LocalChannelRootlessError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalChannelRootlessError';
    }
}
/**
 * One page is enough for a Root scan: a single Agent family with more than a
 * few hundred conversation Roots is already a corrupted state, and paging here
 * would turn a bounded boot step into an unbounded table walk.
 */
const PRIMARY_FAMILY_ROOT_SCAN_LIMIT = 200;
/**
 * Typed through the public port (an intersection, not a spread) so the emitted
 * wire-input declaration never has to name port-internal result types.
 */
function withRootlessAgentIdentityReads(port, rest) {
    return {
        getAgentOwnerIdentity: (requestRef) => port.getAgentOwnerIdentity(requestRef),
        getSessionAgentRoutingSnapshot: (sessionId) => port.getSessionAgentRoutingSnapshot(sessionId),
        getSessionProjectIdentity: (sessionId) => port.getSessionProjectIdentity(sessionId),
        ...rest,
    };
}
/**
 * Collect the host-side capability closures for the channel subsystem.
 *
 * MR3: the ONLY channel assembly entry left in v1. The external (Local
 * Runtime V2) composition consumes these closures and assembles its own v2
 * channel subsystem from them; no internal assembly exists any more, so the
 * bundle cannot drift between modes by construction.
 */
export function buildHostChannelWireInput(host, options) {
    const requireConversation = () => {
        if (!host.runtimeConversation) {
            throw new Error('Runtime Conversation is unavailable for Channel execution');
        }
        return host.runtimeConversation;
    };
    return {
        dataDir: () => host.configGetter().dataDir,
        nowMs: host.nowMs,
        agentName: host.agentName,
        ...(buildChannelAgentResolution(host)),
        makeId,
        fetchImpl: host.fetchImpl,
        ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
        resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
        getSessionById: (id) => host.getSessionById(id),
        // The v2 wire contract types agentName as optional (its route resolvers
        // always pass one today); fall back to the host's primary agent so an
        // undefined never turns into a cross-agent scan.
        listSessions: (agentName, listOptions) => host.listAllSessions(agentName ?? host.agentName, listOptions),
        createSession: (input) => requireConversation().lifecycle.createSession(input),
        ...(host.runtimeConversation
            ? {
                revealMigratedSession: async (sessionId) => {
                    const conversation = requireConversation();
                    const session = await conversation.query.getSession(sessionId);
                    if (!session || session.sessionKind === 'cron' || session.sessionKind === 'peek')
                        return;
                    const trustedLegacyRoot = session.sessionType === 'root' && session.sessionKind === 'conversation';
                    const markerMissing = trustedLegacyRoot && !hasTrustedLegacyImRootMarker(session.purpose);
                    if (session.visibility !== 'hidden' && !markerMissing)
                        return;
                    await conversation.lifecycle.updateSession(sessionId, {
                        ...(session.visibility === 'hidden' ? { visibility: 'visible' } : {}),
                        ...(markerMissing
                            ? { purpose: appendTrustedLegacyImRootMarker(session.purpose) }
                            : {}),
                    });
                },
            }
            : {}),
        ...buildRootlessChannelCapabilities(host),
        createRootSession: async (agentName) => {
            const conversation = requireConversation();
            const previousRoot = (await conversation.query.listSessions({ agentName, sessionType: 'root', limit: 1 }))[0];
            return hostCreateRootSession({
                agentName,
                createSession: (input) => conversation.lifecycle.createSession({
                    ...input,
                    agentName: input.agentName ?? agentName,
                }),
                replaceRootSession: (replacementAgentName, sessionId) => host.agentRoutes.replaceRootSession(replacementAgentName, sessionId),
                deleteSession: (sessionId) => conversation.lifecycle.deleteSession(sessionId),
                resolveWorkspaceDir: () => previousRoot?.workspaceDir ?? host.resolveDefaultWorkspaceDir(),
            });
        },
        configGetter: () => host.configGetter(),
        // Family reconciliation is V2-only. Standalone V1 has no runtime
        // conversation or Agent resolver and must retain its own startup path.
        ...buildChannelFamilyCapabilities(host, requireConversation),
        enqueueMessage: buildChannelEnqueue(host, requireConversation),
        abortSession: async (sessionId) => {
            await requireConversation().ingress.abort(sessionId, 'user_stop');
        },
        requestCompaction: ({ sessionId, agentName, customInstructions, reason, onStarted, }) => requireConversation().maintenance.compact({
            sessionId,
            agentName,
            ...(customInstructions ? { customInstructions } : {}),
            ...(reason ? { reason } : {}),
            ...(onStarted ? { onStarted } : {}),
        }),
        emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        // MR3: the v1 store/infra/runner test-override seams are gone with the
        // v1 implementation; only production injection points remain below.
        ...(options.wechatRuntimeSdk ? { wechatRuntimeSdkOverride: options.wechatRuntimeSdk } : {}),
        ...(options.telegramTokenVerifyFetcher
            ? { telegramTokenVerifyFetcher: options.telegramTokenVerifyFetcher }
            : {}),
        ...(options.wechatOnboardFetcher ? { wechatOnboardFetcher: options.wechatOnboardFetcher } : {}),
        ...(options.feishuWsEnabled === false ? { feishuWsEnabled: false } : {}),
        ...(options.capabilityProfile === 'cli'
            ? { channelCapabilityPolicy: 'disabled' }
            : {}),
        ...(options.deferChannelStartup === true ? { deferChannelStartup: true } : {}),
        ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
        submitQuestionnaireReply: async ({ agentName, requestId, reply, }) => {
            try {
                await new LocalQuestionnaireService(host.questionnaireServiceDeps()).reply({
                    agentName,
                    requestId,
                    reply,
                });
                return { status: 'accepted' };
            }
            catch (error) {
                if (error instanceof LocalQuestionnaireError) {
                    host.emitBusEvent('questionnaire.reply_rejected', {
                        requestId,
                        agentName,
                        status: error.status,
                        code: error.code,
                    });
                }
                else {
                    host.emitBusEvent('questionnaire.reply_failed', {
                        requestId,
                        agentName,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                return classifyQuestionnaireReplyError(error);
            }
        },
        applyPermissionReply: (input) => applyPermissionReplyFromChannel(host.permissionRouteContext(), input, () => host.emitBusEvent('permission.im_reply_skipped', { ...input })),
        // V2 stores the channel origin in the submitted Turn context. The retired
        // host-local map had no writer after the runtime cutover, so leave this
        // optional legacy projection absent and let permission delivery use the
        // committed event origin.
        runLegacyImCredentialMigration: options.runLegacyImCredentialMigration,
    };
}
function buildChannelAgentResolution(host) {
    return host.runtimeConversation
        ? {
            resolveAgentReadScope: (requestedName) => host.agentResolver.resolveAgentReadScope(requestedName),
            resolveAgentWriteTarget: (requestedName) => host.agentResolver.resolveAgentWriteTarget(requestedName),
        }
        : {};
}
function requireChannelSource(source) {
    if (source === 'channel:wechat' || source === 'channel:feishu' || source === 'channel:telegram')
        return source;
    throw new Error(`Channel enqueue requires a channel source: ${String(source)}`);
}
function buildChannelEnqueue(host, requireConversation) {
    return async (session, body, enqueueOptions) => {
        const source = requireChannelSource(enqueueOptions?.source);
        const ingress = requireConversation().ingress;
        const submit = {
            sessionId: session.sessionId,
            source,
            allowQueue: true,
            message: {
                content: body.content,
                ...(body.attachments ? { attachments: body.attachments } : {}),
                ...(body.quotedMessage ? { quotedMessage: body.quotedMessage } : {}),
                ...(body.channelContext ? { channelContext: body.channelContext } : {}),
            },
            ...(enqueueOptions?.clientRequestId
                ? { clientRequestId: enqueueOptions.clientRequestId }
                : {}),
            ...(enqueueOptions?.dedupeKey ? { dedupeKey: enqueueOptions.dedupeKey } : {}),
            ...(enqueueOptions?.expiresAt !== undefined ? { expiresAt: enqueueOptions.expiresAt } : {}),
        };
        // Only ordinary IM messages opt in to the desktop follow-up preference;
        // other channel enqueues (the dormant `/btw`) keep the plain queue path.
        if (!enqueueOptions?.followComposerSendBehavior) {
            return submitChannelMessage(ingress, submit);
        }
        return routeChannelFollowMessage(channelFollowDeps(host, ingress), { source, submit });
    };
}
/**
 * The follow-up ports for one IM message. Read the late-bound ports per
 * message: the V2 runtime binds the probe after this bundle is built.
 */
function channelFollowDeps(host, ingress) {
    return {
        ingress,
        ...(host.composerSendBehavior ? { composerSendBehavior: host.composerSendBehavior } : {}),
        ...(host.activeTurnChannelProbe ? { activeTurnChannelProbe: host.activeTurnChannelProbe } : {}),
        ...(host.findMergedChannelEvent ? { findMergedChannelEvent: host.findMergedChannelEvent } : {}),
    };
}
function buildChannelFamilyCapabilities(host, requireConversation) {
    return host.runtimeConversation
        ? {
            primaryFamilyRootSessions: {
                listConversationRoots: async (agentName) => (await requireConversation().query.listSessions({
                    agentName,
                    sessionType: 'root',
                    includeSessionKinds: ['conversation'],
                    includeHidden: true,
                    limit: PRIMARY_FAMILY_ROOT_SCAN_LIMIT,
                })).map((session) => ({
                    sessionId: session.sessionId,
                    agentName: session.agentName,
                    runtime: session.runtime,
                    sessionType: session.sessionType,
                    sessionKind: session.sessionKind,
                    archived: session.archived,
                    updatedAtMs: session.updatedAtMs,
                })),
                replaceRoot: async (agentName, sessionId) => {
                    const replacement = await requireConversation().lifecycle.replaceRootSession(agentName, sessionId);
                    return {
                        previousRootSessionIds: replacement.previousRoots.map((root) => root.sessionId),
                    };
                },
                // No `workspaceDir`: that is the existing "return the Agent's Root,
                // creating it only when there is none" path, not a second create.
                ensureRoot: async (agentName) => {
                    const created = await requireConversation().lifecycle.createRootSession({
                        agentName,
                    });
                    return {
                        sessionId: created.sessionId,
                        agentName: created.agentName,
                        runtime: created.runtime,
                        sessionType: created.sessionType,
                        sessionKind: created.sessionKind,
                        archived: created.archived,
                        updatedAtMs: created.updatedAtMs,
                    };
                },
                getAgentRootPointer: async (agentName) => {
                    if (!(await host.agentRuntimePort.agentExists(agentName)))
                        return undefined;
                    const detail = (await host.agentRuntimePort.getAgent({ name: agentName })).agent;
                    return detail?.rootSessionId?.trim() || undefined;
                },
                agentExists: (agentName) => host.agentRuntimePort.agentExists(agentName),
            },
            primaryFamilySessionModels: {
                getSession: async (sessionId) => {
                    const session = await requireConversation().query.getSession(sessionId);
                    return session
                        ? {
                            sessionId: session.sessionId,
                            effectiveModel: session.effectiveModel ?? null,
                            effectiveModelVariant: session.effectiveModelVariant ?? null,
                        }
                        : undefined;
                },
                updateSession: (sessionId, fields) => requireConversation().lifecycle.updateSession(sessionId, fields),
            },
        }
        : {};
}
/**
 * A deleted Agent can leave `credentials/<agent>/*.json` behind. Report it as
 * missing so the migration skips that row instead of aborting startup; any
 * other read failure still propagates.
 */
async function readLegacyCredentialAgent(port, agentName) {
    try {
        return (await port.getAgent({ name: agentName })).agent;
    }
    catch (error) {
        if (isAgentNotFoundError(error))
            return undefined;
        throw error;
    }
}
function buildRootlessChannelCapabilities(host) {
    return host.runtimeConversation
        ? {
            imConversationModel: true,
            legacyImCredentialAgent: async (agentName) => {
                const detail = await readLegacyCredentialAgent(host.agentRuntimePort, agentName);
                if (!detail)
                    return undefined;
                const workspaceDir = canonicalProjectWorkspaceDir(detail.defaultWorkspaceDir);
                const hasConfiguredWorkspace = (detail.defaultWorkspaceDir?.trim().length ?? 0) > 0;
                return {
                    ...(detail.rootSessionId?.trim() ? { rootSessionId: detail.rootSessionId.trim() } : {}),
                    ...readLegacyDefaultProject(workspaceDir, hasConfiguredWorkspace),
                };
            },
            rootlessV2: withRootlessAgentIdentityReads(host.agentRuntimePort, {
                resolveProjectWorkspace: (projectKey) => {
                    if (projectKey === 'default') {
                        return {
                            workspaceDir: host.resolveDefaultWorkspaceDir(),
                            isDefaultWorkspace: true,
                        };
                    }
                    const workspaceDir = workspaceDirFromProjectKey(projectKey);
                    if (!workspaceDir) {
                        throw new LocalChannelRootlessError(400, 'CHANNEL_PROJECT_INVALID', 'The Channel route Project is invalid.');
                    }
                    return { workspaceDir, isDefaultWorkspace: false };
                },
            }),
        }
        : {};
}
function readLegacyDefaultProject(workspaceDir, hasConfiguredWorkspace) {
    if (workspaceDir)
        return { defaultProjectKey: projectKeyForWorkspace(workspaceDir) };
    if (!hasConfiguredWorkspace)
        return { defaultProjectKey: projectKeyForWorkspace(undefined) };
    return {};
}
function hasTrustedLegacyImRootMarker(purpose) {
    return Boolean(purpose === TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER ||
        purpose?.endsWith(`\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`));
}
function appendTrustedLegacyImRootMarker(purpose) {
    return purpose
        ? `${purpose}\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`
        : TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER;
}
//# sourceMappingURL=host-input.js.map