import * as fs from "fs";
/**
 * Required upload artifacts are explicit, user-consented feedback payloads.
 * Preserve them byte-for-byte so structured session reports remain parseable.
 */
export async function createRequiredUploadArtifact(artifact) {
    if (artifact.content !== undefined) {
        return {
            name: artifact.name,
            content: artifact.content,
            bytes: Buffer.byteLength(artifact.content, 'utf8'),
            source: 'required-upload-artifacts',
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
            source: 'required-upload-artifacts',
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        };
    }
    catch {
        throw new Error(`required_diagnostic_artifact_missing:${artifact.name}`);
    }
}
