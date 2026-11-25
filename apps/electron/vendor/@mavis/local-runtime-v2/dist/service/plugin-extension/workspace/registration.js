import { isUiRenderSite, UI_RENDER_EVENT, UI_RENDER_MATCHER_FIELDS, } from '@mavis/shared/plugin-extension';
import { createExtensionDiagnostic, } from '../sdk/diagnostics.js';
import { isObserveEventName, observeEventSpec, } from '../sdk/contracts/events.js';
import { diagnosticAt, isFunctionWithBody, isInlineFunction, literalString, propertyNameText, unwrapExpression, } from './syntax.js';
/**
 * Reads `register(on)` in the entry module: every `on()` call directly at the top level of its
 * body, with literal slot and matcher (one.md §4 写法规则, three.md §2.2 entries / `hooks:`).
 * For `on('ui.render', { site }, hook)` the entries are the literal `key`s of the `Button`s the
 * hook writes; the host checks the evaluated drawing itself.
 */
export function analyzeRegistration(t, sourceFile, siteTable) {
    return new RegistrationReader(t, sourceFile, siteTable).read();
}
class RegistrationReader {
    t;
    sourceFile;
    siteTable;
    hookRoles = new Map();
    acceptedOnCallees = new Set();
    entries = [];
    bindings = [];
    hooks = [];
    diagnostics = [];
    seenIds = new Set();
    drawnSites = new Set();
    constructor(t, sourceFile, siteTable) {
        this.t = t;
        this.sourceFile = sourceFile;
        this.siteTable = siteTable;
    }
    read() {
        const register = findRegister(this.t, this.sourceFile);
        if (!register) {
            this.diagnostics.push(createExtensionDiagnostic('HOOK_MODULE_EXPORT_INVALID', {
                file: this.sourceFile.fileName,
                line: 1,
                column: 1,
            }));
            return this.result();
        }
        this.readBody(register);
        return { ...this.result(), register };
    }
    result() {
        return {
            hookRoles: this.hookRoles,
            acceptedOnCallees: this.acceptedOnCallees,
            entries: this.entries,
            bindings: this.bindings,
            hooks: this.hooks,
            diagnostics: this.diagnostics,
        };
    }
    report(code, node, detail) {
        this.diagnostics.push(diagnosticAt(code, this.sourceFile, node, detail));
    }
    readBody(register) {
        const t = this.t;
        const onParameter = register.parameters[0];
        const body = register.body;
        if (!onParameter || !body)
            return;
        if (!t.isIdentifier(onParameter.name)) {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', onParameter, '`on` must be a plain parameter');
            return;
        }
        const statements = t.isBlock(body) ? body.statements : [body];
        let afterAwait = false;
        for (const statement of statements) {
            const call = topLevelOnCall(t, statement, onParameter.name.text);
            if (call && !afterAwait) {
                this.acceptedOnCallees.add(call.expression);
                this.readOnCall(call);
            }
            if (containsAwait(t, statement))
                afterAwait = true;
        }
    }
    readOnCall(call) {
        const args = call.arguments;
        if (args.some((argument) => this.t.isSpreadElement(argument))) {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', call, '`on()` arguments must not be spread');
            return;
        }
        const slot = args[0] && literalString(this.t, args[0]);
        if (slot === UI_RENDER_EVENT) {
            this.readUiRenderCall(call);
            return;
        }
        const site = slot === undefined ? undefined : this.siteTable.get(slot);
        if (site && !isUiRenderSite(site)) {
            this.readSiteCall(call, site);
            return;
        }
        if (slot !== undefined && isObserveEventName(slot)) {
            this.readObserveCall(call, slot);
            return;
        }
        this.reportUnsupported(call, slot, site);
    }
    /** A `ui.render` site is a place, not an event: it is drawn by `ui.render`. */
    reportUnsupported(call, slot, site) {
        const args = call.arguments;
        const detail = site
            ? `${site.slot} is drawn by on('${UI_RENDER_EVENT}', ${uiRenderMatcherText(site)}, hook)`
            : (slot ?? 'event name must be a string literal');
        this.report('EXTENSION_EVENT_UNSUPPORTED', args[0] ?? call, detail);
        if (args.length > 1)
            this.addHookRole(args[args.length - 1], false);
    }
    readSiteCall(call, site) {
        const [, matcherNode, hookNode] = call.arguments;
        if (call.arguments.length !== 3 || !matcherNode || !hookNode) {
            this.reportArity(call, `on('${site.slot}', matcher, hook)`);
            this.addHookRole(call.arguments[call.arguments.length - 1], true, true);
            return;
        }
        this.addHookRole(hookNode, true, true);
        const matcher = this.readMatcher(matcherNode, {
            fields: site.matcherFields.map((field) => field.name),
            required: site.matcherFields.filter((field) => field.required).map((field) => field.name),
        });
        if (matcher)
            this.addSiteEntry(site, matcher, matcherNode);
    }
    /**
     * `on('ui.render', { site, ... }, hook)`: one per site, and one per pane `id` (or one for every
     * pane, without `id`), in each plugin. The hook is one layer of the site's render chain and
     * receives `next`. `above-prompt` is listed as one entry; a pane lists none until it is opened.
     */
    readUiRenderCall(call) {
        const [, matcherNode, hookNode] = call.arguments;
        if (call.arguments.length !== 3 || !matcherNode || !hookNode) {
            this.reportArity(call, `on('${UI_RENDER_EVENT}', { site }, hook)`);
            this.addHookRole(call.arguments[call.arguments.length - 1], true, false);
            return;
        }
        const hook = this.addHookRole(hookNode, true, false);
        const drawing = this.readUiRenderMatcher(matcherNode);
        if (!drawing || !this.claimDrawing(drawing.site, drawing.matcher, matcherNode))
            return;
        const { site, matcher } = drawing;
        // Every `ui.render` drawing is a layer of its site's chain: one that never calls `next` hides
        // every layer after it, on every site alike, so it is warned like any layered hook.
        const role = hook && this.hookRoles.get(hook);
        if (role)
            this.hookRoles.set(hook, { ...role, layered: true });
        this.hooks.push({
            slot: UI_RENDER_EVENT,
            matcher,
            label: formatHook(UI_RENDER_EVENT, matcher),
        });
        // A band layer lists one entry per plugin; a pane lists none until the plugin opens it.
        if (site.matcherFields.length === 0) {
            this.entries.push({
                slot: site.slot,
                id: site.slot,
                matcher: { site: site.slot },
                label: site.slot,
            });
        }
    }
    /** The literal `{ site, ... }` of a `ui.render` call and the site it names, or a diagnostic. */
    readUiRenderMatcher(node) {
        const drawn = this.siteTable.slots.flatMap((slot) => {
            const spec = this.siteTable.get(slot);
            return spec && isUiRenderSite(spec) ? [spec] : [];
        });
        const base = UI_RENDER_MATCHER_FIELDS.map((field) => field.name);
        const extra = [...new Set(drawn.flatMap((spec) => spec.matcherFields.map((f) => f.name)))];
        const matcher = this.readMatcher(node, { fields: [...base, ...extra], required: base });
        if (!matcher || matcher.site === undefined)
            return undefined;
        const site = this.siteTable.get(matcher.site);
        if (!site || !isUiRenderSite(site)) {
            this.report('EXTENSION_MATCHER_INVALID', node, `unknown site "${matcher.site}"; use ${drawn.map((spec) => `'${spec.slot}'`).join(', ')}`);
            return undefined;
        }
        return this.fitsSiteMatcher(site, matcher, node) ? { site, matcher } : undefined;
    }
    /**
     * One `ui.render` per site, and per `id` (or none) on a site whose instances have one, within this
     * package; another plugin may register the same drawing and joins the chain.
     */
    claimDrawing(site, matcher, node) {
        const keyed = site.matcherFields.some((field) => field.name === 'id');
        // `\u0001` stands for "no id": a drawing of every pane, apart from any literal id.
        const drawing = keyed ? `${site.slot}\0${matcher.id ?? '\u0001'}` : site.slot;
        if (!this.drawnSites.has(drawing)) {
            this.drawnSites.add(drawing);
            return true;
        }
        let target = site.slot;
        if (keyed)
            target = matcher.id === undefined ? `every ${site.slot}` : `${site.slot} id "${matcher.id}"`;
        this.report('EXTENSION_DUPLICATE_ENTRY', node, `second ${UI_RENDER_EVENT} for ${target}`);
        return false;
    }
    /** The `ui.render` matcher names exactly the fields of its site: required present, no others. */
    fitsSiteMatcher(site, matcher, node) {
        const allowed = new Set(['site', ...site.matcherFields.map((field) => field.name)]);
        const unexpected = Object.keys(matcher).filter((name) => !allowed.has(name));
        const missing = site.matcherFields
            .filter((field) => field.required && matcher[field.name] === undefined)
            .map((field) => field.name);
        if (unexpected.length === 0 && missing.length === 0)
            return true;
        this.report('EXTENSION_MATCHER_INVALID', node, missing.length > 0
            ? `${site.slot} needs ${missing.join(', ')}; expected ${uiRenderMatcherText(site)}`
            : `${site.slot} takes no ${unexpected.join(', ')}; expected ${uiRenderMatcherText(site)}`);
        return false;
    }
    reportArity(call, expected) {
        if (call.arguments.length === 2) {
            this.report('EXTENSION_MATCHER_INVALID', call, `matcher missing; expected ${expected}`);
        }
        else {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', call, `expected ${expected}`);
        }
    }
    addSiteEntry(site, matcher, node) {
        const label = formatHook(site.slot, matcher);
        this.hooks.push({ slot: site.slot, matcher, label });
        const declaresId = site.matcherFields.some((field) => field.name === 'id');
        const id = matcher.id;
        if (declaresId && id !== undefined) {
            const key = `${site.slot}\0${id}`;
            if (this.seenIds.has(key)) {
                this.report('EXTENSION_DUPLICATE_ENTRY', node, `${site.slot} id "${id}"`);
                return;
            }
            this.seenIds.add(key);
        }
        this.entries.push({ slot: site.slot, ...(id === undefined ? {} : { id }), matcher, label });
        if (!declaresId)
            this.bindings.push({ slot: site.slot, matcher });
    }
    /** `on(event, hook)` observes every occurrence; `tool.*` also take `on(event, matcher, hook)`. */
    readObserveCall(call, event) {
        const spec = observeEventSpec(event);
        const fields = spec.matcherFields.map((field) => field.name);
        const args = call.arguments;
        this.addHookRole(args[args.length - 1], false);
        if (args.length === 2) {
            this.hooks.push({ slot: event, label: event });
            return;
        }
        if (args.length !== 3 || !args[1]) {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', call, `expected on('${event}', hook)`);
            return;
        }
        if (fields.length === 0) {
            this.report('EXTENSION_MATCHER_INVALID', call, `${event} takes no matcher`);
            return;
        }
        const matcher = this.readMatcher(args[1], {
            fields,
            required: spec.matcherFields.filter((field) => field.required).map((field) => field.name),
        });
        if (matcher)
            this.hooks.push({ slot: event, matcher, label: formatHook(event, matcher) });
    }
    addHookRole(node, isRender, layered = false) {
        if (!node)
            return undefined;
        const fn = this.hookFunction(node);
        if (!fn) {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', node, 'hook must be a function written inline or declared at the top level of this module');
            return undefined;
        }
        this.hookRoles.set(fn, {
            isRender,
            layered,
            node: fn,
            nextUsed: false,
            sourceFile: this.sourceFile,
        });
        return fn;
    }
    hookFunction(node) {
        const value = unwrapExpression(this.t, node);
        if (isInlineFunction(this.t, value))
            return value;
        if (this.t.isIdentifier(value))
            return topLevelFunction(this.t, this.sourceFile, value.text);
        return undefined;
    }
    readMatcher(node, shape) {
        const value = unwrapExpression(this.t, node);
        if (!this.t.isObjectLiteralExpression(value)) {
            this.report('EXTENSION_MATCHER_INVALID', node, 'matcher must be an object literal');
            return undefined;
        }
        const matcher = {};
        for (const property of value.properties) {
            if (!this.readMatcherProperty(property, shape, matcher))
                return undefined;
        }
        const missing = shape.required.filter((field) => !Object.hasOwn(matcher, field));
        if (missing.length > 0) {
            this.report('EXTENSION_MATCHER_INVALID', node, `missing ${missing.join(', ')}`);
            return undefined;
        }
        const ordered = {};
        for (const field of shape.fields) {
            const fieldValue = matcher[field];
            if (fieldValue !== undefined)
                ordered[field] = fieldValue;
        }
        return ordered;
    }
    readMatcherProperty(property, shape, matcher) {
        const t = this.t;
        if (!t.isPropertyAssignment(property)) {
            this.report('EXTENSION_MATCHER_INVALID', property, 'no spread, shorthand or method');
            return false;
        }
        const name = propertyNameText(t, property.name);
        if (name === undefined || !shape.fields.includes(name) || Object.hasOwn(matcher, name)) {
            this.report('EXTENSION_MATCHER_INVALID', property.name, `unexpected matcher key ${property.name.getText(this.sourceFile)}`);
            return false;
        }
        const literal = literalString(t, property.initializer);
        if (literal === undefined) {
            this.report('EXTENSION_MATCHER_INVALID', property.initializer, `"${name}" must be a literal`);
            return false;
        }
        matcher[name] = literal;
        return true;
    }
}
/** `{ site: 'pane', id }` as the author writes it. */
function uiRenderMatcherText(site) {
    const fields = site.matcherFields.map((field) => field.required ? field.name : `${field.name}?`);
    return `{ site: '${site.slot}'${fields.map((field) => `, ${field}`).join('')} }`;
}
function formatHook(slot, matcher) {
    const pairs = Object.entries(matcher).map(([key, value]) => `${key}=${value}`);
    return pairs.length > 0 ? `${slot}{${pairs.join(', ')}}` : slot;
}
function isExported(t, node) {
    if (!t.canHaveModifiers(node))
        return false;
    return t.getModifiers(node)?.some((item) => item.kind === t.SyntaxKind.ExportKeyword) ?? false;
}
function findRegister(t, sourceFile) {
    for (const statement of sourceFile.statements) {
        const found = registerFromStatement(t, sourceFile, statement);
        if (found !== undefined)
            return found ?? undefined;
    }
    return undefined;
}
/** `undefined`: statement does not export `register`; `null`: it does, but not as a function. */
function registerFromStatement(t, sourceFile, statement) {
    if (t.isFunctionDeclaration(statement)) {
        const exported = statement.name?.text === 'register' && isExported(t, statement);
        return exported && statement.body ? statement : undefined;
    }
    if (t.isVariableStatement(statement))
        return registerFromVariables(t, statement);
    if (t.isExportDeclaration(statement))
        return registerFromExportList(t, sourceFile, statement);
    return undefined;
}
function registerFromVariables(t, statement) {
    if (!isExported(t, statement))
        return undefined;
    const declaration = statement.declarationList.declarations.find((item) => t.isIdentifier(item.name) && item.name.text === 'register');
    return declaration ? (functionInitializer(t, declaration) ?? null) : undefined;
}
function registerFromExportList(t, sourceFile, statement) {
    const clause = statement.moduleSpecifier ? undefined : statement.exportClause;
    if (!clause || !t.isNamedExports(clause))
        return undefined;
    const element = clause.elements.find((item) => item.name.text === 'register');
    if (!element)
        return undefined;
    return topLevelFunction(t, sourceFile, (element.propertyName ?? element.name).text) ?? null;
}
function functionInitializer(t, declaration) {
    const value = declaration.initializer && unwrapExpression(t, declaration.initializer);
    return value && isInlineFunction(t, value) ? value : undefined;
}
function topLevelFunction(t, sourceFile, name) {
    for (const statement of sourceFile.statements) {
        if (t.isFunctionDeclaration(statement) && statement.name?.text === name) {
            return statement.body ? statement : undefined;
        }
        if (!t.isVariableStatement(statement))
            continue;
        const declaration = statement.declarationList.declarations.find((item) => t.isIdentifier(item.name) && item.name.text === name);
        if (declaration)
            return functionInitializer(t, declaration);
    }
    return undefined;
}
function topLevelOnCall(t, statement, onName) {
    const expression = t.isExpressionStatement(statement) ? statement.expression : statement;
    const call = t.isExpression(expression) ? unwrapExpression(t, expression) : undefined;
    if (call && t.isCallExpression(call) && t.isIdentifier(call.expression)) {
        if (call.expression.text === onName) {
            return call;
        }
    }
    return undefined;
}
function containsAwait(t, node) {
    if (t.isAwaitExpression(node) || (t.isForOfStatement(node) && node.awaitModifier))
        return true;
    if (isFunctionWithBody(t, node))
        return false;
    return t.forEachChild(node, (child) => containsAwait(t, child) || undefined) ?? false;
}
//# sourceMappingURL=registration.js.map