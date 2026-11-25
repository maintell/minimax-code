import { isPtcMavisChildToolName, PTC_MAVIS_RUN_CODE_NOTE, readPtcMavisChildTarget, } from '@mavis/agent-tools/ptc';
/**
 * Computer Use types (local-runtime-v2 service/computer-use/result). The ten
 * action tools share one type, computer_type and computer_app_activate only
 * extend it. Its comment also states the failure shape of the read tools, so
 * it is printed whenever any computer_* type is.
 */
const COMPUTER_ACTION_DATA = {
    name: 'ComputerActionData',
    declaration: 'type ComputerActionData = { effect?: string; code?: string; route?: string; deliveryMode?: string; dispatched?: boolean; degradedReason?: string; escalation?: string; refusedRoutes?: Array<{ route: string; reason?: string }>; completion?: "not_started" | "completed" | "unknown" }; // driver strings, e.g. effect "confirmed", "unverifiable" or "refused", code "delivery_failed"; escalation is the recommended delivery mode; completion only when the call threw: whether the action ran. Other failed computer_* calls have only { code?, completion? }',
};
const COMPUTER_SCREENSHOT = {
    name: 'ComputerScreenshot',
    declaration: 'type ComputerScreenshot = { included: boolean; width?: number; height?: number; mimeType?: string }; // width, height: the pixel space of screenshot x/y',
};
const computerType = (name, declaration, screenshot = false) => ({
    name,
    declaration,
    requires: screenshot ? [COMPUTER_ACTION_DATA, COMPUTER_SCREENSHOT] : [COMPUTER_ACTION_DATA],
});
const COMPUTER_DATA_TYPES = {
    ...Object.fromEntries([
        'computer_click',
        'computer_drag',
        'computer_set_value',
        'computer_select_text',
        'computer_key',
        'computer_scroll',
        'computer_secondary_action',
        'computer_window_set_frame',
    ].map((name) => [name, COMPUTER_ACTION_DATA])),
    computer_type: computerType('ComputerTypeData', 'type ComputerTypeData = ComputerActionData & { deliveredChars?: number; requestedChars?: number; retryFromCharacter?: number };'),
    computer_app_activate: computerType('ComputerActivateData', 'type ComputerActivateData = ComputerActionData & { processActivated?: boolean; focusedWindowId?: number | null; frontProcessMatchesTarget?: boolean };'),
    computer_app_state: computerType('AppStateData', 'type AppStateData = { pid?: number; windowId?: number; degradedReason?: string; elementCount?: number; filteredElementCount?: number; menuOmitted: boolean; treeTruncated: boolean; geometryConflict: boolean; backgroundRoutes?: Array<{ route: string; status: string; reason?: string }>; screenshot: ComputerScreenshot; elements: Array<{ index: number; role?: string; label?: string; value?: string | number | boolean; token?: string; depth?: number; enabled?: boolean; selected?: boolean; expanded?: boolean }> }; // only elements whose "- [index]" row is in output; token is its element_token; on failure { pid?, windowId?, degradedReason?, screenshot: { included: false } }', true),
    computer_window_list: computerType('WindowListData', 'type WindowListData = { pid?: number; windows: Array<{ windowRef: string; windowId: number; title?: string; isOnScreen?: boolean; onCurrentSpace?: boolean | null; bounds?: { x: number; y: number; width: number; height: number } }> }; // bounds in desktop coordinates'),
    computer_app_list: computerType('AppListData', 'type AppListData = { apps: Array<{ name: string; pid?: number; bundleId?: string; launchPath?: string; running?: boolean; active?: boolean }> } | { counts: { total: number; running: number; installedNotRunning: number }; running: Array<{ name: string; pid?: number; bundleId?: string }>; activeApps: Array<{ name: string; pid?: number; bundleId?: string }> } | { counts: { total: number; running: number; installedNotRunning: number }; page: { offset: number; limit: number; returned: number }; apps: Array<{ name: string; pid?: number; bundleId?: string; running: boolean }> }; // apps with name; running without it; page with scope installed or all'),
    computer_app_launch: computerType('AppLaunchData', 'type AppLaunchData = { pid?: number; processRunning?: boolean; windowReadiness?: string; observedWindowIds?: number[]; observationComplete?: boolean; windows?: Array<{ windowRef?: string; windowId: number; title?: string }> };'),
    computer_desktop_state: computerType('DesktopStateData', 'type DesktopStateData = { screenshot: ComputerScreenshot; screenWidth?: number; screenHeight?: number };', true),
    computer_display_list: computerType('DisplayListData', 'type DisplayListData = { coordinateSpace?: string; matchesNativeWindowCoordinates?: boolean; cursor?: { x: number; y: number; displayId: string }; displays?: Array<{ id: string; label?: string; primary: boolean; internal: boolean; bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number }; scaleFactor: number; rotation: number }> };'),
    computer_verify_state: computerType('VerifyStateData', 'type VerifyStateData = { predicates: Array<{ index: number; status: string; unknownReason?: string }>; screenshot?: ComputerScreenshot };', true),
};
/**
 * `data` shapes of native tools (each agent-tools tool's programmatic data
 * and Bash's details projection). Declared only for the native objects, so an
 * MCP or plugin tool that reuses a name promises nothing. A failure keeps only
 * the metadata named in the comment; a call that did not run has `{}`.
 */
