import { dotnet } from './_framework/dotnet.js';
import {
  createPptxCoreDocumentSessionFromSourceGraph,
  loadBundledFontRuntimeV1,
  pptxErrorTraceV1,
  SourceGraphBatchDecoderV1,
} from './pptx-core-host.js';

const STREAM_SCHEMA = 'mavis.pptx_core_source_stream.v1';
const SESSION_SCHEMA = 'mavis.pptx_core_session.v1';
let assemblyExports;
let startupError;
let descriptor;
let expectedSequence = 0;
let totalBytes = 0;
let chunks = [];
let terminal = false;
let activeImportRequestId;
let documentSession;
const cancelledRequestIds = new Set();

function logPerformanceStage(stage, startedAt, counts = {}) {
  console.info('[PPTX Core][performance]', JSON.stringify({
    stage,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    ...counts,
  }));
}

try {
  const startedAt = performance.now();
  const runtime = await dotnet.create();
  const config = runtime.getConfig();
  assemblyExports = await runtime.getAssemblyExports(config.mainAssemblyName);
  logPerformanceStage('runtime-startup', startedAt);
  self.postMessage({
    kind: 'runtime-ready',
    runtimeInfo: JSON.parse(assemblyExports.PptxImporterExports.GetRuntimeInfo()),
  });
} catch (error) {
  startupError =
    error instanceof Error ? error.message : 'The PPTX importer runtime failed to start';
  self.postMessage({ kind: 'runtime-failed', error: startupError });
}

function capability() {
  if (!descriptor) throw new Error('The PPTX importer session is not initialized');
  return {
    schema: descriptor.schema,
    coreSessionId: descriptor.coreSessionId,
    nonce: descriptor.nonce,
  };
}

function portMessage(message) {
  self.postMessage({ kind: 'port-message', capability: capability(), message });
}

// SafeOpcException exposes one fixed message per SafeOpcErrorCode.
const SAFE_OPC_DETAILS = [
  ['The document archive is invalid', 'safe_opc_invalid'],
  ['The document exceeds the preview resource limit', 'safe_opc_limit'],
  ['The document uses an unsupported package feature', 'safe_opc_unsupported'],
];

// SafeOpcException.Unsupported(feature) appends one fixed snake_case feature name.
const SAFE_OPC_UNSUPPORTED_FEATURES = new Set([
  'ambiguous_data_descriptor',
  'compression_method',
  'embedded_binary_part',
  'multi_disk',
  'zip64_data_descriptor',
  'zip64_offset',
]);

function importFailureDetail(stage, error) {
  if (stage !== 'package_import') return stage;
  const message = error instanceof Error ? error.message : '';
  const detail = SAFE_OPC_DETAILS.find(([text]) => message.includes(text))?.[1] ?? 'importer_error';
  if (detail !== 'safe_opc_unsupported') return detail;
  const feature = message.match(/unsupported package feature \(([a-z0-9_]+)\)/u)?.[1];
  return feature && SAFE_OPC_UNSUPPORTED_FEATURES.has(feature)
    ? `safe_opc_unsupported_${feature}`
    : detail;
}

/** Sanitized frames only: bundle basenames, positions and code identifiers, never the message. */
function errorTrace(error) {
  const trace = pptxErrorTraceV1(error);
  return trace.length > 0 ? { trace } : {};
}

function fail(code, message, detail, cause) {
  if (terminal) return;
  terminal = true;
  chunks = [];
  if (activeImportRequestId && assemblyExports) {
    const requestId = activeImportRequestId;
    activeImportRequestId = undefined;
    assemblyExports.PptxImporterExports.Cancel(requestId);
    void assemblyExports.PptxImporterExports.Release(requestId);
  }
  documentSession?.dispose();
  documentSession = undefined;
  if (descriptor) {
    portMessage({
      schema: STREAM_SCHEMA,
      kind: 'abort',
      coreSessionId: descriptor.coreSessionId,
      nonce: descriptor.nonce,
      sequence: expectedSequence,
      reason:
        code === 'source_mutated'
          ? 'source_mutated'
          : code === 'cancelled'
            ? 'cancelled'
            : 'invalid_protocol',
    });
  }
  self.postMessage({
    kind: 'failed',
    error: {
      schema: 'mavis.preview_error.v1',
      code,
      message,
      retryable: false,
      ...(detail ? { detail } : {}),
      ...(cause === undefined ? {} : errorTrace(cause)),
    },
  });
}

