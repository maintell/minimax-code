import { emitHttpService } from './emit-http-service.js';
import { emitLocalRuntimeRoutes } from './emit-local-runtime-routes.js';
export function emitDesktopService(definition) {
    const generated = emitHttpService(definition.httpDefinition, {
        emitRuntime: true,
        routeMetadataStyle: 'full',
        runtimeImportPrefix: '../../runtime',
    });
    return {
        ...generated,
        localRuntimeRoutesTs: emitLocalRuntimeRoutes(definition.httpDefinition),
    };
}
//# sourceMappingURL=emit-desktop-service.js.map