/**
 * Registry —— agent-runtime 内部状态与装配实现。
 *
 * 三阶段：
 *   1. 构造：`initExtensions` 逐个跑 `ext.init(ownerApi)`，每个 extension 拿到
 *      owner-scoped `ExtensionAPI` facade。每次 `pi.registerXxx / pi.on` 同时校验 registry
 *      处于 `initializing` 且 active owner 与 facade owner 一致；全部成功后进入 `ready`，
 *      任一失败则永久进入 `failed`，从而防止重入、并发 init 与半初始化贡献泄漏。
 *   2. 装配：`assembleTurn(ctx)` 遍历 `LoadedExtension`（跳过 disabled），把 tools /
 *      prompt / reminder / hook 合并成 `AssemblyResult`。registry 分别计算 raw
 *      `reminders[]` 与 prompt contributor 输出；prompt contributor 只接收
 *      `TurnAssemblyCtx`，不能读取尚未生成的 `AssemblyResult` 或 reminders。
 *   3. 运行：Handler 由 host 触发（`PiTurnRunner` / turn lifecycle），registry 不参与。
 *
 * 并发语义（v1.0）：
 *   - `assembleTurn` 在第一次 await 前同步快照全部 extension 的 enabled 状态；in-flight
 *     装配期间的 `setEnabled` 只影响下一次装配，单个 `AssemblyResult` 不会混用新旧状态。
 *   - Handler 触发时 disable：现调用会跑完，下次触发才 gate；agent-runtime 层面不感知。
 *   - `assembleTurn` 每次调用生成独立的 hook wrapper closure（含 ctx），并发调用互不
 *     污染。
 */
import { HOOK_NAMES } from './types.js';
function isRuntimeToolCatalog(value) {
    return Array.isArray(value);
}
function createEmptyHookStorage() {
    const storage = {};
    for (const name of HOOK_NAMES)
        storage[name] = [];
    return storage;
}
function createEmptyLoaded(ext) {
    return {
        id: ext.id,
        description: ext.description,
        enabledGlobal: true,
        tools: [],
        systemPromptContributors: [],
        userPromptContributors: [],
        reminderProviders: [],
        hookHandlers: createEmptyHookStorage(),
    };
}
function contributionStats(loaded) {
    const hooks = {};
    for (const name of HOOK_NAMES) {
        hooks[name] = loaded.hookHandlers[name].length;
    }
    return {
        tools: loaded.tools.length,
        promptContributors: loaded.systemPromptContributors.length + loaded.userPromptContributors.length,
        reminderProviders: loaded.reminderProviders.length,
        hooks: hooks,
    };
}
/**
 * PiTurnHooks 字段（agent-core 命名）与 SPI event 名的对照表。
 * 用于表驱动合并 hook 数组，避免 5 处重复 shotgun edit。
 *
 * `on_step_end` 映射到 `onStepEndHook`。deprecated per-step compatibility slot
 * `onTurnEndHook` 由 agent-core `newTurn` 兼容读入；
 * agent-runtime 只写 step 语义明确的新字段，避免同一 handler 被重复执行。
 */
