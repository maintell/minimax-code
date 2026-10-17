import { constants } from "node:fs";
import { readFile, open, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import jszip from "jszip";
import { safePreviewDiagnosticV1, PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
import { discoverLibreOffice, runSofficeConversion } from "../libreoffice/runtime";
import { validateSanitizedSourceHandle, resolveSanitizedSourcePath, isSanitizedSourceHandle } from "../sanitized-source";
import { validateArtifactPathWithinWorkDir, ensureRealWorkDir } from "../artifact-path";
import { noopDocumentPreviewLogger } from "../logging";
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export let LIBREOFFICE_NATIVE_PPTX_MIME = PPTX_MIME;
const BACKEND_ID = 'libreoffice-native';
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
            backendId: BACKEND_ID,
        },
    };
}
async function countSlides(source) {
    try {
        if (!(await validateSanitizedSourceHandle(source)))
            return undefined;
        const sourcePath = resolveSanitizedSourcePath(source);
        if (!sourcePath)
            return undefined;
        const bytes = await readFile(sourcePath);
        const zip = await jszip.loadAsync(bytes, { checkCRC32: false });
        return (Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length ||
            undefined);
    }
    catch {
        return undefined;
    }
}
async function validatePdf(pathname, outputDir, maxBytes) {
    try {
        const validated = await validateArtifactPathWithinWorkDir(outputDir, pathname);
        if (!validated || validated.sizeBytes <= 5 || validated.sizeBytes > maxBytes) {
            return failure('artifact_invalid', 'LibreOffice produced an invalid PDF location');
        }
        const resolvedPath = path.resolve(pathname);
        const handle = await open(resolvedPath, fsNoFollowReadFlags());
        try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() ||
                opened.isSymbolicLink() ||
                opened.size <= 5n ||
                opened.size > BigInt(maxBytes) ||
                opened.size !== BigInt(validated.sizeBytes)) {
                return failure('artifact_invalid', 'LibreOffice PDF changed during validation');
            }
            const header = Buffer.alloc(5);
            await handle.read(header, 0, header.length, 0);
            if (header.toString('ascii') !== '%PDF-') {
                return failure('artifact_invalid', 'LibreOffice output is not a PDF');
            }
            const tailLength = Number(opened.size > 4096n ? 4096n : opened.size);
            const tail = Buffer.alloc(tailLength);
            await handle.read(tail, 0, tail.length, Number(opened.size) - tail.length);
            if (!tail.includes(Buffer.from('%%EOF'))) {
                return failure('artifact_invalid', 'LibreOffice output has no PDF trailer');
            }
        }
        finally {
            await handle.close().catch(() => undefined);
        }
        return { ok: true, value: { sizeBytes: validated.sizeBytes } };
    }
    catch {
        return failure('artifact_invalid', 'LibreOffice PDF output is missing');
    }
}
function fsNoFollowReadFlags() {
    return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}
const MAX_LOGGED_STDERR_CHARS = 2000;
/** Bound the captured converter stderr so a noisy child cannot flood the log. */
function boundedStderrTail(stderr) {
    if (!stderr)
        return undefined;
    return stderr.length > MAX_LOGGED_STDERR_CHARS ? stderr.slice(-MAX_LOGGED_STDERR_CHARS) : stderr;
}
/*
 * Kept as a separate helper so cleanup can use the same lexical containment
 * rule without ever recursively removing a path supplied by a backend.
 */
