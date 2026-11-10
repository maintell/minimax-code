/**
 * LocalPermissionFacade — permission orchestration backed by the deterministic
 * checkers + the cloud gateway.
 *
 * The split:
 *   - Deterministic layer: `PermissionEngine` dispatches
 *     `BashToolPermissionChecker` / `FsToolPermissionChecker`; Permission Core
 *     is the default final reducer. Together they produce all rule contents
 *     (`bash(npm publish:*)`), rewrittenInput (`rm` → `mavis-trash`), and
 *     bypass-immune flags; these define every wire shape (UI, route JSON,
 *     persisted rules).
 *   - Decision layer: the `PermissionMode` (`default` / `auto` /
 *     `bypassPermissions`) is mapped to an `AskForApproval` policy
 *     (`on-request` / `on-request-llm` / `never`) for policy clarity, but the
 *     flow is routed through `PermissionEngine.checkPermission(...)` with a
 *     snapshotted `core` (default) or `engine` (rollback) policy owner.
 *   - LLM layer: `auto` mode consults `HttpCloudGatewayClient` →
 *     `POST /mavis/api/v1/permission/check`. acceptEdits is normalized to
 *     `default` at entry.
 *
 * `LocalPermissionApprovalService` owns pending/dedupe/waiter/persistence;
 * routes only adapt the typed `permission.ask` product-event flow. The facade is a pure
 * synchronous-ish decision function from their POV (modulo the cloud gateway
 * await for `auto` mode).
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { PermissionEngine, registerDefaultCheckers, HttpCloudGatewayClient, modeToAskPolicy, renderConversationContext, formatDecisionReason, formatAutoClassifierReason, createToolPermissionContext, createPermissionExecutionPlan, shouldUseCloudClassify, detectMessagesLocale, } from '@mavis/permission';
import { LocalPermissionStoreUnhealthyError, } from '../rules/rules.js';
import { logger } from '../../../infra/logging/logger.js';
import { readLocalPermissionMode } from '../request-contracts.js';
import { applyAskGate } from './ask-gate.js';
import { evaluateLocalPermissionCheck } from './checkers.js';
import { evaluateNativeDeleteSafety, evaluatePosixTrashSafety, evaluateWindowsHardSafety, needsDeleteRewrite, runtimeCheckerShell, } from './runtime-safety.js';
import { classifyDenySource, formatTimeoutSuffixSeconds, isOrdinaryFallbackAsk, mapClassifierRecommendation, resolveBoundaryDenial, resolveLocalPolicyAsk, serializeToolInput, } from './verdict-mapping.js';
function readPermissionPolicyOwner(value) {
    if (value === undefined || value === 'core')
        return 'core';
    return 'engine';
}
/** A Hook recheck keeps its validated plan's setting; otherwise read the current opt-in. */
function readNativeDelete(params, config) {
    return params.nativeDeleteSnapshot ?? config.permission?.nativeDelete === true;
}
/**
 * Convert a structured decision reason into diagnostic fields. Bash
 * subcommands retain their command and safety detail so operators can explain
 * an allow/ask/deny without consulting messages.jsonl. A matched rule keeps its
 * content so the log names the exact rule. Filesystem reasons still omit the
 * tool's own paths and free-form descriptions.
 */
