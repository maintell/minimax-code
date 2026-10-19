import { domainMethodSigs, groupServiceByDomain } from './v2-domain-model.js';
import { domainControllerBaseClassName, domainControllerKey, toScreamingSnake, v2GeneratedHeader, } from './v2-naming.js';
/**
 * Emits `routing/bindings.gen.ts`: a `DesktopControllers` map type (one field
 * per api.domain, typed by the domain's generated contract) plus a
 * `makeBindings(controllers)` factory that wires each contract to its domain
 * controller's method. Handlers are arrow-wrapped to preserve `this` on the
 * injected controller. The composition root hand-writes `createControllers`
 * and calls `makeBindings(createControllers(deps))`. Regenerated in full on
 * every gen (design doc §4.1); contracts are type-only imports because
 * `verbatimModuleSyntax` forbids value-importing an interface.
 */
export function emitV2Bindings(definition) {
    if (definition.services.length !== 1) {
        throw new Error(`${definition.sourcePath}: v2 bindings generation expects exactly one service, got ${definition.services.length}`);
    }
    const service = definition.services[0];
    if (!service) {
        throw new Error(`${definition.sourcePath}: missing service for v2 bindings generation`);
    }
    const groups = groupServiceByDomain(service, definition.sourcePath);
    const baseImports = groups.map((group) => {
        const className = domainControllerBaseClassName(group.domain);
        const fileName = `${group.domain.replace(/_/g, '-')}-controller-base.gen.js`;
        return `import type { ${className} } from '../generated/${fileName}';`;
    });
    const fields = groups.map((group) => `  readonly ${domainControllerKey(group.domain)}: ${domainControllerBaseClassName(group.domain)};`);
    const bindings = groups.flatMap((group) => {
        const key = domainControllerKey(group.domain);
        return domainMethodSigs(group).map((sig) => {
            const define = sig.sse ? 'defineSseRoute' : 'defineRoute';
            return `    ${define}(contracts.${toScreamingSnake(sig.tsName)}, (ctx, req) => c.${key}.${sig.tsName}(ctx, req)),`;
        });
    });
    const lines = [
        v2GeneratedHeader(definition.sourcePath),
        "import { defineRoute, defineSseRoute, type RouteBinding } from './define-route.js';",
        "import * as contracts from './contracts.gen.js';",
        ...baseImports,
        '',
        'export interface DesktopControllers {',
        ...fields,
        '}',
        '',
        'export function makeBindings(c: DesktopControllers): readonly RouteBinding[] {',
        '  return [',
        ...bindings,
        '  ];',
        '}',
    ];
    return `${lines.join('\n')}\n`;
}
//# sourceMappingURL=emit-v2-bindings.js.map