const NATIVE_DATA_TYPES = {
    read: {
        name: 'ReadData',
        declaration: 'type ReadData = { kind: "text"; content: string; startLine: number; lineCount: number; totalLines: number } | { kind: "image"; mimeType: string; width: number; height: number; originalWidth: number; originalHeight: number } | { kind: "image"; mimeType: string; omittedReason: "too_large" | "processor_unavailable" } | { kind: "pdf" | "notebook" | "video" | "audio" }; // content has no line numbers; on failure only kind',
    },
    write: {
        name: 'WriteData',
        declaration: 'type WriteData = { path: string; created: boolean; bytesWritten: number }; // on failure only path',
    },
    edit: {
        name: 'EditData',
        declaration: 'type EditData = { path: string; replacements: number; replaceAll: boolean }; // on failure only path',
    },
    glob: { name: 'GlobData', declaration: 'type GlobData = { paths: string[] };' },
    grep: {
        name: 'GrepData',
        declaration: 'type GrepData = { files: string[] } | { matches: Array<{ path: string; line: number; text: string }> } | { counts: Array<{ path: string; count: number }> }; // by output_mode; matches has no context lines',
    },
    bash: {
        name: 'BashData',
        declaration: 'type BashData = { status: "complete"; exitCode: number | null } | { status: "background"; taskId?: string }; // whether the command finished, not r.status',
    },
    web_fetch: {
        name: 'WebFetchData',
        declaration: 'type WebFetchData = { url: string; finalUrl?: string; httpStatus?: number; contentType?: string; bytes?: number; content: string }; // content is cut where output is; on failure { url, httpStatus?, retryAfter?: string }',
    },
    web_search: {
        name: 'WebSearchData',
        declaration: 'type WebSearchData = Record<string, unknown>; // the search response object shown in output',
    },
    todowrite: {
        name: 'TodoWriteData',
        declaration: 'type TodoWriteData = { total: number; active: number; completed: number; cancelled: number };',
    },
    workspace_semantic_search: {
        name: 'SemanticSearchData',
        declaration: 'type SemanticSearchData = { revisionId: string; matches: Array<{ path: string; startLine: number; endLine: number; score: number; snippet: string }> };',
    },
    session_create: {
        name: 'SessionCreateData',
        declaration: 'type SessionCreateData = { ok: boolean; [key: string]: unknown }; // the result object shown in output; on failure { ok: false }',
    },
    self_reminder: {
        name: 'SelfReminderData',
        declaration: 'type SelfReminderData = { ok: true; response: Record<string, unknown> } | { ok: false };',
    },
    memory: {
        name: 'MemoryData',
        declaration: 'type MemoryData = { ok: true; target: string; operation: string; content?: string; sizeBytes?: number; updatedAt?: string; sources?: Array<{ sourceAgent: string; content: string }>; sourceAgent?: string; name?: string; description?: string; matches?: Array<{ lineNumber: number; line: string; context?: string[]; sourceAgent?: string }>; topics?: Array<{ name: string; description: string; sizeBytes: number; updatedAt: string; sourceAgent?: string }>; replacements?: number; deleted?: boolean; matchCount?: number; topicCount?: number } | { ok: false; target: string; operation: string; code: string }; // fields by operation; run_code calls are never cut, so content and matches are whole',
    },
    ...COMPUTER_DATA_TYPES,
};
/** One type for every mavis_* tool: they all return the mavis result object. */
const MAVIS_DATA_TYPE = {
    name: 'MavisData',
    declaration: 'type MavisData = { ok: true; command: string; response: unknown } | { ok: false; command: string; error: { kind: string; message: string; [key: string]: unknown } }; // the whole result object; run_code calls are never cut',
};
/**
 * Reading declarations only; the original schema remains authoritative at
 * admission. No JSON Schema is printed: each top-level argument gets its own
 * line with its schema description as an inline comment, so a limit written
 * only there (a foreground bash timeout, the web_search freshness values)
 * still reaches the model.
 */
