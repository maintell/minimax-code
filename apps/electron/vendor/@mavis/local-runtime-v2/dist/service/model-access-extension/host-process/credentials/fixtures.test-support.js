import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModelAccessRegistry } from '../../core/registry.js';
import { ModelAccessCapabilityPolicy } from '../../core/policy.js';
import { ModelAccessBindingService } from '../../credentials/binding.service.js';
import { ModelAccessOwnedService } from '../../credentials/owned.service.js';
import { ModelAccessBorrowService } from '../../borrow/borrow.service.js';
import { ModelAccessRequestService } from '../../request/request.service.js';
import { ModelAccessLoginService } from '../../login/login.service.js';
import { extensionContext } from '../../core/context.js';
import { ModelAccessHostSupervisor } from '../process/supervisor.js';
import { createModelAccessHostClassifier, createModelAccessHostTransport } from '../proxy.js';
import { createModelAccessHostLoginHandler } from '../login-proxy.js';
import { createModelAccessHostOwnedHandlers, createModelAccessHostBorrowHandlers, hostContextInput, } from './proxy.js';
export const identity = {
    providerId: 'fixture',
    region: 'test',
    tenant: 'test',
    subject: 'account',
};
export const model = { id: 'synthetic', api: 'openai-completions' };
export const sourceRef = {
    installationId: 'synthetic',
    sourceId: 'fixture',
    variant: 'cli',
    target: 'global',
    selector: 'current',
};
export const manifest = {
    schemaVersion: 1,
    name: '@fixture/generations',
    version: '1.0.0',
    entry: './index.mjs',
    engines: { mcodeSdk: '^1' },
    trust: 'native-code',
    platforms: ['darwin', 'linux', 'win32'],
    providers: [
        { id: 'fixture', credentialSchema: 1, credentialKinds: ['direct-owned', 'borrowed-current'] },
    ],
    sources: [
        {
            id: 'fixture',
            hostAgentId: 'fixture',
            capabilities: {
                subscriptionBorrow: { variants: [{ id: 'cli', targets: ['global'] }] },
                login: { methods: [{ id: 'device', kind: 'device-code', targets: ['global'] }] },
            },
        },
    ],
};
function moduleSource(version) {
    return `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const version = ${version};
const identity = ${JSON.stringify(identity)};
let directory;
const spent = new Set();
async function gate(ctx, kind) {
  directory = ctx.dataDir;
  await writeFile(path.join(directory, kind + '-started-' + version), 'synthetic');
  for (;;) {
    try { await readFile(path.join(directory, kind + '-release-' + version)); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
}
function resolved(payload) { return { identity, payload, expiresAt: payload.expiresAt }; }
async function renew(ctx, binding, previous) {
  const token = previous.payload.token;
  if (spent.has(token)) throw new Error('synthetic-token-replayed');
  spent.add(token);
  await gate(ctx, 'owned');
  return resolved({ token: token + '-rotated-v' + version, expiresAt: Date.now() + 60000 });
}
async function readBorrow(ctx) {
  directory = ctx.dataDir;
  return JSON.parse(await readFile(path.join(directory, 'borrow.json'), 'utf8'));
}
async function renewBorrow(ctx) {
  await gate(ctx, 'borrow');
  const next = resolved({ token: 'borrow-rotated-v' + version, expiresAt: Date.now() + 60000 });
  await writeFile(path.join(directory, 'borrow.json'), JSON.stringify(next));
  return next;
}
export default {
  providers: { fixture: {
    resolveOwned: async (ctx, binding, payload) => { directory = ctx.dataDir; return resolved(payload); },
    renewOwned: renew, forceRenewOwned: renew,
    models: async (ctx) => { directory = ctx.dataDir; return [{ id: 'v' + version + '-g' + ctx.generation, api: 'openai-completions' }]; },
    bindTransport: async (ctx) => ({ api: 'openai-completions', modelId: 'synthetic', baseUrl: 'https://fixture.invalid',
      fetch: async () => new Response('v' + version + '-g' + ctx.generation),
      dispose: async () => { await writeFile(path.join(ctx.dataDir, 'transport-disposed-' + version), 'synthetic'); } }),
    classifyError: () => ({ category: 'credential', code: 'v' + version, retryable: true }),
    forget: async (ctx) => { await writeFile(path.join(ctx.dataDir, 'forgotten-' + version), 'synthetic'); },
  } },
  sources: { fixture: {
    subscriptionBorrow: { cli: { discover: async () => [], resolve: readBorrow, renew: renewBorrow, forceRenew: renewBorrow } },
    login: { device: { begin: async (ctx) => ({
      view: { kind: 'device', verificationUrl: 'https://fixture.invalid', userCode: 'SYNTHETIC', expiresAt: Date.now() + 60000 },
      result: gate(ctx, 'login').then(() => ({ kind: 'direct-owned', providerId: 'fixture', credentialSchema: 1, identity,
        payload: { token: 'login-v' + version, expiresAt: Date.now() + 60000 } })),
      cancel: async () => {},
    }) } },
  } },
  dispose: async () => { if (directory) await writeFile(path.join(directory, 'disposed-' + version), 'synthetic'); },
};`;
}
export async function generationFixture(timeoutMs = 2_000) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'model-access-generation-'));
    const directories = { root, hostDataDir: root };
    const dataDir = path.join(root, 'data', 'synthetic');
    await mkdir(dataDir, { recursive: true });
    const registry = new ModelAccessRegistry();
    const supervisor = new ModelAccessHostSupervisor();
    const policy = new ModelAccessCapabilityPolicy('synthetic', registry);
    const leases = [];
    const slots = new Map();
    let state = { bindings: [] };
    let beforeWrite = async () => { };
    let tail = Promise.resolve();
    const serial = (run) => {
        const previous = tail;
        const next = (async () => {
            await previous;
            return run();
        })();
        tail = (async () => {
            try {
                await next;
            }
            catch { }
        })();
        return next;
    };
    const secretKey = (slot) => `${slot.providerKey}/${slot.slot}`;
    const secrets = {
        read: async (slot) => slots.get(secretKey(slot)) ?? '',
        write: async (slot, payload) => {
            await beforeWrite();
            slots.set(secretKey(slot), payload);
        },
        remove: async (slot) => {
            slots.delete(secretKey(slot));
        },
        settled: async () => { },
    };
    const bindings = new ModelAccessBindingService({
        serial,
        state: () => state,
        save: async (next) => {
            state = next;
        },
        assertInstallation: () => {
            const current = registry.get('synthetic');
            if (!current)
                throw new Error('installation_missing');
            return current.generation;
        },
        acquireGeneration: (id, parent) => registry.acquire(id, parent),
        acquireBorrow: (source, signal, generation) => policy.acquire({
            installationId: source.installationId,
            sourceId: source.sourceId,
            capability: 'subscriptionBorrow',
            entryId: source.variant,
            targets: [source.target],
            signal,
        }, generation),
        forgetOwned: async () => { },
        warn: () => { },
    }, secrets);
    const host = {
        registry: () => registry,
        policy: () => policy,
        serial,
        bindings,
        directories,
        profileId: 'synthetic',
    };
    const owned = new ModelAccessOwnedService(host, timeoutMs);
    const borrow = new ModelAccessBorrowService(host, 5_000);
    const requests = new ModelAccessRequestService({ ...host, borrow }, timeoutMs);
    const login = new ModelAccessLoginService({
        ...host,
        forgetLate: async (input) => {
            const registration = input.generation.registration;
            await registration.extension.providers.fixture?.forget?.(extensionContext({
                directories,
                profileId: 'synthetic',
                installationId: 'synthetic',
                generation: registration.generation,
                signal: new AbortController().signal,
            }), {
                providerKey: input.providerKey,
                installationId: 'synthetic',
                providerId: 'fixture',
                kind: 'direct-owned',
            }, input.payload);
        },
    });
    const activate = async (version) => {
        const modulePath = path.join(root, `extension-${version}.mjs`);
        await writeFile(modulePath, moduleSource(version));
        const lease = await supervisor.activate({
            installationId: 'synthetic',
            packageGeneration: version,
            moduleUrl: pathToFileURL(modulePath).href,
            manifest,
            entryPath: fileURLToPath(new URL('../shim/host-entry.ts', import.meta.url)),
            nodeArgs: ['--import', createRequire(import.meta.url).resolve('tsx/esm')],
            cwd: root,
            environment: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
        });
        leases.push(lease);
        const extension = fixtureProxy(lease);
        const input = {
            installationId: 'synthetic',
            generation: version,
            digest: `sha256:${String(version).repeat(64)}`,
            manifest,
            extension,
            host: lease,
        };
        if (registry.get('synthetic'))
            registry.replace(input);
        else
            registry.register(input);
        await lease.release();
        return lease;
    };
    await activate(1);
    policy.setGlobal('subscriptionBorrow', true);
    policy.setTarget({
        installationId: 'synthetic',
        sourceId: 'fixture',
        capability: 'login',
        entryId: 'device',
        target: 'global',
    }, true);
    const commit = (token = 'original', expiresAt = 1, providerKey = 'owned') => bindings.replaceOwned({
        providerKey,
        providerId: 'fixture',
        installationId: 'synthetic',
        credentialSchema: 1,
        identity,
        signal: new AbortController().signal,
        payload: JSON.stringify({ token, expiresAt }),
    });
    const marker = (name) => path.join(dataDir, name);
    return {
        registry,
        supervisor,
        policy,
        bindings,
        owned,
        borrow,
        requests,
        login,
        activate,
        leases,
        slots,
        commit,
        state: () => state,
        mark: (name) => writeFile(marker(name), 'synthetic'),
        read: (name) => readFile(marker(name), 'utf8'),
        seedBorrow: () => writeFile(marker('borrow.json'), JSON.stringify({
            identity,
            payload: { token: 'borrow-original', expiresAt: Date.now() + 60000 },
        })),
        setBeforeWrite: (run) => {
            beforeWrite = run;
        },
        close: async () => {
            for (const version of [1, 2, 3])
                for (const kind of ['owned', 'borrow', 'login'])
                    await writeFile(marker(`${kind}-release-${version}`), 'synthetic');
            requests.close();
            borrow.close();
            owned.close();
            await login.close();
            await Promise.all([requests.settled(), borrow.settled(), owned.settled()]);
            registry.remove('synthetic');
            await supervisor.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}
function fixtureProxy(lease) {
    const { peer } = lease;
    return {
        providers: {
            fixture: {
                ...createModelAccessHostOwnedHandlers(peer, 'fixture', [
                    'resolveOwned',
                    'renewOwned',
                    'forceRenewOwned',
                    'forget',
                ]),
                models: (context, binding, credential) => peer.request('models', {
                    providerId: 'fixture',
                    context: hostContextInput(context),
                    binding,
                    credential,
                }),
                bindTransport: async (context, credential, requestedModel) => createModelAccessHostTransport(peer, await peer.request('bindTransport', {
                    providerId: 'fixture',
                    context: hostContextInput(context),
                    credential,
                    model: requestedModel,
                })),
                classifyError: createModelAccessHostClassifier(peer, 'fixture'),
            },
        },
        sources: {
            fixture: {
                login: {
                    device: createModelAccessHostLoginHandler(peer, {
                        providerId: 'fixture',
                        sourceId: 'fixture',
                        methodId: 'device',
                        kind: 'device-code',
                    }),
                },
                subscriptionBorrow: {
                    cli: {
                        discover: async () => [],
                        ...createModelAccessHostBorrowHandlers(peer, 'fixture', 'cli', ['renew', 'forceRenew']),
                    },
                },
            },
        },
    };
}
//# sourceMappingURL=fixtures.test-support.js.map