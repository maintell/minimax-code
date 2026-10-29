import { createV2AgentExecutionSource } from './execution-source.js';
import { createV2AgentProfileSource } from './profile-source.js';
import { isGitRepo } from '../../service/workspace/index.js';
import { resolveAgentPromptSurface, createLocalStaticPromptReader, } from '../../service/turn-system/index.js';
/** Decorates product-owned AgentHost capabilities with process-local runtime adapters. */
export function createRuntimeAgentProduct(options) {
    const { baseProduct, agentService, modelConfig, logger, nowMs, runtimeOwnerKind, capabilityProfile, miniappAvailable, implicitCustomProviderThinking, systemPromptOverrides, agentReferenceProjection, inspector, promptSnapshots, internalTurnPromptReads, browserUse, globalInstructions, } = options;
    const baseSkills = baseProduct.preparation.configBuilder.skills;
    return {
        ...baseProduct,
        toolSources: {
            resolve: async (turnInput) => {
                const base = await baseProduct.toolSources.resolve({
                    ...turnInput,
                    miniappAvailable,
                });
                if (turnInput.toolsDisabled)
                    return base;
                const capability = browserUse.resolveTurnCapability({
                    sessionId: turnInput.session.sessionId,
                    turnId: turnInput.turnId,
                    surface: resolveAgentPromptSurface(turnInput.session, runtimeOwnerKind),
                    workspaceRoot: turnInput.session.workspaceDir,
                    baseTools: base.nativeTools,
                    ...(turnInput.allowedExtensionSkillNames === undefined
                        ? {}
                        : { allowedExtensionSkillNames: turnInput.allowedExtensionSkillNames }),
                    ...(turnInput.desktopCapabilities
                        ? { desktopCapabilities: turnInput.desktopCapabilities }
                        : {}),
                });
                return { ...base, nativeTools: capability.tools };
            },
        },
        inputPreparation: {
            ...baseProduct.inputPreparation,
            agentReferenceProjection,
            reminders: {
                ...baseProduct.inputPreparation.reminders,
                buildSystem: async (input) => {
                    const base = await baseProduct.inputPreparation.reminders.buildSystem(input);
                    const browser = browserUse.reminders.buildTurnReminder({
                        sessionId: input.session.sessionId,
                        turnId: input.turnId,
                        surface: resolveAgentPromptSurface(input.session, runtimeOwnerKind),
                        userPrompt: input.promptText,
                        ...allowedExtensionSkillNames(input.agentConfig),
                        ...(input.desktopCapabilities
                            ? { desktopCapabilities: input.desktopCapabilities }
                            : {}),
                    });
                    const diagnostic = mergeReminderDiagnostic(base.diagnostic, browser.diagnostic);
                    return {
                        content: combineSystemReminderContent(base.content, browser.content),
                        ...diagnostic,
                        ...(base.finalizeTelemetry ? { finalizeTelemetry: base.finalizeTelemetry } : {}),
                    };
                },
            },
        },
        agents: createV2AgentExecutionSource(agentService, logger, {
            ensureSessionAgentDefinition: options.ensureSessionAgentDefinition,
        }),
        ...(promptSnapshots ? { promptSnapshots } : {}),
        internalTurnPromptReads,
        preparation: {
            ...baseProduct.preparation,
            configBuilder: {
                ...baseProduct.preparation.configBuilder,
                config: modelConfig.read,
                isGitRepository: baseProduct.preparation.configBuilder.isGitRepository ??
                    ((workspaceDir) => isGitRepo(workspaceDir, AbortSignal.timeout(2_000))),
                skills: {
                    listRuntimeSkills: async (scope) => {
                        const base = await baseSkills.listRuntimeSkills(scope);
                        const skill = browserUse.builtinSkillDescriptor();
                        if (!skill)
                            return base;
                        return {
                            ...base,
                            skills: [
                                ...base.skills.filter((candidate) => normalizedSkillName(candidate.name) !== normalizedSkillName(skill.name)),
                                {
                                    name: skill.name,
                                    description: skill.description,
                                    selectionScope: 'capability-owned',
                                },
                            ],
                        };
                    },
                    renderCatalog: (scope) => {
                        const skill = browserUse.builtinSkillDescriptor();
                        if (!skill)
                            return baseSkills.renderCatalog(scope);
                        return baseSkills.renderCatalog({
                            ...scope,
                            additionalSkills: [
                                ...(scope.additionalSkills ?? []).filter((candidate) => normalizedSkillName(candidate.name) !== normalizedSkillName(skill.name)),
                                { name: skill.name, description: skill.description, builtin: true },
                            ],
                        });
                    },
                },
                nowMs,
                miniappAvailable,
                modelRepairLogger: logger,
                staticPrompts: createLocalStaticPromptReader({ logger, globalInstructions }),
                tuiProductPolicy: runtimeOwnerKind === 'tui',
                ...(promptSnapshots ? { promptSnapshots } : {}),
                ...(implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
                systemPromptOverrides,
                profile: createV2AgentProfileSource(agentService, modelConfig.read, runtimeOwnerKind, capabilityProfile),
            },
            modelResolver: {
                ...baseProduct.preparation.modelResolver,
                ...(implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
                // Capture decorates the host transport rather than replacing it, so the
                // Electron proxy/net fetch still performs every request. Read the
                // resolver defensively: composition roots may omit it entirely. A host
                // without a resolved transport (TUI) still has to observe requests, so
                // capture falls back to the same global fetch the provider SDK would
                // have used on its own instead of skipping the request payload.
                ...(inspector
                    ? {
                        fetchImpl: inspector.wrapResolvedFetch(baseProduct.preparation.modelResolver?.fetchImpl ??
                            globalThis.fetch.bind(globalThis)),
                    }
                    : {}),
            },
        },
        runner: {
            ...baseProduct.runner,
            ...(inspector
                ? {
                    llmCaptureFactory: (turn) => inspector.createRecorder(turn),
                }
                : {}),
        },
        executor: {
            ...baseProduct.executor,
            createTurnToolSafetyGuard: () => browserUse.createTurnToolSafetyGuard(),
        },
        normalExtensions: [browserUse.extension, ...(baseProduct.normalExtensions ?? [])],
    };
}
function normalizedSkillName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function combineSystemReminderContent(baseContent, browserContent) {
    const browser = browserContent.trim();
    if (!browser)
        return baseContent;
    const base = baseContent.trim();
    if (!base)
        return `<system-reminder>\n${browser}\n</system-reminder>`;
    const opening = '<system-reminder>';
    const closing = '</system-reminder>';
    if (!base.startsWith(opening) || !base.endsWith(closing))
        return baseContent;
    const body = base.slice(opening.length, -closing.length).trim();
    return [opening, body, browser, closing].filter(Boolean).join('\n');
}
function mergeReminderDiagnostic(base, browser) {
    if (!browser)
        return base === undefined ? {} : { diagnostic: base };
    const eventAttributes = browserReminderEventAttributes(browser);
    if (base && typeof base === 'object' && !Array.isArray(base)) {
        const record = base;
        return {
            diagnostic: {
                ...record,
                browserUse: browser,
                ...(eventAttributes
                    ? {
                        eventAttributes: {
                            ...(isRecord(record.eventAttributes) ? record.eventAttributes : {}),
                            ...eventAttributes,
                        },
                    }
                    : {}),
            },
        };
    }
    return {
        diagnostic: {
            ...(base === undefined ? {} : { base }),
            browserUse: browser,
            ...(eventAttributes ? { eventAttributes } : {}),
        },
    };
}
function browserReminderEventAttributes(diagnostic) {
    if (diagnostic.browserControlDisabled !== true)
        return undefined;
    return {
        browserControlDisabled: true,
        browserOperationIntentDetected: diagnostic.browserOperationIntentDetected === true,
        browserDisabledGuidanceInjected: diagnostic.browserDisabledGuidanceInjected === true,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function allowedExtensionSkillNames(agentConfig) {
    const profile = isRecord(agentConfig.agent_profile) ? agentConfig.agent_profile : undefined;
    const selection = isRecord(profile?.config_selection) ? profile.config_selection : undefined;
    const value = selection?.extensionSkills;
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? { allowedExtensionSkillNames: value }
        : {};
}
//# sourceMappingURL=runtime-agent-product.js.map