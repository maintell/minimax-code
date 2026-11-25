import { diagnosticAt, isFunctionWithBody, isInlineFunction, propertyNameText, unwrapExpression, } from './syntax.js';
/**
 * `ctx` domains that also carry data, with their methods: `ctx.session.usage()` is a call,
 * `ctx.session.id` data. The compiler checks the methods against `ExtensionContext` both ways.
 */
const DATA_DOMAIN_METHODS = {
    plugin: {},
    session: { usage: true },
};
const DATA_DOMAINS = new Set(Object.keys(DATA_DOMAIN_METHODS));
const DATA_METHODS = new Set(Object.entries(DATA_DOMAIN_METHODS).flatMap(([domain, methods]) => Object.keys(methods).map((method) => `${domain}.${method}`)));
/** State writes a drawing must not make: what it draws depends on state, not the reverse. */
const RENDER_WRITES = new Set(['state.set', 'state.update']);
/**
 * `ctx` methods that take a callback the host later runs as its own Invocation (SDK `context.ts`:
 * `ClockCallback`, the `onDidChange` listener), and that callback's argument index.
 */
const CTX_CALLBACK_ARGUMENTS = new Map(Object.entries({
    'clock.after': 1,
    'clock.every': 1,
    'store.onDidChange': 0,
}));
const OTHER = { kind: 'other' };
const ON = { kind: 'on' };
const CTX = { kind: 'ctx' };
class Scope {
    parent;
    names = new Map();
    constructor(parent) {
        this.parent = parent;
    }
    declare(name, binding) {
        this.names.set(name, binding);
    }
    lookup(name) {
        return this.names.get(name) ?? this.parent?.lookup(name);
    }
}
/**
 * Walks one whole module with lexical scopes and records every `ctx.<domain>.<method>(…)` on the
 * one name bound to the activation's `ctx`: a hook's first parameter. Callbacks take no `ctx` and
 * close over the hook's; any other binding, even one named `ctx`, is not `ctx` (a callback that
 * declares its own fails when it runs). Wherever the call sits it is recorded; any other use of
 * `ctx` (dynamic access, aliasing, passing it on) is refused (one.md §4 写法规则).
 */
