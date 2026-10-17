import { defineRuntimeTool } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const id = Type.String({ minLength: 1 });
const index = Type.Integer({ minimum: 0 });
const schema = Type.Object({
    action: Type.Union(['list', 'snapshot', 'read', 'apply', 'save'].map((value) => Type.Literal(value))),
    documentId: Type.Optional(id),
    revision: Type.Optional(id),
    readId: Type.Optional(id),
    taskId: Type.Optional(id),
    sheetId: Type.Optional(id),
    range: Type.Optional(Type.Object({
        startRow: index,
        endRow: index,
        startColumn: index,
        endColumn: index,
    })),
    edits: Type.Optional(Type.Array(Type.Object({
        sheetId: id,
        row: index,
        column: index,
        value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        formula: Type.Optional(Type.String({ pattern: '^=' })),
    }), { minItems: 1, maxItems: 5000 })),
}, { additionalProperties: false });
export function createExcelEditorExtension(port) {
    const tool = defineRuntimeTool({
        name: 'excel_editor',
        source: 'builtin',
        schema,
        description: 'Read and edit Excel workbooks currently open in this Desktop local session, including unsaved input. Call list, then snapshot(documentId) for revision, readId, sheets, dimensions and current selection. Call read with documentId, revision, readId, sheetId and range {startRow,endRow,startColumn,endColumn}; coordinates are zero-based and inclusive, at most 5000 cells per read. Read every target cell before applying. Apply takes documentId, revision, readId, a unique taskId, and edits [{sheetId,row,column,value,formula?}]. Values are literal strings, finite numbers, booleans or null; formulas start with =. Apply supports cell values and formulas, not sheet structure or formatting, and creates one undo step. Selection comments are context, not write boundaries. Human edits invalidate reads. Apply returns actual editor state; save with a fresh snapshot revision/readId and unique taskId persists the current workbook, refusing external file changes. Do not edit an old disk copy while this editor is open. Repeating an identical taskId returns its original result; after cancellation or an uncertain result inspect live state before doing anything else. Cloud files use ordinary file tools instead.',
        execute: async (context, input, signal) => {
            try {
                if (!Value.Check(schema, input))
                    throw new Error('Invalid excel_editor arguments; use JSON numbers for coordinates and pass request fields at the top level');
                if (input.action !== 'list' && !input.documentId)
                    throw new Error('documentId is required; call list first');
                if (['read', 'apply', 'save'].includes(input.action) && (!input.revision || !input.readId))
                    throw new Error('revision and readId are required; call snapshot first');
                if (input.action === 'read' && (!input.sheetId || !input.range))
                    throw new Error('read requires sheetId and range');
                if (input.action === 'apply' && !input.edits)
                    throw new Error('apply requires edits');
                if (['apply', 'save'].includes(input.action) && !input.taskId)
                    throw new Error('A unique taskId is required');
                if (signal?.aborted)
                    throw new Error('Operation canceled');
                const result = await port.execute(context.sessionId, input, signal);
                const text = JSON.stringify(result);
                return {
                    tool_name: 'excel_editor',
                    text,
                    content: [{ type: 'text', text }],
                    details: { result },
                };
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return {
                    tool_name: 'excel_editor',
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                };
            }
        },
    });
    return {
        id: 'workspace-excel-editor',
        description: 'Live Excel editing in the Desktop workspace.',
        init(api) {
            api.registerTool(() => tool);
        },
    };
}
//# sourceMappingURL=excel-editor.js.map