import { sanitizeOoxmlForPreview } from "./ooxml-sanitizer";
import { createDocumentPreviewBackendRegistry } from "./index";
import { createLibreOfficeNativeBackend } from "./backends/libreoffice-native-backend";
import { OfficeComponentManager } from "./components/component-manager";
import { sharedDocumentPreviewArtifactStore } from "./artifact-store";
import { DocumentPreviewSourceRegistry } from "./source-registry";
/**
 * Composition root for the process-wide document-preview dependencies.
 * Keeping this separate from IPC lets other main-process adapters (for
 * example PPT QuickLook) share the source registry without importing an IPC
 * module and accidentally coupling handler registration to their setup.
 */
export let documentPreviewSourceRegistry = new DocumentPreviewSourceRegistry();
export let documentPreviewArtifactStore = sharedDocumentPreviewArtifactStore;
export let documentPreviewComponentManager = new OfficeComponentManager();
export let documentPreviewBackendRegistry = createDocumentPreviewBackendRegistry([
    createLibreOfficeNativeBackend({ componentManager: documentPreviewComponentManager }),
]);
export let documentPreviewSanitizer = sanitizeOoxmlForPreview;
/**
 * Binds the OOXML sanitizer to a main-process logger so the worker's
 * pre-result error/exit detail is captured before the renderer receives the
 * stable redacted failure. The default export stays logger-free for callers
 * (and tests) that do not inject one.
 */
export function createDocumentPreviewSanitizer(logger) {
    return (bytes, signal, options) => sanitizeOoxmlForPreview(bytes, signal, options, logger);
}
/**
 * Builds a logger-aware managed component manager. Only used by production
 * wiring; the shared `documentPreviewComponentManager` singleton stays the
 * default when no logger is injected.
 */
export function createDocumentPreviewComponentManager(logger) {
    return new OfficeComponentManager(logger ? { logger } : {});
}
/** Builds a logger-aware native backend registry for production wiring. */
export function createDocumentPreviewBackendRegistryWithLogger(componentManager, logger) {
    return createDocumentPreviewBackendRegistry([
        createLibreOfficeNativeBackend({
            componentManager,
            ...(logger ? { logger } : {}),
        }),
    ]);
}
