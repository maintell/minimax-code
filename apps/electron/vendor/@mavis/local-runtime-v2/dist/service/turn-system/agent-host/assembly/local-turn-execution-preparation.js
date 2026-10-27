import { isRuntimeToolInputValid } from '@mavis/agent-core/tools';
import { resolveAskUserReminder, } from '../preparation/config/ask-user-reminder.js';
import { LocalTurnPermissionGate } from '../runner/policy/local-turn-permission-gate.js';
import { LocalTurnInputPreparer } from './local-turn-input-preparation.js';
import { readTrustedBuiltinAgentProfileIdentity } from './local-turn-tool-catalog-source.js';
import { emitLocalPluginHookWarnings, localPluginHookCoordinator, } from './local-turn-plugin-hooks.js';
/**
 * Native v2 execution-preparation adapter. It is deliberately constructed
 * inside AgentHost composition so production callers inject raw fact owners,
 * never arbitrary message/caller/tool-context builders.
 */
export class NativeLocalTurnExecutionPreparationSource {
    inputPreparer;
    permission;
    askUserPolicy;
    logger;
    constructor(inputPreparer, permission, 
    /** Absent for hosts without Goal/config ports; AskUser reminders are then skipped. */
    askUserPolicy, logger) {
        this.inputPreparer = inputPreparer;
        this.permission = permission;
        this.askUserPolicy = askUserPolicy;
        this.logger = logger;
    }
    async prepare(input) {
        const prepared = await this.inputPreparer.prepare({
            lease: input.execution.lease,
            session: input.execution.session,
            agent: input.execution.agent,
            preparation: input.execution.preparation,
            canonicalUserInput: input.execution.canonicalUserInput,
            genuineUserQueryText: input.execution.request.genuineUserQueryText,
            immediateSendBatch: input.execution.request.immediateSendBatch,
            provenance: input.execution.request.provenance,
            ...(input.execution.desktopCapabilities
                ? { desktopCapabilities: input.execution.desktopCapabilities }
                : {}),
            history: (input.execution.runnerHistory ?? input.execution.history)?.messages ?? [],
        });
        const askUserReminder = await resolveAskUserReminder(input.execution, this.askUserPolicy, this.logger);
        const browserAssets = [...(prepared.browserAssets ?? [])];
        const context = createToolContext(input.execution, input.eventWriter, browserAssets, prepared.channelContext);
        let nextSteeringMessageIndex = input.execution.request.immediateSendBatch?.members.length ??
            input.execution.canonicalUserInput.messages.length;
        // One per-Turn readiness guard for native bash. The guard is fresh
        // per Turn so resolved state and in-flight batches do not leak between
        // turns on a shared gate instance; on non-Windows hosts the injected
        // resolver is absent and the guard is a no-op for the existing Bash
        // permission path.
        const shellReadinessGuard = this.permission.createShellReadinessGuard({
            hasShell: Boolean(input.execution.preparation.agentShell),
            sessionId: input.execution.lease.sessionId,
        });
        return {
            promptText: prepared.promptText,
            genuineUserQueryText: prepared.genuineUserQueryText,
            initialBatchMessages: prepared.initialBatchMessages,
            initialBatchGenuineUserQueryTexts: prepared.initialBatchGenuineUserQueryTexts,
            userMessage: prepared.userMessage,
            caller: prepared.caller,
            // AskUser blocks trail the other Turn reminders; order only matters for
            // readability because history detection matches complete blocks.
            reminderBlocks: askUserReminder
                ? [...prepared.reminderBlocks, askUserReminder]
                : prepared.reminderBlocks,
            loadBackgroundReminder: prepared.loadBackgroundReminder,
            ...(prepared.systemReminderDiagnostic !== undefined
                ? { systemReminderDiagnostic: prepared.systemReminderDiagnostic }
                : {}),
            prepareSteering: async (steering) => {
                const messageIndexOffset = nextSteeringMessageIndex;
                nextSteeringMessageIndex += 1 + (steering.message.queuedMessages?.length ?? 0);
                const preparedSteering = await this.inputPreparer.prepareSteering({
                    lease: input.execution.lease,
                    preparation: input.execution.preparation,
                    message: steering.message,
                    genuineUserQueryText: steering.genuineUserQueryText,
                    provenance: steering.provenance,
                    messageIndexOffset,
                    computerUseAvailable: input.execution.assembly.tools.some((tool) => tool.def.name.startsWith('computer_')),
                    desktopCapabilities: input.execution.desktopCapabilities,
                });
                browserAssets.push(...(preparedSteering.browserAssets ?? []));
                return {
                    userMessage: preparedSteering.userMessage,
                    genuineUserQueryText: preparedSteering.genuineUserQueryText,
                };
            },
            toolResolution: {
                context,
                disableBuiltinToolFallback: true,
                permissionGuard: async (toolContext, signal) => {
                    // Readiness runs FIRST so a missing binding can never reach the
                    // permission engine. A signal cancellation must not release the
                    // block; the guard keeps the call out of `beforeToolCall` and the
                    // tool executor regardless.
                    const readinessBlock = await shellReadinessGuard(toolContext, signal ?? input.execution.lease.signal);
                    if (readinessBlock)
                        return readinessBlock;
                    return this.permission.beforeToolCall({
                        sessionId: input.execution.lease.sessionId,
                        turnId: input.execution.lease.turnId,
                        agentName: input.execution.agent.agentName,
                        model: `${input.execution.preparation.llm.model.provider}/${input.execution.preparation.llm.model.id}`,
                        cwd: input.execution.session.workspaceDir,
                        toolContext,
                        trustedExactWritePaths: context.trustedExactWritePaths,
                        signal: signal ?? input.execution.lease.signal,
                        preToolPermission: input.execution.pluginApprovalRequests?.get(toolContext.toolCall.id),
                        sessionLineage: {
                            miniApp: input.execution.session.miniAppOrigin !== undefined,
                            parentSessionId: input.execution.session.parentSessionId,
                        },
                        ...(prepared.channelContext ? { channelContext: prepared.channelContext } : {}),
                        ...(input.execution.pluginHooks?.length
                            ? {
                                beforeApproval: createPluginPermissionRequestHook(input.execution),
                            }
                            : {}),
                    });
                },
            },
        };
    }
}
function createPluginPermissionRequestHook(execution) {
    return async (approval) => {
        const result = await localPluginHookCoordinator.runEvent(execution.pluginHooks ?? [], {
            event: 'PermissionRequest',
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            cwd: execution.session.workspaceDir,
            ...execution.pluginHookRuntimeContext,
            ...pluginToolProvenance(execution.pluginMcpToolOwners, execution.pluginToolApprovalTargets, approval.toolUseId, approval.toolName),
            matcherValue: approval.toolName,
            payload: {
                tool_name: approval.toolName,
                tool_input: approval.toolInput,
                tool_use_id: approval.toolUseId,
                reason: approval.reason,
                permission_rule_contents: approval.ruleContents,
            },
        }, approval.signal);
        await emitLocalPluginHookWarnings({
            reporter: execution.pluginHookEventReporter,
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            event: 'PermissionRequest',
            result,
        });
        const updatedInput = result.decision.updatedInput;
        if (!isValidPluginPermissionRewrite(execution, approval.toolUseId, approval.toolName, updatedInput)) {
            return {
                behavior: 'deny',
                reason: result.decision.stopReason ??
                    result.decision.reason ??
                    `PermissionRequest Plugin Hook returned invalid input for ${approval.toolName}.`,
                ...(result.decision.continue === false || result.decision.interrupt === true
                    ? { terminateAgent: true }
                    : {}),
            };
        }
        return toPluginPermissionDecision(result.decision, updatedInput);
    };
}
function isValidPluginPermissionRewrite(execution, toolUseId, toolName, updatedInput) {
    const approvalTarget = execution.pluginToolApprovalTargets?.get(toolUseId);
    return (updatedInput === undefined ||
        (approvalTarget
            ? isRuntimeToolInputValid([
                {
                    ...approvalTarget.tool,
                    def: {
                        ...approvalTarget.tool.def,
                        name: toolName,
                        schema: approvalTarget.inputSchema,
                    },
                },
            ], toolName, updatedInput)
            : isRuntimeToolInputValid(execution.assembly.tools, toolName, updatedInput)));
}
function toPluginPermissionDecision(decision, updatedInput) {
    const stopped = decision.continue === false || decision.interrupt === true;
    return {
        behavior: decision.permissionDecision ?? 'abstain',
        ...(decision.permissionAutoApproval ? { autoApproval: decision.permissionAutoApproval } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(stopped
            ? {
                terminateAgent: true,
                reason: decision.stopReason ?? decision.reason ?? 'Agent stopped by Plugin Hook.',
            }
            : {}),
        ...(updatedInput ? { updatedInput } : {}),
        ...(decision.updatedPermissions?.length
            ? { updatedPermissions: decision.updatedPermissions }
            : {}),
    };
}
function pluginToolProvenance(owners, approvalTargets, toolUseId, toolName) {
    const approvalTarget = approvalTargets?.get(toolUseId);
    if (approvalTarget?.pluginName) {
        return {
            toolProvenance: { kind: 'plugin_host', pluginName: approvalTarget.pluginName },
        };
    }
    const pluginName = owners?.get(toolName);
    return pluginName ? { toolProvenance: { kind: 'plugin_mcp', pluginName } } : {};
}
function createToolContext(execution, eventWriter, browserAssets, channelContext) {
    const identity = readTrustedBuiltinAgentProfileIdentity(execution.preparation.agentConfig.agent_profile);
    const forceReadOnlyFilesystem = identity.trustedBuiltin && identity.canonicalViewName === 'explore';
    return {
        sessionId: execution.lease.sessionId,
        turnId: execution.lease.turnId,
        agentName: execution.agent.agentName,
        parentAgentConfig: execution.preparation.agentConfig,
        eventWriter,
        browserAssets,
        ...(forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
        ...(execution.pluginHookEventReporter ? { reporter: execution.pluginHookEventReporter } : {}),
        trustedExactWritePaths: execution.assemblyContext.plan
            ? [execution.assemblyContext.plan.canonicalPath]
            : [],
        // ask_user picks the Plan policy from the same fact the ask-user-policy
        // reminder reads (assemblyContext.plan), so the two cannot disagree.
        ...(execution.assemblyContext.plan?.active === true ? { askUserPlanActive: true } : {}),
        ...(channelContext ? { channelContext } : {}),
    };
}
//# sourceMappingURL=local-turn-execution-preparation.js.map