function isContained(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function cleanupDraft(outputDir, outputPath) {
    if (outputPath && isContained(outputDir, outputPath)) {
        await rm(outputPath, { force: true }).catch(() => undefined);
    }
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
}
async function verifyIntegrity(check) {
    if (typeof check !== 'function')
        return false;
    try {
        return await check();
    }
    catch {
        return false;
    }
}
function componentTuple(platform, arch) {
    if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'x64' && arch !== 'arm64')) {
        return null;
    }
    return { platform, arch };
}
function hostComponentTuple() {
    return componentTuple(process.platform, process.arch);
}
function unsupportedHostStatus() {
    return {
        backendId: BACKEND_ID,
        availability: 'unavailable',
        reason: 'unsupported_runtime_tuple',
        platform: process.platform,
        arch: process.arch,
    };
}
export function createLibreOfficeNativeBackend(options = {}) {
    const logger = options.logger ?? noopDocumentPreviewLogger;
    const discover = options.discover ??
        (async (discoveryOptions = {}) => {
            const candidatePlatform = discoveryOptions.platform ?? process.platform;
            const candidateArch = discoveryOptions.arch ?? process.arch;
            const tuple = componentTuple(candidatePlatform, candidateArch);
            const managedPath = tuple && options.componentManager
                ? await options.componentManager.resolveEntrypoint(tuple)
                : null;
            return discoverLibreOffice({
                ...options.discoveryOptions,
                ...discoveryOptions,
                ...(managedPath ? { managedPath } : {}),
            });
        });
    // Discovery is intentionally live.  Installing a managed component must
    // make the backend available on the very next preflight; caching a negative
    // probe here would force a restart or a hidden invalidation protocol.
    const resolveDiscovery = () => discover(options.discoveryOptions ?? {});
    const backend = {
        descriptor: {
            id: BACKEND_ID,
            version: 'native',
            inputMimeTypes: [PPTX_MIME],
            outputKinds: ['pdf.v1'],
            capabilities: ['high-fidelity-static', 'text-selection', 'search'],
        },
        async preflight(context) {
            if (!hostComponentTuple())
                return unsupportedHostStatus();
            if (context.source.mimeType !== PPTX_MIME ||
                !context.source.fileName.toLowerCase().endsWith('.pptx')) {
                return {
                    backendId: BACKEND_ID,
                    availability: 'unavailable',
                    reason: 'unsupported_input_type',
                    platform: process.platform,
                    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
                };
            }
            const result = await resolveDiscovery();
            if (result.availability !== 'available' &&
                options.componentManager &&
                (result.platform === 'darwin' || result.platform === 'win32') &&
                (result.arch === 'x64' || result.arch === 'arm64')) {
                const managed = await options.componentManager.status({
                    platform: result.platform,
                    arch: result.arch,
                });
                if (managed.ok && managed.value.availability === 'installable') {
                    return managed.value;
                }
            }
            return {
                backendId: BACKEND_ID,
                availability: result.availability,
                ...(result.version ? { version: result.version } : {}),
                ...(result.reason ? { reason: result.reason } : {}),
                platform: result.platform,
                arch: result.arch,
            };
        },
        async transform(context) {
            if (!hostComponentTuple()) {
                return failure('backend_unavailable', 'LibreOffice native preview is unsupported on this platform', true);
            }
            if (context.source.mimeType !== PPTX_MIME ||
                !context.source.fileName.toLowerCase().endsWith('.pptx')) {
                return failure('backend_unavailable', 'LibreOffice native backend accepts only PPTX');
            }
            if (context.signal.aborted)
                return failure('cancelled', 'Native preview was cancelled', true);
            if (!isSanitizedSourceHandle(context.sanitizedSource) ||
                context.sanitizedSource.sourceId !== context.source.sourceId ||
                context.sanitizedSource.contentSha256 !== context.source.contentSha256 ||
                !(await validateSanitizedSourceHandle(context.sanitizedSource))) {
                return failure('source_mutated', 'Preview source changed before native conversion');
            }
            if (!context.sourceIntegrity ||
                typeof context.sourceIntegrity.beforeTransform !== 'function' ||
                typeof context.sourceIntegrity.afterTransform !== 'function') {
                return failure('source_mutated', 'Native preview source integrity contract is unavailable');
            }
            const discovery = await resolveDiscovery();
            if (discovery.availability !== 'available' || !discovery.executablePath) {
                logger.warn({
                    msg: '[DocumentPreview][libreoffice-native] backend unavailable before conversion',
                    reason: discovery.reason ?? 'LibreOffice is unavailable',
                    platform: discovery.platform,
                    arch: discovery.arch,
                });
                return failure('backend_unavailable', discovery.reason ?? 'LibreOffice is unavailable', true);
            }
            const workDir = path.resolve(context.workDir);
            // The orchestrator owns this directory.  A backend may create files
            // inside it, but it must not redirect output through a symlinked
            // workspace or a caller-controlled relative path.
            await mkdir(workDir, { recursive: true, mode: 0o700 });
            if (!(await ensureRealWorkDir(workDir))) {
                return failure('artifact_invalid', 'Native preview transform workspace is not trusted');
            }
            const outputDir = path.join(workDir, 'native-output');
            await mkdir(outputDir, { recursive: true, mode: 0o700 });
            if (!(await ensureRealWorkDir(outputDir))) {
                return failure('artifact_invalid', 'Native preview output workspace is not trusted');
            }
            let conversion = null;
            let conversionStarted = false;
            let afterIntegrity = true;
            try {
                if (!(await verifyIntegrity(context.sourceIntegrity.beforeTransform))) {
                    return failure('source_mutated', 'Preview source changed before native conversion');
                }
                const remainingTimeoutMs = context.deadlineAtMs === undefined
                    ? context.request.policy.timeoutMs || PPTX_PREVIEW_LIMITS_V1.nativeConversionTimeoutMs
                    : context.deadlineAtMs - Date.now();
                if (remainingTimeoutMs <= 0) {
                    return failure('timeout', 'Document preview deadline elapsed before native conversion', true);
                }
                conversionStarted = true;
                conversion = await (options.runConversion ?? runSofficeConversion)({
                    executablePath: discovery.executablePath,
                    sanitizedSource: context.sanitizedSource,
                    outputDir,
                    signal: context.signal,
                    timeoutMs: Math.max(1, remainingTimeoutMs),
                    env: options.env,
                    platform: discovery.platform,
                    logger,
                });
            }
            catch (error) {
                conversion = {
                    ok: false,
                    profileDir: '',
                    outputPath: path.join(outputDir, 'unknown.pdf'),
                    exitCode: null,
                    signal: null,
                    stdout: '',
                    stderr: '',
                    aborted: context.signal.aborted,
                    timedOut: false,
                    reason: error instanceof Error ? error.message : 'conversion_failed',
                };
            }
            finally {
                if (conversionStarted) {
                    afterIntegrity = await verifyIntegrity(context.sourceIntegrity.afterTransform);
                }
            }
            // `runSofficeConversion` deliberately leaves its private job/profile
            // paths intact when whole-tree termination is unproven.  Propagate that
            // lifecycle fact before any ordinary draft cleanup can run; recursive
            // removal here could race a surviving descendant. The orchestrator's
            // callback quarantines this backend and retains the outer workDir too.
            const terminationUnproven = conversion?.ok === false && conversion.terminationProven === false;
            if (terminationUnproven)
                context.markUnboundedExecution?.();
            if (!afterIntegrity) {
                if (!terminationUnproven)
                    await cleanupDraft(outputDir, conversion?.outputPath);
                return failure('source_mutated', 'Preview source changed during native conversion');
            }
            if (!conversion) {
                await cleanupDraft(outputDir);
                logger.error({
                    msg: '[DocumentPreview][libreoffice-native] conversion did not start',
                    code: 'render_failed',
                });
                return failure('render_failed', 'Native preview conversion did not start', true);
            }
            if (!conversion.ok) {
                const conversionDetail = {
                    conversionReason: conversion.reason,
                    exitCode: conversion.exitCode,
                    signal: conversion.signal,
                    aborted: conversion.aborted,
                    timedOut: conversion.timedOut,
                    terminationProven: conversion.terminationProven ?? true,
                    stderrTail: boundedStderrTail(conversion.stderr),
                };
                if (terminationUnproven) {
                    logger.error({
                        msg: '[DocumentPreview][libreoffice-native] native process termination could not be proven; a soffice process may be orphaned',
                        code: 'backend_unavailable',
                        ...conversionDetail,
                    });
                    return failure('backend_unavailable', 'Native preview process termination could not be proven', true);
                }
                await cleanupDraft(outputDir, conversion.outputPath);
                if (conversion.aborted)
                    return failure('cancelled', 'Native preview was cancelled', true);
                if (conversion.timedOut)
                    return failure('timeout', 'LibreOffice conversion timed out', true);
                if (conversion.reason === 'pdf_invalid' ||
                    conversion.reason === 'pdf_missing' ||
                    conversion.reason === 'sanitized_job_input_invalid') {
                    logger.error({
                        msg: '[DocumentPreview][libreoffice-native] conversion produced an invalid PDF',
                        code: 'artifact_invalid',
                        ...conversionDetail,
                    });
                    return failure('artifact_invalid', 'LibreOffice output is not a valid PDF');
                }
                if (conversion.reason === 'sanitized_source_invalid' ||
                    conversion.reason === 'sanitized_source_mutated') {
                    return failure('source_mutated', 'Sanitized preview source changed during conversion');
                }
                logger.error({
                    msg: '[DocumentPreview][libreoffice-native] conversion failed',
                    code: 'render_failed',
                    ...conversionDetail,
                });
                return failure('render_failed', 'Native preview conversion failed', true);
            }
            const valid = await validatePdf(conversion.outputPath, outputDir, context.request.policy.maxArtifactBytes);
            if (!valid.ok) {
                await cleanupDraft(outputDir, conversion.outputPath);
                logger.error({
                    msg: '[DocumentPreview][libreoffice-native] converted PDF failed validation',
                    code: 'artifact_invalid',
                    exitCode: conversion.exitCode,
                    signal: conversion.signal,
                    stderrTail: boundedStderrTail(conversion.stderr),
                });
                return valid;
            }
            if (!(await validateSanitizedSourceHandle(context.sanitizedSource))) {
                await cleanupDraft(outputDir, conversion.outputPath);
                return failure('source_mutated', 'Sanitized preview source changed during conversion');
            }
            const slideCount = await countSlides(context.sanitizedSource);
            const draft = {
                backendId: BACKEND_ID,
                backendVersion: discovery.version ?? backend.descriptor.version,
                kind: 'pdf.v1',
                ...(slideCount ? { slideCount } : {}),
                resources: [
                    {
                        resourceId: 'document',
                        name: 'document.pdf',
                        mediaType: 'application/pdf',
                        absolutePath: conversion.outputPath,
                        sizeBytes: valid.value.sizeBytes,
                    },
                ],
                warnings: [],
            };
            return { ok: true, value: draft };
        },
    };
    backend.startTransform = (context) => {
        const result = backend.transform(context);
        return {
            result,
            // The orchestrator aborts this signal before requesting settlement.
            // The converter owns process-tree termination and resolves only after
            // its child execution and private profile cleanup are complete.
            terminateAndWait: async () => {
                await result.then(() => undefined, () => undefined);
            },
        };
    };
    return backend;
}
export let createNativeLibreOfficeBackend = createLibreOfficeNativeBackend;
