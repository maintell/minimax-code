// Reverse the shipped tsc CommonJS output back into TypeScript sources.
//
// Input : <inDir>/main/**/*.js   (Electron main-process build output)
// Output: <outDir>/main/**/*.ts  (equivalent TypeScript sources)
//
// The transform is text-based: the TypeScript parser locates the emitted
// patterns and each match is replaced by its source-level equivalent, so
// comments and untouched code keep their exact formatting.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const inDir = process.argv[2];
const outDir = process.argv[3];
if (!inDir || !outDir) {
  console.error('usage: node convert-main.mjs <inDir/with/main> <outDir>');
  process.exit(1);
}

const IGNORE_START = /^(?:"use strict";|'use strict';)$/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const HELPER_NAMES = [
  '__createBinding',
  '__setModuleDefault',
  '__importStar',
  '__exportStar',
  '__importDefault',
  '__awaiter',
  '__generator',
  '__spreadArray',
  '__decorate',
  '__assign',
  '__values',
];

function isHelperDecl(stmt, source) {
  if (!ts.isVariableStatement(stmt)) return false;
  return stmt.declarationList.declarations.some((d) => {
    const name = d.name.getText(source);
    return HELPER_NAMES.includes(name.split('.')[0]);
  });
}

function isEsModuleMarker(stmt, source) {
  if (!ts.isExpressionStatement(stmt)) return false;
  const text = stmt.getText(source).replace(/\s+/g, ' ').trim();
  return /^Object\.defineProperty\(exports, ?["']__esModule["'], ?\{ ?value: ?true ?\}\);?$/.test(text);
}

function isVoidZeroExports(stmt, source) {
  if (!ts.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!ts.isBinaryExpression(expr)) return false;
  const walkLeft = (e) => (ts.isBinaryExpression(e) ? walkLeft(e.left) : e);
  const walkRight = (e) => (ts.isBinaryExpression(e) ? walkRight(e.right) : e);
  const leftmost = walkLeft(expr);
  const rightmost = walkRight(expr);
  if (!ts.isVoidExpression(rightmost)) return false;
  return /^exports(\.[A-Za-z_$][\w$]*)+$/.test(leftmost.getText(source));
}

function isExportsAssignment(stmt, source) {
  if (!ts.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    /^exports\.[A-Za-z_$][\w$]*$/.test(expr.left.getText(source))
  );
}

function requireCallOf(node) {
  if (!node || !ts.isCallExpression(node)) return undefined;
  if (node.expression.getText() !== 'require') return undefined;
  if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return undefined;
  return node.arguments[0].text;
}

function classifyInitializer(init) {
  const direct = requireCallOf(init);
  if (direct !== undefined) return { kind: 'named', spec: direct };
  if (init && ts.isCallExpression(init) && init.arguments.length === 1) {
    const fn = init.expression.getText();
    const inner = requireCallOf(init.arguments[0]);
    if (inner !== undefined && (fn === '__importDefault' || fn === '__importStar')) {
      return { kind: fn === '__importDefault' ? 'default' : 'star', spec: inner };
    }
  }
  return undefined;
}

function deriveDefaultName(spec) {
  const base = spec
    .replace(/^node:/, '')
    .split('/')
    .filter(Boolean)
    .pop()
    .replace(/\.[jt]sx?$/, '')
    .replace(/[-.]+(\w)/g, (_, c) => c.toUpperCase())
    .replace(/[^A-Za-z0-9_$]/g, '_')
    .replace(/^[0-9]/, '_$&');
  return base || 'mod';
}

function convertFile(text, fileName, diagnostics) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {{start:number,end:number,text:string,note?:string}[]} */
  const edits = [];
  const statements = source.statements;
  const removed = new Set();
  // Ranges replaced as a whole; the member-rewrite pass must not touch them.
  const protectedRanges = [];
  const addProtected = (start, end) => protectedRanges.push([start, end]);

  // 0. All top-level declared identifiers (for collision-safe import names).
  const topLevelNames = new Set();
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) topLevelNames.add(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name) topLevelNames.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) topLevelNames.add(d.name.text);
    }
  }
  // Every identifier bound anywhere (imports, parameters, locals, catch clauses);
  // a local alias must not collide with any of them.
  const boundNames = new Set(topLevelNames);
  const collectBound = (node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
      const name = node.name;
      if (name && ts.isIdentifier(name)) boundNames.add(name.text);
      else if (name && ts.isObjectBindingPattern(name)) for (const el of name.elements) if (ts.isIdentifier(el.name)) boundNames.add(el.name.text);
      else if (name && ts.isArrayBindingPattern(name)) for (const el of name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) boundNames.add(el.name.text);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      boundNames.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      const name = node.variableDeclaration.name;
      if (ts.isIdentifier(name)) boundNames.add(name.text);
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) boundNames.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) boundNames.add(clause.namedBindings.name.text);
    }
    node.forEachChild(collectBound);
  };
  collectBound(source);

  // 1. Prologue: "use strict", helpers, __esModule marker, void-0 line.
  const voidZeroStmtsRaw = [];
  for (const stmt of statements) {
    if (ts.isExpressionStatement(stmt)) {
      const t = stmt.getText(source).replace(/\s+/g, ' ').trim();
      if (IGNORE_START.test(t)) {
        edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
        addProtected(stmt.getStart(source), stmt.getEnd());
        removed.add(stmt);
        continue;
      }
    }
    if (isHelperDecl(stmt, source) || isEsModuleMarker(stmt, source)) {
      edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
      addProtected(stmt.getStart(source), stmt.getEnd());
      removed.add(stmt);
      continue;
    }
    if (isVoidZeroExports(stmt, source)) {
      edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
      addProtected(stmt.getStart(source), stmt.getEnd());
      removed.add(stmt);
      voidZeroStmtsRaw.push(stmt);
    }
  }

  // 2. Require declarations.
  const requires = [];
  for (const stmt of statements) {
    if (removed.has(stmt)) continue;
    if (!ts.isVariableStatement(stmt)) continue;
    const decls = stmt.declarationList.declarations;
    if (decls.length !== 1) continue;
    const d = decls[0];
    if (!ts.isIdentifier(d.name) || !d.initializer) continue;
    const cls = classifyInitializer(d.initializer);
    if (!cls) continue;
    requires.push({ id: d.name.text, spec: cls.spec, kind: cls.kind, stmt, decl: d, kw: stmt.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'var' });
  }
  const reqById = new Map(requires.map((r) => [r.id, r]));

  // Member uses of each require binding.
  const usesOf = (idName) => {
    const props = new Map();
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === idName) {
        const prop = node.name.text;
        props.set(prop, (props.get(prop) ?? 0) + 1);
      }
      node.forEachChild(visit);
    };
    visit(source);
    return props;
  };
  for (const r of requires) r.uses = usesOf(r.id);

  // 3. Getter re-exports.
  const getterReexports = [];
  for (const stmt of statements) {
    if (removed.has(stmt)) continue;
    if (!ts.isExpressionStatement(stmt)) continue;
    const flat = stmt.getText(source).replace(/\s+/g, ' ');
    let matched = /^Object\.defineProperty\(\s*exports\s*,\s*(["'])([^"']+)\1\s*,\s*\{\s*enumerable:\s*true\s*,\s*get:\s*function\s*\(\s*\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*;?\s*\}\s*\}\s*\)\s*;?$/.exec(
      flat
    );
    if (matched) {
      getterReexports.push({ stmt, exportName: matched[2], ns: matched[3], prop: matched[4] });
      continue;
    }
    matched = /^Object\.defineProperty\(\s*exports\s*,\s*(["'])([^"']+)\1\s*,\s*\{\s*enumerable:\s*true\s*,\s*get:\s*function\s*\(\s*\)\s*\{\s*return\s+__importDefault\(([A-Za-z_$][\w$]*)\)\.default\s*;?\s*\}\s*\}\s*\)\s*;?$/.exec(
      flat
    );
    if (matched) {
      getterReexports.push({ stmt, exportName: matched[2], ns: matched[3], prop: 'default', isDefault: true });
    }
  }
  const gettersByNs = new Map();
  for (const g of getterReexports) {
    if (!gettersByNs.has(g.ns)) gettersByNs.set(g.ns, []);
    gettersByNs.get(g.ns).push(g);
  }

  // 4. exports.X = X; / exports.X = expr; / exports.default = X;
  const declExports = new Map(); // localName -> exportName (re-export of a declaration)
  const defaultExportStmts = [];
  const declConstStmts = []; // declaration-form exported const/let
  for (const stmt of statements) {
    if (removed.has(stmt)) continue;
    if (!isExportsAssignment(stmt, source)) continue;
    const expr = stmt.expression;
    const exportName = expr.left.getText(source).slice('exports.'.length);
    if (exportName === 'default') {
      defaultExportStmts.push(stmt);
      continue;
    }
    // Re-export of a local declaration: `exports.fn = fn;`
    let declared = false;
    if (ts.isIdentifier(expr.right) && expr.right.text === exportName) {
      for (const other of statements) {
        if (ts.isFunctionDeclaration(other) && other.name?.text === exportName) declared = true;
        else if (ts.isClassDeclaration(other) && other.name?.text === exportName) declared = true;
        else if (ts.isVariableStatement(other)) {
          for (const d of other.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === exportName) declared = true;
          }
        }
      }
    }
    if (declared) {
      declExports.set(exportName, exportName);
      continue;
    }
    // Declaration form: `exports.NAME = expr;` (from `export const NAME = expr`)
    // or `exports.NAME = void 0;` (from `export let NAME;`).
    declConstStmts.push({ stmt, name: exportName, value: expr.right, isVoid0: ts.isVoidExpression(expr.right) });
  }
  // Reassigned declared names must become `let`.
  const assignStmtOf = (node) => {
    let stmt = node;
    while (stmt.parent && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
    return stmt;
  };
  const countOtherAssignments = (name, exclude) => {
    let n = 0;
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (node.left.getText(source) === `exports.${name}` && !exclude.has(assignStmtOf(node))) n += 1;
      }
      node.forEachChild(visit);
    };
    visit(source);
    return n;
  };
  const declStmtSet = new Set(declConstStmts.map((d) => d.stmt));
  const reassigned = new Set();
  for (const { name } of declConstStmts) {
    if (countOtherAssignments(name, declStmtSet) > 0) reassigned.add(name);
  }

  const localNames = boundNames;

  // --- Statement replacements ---

  const importInfoById = new Map();
  const requireReplacement = new Map();

  for (const req of requires) {
    const getters = gettersByNs.get(req.id) ?? [];
    const getterProps = new Set(getters.map((g) => g.prop));
    if (req.kind === 'star') {
      importInfoById.set(req.id, { kind: 'star', id: req.id });
      requireReplacement.set(req.id, `import * as ${req.id} from "${req.spec}";`);
      continue;
    }
    if (req.kind === 'default') {
      let name = deriveDefaultName(req.spec);
      while (localNames.has(name)) name += '_';
      localNames.add(name);
      importInfoById.set(req.id, { kind: 'default', local: name });
      requireReplacement.set(req.id, `import ${name} from "${req.spec}";`);
      continue;
    }
    const props = [...req.uses.keys()].filter((p) => p !== 'default');
    // `const` requires are plain imports and may also feed bare `export { x }`
    // re-exports; `var` requires are the emit of `export { x } from "…"`.
    const regularProps =
      req.kw === 'const' ? props : props.filter((p) => !getterProps.has(p));
    const alias = new Map();
    if (regularProps.length > 0) {
      const parts = [];
      for (const p of regularProps) {
        let local = p;
        if (localNames.has(local)) {
          const base = deriveDefaultName(req.spec);
          local = `${base}${p[0].toUpperCase()}${p.slice(1)}`;
          while (localNames.has(local)) local += '_';
        }
        localNames.add(local);
        alias.set(p, local);
        parts.push(local === p ? p : `${p} as ${local}`);
      }
      requireReplacement.set(req.id, `import { ${parts.join(', ')} } from "${req.spec}";`);
    } else {
      requireReplacement.set(req.id, '');
    }
    importInfoById.set(req.id, { kind: 'named', alias });
  }

  // `var` requires exist only to serve `export { … } from "…"` statements; the
  // whole group is re-emitted as one merged re-export at the require position.
  const varGetterByNs = new Map();
  for (const g of getterReexports) {
    const req = reqById.get(g.ns);
    if (req && req.kw === 'var') {
      if (!varGetterByNs.has(g.ns)) varGetterByNs.set(g.ns, []);
      varGetterByNs.get(g.ns).push(g);
    }
  }
  for (const [ns, group] of varGetterByNs) {
    const req = reqById.get(ns);
    const names = group.map((g) => (g.prop === g.exportName ? g.prop : `${g.prop} as ${g.exportName}`));
    edits.push({
      start: req.stmt.getStart(source),
      end: req.stmt.getEnd(),
      text: `export { ${names.join(', ')} } from "${req.spec}";`,
    });
    addProtected(req.stmt.getStart(source), req.stmt.getEnd());
    for (const g of group) {
      edits.push({ start: g.stmt.getStart(source), end: g.stmt.getEnd(), text: '' });
      addProtected(g.stmt.getStart(source), g.stmt.getEnd());
    }
  }

  // Protected ranges: statements fully replaced (require decls, getters, removals, ...).

  for (const req of requires) {
    if (varGetterByNs.has(req.id)) continue;
    const replacement = requireReplacement.get(req.id);
    if (replacement === undefined) continue;
    edits.push({ start: req.stmt.getStart(source), end: req.stmt.getEnd(), text: replacement });
    addProtected(req.stmt.getStart(source), req.stmt.getEnd());
  }

  for (const g of getterReexports) {
    if (varGetterByNs.has(g.ns)) continue;
    const req = reqById.get(g.ns);
    if (!req) {
      diagnostics.push(`${fileName}: getter re-export with unknown namespace ${g.ns}`);
      continue;
    }
    const info = importInfoById.get(req.id);
    const alias = info?.kind === 'named' ? info.alias.get(g.prop) : undefined;
    let replacement;
    if (alias !== undefined) {
      // Form 1: plain import + bare re-export (emits `const ns_1 = require(...)`).
      replacement = `export { ${alias === g.exportName ? alias : `${alias} as ${g.exportName}`} };`;
    } else {
      // Form 2: `export { x } from "…"` (emits `var ns_1 = require(...)`).
      replacement = `export { ${g.prop === g.exportName ? g.prop : `${g.prop} as ${g.exportName}`} } from "${req.spec}";`;
    }
    edits.push({ start: g.stmt.getStart(source), end: g.stmt.getEnd(), text: replacement });
    addProtected(g.stmt.getStart(source), g.stmt.getEnd());
  }

  for (const stmt of statements) {
    if (removed.has(stmt)) continue;
    if (!ts.isExpressionStatement(stmt)) continue;
    const m = /^__exportStar\(\s*require\(\s*(["'])([^"']+)\1\s*\)\s*,\s*exports\s*\)\s*;?$/.exec(
      stmt.getText(source).replace(/\s+/g, ' ')
    );
    if (m) {
      edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: `export * from "${m[2]}";` });
      addProtected(stmt.getStart(source), stmt.getEnd());
    }
  }

  // Dynamic imports: `Promise.resolve(<tpl>).then(s => __importStar(require(s)))`
  // and `Promise.resolve().then(() => __importStar(require("lit")))` are the
  // CommonJS emit of `import(<expr>)`.
  const dynamicImportEdits = [];
  const visitDyn = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then') {
      const promise = node.expression.expression;
      const arg0 = node.arguments[0];
      if (
        ts.isCallExpression(promise) &&
        ts.isPropertyAccessExpression(promise.expression) &&
        promise.expression.expression.getText(source) === 'Promise' &&
        promise.expression.name.text === 'resolve' &&
        arg0 &&
        ts.isArrowFunction(arg0) &&
        arg0.parameters.length <= 1
      ) {
        const body = arg0.body;
        const requireArg = (() => {
          if (!ts.isCallExpression(body) || body.expression.getText(source) !== '__importStar') return undefined;
          const inner = body.arguments[0];
          if (!inner || !ts.isCallExpression(inner) || inner.expression.getText(source) !== 'require') return undefined;
          return inner.arguments[0];
        })();
        if (requireArg) {
          let inner;
          if (promise.arguments.length === 0 && arg0.parameters.length === 0) {
            inner = requireArg.getText(source); // string literal
          } else if (
            promise.arguments.length === 1 &&
            arg0.parameters.length === 1 &&
            ts.isIdentifier(arg0.parameters[0].name) &&
            ts.isIdentifier(requireArg) &&
            requireArg.text === arg0.parameters[0].name.text
          ) {
            const tpl = promise.arguments[0];
            if (
              ts.isTemplateExpression(tpl) &&
              tpl.head.text === '' &&
              tpl.templateSpans.length === 1 &&
              tpl.templateSpans[0].literal.text === ''
            ) {
              inner = tpl.templateSpans[0].expression.getText(source);
            }
          }
          if (inner !== undefined) {
            dynamicImportEdits.push({ start: node.getStart(source), end: node.getEnd(), text: `import(${inner})` });
          }
        }
      }
    }
    node.forEachChild(visitDyn);
  };
  visitDyn(source);
  for (const e of dynamicImportEdits) {
    edits.push(e);
    addProtected(e.start, e.end);
  }

  for (const [localName, exportName] of declExports) {
    if (exportName !== localName) {
      diagnostics.push(`${fileName}: renamed export ${localName} as ${exportName} (left as-is)`);
    }
    let declStmt;
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === localName) declStmt = stmt;
      else if (ts.isClassDeclaration(stmt) && stmt.name?.text === localName) declStmt = stmt;
      else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === localName) declStmt ??= stmt;
        }
      }
    }
    if (!declStmt) {
      diagnostics.push(`${fileName}: export assignment for ${localName} without declaration`);
      continue;
    }
    edits.push({ start: declStmt.getStart(source), end: declStmt.getStart(source), text: 'export ' });
    for (const stmt of statements) {
      if (removed.has(stmt) || !isExportsAssignment(stmt, source)) continue;
      const expr = stmt.expression;
      if (
        expr.left.getText(source) === `exports.${exportName}` &&
        ts.isIdentifier(expr.right) &&
        expr.right.text === localName
      ) {
        edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
        addProtected(stmt.getStart(source), stmt.getEnd());
      }
    }
  }

  for (const stmt of defaultExportStmts) {
    const expr = stmt.expression;
    edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: `export default ${expr.right.getText(source)};` });
    addProtected(stmt.getStart(source), stmt.getEnd());
  }

  // Declaration-form exports: `exports.NAME = expr;` / `exports.NAME = void 0;`.
  const declExportLefts = new Set();
  for (const { stmt, name, isVoid0 } of declConstStmts) {
    if (isVoid0) {
      edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: `export let ${name};` });
      addProtected(stmt.getStart(source), stmt.getEnd());
      continue;
    }
    const expr = stmt.expression;
    const left = expr.left;
    const keyword = reassigned.has(name) ? 'let' : 'const';
    edits.push({ start: left.getStart(source), end: left.getEnd(), text: `export ${keyword} ${name}` });
    declExportLefts.add(left.getStart(source));
  }

  // Names listed in the void-0 prologue without a later assignment are
  // uninitialized exported bindings (`export let NAME;`).
  const orphanNames = [];
  for (const stmt of voidZeroStmtsRaw) {
    const names = [];
    const collect = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === 'exports'
      ) {
        names.push(node.left.name.text);
      }
      node.forEachChild(collect);
    };
    collect(stmt.expression);
    for (const name of names) {
      if (declConstStmts.some((d) => d.name === name)) continue;
      if (declExports.has(name)) continue;
      if (getterReexports.some((g) => g.exportName === name)) continue;
      orphanNames.push({ name, stmt });
    }
  }
  // Encounter order is the reverse of the prologue list order; inserting at the
  // prologue position keeps their relative order when edits are applied right-to-left.
  for (const { name, stmt } of orphanNames) {
    edits.push({ start: stmt.getStart(source), end: stmt.getStart(source), text: `export let ${name};\n` });
  }

  const inProtected = (node) => {
    const start = node.getStart(source);
    return protectedRanges.some(([s, e]) => start >= s && node.getEnd() <= e);
  };

  // --- Member rewrites ---

  const exportedNames = new Set([...declExports.keys(), ...declConstStmts.map((d) => d.name)]);

  const visit = (node) => {
    // (0, ns.prop)(...) and ns.prop for require bindings.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const nsName = node.expression.text;
      const req = reqById.get(nsName);
      if (req && !inProtected(node)) {
        const info = importInfoById.get(nsName);
        const prop = node.name.text;
        let replacement;
        if (info?.kind === 'star') replacement = undefined;
        else if (info?.kind === 'default') replacement = prop === 'default' ? info.local : undefined;
        else if (info?.kind === 'named') replacement = info.alias.get(prop);
        if (replacement !== undefined) {
          let start = node.getStart(source);
          let end = node.getEnd();
          const parent = node.parent;
          if (
            parent &&
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            ts.isNumericLiteral(parent.left) &&
            parent.left.text === '0' &&
            parent.parent &&
            ts.isParenthesizedExpression(parent.parent)
          ) {
            start = parent.parent.getStart(source);
            end = parent.parent.getEnd();
          }
          edits.push({ start, end, text: replacement });
        }
      }
      // exports.NAME references in the body.
      if (
        nsName === 'exports' &&
        exportedNames.has(node.name.text) &&
        !inProtected(node) &&
        !declExportLefts.has(node.getStart(source))
      ) {
        edits.push({ start: node.getStart(source), end: node.getEnd(), text: node.name.text });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  // Apply edits (descending; skip overlaps).
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let cursor = Number.MAX_SAFE_INTEGER;
  const skipped = [];
  for (const e of edits) {
    if (e.end > cursor) {
      skipped.push(e);
      continue;
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    cursor = e.start;
  }
  if (skipped.length) {
    const s = skipped[0];
    diagnostics.push(
      `${fileName}: ${skipped.length} overlapping edit(s) skipped; first: [${s.start},${s.end}) orig=${JSON.stringify(
        text.slice(s.start, Math.min(s.end, s.start + 70))
      )} new=${JSON.stringify(s.text.slice(0, 70))}`
    );
  }
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '');
  // A module whose runtime content was fully erased (type-only module) still
  // emits the `"use strict"` + `__esModule` prologue; keep it a module.
  if (statements.some((s) => removed.has(s)) && !/\b(?:import|export|require)\b/.test(out)) {
    out = out.replace(/\s*$/, '\n\nexport {};\n');
  }
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function main() {
  const files = walk(inDir).filter((f) => f.endsWith('.js'));
  const diagnostics = [];
  let converted = 0;
  for (const file of files) {
    const rel = path.relative(inDir, file).replace(/\\/g, '/');
    if (rel.endsWith('.bundle.js')) {
      // esbuild-produced preload bundle (banner `// main/…/preload.ts`); shipped verbatim.
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      converted += 1;
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const text = convertFile(src, rel, diagnostics);
    const dest = path.join(outDir, rel.replace(/\.js$/, '.ts'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
    converted += 1;
  }
  console.log(`converted ${converted} files`);
  for (const d of diagnostics) console.log('  ! ' + d);
}

main();
