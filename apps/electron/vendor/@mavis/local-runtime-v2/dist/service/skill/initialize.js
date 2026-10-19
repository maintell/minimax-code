import { isManagedRuntime } from '@mavis/config';
import { SkillEvolveService } from './evolve.service.js';
import { LocalSkillHubStore } from './management/hub-api.js';
import { createLocalSkillService } from './management/skill-service.js';
import { createHostedSkillReads } from './runtime/hosted-reader.js';
import { resolveFeatureAwareBuiltinSkillNames } from './runtime/feature-owned-skills.js';
import { readNativeSkill } from './runtime/native-reader.js';
import { createLocalSkillRegistryProvider } from './registry/registry.js';
import { createRuntimeSkillReads } from './runtime/reads.js';
import { getBuiltinSkillsDirCandidates, isLocalBuiltinSkillEnabled, readLocalBuiltinSkill, } from './assets/builtin.js';
import { seedBuiltinSkills } from './assets/seed-builtin.js';
import { resolveBuiltinSkillsDir } from './registry/roots.js';
export function initializeSkillSystem(options) {
    const provider = createLocalSkillRegistryProvider(options.configGetter, options.skillRegistryRoots === undefined ? undefined : () => options.skillRegistryRoots ?? [], options.registryDiagnostics, { enabledState: options.enabledState, readMcpServerNames: options.readMcpServerNames });
    const listeners = new Set();
    const work = new Set();
    let closed = false;
    let ready = false;
    let closePromise;
    const run = async (action) => {
        if (closed)
            throw new Error('Skill runtime has been closed');
        const result = action();
        work.add(result);
        try {
            return await result;
        }
        finally {
            work.delete(result);
        }
    };
    const notifyRuntimeSkillsChanged = () => {
        for (const listener of listeners)
            listener();
    };
    const registry = {
        listSkills: (...args) => run(() => provider.listSkills(...args)),
        listRuntimeSkills: (...args) => run(() => provider.listRuntimeSkills(...args)),
        renderCatalog: (...args) => run(() => provider.renderCatalog(...args)),
        readSkillByName: (...args) => run(() => provider.readSkillByName(...args)),
        getSkillDetail: (...args) => run(() => provider.getSkillDetail(...args)),
        listSkillFiles: (...args) => run(() => provider.listSkillFiles(...args)),
        readSkillFile: (...args) => run(() => provider.readSkillFile(...args)),
        deleteSkill: (...args) => run(() => provider.deleteSkill(...args)),
        setSkillEnabled: (...args) => run(() => provider.setSkillEnabled(...args)),
        refresh: (...args) => run(() => provider.refresh(...args)),
    };
    const reads = createRuntimeSkillReads(options, provider);
    const hostedReads = createHostedSkillReads(reads);
    const hasBuiltinSkill = async (name, agentName) => (await readLocalBuiltinSkill(name, agentName)) !== undefined;
    const runtime = {
        registry,
        withRegistry: (action) => run(() => action({ registry: provider, hasBuiltinSkill })),
        resolveBuiltinSkillNames: resolveFeatureAwareBuiltinSkillNames,
        readNativeSkill: (input) => run(() => readNativeSkill(reads, input)),
        listHostedRuntimeSkills: (...args) => run(() => hostedReads.listHostedRuntimeSkills(...args)),
        renderHostedCatalog: (...args) => run(() => hostedReads.renderHostedCatalog(...args)),
        listRuntimeSkills: (...args) => run(() => reads.listRuntimeSkills(...args)),
        renderCatalog: (...args) => run(() => reads.renderCatalog(...args)),
        readSkillByName: (...args) => run(() => reads.readSkillByName(...args)),
        setSkillEnabled: (input, enabled) => run(async () => {
            const result = await provider.setSkillEnabled(input, enabled);
            if (result)
                notifyRuntimeSkillsChanged();
            return result;
        }),
        hasBuiltinSkill: (name, agentName) => run(() => hasBuiltinSkill(name, agentName)),
        onDidChangeRuntimeSkills: (listener) => {
            if (closed)
                throw new Error('Skill runtime has been closed');
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        notifyRuntimeSkillsChanged,
    };
    const hub = new LocalSkillHubStore({
        remoteEnabled: () => options.configGetter().skillHub?.enabled !== false &&
            process.env.__MAVIS_RUNTIME_MANAGED !== '0' &&
            (options.management.runtimeOwnerKind === 'electron' ||
                options.management.electronHost === true ||
                isManagedRuntime()),
        ...options.management.hub,
        dataDir: () => options.configGetter().dataDir,
    });
    const management = createLocalSkillService({
        ...options,
        ...options.management,
        runtime,
        skillHubStore: hub,
    });
    const evolve = new SkillEvolveService(() => options.configGetter().dataDir, options.management.hub.nowMs ?? Date.now);
    const unbind = options.bindRuntime(runtime);
    return {
        runtime,
        management,
        evolve: (input) => run(() => evolve.execute(input)),
        installedIdentities: () => run(() => hub.getInstalledIdentities()),
        ready: async () => {
            if (closed)
                throw new Error('Skill runtime has been closed');
            if (ready)
                return;
            seedBuiltinSkills({
                builtinSkillsDir: resolveBuiltinSkillsDir(options.configGetter()),
                sourceDirs: getBuiltinSkillsDirCandidates(),
                isSkillEnabled: isLocalBuiltinSkillEnabled,
            });
            ready = true;
        },
        close: () => {
            closePromise ??= (async () => {
                closed = true;
                await Promise.allSettled([...work]);
                try {
                    provider.close();
                }
                finally {
                    listeners.clear();
                    unbind();
                }
            })();
            return closePromise;
        },
    };
}
//# sourceMappingURL=initialize.js.map