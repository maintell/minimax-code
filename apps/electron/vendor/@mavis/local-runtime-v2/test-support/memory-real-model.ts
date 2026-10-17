import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import {
  getPrimaryDataDirPath,
  loadConfigFromFile,
  readLocalRuntimeAuthContext,
  setLegacyByokProviderMigrationEnabled,
  setManagedPresetBaseUrlSyncEnabled,
} from '@mavis/config';
import { DatabaseClient } from '../src/infra/db/client.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { ALL_MIGRATIONS } from '../src/infra/db/migrations.js';
import { LocalModelResolver } from '../src/service/model-system/index.js';
import {
  createProductionAgentPreparation,
  createGlobalMemoryModelCompletion,
} from '../src/service/turn-system/index.js';
import { resolveBuiltinPromptAssetsDir } from '../src/service/prompt-config/index.js';
import { MemoryV2ModelGateway } from '../src/service/memory-system/adapters/model-gateway.js';
import { MemoryStateRepositoryImpl } from '../src/service/memory-system/adapters/state-repository.js';
import { MemoryFileStoreImpl } from '../src/service/memory-system/adapters/file-store.js';
import { SessionMemorySourceAdapter } from '../src/service/memory-system/adapters/session-source.js';
import { createProductionSessionSystemPort } from '../src/service/memory-system/adapters/session-source.production.js';
import { MemoryDiagnostics, traceMemoryPort } from '../src/service/memory-system/diagnostics.js';
import { MemoryScopeMutationCoordinator } from '../src/service/memory-system/scope-mutation.js';
import { accessPolicy } from '../src/service/memory-system/access-policy.js';
import { MemoryCaptureService } from '../src/service/memory-system/orchestration/capture-service.js';
import { MemoryConsolidationService } from '../src/service/memory-system/orchestration/consolidation-service.js';
import { MemoryLegacyMigrationService } from '../src/service/memory-system/orchestration/legacy-migration-service.js';
import { MemoryGovernanceService } from '../src/service/memory-system/orchestration/governance-service.js';
import type { SessionRecord } from '../src/service/session-system/index.js';

const SOURCE_TEXT =
  '长期约定：项目使用 TypeScript，依赖管理统一使用 pnpm。所有技术文档使用中文。请确认你理解这三项约定，并说明后续开发、安装依赖和交付文档时分别怎样执行。';
export const MEMORY_REAL_SOURCE_MESSAGES = [
  { role: 'user', content: SOURCE_TEXT, genuineUserQueryText: SOURCE_TEXT },
  {
    role: 'assistant',
    stopReason: 'stop',
    content:
      '已确认：后续在这个项目中编写和修改代码时使用 TypeScript；安装、更新和管理依赖统一使用 pnpm，并在交付说明中使用对应命令。技术文档使用中文，这项约定适用于后续技术说明，项目路径仅作为本次对话的来源。代码标识符和命令保持原文。这三项约定分别对应项目语言、依赖管理和文档语言。',
  },
];
const SESSION_ID = 'memory-real-session';