function permissionReasonLogFields(reason, includeSafetyDetail = false) {
    const reasonCode = {
        rule: 'persisted_rule',
        safetyCheck: 'safety_check',
        workingDirectory: 'working_directory_boundary',
        internalWhitelist: 'internal_whitelist',
        sessionOwnedReadablePath: 'session_owned_readable_path',
        trustedExactWrite: 'trusted_exact_write',
        tempDirectory: 'temp_directory',
        sandbox: 'sandbox',
        mode: 'permission_mode',
        pathValidation: 'path_validation',
        dangerousRemoval: 'dangerous_removal',
        subcommandResults: 'subcommand_results',
        rmRewrite: 'recoverable_delete_rewrite',
        recoverableDeleteRewrite: 'recoverable_delete_rewrite',
    };
    const fields = { reason_code: reasonCode[reason.type] };
    if (reason.type === 'rule') {
        fields.rule_source = reason.rule.source;
        fields.rule_behavior = reason.rule.ruleBehavior;
        fields.rule_tool_name = reason.rule.ruleValue.toolName;
        if (reason.rule.ruleValue.ruleContent)
            fields.rule_content = reason.rule.ruleValue.ruleContent;
    }
    else if (reason.type === 'mode') {
        fields.reason_mode = reason.mode;
    }
    else if (reason.type === 'safetyCheck') {
        if (includeSafetyDetail)
            fields.reason_detail = reason.description;
        if (reason.category)
            fields.reason_category = reason.category;
    }
    else if (reason.type === 'subcommandResults') {
        fields.subcommand_results = [...reason.reasons].map(([command, result]) => ({
            command,
            behavior: result.behavior,
            reason_type: result.reason.type,
            ...permissionReasonLogFields(result.reason, true),
        }));
    }
    return fields;
}
function readCommand(input) {
    if (typeof input.command === 'string')
        return input.command;
    return typeof input.cmd === 'string' ? input.cmd : undefined;
}
function bashCommandLogFields(toolName, command) {
    return toolName === 'bash' && command ? { command } : {};
}
function normalizeEngineMode(mode) {
    if (mode === 'acceptEdits')
        return 'default';
    return mode === 'off' ? 'bypassPermissions' : mode;
}
// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------
export class LocalPermissionFacade {
    shellResolver;
    deps;
    cloudGateway;
    engine;
    cloudGatewayTimeoutMs;
    /** Last `permission.context` written per Session: the local day plus the settings. */
    loggedPermissionContexts = new Map();
    constructor(deps) {
        this.deps = deps;
        this.cloudGatewayTimeoutMs = deps.cloudGatewayTimeoutMs ?? 60_000;
        this.cloudGateway =
            deps.cloudGateway ?? new HttpCloudGatewayClient({ timeoutMs: this.cloudGatewayTimeoutMs });
        this.engine = new PermissionEngine();
        registerDefaultCheckers(this.engine);
    }
    /** Host-owned Session shell binding; never derived from tool or HTTP input. */
    bindShellResolver(resolve) {
        this.shellResolver = resolve;
    }
    async withShell(params) {
        if (!this.shellResolver || !params.sessionId)
            return params;
        // Non-Bash tools never wait for a session shell binding: read, edit, write, etc.
        // do not need an executor shell, and forcing a probe here would unnecessarily
        // block the deterministic permission path. Only Bash carries an executor
        // shell, so only Bash resolves the binding.
        if (params.toolName !== 'bash')
            return params;
        return { ...params, trustedShellFamily: await this.shellResolver(params.sessionId) };
    }
    /**
     * Decision entrypoint. Consumed by routes and the pi-turn-runner
     * beforeToolCall hook.
     *
     * This is a thin wrapper. The actual decision pipeline lives in
     * {@link checkPermissionRaw}; this wrapper exists solely to feed
     * the raw verdict through {@link applyAskGate} so the
     * `bypassPermissions` ("始终允许") invariant — _no card ever
     * surfaces in this mode_ — is enforced in one place rather than
     * scattered across the 22 sites that can produce `behavior: 'ask'`.
     *
     * The mode is snapshotted ONCE at this entrypoint and threaded into
     * the raw pipeline and the gate. `configGetter()` is a live view of
     * daemon config, and `PUT /config { permissionMode: ... }` can flip
     * it mid-call between two `await` boundaries; reading it twice would
     * let the raw pipeline and the gate disagree about which mode is
     * active. In the worst case (user tightens `bypassPermissions` →
     * `default` mid-call), a stale `'bypassPermissions'` snapshot in the
     * gate would downgrade a freshly-asked credential read to ALLOW.
     *
     * If you need to read the unmodified verdict (tests, telemetry,
     * future debug surfaces), call {@link checkPermissionRaw} directly.
     */
    async checkPermission(unresolvedParams) {
        const config = this.deps.configGetter();
        const nativeDelete = readNativeDelete(unresolvedParams, config);
        const configuredMode = readLocalPermissionMode(config.permissionMode);
        const policyOwner = readPermissionPolicyOwner(config.permission?.policyOwner);
        const params = await this.withShell(unresolvedParams);
        const pluginContext = await this.resolvePluginHookPermissionContext(params);
        const rawMode = pluginContext.mode ?? params.permissionModeOverride ?? configuredMode;
        // The raw pipeline and the execution plan share this one nativeDelete snapshot.
        const verdict = await this.checkPermissionRaw({ ...params, nativeDeleteSnapshot: nativeDelete }, rawMode, policyOwner, pluginContext);
        // acceptEdits is normalized to default inside the raw pipeline, but
        // the gate cares only about bypassPermissions; passing the raw mode
        // through unchanged is correct.
        const gatedVerdict = applyAskGate(verdict, rawMode);
        const finalVerdict = await this.addExecutionPlan(params, gatedVerdict, rawMode, nativeDelete);
        logger.info({
            ...(params.sessionId ? { session_id: params.sessionId } : {}),
            tool_name: params.toolName,
            permission_mode: rawMode,
            policy_owner: policyOwner,
            raw_behavior: verdict.behavior,
            final_behavior: finalVerdict.behavior,
            ask_gate_applied: verdict.behavior !== finalVerdict.behavior,
            rewrite_applied: Boolean(finalVerdict.rewrittenInput),
            execution_plan_present: Boolean(finalVerdict.executionPlan),
            transform_count: finalVerdict.executionPlan?.transforms.length ?? 0,
            raw_rule_count: verdict.ruleContents?.length ?? 0,
            ...(finalVerdict.denySource ? { deny_source: finalVerdict.denySource } : {}),
        }, 'permission.decision');
        return finalVerdict;
    }
    /** Bash always carries a plan so execution keeps the shell this decision authorized. */
    async addExecutionPlan(params, verdict, mode, nativeDelete) {
        const skipsPlan = params.toolName !== 'bash' && mode === 'off' && verdict.rewrittenInput === undefined;
        if (verdict.behavior === 'deny' || skipsPlan)
            return verdict;
        return {
            ...verdict,
            executionPlan: createPermissionExecutionPlan({
                toolName: params.toolName,
                input: params.input,
                ...(verdict.rewrittenInput ? { rewrittenInput: verdict.rewrittenInput } : {}),
                shell: params.trustedShellFamily ?? this.deps.shellFamily ?? 'unknown',
                context: {
                    workingDirectory: await this.resolveWorkingDirectory(params.sessionId, params.agentName),
                    homeDir: homedir(),
                    platform: this.deps.platform ?? process.platform,
                },
                nativeDelete,
            }),
        };
    }
    /**
     * The unmodified decision pipeline. Returns whatever the chain
     * (runtime safety boundary → off short-circuit → engine →
     * cloud-gateway for `auto`) decides, including `ask` verdicts that
     * would otherwise be downgraded under bypassPermissions.
     *
     * `effectiveMode` is the mode snapshot the caller wants this call to
     * use. {@link checkPermission} threads in a single snapshot so the
     * raw pipeline and the ask-gate cannot disagree across an `await`
     * boundary when the user flips `PUT /config { permissionMode }`
     * mid-decision. External callers (tests, telemetry) can omit it; the
     * pipeline then falls back to a fresh `configGetter()` read — fine
     * for non-prod, but never re-used across the gate.
     *
     * Only {@link checkPermission} and tests should call this directly.
     */
    async checkPermissionRaw(unresolvedParams, effectiveMode, effectivePolicyOwner, resolvedPluginContext) {
        // The public entrypoint already resolved this invocation, including an absent binding.
        // Re-resolving here could authorize with a different family than the execution plan.
        const params = resolvedPluginContext || unresolvedParams.trustedShellFamily
            ? unresolvedParams
            : await this.withShell(unresolvedParams);
        const config = this.deps.configGetter();
        const pluginContext = resolvedPluginContext ?? (await this.resolvePluginHookPermissionContext(params));
        const rawMode = pluginContext.mode ??
            effectiveMode ??
            params.permissionModeOverride ??
            readLocalPermissionMode(config.permissionMode);
        const policyOwner = effectivePolicyOwner ?? readPermissionPolicyOwner(config.permission?.policyOwner);
        const platform = this.deps.platform ?? process.platform;
        const unboundShell = this.denyUnboundShell(params, platform);
        if (unboundShell)
            return unboundShell;
        const nativeDelete = readNativeDelete(params, config);
        return this.checkRuntimeSafety(params, {
            rawMode,
            policyOwner,
            platform,
            pluginContext,
            nativeDelete,
        });
    }
    /**
     * A bound Windows Session runs Bash only through its resolved shell. Never
     * fall back to a guessed shell while that binding is absent.
     */
    denyUnboundShell(params, platform) {
        if (platform !== 'win32' ||
            !this.shellResolver ||
            !params.sessionId ||
            params.toolName !== 'bash' ||
            params.trustedShellFamily) {
            return undefined;
        }
        return {
            behavior: 'deny',
            denySource: 'safety-immune',
            reason: 'AGENT_SHELL_UNAVAILABLE: no session Shell is bound. Continue with non-shell tools and retry after Shell availability is restored.',
        };
    }
    runtimeSafetyDeps() {
        return {
            configGetter: this.deps.configGetter,
            shellFamily: this.deps.shellFamily,
            trashRuntimeProbe: this.deps.trashRuntimeProbe,
            resolveExplicitWorkspaceDirectory: (sessionId, agentName) => this.resolveExplicitWorkspaceDirectory(sessionId, agentName),
            resolveWorkingDirectory: (sessionId, agentName) => this.resolveWorkingDirectory(sessionId, agentName),
        };
    }
    /** The TUI startup opt-out only ever applies to Windows hosts. */
    skipsWindowsHardSafety(platform) {
        return platform === 'win32' && this.deps.skipWindowsHardSafetyChecks === true;
    }
    async checkRuntimeSafety(params, snapshot) {
        const { rawMode, platform, nativeDelete } = snapshot;
        const request = {
            params,
            platform,
            command: readCommand(params.input),
            nativeDelete,
            skipWindowsHardSafetyChecks: this.skipsWindowsHardSafety(platform),
        };
        const deps = this.runtimeSafetyDeps();
        let runtimeSafety = await evaluateWindowsHardSafety(deps, request);
        if (runtimeSafety.denial)
            return runtimeSafety.denial;
        const posixTrashSafety = nativeDelete
            ? undefined
            : evaluatePosixTrashSafety(this.deps.configGetter, platform, request.command);
        if (posixTrashSafety)
            return posixTrashSafety;
        if (nativeDelete) {
            runtimeSafety = await evaluateNativeDeleteSafety(deps, request, runtimeSafety);
            if (runtimeSafety.denial)
                return runtimeSafety.denial;
        }
        // Off mode skips permission review, but recoverable deletion still needs the engine rewrite.
        if (rawMode === 'off' && !needsDeleteRewrite(request)) {
            return {
                behavior: 'allow',
                reason: 'Allowed: permission mode is off; permission review was skipped.',
            };
        }
        return this.checkPolicy(params, snapshot, runtimeSafety);
    }
    async checkPolicy(params, snapshot, windowsHardSafety) {
        const { rawMode, policyOwner, platform, nativeDelete } = snapshot;
        const command = readCommand(params.input);
        // acceptEdits is an alias for default with seeded allow rules.
        // Never propagate acceptEdits into the engine.
        const mode = normalizeEngineMode(rawMode);
        const askPolicy = modeToAskPolicy(mode);
        // Coarse user-locale hint so the rendered reason matches the user's
        // language: sniff inline messages first, fall back to the session's
        // recent messages. We use the inline hints only here; the cloud-classifier
        // path below already loads recent messages for conversation_context and
        // re-uses them.
        const localeHint = this.resolveInlineLocaleHint(params);
        // Snapshot rules + build the ToolPermissionContext.
        const loaded = await this.loadRules(params, snapshot);
        if ('behavior' in loaded)
            return loaded;
        const { rules } = loaded;
        const workingDirectory = windowsHardSafety.workingDirectory ??
            (await this.resolveWorkingDirectory(params.sessionId, params.agentName));
        const ctx = this.createPolicyContext(params, { mode, snapshot, rules, workingDirectory });
        this.logPermissionContext(params.sessionId, ctx);
        // Local-runtime-only safety net. Splits into two kinds so we don't
        // regress "始终允许":
        //
        //   - bypass-immune  → UNC/network-share access, recursive deletion of
        //     `/` or `~`. Stays a deny across every askPolicy because no user
        //     toggle should make these reachable.
        //
        //   - policy        → sensitive credential paths (`~/.ssh`, `*.pem`,
        //     …). Under bypassPermissions we skip it entirely so the engine's
        //     fast-allow / rule store can speak; under default/auto we let the
        //     engine run first and demote allow → ask so the cloud gateway or
        //     the user can clear it (routes to the LLM gate, per bash-fast-allow).
        //
        //   - ask           → curl-pipe-shell, shell substitution, slow
        //     unbounded scan, recursive rm, workspace-escape. Same upgrade
        //     allow → ask logic as before; ASK was never bypass-immune.
        const localHardCheck = evaluateLocalPermissionCheck({
            toolName: params.toolName,
            input: params.input,
            workspaceDir: workingDirectory,
            platform,
            skipWindowsHardSafetyChecks: this.skipsWindowsHardSafety(platform),
            ...runtimeCheckerShell(this.deps.shellFamily, params, nativeDelete),
        });
        const boundaryDenial = resolveBoundaryDenial({
            params,
            localHardCheck,
            recoverableNativeDelete: windowsHardSafety.recoverableNativeDelete,
            rules,
            localeHint,
        });
        if (boundaryDenial)
            return boundaryDenial;
        // Run the deterministic engine. Output carries:
        //   - behavior (allow / ask / deny)
        //   - reason (structured DecisionReason — rendered with reason-format)
        //   - ruleContents (BashChecker/FsChecker normalized — e.g. "npm publish:*")
        //   - rewrittenInput (rm → mavis-trash)
        //   - skipAutoClassifier (defensive net — keep ask out of LLM)
        const decision = this.engine.checkPermission(params.toolName, params.input, ctx, {
            policyOwner,
            onCheckerDecision: (trace) => {
                logger.info({
                    ...(params.sessionId ? { session_id: params.sessionId } : {}),
                    tool_name: params.toolName,
                    permission_mode: mode,
                    policy_owner: policyOwner,
                    checker_registered: trace.checkerRegistered,
                    checker_behavior: trace.checkerBehavior,
                    ...(params.toolName === 'bash' && command ? { command } : {}),
                    ...(trace.reasonType ? { reason_type: trace.reasonType } : {}),
                    ...(trace.reason
                        ? permissionReasonLogFields(trace.reason, params.toolName === 'bash')
                        : {}),
                    rewrite_applied: trace.rewriteApplied,
                    rule_count: trace.ruleCount,
                    skip_auto_classifier: trace.skipAutoClassifier,
                }, 'permission.checker.decision');
            },
        });
        logger.info({
            ...(params.sessionId ? { session_id: params.sessionId } : {}),
            tool_name: params.toolName,
            permission_mode: mode,
            policy_owner: policyOwner,
            policy_behavior: decision.behavior,
            ...bashCommandLogFields(params.toolName, command),
            reason_type: decision.reason.type,
            ...permissionReasonLogFields(decision.reason, params.toolName === 'bash'),
            rewrite_applied: Boolean(decision.rewrittenInput),
            rule_count: decision.ruleContents?.length ?? 0,
            skip_auto_classifier: decision.skipAutoClassifier === true,
        }, `permission.${policyOwner}.decision`);
        if (loaded.unhealthyStoreReason && decision.behavior !== 'deny') {
            return {
                behavior: 'ask',
                reason: loaded.unhealthyStoreReason,
                rewrittenInput: decision.rewrittenInput,
            };
        }
        return this.resolveEngineDecision({
            params,
            decision,
            localHardCheck,
            rules,
            askPolicy,
            workingDirectory,
            localeHint,
            policyOwner,
        });
    }
    async resolveEngineDecision(input) {
        const { params, decision, localHardCheck, rules, askPolicy, workingDirectory, localeHint, policyOwner, } = input;
        // policy deny (sensitive credential path) under default/auto — demote
        // allow → ask so the LLM gate / user can authorize. Under
        // bypassPermissions we skip this branch so the engine's allow stays
        // allow (matches "始终允许" semantics).
        //
        // Exception: when the user has a persisted allow rule that matches this
        // tool call (either via the engine's rule match or the local rule store's
        // content-specific matching — e.g. web_fetch(*)), the user has explicitly
        // authorized this tool; overriding it back to ask would make the stored
        // rule ineffective and cause repeated permission popups on every call
        // despite the user clicking "Always allow".
        const policyAsk = resolveLocalPolicyAsk({ askPolicy, localHardCheck, decision, rules, params });
        if (policyAsk)
            return policyAsk;
        // bypassPermissions ('never') no longer needs an `allow → ask`
        // upgrade for local hard-check ASKs. The ask-gate
        // ({@link applyAskGate}) now sits at the public entrypoint and
        // downgrades any ASK verdict back to ALLOW when
        // `mode === 'bypassPermissions'`. Honouring the local checker's
        // ASK here would only be visible through `checkPermissionRaw`
        // (tests, telemetry); it stays a no-op for the production path.
        // ALLOW / DENY — return as-is, render reason from structured DecisionReason.
        if (decision.behavior === 'allow') {
            return {
                behavior: 'allow',
                reason: formatDecisionReason(decision.reason, 'allow', localeHint),
                rewrittenInput: decision.rewrittenInput,
            };
        }
        if (decision.behavior === 'deny') {
            return {
                behavior: 'deny',
                reason: formatDecisionReason(decision.reason, 'deny', localeHint),
                denySource: classifyDenySource(decision.reason),
            };
        }
        // ASK — fold with askPolicy.
        const baseAsk = {
            behavior: 'ask',
            reason: formatDecisionReason(decision.reason, 'ask', localeHint),
            ruleContents: decision.ruleContents,
            ruleMatchers: decision.ruleMatchers,
            rewrittenInput: decision.rewrittenInput,
            ...(isOrdinaryFallbackAsk(decision.reason) ? { hookAutoApprovalEligible: true } : {}),
        };
        // 'never' (始终允许 / bypassPermissions): the raw pipeline still
        // returns ASK so the engine's intent is visible to telemetry /
        // tests via `checkPermissionRaw`; the public-entry ask-gate then
        // downgrades it to ALLOW, matching the "始终允许 = no card ever"
        // invariant. The bypass-immune deny set (UNC, root rm) short-
        // circuited at facade:202 — it never reaches this branch.
        if (askPolicy === 'never') {
            return baseAsk;
        }
        if (askPolicy === 'deny') {
            return {
                behavior: 'deny',
                reason: `Denied by dontAsk permission mode: ${baseAsk.reason}`,
                denySource: 'rule',
            };
        }
        // 'on-request' (询问 / default): emit ask immediately.
        if (askPolicy === 'on-request') {
            return baseAsk;
        }
        return this.classifyDecision({
            params,
            decision,
            baseAsk,
            workingDirectory,
            localeHint,
            policyOwner,
        });
    }
    async loadRules(params, snapshot) {
        try {
            return {
                rules: [
                    ...(await this.deps.ruleStore.listRules({
                        agentName: params.agentName,
                        sessionId: params.sessionId,
                    })),
                    ...snapshot.pluginContext.rules,
                ],
            };
        }
        catch (error) {
            if (!(error instanceof LocalPermissionStoreUnhealthyError))
                throw error;
            logger.warn({
                ...(params.sessionId ? { session_id: params.sessionId } : {}),
                tool_name: params.toolName,
                source: error.source,
                reason: error.reasonCode,
            }, 'permission.store.unhealthy');
            const reason = `Permission rule store is unhealthy (${error.reasonCode}); approval is required.`;
            if (snapshot.rawMode === 'bypassPermissions') {
                return { behavior: 'deny', reason, denySource: 'safety' };
            }
            const command = readCommand(params.input);
            const { platform, nativeDelete } = snapshot;
            if (!needsDeleteRewrite({ params, platform, command, nativeDelete })) {
                return { behavior: 'ask', reason };
            }
            // Rule-store failure must not skip the recoverable-delete transformation.
            // Run safety/rewrite without granting any rule, then retain the required ask.
            return { rules: [], unhealthyStoreReason: reason };
        }
    }
    createPolicyContext(params, input) {
        const { mode, snapshot, rules, workingDirectory } = input;
        return createToolPermissionContext({
            mode,
            nativeDelete: snapshot.nativeDelete,
            rules,
            workingDirectory,
            allowedWorkingPaths: [...snapshot.pluginContext.directories],
            sandboxAllowPaths: this.resolveSandboxAllowPaths(params.toolName, workingDirectory, params.agentName),
            trustedExactWritePaths: params.trustedExactWritePaths,
            sessionOwnedReadablePaths: params.sessionOwnedReadablePaths,
            dataDir: this.deps.configGetter().dataDir,
            homeDir: homedir(),
            isFile: (p) => {
                try {
                    return statSync(p).isFile();
                }
                catch {
                    return false;
                }
            },
            agentName: params.agentName,
            sessionId: params.sessionId,
            platform: snapshot.platform,
            shellFamily: params.trustedShellFamily ?? this.deps.shellFamily ?? 'unknown',
        });
    }
    /**
     * The settings rarely change within a Session, so they are logged once per
     * Session per day and again when they change, not on every check.
     * sandboxAllowPaths is left out: it differs between read-only and other
     * tools and follows from dataDir, agentName and workingDirectory.
     */
    logPermissionContext(sessionId, ctx) {
        const permissionSettings = {
            agent_name: ctx.agentName,
            permission_mode: ctx.mode,
            native_delete: ctx.nativeDelete,
            working_directory: ctx.workingDirectory,
            allowed_working_paths: ctx.allowedWorkingPaths,
            trusted_exact_write_paths: ctx.trustedExactWritePaths,
            rules: ctx.rules,
            data_dir: ctx.dataDir,
            home_dir: ctx.homeDir,
            platform: ctx.platform,
            shell_family: ctx.shellFamily,
        };
        const permissionSettingsKey = `${new Date().toDateString()}\n${JSON.stringify(permissionSettings)}`;
        if (this.loggedPermissionContexts.get(sessionId ?? '') === permissionSettingsKey)
            return;
        this.loggedPermissionContexts.set(sessionId ?? '', permissionSettingsKey);
        logger.info({
            ...(sessionId ? { session_id: sessionId } : {}),
            ...permissionSettings,
            // Count only: the Session read grants carry user attachment file
            // names (raw user assets) and grow with every attachment, so they
            // neither enter the log nor the change-detection key above.
            session_owned_readable_path_count: ctx.sessionOwnedReadablePaths.length,
        }, 'permission.context');
    }
    async classifyDecision(input) {
        const { params, decision, baseAsk, workingDirectory, localeHint, policyOwner } = input;
        const logClassifierDecision = (classifierVerdict, recommendationBehavior, skipReason) => {
            logger.info({
                ...(params.sessionId ? { session_id: params.sessionId } : {}),
                tool_name: params.toolName,
                policy_owner: policyOwner,
                classifier_verdict: classifierVerdict,
                recommendation_behavior: recommendationBehavior,
                ...(skipReason ? { skip_reason: skipReason } : {}),
            }, 'permission.classifier.decision');
        };
        // 'on-request-llm' (智能授权 / auto): consult cloud gateway BEFORE ask.
        // Cloud classify only fires in managed runtime contexts (a configured
        // Bearer token resolver). Pure local dev daemons + tests fall through to
        // ask so they don't hang on a real HTTP call.
        if (decision.skipAutoClassifier || !shouldUseCloudClassify()) {
            logClassifierDecision('skipped', 'ask', decision.skipAutoClassifier ? 'policy' : 'unavailable');
            return baseAsk;
        }
        const conversationContext = await this.buildConversationContext(params.sessionId, params.latestUserMessages, params.recentMessages);
        // Hardening: even though HttpCloudGatewayClient fails closed on every
        // documented error branch, we wrap classifyViaCloud in a catch-all so
        // any unexpected runtime throw (e.g. region-resolver glitch on first
        // boot, AbortError before fetch is created) still routes to ASK rather
        // than bubbling out and killing the turn.
        let gatewayVerdict;
        const classifyStartedAt = Date.now();
        try {
            gatewayVerdict = await this.classifyViaCloud({
                toolName: params.toolName,
                command: serializeToolInput(params.toolName, params.input),
                workspaceRoot: workingDirectory,
                conversationContext,
                sessionId: params.sessionId,
                agentName: params.agentName,
            });
        }
        catch {
            this.emitLlmCheckMetrics('error', classifyStartedAt);
            logClassifierDecision('error', 'ask');
            return mapClassifierRecommendation(decision, 'ask', formatAutoClassifierReason('timeout', formatTimeoutSuffixSeconds(this.cloudGatewayTimeoutMs), localeHint), policyOwner);
        }
        this.emitLlmCheckMetrics(gatewayVerdict.kind, classifyStartedAt);
        logClassifierDecision(gatewayVerdict.kind, gatewayVerdict.kind === 'allow' ? 'allow' : 'ask');
        return this.mapCloudDecision({ decision, gatewayVerdict, localeHint, policyOwner });
    }
    mapCloudDecision(input) {
        const { decision, gatewayVerdict, localeHint, policyOwner } = input;
        switch (gatewayVerdict.kind) {
            case 'allow':
                return mapClassifierRecommendation(decision, 'allow', formatAutoClassifierReason('allow', gatewayVerdict.reasonLocalized, localeHint), policyOwner);
            case 'block':
            case 'confirm':
                return mapClassifierRecommendation(decision, 'ask', formatAutoClassifierReason(gatewayVerdict.kind, gatewayVerdict.reasonLocalized, localeHint), policyOwner);
            case 'timeout':
            default:
                // Surface the client's reasonLocalized as the suffix so 5xx /
                // network / abort failures stay distinguishable on the UI card
                // and in daemon logs. The client already prefixes its reason
                // with "timed out", "permission/check returned 500",
                // "permission/check biz error", etc.
                return mapClassifierRecommendation(decision, 'ask', formatAutoClassifierReason('timeout', gatewayVerdict.reasonLocalized ||
                    formatTimeoutSuffixSeconds(this.cloudGatewayTimeoutMs), localeHint), policyOwner);
        }
    }
    /**
     * acceptEdits alias seeder.
     *
     * Seeds `edit/write/apply_patch=allow` rules at startup AND on every
     * setMode('acceptEdits'): callers invoke this both at startup
     * (createLocalPermissionService) and after
     * `PUT /config { permissionMode: 'acceptEdits' }` so a runtime mode
     * switch does not have to wait for a daemon restart to take effect.
     *
     * Idempotent: each global rule is only added when missing.
     */
    async syncAcceptEditsSeed() {
        return this.runStartupAliasSeed();
    }
    /**
     * Startup-only entrypoint kept for backwards compatibility with
     * createLocalPermissionService; aliased to `syncAcceptEditsSeed`.
     */
    async runStartupAliasSeed() {
        const cfg = this.deps.configGetter();
        const mode = readLocalPermissionMode(cfg.permissionMode);
        if (mode !== 'acceptEdits')
            return;
        const existing = await this.deps.ruleStore.listRules({});
        const targets = [
            { toolName: 'edit' },
            { toolName: 'write' },
            { toolName: 'apply_patch' },
        ];
        const missing = targets.filter((t) => !existing.some((r) => r.source === 'global' &&
            r.ruleBehavior === 'allow' &&
            r.ruleValue.toolName === t.toolName &&
            !r.ruleValue.ruleContent));
        if (missing.length === 0)
            return;
        await this.deps.ruleStore.applyUpdate({
            type: 'addRules',
            source: 'global',
            destination: 'global',
            behavior: 'allow',
            rules: missing,
        });
    }
    async applyPluginHookPermissionUpdates(input) {
        const store = this.deps.pluginHookPermissionStore;
        if (!store)
            throw new Error('Plugin Hook permission mutation store is unavailable.');
        const configuredMode = readLocalPermissionMode(this.deps.configGetter().permissionMode);
        await store.applyAtomic({
            ...input,
            bypassAvailable: configuredMode === 'bypassPermissions' || configuredMode === 'off',
        });
    }
    async clearPluginHookSessionPermissions(sessionId) {
        const store = this.deps.pluginHookPermissionStore;
        if (!store)
            throw new Error('Plugin Hook permission owner is unavailable.');
        await store.clearSession(sessionId);
    }
    async resolvePluginHookPermissionContext(params) {
        const store = this.deps.pluginHookPermissionStore;
        if (!store)
            throw new Error('Plugin Hook permission owner is unavailable.');
        const cwd = await this.resolveWorkingDirectory(params.sessionId, params.agentName);
        return await store.effective({
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            cwd,
        });
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    /** Built-in skill assets may be read without granting access to private runtime state. */
    resolveSandboxAllowPaths(toolName, workingDirectory, agentName) {
        // Read-only tool set parity with `READ_ONLY_TOOLS`
        // (`packages/agent-modules/permission/src/tools/fs-permission.ts`).
        // We don't import it directly to avoid coupling facade construction
        // to engine module load order; if the set changes upstream, the
        // sandbox helper here needs to stay in sync.
        const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
        if (!READ_ONLY_TOOLS.has(toolName))
            return [];
        const candidates = [];
        const dataDir = this.deps.configGetter().dataDir;
        for (const root of [dataDir, path.join(homedir(), '.minimax')]) {
            if (!root)
                continue;
            candidates.push(path.resolve(root, 'skills'), path.resolve(root, '.builtin-skills'));
            if (agentName)
                candidates.push(path.resolve(root, 'agents', agentName, 'skills'));
        }
        // De-duplicate (dataDir may already equal <dataDir> on a default install).
        const unique = Array.from(new Set(candidates));
        if (!workingDirectory)
            return unique;
        const resolvedWorkspace = path.resolve(workingDirectory);
        return unique.filter((candidate) => {
            // Drop candidates that would shadow the workspace boundary check.
            const withSep = candidate.endsWith(path.sep) ? candidate : candidate + path.sep;
            return !resolvedWorkspace.startsWith(withSep) && resolvedWorkspace !== candidate;
        });
    }
    async classifyViaCloud(input) {
        return this.cloudGateway.classify({
            toolName: input.toolName,
            input: input.command,
            platform: process.platform,
            homeDir: homedir(),
            workspaceRoot: input.workspaceRoot,
            mode: 'auto',
            conversationContext: input.conversationContext,
            agentId: input.agentName,
            sessionId: input.sessionId,
        });
    }
    /** `verdict` = CloudClassifyVerdict.kind or 'error' for an unexpected throw. */
    emitLlmCheckMetrics(verdict, startedAtMs) {
        const metrics = this.deps.metricsClient;
        if (!metrics)
            return;
        metrics.histogram('permission_llm_check_duration_ms', Date.now() - startedAtMs);
        metrics.counter('permission_llm_check_total', 1, { verdict });
    }
    async resolveWorkingDirectory(sessionId, agentName) {
        let resolvedAgent = agentName;
        if (sessionId) {
            const session = await this.deps.getSessionById(sessionId);
            if (session?.workspaceDir)
                return session.workspaceDir;
            resolvedAgent = resolvedAgent ?? session?.agentName;
        }
        if (resolvedAgent) {
            const agent = await this.deps.getLocalAgent(resolvedAgent);
            if (agent?.defaultWorkspaceDir)
                return agent.defaultWorkspaceDir;
            return path.join(this.deps.configGetter().dataDir, 'agents', resolvedAgent, 'workspace');
        }
        return homedir();
    }
    /**
     * Resolves only an actual session or agent workspace. In particular, it
     * never returns the general permission-context fallback (home/dataDir),
     * because that fallback must not become a write/delete safety boundary.
     */
    async resolveExplicitWorkspaceDirectory(sessionId, agentName) {
        let resolvedAgent = agentName;
        if (sessionId) {
            const session = await this.deps.getSessionById(sessionId);
            if (session?.workspaceDir)
                return session.workspaceDir;
            resolvedAgent = resolvedAgent ?? session?.agentName;
        }
        if (!resolvedAgent)
            return undefined;
        return (await this.deps.getLocalAgent(resolvedAgent))?.defaultWorkspaceDir;
    }
    /**
     * Coarse user-locale hint from inline messages.
     *
     * Inline-only by design, to avoid burning a store round-trip on the deny /
     * allow fast paths. The cloud-classifier path below already pulls recent
     * messages from the store via `buildConversationContext`; in practice an
     * inline hint is supplied by the daemon's HTTP route (it forwards
     * `recent_user_messages`), so the inline path covers the live wire. The
     * fallback returns `'unknown'`, which the formatter renders as the English
     * template for messageless sessions.
     */
    resolveInlineLocaleHint(params) {
        const inline = params.latestUserMessages ?? params.recentMessages;
        if (!inline || inline.length === 0)
            return 'unknown';
        return detectMessagesLocale(inline);
    }
    async buildConversationContext(sessionId, inlineLatest, inlineRecent) {
        if (inlineLatest !== undefined || inlineRecent !== undefined) {
            return renderConversationContext({
                latestUserMessages: inlineLatest,
                recentMessages: inlineRecent,
            });
        }
        if (!sessionId || !this.deps.messageStore)
            return '';
        try {
            const [latest, recent] = await Promise.all([
                this.deps.messageStore.listRecentDisplayMessages(sessionId, {
                    limit: 3,
                    role: 'user',
                    excludePermissionResponses: true,
                }),
                this.deps.messageStore.listRecentDisplayMessages(sessionId, { limit: 5 }),
            ]);
            return renderConversationContext({
                latestUserMessages: latest,
                recentMessages: recent,
            });
        }
        catch {
            return '';
        }
    }
}
// `statSync` is used by the `isFile` probe above; this reference is a no-op
// guard kept for the reserved filesystem-touch validation helper.
void statSync;
//# sourceMappingURL=facade.js.map