export function analyzeCtxUsage(input) {
    return new CtxUsageWalker(input).run();
}
class CtxUsageWalker {
    input;
    t;
    calls = [];
    diagnostics = [];
    /** Functions the host runs later as their own Invocation. */
    callbacks;
    /** Callback-position expressions: any function inside one runs later, not while drawing. */
    positions;
    constructor(input) {
        this.input = input;
        this.t = input.typescript;
        const found = collectCallbackFunctions(this.t, input.sourceFile, input.callbackProps);
        this.callbacks = found.functions;
        this.positions = found.positions;
    }
    run() {
        const scope = new Scope();
        this.hoistVars(scope, this.input.sourceFile);
        this.declareStatements(scope, this.input.sourceFile.statements);
        for (const statement of this.input.sourceFile.statements)
            this.visit(statement, scope);
        return { calls: this.calls, diagnostics: this.diagnostics };
    }
    report(code, node, detail) {
        this.diagnostics.push(diagnosticAt(code, this.input.sourceFile, node, detail));
    }
    // ------------------------------------------------------------------------------------------
    // Scopes
    declareName(scope, name, binding) {
        if (this.t.isIdentifier(name)) {
            scope.declare(name.text, binding);
            return;
        }
        for (const element of name.elements) {
            if (this.t.isBindingElement(element))
                this.declareName(scope, element.name, binding);
        }
    }
    declareStatements(scope, statements) {
        for (const statement of statements)
            this.declareStatement(scope, statement);
    }
    declareStatement(scope, statement) {
        const t = this.t;
        if (t.isVariableStatement(statement)) {
            if ((statement.declarationList.flags & t.NodeFlags.BlockScoped) === 0)
                return;
            for (const declaration of statement.declarationList.declarations) {
                this.declareName(scope, declaration.name, OTHER);
            }
            return;
        }
        if ((t.isFunctionDeclaration(statement) ||
            t.isClassDeclaration(statement) ||
            t.isEnumDeclaration(statement)) &&
            statement.name) {
            scope.declare(statement.name.text, OTHER);
            return;
        }
        if (t.isImportDeclaration(statement) && statement.importClause) {
            this.declareImport(scope, statement.importClause);
        }
    }
    declareImport(scope, clause) {
        const t = this.t;
        if (clause.name)
            scope.declare(clause.name.text, OTHER);
        const bindings = clause.namedBindings;
        if (!bindings)
            return;
        if (t.isNamespaceImport(bindings)) {
            scope.declare(bindings.name.text, OTHER);
            return;
        }
        for (const element of bindings.elements)
            scope.declare(element.name.text, OTHER);
    }
    hoistVars(scope, node) {
        const t = this.t;
        t.forEachChild(node, (child) => {
            if (isFunctionWithBody(t, child) || t.isClassLike(child))
                return;
            if (t.isVariableDeclarationList(child) && (child.flags & t.NodeFlags.BlockScoped) === 0) {
                for (const declaration of child.declarations) {
                    this.declareName(scope, declaration.name, OTHER);
                }
            }
            this.hoistVars(scope, child);
        });
    }
    innerScope(node, scope) {
        const t = this.t;
        if (t.isBlock(node) || t.isModuleBlock(node)) {
            const inner = new Scope(scope);
            this.declareStatements(inner, node.statements);
            return inner;
        }
        if (t.isCaseBlock(node)) {
            const inner = new Scope(scope);
            for (const clause of node.clauses)
                this.declareStatements(inner, clause.statements);
            return inner;
        }
        return this.bindingScope(node, scope);
    }
    /** `for (let …)` and `catch (e)` declare names visible only inside the statement. */
    bindingScope(node, scope) {
        const t = this.t;
        let names = [];
        if (t.isForStatement(node) || t.isForInStatement(node) || t.isForOfStatement(node)) {
            const initializer = node.initializer;
            if (initializer && t.isVariableDeclarationList(initializer)) {
                names = initializer.declarations.map((item) => item.name);
            }
        }
        else if (t.isCatchClause(node) && node.variableDeclaration) {
            names = [node.variableDeclaration.name];
        }
        if (names.length === 0)
            return scope;
        const inner = new Scope(scope);
        for (const name of names)
            this.declareName(inner, name, OTHER);
        return inner;
    }
    // ------------------------------------------------------------------------------------------
    // Walk
    visit(node, scope) {
        const t = this.t;
        if (isTypeOnlyNode(t, node))
            return;
        if (isFunctionWithBody(t, node)) {
            this.visitFunction(node, scope);
            return;
        }
        if (t.isIdentifier(node)) {
            if (isValueReference(t, node))
                this.onReference(node, scope.lookup(node.text));
            return;
        }
        const inner = this.innerScope(node, scope);
        t.forEachChild(node, (child) => this.visit(child, inner));
    }
    visitFunction(fn, outer) {
        const t = this.t;
        const scope = new Scope(outer);
        if (t.isFunctionExpression(fn) && fn.name)
            scope.declare(fn.name.text, OTHER);
        fn.parameters.forEach((parameter, index) => {
            let binding = this.parameterBinding(fn, index);
            if (binding.kind === 'ctx' && !t.isIdentifier(parameter.name)) {
                this.report('EXTENSION_CALL_SHAPE_INVALID', parameter, 'the `ctx` parameter must not be destructured');
                binding = OTHER;
            }
            this.declareName(scope, parameter.name, binding);
        });
        for (const parameter of fn.parameters) {
            this.visit(parameter.name, scope);
            if (parameter.initializer)
                this.visit(parameter.initializer, scope);
        }
        const body = fn.body;
        if (!body || !t.isBlock(body)) {
            if (body)
                this.visit(body, scope);
            return;
        }
        this.hoistVars(scope, body);
        this.declareStatements(scope, body.statements);
        for (const statement of body.statements)
            this.visit(statement, scope);
    }
    parameterBinding(fn, index) {
        const hook = this.input.hooks?.get(fn);
        if (fn === this.input.register && index === 0)
            return ON;
        if (index === 0 && hook !== undefined)
            return CTX;
        if (hook && index === 2)
            return { kind: 'next', hook };
        return OTHER;
    }
    onReference(id, binding) {
        if (!binding || binding.kind === 'other')
            return;
        if (binding.kind === 'next') {
            binding.hook.nextUsed = true;
            return;
        }
        if (binding.kind === 'ctx') {
            this.checkCtx(id);
            return;
        }
        if (!this.input.acceptedOnCallees?.has(id)) {
            this.report('EXTENSION_REGISTER_SHAPE_INVALID', id, '`on` may only be called directly at the top level of `register`');
        }
    }
    // ------------------------------------------------------------------------------------------
    // ctx
    checkCtx(id) {
        const member = memberCall(this.t, id);
        if (member.kind === 'data')
            return;
        if (member.kind === 'invalid') {
            this.report('EXTENSION_CALL_SHAPE_INVALID', id, member.detail);
            return;
        }
        if (this.inRenderBody(id) && RENDER_WRITES.has(`${member.domain}.${member.method}`)) {
            this.report('EXTENSION_RENDER_SIDE_EFFECT', member.call, `${member.domain}.${member.method} in a render hook`);
        }
        this.recordCall(member.domain, member.method, member.call);
    }
    /**
     * Whether `id` runs while a render hook draws: in the hook body, including the sync helpers,
     * `forEach` callbacks and IIFEs it defines there. A callback is the boundary: it runs later, as
     * its own Invocation. That is a function resolved from a callback position (an element callback
     * prop, a clock or store callback), or any function nested inside
     * a callback-position expression however it is wrapped (`wrap(() => …)`, `e && (() => …)`).
     * Code of the expression itself outside such a function, including an IIFE, runs while drawing.
     * Code that executes a nested function while drawing (`(() => { f(); return f; })()`,
     * `.map((f) => f())`) is not followed here; the runtime refuses its writes by Invocation kind.
     */
    inRenderBody(id) {
        let crossedFunction = false;
        for (let node = id.parent; node; node = node.parent) {
            if (crossedFunction && this.positions.has(node))
                return false;
            if (!isFunctionWithBody(this.t, node))
                continue;
            const hook = this.input.hooks?.get(node);
            if (hook)
                return hook.isRender;
            if (this.callbacks.has(node))
                return false;
            if (!isImmediatelyCalled(this.t, node))
                crossedFunction = true;
        }
        return false;
    }
    recordCall(domain, method, call) {
        if (domain === 'mcp' && method === 'call') {
            this.recordMcpCall(call);
            return;
        }
        this.calls.push({ domain, method });
    }
    recordMcpCall(call) {
        const t = this.t;
        const [serverArgument, toolArgument] = call.arguments;
        const server = serverArgument && unwrapExpression(t, serverArgument);
        if (!server || !t.isStringLiteral(server)) {
            this.report('EXTENSION_CALL_SHAPE_INVALID', serverArgument ?? call, 'the `server` argument of `ctx.mcp.call` must be a string literal');
            return;
        }
        const tool = toolArgument && unwrapExpression(t, toolArgument);
        this.calls.push({
            domain: 'mcp',
            method: 'call',
            server: server.text,
            ...(tool && t.isStringLiteral(tool) ? { tool: tool.text } : {}),
        });
    }
}
/** A member of a data domain other than its methods (`ctx.session.usage`) is data. */
function isDataRead(t, domain, domainBase) {
    if (!DATA_DOMAINS.has(domain))
        return false;
    const access = domainBase.parent;
    return !(t.isPropertyAccessExpression(access) &&
        access.expression === domainBase &&
        DATA_METHODS.has(`${domain}.${access.name.text}`));
}
/** Classifies `ctx` at `id`: `ctx.<domain>.<method>(…)`, a data read, or a forbidden shape. */
function memberCall(t, id) {
    const base = climb(t, id);
    const domainAccess = base.parent;
    if (!t.isPropertyAccessExpression(domainAccess) || domainAccess.expression !== base) {
        const dynamic = t.isElementAccessExpression(domainAccess) && domainAccess.expression === base;
        return {
            kind: 'invalid',
            detail: dynamic
                ? `dynamic property access on \`${id.text}\``
                : `\`${id.text}\` is used as a value (destructured, aliased or passed on)`,
        };
    }
    const domain = domainAccess.name.text;
    const domainBase = climb(t, domainAccess);
    const methodAccess = domainBase.parent;
    if (isDataRead(t, domain, domainBase))
        return { kind: 'data' };
    if (!t.isPropertyAccessExpression(methodAccess) || methodAccess.expression !== domainBase) {
        return {
            kind: 'invalid',
            detail: `\`${id.text}.${domain}\` must be called as \`${id.text}.${domain}.<method>(…)\``,
        };
    }
    const method = methodAccess.name.text;
    const methodBase = climb(t, methodAccess);
    const call = methodBase.parent;
    if (!t.isCallExpression(call) || call.expression !== methodBase) {
        return {
            kind: 'invalid',
            detail: `\`${id.text}.${domain}.${method}\` must be called directly`,
        };
    }
    return { kind: 'call', domain, method, call };
}
/**
 * The functions the host runs later as their own Invocation, for the render boundary: element
 * callback props (JSX attribute or element-function object) and the callbacks of
 * `ctx.clock.after / every` and `ctx.store.onDidChange`, followed through same-module names,
 * aliases, object-literal members and conditionals; plus the position expressions, so a function
 * wrapped in a way the scan cannot follow still counts by where it is written.
 */
