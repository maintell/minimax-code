import { defineRuntimeTool } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const textReplacement = Type.Object({
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    expectedText: Type.String(),
    text: Type.String(),
});
const nullableNumber = Type.Union([Type.Null(), Type.Number()]);
const nullableString = Type.Union([Type.Null(), Type.String()]);
// Primitive fields mirror GenOffice's public apply_ops contract. The editor
// remains responsible for each operation's allowed fields, targets and bounds.
const operation = Type.Object({
    op: Type.String(),
    target: Type.Optional(Type.Object({
        nodeType: Type.Optional(Type.String()),
        headingLevel: Type.Optional(Type.Integer()),
        containsText: Type.Optional(Type.String()),
        matchCase: Type.Optional(Type.Boolean()),
        blockIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
        scope: Type.Optional(Type.String()),
        range: Type.Optional(Type.Object({ from: Type.Integer(), to: Type.Integer() })),
    })),
    bold: Type.Optional(Type.Boolean()),
    italic: Type.Optional(Type.Boolean()),
    underline: Type.Optional(Type.Boolean()),
    strike: Type.Optional(Type.Boolean()),
    color: Type.Optional(nullableString),
    highlight: Type.Optional(nullableString),
    fontSize: Type.Optional(nullableNumber),
    fontFamily: Type.Optional(nullableString),
    baseline: Type.Optional(nullableString),
    link: Type.Optional(Type.Union([Type.Null(), Type.Object({ url: Type.String() })])),
    align: Type.Optional(nullableString),
    lineSpacing: Type.Optional(nullableNumber),
    indentLeft: Type.Optional(nullableNumber),
    indentRight: Type.Optional(nullableNumber),
    indentFirstLine: Type.Optional(nullableNumber),
    spaceBefore: Type.Optional(nullableNumber),
    spaceAfter: Type.Optional(nullableNumber),
    pageBreakBefore: Type.Optional(Type.Boolean()),
    shadingFill: Type.Optional(nullableString),
    borders: Type.Optional(nullableString),
    level: Type.Optional(Type.Integer()),
    find: Type.Optional(Type.String()),
    replace: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    matchCase: Type.Optional(Type.Boolean()),
    blockIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    afterBlockIndex: Type.Optional(Type.Integer({ minimum: -1 })),
    kind: Type.Optional(Type.String()),
    widthPx: Type.Optional(nullableNumber),
    heightPx: Type.Optional(nullableNumber),
}, { additionalProperties: false });
// Keep nested value types visible to provider argument decoders. An untyped
// Record turns XML tool-call positions into strings and ops into { item: ... }.
const commandInput = Type.Object({
    from: Type.Optional(Type.Integer({ minimum: 0 })),
    to: Type.Optional(Type.Integer({ minimum: 0 })),
    expectedText: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    edits: Type.Optional(Type.Array(textReplacement, { minItems: 1, maxItems: 20 })),
    startBlockIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    endBlockIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    html: Type.Optional(Type.String()),
    ops: Type.Optional(Type.Array(operation, { minItems: 1 })),
    dryRun: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const schema = Type.Object({
    action: Type.Union(['list', 'snapshot', 'read', 'apply', 'save'].map((value) => Type.Literal(value))),
    documentId: Type.Optional(Type.String({
        description: 'Top-level document identity copied from list or snapshot. Never place it inside command.',
    })),
    revision: Type.Optional(Type.Integer({
        minimum: 0,
        description: 'Top-level snapshot revision, used with documentId.',
    })),
    readId: Type.Optional(Type.String({
        description: 'Top-level read credential from snapshot; required for read and apply.',
    })),
    taskId: Type.Optional(Type.String({ description: 'Top-level unique id for one apply attempt; never reuse it.' })),
    command: Type.Optional(Type.Object({
        name: Type.Union([
            'replace_selection',
            'replace_blocks',
            'apply_ops',
            'replace_text',
            'replace_texts',
        ].map((name) => Type.Literal(name))),
        input: commandInput,
    }, { additionalProperties: false })),
    range: Type.Optional(Type.Object({
        startBlockIndex: Type.Integer({ minimum: 0 }),
        endBlockIndex: Type.Integer({ minimum: 0 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
    })),
}, { additionalProperties: false });
const protocolFields = ['documentId', 'revision', 'readId', 'taskId'];
/** commandInput is shared by every command, so accepted fields are enforced per name at runtime. */
function acceptedInputFields(name) {
    switch (name) {
        case 'replace_selection':
            return ['html'];
        case 'replace_blocks':
            return ['startBlockIndex', 'endBlockIndex', 'html'];
        case 'apply_ops':
            return ['ops', 'dryRun'];
        case 'replace_text':
            return ['from', 'to', 'expectedText', 'text'];
        case 'replace_texts':
            return ['edits'];
    }
}
/**
 * Literal unions the model gets wrong most often; TypeBox reports them without
 * the allowed set. Keys are normalized field paths as produced by fieldPath().
 */
const literalChoices = {
    action: 'list, snapshot, read, apply, save',
    'command.name': 'replace_selection, replace_blocks, apply_ops, replace_text, replace_texts',
};
const expectedPhrases = {
    'Expected integer': 'an integer',
    'Expected number': 'a number',
    'Expected string': 'a string',
    'Expected boolean': 'a boolean',
    'Expected array': 'an array',
    'Expected object': 'an object',
    'Expected array length to be greater or equal to 1': 'a non-empty array',
};
function fieldPath(path) {
    return path
        .split('/')
        .filter(Boolean)
        .reduce((acc, segment) => /^\d+$/.test(segment) ? `${acc}[${segment}]` : acc ? `${acc}.${segment}` : segment, '');
}
function describeReceived(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return `string ${JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}…` : value)}`;
    if (typeof value === 'number' || typeof value === 'boolean')
        return `${typeof value} ${value}`;
    if (Array.isArray(value))
        return `an array of ${value.length}`;
    return 'an object';
}
/**
 * A one-line "does not match the schema" gave the model nothing to correct and
 * drove repeated retries, so name the field, the expected type and what arrived.
 */
function describeSchemaError(error) {
    const field = fieldPath(error.path) || 'arguments';
    if (error.message === 'Unexpected property')
        return `${field} is not a supported field (received ${describeReceived(error.value)})`;
    const choices = literalChoices[field];
    const expected = choices
        ? `one of: ${choices}`
        : (expectedPhrases[error.message] ?? error.message.replace(/^Expected /, '').toLowerCase());
    return `${field} must be ${expected} (received ${describeReceived(error.value)})`;
}
function schemaFailure(value) {
    const details = [...Value.Errors(schema, value)].slice(0, 3).map(describeSchemaError).join('; ');
    return `Invalid word_editor arguments: ${details || 'arguments do not match the schema'}. Correct the listed fields and call again; the document was not touched.`;
}
/** Tool arguments arrive as JSON; clone so Value.Convert cannot mutate the caller's object. */
function cloneArguments(value) {
    return JSON.parse(JSON.stringify(value));
}
/**
 * Provider tool calls occasionally place the request envelope inside command.
 * Keep the public contract flat, but repair that unambiguous shape before the
 * request reaches the Desktop broker. Conflicting copies are rejected so a
 * stale document identity can never be silently selected.
 */
function normalizeWordEditorArguments(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Invalid Word editor arguments: expected a JSON object with action and documentId');
    }
    const raw = cloneArguments(args);
    const command = raw.command;
    if (command && typeof command === 'object' && !Array.isArray(command)) {
        const lifted = { ...command };
        for (const field of protocolFields) {
            if (!(field in lifted))
                continue;
            const nestedValue = lifted[field];
            const topLevelValue = raw[field];
            if (topLevelValue !== undefined && topLevelValue !== nestedValue) {
                throw new Error(`word_editor ${field} must be provided at the top level, not inside command`);
            }
            raw[field] = nestedValue;
            delete lifted[field];
        }
        raw.command = lifted;
    }
    // Validate what the model actually sent before converting anything. Convert
    // repairs the quoted numbers and booleans that XML tool decoders emit, but it
    // also wraps a lone object into a one-element array (ops: { item: ... } ->
    // [ ... ]), which would turn a shape mistake into a deeper error about some
    // field the model never sent. Reporting the raw shape is what makes the retry
    // correct instead of another guess.
    let prepared = raw;
    if (!Value.Check(schema, raw)) {
        const converted = cloneArguments(raw);
        Value.Convert(schema, converted);
        if (!Value.Check(schema, converted))
            throw new Error(schemaFailure(raw));
        prepared = converted;
    }
    const checked = prepared;
    if (checked.command) {
        const allowed = acceptedInputFields(checked.command.name);
        const input = (checked.command.input ?? {});
        const stray = Object.keys(input).find((field) => !allowed.includes(field));
        if (stray)
            throw new Error(`Invalid word_editor arguments: command.name ${checked.command.name} does not accept ${stray}. The document was not touched.`);
    }
    if (checked.action !== 'list' && typeof checked.documentId !== 'string') {
        throw new Error('word_editor requires documentId at the top level for every action except list; copy it from list or snapshot');
    }
    return checked;
}
export function createWordEditorExtension(port) {
    const tool = defineRuntimeTool({
        name: 'word_editor',
        source: 'builtin',
        schema,
        // This extension uses @sinclair/typebox; normalize with the same schema
        // implementation before Pi's provider validation (which uses typebox 1.x).
        prepareArguments: normalizeWordEditorArguments,
        description: 'Pass documentId, revision, readId and taskId as top-level fields next to action; command holds only {name, input}. Every position, index, count and flag is a JSON number or boolean, never a quoted string. Read and edit DOCX documents currently open in this Desktop session workspace, including unsaved human input. First call list, then snapshot the returned documentId. Example: {action:"apply", documentId:"<from snapshot>", revision:7, readId:"<from snapshot>", taskId:"<unique>", command:{name:"replace_selection", input:{html:"..."}}}. Read full blocks before rewriting; read ranges use current block indexes. Snapshot returns revision, readId, exact text positions, selection, the supported command schemas and the applyOps usage lines the apply_ops description refers to. Read and apply both require the snapshot revision/readId; apply also requires a unique taskId. The selection is context; the task may affect other document regions. Apply changes directly to this editor, never to an old disk copy. Later human changes cause stale proposals to fail. Save persists current edits and refuses an externally changed file. Do not retry an uncertain mutation; inspect the live state first. A rejected call changes nothing.',
        execute: async (context, input, signal) => {
            try {
                const normalized = normalizeWordEditorArguments(input);
                if (signal?.aborted)
                    throw new Error('Operation canceled');
                const result = await port.execute(context.sessionId, normalized, signal);
                const text = JSON.stringify(result);
                return {
                    tool_name: 'word_editor',
                    text,
                    content: [{ type: 'text', text }],
                    details: { result },
                };
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return {
                    tool_name: 'word_editor',
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                };
            }
        },
    });
    return {
        id: 'workspace-word-editor',
        description: 'Live Word editing in the Desktop workspace.',
        init(api) {
            api.registerTool(() => tool);
        },
    };
}
//# sourceMappingURL=word-editor.js.map