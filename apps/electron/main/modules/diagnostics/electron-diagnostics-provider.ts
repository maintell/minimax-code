import { realpath, readFile, lstat } from "node:fs/promises";
import * as path from "node:path";
import { uploadLog } from "../../ipc/system.ipc";
import { resolveLocalRuntimeDataDir } from "../local-runtime/data-dir";
import { resolveLocalRuntimeV2DirectoryContract } from "../local-runtime/v2-paths";
const MAX_UPLOAD_FILES = 256;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_DIAGNOSTIC_MANIFEST_BYTES = 2 * 1024 * 1024;
const SENSITIVE_CREDENTIAL_FILENAMES = new Set([
    'auth.json',
    'credentials.enc',
    'credentials.json',
]);
function diagnosticBundleRootDir() {
    return path.resolve(resolveLocalRuntimeV2DirectoryContract(resolveLocalRuntimeDataDir()).diagnostics);
}
function isPathInside(root, child) {
    const relative = path.relative(root, child);
    return (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)));
}
async function realpathOrNull(rawPath) {
    return realpath(rawPath).catch(() => null);
}
function toDiagnosticUploadError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith('diagnostic_upload_') ? message : null;
}
async function readDiagnosticUploadManifest(manifestPath) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(manifestPath, 'utf-8'));
    }
    catch {
        throw new Error('diagnostic_upload_manifest_invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('diagnostic_upload_manifest_invalid');
    }
    const artifacts = parsed.artifacts;
    if (!Array.isArray(artifacts)) {
        throw new Error('diagnostic_upload_manifest_artifacts_required');
    }
    if (artifacts.length > MAX_UPLOAD_FILES) {
        throw new Error('diagnostic_upload_too_many_files');
    }
    return artifacts.map((artifact, index) => {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
            throw new Error(`diagnostic_upload_manifest_artifact_invalid:${index}`);
        }
        const raw = artifact;
        if (typeof raw.name !== 'string' || !raw.name) {
            throw new Error(`diagnostic_upload_manifest_artifact_invalid:${index}`);
        }
        if (typeof raw.bytes !== 'number' || !Number.isFinite(raw.bytes) || raw.bytes < 0) {
            throw new Error(`diagnostic_upload_manifest_artifact_invalid:${index}`);
        }
        return { name: raw.name, bytes: Math.floor(raw.bytes) };
    });
}
function resolveManifestArtifactPath(root, artifactName) {
    if (artifactName.includes('\\') ||
        artifactName.includes('\0') ||
        artifactName.startsWith('/') ||
        /^[A-Za-z]:/u.test(artifactName)) {
        throw new Error('diagnostic_upload_manifest_artifact_path_invalid');
    }
    const segments = artifactName.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('diagnostic_upload_manifest_artifact_path_invalid');
    }
    return path.join(root, ...segments);
}
function isSensitiveCredentialArtifact(artifactName) {
    return artifactName
        .split('/')
        .some((segment) => SENSITIVE_CREDENTIAL_FILENAMES.has(segment.toLowerCase()) ||
        /^auth\.json\..+\.tmp$/iu.test(segment));
}
function diagnosticArchiveName(bundlePath, artifactName) {
    return `diagnostic-bundle/${path.basename(bundlePath)}/${artifactName}`;
}
async function uploadDiagnosticBundle(body) {
    if (body.confirm !== true) {
        return { available: false, error: 'diagnostic_upload_consent_required' };
    }
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath)
        return { available: false, error: 'diagnostic_upload_path_required' };
    const bundlePath = path.resolve(rawPath);
    const diagnosticRoot = diagnosticBundleRootDir();
    if (!isPathInside(diagnosticRoot, bundlePath)) {
        return { available: false, error: 'diagnostic_upload_path_outside_diagnostics_dir' };
    }
    const diagnosticRootStat = await lstat(diagnosticRoot).catch(() => null);
    if (diagnosticRootStat?.isSymbolicLink()) {
        return { available: false, error: 'diagnostic_upload_symlink_not_allowed' };
    }
    const bundleStat = await lstat(bundlePath).catch(() => null);
    if (!bundleStat)
        return { available: false, error: 'diagnostic_upload_path_not_found' };
    if (bundleStat.isSymbolicLink()) {
        return { available: false, error: 'diagnostic_upload_symlink_not_allowed' };
    }
    if (!bundleStat.isDirectory()) {
        return { available: false, error: 'diagnostic_upload_directory_required' };
    }
    const [dataDirRealPath, diagnosticRootRealPath, bundleRealPath] = await Promise.all([
        realpathOrNull(resolveLocalRuntimeDataDir()),
        realpathOrNull(diagnosticRoot),
        realpathOrNull(bundlePath),
    ]);
    if (!dataDirRealPath || !diagnosticRootRealPath || !bundleRealPath) {
        return { available: false, error: 'diagnostic_upload_path_not_found' };
    }
    if (!isPathInside(dataDirRealPath, diagnosticRootRealPath)) {
        return { available: false, error: 'diagnostic_upload_path_outside_diagnostics_dir' };
    }
    if (!isPathInside(diagnosticRootRealPath, bundleRealPath)) {
        return { available: false, error: 'diagnostic_upload_path_outside_diagnostics_dir' };
    }
    const manifestPath = path.join(bundlePath, 'diagnostic-manifest.json');
    const manifestStat = await lstat(manifestPath).catch(() => null);
    if (manifestStat?.isSymbolicLink()) {
        return { available: false, error: 'diagnostic_upload_symlink_not_allowed' };
    }
    if (!manifestStat?.isFile()) {
        return { available: false, error: 'diagnostic_upload_manifest_required' };
    }
    if (manifestStat.size > MAX_DIAGNOSTIC_MANIFEST_BYTES) {
        return { available: false, error: 'diagnostic_upload_manifest_too_large' };
    }
    const manifestRealPath = await realpathOrNull(manifestPath);
    if (!manifestRealPath || !isPathInside(bundleRealPath, manifestRealPath)) {
        return { available: false, error: 'diagnostic_upload_path_outside_bundle_dir' };
    }
    let manifestArtifacts;
    try {
        manifestArtifacts = await readDiagnosticUploadManifest(manifestPath);
    }
    catch (err) {
        const uploadError = toDiagnosticUploadError(err);
        if (uploadError)
            return { available: false, error: uploadError };
        throw err;
    }
    const files = [
        {
            name: diagnosticArchiveName(bundlePath, 'diagnostic-manifest.json'),
            path: manifestPath,
        },
    ];
    const seenArtifacts = new Set(['diagnostic-manifest.json']);
    let totalBytes = manifestStat.size;
    if (totalBytes > MAX_UPLOAD_BYTES) {
        return { available: false, error: 'diagnostic_upload_too_large' };
    }
    for (const artifact of manifestArtifacts) {
        if (isSensitiveCredentialArtifact(artifact.name)) {
            return { available: false, error: 'diagnostic_upload_sensitive_artifact_not_allowed' };
        }
        if (seenArtifacts.has(artifact.name)) {
            return { available: false, error: 'diagnostic_upload_manifest_artifact_duplicate' };
        }
        seenArtifacts.add(artifact.name);
        let artifactPath;
        try {
            artifactPath = resolveManifestArtifactPath(bundlePath, artifact.name);
        }
        catch (err) {
            const uploadError = toDiagnosticUploadError(err);
            if (uploadError)
                return { available: false, error: uploadError };
            throw err;
        }
        const artifactStat = await lstat(artifactPath).catch(() => null);
        if (!artifactStat)
            return { available: false, error: 'diagnostic_upload_artifact_not_found' };
        if (artifactStat.isSymbolicLink()) {
            return { available: false, error: 'diagnostic_upload_symlink_not_allowed' };
        }
        if (!artifactStat.isFile()) {
            return { available: false, error: 'diagnostic_upload_artifact_not_file' };
        }
        const artifactRealPath = await realpathOrNull(artifactPath);
        if (!artifactRealPath || !isPathInside(bundleRealPath, artifactRealPath)) {
            return { available: false, error: 'diagnostic_upload_path_outside_bundle_dir' };
        }
        if (artifactStat.size !== artifact.bytes) {
            return { available: false, error: 'diagnostic_upload_artifact_size_changed' };
        }
        if (files.length + 1 > MAX_UPLOAD_FILES + 1) {
            return { available: false, error: 'diagnostic_upload_too_many_files' };
        }
        totalBytes += artifactStat.size;
        if (totalBytes > MAX_UPLOAD_BYTES) {
            return { available: false, error: 'diagnostic_upload_too_large' };
        }
        files.push({
            name: diagnosticArchiveName(bundlePath, artifact.name),
            path: artifactPath,
        });
    }
    const result = await uploadLog(files);
    return {
        available: result.success,
        success: result.success,
        uploadId: result.uploadId,
        path: result.path,
        fileCount: files.length,
        bytes: totalBytes,
        ...(result.error ? { error: result.error } : {}),
    };
}
export function createElectronDiagnosticsProvider() {
    return { uploadDiagnosticBundle };
}
