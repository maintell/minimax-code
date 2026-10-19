import { resolveSourceProvenanceEnabled } from '@mavis/shared/source-provenance';
/** Local product ownership is supplied by the host, never inferred from env. */
export function isLocalSourceProvenanceEnabled(runtimeOwnerKind, env = process.env) {
    return resolveSourceProvenanceEnabled({
        platform: runtimeOwnerKind,
        internalBuild: env.__MAVIS_BUILD_INTERNAL === 'true',
        insideBuild: env.__MAVIS_BUILD_INSIDE === 'true',
    });
}
//# sourceMappingURL=source-provenance.js.map