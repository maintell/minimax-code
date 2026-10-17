import { createResultDeliveryPort } from './adapters/result-delivery.js';
import { SessionHandoffCloudClient, } from './adapters/cloud-client.js';
import { initializeSessionHandoffService } from './initialize.js';
import { createResultWorkspacePort } from './adapters/result-workspace.js';
import { createHandoffRecommendationModelPort, } from './adapters/recommendation-model.js';
import { createHandoffSummaryModelPort } from './adapters/summary-model.js';
import { FileHandoffStateStore } from './adapters/state-store.js';
import { NativeHandoffTransferClient } from './adapters/transfer-client.js';
import { createHandoffWorkspacePort } from './adapters/workspace.js';
import { cleanupTransferOrphans } from './upload-resume.js';
export async function createSessionHandoffComposition(input) {
    const workspace = createHandoffWorkspacePort({
        dataDir: input.dataDir,
        scan: input.compatibility.workspace.scan,
    });
    const state = new FileHandoffStateStore(input.dataDir);
    const cloud = new SessionHandoffCloudClient({
        ...input.compatibility.cloud,
        ...(input.logger ? { logger: input.logger } : {}),
    });
    const transfer = createTransferClient(input, cloud);
    const resultWorkspace = createResultWorkspacePort({
        dataDir: input.dataDir,
        workspace,
        sessions: input.sessions,
        worktree: input.worktree,
    });
    const resultDelivery = createResultDelivery(input);
    const modelPorts = handoffModelPorts(input.recommendation);
    await cleanupTransferOrphans({
        state,
        workspace,
        cloud,
        ...(transfer ? { transfer } : {}),
        nowMs: input.nowMs?.() ?? Date.now(),
        abortReason: 'Local Session handoff transfer expired during restart recovery',
    });
    const retainedResultWorkspaces = (await state.listActiveResultMaterializations()).flatMap((materialization) => {
        if (materialization.state !== 'materializing' ||
            !materialization.workspacePath ||
            !materialization.workingPath ||
            !materialization.transferPath ||
            !materialization.operationId ||
            !materialization.kind) {
            return [];
        }
        return [
            {
                workspacePath: materialization.workspacePath,
                workingPath: materialization.workingPath,
                transferPath: materialization.transferPath,
                operationId: materialization.operationId,
                kind: materialization.kind,
                ...(materialization.ownershipToken
                    ? { ownershipToken: materialization.ownershipToken }
                    : {}),
                ...(materialization.fingerprint ? { fingerprint: materialization.fingerprint } : {}),
            },
        ];
    });
    await Promise.all([
        resultWorkspace.cleanupOrphans?.(retainedResultWorkspaces),
        resultDelivery?.recoverPending(),
    ]);
    return initializeSessionHandoffService({
        ...(input.metrics ? { metrics: input.metrics } : {}),
        workspace,
        cloud,
        state,
        identity: state,
        resultWorkspace,
        ...(resultDelivery ? { resultDelivery } : {}),
        ...modelPorts,
        ...(transfer ? { transfer } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.logger ? { logger: input.logger } : {}),
    });
}
function createTransferClient(input, cloud) {
    const binaryPath = input.binaryPath ?? process.env.MAVIS_SESSION_TRANSFER_CLIENT?.trim();
    return binaryPath
        ? new NativeHandoffTransferClient({ binaryPath, dataDir: input.dataDir, cloud })
        : undefined;
}
function createResultDelivery(input) {
    const downloadsDir = input.downloadsDir ?? process.env.MAVIS_SESSION_RESULT_DOWNLOADS_DIR?.trim();
    return downloadsDir
        ? createResultDeliveryPort({ dataDir: input.dataDir, downloadsDir })
        : undefined;
}
// 同一份模型准备同时供两个派发端口:文件推荐与历史摘要。两者都只在宿主具备模型能力
// 时才存在,缺席时各自退回自己的确定性兜底(工具证据下限 / 兜底摘要)。
function handoffModelPorts(options) {
    if (!options)
        return {};
    return {
        recommendation: createHandoffRecommendationModelPort(options),
        summary: createHandoffSummaryModelPort(options),
    };
}
//# sourceMappingURL=composition.js.map