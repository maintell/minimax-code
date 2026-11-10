/** Desktop editing wire; source authority and paths stay in the host. */
export const PPTX_EDITING_SCHEMA_V1 = 'mavis.pptx_editing.v1';
/** Authored document colors and widths shared by insertion and its live preview. */
export const PPTX_BASIC_SHAPE_DEFAULTS_V1 = Object.freeze({
    fill: 'D9E2F3',
    stroke: '4472C4',
    strokeWidthEmu: 12700,
    lineStrokeWidthEmu: 25400,
    shapeStrokeWidthEmu: 0,
});
const ID = /^ppt-node:v1:[a-f0-9]{16}$/u;
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid_transaction');
    return value;
}
function boundedInteger(value, minimum = 0, maximum = 1_000_000_000) {
    if (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum)
        throw new Error('invalid_transaction');
    return value;
}
function text(value, max = 128) {
    if (typeof value !== 'string' ||
        value.length > max ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value))
        throw new Error('invalid_transaction');
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                throw new Error('invalid_transaction');
        }
        else if (code >= 0xdc00 && code <= 0xdfff)
            throw new Error('invalid_transaction');
    }
    return value;
}
function color(value) {
    const result = text(value, 6);
    if (!/^[a-f0-9]{6}$/iu.test(result))
        throw new Error('invalid_transaction');
    return result.toUpperCase();
}
function decodeChartData(value) {
    const input = object(value);
    if (!Array.isArray(input.categories) ||
        input.categories.length < 1 ||
        input.categories.length > 1000 ||
        !Array.isArray(input.series) ||
        input.series.length < 1 ||
        input.series.length > 64)
        throw new Error('invalid_transaction');
    const categories = input.categories.map((candidateValue) => text(candidateValue, 1024));
    const series = input.series.map((currentValue) => {
        const row = object(currentValue);
        if (!Array.isArray(row.values) || row.values.length !== categories.length)
            throw new Error('invalid_transaction');
        return {
            name: text(row.name, 1024),
            values: row.values.map((nextValue) => {
                if (nextValue !== null &&
                    (typeof nextValue !== 'number' ||
                        !Number.isFinite(nextValue) ||
                        Math.abs(nextValue) > 1e100))
                    throw new Error('invalid_transaction');
                return nextValue;
            }),
        };
    });
    return { categories, series };
}
function decodeChartType(value) {
    if (![
        'column',
        'stacked-column',
        'percent-column',
        'bar',
        'stacked-bar',
        'percent-bar',
        'line',
        'pie',
        'doughnut',
    ].includes(String(value)))
        throw new Error('unsupported_edit');
    return value;
}
function decodeTextStyle(value) {
    const style = object(value);
    const result = {};
    if (style.fontFamily !== undefined)
        result.fontFamily = text(style.fontFamily, 256);
    if (style.fontSize100 !== undefined)
        result.fontSize100 = boundedInteger(style.fontSize100, 100, 40000);
    for (const key of ['bold', 'italic', 'underline'])
        if (style[key] !== undefined) {
            if (typeof style[key] !== 'boolean')
                throw new Error('invalid_transaction');
            result[key] = style[key];
        }
    if (style.color !== undefined)
        result.color = color(style.color);
    if (!Object.keys(result).length || result.fontFamily === '')
        throw new Error('invalid_transaction');
    return result;
}
function decodeInsertedTextStyle(value) {
    const { fontSize100, bold } = decodeTextStyle(value);
    if (fontSize100 === undefined && bold === undefined)
        throw new Error('invalid_transaction');
    return {
        ...(fontSize100 !== undefined ? { fontSize100 } : {}),
        ...(bold !== undefined ? { bold } : {}),
    };
}
export function decodePptxEditingTransactionV1(value) {
    const input = object(value);
    if (JSON.stringify(input).length > 2_000_000)
        throw new Error('invalid_transaction');
    if (input.schema !== 'mavis.pptx_transaction.v1' ||
        !Array.isArray(input.scope) ||
        input.scope.length < 1 ||
        input.scope.length > 1000 ||
        !Array.isArray(input.operations) ||
        input.operations.length < 1 ||
        input.operations.length > 256 ||
        !['human', 'agent'].includes(String(input.actor)))
        throw new Error('invalid_transaction');
    const scope = input.scope.map((id) => {
        const s = text(id);
        if (!ID.test(s))
            throw new Error('invalid_transaction');
        return s;
    });
    if (new Set(scope).size !== scope.length ||
        Object.keys(object(input.expectedVersions)).length > 1000)
        throw new Error('invalid_transaction');
    const expectedVersions = Object.fromEntries(Object.entries(object(input.expectedVersions)).map(([id, v]) => {
        if (!ID.test(id))
            throw new Error('invalid_transaction');
        return [id, boundedInteger(v)];
    }));
    const operations = input.operations.map((raw) => {
        const op = object(raw);
        const targetId = text(op.targetId);
        if (!ID.test(targetId))
            throw new Error('invalid_transaction');
        switch (op.kind) {
            case 'insert-chart': {
                const id = text(op.id);
                if (!ID.test(id))
                    throw new Error('invalid_transaction');
                const chartType = decodeChartType(op.chartType);
                const data = decodeChartData(op.data);
                if (['pie', 'doughnut'].includes(chartType) && data.series.length !== 1)
                    throw new Error('unsupported_edit');
                const rect = object(op.rect);
                return {
                    kind: 'insert-chart',
                    targetId,
                    id,
                    chartType,
                    data,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width, 1),
                        height: boundedInteger(rect.height, 1),
                    },
                };
            }
            case 'chart': {
                const edit = object(op.edit);
                if (edit.action === 'data') {
                    const { categories, series } = decodeChartData(edit);
                    return { kind: 'chart', targetId, edit: { action: 'data', categories, series } };
                }
                if (edit.action === 'type') {
                    const chartType = decodeChartType(edit.chartType);
                    return {
                        kind: 'chart',
                        targetId,
                        edit: { action: 'type', chartType },
                    };
                }
                if (edit.action === 'style') {
                    const result = { action: 'style' };
                    for (const key of ['legend', 'labels'])
                        if (edit[key] !== undefined) {
                            if (typeof edit[key] !== 'boolean')
                                throw new Error('invalid_transaction');
                            result[key] = edit[key];
                        }
                    if (edit.labelPosition !== undefined) {
                        if (![
                            'bestFit',
                            'bottom',
                            'center',
                            'insideBase',
                            'insideEnd',
                            'left',
                            'outsideEnd',
                            'right',
                            'top',
                        ].includes(String(edit.labelPosition)))
                            throw new Error('invalid_transaction');
                        result.labelPosition = edit.labelPosition;
                    }
                    if (edit.legendPosition !== undefined) {
                        if (!['right', 'left', 'top', 'bottom', 'top-right'].includes(String(edit.legendPosition)))
                            throw new Error('invalid_transaction');
                        result.legendPosition = edit.legendPosition;
                    }
                    if (edit.colors !== undefined) {
                        if (!Array.isArray(edit.colors) || edit.colors.length > 64 || !edit.colors.length)
                            throw new Error('invalid_transaction');
                        result.colors = edit.colors.map(color);
                    }
                    if (Object.keys(result).length === 1)
                        throw new Error('invalid_transaction');
                    return { kind: 'chart', targetId, edit: result };
                }
                throw new Error('invalid_transaction');
            }
            case 'notes':
                return { kind: 'notes', targetId, text: text(op.text, 1_000_000) };
            case 'page': {
                if (op.action === 'insert' || op.action === 'duplicate') {
                    const id = text(op.id);
                    if (!ID.test(id) || id === targetId)
                        throw new Error('invalid_transaction');
                    if (op.position !== undefined && !['before', 'after'].includes(String(op.position)))
                        throw new Error('invalid_transaction');
                    return {
                        kind: 'page',
                        targetId,
                        action: op.action,
                        id,
                        ...(op.position === undefined ? {} : { position: op.position }),
                    };
                }
                if (op.action === 'delete')
                    return { kind: 'page', targetId, action: 'delete' };
                if (op.action === 'hidden') {
                    if (typeof op.hidden !== 'boolean')
                        throw new Error('invalid_transaction');
                    return { kind: 'page', targetId, action: 'hidden', hidden: op.hidden };
                }
                if (op.action === 'reorder') {
                    const beforeId = op.beforeId === null ? null : text(op.beforeId);
                    if (beforeId !== null && (!ID.test(beforeId) || beforeId === targetId))
                        throw new Error('invalid_transaction');
                    return { kind: 'page', targetId, action: 'reorder', beforeId };
                }
                throw new Error('invalid_transaction');
            }
            case 'insert-media':
            case 'replace-media': {
                const resourceId = text(op.resourceId);
                const posterResourceId = text(op.posterResourceId);
                if (![resourceId, posterResourceId].every((id) => /^ppt-resource:v1:[a-f0-9]{16,64}$/u.test(id)))
                    throw new Error('invalid_transaction');
                if (op.kind === 'replace-media')
                    return { kind: 'replace-media', targetId, resourceId, posterResourceId };
                if (op.mediaKind !== 'audio' && op.mediaKind !== 'video')
                    throw new Error('invalid_transaction');
                const id = text(op.id);
                if (!ID.test(id))
                    throw new Error('invalid_transaction');
                const rect = object(op.rect);
                return {
                    kind: 'insert-media',
                    targetId,
                    id,
                    mediaKind: op.mediaKind,
                    resourceId,
                    posterResourceId,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width, 1),
                        height: boundedInteger(rect.height, 1),
                    },
                };
            }
            case 'formula':
            case 'insert-formula': {
                if (op.format !== 'latex' && op.format !== 'unicode')
                    throw new Error('unsupported_formula');
                const source = text(op.source, 8192);
                if (!source.trim())
                    throw new Error('unsupported_formula');
                if (op.kind === 'formula')
                    return { kind: 'formula', targetId, source, format: op.format };
                const id = text(op.id);
                if (!ID.test(id))
                    throw new Error('invalid_transaction');
                const rect = object(op.rect);
                return {
                    kind: 'insert-formula',
                    targetId,
                    id,
                    source,
                    format: op.format,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width, 1),
                        height: boundedInteger(rect.height, 1),
                    },
                };
            }
            case 'animation': {
                const edit = object(op.edit);
                if (edit.action === 'add' || edit.action === 'replace' || edit.action === 'update') {
                    if (![
                        'appear',
                        'disappear',
                        'fade-in',
                        'fade-out',
                        'fly-in',
                        'fly-out',
                        'zoom-in',
                        'zoom-out',
                        'wipe-in',
                        'wipe-out',
                    ].includes(String(edit.effect)))
                        throw new Error('unsupported_edit');
                    if (edit.start !== undefined &&
                        !['on-click', 'with-previous', 'after-previous'].includes(String(edit.start)))
                        throw new Error('unsupported_edit');
                    return {
                        kind: 'animation',
                        targetId,
                        edit: {
                            ...(edit.action === 'update'
                                ? {
                                    action: 'update',
                                    timingId: boundedInteger(edit.timingId, 1, 2147483647),
                                }
                                : { action: edit.action }),
                            effect: edit.effect,
                            durationMs: boundedInteger(edit.durationMs, 1, 10000),
                            ...(edit.start === undefined ? {} : { start: edit.start }),
                            ...(edit.delayMs === undefined
                                ? {}
                                : { delayMs: boundedInteger(edit.delayMs, 0, 60000) }),
                            ...(edit.repeatCount === undefined
                                ? {}
                                : { repeatCount: boundedInteger(edit.repeatCount, 0, 99) }),
                        },
                    };
                }
                if (edit.action === 'delete')
                    return {
                        kind: 'animation',
                        targetId,
                        edit: { action: 'delete', timingId: boundedInteger(edit.timingId, 1, 2147483647) },
                    };
                if (edit.action === 'reorder')
                    return {
                        kind: 'animation',
                        targetId,
                        edit: {
                            action: 'reorder',
                            timingId: boundedInteger(edit.timingId, 1, 2147483647),
                            beforeTimingId: edit.beforeTimingId === null
                                ? null
                                : boundedInteger(edit.beforeTimingId, 1, 2147483647),
                        },
                    };
                throw new Error('invalid_transaction');
            }
            case 'transition': {
                if (![
                    'none',
                    'fade',
                    'fade-black',
                    'push',
                    'cover',
                    'pull',
                    'wipe',
                    'split-horizontal',
                    'split-vertical',
                    'zoom-horizontal',
                    'zoom-vertical',
                    'zoom-in',
                    'zoom-out',
                ].includes(String(op.transition)))
                    throw new Error('unsupported_edit');
                if (op.direction !== undefined &&
                    (op.transition === 'zoom-horizontal'
                        ? !['l', 'r'].includes(String(op.direction))
                        : op.transition === 'zoom-vertical'
                            ? !['u', 'd'].includes(String(op.direction))
                            : !['push', 'cover', 'pull', 'wipe'].includes(String(op.transition)) ||
                                !['l', 'r', 'u', 'd'].includes(String(op.direction))))
                    throw new Error('unsupported_edit');
                return {
                    kind: 'transition',
                    targetId,
                    transition: op.transition,
                    ...(op.direction === undefined
                        ? {}
                        : { direction: op.direction }),
                    durationMs: boundedInteger(op.durationMs, 1, 10000),
                };
            }
            case 'insert-picture': {
                const id = text(op.id);
                const resourceId = text(op.resourceId);
                if (!ID.test(id) || !/^ppt-resource:v1:[a-f0-9]{16,64}$/u.test(resourceId))
                    throw new Error('invalid_transaction');
                const rect = object(op.rect);
                return {
                    kind: 'insert-picture',
                    targetId,
                    id,
                    resourceId,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width, 1),
                        height: boundedInteger(rect.height, 1),
                    },
                };
            }
            case 'replace-picture': {
                const resourceId = text(op.resourceId);
                if (!/^ppt-resource:v1:[a-f0-9]{16,64}$/u.test(resourceId))
                    throw new Error('invalid_transaction');
                return { kind: 'replace-picture', targetId, resourceId };
            }
            case 'picture-crop': {
                const selectedValue = object(op.crop);
                const crop = {
                    left: boundedInteger(selectedValue.left, 0, 99999),
                    top: boundedInteger(selectedValue.top, 0, 99999),
                    right: boundedInteger(selectedValue.right, 0, 99999),
                    bottom: boundedInteger(selectedValue.bottom, 0, 99999),
                };
                if (crop.left + crop.right >= 100000 || crop.top + crop.bottom >= 100000)
                    throw new Error('invalid_transaction');
                return { kind: 'picture-crop', targetId, crop };
            }
            case 'table': {
                const edit = object(op.edit);
                if (edit.action === 'merge') {
                    const rowSpan = boundedInteger(edit.rowSpan, 1, 10000);
                    const columnSpan = boundedInteger(edit.columnSpan, 1, 10000);
                    if (rowSpan * columnSpan < 2 || rowSpan * columnSpan > 10000)
                        throw new Error('invalid_transaction');
                    return {
                        kind: 'table',
                        targetId,
                        edit: {
                            action: 'merge',
                            row: boundedInteger(edit.row, 0, 10000),
                            column: boundedInteger(edit.column, 0, 10000),
                            rowSpan,
                            columnSpan,
                        },
                    };
                }
                if (edit.action === 'cell' || edit.action === 'appearance') {
                    const result = edit.action === 'cell'
                        ? {
                            action: 'cell',
                            row: boundedInteger(edit.row, 0, 10000),
                            column: boundedInteger(edit.column, 0, 10000),
                        }
                        : { action: 'appearance' };
                    if (result.action === 'cell') {
                        if (edit.text !== undefined)
                            result.text = text(edit.text, 1_000_000);
                        if (edit.style !== undefined)
                            result.style = decodeTextStyle(edit.style);
                        if (edit.alignment !== undefined) {
                            if (!['l', 'ctr', 'r'].includes(String(edit.alignment)))
                                throw new Error('invalid_transaction');
                            result.alignment = edit.alignment;
                        }
                    }
                    if (edit.fill !== undefined)
                        result.fill = edit.fill === null ? null : color(edit.fill);
                    if (edit.border !== undefined) {
                        const border = object(edit.border);
                        result.border = {
                            color: border.color === null ? null : color(border.color),
                            widthEmu: boundedInteger(border.widthEmu, 0, 12_700_000),
                        };
                    }
                    if (!Object.keys(result).some((key) => !['action', 'row', 'column'].includes(key)))
                        throw new Error('invalid_transaction');
                    return { kind: 'table', targetId, edit: result };
                }
                if (![
                    'insert-row',
                    'delete-row',
                    'insert-column',
                    'delete-column',
                    'row-height',
                    'column-width',
                ].includes(String(edit.action)))
                    throw new Error('unsupported_edit');
                return {
                    kind: 'table',
                    targetId,
                    edit: {
                        action: edit.action,
                        index: boundedInteger(edit.index, 0, 10000),
                        ...(edit.value !== undefined
                            ? { value: boundedInteger(edit.value, 9525, 1_000_000_000) }
                            : {}),
                    },
                };
            }
            case 'insert-shape': {
                const id = text(op.id);
                if (!ID.test(id) ||
                    !['text', 'rect', 'roundRect', 'ellipse', 'line', 'arrow', 'connector', 'table'].includes(String(op.shapeKind)))
                    throw new Error('invalid_transaction');
                const rect = object(op.rect);
                const beforeId = op.beforeId === undefined ? undefined : text(op.beforeId);
                if (beforeId !== undefined && !ID.test(beforeId))
                    throw new Error('invalid_transaction');
                return {
                    kind: 'insert-shape',
                    targetId,
                    id,
                    shapeKind: op.shapeKind,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width, ['line', 'arrow', 'connector'].includes(String(op.shapeKind)) ? 0 : 1),
                        height: boundedInteger(rect.height, ['line', 'arrow', 'connector'].includes(String(op.shapeKind)) ? 0 : 1),
                    },
                    ...(op.rows !== undefined ? { rows: boundedInteger(op.rows, 1, 50) } : {}),
                    ...(op.columns !== undefined ? { columns: boundedInteger(op.columns, 1, 50) } : {}),
                    ...(op.text !== undefined ? { text: text(op.text, 1_000_000) } : {}),
                    ...(op.textStyle !== undefined
                        ? { textStyle: decodeInsertedTextStyle(op.textStyle) }
                        : {}),
                    ...(op.rotation60000 !== undefined
                        ? { rotation60000: boundedInteger(op.rotation60000, -21_600_000, 21_600_000) }
                        : {}),
                    ...(beforeId ? { beforeId } : {}),
                };
            }
            case 'delete-shape':
                return { kind: 'delete-shape', targetId };
            case 'reorder-shape': {
                const beforeId = op.beforeId === null ? null : text(op.beforeId);
                if (beforeId !== null && !ID.test(beforeId))
                    throw new Error('invalid_transaction');
                return { kind: 'reorder-shape', targetId, beforeId };
            }
            case 'text':
                return {
                    kind: 'text',
                    targetId,
                    start: boundedInteger(op.start),
                    end: boundedInteger(op.end),
                    text: text(op.text, 1_000_000),
                };
            case 'text-style': {
                const result = decodeTextStyle(op.style);
                return {
                    kind: 'text-style',
                    targetId,
                    start: boundedInteger(op.start),
                    end: boundedInteger(op.end),
                    style: result,
                };
            }
            case 'paragraph': {
                if (!Array.isArray(op.paragraphIndices) ||
                    op.paragraphIndices.length < 1 ||
                    op.paragraphIndices.length > 10000)
                    throw new Error('invalid_transaction');
                const style = object(op.style);
                const result = {};
                if (style.alignment !== undefined) {
                    if (!['l', 'ctr', 'r', 'just'].includes(String(style.alignment)))
                        throw new Error('invalid_transaction');
                    result.alignment = style.alignment;
                }
                if (style.bullet !== undefined) {
                    if (!['none', 'bullet', 'number'].includes(String(style.bullet)))
                        throw new Error('invalid_transaction');
                    result.bullet = style.bullet;
                }
                if (style.lineSpacing1000 !== undefined)
                    result.lineSpacing1000 = boundedInteger(style.lineSpacing1000, 10000, 1000000);
                if (style.marginLeftEmu !== undefined)
                    result.marginLeftEmu = boundedInteger(style.marginLeftEmu, 0, 100000000);
                if (style.indentEmu !== undefined)
                    result.indentEmu = boundedInteger(style.indentEmu, -100000000, 100000000);
                if (style.spaceBefore100 !== undefined)
                    result.spaceBefore100 = boundedInteger(style.spaceBefore100, 0, 40000);
                if (style.spaceAfter100 !== undefined)
                    result.spaceAfter100 = boundedInteger(style.spaceAfter100, 0, 40000);
                if (!Object.keys(result).length ||
                    new Set(op.paragraphIndices).size !== op.paragraphIndices.length)
                    throw new Error('invalid_transaction');
                return {
                    kind: 'paragraph',
                    targetId,
                    paragraphIndices: op.paragraphIndices.map((i) => boundedInteger(i, 0, 10000)),
                    style: result,
                };
            }
            case 'text-anchor':
                if (op.anchor !== 't' && op.anchor !== 'ctr' && op.anchor !== 'b')
                    throw new Error('invalid_transaction');
                return { kind: 'text-anchor', targetId, anchor: op.anchor };
            case 'text-insets': {
                const v = object(op.insets);
                return {
                    kind: 'text-insets',
                    targetId,
                    insets: {
                        left: boundedInteger(v.left),
                        top: boundedInteger(v.top),
                        right: boundedInteger(v.right),
                        bottom: boundedInteger(v.bottom),
                    },
                };
            }
            case 'transform': {
                const rect = object(op.rect);
                return {
                    kind: 'transform',
                    targetId,
                    rect: {
                        x: boundedInteger(rect.x, -1_000_000_000),
                        y: boundedInteger(rect.y, -1_000_000_000),
                        width: boundedInteger(rect.width),
                        height: boundedInteger(rect.height),
                    },
                    rotation60000: boundedInteger(op.rotation60000, -21_600_000, 21_600_000),
                };
            }
            case 'appearance': {
                const result = {
                    kind: 'appearance',
                    targetId,
                };
                if (op.fill !== undefined)
                    result.fill = op.fill === null ? null : color(op.fill);
                if (op.opacity100000 !== undefined)
                    result.opacity100000 = boundedInteger(op.opacity100000, 0, 100000);
                if (op.stroke !== undefined) {
                    const v = object(op.stroke);
                    result.stroke = {
                        color: v.color === null ? null : color(v.color),
                        widthEmu: boundedInteger(v.widthEmu, 0, 12_700_000),
                    };
                }
                if (Object.keys(result).length === 2)
                    throw new Error('invalid_transaction');
                return result;
            }
            default:
                throw new Error('unsupported_edit');
        }
    });
    if (!text(input.commandId).length ||
        !text(input.transactionId).length ||
        input.historyGroupId === '')
        throw new Error('invalid_transaction');
    for (const op of operations) {
        if (!scope.includes(op.targetId))
            throw new Error('scope_violation');
        if ((op.kind === 'text' || op.kind === 'text-style') && op.start > op.end)
            throw new Error('invalid_transaction');
        if ((op.kind === 'transform' || op.kind === 'insert-shape') &&
            op.rect.width === 0 &&
            op.rect.height === 0)
            throw new Error('invalid_transaction');
    }
    if (operations.reduce((size, op) => size + (op.kind === 'text' ? op.text.length : 0), 0) > 1_000_000)
        throw new Error('invalid_transaction');
    return {
        schema: 'mavis.pptx_transaction.v1',
        commandId: text(input.commandId),
        transactionId: text(input.transactionId),
        baseRevision: boundedInteger(input.baseRevision),
        scope,
        expectedVersions,
        operations,
        actor: input.actor,
        ...(input.historyGroupId !== undefined ? { historyGroupId: text(input.historyGroupId) } : {}),
    };
}
function nonempty(value) {
    const result = text(value, 256);
    if (!result)
        throw new Error('invalid_request');
    return result;
}
function finiteTime(value) {
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER)
        throw new Error('invalid_request');
    return value;
}
export function decodePptxEditingReadV1(value) {
    const input = object(value);
    if (JSON.stringify(input).length > 2_000_000)
        throw new Error('resource_limit_exceeded');
    const slideIndex = () => boundedInteger(input.slideIndex, 0, 10000);
    switch (input.method) {
        case 'summary':
        case 'diagnostics':
            return { method: input.method };
        case 'animation':
            return {
                method: 'animation',
                slideIndex: slideIndex(),
                ...(input.timingId !== undefined
                    ? { timingId: boundedInteger(input.timingId, 1, 2147483647) }
                    : {}),
            };
        case 'slide':
        case 'selection':
            return { method: input.method, slideIndex: slideIndex() };
        case 'notes': {
            const slideId = nonempty(input.slideId);
            if (!ID.test(slideId))
                throw new Error('invalid_request');
            return { method: 'notes', slideId };
        }
        case 'search':
            return { method: 'search', query: text(input.query, 10000) };
        case 'resource':
            return {
                method: 'resource',
                resourceId: nonempty(input.resourceId),
                renderHash: nonempty(input.renderHash),
            };
        case 'picture': {
            const objectId = nonempty(input.objectId);
            if (!ID.test(objectId))
                throw new Error('invalid_request');
            return {
                method: 'picture',
                objectId,
                expectedVersion: boundedInteger(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER),
            };
        }
        case 'selection-resource':
            return { method: 'selection-resource', resourceId: nonempty(input.resourceId) };
        case 'evaluate-animation': {
            const eventLog = object(input.eventLog);
            if (eventLog.schema !== 'mavis.pptx_playback_event_log.v1' ||
                eventLog.slideEnteredAtMs !== 0 ||
                !Array.isArray(eventLog.events) ||
                eventLog.events.length > 10000)
                throw new Error('invalid_request');
            const events = eventLog.events.map((sourceValue) => {
                const event = object(sourceValue);
                const result = {
                    kind: nonempty(event.kind),
                    logicalAtMs: finiteTime(event.logicalAtMs),
                    sequence: boundedInteger(event.sequence, 0, Number.MAX_SAFE_INTEGER),
                };
                for (const key of [
                    'targetNodeId',
                    'mediaNodeId',
                    'bookmark',
                    'state',
                    'transitionProgramHash',
                ])
                    if (event[key] !== undefined)
                        result[key] = nonempty(event[key]);
                if (event.targetMs !== undefined)
                    result.targetMs = finiteTime(event.targetMs);
                return result;
            });
            return {
                method: 'evaluate-animation',
                ...(input.timingId !== undefined
                    ? { timingId: boundedInteger(input.timingId, 1, 2147483647) }
                    : {}),
                slideIndex: slideIndex(),
                baseRenderHash: nonempty(input.baseRenderHash),
                logicalTimeMs: finiteTime(input.logicalTimeMs),
                generation: boundedInteger(input.generation, 0, Number.MAX_SAFE_INTEGER),
                eventLog: { schema: eventLog.schema, slideEnteredAtMs: 0, events },
            };
        }
        case 'evaluate-transition':
            return {
                method: 'evaluate-transition',
                fromSlideIndex: boundedInteger(input.fromSlideIndex, 0, 10000),
                toSlideIndex: boundedInteger(input.toSlideIndex, 0, 10000),
                logicalTimeMs: finiteTime(input.logicalTimeMs),
                surfaces: object(input.surfaces),
            };
        default:
            throw new Error('invalid_request');
    }
}
/** The visible renderer cannot issue raw resource writes or prepare/commit operations. */
export function decodePptxEditingRequestV1(value) {
    const input = object(value);
    if (input.action === 'open') {
        const contentSha256 = nonempty(input.contentSha256);
        if (!/^sha256:[a-f0-9]{64}$/u.test(contentSha256))
            throw new Error('invalid_request');
        if (input.preparation !== undefined && input.preparation !== 'basic')
            throw new Error('invalid_request');
        return {
            action: 'open',
            sourceId: nonempty(input.sourceId),
            contentSha256: contentSha256,
            ...(input.preparation === 'basic' ? { preparation: 'basic' } : {}),
            ...(input.sourceGeneration === undefined && input.preparation === 'basic'
                ? {}
                : { sourceGeneration: boundedInteger(input.sourceGeneration, 0, Number.MAX_SAFE_INTEGER) }),
            ...(input.openId === undefined ? {} : { openId: nonempty(input.openId) }),
            ...(input.sessionId === undefined ? {} : { sessionId: text(input.sessionId, 512) }),
        };
    }
    if (input.action === 'cancel-open')
        return {
            action: 'cancel-open',
            sourceId: nonempty(input.sourceId),
            openId: nonempty(input.openId),
        };
    const editSessionId = nonempty(input.editSessionId);
    switch (input.action) {
        case 'capabilities': {
            const objectId = input.objectId === undefined ? undefined : nonempty(input.objectId);
            if (objectId !== undefined && !ID.test(objectId))
                throw new Error('invalid_request');
            return {
                action: 'capabilities',
                editSessionId,
                ...(objectId ? { objectId } : {}),
                ...(input.slideIndex === undefined
                    ? {}
                    : { slideIndex: boundedInteger(input.slideIndex, 0, 10000) }),
            };
        }
        case 'clipboard': {
            const candidateEditSessionId = text(input.editSessionId);
            const expectedRevision = boundedInteger(input.expectedRevision, 0);
            if (input.operation === 'inspect')
                return {
                    action: 'clipboard',
                    editSessionId: candidateEditSessionId,
                    operation: 'inspect',
                    expectedRevision,
                };
            if (input.operation === 'paste') {
                if (input.anchor !== undefined &&
                    (input.kind !== 'objects' || input.position !== undefined))
                    throw new Error('invalid_request');
                const anchor = input.anchor === undefined ? undefined : object(input.anchor);
                if (input.position !== undefined && !['before', 'after'].includes(String(input.position)))
                    throw new Error('invalid_request');
                if (input.position !== undefined && input.kind !== 'slides')
                    throw new Error('invalid_request');
                if (input.kind !== undefined && !['objects', 'slides'].includes(String(input.kind)))
                    throw new Error('invalid_request');
                const targetId = text(input.targetId);
                if (!ID.test(targetId))
                    throw new Error('invalid_request');
                return {
                    action: 'clipboard',
                    editSessionId: candidateEditSessionId,
                    operation: 'paste',
                    ...(anchor === undefined
                        ? {}
                        : { anchor: { x: boundedInteger(anchor.x), y: boundedInteger(anchor.y) } }),
                    ...(input.kind === undefined ? {} : { kind: input.kind }),
                    ...(input.position === undefined
                        ? {}
                        : { position: input.position }),
                    targetId,
                    expectedRevision,
                };
            }
            if (!['copy', 'cut'].includes(String(input.operation)) ||
                !['objects', 'slides'].includes(String(input.kind)) ||
                !Array.isArray(input.targetIds) ||
                !input.targetIds.length ||
                input.targetIds.length > 256)
                throw new Error('invalid_request');
            const targetIds = input.targetIds.map((resolvedValue) => {
                const id = text(resolvedValue);
                if (!ID.test(id))
                    throw new Error('invalid_request');
                return id;
            });
            if (new Set(targetIds).size !== targetIds.length)
                throw new Error('invalid_request');
            return {
                action: 'clipboard',
                editSessionId: candidateEditSessionId,
                operation: input.operation,
                kind: input.kind,
                targetIds,
                expectedRevision,
            };
        }
        case 'confirm-leave':
            return { action: 'confirm-leave', editSessionId };
        case 'propose': {
            if (!Array.isArray(input.targetIds) ||
                !input.targetIds.length ||
                input.targetIds.length > 100)
                throw new Error('invalid_request');
            const targetIds = input.targetIds.map((pendingValue) => {
                const id = nonempty(pendingValue);
                if (!ID.test(id))
                    throw new Error('invalid_request');
                return id;
            });
            const instruction = text(input.instruction, 8192);
            if (!instruction.trim() || new Set(targetIds).size !== targetIds.length)
                throw new Error('invalid_request');
            const textRange = input.textRange === undefined
                ? undefined
                : {
                    start: boundedInteger(object(input.textRange).start, 0),
                    end: boundedInteger(object(input.textRange).end, 0),
                };
            if (textRange && (targetIds.length !== 1 || textRange.end <= textRange.start))
                throw new Error('invalid_request');
            return {
                action: 'propose',
                editSessionId,
                generationId: nonempty(input.generationId),
                instruction,
                targetIds,
                ...(textRange ? { textRange } : {}),
            };
        }
        case 'cancel-proposal':
            return {
                action: 'cancel-proposal',
                editSessionId,
                generationId: nonempty(input.generationId),
            };
        case 'proposal':
            if (input.choice !== 'accept' && input.choice !== 'reject')
                throw new Error('invalid_request');
            return {
                action: 'proposal',
                editSessionId,
                proposalId: nonempty(input.proposalId),
                choice: input.choice,
            };
        case 'close':
            return { action: 'close', editSessionId };
        case 'export-picture': {
            const objectId = nonempty(input.objectId);
            if (!ID.test(objectId))
                throw new Error('invalid_request');
            return {
                action: 'export-picture',
                editSessionId,
                objectId,
                expectedVersion: boundedInteger(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER),
            };
        }
        case 'select-resource':
            if (!['image', 'audio', 'video'].includes(String(input.kind)))
                throw new Error('invalid_request');
            return {
                action: 'select-resource',
                editSessionId,
                kind: input.kind,
            };
        case 'recovery':
            if (input.choice !== 'restore' && input.choice !== 'discard')
                throw new Error('invalid_request');
            return { action: 'recovery', editSessionId, choice: input.choice };
        case 'save':
            if (!['save', 'save-as', 'external-open'].includes(String(input.mode)))
                throw new Error('invalid_request');
            return {
                action: 'save',
                editSessionId,
                mode: input.mode,
                expectedRevision: boundedInteger(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
            };
        case 'read':
            return { action: 'read', editSessionId, request: decodePptxEditingReadV1(input.request) };
        case 'edit': {
            const command = object(input.command);
            const slice = command.slideIndex === undefined
                ? {}
                : { slideIndex: boundedInteger(command.slideIndex, 0, 10000) };
            if (command.action === 'execute')
                return {
                    action: 'edit',
                    editSessionId,
                    command: {
                        action: 'execute',
                        transaction: decodePptxEditingTransactionV1(command.transaction),
                        ...slice,
                    },
                };
            if (command.action === 'state')
                return { action: 'edit', editSessionId, command: { action: 'state', ...slice } };
            if (command.action === 'undo' || command.action === 'redo')
                return {
                    action: 'edit',
                    editSessionId,
                    command: {
                        action: command.action,
                        expectedRevision: boundedInteger(command.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
                        ...slice,
                    },
                };
            throw new Error('invalid_request');
        }
        default:
            throw new Error('invalid_request');
    }
}
/** Drop malformed status packets before they reach any document owner. */
export function decodePptxEditingStatusV1(value) {
    const input = object(value);
    const editSessionId = nonempty(input.editSessionId);
    if (input.kind === 'performance') {
        if (input.stage !== 'recovery-persist' || !['success', 'failed'].includes(String(input.status)))
            throw new Error('invalid_request');
        for (const [key, max] of [
            ['elapsedMs', 86_400_000],
            ['revision', Number.MAX_SAFE_INTEGER],
            ['bytes', Number.MAX_SAFE_INTEGER],
        ]) {
            const number = input[key];
            if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > max)
                throw new Error('invalid_request');
        }
        return {
            kind: 'performance',
            editSessionId,
            stage: 'recovery-persist',
            status: input.status,
            elapsedMs: boundedInteger(input.elapsedMs, 0, 86_400_000),
            revision: boundedInteger(input.revision, 0, Number.MAX_SAFE_INTEGER),
            bytes: boundedInteger(input.bytes, 0, Number.MAX_SAFE_INTEGER),
        };
    }
    if (input.kind === 'capability') {
        const objectId = nonempty(input.objectId);
        if (!ID.test(objectId) ||
            input.capability !== 'chart-data' ||
            !['ready', 'unsupported'].includes(String(input.state)))
            throw new Error('invalid_request');
        return {
            kind: 'capability',
            editSessionId,
            objectId,
            capability: 'chart-data',
            openEpoch: boundedInteger(input.openEpoch, 1, Number.MAX_SAFE_INTEGER),
            statusSeq: boundedInteger(input.statusSeq, 1, Number.MAX_SAFE_INTEGER),
            documentRevision: boundedInteger(input.documentRevision, 0, Number.MAX_SAFE_INTEGER),
            objectVersion: boundedInteger(input.objectVersion, 0, Number.MAX_SAFE_INTEGER),
            state: input.state,
        };
    }
    if (input.kind !== undefined && input.kind !== 'recovery')
        throw new Error('invalid_request');
    const recovery = object(input.recovery);
    if (['available', 'restored', 'saving', 'failed'].some((key) => typeof recovery[key] !== 'boolean'))
        throw new Error('invalid_request');
    return {
        editSessionId,
        recovery: {
            available: recovery.available,
            restored: recovery.restored,
            saving: recovery.saving,
            failed: recovery.failed,
        },
    };
}
//# sourceMappingURL=pptx-editing.js.map