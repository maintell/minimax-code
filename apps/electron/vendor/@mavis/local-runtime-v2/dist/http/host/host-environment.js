import { ensureCurrentLocalRuntimeDataMigratedToV2OrThrow, hasCompletedV2LayoutMigrationReceipt, } from '../../infra/legacy-db/v2-migration.js';
import { ensureTrashScript, inspectTrashRuntime } from '../../infra/process/ensure-trash-script.js';
import { ensureRmShim } from '../../infra/process/ensure-rm-shim.js';
import { ensureBinInProcessPath } from '../../infra/process/ensure-bin-in-path.js';
import { logger } from '../../infra/logging/logger.js';
import { getConfig } from '@mavis/config';
import { resolveLocalBashShell } from '@mavis/agent-tools/desktop';
import { createDeferredPluginHookPermissionCapability } from '@mavis/permission';
import { createDeferredContentSafetyCapability } from '@mavis/shared/local-runtime-safety';
import { createDeferredSkillRuntimeCapability } from '@mavis/shared/local-runtime-skills';
import { createFailClosedAgentRuntimePort } from '../../service/agent/index.js';
import { resolveBuiltinReviewPromptDir } from '../../service/review/index.js';
import { updateLocalConfigFile } from '../../infra/config/update.js';
import { createLLMFailureReportHook } from '../../infra/error-reporting/index.js';
import { LocalBashCompletionCorrelation } from '../../infra/observability/bash-completion-correlation.js';
import { resolveLocalRuntimeMode } from '../../infra/runtime-owner/mode.js';
import { makeRuntimeOwnerId } from './host-support.js';
import { createLocalModelResolver } from './turn/host-turn-service-factories.js';
export function resolveHostIdentityOptions(options) {
    const runtimeOwnerKind = options.runtimeOwnerKind ?? 'runtime';
    return {
        agentName: options.agentName ?? 'mavis',
        agentDisplayName: options.agentDisplayName ?? 'Mavis',
        reviewPromptDir: options.reviewPromptDir ?? resolveBuiltinReviewPromptDir(),
        runtimeMode: options.runtimeMode ?? resolveLocalRuntimeMode(),
        lockOwner: {
            ownerKind: runtimeOwnerKind,
            ownerId: options.runtimeOwnerId ?? makeRuntimeOwnerId(runtimeOwnerKind),
        },
        channelCapabilityEnabled: (options.channelComposition ?? 'internal') === 'external' &&
            options.capabilityProfile !== 'cli',
    };
}
export function resolveHostConfigOptions(options) {
    return {
        configGetter: options.configGetter ?? (() => getConfig()),
        configUpdater: options.configUpdater ?? updateLocalConfigFile,
        nowMs: options.nowMs ?? (() => Date.now()),
        isContextWindowUsageEnabled: options.isContextWindowUsageEnabled ?? (() => false),
        llmRequestFailureHook: options.llmRequestFailureHook ??
            (options.errorReporter ? createLLMFailureReportHook(options.errorReporter) : undefined),
        bashCompletionCorrelation: options.bashCompletionCorrelation ??
            new LocalBashCompletionCorrelation(options.metricsClient),
    };
}
export function resolveHostCapabilityOptions(options) {
    const agentRuntimePort = options.agentRuntimePort ?? createFailClosedAgentRuntimePort();
    return {
        agentRuntimePort,
        agentResolver: options.agentResolver ?? agentRuntimePort,
        contentSafety: options.contentSafety ?? createDeferredContentSafetyCapability().capability,
        skillRuntime: options.skillRuntime ?? createDeferredSkillRuntimeCapability().capability,
        pluginHookPermissionStore: options.pluginHookPermissionStore ??
            createDeferredPluginHookPermissionCapability().capability,
    };
}
export function resolveHostModelResolver(options, input) {
    return options.modelResolver ?? createLocalModelResolver(input);
}
function reportTrashSeedFailure(error) {
    const nodeError = error instanceof Error ? error : undefined;
    logger.error({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { error_name: error.name } : {}),
        ...(typeof nodeError?.code === 'string' ? { error_code: nodeError.code } : {}),
        ...(typeof nodeError?.syscall === 'string' ? { syscall: nodeError.syscall } : {}),
    }, 'local_runtime.trash_seed_failed');
}
/** 在 Host 存储打开前完成目录迁移与当前 profile 的命令环境准备。 */
export function initializeHostEnvironment(input) {
    const { options, configGetter, nowMs } = input;
    if (!hasCompletedV2LayoutMigrationReceipt(options, () => configGetter().dataDir)) {
        ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(() => configGetter().dataDir, nowMs, options.metricsReporter);
    }
    const runtimeConfig = configGetter();
    const dataDir = runtimeConfig.dataDir;
    // 原生删除模式下 `rm` 不经过回收站，启动时既不修复 rm shim，也不检查回收站可用性。
    const nativeDelete = runtimeConfig.permission?.nativeDelete === true;
    try {
        // 两种模式都保留显式的 mavis-trash。
        ensureTrashScript(dataDir);
        if (!nativeDelete)
            ensureRmShim(dataDir);
    }
    catch (error) {
        reportTrashSeedFailure(error);
    }
    try {
        // `<dataDir>/bin` 只注入当前进程 PATH，不写用户 shell rc 或 HKCU\Environment。
        ensureBinInProcessPath(dataDir);
    }
    catch {
        // PATH 注入保持 best-effort；删除安全性由下方检查报告。
    }
    if (!nativeDelete)
        reportTrashRuntimeHealth(dataDir);
}
function reportTrashRuntimeHealth(dataDir) {
    const trashRuntime = inspectTrashRuntime(dataDir);
    if (!trashRuntime.available) {
        logger.error({ reason: trashRuntime.reason, ...trashRuntime.diagnostics }, 'local_runtime.trash_unavailable');
    }
}
/**
 * 产品入口未显式指定时，按执行器实际选用的 Shell 推导 shell family。Windows 上的
 * Git Bash / sh 同样记为 POSIX；无法判定时保持 undefined，原生删除继续 fail closed。
 */
export function resolveHostShellFamily(explicit) {
    if (explicit)
        return explicit;
    const shell = resolveLocalBashShell();
    if (shell === 'powershell' || shell === 'pwsh')
        return 'powershell';
    if (shell === 'bash' || shell === 'sh')
        return 'posix';
    return undefined;
}
/** TUI-only startup opt-out; every other owner keeps the Windows hard-safety checks. */
export function readTuiWindowsHardSafetyOptOut(runtimeOwnerKind, configGetter) {
    return runtimeOwnerKind === 'tui' && configGetter().skipWindowsHardSafetyChecks === true;
}
//# sourceMappingURL=host-environment.js.map