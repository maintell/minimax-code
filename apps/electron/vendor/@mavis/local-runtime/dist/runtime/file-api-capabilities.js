/**
 * Normalize the legacy local alias once. The protocol field wins whenever it
 * is explicitly present, including `false`.
 */
export function normalizeLocalFileApiCapabilities(capabilities) {
    const enabled = typeof capabilities?.support_files_api === 'boolean'
        ? capabilities.support_files_api
        : capabilities?.use_file_api === true;
    if (!enabled)
        return { support_files_api: false };
    const uploadEndpoint = capabilities?.files_api_upload_endpoint?.trim();
    const refScheme = capabilities?.files_api_ref_scheme?.trim();
    const ttlSec = capabilities?.files_api_file_id_ttl_sec;
    return {
        support_files_api: true,
        ...(uploadEndpoint ? { files_api_upload_endpoint: uploadEndpoint } : {}),
        ...(refScheme ? { files_api_ref_scheme: refScheme } : {}),
        ...(typeof ttlSec === 'number' && Number.isFinite(ttlSec) && ttlSec >= 0
            ? { files_api_file_id_ttl_sec: ttlSec }
            : {}),
    };
}
//# sourceMappingURL=file-api-capabilities.js.map