import { Type } from '@sinclair/typebox';
import { buildOrReuseIndex, mcpServerOfToolName, serverOfToolEntry } from './search-index.js';
const NO_DEVIATION = new Map();
/** What a declaration depends on; any difference is a changed definition. */
export function toolDefinitionSignature(def) {
    return JSON.stringify([def.description, def.schema, def.loading ?? null]);
}
export function toolSearchWindowFingerprint(options, model, ptc) {
    // `estimateTokens` is a function and drops out; every other option shapes the plan.
    // The context window does not, though it caps the fixed budget when known: the window
    // keeps the deferral it started with, and switching 512k to 1M on the same model must
    // not restart it.
    return JSON.stringify({ options, model: { provider: model.provider, id: model.id }, ptc });
}
/**
 * The window of a freshly planned Turn: the start of a Session's window, or a
 * new one after `reset`. Nothing differs from a window that just started.
 */
export function startToolSearchWindow(plan, input) {
    const byTool = new Map(input.entries.map((entry) => [entry.tool, entry]));
    const freeze = (entry) => [
        entry.tool.def.name,
        { ...entry, signature: toolDefinitionSignature(entry.tool.def) },
    ];
    const inline = plan.inlineTools.flatMap((tool) => {
        const entry = byTool.get(tool);
        return entry && input.isCandidate(entry) ? [freeze(entry)] : [];
    });
    const window = {
        fingerprint: input.fingerprint,
        ...(plan.autoDecision ? { autoDecision: plan.autoDecision } : {}),
        inlineOrder: plan.inlineTools.map((tool) => tool.def.name),
        inline: new Map(inline),
        deferred: new Map(plan.deferred ? plan.deferredEntries.map(freeze) : []),
        gateways: input.gatewaysExposed || plan.deferred,
    };
    return {
        window,
        event: input.reset ? 'reset' : 'started',
        ...(input.reset ? { reset: input.reset } : {}),
        deviation: NO_DEVIATION,
    };
}
/**
 * The notice this Turn's user message carries, if any: when the deviation
 * differs from the last told one, or when what was told is unknown and there is
 * a deviation to state or an earlier notice to supersede. `changedInWindow` is
 * given only when the window continues; without it the window restarted (or
 * Tool Search is off), so nothing can revert to a catalog the model never saw.
 */
export function toolAvailabilityNotice(told, deviation, outside, entries, changedInWindow) {
    const last = told.snapshot;
    const due = last ? !sameDeviations(last, deviation) : deviation.size > 0 || told.everTold;
    if (!due)
        return undefined;
    const named = (status) => [...deviation].flatMap(([name, entry]) => (entry.status === status ? [name] : [])).sort();
    const present = new Set(entries.map((entry) => entry.tool.def.name));
    const unavailable = named('removed');
    const asShown = (name) => !deviation.has(name) && present.has(name);
    const back = (statuses) => [...(last ?? [])]
        .flatMap(([name, entry]) => (statuses.includes(entry.status) && asShown(name) ? [name] : []))
        .sort();
    return {
        deviation,
        added: outside,
        unavailable,
        unavailableServers: wholeServersGone(unavailable, deviation, entries),
        changed: named('changed'),
        availableAgain: back(changedInWindow ? ['removed'] : ['removed', 'changed']),
        // Announced as changed in this window and as shown now, unless the last known
        // notice already said so (it did not list them).
        reverted: [...(changedInWindow ?? [])]
            .filter((name) => asShown(name) && (last === undefined || last.has(name)))
            .sort(),
    };
}
/**
 * The servers none of whose tools is present, each with its unavailable tools (two or more).
 * A live tool counts under its server and its name prefix, so a server known by
 * either never reads as wholly gone while one of its tools is present.
 */
function wholeServersGone(unavailable, deviation, entries) {
    const live = new Set(entries.flatMap((entry) => [
        serverOfToolEntry(entry),
        mcpServerOfToolName(entry.tool.def.name),
    ]));
    const gone = new Map();
    for (const name of unavailable) {
        const server = deviation.get(name)?.server;
        if (server === undefined || live.has(server))
            continue;
        gone.set(server, [...(gone.get(server) ?? []), name]);
    }
    return new Map([...gone].filter(([, names]) => names.length > 1));
}
function sameDeviations(a, b) {
    if (a.size !== b.size)
        return false;
    for (const [name, entry] of a) {
        const other = b.get(name);
        if (other?.status !== entry.status || other.signature !== entry.signature)
            return false;
    }
    return true;
}
/**
 * A present tool outside the window: added, or changed when the last told
 * notice listed it with another definition (and stays changed while that holds).
 */
function outsideStatus(last, signature) {
    if (!last || last.status === 'removed')
        return 'added';
    return last.status === 'changed' || last.signature !== signature ? 'changed' : 'added';
}
/**
 * The deviation of a tool that disappeared. Its server is the frozen entry's, or
 * the one a notice announced it with; the name prefix only when neither is known.
 */
function removedDeviation(name, frozen, announcedServer) {
    const server = frozen
        ? serverOfToolEntry(frozen)
        : (announcedServer ?? mcpServerOfToolName(name));
    return { status: 'removed', ...(server === undefined ? {} : { server }) };
}
function withServer(entry) {
    const server = serverOfToolEntry(entry);
    return server === undefined ? {} : { server };
}
/**
 * Plans a later Turn of `window` against the current inventory, or says why the
 * window cannot continue.
 */
