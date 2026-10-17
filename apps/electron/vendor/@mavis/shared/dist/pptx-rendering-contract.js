import {} from './pptx-diagnostic-policy.generated.js';
import { PPTX_PREVIEW_LIMITS_V1, PPTX_PREVIEW_LIMITS_VERSION_V1, } from './pptx-preview-limits.generated.js';
export { PPTX_DIAGNOSTIC_POLICY_BY_CODE_V1, PPTX_DIAGNOSTIC_POLICY_SCHEMA_V1, PPTX_DIAGNOSTIC_POLICY_V1, PPTX_DIAGNOSTIC_POLICY_VERSION_V1, } from './pptx-diagnostic-policy.generated.js';
export { PPTX_PREVIEW_LIMITS_V1, PPTX_PREVIEW_LIMITS_VERSION_V1, } from './pptx-preview-limits.generated.js';
export const PPTX_CORE_SESSION_SCHEMA_V1 = 'mavis.pptx_core_session.v1';
export const PPTX_CORE_STREAM_SCHEMA_V1 = 'mavis.pptx_core_source_stream.v1';
export const PPTX_CORE_RENDERER_PORT_EVENT_V1 = 'mavis:pptx-core-port:v1';
export const SAFE_PACKAGE_HANDLE_SCHEMA_V1 = 'mavis.safe_package_handle.v1';
export const PPTX_DECK_SUMMARY_SCHEMA_V1 = 'mavis.pptx_deck_summary.v1';
export const PPTX_SLIDE_RENDER_SCHEMA_V1 = 'mavis.pptx_slide_render.v1';
export const PPTX_DIAGNOSTIC_REPORT_SCHEMA_V1 = 'mavis.pptx_diagnostic_report.v1';
export const PPTX_SLIDE_NOTES_SCHEMA_V1 = 'mavis.pptx_slide_notes_read_model.v1';
export const PPTX_TEXT_SEARCH_SCHEMA_V1 = 'mavis.pptx_text_search_result.v1';
export const PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V1 = 'mavis.pptx_slide_selection_model.v1';
export const PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V2 = 'mavis.pptx_slide_selection_model.v2';
export const PPTX_SELECTION_RESOURCE_SCHEMA_V1 = 'mavis.pptx_selection_resource.v1';
export const PPTX_RENDER_RESOURCE_SCHEMA_V1 = 'mavis.pptx_render_resource.v1';
export const PPTX_SLIDE_ANIMATION_SCHEMA_V1 = 'mavis.pptx_slide_animation.v1';
export const PPTX_ANIMATION_EVALUATION_SCHEMA_V1 = 'mavis.pptx_animation_evaluation_wire.v1';
export const PPTX_TRANSITION_EVALUATION_SCHEMA_V1 = 'mavis.pptx_transition_evaluation.v1';
export const PPTX_CORE_STREAM_CHUNK_BYTES_V1 = 4 * 1024 * 1024;
export const PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1 = 2;
/** Complete ECMA-376 ST_PresetPatternVal inventory accepted by the core and painter. */
export const PPTX_PATTERN_PRESETS_V1 = Object.freeze([
    'pct5',
    'pct10',
    'pct20',
    'pct25',
    'pct30',
    'pct40',
    'pct50',
    'pct60',
    'pct70',
    'pct75',
    'pct80',
    'pct90',
    'horz',
    'vert',
    'ltHorz',
    'ltVert',
    'dkHorz',
    'dkVert',
    'narHorz',
    'narVert',
    'dashHorz',
    'dashVert',
    'cross',
    'dnDiag',
    'upDiag',
    'ltDnDiag',
    'ltUpDiag',
    'dkDnDiag',
    'dkUpDiag',
    'wdDnDiag',
    'wdUpDiag',
    'dashDnDiag',
    'dashUpDiag',
    'diagCross',
    'smCheck',
    'lgCheck',
    'smGrid',
    'lgGrid',
    'dotGrid',
    'smConfetti',
    'lgConfetti',
    'horzBrick',
    'diagBrick',
    'solidDmnd',
    'openDmnd',
    'dotDmnd',
    'plaid',
    'sphere',
    'weave',
    'divot',
    'shingle',
    'wave',
    'trellis',
    'zigZag',
]);
export const PPTX_RENDER_WIRE_LIMITS_V1 = Object.freeze({
    maxNodes: 10_000,
    maxWireBytes: 16 * 1024 * 1024,
    maxPathCommands: 100_000,
    maxGlyphs: 100_000,
    maxResources: 2_048,
    maxGradientStops: 64,
    maxClipDepth: 32,
    maxResourceBytes: 64 * 1024 * 1024,
});
export function isSafePptxHyperlinkUrlV1(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 4096 ||
        /[\u0000-\u0020\u007f]/u.test(value))
        return false;
    try {
        const url = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=pptx-rendering-contract.js.map