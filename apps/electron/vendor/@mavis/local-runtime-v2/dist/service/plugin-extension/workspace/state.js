import { EXTENSION_SDK_SPECIFIERS } from '../contracts.js';
import { diagnosticAt, isFunctionWithBody, propertyNameText, unwrapExpression } from './syntax.js';
const SDK_ROOT = EXTENSION_SDK_SPECIFIERS[0];
/**
 * `state:` (three.md §2.2): literal keys of `defineState({ key: { default } })` at module top
 * level, with the default's type read syntactically (`as T` keeps the author's widened type).
 */
export class StateCollector {
    t;
    fields = [];
    diagnostics = [];
    keys = new Set();
    sourceFile;
    constructor(t) {
        this.t = t;
    }
    collect(sourceFile) {
        const callees = defineStateCallees(this.t, sourceFile);
        if (callees.functions.size === 0 && callees.namespaces.size === 0)
            return;
        this.sourceFile = sourceFile;
        const visit = (node, nested) => {
            if (this.t.isCallExpression(node) && isDefineState(this.t, node.expression, callees)) {
                if (nested)
                    this.report(node, '`defineState` must be called at module top level');
                else
                    this.readSpec(node.arguments[0] ?? node);
            }
            this.t.forEachChild(node, (child) => visit(child, nested || isFunctionWithBody(this.t, child)));
        };
        visit(sourceFile, false);
    }
    report(node, detail) {
        if (!this.sourceFile)
            return;
        this.diagnostics.push(diagnosticAt('EXTENSION_STATE_SHAPE_INVALID', this.sourceFile, node, detail));
    }
    readSpec(argument) {
        const spec = unwrapExpression(this.t, argument);
        if (!this.t.isObjectLiteralExpression(spec)) {
            this.report(argument, 'the argument must be an object literal');
            return;
        }
        for (const property of spec.properties)
            this.readField(property);
    }
    readField(property) {
        const t = this.t;
        const key = t.isPropertyAssignment(property) ? propertyNameText(t, property.name) : undefined;
        if (!t.isPropertyAssignment(property) || key === undefined) {
            this.report(property, 'state keys must be literal property names');
            return;
        }
        if (this.keys.has(key)) {
            this.report(property.name, `state key "${key}" is declared twice`);
            return;
        }
        const type = this.fieldType(property.initializer);
        if (!type) {
            this.report(property, `"${key}" must be { default: <literal> }`);
            return;
        }
        this.keys.add(key);
        this.fields.push({ key, type, label: `${key}: ${type}` });
    }
    fieldType(initializer) {
        const t = this.t;
        const field = unwrapExpression(t, initializer);
        if (!t.isObjectLiteralExpression(field) || field.properties.length !== 1)
            return undefined;
        const [property] = field.properties;
        if (!property || !t.isPropertyAssignment(property))
            return undefined;
        if (propertyNameText(t, property.name) !== 'default' || !this.sourceFile)
            return undefined;
        return literalType(t, this.sourceFile, property.initializer);
    }
}
function defineStateCallees(t, sourceFile) {
    const functions = new Set();
    const namespaces = new Set();
    for (const statement of sourceFile.statements) {
        const bindings = sdkImportBindings(t, statement);
        if (!bindings)
            continue;
        if (t.isNamespaceImport(bindings)) {
            namespaces.add(bindings.name.text);
            continue;
        }
        for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (imported === 'defineState' && !element.isTypeOnly)
                functions.add(element.name.text);
        }
    }
    return { functions, namespaces };
}
function sdkImportBindings(t, statement) {
    if (!t.isImportDeclaration(statement) || statement.importClause?.isTypeOnly)
        return undefined;
    const specifier = statement.moduleSpecifier;
    if (!t.isStringLiteral(specifier) || specifier.text !== SDK_ROOT)
        return undefined;
    return statement.importClause?.namedBindings;
}
function isDefineState(t, callee, callees) {
    const value = unwrapExpression(t, callee);
    if (t.isIdentifier(value))
        return callees.functions.has(value.text);
    return (t.isPropertyAccessExpression(value) &&
        value.name.text === 'defineState' &&
        t.isIdentifier(value.expression) &&
        callees.namespaces.has(value.expression.text));
}
function literalType(t, sourceFile, node) {
    if (t.isParenthesizedExpression(node) || t.isSatisfiesExpression(node)) {
        return literalType(t, sourceFile, node.expression);
    }
    if (t.isAsExpression(node)) {
        return literalType(t, sourceFile, node.expression) && node.type.getText(sourceFile);
    }
    if (t.isArrayLiteralExpression(node))
        return arrayLiteralType(t, sourceFile, node);
    if (t.isObjectLiteralExpression(node))
        return objectLiteralType(t, sourceFile, node);
    return primitiveLiteralType(t, node);
}
function primitiveLiteralType(t, node) {
    if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node))
        return 'string';
    if (t.isNumericLiteral(node))
        return 'number';
    if (t.isPrefixUnaryExpression(node))
        return signedNumberType(t, node);
    if (node.kind === t.SyntaxKind.TrueKeyword || node.kind === t.SyntaxKind.FalseKeyword) {
        return 'boolean';
    }
    return node.kind === t.SyntaxKind.NullKeyword ? 'null' : undefined;
}
function signedNumberType(t, node) {
    const signed = node.operator === t.SyntaxKind.MinusToken || node.operator === t.SyntaxKind.PlusToken;
    return signed && t.isNumericLiteral(node.operand) ? 'number' : undefined;
}
function arrayLiteralType(t, sourceFile, node) {
    const types = [];
    for (const element of node.elements) {
        const type = literalType(t, sourceFile, element);
        if (type === undefined)
            return undefined;
        if (!types.includes(type))
            types.push(type);
    }
    const [single] = types;
    if (single === undefined)
        return 'unknown[]';
    return types.length === 1 && !single.includes(' ') ? `${single}[]` : `(${types.join(' | ')})[]`;
}
function objectLiteralType(t, sourceFile, node) {
    const members = [];
    for (const property of node.properties) {
        if (!t.isPropertyAssignment(property))
            return undefined;
        const key = propertyNameText(t, property.name);
        const type = literalType(t, sourceFile, property.initializer);
        if (key === undefined || type === undefined)
            return undefined;
        members.push(`${key}: ${type}`);
    }
    return members.length > 0 ? `{ ${members.join('; ')} }` : '{}';
}
//# sourceMappingURL=state.js.map