const HOOK_MAPPINGS = [
    { pi: 'onLlmCallPreparedHook', event: 'on_llm_call_prepared', adapter: 'context' },
    { pi: 'beforeLlmCallHook', event: 'before_llm_call', adapter: 'context' },
    { pi: 'afterLlmCallHook', event: 'after_llm_call', adapter: 'context' },
    { pi: 'beforeToolCallHook', event: 'before_tool_call', adapter: 'tool-context' },
    { pi: 'afterToolCallHook', event: 'after_tool_call', adapter: 'tool-context' },
    { pi: 'onHistoryChangedHook', event: 'on_history_changed', adapter: 'context' },
    { pi: 'onStepEndHook', event: 'on_step_end', adapter: 'context' },
];
export class Registry {
    extensions = new Map();
    activeLoaded = null;
    lifecycleState = 'new';
    sessionOverrides = new Map();
    /**
     * Per-profile params merged from `ProfileOverlay.param`——由 `createAgentRuntime`
     * 传入，一次固化。Extension 在 `init` 里通过 `pi.params` 读取（文档 §4.4 line 281）。
     */
    params;
    constructor(params = {}) {
        this.params = params;
    }
    // ─── init & control plane ──────────────────────────────────────────
    async initExtensions(extensions) {
        if (this.lifecycleState !== 'new') {
            const calledTwice = this.lifecycleState === 'ready' ? '; cannot be called twice' : '';
            throw new Error(`Registry.initExtensions requires registry state 'new'; current state is '${this.lifecycleState}'${calledTwice}`);
        }
        this.lifecycleState = 'initializing';
        try {
            for (const ext of extensions) {
                if (this.extensions.has(ext.id)) {
                    throw new Error(`Duplicate extension id during init: ${ext.id}`);
                }
                const loaded = createEmptyLoaded(ext);
                this.extensions.set(ext.id, loaded);
                this.activeLoaded = loaded;
                try {
                    await ext.init(this.createExtensionApi(loaded));
                }
                finally {
                    this.activeLoaded = null;
                }
            }
            this.lifecycleState = 'ready';
        }
        catch (error) {
            this.lifecycleState = 'failed';
            this.extensions.clear();
            this.sessionOverrides.clear();
            throw error;
        }
    }
    setEnabled(extensionId, enabled, scope) {
        this.assertReady('setEnabled');
        if (!this.extensions.has(extensionId)) {
            throw new Error(`Registry.setEnabled: unknown extension id: ${extensionId}`);
        }
        if (scope?.sessionId) {
            let sessionMap = this.sessionOverrides.get(scope.sessionId);
            if (!sessionMap) {
                sessionMap = new Map();
                this.sessionOverrides.set(scope.sessionId, sessionMap);
            }
            sessionMap.set(extensionId, enabled);
        }
        else {
            const loaded = this.extensions.get(extensionId);
            if (loaded)
                loaded.enabledGlobal = enabled;
        }
    }
    listExtensions(scope) {
        this.assertReady('listExtensions');
        const sessionMap = scope?.sessionId ? this.sessionOverrides.get(scope.sessionId) : undefined;
        const out = [];
        for (const loaded of this.extensions.values()) {
            const sessionOverride = sessionMap?.get(loaded.id);
            const enabled = sessionOverride ?? loaded.enabledGlobal;
            out.push({
                id: loaded.id,
                description: loaded.description,
                enabled,
                contributions: contributionStats(loaded),
            });
        }
        return out;
    }
    disposeSession(sessionId) {
        this.assertReady('disposeSession');
        this.sessionOverrides.delete(sessionId);
    }
    assertReady(method) {
        if (this.lifecycleState !== 'ready') {
            throw new Error(`Registry.${method} requires registry state 'ready'; current state is '${this.lifecycleState}'`);
        }
    }
    isEnabled(loaded, ctx) {
        if (ctx) {
            const override = this.sessionOverrides.get(ctx.sessionId)?.get(loaded.id);
            if (override !== undefined)
                return override;
        }
        return loaded.enabledGlobal;
    }
    // ─── Owner-scoped ExtensionAPI ─────────────────────────────────────
    createExtensionApi(owner) {
        return {
            params: this.params,
            registerTool: (contribution) => {
                this.registerTool(owner, contribution);
            },
            contributeSystemPrompt: (fn) => {
                this.contributeSystemPrompt(owner, fn);
            },
            contributeUserPromptPrefix: (fn) => {
                this.contributeUserPromptPrefix(owner, fn);
            },
            registerReminderProvider: (provider) => {
                this.registerReminderProvider(owner, provider);
            },
            on: (event, handler) => {
                this.registerHook(owner, event, handler);
            },
        };
    }
    registerTool(owner, contribution) {
        this.assertActiveOwner(owner, 'registerTool');
        owner.tools.push(contribution);
    }
    contributeSystemPrompt(owner, fn) {
        this.assertActiveOwner(owner, 'contributeSystemPrompt');
        owner.systemPromptContributors.push(fn);
    }
    contributeUserPromptPrefix(owner, fn) {
        this.assertActiveOwner(owner, 'contributeUserPromptPrefix');
        owner.userPromptContributors.push(fn);
    }
    registerReminderProvider(owner, provider) {
        this.assertActiveOwner(owner, 'registerReminderProvider');
        owner.reminderProviders.push(provider);
    }
    registerHook(owner, event, handler) {
        this.assertActiveOwner(owner, `on(${event})`);
        // Per-event typed push; adding a new event = extend HOOK_NAMES + HookHandlerMap,
        // no code change here.
        owner.hookHandlers[event].push(handler);
    }
    assertActiveOwner(owner, method) {
        if (this.lifecycleState !== 'initializing') {
            throw new Error(`Registry.${method} can only be called during extension init(). ` +
                `Current registry state is '${this.lifecycleState}'. ` +
                'Storing the pi reference for later use is forbidden.');
        }
        if (this.activeLoaded !== owner) {
            const activeOwner = this.activeLoaded?.id;
            const activeOwnerDetail = activeOwner ? `; active owner is '${activeOwner}'.` : '.';
            throw new Error(`Registry.${method}: ExtensionAPI owner '${owner.id}' is outside its init window${activeOwnerDetail}`);
        }
    }
    // ─── Assembly ───────────────────────────────────────────────────────
    async assembleModelContext(ctx, seed) {
        this.assertReady('assembleModelContext');
        const tools = [...(seed?.tools ?? [])];
        const systemPrefixes = [];
        const toolNames = collectSeedToolNames(tools);
        for (const { loaded, enabled } of this.snapshotExtensions(ctx)) {
            if (!enabled)
                continue;
            if (loaded.tools.length > 0 || loaded.systemPromptContributors.length > 0) {
                await this.appendModelContextContributions(loaded, ctx, tools, systemPrefixes, toolNames);
            }
        }
        return { systemPromptPrefix: systemPrefixes.join('\n\n'), tools };
    }
    async assembleTurn(ctx, seed) {
        this.assertReady('assembleTurn');
        const tools = [...(seed?.tools ?? [])];
        const systemPrefixes = [];
        const userPrefixes = seed?.userPromptPrefix ? [seed.userPromptPrefix] : [];
        const reminders = [];
        const hooks = {
            beforeLlmCallHook: [],
            afterLlmCallHook: [],
            beforeToolCallHook: [],
            afterToolCallHook: [],
            onHistoryChangedHook: [],
            // 使用 step 语义明确的 `onStepEndHook`。agent-core `newTurn` 在当前迁移窗口
            // 仍兼容读取 legacy `onTurnEndHook`；agent-runtime 只写新字段。
            onStepEndHook: [],
        };
        const turnStartHandlers = [];
        const turnEndHandlers = [];
        const extensionSnapshots = this.snapshotExtensions(ctx);
        const loadedExtensions = extensionSnapshots.map(({ loaded }) => loaded);
        const enabledIds = [];
        const disabledIds = [];
        const toolNames = collectSeedToolNames(tools);
        for (const { loaded, enabled } of extensionSnapshots) {
            if (!enabled) {
                disabledIds.push(loaded.id);
                continue;
            }
            enabledIds.push(loaded.id);
            if (loaded.tools.length > 0 || loaded.systemPromptContributors.length > 0) {
                await this.appendModelContextContributions(loaded, ctx, tools, systemPrefixes, toolNames);
            }
            for (const fn of loaded.userPromptContributors) {
                const s = await fn(ctx);
                if (s)
                    userPrefixes.push(s);
            }
            for (const provider of loaded.reminderProviders) {
                const emission = await provider.compute(ctx);
                if (emission) {
                    reminders.push({ providerName: provider.name, reminder: emission });
                }
            }
            // 表驱动合并 pi step-level hooks，避免 5 处 shotgun edit（review Standards S-4）。
            // PiTurnHooks 各字段类型不同、intersection 为 never，走 helper 收窄类型。
            for (const mapping of HOOK_MAPPINGS) {
                const source = loaded.hookHandlers[mapping.event];
                if (source.length === 0)
                    continue;
                const wrapped = source.map((handler) => mapping.adapter === 'tool-context'
                    ? wrapToolWithCtx(handler, ctx)
                    : wrapWithCtx(handler, ctx));
                appendHooks(hooks, mapping.pi, wrapped);
            }
            turnStartHandlers.push(...loaded.hookHandlers.turn_start);
            turnEndHandlers.push(...loaded.hookHandlers.turn_end);
        }
        // 排序 reminders：priority 高的在前；相等则按插入顺序（Array.prototype.sort
        // 在 ES2019+ 保证 stable）。registry 只提供独立 emission 列表；prompt
        // contributors 无法读取该列表，具体渲染 / 注入策略由 host 决定。
        reminders.sort((a, b) => (b.reminder.priority ?? 0) - (a.reminder.priority ?? 0));
        const userPromptPrefix = userPrefixes.join('\n\n');
        const diagnostic = {
            loadedExtensions: loadedExtensions.map((l) => l.id),
            enabledExtensions: enabledIds,
            disabledExtensions: disabledIds,
            toolCount: tools.length,
            reminderCount: reminders.length,
        };
        return {
            systemPromptPrefix: systemPrefixes.join('\n\n'),
            userPromptPrefix,
            tools,
            hooks,
            reminders,
            turnStartHandlers,
            turnEndHandlers,
            diagnostic,
        };
    }
    snapshotExtensions(ctx) {
        // Snapshot all enablement before the first contribution can yield.
        return [...this.extensions.values()].map((loaded) => ({
            loaded,
            enabled: this.isEnabled(loaded, ctx),
        }));
    }
    async appendModelContextContributions(loaded, ctx, tools, systemPrefixes, toolNames) {
        for (const contribution of loaded.tools) {
            const resolved = typeof contribution === 'function' ? await contribution(ctx) : contribution;
            if (!resolved)
                continue;
            const catalog = isRuntimeToolCatalog(resolved) ? resolved : [resolved];
            for (const tool of catalog) {
                const name = tool.def.name;
                if (toolNames.has(name)) {
                    throw new Error(`Duplicate tool name '${name}' contributed by extension '${loaded.id}' (already registered by an earlier extension).`);
                }
                toolNames.add(name);
                tools.push(tool);
            }
        }
        for (const fn of loaded.systemPromptContributors) {
            const prefix = await fn(ctx);
            if (prefix)
                systemPrefixes.push(prefix);
        }
    }
}
function collectSeedToolNames(tools) {
    const names = new Set();
    for (const tool of tools) {
        const name = tool.def.name;
        if (names.has(name))
            throw new Error(`Duplicate tool name '${name}' in assembly seed.`);
        names.add(name);
    }
    return names;
}
function wrapWithCtx(handler, ctx) {
    return async (event) => {
        const result = await handler(event, ctx);
        return result ?? undefined;
    };
}
function wrapToolWithCtx(handler, ctx) {
    return async (event, signal) => {
        const result = await handler(event, signal, ctx);
        return result ?? undefined;
    };
}
/**
 * Append handlers into a `PiTurnHooks` field via a narrowed helper. `PiTurnHooks`'s
 * fields have different function signatures, so writing `hooks[key] = [...]` widens
 * to `never` on intersection. Casting inside a helper keeps the unsafe write in one
 * place and lets callers stay type-driven via `HOOK_MAPPINGS`.
 */
function appendHooks(hooks, key, values) {
    const existing = (hooks[key] ?? []);
    hooks[key] = [...existing, ...values];
}
//# sourceMappingURL=registry.js.map