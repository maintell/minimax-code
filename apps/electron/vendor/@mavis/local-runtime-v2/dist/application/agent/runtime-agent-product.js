import { createV2AgentExecutionSource } from './execution-source.js';
import { createV2AgentProfileSource } from './profile-source.js';
import { createComputerUseTurnToolSafetyGuard, } from '../../service/computer-use/index.js';
import { isGitRepo } from '../../service/workspace/index.js';
import { createModelAccessAuthoring, withCapabilityOwnedSkills, } from './capability-owned-skills.js';
import { resolveAgentPromptSurface, createLocalStaticPromptReader, } from '../../service/turn-system/index.js';
/** Decorates product-owned AgentHost capabilities with process-local runtime adapters. */
export function createRuntimeAgentProduct(options) {
    const { baseProduct, agentService, modelConfig, logger, nowMs, runtimeOwnerKind, capabilityProfile, miniappAvailable, pptPreviewAvailable, implicitCustomProviderThinking, systemPromptOverrides, agentReferenceProjection, inspector, promptSnapshots, internalTurnPromptReads, browserUse, globalInstructions, } = options;
    const baseSkills = baseProduct.preparation.configBuilder.skills;
    const authoring = createModelAccessAuthoring(options.modelAccessExtensionTool, runtimeOwnerKind);
    return {
        ...baseProduct,
        toolSources: {
            resolve: async (turnInput) => {
                const base = await baseProduct.toolSources.resolve({
                    ...turnInput,
                    miniappAvailable,
                    pptPreviewAvailable,
                });
                if (turnInput.toolsDisabled)
                    return base;
                const capability = browserUse.resolveTurnCapability({
                    sessionId: turnInput.session.sessionId,
                    turnId: turnInput.turnId,
                    surface: resolveAgentPromptSurface(turnInput.session, runtimeOwnerKind),
                    workspaceRoot: turnInput.session.workspaceDir,
                    baseTools: base.nativeTools,
                    ...(turnInput.desktopCapabilities
                        ? { desktopCapabilities: turnInput.desktopCapabilities }
                        : {}),
                });
                return { ...base, nativeTools: authoring.tools(capability.tools, turnInput.session) };
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
                skills: withCapabilityOwnedSkills(baseSkills, (surface) => [browserUse.builtinSkillDescriptor(), authoring.skillFor(surface)].filter((skill) => skill !== undefined)),
                nowMs,
                miniappAvailable,
                pptPreviewAvailable,
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
            // Browser and Computer Use each keep their own per-turn state; neither
            // replaces the other. The first guard that blocks a call decides.
            createTurnToolSafetyGuard: () => combineTurnToolSafetyGuards([
                browserUse.createTurnToolSafetyGuard(),
                createComputerUseTurnToolSafetyGuard(),
            ]),
            // PTC state logs name the product surface. The TUI exec entry point is
            // known only to the host process, so exec reads `tui` here.
            ptcSurface: ptcSurfaceOf(runtimeOwnerKind),
        },
        normalExtensions: [browserUse.extension, ...(baseProduct.normalExtensions ?? [])],
    };
}
function ptcSurfaceOf(runtimeOwnerKind) {
    if (runtimeOwnerKind === 'electron')
        return 'desktop';
    return runtimeOwnerKind === 'tui' ? 'tui' : 'other';
}
/** The first guard that blocks decides; every guard observes every result. */
function combineTurnToolSafetyGuards(guards) {
    return {
        async beforeToolCall(input, signal) {
            for (const guard of guards) {
                const decision = await guard.beforeToolCall(input, signal);
                if (decision)
                    return decision;
            }
            return undefined;
        },
        async afterToolCall(input, signal) {
            for (const guard of guards)
                await guard.afterToolCall(input, signal);
        },
    };
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
//# sourceMappingURL=runtime-agent-product.js.map