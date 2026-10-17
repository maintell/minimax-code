import { assertTsIdentifier } from './ts-type-mapper.js';
import { toScreamingSnake, v2GeneratedHeader } from './v2-naming.js';
export function emitV2Contracts(definition) {
    if (definition.services.length !== 1) {
        throw new Error(`${definition.sourcePath}: v2 contracts generation expects exactly one service, got ${definition.services.length}`);
    }
    const service = definition.services[0];
    if (!service) {
        throw new Error(`${definition.sourcePath}: missing service for v2 contracts generation`);
    }
    const constNames = new Map();
    const registerConstName = (tsName) => {
        assertTsIdentifier(tsName, `v2 contract ${tsName}`);
        const constName = toScreamingSnake(tsName);
        const existing = constNames.get(constName);
        if (existing !== undefined) {
            throw new Error(`${definition.sourcePath}: v2 contract constant collision: '${existing}' and '${tsName}' both map to ${constName}`);
        }
        constNames.set(constName, tsName);
        return constName;
    };
    const typeNames = new Set();
    for (const m of service.methods) {
        typeNames.add(m.requestType);
        typeNames.add(m.responseType);
    }
    for (const s of service.sseContracts) {
        typeNames.add(s.requestType);
        typeNames.add(s.frameType);
        if (s.errorBodyType)
            typeNames.add(s.errorBodyType);
    }
    const lines = [
        v2GeneratedHeader(definition.sourcePath),
        "import { DESKTOP_SERVICE_ROUTES, DESKTOP_SERVICE_SSE_CONTRACTS } from '@mavis/thrift-gen/generated/desktop-service/routes';",
        'import type {',
        ...[...typeNames].sort().map((n) => `  ${n},`),
        "} from '@mavis/thrift-gen/generated/desktop-service/types';",
        "import type { RouteContract, SseRouteContract } from './define-route.js';",
        '',
    ];
    for (const m of service.methods) {
        lines.push(`export const ${registerConstName(m.tsName)}: RouteContract<${m.requestType}, ${m.responseType}> = { name: '${m.tsName}', meta: DESKTOP_SERVICE_ROUTES.${m.tsName} };`);
    }
    for (const s of service.sseContracts) {
        const errorType = s.errorBodyType ?? 'unknown';
        lines.push(`export const ${registerConstName(s.tsName)}: SseRouteContract<${s.requestType}, ${s.frameType}, ${errorType}> = { name: '${s.tsName}', meta: DESKTOP_SERVICE_SSE_CONTRACTS.${s.tsName} };`);
    }
    return `${lines.join('\n')}\n`;
}
//# sourceMappingURL=emit-v2-contracts.js.map