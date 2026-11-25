import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ELEMENT_CATALOG } from '@mavis/shared/plugin-extension';
import { analyzeCtxUsage } from './ctx-usage.js';
import { analyzeRegistration } from './registration.js';
import { StateCollector } from './state.js';
import { diagnosticAt, findJsxPragmaDiagnostics, loadTypeScript, parseSource } from './syntax.js';
const CALLBACK_PROPS = new Set(Object.values(ELEMENT_CATALOG).flatMap((spec) => spec.callbacks));
/**
 * preview ② syntax-level scan (three.md §2.2): entries, `hooks:`, `calls:` and `state:` from
 * the source, without a type checker and without running plugin code.
 */
export async function scanExtensionSources(input) {
    const typescript = await loadTypeScript();
    const sources = new Map();
    const parse = async (file) => {
        const cached = sources.get(file);
        if (cached)
            return cached;
        const sourceFile = parseSource(typescript, file, await readSource(input.root, file));
        sources.set(file, sourceFile);
        return sourceFile;
    };
    const registration = analyzeRegistration(typescript, await parse(input.entry), input.siteTable);
    const diagnostics = [...registration.diagnostics];
    const calls = [];
    for (const file of input.files) {
        const sourceFile = await parse(file);
        const usage = analyzeCtxUsage(usageInput(typescript, sourceFile, file === input.entry, registration));
        calls.push(...usage.calls);
        diagnostics.push(...usage.diagnostics);
    }
    const state = new StateCollector(typescript);
    for (const file of new Set([...input.files, ...(input.stateFiles ?? [])])) {
        state.collect(await parse(file));
    }
    diagnostics.push(...state.diagnostics, ...shadowingWarnings(registration));
    return {
        entries: registration.entries,
        bindings: registration.bindings,
        hooks: registration.hooks,
        calls: summarizeCalls(calls),
        state: state.fields,
        diagnostics: sortDiagnostics(diagnostics),
    };
}
/** Rejects `@jsx*` pragmas that would override the host JSX settings. */
export async function scanJsxPragmas(root, files) {
    const typescript = await loadTypeScript();
    const diagnostics = [];
    for (const file of files) {
        const sourceFile = parseSource(typescript, file, await readSource(root, file));
        diagnostics.push(...findJsxPragmaDiagnostics(typescript, sourceFile));
    }
    return sortDiagnostics(diagnostics);
}
export function sortDiagnostics(diagnostics) {
    return [...diagnostics].sort((left, right) => (left.file ?? '').localeCompare(right.file ?? '') ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.column ?? 0) - (right.column ?? 0));
}
async function readSource(root, file) {
    return readFile(path.join(root, ...file.split('/')), 'utf8');
}
function usageInput(typescript, sourceFile, isEntry, registration) {
    const base = { typescript, sourceFile, callbackProps: CALLBACK_PROPS };
    if (!isEntry)
        return base;
    return {
        ...base,
        hooks: registration.hookRoles,
        acceptedOnCallees: registration.acceptedOnCallees,
        ...(registration.register ? { register: registration.register } : {}),
    };
}
/** A layered render hook that never references `next` hides inner layers and the host default. */
function shadowingWarnings(registration) {
    return [...registration.hookRoles.values()]
        .filter((role) => role.layered && !role.nextUsed)
        .map((role) => diagnosticAt('EXTENSION_SHADOWING', role.sourceFile, role.node, 'hook never calls `next`'));
}
/** `calls:` lists `mcp.call` per server; the tool is kept only when every call names it. */
function summarizeCalls(calls) {
    const serverWide = new Set(calls
        .filter((call) => call.server !== undefined && call.tool === undefined)
        .map((call) => call.server));
    const byLabel = new Map();
    for (const call of calls) {
        const scanned = toScannedCall(call, serverWide);
        byLabel.set(scanned.label, scanned);
    }
    return [...byLabel.values()].sort((left, right) => left.label.localeCompare(right.label));
}
function toScannedCall(call, serverWide) {
    const name = `${call.domain}.${call.method}`;
    if (call.server === undefined)
        return { domain: call.domain, method: call.method, label: name };
    const tool = serverWide.has(call.server) ? undefined : call.tool;
    return {
        domain: call.domain,
        method: call.method,
        server: call.server,
        ...(tool === undefined ? {} : { tool }),
        label: tool === undefined ? `${name}(${call.server})` : `${name}(${call.server}, ${tool})`,
    };
}
//# sourceMappingURL=scan.js.map