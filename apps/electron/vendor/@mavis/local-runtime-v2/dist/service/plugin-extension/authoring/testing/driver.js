import { setImmediate as nextTick } from 'node:timers/promises';
import { settleInBackground } from '../../../../infra/async/settle.js';
import { isUiRenderSite, parseOwnedSiteKey } from '@mavis/shared/plugin-extension';
import { parseAgentSpawnSpec } from '../../sdk/agent-request.js';
import { validate } from '../../sdk/model-request.js';
import { validateSuggestionText } from '../../sdk/prompt-suggestion.js';
import { answerFields } from '../../sdk/observe-answer.js';
import { ExtensionHost } from '../../host/host.js';
import { normalizeMatcher } from '../../host/realm/realm.js';
import { fixFor } from '../fixes.js';
import { inThreadWorkerFactory } from './in-thread-worker.js';
const SESSION = 'extension-test';
const MOD_SPECIFIER = 'mcode-test:mod/';
/** A mod has no validate record, so it may make every `ctx` call. */
const MOD_CALLS = [
    'agent.spawn',
    'agent.list',
    'model.complete',
    'mcp.call',
    'store.get',
    'store.set',
    'store.delete',
    'store.keys',
    'store.onDidChange',
    'state.get',
    'state.set',
    'state.update',
    'clock.after',
    'clock.every',
    'clock.now',
    'ui.toast',
    'ui.invalidate',
    'ui.open',
    'ui.close',
    'prompt.fill',
    'prompt.suggest',
    'prompt.read',
    'session.usage',
].map((name) => {
    const [domain = '', method = ''] = name.split('.');
    return { domain, method };
});
const QUIET_TICKS = 3;
const TURN_STATUS_OF = {
    answer: 'completed',
    aborted: 'aborted',
    refusal: 'error',
    error: 'error',
};
const DEFAULT_SPAWN_RECEIPT = { agentId: 'agent-1', model: 'test/model' };
/** A session nothing was measured in yet. */
const DEFAULT_USAGE = { startedAt: 0, context: { window: 200_000 }, rateLimits: [] };
/**
 * `/testing` driver: one real ExtensionHost per mounted site, its realms in the test Worker's own
 * thread, `ctx` services replaced by in-memory fakes and the injected `mcp`, and a fake clock by
 * default.
 */
