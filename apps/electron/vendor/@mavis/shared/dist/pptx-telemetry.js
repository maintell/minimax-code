/**
 * Fixed vocabularies for PPTX preview telemetry. Every value is an ECMA-376
 * enumeration, a code-owned bucket or a bundle frame; authored text, names,
 * paths and bytes never pass these checks.
 */
const GEOMETRY_PRESETS_V1 = new Set([
    'line',
    'lineInv',
    'triangle',
    'rtTriangle',
    'rect',
    'diamond',
    'parallelogram',
    'trapezoid',
    'nonIsoscelesTrapezoid',
    'pentagon',
    'hexagon',
    'heptagon',
    'octagon',
    'decagon',
    'dodecagon',
    'star4',
    'star5',
    'star6',
    'star7',
    'star8',
    'star10',
    'star12',
    'star16',
    'star24',
    'star32',
    'roundRect',
    'round1Rect',
    'round2SameRect',
    'round2DiagRect',
    'snipRoundRect',
    'snip1Rect',
    'snip2SameRect',
    'snip2DiagRect',
    'plaque',
    'ellipse',
    'teardrop',
    'homePlate',
    'chevron',
    'pieWedge',
    'pie',
    'blockArc',
    'donut',
    'noSmoking',
    'rightArrow',
    'leftArrow',
    'upArrow',
    'downArrow',
    'stripedRightArrow',
    'notchedRightArrow',
    'bentUpArrow',
    'leftRightArrow',
    'upDownArrow',
    'leftUpArrow',
    'leftRightUpArrow',
    'quadArrow',
    'leftArrowCallout',
    'rightArrowCallout',
    'upArrowCallout',
    'downArrowCallout',
    'leftRightArrowCallout',
    'upDownArrowCallout',
    'quadArrowCallout',
    'bentArrow',
    'uturnArrow',
    'circularArrow',
    'leftCircularArrow',
    'leftRightCircularArrow',
    'curvedRightArrow',
    'curvedLeftArrow',
    'curvedUpArrow',
    'curvedDownArrow',
    'swooshArrow',
    'cube',
    'can',
    'lightningBolt',
    'heart',
    'sun',
    'moon',
    'smileyFace',
    'irregularSeal1',
    'irregularSeal2',
    'foldedCorner',
    'bevel',
    'frame',
    'halfFrame',
    'corner',
    'diagStripe',
    'chord',
    'arc',
    'leftBracket',
    'rightBracket',
    'leftBrace',
    'rightBrace',
    'bracketPair',
    'bracePair',
    'straightConnector1',
    'bentConnector2',
    'bentConnector3',
    'bentConnector4',
    'bentConnector5',
    'curvedConnector2',
    'curvedConnector3',
    'curvedConnector4',
    'curvedConnector5',
    'callout1',
    'callout2',
    'callout3',
    'accentCallout1',
    'accentCallout2',
    'accentCallout3',
    'borderCallout1',
    'borderCallout2',
    'borderCallout3',
    'accentBorderCallout1',
    'accentBorderCallout2',
    'accentBorderCallout3',
    'wedgeRectCallout',
    'wedgeRoundRectCallout',
    'wedgeEllipseCallout',
    'cloudCallout',
    'cloud',
    'ribbon',
    'ribbon2',
    'ellipseRibbon',
    'ellipseRibbon2',
    'leftRightRibbon',
    'verticalScroll',
    'horizontalScroll',
    'wave',
    'doubleWave',
    'plus',
    'flowChartProcess',
    'flowChartDecision',
    'flowChartInputOutput',
    'flowChartPredefinedProcess',
    'flowChartInternalStorage',
    'flowChartDocument',
    'flowChartMultidocument',
    'flowChartTerminator',
    'flowChartPreparation',
    'flowChartManualInput',
    'flowChartManualOperation',
    'flowChartConnector',
    'flowChartPunchedCard',
    'flowChartPunchedTape',
    'flowChartSummingJunction',
    'flowChartOr',
    'flowChartCollate',
    'flowChartSort',
    'flowChartExtract',
    'flowChartMerge',
    'flowChartOfflineStorage',
    'flowChartOnlineStorage',
    'flowChartMagneticTape',
    'flowChartMagneticDisk',
    'flowChartMagneticDrum',
    'flowChartDisplay',
    'flowChartDelay',
    'flowChartAlternateProcess',
    'flowChartOffpageConnector',
    'actionButtonBlank',
    'actionButtonHome',
    'actionButtonHelp',
    'actionButtonInformation',
    'actionButtonForwardNext',
    'actionButtonBackPrevious',
    'actionButtonEnd',
    'actionButtonBeginning',
    'actionButtonReturn',
    'actionButtonDocument',
    'actionButtonSound',
    'actionButtonMovie',
    'gear6',
    'gear9',
    'funnel',
    'mathPlus',
    'mathMinus',
    'mathMultiply',
    'mathDivide',
    'mathEqual',
    'mathNotEqual',
    'cornerTabs',
    'squareTabs',
    'plaqueTabs',
    'chartX',
    'chartStar',
    'chartPlus',
    'custom',
    'none',
]);
const TEXT_WARP_PRESETS_V1 = new Set([
    'none',
    'textNoShape',
    'textPlain',
    'textStop',
    'textTriangle',
    'textTriangleInverted',
    'textChevron',
    'textChevronInverted',
    'textRingInside',
    'textRingOutside',
    'textArchUp',
    'textArchDown',
    'textCircle',
    'textButton',
    'textArchUpPour',
    'textArchDownPour',
    'textCirclePour',
    'textButtonPour',
    'textCurveUp',
    'textCurveDown',
    'textCanUp',
    'textCanDown',
    'textWave1',
    'textWave2',
    'textDoubleWave1',
    'textWave4',
    'textInflate',
    'textDeflate',
    'textInflateBottom',
    'textDeflateBottom',
    'textInflateTop',
    'textDeflateTop',
    'textDeflateInflate',
    'textDeflateInflateDeflate',
    'textFadeRight',
    'textFadeLeft',
    'textFadeUp',
    'textFadeDown',
    'textSlantUp',
    'textSlantDown',
    'textCascadeUp',
    'textCascadeDown',
]);
const CHART_PLOT_KINDS_V1 = new Set([
    'areaChart',
    'area3DChart',
    'lineChart',
    'line3DChart',
    'stockChart',
    'radarChart',
    'scatterChart',
    'pieChart',
    'pie3DChart',
    'doughnutChart',
    'barChart',
    'bar3DChart',
    'ofPieChart',
    'surfaceChart',
    'surface3DChart',
    'bubbleChart',
    'funnel',
    'sunburst',
    'clusteredColumn',
    'paretoLine',
    'boxWhisker',
    'treemap',
    'waterfall',
    'regionMap',
]);
const TEXT_SCRIPTS_V1 = new Set([
    'Latn',
    'Hani',
    'Hira',
    'Kana',
    'Hang',
    'Arab',
    'Hebr',
    'Cyrl',
    'Grek',
    'Thai',
    'Deva',
    'Zsye',
    'Zzzz',
]);
const YES_NO = new Set(['yes', 'no']);
const FILL_KINDS = new Set(['none', 'solid', 'gradient', 'pattern', 'picture', 'group', 'absent']);
const NODE_PROFILE_VALUES_V1 = {
    geometry: GEOMETRY_PRESETS_V1,
    size: new Set(['none', 'xs', 's', 'm', 'l', 'xl']),
    aspect: new Set(['none', 'degenerate', 'wide', 'landscape', 'square', 'portrait', 'tall']),
    rotated: YES_NO,
    flipped: new Set(['none', 'h', 'v', 'hv']),
    grouped: YES_NO,
    placeholder: YES_NO,
    fill: FILL_KINDS,
    line: FILL_KINDS,
    shadow: YES_NO,
    text_chars: new Set(['0', '1_20', '21_100', '101_500', '501_2000', '2001_plus']),
    text_paragraphs: new Set(['0', '1', '2_5', '6_20', '21_plus']),
    font_size: new Set(['inherited', 'lt10', '10_17', '18_27', '28_43', '44_71', '72_plus']),
    autofit: new Set(['none', 'normal', 'shape', 'unspecified']),
    wrap: new Set(['none', 'square']),
    vert: new Set([
        'unset',
        'horz',
        'vert',
        'vert270',
        'wordArtVert',
        'eaVert',
        'mongolianVert',
        'wordArtVertRtl',
    ]),
    anchor: new Set(['unset', 't', 'ctr', 'b', 'just', 'dist']),
    columns: new Set(['1', '2_plus']),
    h_overflow: new Set(['overflow', 'clip']),
    v_overflow: new Set(['overflow', 'ellipsis', 'clip']),
    warp: TEXT_WARP_PRESETS_V1,
    picture_crop: YES_NO,
    picture_tile: YES_NO,
    media: new Set(['none', 'audio', 'video']),
    table_rows: new Set(['0', '1_5', '6_20', '21_plus']),
    table_cols: new Set(['0', '1_5', '6_20', '21_plus']),
    table_merged: YES_NO,
    table_style: new Set(['implicit-default', 'resolved', 'missing']),
    chart_source: new Set(['chart', 'chartEx']),
    chart_family: new Set([
        'bar',
        'line',
        'area',
        'pie',
        'doughnut',
        'scatter',
        'bubble',
        'radar',
        'stock',
        'funnel',
        'sunburst',
        'combo',
        'unknown',
    ]),
    chart_projection: new Set(['native-2d', 'authored-3d-to-2d']),
    chart_series: new Set(['0', '1', '2_5', '6_20', '21_plus']),
};
/** Multi-valued keys join up to four sorted members with `+`. */
const NODE_PROFILE_SETS_V1 = {
    text_scripts: TEXT_SCRIPTS_V1,
    chart_plots: CHART_PLOT_KINDS_V1,
};
const MAX_SET_MEMBERS_V1 = 4;
function profileValue(key, value) {
    if (typeof value !== 'string')
        return undefined;
    const single = Object.hasOwn(NODE_PROFILE_VALUES_V1, key)
        ? NODE_PROFILE_VALUES_V1[key]
        : undefined;
    if (single)
        return single.has(value) ? value : 'other';
    const members = Object.hasOwn(NODE_PROFILE_SETS_V1, key)
        ? NODE_PROFILE_SETS_V1[key]
        : undefined;
    if (!members)
        return undefined;
    const parts = [...new Set(value.split('+'))].map((part) => (members.has(part) ? part : 'other'));
    return [...new Set(parts)].sort().slice(0, MAX_SET_MEMBERS_V1).join('+') || undefined;
}
/**
 * Keeps known keys only and maps every value outside the vocabulary to `other`.
 * Returns undefined when nothing remains, so callers can omit the field.
 */
