import { createExtensionDiagnostic, } from '../sdk/diagnostics.js';
import { EXTENSION_JSX_IMPORT_SOURCE } from '../contracts.js';
/** Loaded lazily so the runtime only needs `typescript` when it validates an extension. */
export async function loadTypeScript() {
    const loaded = (await import('typescript'));
    return loaded.default ?? loaded;
}
const EXTENSION_SOURCE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
];
export function isExtensionSourceFile(relativePath) {
    return EXTENSION_SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension));
}
export function parseSource(typescript, file, text) {
    return typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true, scriptKind(typescript, file));
}
function scriptKind(typescript, file) {
    if (file.endsWith('.tsx'))
        return typescript.ScriptKind.TSX;
    if (file.endsWith('.jsx'))
        return typescript.ScriptKind.JSX;
    if (/\.[mc]?js$/u.test(file))
        return typescript.ScriptKind.JS;
    return typescript.ScriptKind.TS;
}
export function diagnosticAt(code, sourceFile, node, detail) {
    return diagnosticAtPosition(code, sourceFile, node.getStart(sourceFile), detail);
}
function diagnosticAtPosition(code, sourceFile, position, detail) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
    return createExtensionDiagnostic(code, {
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        ...(detail === undefined ? {} : { detail }),
    });
}
/** Strips parentheses, `!`, `as`, `satisfies` and `<T>x` around an expression. */
export function unwrapExpression(typescript, node) {
    let current = node;
    while (typescript.isParenthesizedExpression(current) ||
        typescript.isNonNullExpression(current) ||
        typescript.isAsExpression(current) ||
        typescript.isSatisfiesExpression(current) ||
        typescript.isTypeAssertionExpression(current)) {
        current = current.expression;
    }
    return current;
}
/** A string literal or a template without substitutions. */
export function literalString(typescript, node) {
    const value = unwrapExpression(typescript, node);
    if (typescript.isStringLiteral(value) || typescript.isNoSubstitutionTemplateLiteral(value)) {
        return value.text;
    }
    return undefined;
}
export function propertyNameText(typescript, name) {
    if (typescript.isIdentifier(name) ||
        typescript.isStringLiteral(name) ||
        typescript.isNumericLiteral(name)) {
        return name.text;
    }
    return undefined;
}
export function isFunctionWithBody(typescript, node) {
    return ((typescript.isFunctionDeclaration(node) ||
        typescript.isFunctionExpression(node) ||
        typescript.isArrowFunction(node) ||
        typescript.isMethodDeclaration(node) ||
        typescript.isConstructorDeclaration(node) ||
        typescript.isGetAccessorDeclaration(node) ||
        typescript.isSetAccessorDeclaration(node)) &&
        node.body !== undefined);
}
export function isInlineFunction(typescript, node) {
    return typescript.isArrowFunction(node) || typescript.isFunctionExpression(node);
}
const PRAGMA = /@jsx(ImportSource|Runtime|Frag)?(?![\w-])[ \t]*(\S*)/gu;
const HOST_PRAGMA_VALUES = {
    ImportSource: EXTENSION_JSX_IMPORT_SOURCE,
    Runtime: 'automatic',
};
/**
 * esbuild honours `@jsx*` pragmas in comments and they override the host JSX settings per file;
 * any pragma that disagrees with the host value is rejected (one.md §5).
 */
export function findJsxPragmaDiagnostics(typescript, sourceFile) {
    const text = sourceFile.text;
    const seen = new Set();
    const diagnostics = [];
    const inspect = (ranges) => {
        for (const range of ranges ?? []) {
            if (seen.has(range.pos))
                continue;
            seen.add(range.pos);
            const comment = text.slice(range.pos, range.end);
            for (const match of comment.matchAll(PRAGMA)) {
                const kind = match[1] ?? '';
                if (HOST_PRAGMA_VALUES[kind] !== undefined && HOST_PRAGMA_VALUES[kind] === match[2]) {
                    continue;
                }
                diagnostics.push(diagnosticAtPosition('EXTENSION_IMPORT_FORBIDDEN', sourceFile, range.pos + (match.index ?? 0), `JSX pragma ${match[0].trim()} conflicts with the host JSX settings`));
            }
        }
    };
    const visit = (node) => {
        if (!typescript.isJsxText(node)) {
            inspect(typescript.getLeadingCommentRanges(text, node.pos));
            inspect(typescript.getTrailingCommentRanges(text, node.end));
        }
        typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
    inspect(typescript.getLeadingCommentRanges(text, sourceFile.endOfFileToken.pos));
    return diagnostics;
}
//# sourceMappingURL=syntax.js.map