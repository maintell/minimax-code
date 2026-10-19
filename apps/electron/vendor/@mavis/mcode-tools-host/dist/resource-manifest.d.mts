/**
 * Shared by runtime validation and source-based packaging scripts. Schema 3
 * remains valid for existing staging/prod locks; schema 4 permits only the
 * registry-js prebuilds needed by the CLI's own system proxy discovery.
 * @param {unknown} value
 * @returns {{ path: string, sha256: string }[]}
 */
export function validateEmbeddedResourceManifest(value: unknown): {
    path: string;
    sha256: string;
}[];
/** @param {string} rootDir @param {unknown} manifest */
export function validateEmbeddedResourceFiles(rootDir: string, manifest: unknown): void;
//# sourceMappingURL=resource-manifest.d.mts.map