export function continueToolSearchWindow(window, session, input) {
    const inline = [];
    const deferred = [];
    const deviation = new Map();
    const outside = [];
    const present = new Set();
    const changedInline = [];
    const reloaded = [];
    for (const entry of input.entries) {
        const name = entry.tool.def.name;
        present.add(name);
        const declared = window.inline.get(name);
        const frozen = declared ?? window.deferred.get(name);
        if (!input.isCandidate(entry)) {
            if (frozen)
                reloaded.push(name);
            inline.push(entry.tool);
        }
        else if (declared) {
            if (declared.signature !== toolDefinitionSignature(entry.tool.def))
                changedInline.push(name);
            inline.push(entry.tool);
        }
        else {
            deferred.push(entry);
            const signature = toolDefinitionSignature(entry.tool.def);
            if (!frozen) {
                outside.push(entry);
                const status = outsideStatus(session.told.snapshot?.get(name), signature);
                deviation.set(name, { status, signature, ...withServer(entry) });
            }
            else if (frozen.signature !== signature) {
                deviation.set(name, { status: 'changed', signature, ...withServer(entry) });
            }
        }
    }
    if (reloaded.length > 0)
        return { reset: { reason: 'loading changed', tools: reloaded } };
    if (changedInline.length > 0) {
        return { reset: { reason: 'inline definition changed', tools: changedInline } };
    }
    // Every tool the model knows of in this window and cannot reach any more.
    const registry = new Map(deferred.map((entry) => [entry.tool.def.name, entry.tool]));
    // Tools the window declared keep its order even when the inventory lists them
    // differently; tools it did not declare keep their places.
    const rank = new Map(window.inlineOrder.map((name, index) => [name, index]));
    const slots = inline.flatMap((tool, index) => (rank.has(tool.def.name) ? [index] : []));
    const declaredInOrder = slots
        .flatMap((index) => inline.slice(index, index + 1))
        .sort((a, b) => (rank.get(a.def.name) ?? 0) - (rank.get(b.def.name) ?? 0));
    declaredInOrder.forEach((tool, at) => inline.splice(slots[at] ?? at, 1, tool));
    for (const name of window.inlineOrder) {
        const declared = window.inline.get(name);
        if (!declared || present.has(name))
            continue;
        deviation.set(name, removedDeviation(name, declared, undefined));
        insertAtDeclaredSlot(inline, unavailableTool(declared.tool, name, true), window.inlineOrder);
    }
    // Catalog tools and tools a sent notice added: the model knows of them.
    for (const name of new Set([...window.deferred.keys(), ...session.addedInWindow.keys()])) {
        if (present.has(name) || window.inline.has(name))
            continue;
        const announced = session.told.snapshot?.get(name)?.server ?? session.addedInWindow.get(name);
        deviation.set(name, removedDeviation(name, window.deferred.get(name), announced));
        registry.set(name, unavailableTool(window.deferred.get(name)?.tool, name, false));
    }
    if (registry.size > 0 && !input.gatewaysExposed && !window.gateways) {
        return { reset: { reason: 'tool_search gateway needed', tools: [...registry.keys()] } };
    }
    const outcome = { window, event: 'continued', deviation };
    const notice = toolAvailabilityNotice(session.told, deviation, outside, input.entries, session.changedInWindow);
    const extras = {
        ...(window.autoDecision ? { autoDecision: window.autoDecision } : {}),
        window: outcome,
        ...(notice ? { availability: notice } : {}),
    };
    if (registry.size === 0) {
        return { plan: { deferred: false, inlineTools: inline, ...extras } };
    }
    const index = buildOrReuseIndex(deferred, { maxSchemaTextLen: input.maxSchemaTextLen });
    return {
        plan: {
            deferred: true,
            inlineTools: inline,
            // Removed tools stay here so a call names them as gone; the index omits them.
            deferredRegistry: registry,
            index,
            deferredEntries: deferred,
            stats: input.stats(deferred),
            ...extras,
        },
    };
}
/**
 * Puts a stand-in where the window declared its tool: right after the nearest
 * tool declared before it that is still listed, so an otherwise unchanged list
 * keeps its order.
 */
function insertAtDeclaredSlot(tools, stub, order) {
    const before = new Set(order.slice(0, order.indexOf(stub.def.name)));
    let at = 0;
    tools.forEach((tool, index) => {
        if (before.has(tool.def.name))
            at = index + 1;
    });
    tools.splice(at, 0, stub);
}
/**
 * Stands in for a tool that disappeared within the window. A declared one keeps
 * its frozen definition (the declaration must not change); a deferred one accepts
 * any arguments, so the call reaches this error rather than a validation error.
 */
function unavailableTool(frozen, name, declared) {
    const text = `${name} is not available in this session right now (disconnected, disabled or not permitted). It may come back; do not call it unless a later update says it is available again.`;
    const def = declared && frozen
        ? frozen.def
        : { name, description: frozen?.def.description ?? '', schema: Type.Object({}) };
    return {
        ...(frozen ?? {}),
        source: frozen?.source ?? 'configured',
        def,
        impl: {
            execute: async () => ({
                tool_name: name,
                text,
                content: [{ type: 'text', text }],
                isError: true,
            }),
        },
    };
}
//# sourceMappingURL=window.js.map