function isDescriptor(value) {
  return (
    value &&
    value.schema === SESSION_SCHEMA &&
    typeof value.coreSessionId === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.sourceSha256 === 'string' &&
    Number.isSafeInteger(value.sourceSizeBytes) &&
    value.sourceSizeBytes >= 0
  );
}

function isBoundStreamMessage(input) {
  const message = input?.message;
  return (
    descriptor &&
    input?.capability?.coreSessionId === descriptor.coreSessionId &&
    input?.capability?.nonce === descriptor.nonce &&
    message?.schema === STREAM_SCHEMA &&
    message.coreSessionId === descriptor.coreSessionId &&
    message.nonce === descriptor.nonce &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence >= 0
  );
}

function slideTerminalOutcome(error, requestedSlideIndex) {
  if (
    !error ||
    error.name !== 'PptxSlideStageTerminalErrorV1' ||
    error.slideIndex !== requestedSlideIndex ||
    !Array.isArray(error.diagnosticCodes) ||
    error.diagnosticCodes.length === 0
  ) {
    return null;
  }
  return {
    kind: 'slide-terminal',
    slideIndex: requestedSlideIndex,
    diagnosticCodes: [...new Set(error.diagnosticCodes)].sort(),
    ...(Array.isArray(error.diagnosticReasons)
      ? { diagnosticReasons: error.diagnosticReasons.map(terminalReason) }
      : {}),
    ...(Array.isArray(error.errorTrace) && error.errorTrace.length > 0
      ? { errorTrace: [...error.errorTrace] }
      : {}),
  };
}

function terminalReason({ code, reason, nodeKind, nodeProfile, count }) {
  return { code, reason, nodeKind, ...(nodeProfile ? { nodeProfile } : {}), count };
}

async function importSource(sourceSha256, sourceSizeBytes) {
  if (!assemblyExports) {
    fail(
      'backend_unavailable',
      startupError || 'The PPTX importer runtime is unavailable',
      'runtime_boot_failed',
    );
    return;
  }
  if (!descriptor || totalBytes !== sourceSizeBytes || totalBytes !== descriptor.sourceSizeBytes) {
    fail('source_mutated', 'The document changed while it was being previewed');
    return;
  }
  if (sourceSha256 !== descriptor.sourceSha256) {
    fail('source_mutated', 'The document changed while it was being previewed');
    return;
  }
  const source = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks = [];
  activeImportRequestId = descriptor.coreSessionId;
  let failureCode = 'invalid_source_archive';
  let failureStage = 'package_import';
  try {
    let stageStartedAt = performance.now();
    const manifestJson = await assemblyExports.PptxImporterExports.BeginImportPptx(
      source,
      descriptor.sourceSha256,
      activeImportRequestId,
    );
    logPerformanceStage('import-total', stageStartedAt);
    if (terminal) return;
    stageStartedAt = performance.now();
    failureCode = 'transform_failed';
    failureStage = 'source_graph_decode';
    const manifest = JSON.parse(manifestJson);
    const decoder = new SourceGraphBatchDecoderV1(manifest);
    for (let sequence = 0; sequence < manifest.batchCount; sequence += 1) {
      if (terminal) return;
      await decoder.append(
        assemblyExports.PptxImporterExports.ReadImportBatch(activeImportRequestId, sequence),
      );
    }
    const graph = decoder.finish();
    logPerformanceStage('batch-decode', stageStartedAt, {
      batchCount: manifest.batchCount,
      rowCount: manifest.totalRows,
    });
    stageStartedAt = performance.now();
    failureCode = 'component_unavailable';
    failureStage = 'font_runtime';
    const fontRuntime = await loadBundledFontRuntimeV1(new URL('./', import.meta.url));
    logPerformanceStage('font-runtime', stageStartedAt);
    stageStartedAt = performance.now();
    failureCode = 'transform_failed';
    failureStage = 'document_model';
    documentSession = await createPptxCoreDocumentSessionFromSourceGraph(graph, {
      fontRuntime,
      numberFormatLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
      onSlideLayout: (slideIndex, slide) => {
        if (terminal || !documentSession) return;
        self.postMessage({
          kind: 'slide-layout-ready',
          revision: documentSession.summary.revision,
          slideIndex,
          slide,
        });
      },
      onFatalLayoutError: () =>
        fail('source_mutated', 'The document changed while it was being previewed'),
      readRawPart: async (rawHandle) => {
        await assemblyExports.PptxImporterExports.MaterializeRawPart(
          activeImportRequestId,
          rawHandle,
        );
        return new Uint8Array(
          assemblyExports.PptxImporterExports.ReadRawPart(activeImportRequestId, rawHandle),
        );
      },
    });
    logPerformanceStage('document-model', stageStartedAt, {
      slideCount: documentSession.summary.slideCount,
    });
    self.postMessage({
      kind: 'document-ready',
      sourceSizeBytes,
      sourceSha256,
      summary: documentSession.summary,
    });
  } catch (error) {
    fail(
      failureCode,
      error instanceof Error ? error.message : 'PPTX processing failed',
      importFailureDetail(failureStage, error),
      error,
    );
  }
}