/** 仅测试数据使用独立目录；模型与认证走本机生产配置。 */
export async function createMemoryRealHarness(caseName: string) {
  setLegacyByokProviderMigrationEnabled(false);
  setManagedPresetBaseUrlSyncEnabled(false);
  const configDir = getPrimaryDataDirPath();
  const appConfig = loadConfigFromFile(join(configDir, 'config.yaml'), { dataDir: configDir });
  const dataDir = await mkdtemp(join(tmpdir(), `memory-real-${caseName}-`));
  process.stdout.write(`[memory-real:${caseName}] ${dataDir}\n`);
  const config = () => ({
    ...appConfig.memory.v2,
    active: true,
    enabled: true,
    captureModel: 'minimax/MiniMax-M3',
    consolidationModel: 'minimax/MiniMax-M3',
    writeEnabled: true,
    recallEnabled: true,
    detailedLoggingEnabled: true,
  });
  let clockOffset = 0;
  const nowMs = () => Date.now() + clockOffset;
  const diagnostics = new MemoryDiagnostics({ dataDir, enabled: () => true, nowMs });
  const client = new DatabaseClient({ dataDir });
  try {
    runMigrations(client.rawDb, ALL_MIGRATIONS);
    const resolver = new LocalModelResolver({
      providerConfigGetter: () => appConfig.provider,
      byokConfigGetter: () => ({
        minimax_api: appConfig.minimax_api,
        custom_provider: appConfig.custom_provider,
        minimaxModelSource: appConfig.minimaxModelSource,
      }),
      authContextGetter: () => readLocalRuntimeAuthContext(configDir),
      providerAuthGetter: (provider) =>
        AuthStorage.create(join(configDir, 'codex-auth.json')).getApiKey(provider, {
          includeFallback: false,
        }),
    });
    const preparation = createProductionAgentPreparation({
      configBuilder: {
        config: () => appConfig,
        skills: { listRuntimeSkills: async () => ({ skills: [] }), renderCatalog: async () => '' },
      },
      modelResolver: resolver,
    });
    const assets = await resolveBuiltinPromptAssetsDir();
    const promptNames = {
      capture: 'memory-v2-extraction.md',
      consolidation: 'memory-v2-consolidation.md',
      migration: 'memory-v2-migration.md',
    };
    const model = traceMemoryPort(
      diagnostics,
      'model',
      new MemoryV2ModelGateway({
        config,
        readPrompt: (kind) => readFile(join(assets, promptNames[kind]), 'utf8'),
        completion: createGlobalMemoryModelCompletion({
          preparation,
          defaultModelName: () => appConfig.defaultModel ?? 'minimax/MiniMax-M3',
          nowMs,
          diagnosticEvent: (event, payload) => diagnostics.event(event, payload),
        }),
      }),
    );
    const repository = traceMemoryPort(
      diagnostics,
      'repository',
      new MemoryStateRepositoryImpl(client.db, nowMs),
    );
    const fileStore = traceMemoryPort(diagnostics, 'files', new MemoryFileStoreImpl(dataDir));
    const createdAtMs = nowMs() - 60_000;
    const session = {
      sessionId: SESSION_ID,
      agentName: 'memory-test',
      workspaceDir: dataDir,
      runtime: 'pi-agent',
      sessionType: 'branch',
      sessionKind: 'conversation',
      archived: false,
      status: 'idle',
      title: '记忆真实模型验收',
      createdAtMs,
      updatedAtMs: createdAtMs,
    } satisfies SessionRecord;
    const source = new SessionMemorySourceAdapter(
      createProductionSessionSystemPort({
        sessions: {
          get: async (id) => (id === SESSION_ID ? session : undefined),
          listPage: async () => ({ sessions: [session], hasMore: false }),
        },
        projects: { getSessionProjectId: async () => undefined, getById: async () => undefined },
        history: {
          read: async () => ({
            revision: 'fixture-v1',
            identityVector: ['user-1', 'assistant-1'],
            messages: MEMORY_REAL_SOURCE_MESSAGES,
          }),
        },
        nowMs,
      }),
    );
    const shared = {
      repository,
      fileStore,
      scopeMutation: new MemoryScopeMutationCoordinator(),
      config,
      accessPolicy,
      source,
      nowMs,
    };
    const capture = traceMemoryPort(
      diagnostics,
      'capture',
      new MemoryCaptureService({ ...shared, model }),
    );
    const consolidation = traceMemoryPort(
      diagnostics,
      'consolidation',
      new MemoryConsolidationService({ ...shared, model }),
    );
    const migration = traceMemoryPort(
      diagnostics,
      'migration',
      new MemoryLegacyMigrationService({
        ...shared,
        modelGateway: model,
        disableLegacyRecall: async (agentName) => {
          await writeFile(
            join(dataDir, 'config.yaml'),
            `memory:\n  legacyRecallDisabledAgents:\n    ${agentName}: true\n`,
          );
        },
      }),
    );
    const governance = traceMemoryPort(
      diagnostics,
      'governance',
      new MemoryGovernanceService(shared),
    );
    await writeFile(
      join(dataDir, 'input.json'),
      JSON.stringify(
        {
          caseName,
          stageTwoInputSnapshot:
            caseName === 'stage-two' ? process.env.MAVIS_MEMORY_REAL_STAGE_TWO_INPUT : undefined,
          configPath: join(configDir, 'config.yaml'),
          defaultModel: appConfig.defaultModel,
          memory: config(),
          session,
          history: MEMORY_REAL_SOURCE_MESSAGES,
        },
        null,
        2,
      ),
    );
    return {
      dataDir,
      repository,
      fileStore,
      capture,
      consolidation,
      migration,
      governance,
      diagnostics,
      candidate: {
        sessionId: SESSION_ID,
        createdAtMs,
        updatedAtMs: createdAtMs,
        sourceRevision: 'fixture-v1',
      },
      advancePastCooldown: () => {
        clockOffset += config().publicationCooldownMs + 1;
      },
      async close() {
        await diagnostics.flush();
        client.close();
      },
    };
  } catch (error) {
    await diagnostics.flush();
    client.close();
    throw error;
  }
}

export type MemoryRealHarness = Awaited<ReturnType<typeof createMemoryRealHarness>>;

export async function runMemoryRealCase(
  name: string,
  run: (harness: MemoryRealHarness) => Promise<void>,
) {
  const harness = await createMemoryRealHarness(name);
  const startedAtMs = Date.now();
  try {
    await harness.diagnostics.run(`acceptance.${name}`, {}, () => run(harness));
    await writeFile(
      join(harness.dataDir, 'result.json'),
      JSON.stringify({ status: 'passed', startedAtMs, finishedAtMs: Date.now() }),
    );
  } catch (error) {
    await writeFile(
      join(harness.dataDir, 'result.json'),
      JSON.stringify({ status: 'failed', startedAtMs, finishedAtMs: Date.now() }),
    );
    throw error;
  } finally {
    await harness.close();
  }
}
