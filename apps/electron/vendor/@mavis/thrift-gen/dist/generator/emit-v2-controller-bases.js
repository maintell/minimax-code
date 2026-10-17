import { domainImportedTypes, domainMethodSigs, groupServiceByDomain, } from './v2-domain-model.js';
import { domainControllerBaseClassName, v2GeneratedHeader } from './v2-naming.js';
const GENERATED_PRINT_WIDTH = 100;
const DESKTOP_SERVICE_TYPES_MODULE = '@mavis/thrift-gen/generated/desktop-service/types';
/**
 * Emits one generated default implementation per api.domain. Every method has
 * the exact IDL-derived signature and throws NotImplementedError by default.
 * Hand-written controllers extend these classes and override only migrated
 * methods; regenerated bases are safe to overwrite.
 */
export function emitV2ControllerBases(definition) {
    if (definition.services.length !== 1) {
        throw new Error(`${definition.sourcePath}: v2 controller base generation expects exactly one service, got ${definition.services.length}`);
    }
    const service = definition.services[0];
    if (!service) {
        throw new Error(`${definition.sourcePath}: missing service for v2 controller base generation`);
    }
    const groups = groupServiceByDomain(service, definition.sourcePath);
    return groups.map((group) => ({
        fileName: `${group.domain.replace(/_/g, '-')}-controller-base.gen.ts`,
        content: emitDomainBase(definition.sourcePath, group),
    }));
}
function emitDomainBase(sourcePath, group) {
    const { types, hasSse } = domainImportedTypes(group);
    const className = domainControllerBaseClassName(group.domain);
    const methods = domainMethodSigs(group);
    const lines = [
        v2GeneratedHeader(sourcePath),
        ...emitTypeImport(types),
        ...(hasSse ? ["import type { SseOpenResult } from '@mavis/thrift-gen/runtime';"] : []),
        "import type { RequestContext } from '../context.js';",
        "import { NotImplementedError } from '../errors.js';",
        '',
        `export class ${className} {`,
        ...methods.flatMap((sig, index) => [
            ...emitMethod(sig),
            ...(index < methods.length - 1 ? [''] : []),
        ]),
        '}',
        '',
    ];
    return lines.join('\n');
}
function emitTypeImport(types) {
    const inline = `import type { ${types.join(', ')} } from '${DESKTOP_SERVICE_TYPES_MODULE}';`;
    return inline.length <= GENERATED_PRINT_WIDTH
        ? [inline]
        : [
            'import type {',
            ...types.map((typeName) => `  ${typeName},`),
            `} from '${DESKTOP_SERVICE_TYPES_MODULE}';`,
        ];
}
function emitMethod(sig) {
    const inline = `  async ${sig.tsName}(ctx: RequestContext, req: ${sig.requestType}): ${sig.returnType} {`;
    const signature = inline.length <= GENERATED_PRINT_WIDTH
        ? [inline]
        : [
            `  async ${sig.tsName}(`,
            '    ctx: RequestContext,',
            `    req: ${sig.requestType},`,
            `  ): ${sig.returnType} {`,
        ];
    return [
        ...signature,
        '    void ctx;',
        '    void req;',
        `    throw new NotImplementedError('${sig.tsName}');`,
        '  }',
    ];
}
//# sourceMappingURL=emit-v2-controller-bases.js.map