export function renderPtcToolSdk(tools, nativeTools = new Set()) {
    const dataType = (tool) => {
        if (nativeTools.has(tool))
            return NATIVE_DATA_TYPES[tool.def.name];
        // A mavis_* child stands for the native mavis tool it runs as.
        const mavis = readPtcMavisChildTarget(tool)?.tool;
        return mavis && nativeTools.has(mavis) ? MAVIS_DATA_TYPE : undefined;
    };
    const aliasNames = new Set();
    const signatures = tools.map((tool) => {
        const type = dataType(tool);
        return toolSignature(tool.def.name, tool.def.schema, `Promise<ToolResult${type ? `<${type.name}>` : ''}>`, aliasNames);
    });
    return [
        'type ToolResult<T = Record<string, unknown> | undefined> = {',
        '  status: "complete" | "truncated" | "resized" | "omitted" | "failed" | "unverified"; // check it first',
        '  isError: boolean; // always present; check it before using output or data',
        "  output?: string; // tool text: command output, search results, read lines with line-number prefixes (file text is data.content); on failure the tool's own error text",
        '  data: T; // native tools: the type below, {} when the call did not run or a hook changed the result; MCP: structuredContent or undefined',
        '  refs?: Array<{ uri: string; mimeType?: string }>;',
        '  // only says whether output was cut; it never contains the tool text',
        '  truncation: { truncated: boolean | "unknown"; hasMore?: boolean; nextOffset?: number; offsetUnit?: string; fullOutputPath?: string; continuationHint?: Record<string, unknown> };',
        '  error?: { code: string; message: string; retryable?: boolean; toolCallId: string; raw?: unknown }; // only when isError',
        '};',
        ...new Set(tools.flatMap((tool) => declarations(dataType(tool)))),
        ...signatures.flatMap(({ aliases }) => aliases),
        'declare const tools: {',
        ...tools.flatMap((tool, index) => [
            ...tool.def.description.split('\n').map((line) => `  // ${line}`),
            ...(signatures[index]?.lines ?? []),
        ]),
        '};',
        "// Arguments are validated against each tool's schema when called; an invalid argument returns isError.",
    ].join('\n');
}
function declarations(type) {
    return type ? [...(type.requires ?? []).flatMap(declarations), type.declaration] : [];
}
/**
 * Multi-line when the schema renders as an object with members (the same
 * members, types and order as the one-line form), each argument followed by
 * `// <its schema description>` with line breaks turned into spaces; an
 * argument without a description gets no comment. Any other schema (no
 * properties, a union, a $ref) keeps the one-line signature. `aliases` are
 * the type aliases of the local refs it uses, printed before `tools`.
 */