export function createTestingDriver(input) {
    return {
        mount: (spec) => mountSite(input.module, input.sites, spec),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
}
function resolveMount(module, sites, spec) {
    const site = sites.get(spec.slot);
    if (!site)
        throw new Error(`${spec.slot} is not a site; use one of ${sites.slots.join(', ')}`);
    if (!isUiRenderSite(site))
        return { site, spec };
    // `above-prompt`: the session's one chained instance, keyed by the site name.
    if (!site.matcherFields.some((field) => field.name === 'id')) {
        return { site, spec: { ...spec, key: site.slot } };
    }
    const owned = parseOwnedSiteKey(spec.key);
    const id = spec.id ?? (owned?.pluginId === module.pluginId ? owned.id : undefined);
    if (!id) {
        throw new Error(`mount({ site: '${site.slot}' }) requires id, or key '<pluginId>/<id>'`);
    }
    return { site, spec: { ...spec, key: `${module.pluginId}/${id}` } };
}
async function mountSite(module, sites, mountSpec) {
    const { site, spec } = resolveMount(module, sites, mountSpec);
    if (spec.register !== module.token) {
        throw new Error("mount({ register }) takes the package module: import { register } from './register'");
    }
    const modules = new Map();
    const layers = spec.mods.map((register, index) => {
        modules.set(`${MOD_SPECIFIER}${index}`, Object.freeze({ register }));
        return {
            pluginId: `mod-${index + 1}`,
            artifact: {
                digest: `mod-${index + 1}`,
                code: `module.exports = require(${JSON.stringify(`${MOD_SPECIFIER}${index}`)});`,
                hooks: collectHooks(register),
                calls: MOD_CALLS,
            },
        };
    });
    layers.push({ pluginId: module.pluginId, artifact: module.artifact });
    const clock = spec.clock === 'fake' ? new TestClock() : undefined;
    const fakes = new FakeServices(module.pluginId, spec);
    const activity = { inFlight: 0 };
    const host = new ExtensionHost({
        services: fakes.port,
        workerFactory: inThreadWorkerFactory({ modules, ...(clock ? { timers: clock } : {}) }, activity),
        sites: sites.slots.flatMap((slot) => sites.get(slot) ?? []),
        limits: { heartbeatIntervalMs: 2 ** 30 },
        ...(clock ? { clock } : {}),
    });
    layers.forEach((layer) => host.activate({
        sessionId: SESSION,
        pluginId: layer.pluginId,
        source: 'LOCAL_TEST',
        tier: 'installed',
        artifact: layer.artifact,
    }));
    const viewLease = host.issueViewLease(SESSION);
    const localDiagnostics = [];
    let current;
    let dirty = false;
    let rendering;
    const renderOnce = async () => {
        const response = await host.render({
            sessionId: SESSION,
            slot: spec.slot,
            key: spec.key,
            props: spec.props,
            propsVersion: 1,
            viewLease,
            match: spec.match,
        });
        if (response.kind === 'error') {
            if (response.code !== 'EXTENSION_RENDER_SUPERSEDED') {
                localDiagnostics.push(diagnostic(response.code, response.message));
            }
            return;
        }
        current = response;
        host.applied({
            sessionId: SESSION,
            slot: spec.slot,
            key: spec.key,
            renderSeq: response.renderSeq,
        });
    };
    const scheduleRender = () => {
        dirty = true;
        rendering ??= (async () => {
            while (dirty) {
                dirty = false;
                await renderOnce();
            }
            rendering = undefined;
        })();
    };
    fakes.onInvalidate = (slot, key) => {
        if ((slot === undefined || slot === spec.slot) && (key === undefined || key === spec.key)) {
            scheduleRender();
        }
    };
    const settle = async () => {
        for (let quiet = 0; quiet < QUIET_TICKS;) {
            await nextTick();
            if (rendering) {
                await rendering;
                quiet = 0;
            }
            else if (activity.inFlight > 0) {
                quiet = 0;
            }
            else {
                quiet += 1;
            }
        }
    };
    const answer = (response) => {
        if ('ok' in response)
            return;
        if ('stale' in response) {
            throw new TestHostError('EXTENSION_HANDLE_STALE', 'the element was re-rendered');
        }
        throw new TestHostError(response.code, response.message);
    };
    scheduleRender();
    await settle();
    return {
        site,
        current: () => current,
        gesture: async ({ kind, renderSeq, plugin, handle, value }) => {
            const request = {
                sessionId: SESSION,
                slot: spec.slot,
                key: spec.key,
                renderSeq,
                plugin,
                handle,
                ...(value === undefined ? {} : { value }),
            };
            answer(await host[kind](request));
            await settle();
        },
        completeAgent: async (completion) => {
            const { agentId, reason = 'answer' } = completion;
            const status = TURN_STATUS_OF[reason];
            settleInBackground(host.observe({
                sessionId: SESSION,
                event: 'turn.complete',
                payload: {
                    sessionId: SESSION,
                    turnId: `turn-of-${agentId}`,
                    agentId,
                    status,
                    durationMs: 0,
                },
                match: {},
                spawner: {
                    pluginId: module.pluginId,
                    fields: answerFields({ pluginId: module.pluginId, answer: completion.answer, reason }, status),
                },
            }));
            await settle();
        },
        settle,
        advance: async (ms) => {
            if (clock)
                await clock.advance(ms, settle);
            else
                await new Promise((resolve) => setTimeout(resolve, ms));
            await settle();
        },
        state: () => fakes.stateOf(module.pluginId),
        diagnostics: () => [
            ...host
                .inspect({ sessionId: SESSION })
                .diagnostics.map((entry) => diagnostic(entry.code, entry.message, entry.pluginId)),
            ...localDiagnostics,
        ],
        effects: () => [...fakes.effects],
        unmount: async () => {
            host.releaseViewLease(viewLease);
            await host.close();
            clock?.clearAll();
        },
    };
}
class TestHostError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'TestHostError';
    }
}
function diagnostic(code, message, plugin) {
    const fix = fixFor(code);
    return {
        code,
        message,
        ...(fix ? { fix } : {}),
        ...(plugin ? { plugin } : {}),
    };
}
/** A mod has no validate record: its `on()` calls are collected once, the realm re-checks them. */
function collectHooks(register) {
    const hooks = [];
    const on = (...args) => {
        const [slot] = args;
        if (typeof slot !== 'string')
            throw new TypeError('on() needs a slot name');
        const matcher = args.length > 2 ? normalizeMatcher(slot, args[1]) : undefined;
        hooks.push(matcher ? { slot, matcher } : { slot });
    };
    register(on, {});
    return hooks;
}
/** In-memory `ctx` services; effects are recorded instead of reaching a renderer. */
class FakeServices {
    modulePluginId;
    spec;
    effects = [];
    onInvalidate = () => undefined;
    defaults = new Map();
    buckets = new Map();
    stores = new Map();
    listeners = new Map();
    version = 0;
    constructor(modulePluginId, spec) {
        this.modulePluginId = modulePluginId;
        this.spec = spec;
        for (const [key, value] of Object.entries(spec.state ?? {}))
            this.write(modulePluginId, key, value);
    }
    port = {
        sessionFacts: async () => ({ cwd: '/workspace', model: 'test/model' }),
        state: {
            declare: (pluginId, _digest, defaults) => {
                this.defaults.set(pluginId, defaults);
            },
            snapshot: ({ pluginId }) => this.snapshot(pluginId),
            set: (identity, key, value) => this.write(identity.pluginId, key, value),
        },
        call: async (identity, method, args) => {
            return this.call(identity.pluginId, method, args);
        },
        subscribeStore: (identity, listener) => {
            const set = this.listeners.get(identity.pluginId) ?? new Set();
            this.listeners.set(identity.pluginId, set);
            set.add(listener);
            return () => set.delete(listener);
        },
        emit: (event) => {
            if (event.type === 'invalidate' && event.sessionId === SESSION) {
                this.onInvalidate(event.slot, event.key);
            }
            else if (event.type === 'entries-changed') {
                this.onInvalidate();
            }
        },
    };
    stateOf(pluginId) {
        return this.snapshot(pluginId).values;
    }
    snapshot(pluginId) {
        const values = { ...this.defaults.get(pluginId) };
        const versions = {};
        for (const key of Object.keys(values))
            versions[key] = 0;
        for (const [key, entry] of this.bucket(pluginId)) {
            values[key] = entry.value;
            versions[key] = entry.version;
        }
        return { values, versions };
    }
    bucket(pluginId) {
        let bucket = this.buckets.get(pluginId);
        if (!bucket) {
            bucket = new Map();
            this.buckets.set(pluginId, bucket);
        }
        return bucket;
    }
    write(pluginId, key, value) {
        this.version += 1;
        this.bucket(pluginId).set(key, { value, version: this.version });
    }
    async agentCall(pluginId, method, spec) {
        if (method === 'agent.spawn')
            return this.spawnAgent(pluginId, spec);
        return JSON.parse(JSON.stringify((await this.spec.agent?.list?.()) ?? []));
    }
    async call(pluginId, method, args) {
        const [first, second, third] = args;
        if (method.startsWith('agent.'))
            return this.agentCall(pluginId, method, first);
        if (method === 'model.complete')
            return this.model(first);
        if (method === 'mcp.call')
            return this.mcp(String(first), String(second), third);
        const read = this.read(method);
        if (read !== undefined)
            return read;
        if (method === 'prompt.suggest') {
            const text = validateSuggestionText(first);
            return this.spec.composer?.suggest?.(text) ?? { isShown: true };
        }
        if (method.startsWith('store.'))
            return this.storeCall(pluginId, method, first, second);
        const effect = effectOf(pluginId, method, first);
        if (!effect)
            throw new Error(`ctx method ${method} is not available in tests`);
        if (effect.type === 'prompt.fill')
            return this.fill(effect);
        this.effects.push(effect);
        return undefined;
    }
    /** Like the renderer: a `replace` over a non-empty stand-in draft writes nothing. */
    fill(effect) {
        if (effect.mode === 'replace' && (this.spec.composer?.draft ?? '') !== '') {
            return { written: false, reason: 'draft' };
        }
        this.effects.push(effect);
        return { written: true };
    }
    storeCall(pluginId, method, key, value) {
        const store = this.stores.get(pluginId) ?? new Map();
        this.stores.set(pluginId, store);
        if (method === 'store.keys')
            return [...store.keys()];
        const name = String(key);
        if (method === 'store.get')
            return store.get(name);
        if (method === 'store.set')
            store.set(name, value ?? null);
        else
            store.delete(name);
        this.notify(pluginId, name, method === 'store.set' ? (value ?? null) : undefined);
        return undefined;
    }
    async mcp(server, tool, args) {
        const handler = this.spec.mcp;
        if (!handler)
            throw new Error(`ctx.mcp.call(${server}, ${tool}): pass mount({ mcp }) to answer it`);
        return JSON.parse(JSON.stringify(await handler(server, tool, args ?? undefined)));
    }
    async spawnAgent(pluginId, raw) {
        parseAgentSpawnSpec(raw ?? null);
        const spec = JSON.parse(JSON.stringify(raw));
        this.effects.push({ type: 'agent.spawn', plugin: pluginId, spec });
        const receipt = (await this.spec.agent?.spawn?.(spec)) ?? DEFAULT_SPAWN_RECEIPT;
        return JSON.parse(JSON.stringify(receipt));
    }
    /** Answers of the read-only calls; `undefined` for any other method. */
    read(method) {
        if (method === 'prompt.read')
            return { text: this.spec.composer?.draft ?? '' };
        if (method === 'session.usage')
            return JSON.parse(JSON.stringify(this.spec.usage ?? DEFAULT_USAGE));
        return undefined;
    }
    async model(request) {
        const validated = validate(request ?? null);
        const reply = this.spec.model
            ? await this.spec.model({
                model: `${validated.provider}/${validated.modelId}`,
                prompt: validated.prompt,
                ...(validated.system === undefined ? {} : { system: validated.system }),
                ...(validated.maxTokens === undefined ? {} : { maxTokens: validated.maxTokens }),
                ...(validated.timeoutMs === undefined ? {} : { timeoutMs: validated.timeoutMs }),
            })
            : { isAnswered: false, reason: 'model-unavailable' };
        return JSON.parse(JSON.stringify(reply));
    }
    notify(pluginId, key, value) {
        for (const listener of this.listeners.get(pluginId) ?? [])
            listener({ key, value });
    }
}
function effectOf(pluginId, method, arg) {
    if (method === 'ui.toast')
        return { type: 'ui.toast', plugin: pluginId, text: String(arg) };
    if (method === 'ui.open') {
        const focus = argField(arg, 'focus');
        return {
            type: 'ui.open',
            plugin: pluginId,
            id: String(argField(arg, 'id')),
            title: String(argField(arg, 'title')),
            ...(typeof focus === 'boolean' ? { focus } : {}),
        };
    }
    if (method === 'ui.close')
        return { type: 'ui.close', plugin: pluginId, id: String(arg) };
    if (method === 'prompt.fill') {
        return {
            type: 'prompt.fill',
            plugin: pluginId,
            text: String(argField(arg, 'text')),
            mode: argField(arg, 'mode') === 'append' ? 'append' : 'replace',
        };
    }
    return undefined;
}
function argField(value, name) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value[name]
        : undefined;
}
/** Fake time shared by the host (deadlines, handle TTL) and the realm's `ctx.clock` timers. */
class TestClock {
    time = 0;
    seq = 0;
    timers = new Map();
    now() {
        return this.time;
    }
    setTimeout(callback, ms) {
        return this.add(callback, ms);
    }
    setInterval(callback, ms) {
        return this.add(callback, ms, Math.max(1, ms));
    }
    clearTimeout(handle) {
        this.timers.delete(handle);
    }
    clear(handle) {
        this.timers.delete(handle);
    }
    clearAll() {
        this.timers.clear();
    }
    /** Fires due timers in time order, letting the host settle after each one. */
    async advance(ms, settle) {
        const target = this.time + ms;
        for (;;) {
            const [next] = [...this.timers]
                .filter(([, timer]) => timer.at <= target)
                .sort(([, a], [, b]) => a.at - b.at);
            if (!next)
                break;
            const [id, timer] = next;
            this.time = Math.max(this.time, timer.at);
            if (timer.every === undefined)
                this.timers.delete(id);
            else
                timer.at += timer.every;
            timer.callback();
            await settle();
        }
        this.time = target;
    }
    add(callback, ms, every) {
        this.seq += 1;
        this.timers.set(this.seq, {
            at: this.time + Math.max(0, ms),
            ...(every === undefined ? {} : { every }),
            callback,
        });
        return this.seq;
    }
}
//# sourceMappingURL=driver.js.map