function collectCallbackFunctions(t, sourceFile, callbackProps) {
    const found = { functions: new Set(), positions: new Set() };
    const visit = (node) => {
        const expression = callbackPosition(t, sourceFile, node, callbackProps);
        if (expression) {
            found.positions.add(expression);
            resolveCallbacks(t, expression, { out: found.functions, seen: new Set() });
        }
        t.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}
function callbackPosition(t, sourceFile, node, callbackProps) {
    if (t.isJsxAttribute(node))
        return jsxCallback(t, sourceFile, node, callbackProps);
    if (t.isObjectLiteralElementLike(node))
        return objectCallbackPosition(t, node, callbackProps);
    if (t.isCallExpression(node)) {
        const index = ctxCallbackArgument(t, node.expression);
        return index === undefined ? undefined : node.arguments[index];
    }
    return undefined;
}
function jsxCallback(t, sourceFile, node, callbackProps) {
    if (!callbackProps.has(node.name.getText(sourceFile)))
        return;
    const initializer = node.initializer;
    return initializer && t.isJsxExpression(initializer) ? initializer.expression : undefined;
}
/** Callback positions inside an element-function object: `onPress: fn` and the shorthand `{ onPress }`. */
function objectCallbackPosition(t, node, callbackProps) {
    if (t.isPropertyAssignment(node)) {
        const name = propertyNameText(t, node.name);
        return name !== undefined && callbackProps.has(name) ? node.initializer : undefined;
    }
    if (t.isShorthandPropertyAssignment(node)) {
        return callbackProps.has(node.name.text) ? node.name : undefined;
    }
    return undefined;
}
function resolveCallbacks(t, expression, resolution) {
    if (resolution.seen.has(expression))
        return;
    resolution.seen.add(expression);
    const value = unwrapExpression(t, expression);
    if (isInlineFunction(t, value)) {
        resolution.out.add(value);
        return;
    }
    if (t.isConditionalExpression(value)) {
        resolveCallbacks(t, value.whenTrue, resolution);
        resolveCallbacks(t, value.whenFalse, resolution);
        return;
    }
    if (t.isIdentifier(value)) {
        namedCallbacks(t, value, resolution);
        return;
    }
    if (t.isCallExpression(value)) {
        callCallbacks(t, value, resolution);
        return;
    }
    if (t.isPropertyAccessExpression(value) || t.isElementAccessExpression(value)) {
        memberCallbacksOf(t, value, resolution);
    }
}
/** `actions.press`, `actions['press']` or `handlers[0]` on a same-module literal. */
function memberCallbacksOf(t, value, resolution) {
    const base = unwrapExpression(t, value.expression);
    if (!t.isIdentifier(base))
        return;
    const index = t.isElementAccessExpression(value) ? arrayIndex(t, value) : undefined;
    if (index !== undefined) {
        arrayCallbacks(t, base, index, resolution);
        return;
    }
    const name = callbackMemberName(t, value);
    if (name !== undefined)
        objectCallbacks(t, base, name, resolution);
}
/**
 * `press.bind(…)` is `press`; any other call in a callback position, such as `run(fn)`, may hand
 * its arguments to the host as the callback, so they resolve as callbacks too.
 */
function callCallbacks(t, call, resolution) {
    const callee = unwrapExpression(t, call.expression);
    if (t.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
        resolveCallbacks(t, callee.expression, resolution);
        return;
    }
    for (const argument of call.arguments)
        resolveCallbacks(t, argument, resolution);
}
function arrayIndex(t, value) {
    const argument = value.argumentExpression;
    return t.isNumericLiteral(argument) ? Number(argument.text) : undefined;
}
/** `handlers[0]` on a same-module array literal: the element at that index. */
function arrayCallbacks(t, base, index, resolution) {
    const initializer = callbackInitializer(t, callbackDeclaration(t, base));
    const array = initializer && unwrapExpression(t, initializer);
    if (!array || !t.isArrayLiteralExpression(array))
        return;
    const element = array.elements[index];
    if (element && !t.isSpreadElement(element) && !t.isOmittedExpression(element)) {
        resolveCallbacks(t, element, resolution);
    }
}
/** A same-module function declaration, or a variable whose initializer resolves to callbacks. */
function namedCallbacks(t, id, resolution) {
    const declaration = callbackDeclaration(t, id);
    if (declaration && isFunctionWithBody(t, declaration)) {
        resolution.out.add(declaration);
        return;
    }
    const initializer = callbackInitializer(t, declaration);
    if (initializer)
        resolveCallbacks(t, initializer, resolution);
}
function callbackInitializer(t, declaration) {
    if (!declaration || !t.isVariableDeclaration(declaration) || !t.isIdentifier(declaration.name))
        return;
    return declaration.initializer;
}
function callbackMemberName(t, value) {
    if (t.isPropertyAccessExpression(value))
        return value.name.text;
    const argument = value.argumentExpression;
    return argument && t.isStringLiteral(argument) ? argument.text : undefined;
}
/** `actions.press` on a same-module object literal: the member's function, however written. */
function objectCallbacks(t, base, name, resolution) {
    const initializer = callbackInitializer(t, callbackDeclaration(t, base));
    const object = initializer && unwrapExpression(t, initializer);
    if (!object || !t.isObjectLiteralExpression(object))
        return;
    for (const member of object.properties) {
        if (member.name && propertyNameText(t, member.name) === name) {
            memberCallbacks(t, member, resolution);
        }
    }
}
function memberCallbacks(t, member, resolution) {
    if (t.isMethodDeclaration(member) && member.body)
        resolution.out.add(member);
    else if (t.isPropertyAssignment(member))
        resolveCallbacks(t, member.initializer, resolution);
    else if (t.isShorthandPropertyAssignment(member))
        resolveCallbacks(t, member.name, resolution);
}
function callbackDeclaration(t, id) {
    for (let scope = id.parent; scope; scope = scope.parent) {
        const declaration = scopeDeclaration(t, scope, id.text);
        if (declaration)
            return declaration;
    }
    return undefined;
}
function scopeDeclaration(t, scope, name) {
    if (t.isFunctionLike(scope))
        return scope.parameters.find((item) => bindsName(t, item.name, name));
    if (t.isCatchClause(scope)) {
        const declaration = scope.variableDeclaration;
        return declaration && bindsName(t, declaration.name, name) ? declaration : undefined;
    }
    if (t.isForStatement(scope) || t.isForInStatement(scope) || t.isForOfStatement(scope)) {
        const initializer = scope.initializer;
        return initializer && t.isVariableDeclarationList(initializer)
            ? initializer.declarations.find((item) => bindsName(t, item.name, name))
            : undefined;
    }
    return blockDeclaration(t, scope, name);
}
function blockDeclaration(t, scope, name) {
    const statements = statementsOfBlock(t, scope);
    if (!statements)
        return;
    for (const statement of statements) {
        const declaration = statementDeclaration(t, statement, name);
        if (declaration)
            return declaration;
    }
    return hoistedVarDeclaration(t, statements, name);
}
function statementsOfBlock(t, scope) {
    if (t.isBlock(scope) || t.isSourceFile(scope) || t.isCaseClause(scope))
        return scope.statements;
    if (t.isCaseBlock(scope))
        return scope.clauses.flatMap((clause) => clause.statements);
    return undefined;
}
function hoistedVarDeclaration(t, statements, name) {
    for (const statement of statements) {
        const declaration = varDeclaration(t, statement, name);
        if (declaration)
            return declaration;
        if (t.isVariableStatement(statement))
            continue;
        if (isFunctionWithBody(t, statement) || t.isClassLike(statement))
            continue;
        const nestedDeclaration = findNestedVarDeclaration(t, statement, name);
        if (nestedDeclaration)
            return nestedDeclaration;
    }
    return undefined;
}
function varDeclaration(t, statement, name) {
    if (!t.isVariableStatement(statement))
        return;
    if ((statement.declarationList.flags & t.NodeFlags.BlockScoped) !== 0)
        return;
    return statement.declarationList.declarations.find((item) => bindsName(t, item.name, name));
}
function findNestedVarDeclaration(t, node, name) {
    const statements = statementsOfBlock(t, node);
    if (statements)
        return hoistedVarDeclaration(t, statements, name);
    let found;
    t.forEachChild(node, (child) => {
        if (found || isFunctionWithBody(t, child) || t.isClassLike(child))
            return;
        found = findNestedVarDeclaration(t, child, name);
    });
    return found;
}
function statementDeclaration(t, statement, name) {
    if (t.isVariableStatement(statement)) {
        return statement.declarationList.declarations.find((item) => bindsName(t, item.name, name));
    }
    if (t.isFunctionDeclaration(statement) ||
        t.isClassDeclaration(statement) ||
        t.isEnumDeclaration(statement)) {
        return statement.name?.text === name ? statement : undefined;
    }
    if (t.isImportDeclaration(statement))
        return importedDeclaration(t, statement.importClause, name);
    return undefined;
}
function importedDeclaration(t, clause, name) {
    if (clause?.name?.text === name)
        return clause;
    const bindings = clause?.namedBindings;
    if (!bindings)
        return;
    if (t.isNamespaceImport(bindings))
        return bindings.name.text === name ? bindings : undefined;
    return bindings.elements.find((item) => item.name.text === name);
}
function bindsName(t, name, text) {
    if (t.isIdentifier(name))
        return name.text === text;
    return name.elements.some((element) => t.isBindingElement(element) && bindsName(t, element.name, text));
}
/** Callback argument index when `callee` is `<…>.<domain>.<method>` of `CTX_CALLBACK_ARGUMENTS`. */
function ctxCallbackArgument(t, callee) {
    const method = unwrapExpression(t, callee);
    if (!t.isPropertyAccessExpression(method))
        return undefined;
    const domain = unwrapExpression(t, method.expression);
    if (!t.isPropertyAccessExpression(domain))
        return undefined;
    return CTX_CALLBACK_ARGUMENTS.get(`${domain.name.text}.${method.name.text}`);
}
/** `(() => …)()`: the function runs where it is written. */
function isImmediatelyCalled(t, fn) {
    if (!t.isArrowFunction(fn) && !t.isFunctionExpression(fn))
        return false;
    const callee = climb(t, fn);
    return t.isCallExpression(callee.parent) && callee.parent.expression === callee;
}
function climb(t, node) {
    let current = node;
    while ((t.isParenthesizedExpression(current.parent) || t.isNonNullExpression(current.parent)) &&
        current.parent.expression === current) {
        current = current.parent;
    }
    return current;
}
function isTypeOnlyNode(t, node) {
    return (t.isTypeNode(node) ||
        t.isInterfaceDeclaration(node) ||
        t.isTypeAliasDeclaration(node) ||
        t.isTypeParameterDeclaration(node) ||
        t.isHeritageClause(node) ||
        (t.isImportDeclaration(node) && node.importClause?.isTypeOnly === true));
}
let referenceKinds;
function getReferenceKinds(t) {
    const kind = t.SyntaxKind;
    referenceKinds ??= {
        never: new Set([
            kind.QualifiedName,
            kind.MetaProperty,
            kind.JsxAttribute,
            kind.JsxClosingElement,
            kind.ImportSpecifier,
            kind.ExportSpecifier,
            kind.ImportClause,
            kind.NamespaceImport,
            kind.ImportEqualsDeclaration,
            kind.LabeledStatement,
            kind.BreakStatement,
            kind.ContinueStatement,
        ]),
        named: new Set([
            kind.PropertyAssignment,
            kind.PropertyDeclaration,
            kind.MethodDeclaration,
            kind.GetAccessor,
            kind.SetAccessor,
            kind.EnumMember,
            kind.VariableDeclaration,
            kind.Parameter,
            kind.FunctionDeclaration,
            kind.FunctionExpression,
            kind.ClassDeclaration,
            kind.ClassExpression,
            kind.EnumDeclaration,
            kind.ModuleDeclaration,
        ]),
    };
    return referenceKinds;
}
function isValueReference(t, id) {
    const parent = id.parent;
    if (t.isPropertyAccessExpression(parent))
        return parent.expression === id;
    if (t.isBindingElement(parent))
        return parent.initializer === id;
    const kinds = getReferenceKinds(t);
    if (kinds.never.has(parent.kind))
        return false;
    if (kinds.named.has(parent.kind))
        return parent.name !== id;
    return true;
}
//# sourceMappingURL=ctx-usage.js.map