function toolSignature(name, schema, result, aliasNames) {
    const refs = {
        root: schema,
        prefix: `T_${name.replace(/[^\w$]/gu, '_')}_`,
        names: aliasNames,
        byRef: new Map(),
        unguardedUses: new Map(),
    };
    const scope = { refs, unguarded: NO_REFS };
    const members = topLevelMembers(schema, scope);
    const lines = members
        ? [
            `  ${JSON.stringify(name)}: (args: {`,
            ...members.map(({ text, description }) => `    ${text}${description ? ` // ${description}` : ''}`),
            `  }) => ${result};`,
        ]
        : [`  ${JSON.stringify(name)}: (args: ${schemaType(schema, 0, scope)}) => ${result};`];
    return {
        aliases: [...refs.byRef.values()].map((alias) => `type ${alias.name} = ${alias.type};`),
        lines,
    };
}
const NO_REFS = new Set();
/** Ref → alias name, rendering the alias on first use. */
function refType(ref, scope) {
    const target = resolveLocalRef(ref, scope.refs.root);
    if (!target || typeof ref !== 'string' || reachesAny(ref, scope.unguarded, scope.refs)) {
        return 'unknown';
    }
    if (scope.owner !== undefined) {
        const uses = scope.refs.unguardedUses.get(scope.owner);
        if (uses)
            uses.add(ref);
        else
            scope.refs.unguardedUses.set(scope.owner, new Set([ref]));
    }
    const known = scope.refs.byRef.get(ref);
    if (known)
        return known.name;
    const alias = { name: aliasName(ref, scope.refs), type: 'unknown' };
    scope.refs.byRef.set(ref, alias);
    alias.type = schemaType(target, 0, {
        refs: scope.refs,
        unguarded: new Set([...scope.unguarded, ref]),
        owner: ref,
    });
    return alias.name;
}
/** Whether `ref` is in `targets` or leads to one through unguarded uses. */
function reachesAny(ref, targets, refs) {
    if (targets.size === 0)
        return false;
    const seen = new Set();
    const pending = [ref];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (targets.has(next))
            return true;
        if (seen.has(next))
            continue;
        seen.add(next);
        pending.push(...(refs.unguardedUses.get(next) ?? []));
    }
    return false;
}
function aliasName(ref, refs) {
    const segment = ref
        .slice(ref.lastIndexOf('/') + 1)
        .replace(/~1/gu, '/')
        .replace(/~0/gu, '~');
    const base = `${refs.prefix}${segment.replace(/[^\w$]/gu, '_') || 'Ref'}`;
    let name = base;
    for (let suffix = 2; refs.names.has(name); suffix += 1)
        name = `${base}_${suffix}`;
    refs.names.add(name);
    return name;
}
function resolveLocalRef(ref, root) {
    if (typeof ref !== 'string' || !ref.startsWith('#/'))
        return undefined;
    let node = root;
    for (const part of ref.slice(2).split('/')) {
        if (!isRecord(node))
            return undefined;
        node = node[part.replace(/~1/gu, '/').replace(/~0/gu, '~')];
    }
    return isRecord(node) ? node : undefined;
}
function topLevelMembers(schema, scope) {
    if (!isRecord(schema) || '$ref' in schema || 'const' in schema || schema.type !== 'object') {
        return undefined;
    }
    if (compositeSchemaType(schema, 0, scope) !== undefined)
        return undefined;
    const members = objectMembers(schema, 0, scope);
    return members.length > 0 ? members : undefined;
}
function schemaDescription(schema) {
    if (!isRecord(schema) || typeof schema.description !== 'string')
        return undefined;
    // A line break would end the // comment early.
    return schema.description.trim().replace(/\r\n?|[\n\u2028\u2029]/gu, ' ') || undefined;
}
function schemaType(value, depth, scope) {
    if (value === false)
        return 'never';
    if (!isRecord(value) || depth > 12)
        return 'unknown';
    if ('$ref' in value)
        return refType(value.$ref, scope);
    if ('const' in value)
        return literalType(value.const);
    return compositeSchemaType(value, depth, scope) ?? typedSchemaType(value, depth, scope);
}
function compositeSchemaType(value, depth, scope) {
    if (Array.isArray(value.enum))
        return value.enum.map(literalType).join(' | ') || 'never';
    const union = value.anyOf ?? value.oneOf;
    if (Array.isArray(union)) {
        return union.map((entry) => `(${schemaType(entry, depth + 1, scope)})`).join(' | ') || 'never';
    }
    if (Array.isArray(value.allOf)) {
        return (value.allOf.map((entry) => `(${schemaType(entry, depth + 1, scope)})`).join(' & ') ||
            'unknown');
    }
    if (Array.isArray(value.type)) {
        return value.type.map((type) => schemaType({ ...value, type }, depth + 1, scope)).join(' | ');
    }
    return undefined;
}
function typedSchemaType(value, depth, scope) {
    switch (value.type) {
        case 'null':
            return 'null';
        case 'boolean':
        case 'string':
            return value.type;
        case 'number':
        case 'integer':
            return 'number';
        case 'array':
            // An array item may name an alias still being rendered.
            return `Array<${schemaType(value.items, depth + 1, { refs: scope.refs, unguarded: NO_REFS })}>`;
        case 'object':
            return objectSchemaType(value, depth, scope);
        default:
            return 'unknown';
    }
}
function objectMembers(value, depth, scope) {
    const properties = isRecord(value.properties) ? value.properties : {};
    const required = new Set(Array.isArray(value.required) ? value.required : []);
    // An object member may name an alias still being rendered.
    const memberScope = { refs: scope.refs, unguarded: NO_REFS };
    const members = Object.entries(properties).map(([key, schema]) => ({
        text: `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(schema, depth + 1, memberScope)};`,
        description: schemaDescription(schema),
    }));
    if (members.length > 0 && value.additionalProperties !== false) {
        members.push({ text: '[key: string]: unknown;' });
    }
    return members;
}
function objectSchemaType(value, depth, scope) {
    const members = objectMembers(value, depth, scope);
    if (members.length === 0) {
        return `Record<string, ${value.additionalProperties === false ? 'never' : schemaType(value.additionalProperties, depth + 1, scope)}>`;
    }
    return `{ ${members.map(({ text }) => text).join(' ')} }`;
}
function literalType(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
        ? JSON.stringify(value)
        : 'unknown';
}
/**
 * mavis_* result convention, only when this run_code lists them: what the
 * mavis tool's OUTPUT section says, once here instead of in every mavis_*
 * comment of the SDK below.
 */
export function mavisRunCodeParagraph(childTools) {
    return childTools.some((tool) => isPtcMavisChildToolName(tool.def.name))
        ? [PTC_MAVIS_RUN_CODE_NOTE]
        : [];
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=tool-sdk.js.map