self.addEventListener('message', async (event) => {
  const input = event.data;
  if (!input || typeof input !== 'object' || typeof input.kind !== 'string') {
    fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
    return;
  }
  if (input.kind === 'init') {
    if (descriptor || terminal || !isDescriptor(input.descriptor)) {
      fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
      return;
    }
    descriptor = input.descriptor;
    return;
  }
  if (input.kind === 'cancel') {
    fail('cancelled', 'Document preview was cancelled');
    return;
  }
  if (input.kind === 'cancel-request') {
    if (typeof input.requestId === 'string') cancelledRequestIds.add(input.requestId);
    return;
  }
  if (input.kind === 'render-slide') {
    if (
      terminal ||
      !documentSession ||
      input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' ||
      !Number.isSafeInteger(input.slideIndex) ||
      input.slideIndex < 0 ||
      input.slideIndex >= documentSession.summary.slideCount
    ) {
      fail('invalid_source_archive', 'The slide render request is invalid', 'request_invalid');
      return;
    }
    try {
      const render = await documentSession.renderSlide(input.slideIndex);
      let telemetry;
      try {
        telemetry = documentSession.slideTelemetry(render);
      } catch {
        /* Observations are optional. */
      }
      if (render.tree.capability === 'unsupported-terminal') {
        const diagnosticCodes = render.tree.diagnostics
          .filter((diagnostic) => diagnostic.disposition === 'slide-terminal')
          .map((diagnostic) => diagnostic.code);
        let diagnosticReasons = [];
        try {
          diagnosticReasons = documentSession.slideTerminalReasons(render.tree.diagnostics);
        } catch {
          /* Observations are optional. */
        }
        const terminalTrace = telemetry?.diagnostics.find(
          (diagnostic) =>
            diagnostic.disposition === 'slide-terminal' && Array.isArray(diagnostic.errorTrace),
        )?.errorTrace;
        self.postMessage({
          kind: 'slide-outcome',
          requestId: input.requestId,
          outcome: {
            kind: 'slide-terminal',
            slideIndex: input.slideIndex,
            diagnosticCodes:
              diagnosticCodes.length > 0
                ? [...new Set(diagnosticCodes)].sort()
                : ['PPTX-S05-SLIDE-RENDER-TERMINAL'],
            ...(diagnosticReasons.length > 0
              ? { diagnosticReasons: diagnosticReasons.map(terminalReason) }
              : {}),
            ...(terminalTrace ? { errorTrace: [...terminalTrace] } : {}),
          },
        });
        return;
      }
      self.postMessage({
        kind: 'slide-outcome',
        requestId: input.requestId,
        outcome: { kind: 'rendered', page: render },
        ...(telemetry ? { telemetry } : {}),
      });
    } catch (error) {
      const outcome = slideTerminalOutcome(error, input.slideIndex);
      if (outcome) {
        self.postMessage({ kind: 'slide-outcome', requestId: input.requestId, outcome });
        return;
      }
      self.postMessage({
        kind: 'render-failed',
        requestId: input.requestId,
        error: {
          schema: 'mavis.preview_error.v1',
          code: 'invalid_source_archive',
          message: error instanceof Error ? error.message : 'Slide render failed',
          retryable: false,
          ...errorTrace(error),
        },
      });
    }
    return;
  }
  if (input.kind === 'request-diagnostics') {
    if (
      terminal ||
      !documentSession ||
      input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string'
    ) {
      fail('invalid_source_archive', 'The diagnostics request is invalid', 'request_invalid');
      return;
    }
    try {
      self.postMessage({
        kind: 'diagnostic-report',
        requestId: input.requestId,
        report: documentSession.requestDiagnostics(),
      });
    } catch (error) {
      self.postMessage({
        kind: 'render-failed',
        requestId: input.requestId,
        error: {
          schema: 'mavis.preview_error.v1',
          code: 'render_failed',
          message: error instanceof Error ? error.message : 'Diagnostic report failed',
          retryable: false,
          ...errorTrace(error),
        },
      });
    }
    return;
  }
  if (input.kind === 'render-resource') {
    if (
      terminal ||
      !documentSession ||
      input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' ||
      typeof input.renderHash !== 'string' ||
      typeof input.resourceId !== 'string'
    ) {
      fail('invalid_source_archive', 'The render resource request is invalid', 'request_invalid');
      return;
    }
    try {
      const resource = await documentSession.readRenderResource(input.renderHash, input.resourceId);
      self.postMessage({ kind: 'render-resource', requestId: input.requestId, resource }, [
        resource.bytes,
      ]);
    } catch (error) {
      self.postMessage({
        kind: 'render-failed',
        requestId: input.requestId,
        error: {
          schema: 'mavis.preview_error.v1',
          code: 'invalid_source_archive',
          message: error instanceof Error ? error.message : 'Render resource failed',
          retryable: false,
          ...errorTrace(error),
        },
      });
    }
    return;
  }
  if (input.kind === 'get-slide-animation') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || !Number.isSafeInteger(input.slideIndex) ||
      input.slideIndex < 0 || input.slideIndex >= documentSession.summary.slideCount
    ) {
      fail('invalid_source_archive', 'The slide animation request is invalid', 'request_invalid');
      return;
    }
    try {
      const animation = await documentSession.getSlideAnimation(input.slideIndex);
      self.postMessage({ kind: 'slide-animation', requestId: input.requestId, animation });
    } catch (error) {
      self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
        schema: 'mavis.preview_error.v1', code: 'invalid_source_archive',
        message: error instanceof Error ? error.message : 'Slide animation compilation failed', retryable: false, ...errorTrace(error),
      } });
    }
    return;
  }
  if (input.kind === 'get-slide-notes') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || typeof input.slideId !== 'string' ||
      !documentSession.summary.slides.some((slide) => slide.nodeId === input.slideId)
    ) {
      fail('invalid_source_archive', 'The slide notes request is invalid', 'request_invalid');
      return;
    }
    try {
      const notes = await documentSession.getSlideNotes(input.slideId, input.revision);
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'slide-notes', requestId: input.requestId, notes });
      }
    } catch (error) {
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
          schema: 'mavis.preview_error.v1', code: 'render_failed',
          message: error instanceof Error ? error.message : 'Slide notes read failed', retryable: false, ...errorTrace(error),
        } });
      }
    }
    return;
  }
  if (input.kind === 'search-text') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || typeof input.query !== 'string'
    ) {
      fail('invalid_source_archive', 'The text search request is invalid', 'request_invalid');
      return;
    }
    try {
      const result = await documentSession.searchText(input.query, input.revision);
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'text-search-result', requestId: input.requestId, result });
      }
    } catch (error) {
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
          schema: 'mavis.preview_error.v1', code: 'render_failed',
          message: error instanceof Error ? error.message : 'Text search failed', retryable: false, ...errorTrace(error),
        } });
      }
    }
    return;
  }
  if (input.kind === 'get-slide-selection-model') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || !Number.isSafeInteger(input.slideIndex) ||
      input.slideIndex < 0 || input.slideIndex >= documentSession.summary.slideCount
    ) {
      fail('invalid_source_archive', 'The slide selection request is invalid', 'request_invalid');
      return;
    }
    try {
      const model = await documentSession.getSlideSelectionModel(input.slideIndex, input.revision);
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'slide-selection-model', requestId: input.requestId, model });
      }
    } catch (error) {
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
          schema: 'mavis.preview_error.v1', code: 'render_failed',
          message: error instanceof Error ? error.message : 'Slide selection model failed', retryable: false, ...errorTrace(error),
        } });
      }
    }
    return;
  }
  if (input.kind === 'selection-resource') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || typeof input.resourceId !== 'string'
    ) {
      fail('invalid_source_archive', 'The selection resource request is invalid', 'request_invalid');
      return;
    }
    try {
      const resource = await documentSession.readSelectionResource(input.resourceId, input.revision);
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'selection-resource', requestId: input.requestId, resource }, [
          resource.bytes,
        ]);
      }
    } catch (error) {
      if (!cancelledRequestIds.delete(input.requestId)) {
        self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
          schema: 'mavis.preview_error.v1', code: 'render_failed',
          message: error instanceof Error ? error.message : 'Selection resource failed', retryable: false, ...errorTrace(error),
        } });
      }
    }
    return;
  }
  if (input.kind === 'evaluate-animation') {
    const eventLog = input.eventLog;
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || !Number.isSafeInteger(input.slideIndex) ||
      input.slideIndex < 0 || input.slideIndex >= documentSession.summary.slideCount ||
      typeof input.baseRenderHash !== 'string' || !Number.isSafeInteger(input.logicalTimeMs) ||
      input.logicalTimeMs < 0 || !Number.isSafeInteger(input.generation) || input.generation < 0 ||
      !eventLog || eventLog.schema !== 'mavis.pptx_playback_event_log.v1' ||
      eventLog.slideEnteredAtMs !== 0 || !Array.isArray(eventLog.events) || eventLog.events.length > 100000
    ) {
      fail('invalid_source_archive', 'The animation evaluation request is invalid', 'request_invalid');
      return;
    }
    try {
      const evaluation = await documentSession.evaluateSlideAnimation(
        input.slideIndex, input.baseRenderHash, eventLog, input.logicalTimeMs, input.generation,
      );
      self.postMessage({ kind: 'animation-evaluation', requestId: input.requestId, evaluation });
    } catch (error) {
      self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
        schema: 'mavis.preview_error.v1', code: 'render_failed',
        message: error instanceof Error ? error.message : 'Animation evaluation failed', retryable: false, ...errorTrace(error),
      } });
    }
    return;
  }
  if (input.kind === 'evaluate-transition') {
    if (
      terminal || !documentSession || input.revision !== documentSession.summary.revision ||
      typeof input.requestId !== 'string' || !Number.isSafeInteger(input.fromSlideIndex) ||
      !Number.isSafeInteger(input.toSlideIndex) || !Number.isSafeInteger(input.logicalTimeMs) ||
      input.logicalTimeMs < 0 || !input.surfaces || typeof input.surfaces !== 'object'
    ) {
      fail('invalid_source_archive', 'The transition evaluation request is invalid', 'request_invalid');
      return;
    }
    try {
      const evaluation = await documentSession.evaluateSlideTransition(
        input.fromSlideIndex, input.toSlideIndex, input.logicalTimeMs, input.surfaces,
      );
      self.postMessage({ kind: evaluation ? 'transition-evaluation' : 'transition-none', requestId: input.requestId, evaluation });
    } catch (error) {
      self.postMessage({ kind: 'render-failed', requestId: input.requestId, error: {
        schema: 'mavis.preview_error.v1', code: 'render_failed',
        message: error instanceof Error ? error.message : 'Transition evaluation failed', retryable: false, ...errorTrace(error),
      } });
    }
    return;
  }
  if (!descriptor || terminal || documentSession || !isBoundStreamMessage(input)) {
    fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
    return;
  }
  const message = input.message;
  if (message.kind === 'abort') {
    fail(
      message.reason === 'source_mutated' ? 'source_mutated' : 'cancelled',
      message.reason === 'source_mutated'
        ? 'The document changed while it was being previewed'
        : 'Document preview was cancelled',
    );
    return;
  }
  if (message.kind === 'hello') {
    if (
      expectedSequence !== 0 ||
      message.sequence !== 0 ||
      message.sourceGeneration !== descriptor.sourceGeneration ||
      message.sourceSha256 !== descriptor.sourceSha256 ||
      message.sourceSizeBytes !== descriptor.sourceSizeBytes ||
      message.limitsVersion !== descriptor.limitsVersion
    ) {
      fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
      return;
    }
    expectedSequence = 1;
    return;
  }
  if (message.sequence !== expectedSequence) {
    fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
    return;
  }
  if (message.kind === 'chunk') {
    if (
      !(message.bytes instanceof ArrayBuffer) ||
      message.offset !== totalBytes ||
      totalBytes + message.bytes.byteLength > descriptor.sourceSizeBytes
    ) {
      fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
      return;
    }
    chunks.push(new Uint8Array(message.bytes).slice());
    totalBytes += message.bytes.byteLength;
    expectedSequence += 1;
    portMessage({
      schema: STREAM_SCHEMA,
      kind: 'ack',
      coreSessionId: descriptor.coreSessionId,
      nonce: descriptor.nonce,
      sequence: message.sequence,
    });
    return;
  }
  if (message.kind === 'end') {
    expectedSequence += 1;
    void importSource(message.sourceSha256, message.totalBytes);
    return;
  }
  fail('invalid_source_archive', 'The document archive is invalid', 'protocol_invalid');
});
