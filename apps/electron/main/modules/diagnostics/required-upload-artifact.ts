import * as fs from "fs";
export let REQUIRED_UPLOAD_ARTIFACT_SOURCE = 'required-upload-artifacts';
/**
 * Required upload artifacts are explicit, user-consented feedback payloads.
 * Preserve them byte-for-byte so structured session reports remain parseable.
 * `source` 决定它在包清单里算在哪个来源下（装包分档时排在日志之后的会话文件用单独的来源）。
 */
export async function createRequiredUploadArtifact(artifact, source = REQUIRED_UPLOAD_ARTIFACT_SOURCE) {
    if (artifact.content !== undefined) {
        return {
            name: artifact.name,
            content: artifact.content,
            bytes: Buffer.byteLength(artifact.content, 'utf8'),
            source,
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        };
    }
    if (!artifact.path) {
        throw new Error(`required_diagnostic_artifact_missing:${artifact.name}`);
    }
    try {
        const stat = await fs.promises.stat(artifact.path);
        return {
            name: artifact.name,
            path: artifact.path,
            bytes: stat.size,
            source,
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        };
    }
    catch {
        throw new Error(`required_diagnostic_artifact_missing:${artifact.name}`);
    }
}
