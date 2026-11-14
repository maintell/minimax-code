/**
 * 兼容拆分调用快照前已落盘的合同，避免升级时全量重抽或 INIT。
 * 旧 ID 无法反推出格式版本；历史 input-v5 等文档也允许按当前可读格式接续，
 * 不补跑旧输入裁剪或 prompt 规则。调用方必须验证来源水位、文档信封或文件协议。
 * 下列前缀限定接收方版本，不表示旧产物也是 v3/input-v6；未来不兼容版本不能自动加入。
 */
export function isCompatibleLegacyArtifactContract(storedContractId, artifactContractId) {
    return (/^[a-f0-9]{64}$/.test(storedContractId ?? '') &&
        /^(capture|consolidation)-v3-input-v6:[a-f0-9]{64}$/.test(artifactContractId));
}
//# sourceMappingURL=artifact-contract.js.map