export function normalizePptxNodeProfileV1(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value)
        .map(([key, item]) => [key, profileValue(key, item)])
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}
const MAX_TRACE_FRAMES_V1 = 6;
const FRAME_NAME_V1 = /^[A-Za-z0-9_$.<>[\]]{1,80}$/u;
const FRAME_FILE_V1 = /^[A-Za-z0-9_.-]{1,80}\.(?:m?js|tsx?|wasm)$/u;
const MANAGED_FRAME_V1 = /^Mavis\.[A-Za-z0-9_.]{1,120}$/u;
/** One sanitized frame: `name@bundle.js:line:col`, `bundle.js:line:col` or a `Mavis.*` method. */
export const PPTX_ERROR_TRACE_FRAME_V1 = /^(?:(?:[A-Za-z0-9_$.<>[\]]{1,80}@)?[A-Za-z0-9_.-]{1,80}\.(?:m?js|tsx?|wasm):\d{1,7}(?::\d{1,7})?|Mavis\.[A-Za-z0-9_.]{1,120})$/u;
function frameFile(location) {
    const path = location.replace(/[?#].*$/u, '');
    const file = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    return FRAME_FILE_V1.test(file) ? file : null;
}
function parseFrame(line) {
    const managed = line.match(/^\s*at (Mavis\.[A-Za-z0-9_.]+)/u)?.[1];
    if (managed)
        return MANAGED_FRAME_V1.test(managed) ? managed : null;
    const v8 = line.match(/^\s*at (?:async )?(?:(.+?) \()?(.+):(\d+):(\d+)\)?\s*$/u);
    const gecko = v8 ? null : line.match(/^\s*(.*?)@(.+):(\d+):(\d+)\s*$/u);
    const match = v8 ?? gecko;
    if (!match)
        return null;
    const file = frameFile(match[2]);
    if (!file)
        return null;
    const name = match[1]?.replace(/^new /u, '');
    const frame = `${file}:${match[3]}:${match[4]}`;
    return name && FRAME_NAME_V1.test(name) ? `${name}@${frame}` : frame;
}
/**
 * Bundle frames of an error's stack without its message. Only file basenames,
 * positions and code identifiers survive, so install paths and document text
 * embedded in messages are dropped.
 */
export function pptxErrorTraceV1(error) {
    const frames = [];
    try {
        if (!(error instanceof Error) || typeof error.stack !== 'string')
            return Object.freeze(frames);
        let stack = error.stack;
        const header = Error.prototype.toString.call(error);
        if (stack === header)
            return Object.freeze(frames);
        if (stack.startsWith(`${header}\n`)) {
            // V8 includes the entire message, including authored newlines, before its frames.
            stack = stack.slice(header.length + 1);
        }
        else if (!/^(?:[A-Za-z0-9_$.<>[\]]{1,80})?@/u.test(stack)) {
            // Gecko supplies frames without a header. Unknown/stale headers fail closed:
            // skipping just the first line could export the rest of a multiline message.
            return Object.freeze(frames);
        }
        for (const line of stack.split('\n')) {
            const frame = parseFrame(line);
            if (frame && PPTX_ERROR_TRACE_FRAME_V1.test(frame))
                frames.push(frame);
            if (frames.length >= MAX_TRACE_FRAMES_V1)
                break;
        }
    }
    catch {
        // An unusual stack/name/message getter must not change preview behavior.
    }
    return Object.freeze(frames);
}
/** Joins frames with `|` for string-only diagnostic details, keeping whole frames within `maxChars`. */
export function encodePptxErrorTraceV1(frames, maxChars) {
    let encoded = '';
    for (const frame of frames) {
        const next = encoded ? `${encoded}|${frame}` : frame;
        if (next.length > maxChars)
            break;
        encoded = next;
    }
    return encoded || undefined;
}
/** Accepts a frame array or its `|`-joined form; drops malformed frames and never throws. */
export function normalizePptxErrorTraceV1(value) {
    const list = typeof value === 'string' ? value.split('|') : value;
    if (!Array.isArray(list))
        return undefined;
    const frames = list
        .filter((frame) => typeof frame === 'string' && PPTX_ERROR_TRACE_FRAME_V1.test(frame))
        .slice(0, MAX_TRACE_FRAMES_V1);
    return frames.length === 0 ? undefined : Object.freeze(frames);
}
//# sourceMappingURL=pptx-telemetry.js.map