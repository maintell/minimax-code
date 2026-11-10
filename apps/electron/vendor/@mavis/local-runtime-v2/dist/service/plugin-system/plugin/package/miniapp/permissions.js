import { miniAppPermissionId } from '@mavis/shared/miniapp-surface';
/** Switchable permissions the validated manifest declares, without installed authorization state. */
export function declaredMiniAppPermissions(miniapp) {
    return [
        ...(miniapp.hostConnectorAccess?.providers ?? []).map((provider) => miniAppPermissionId('connector', provider)),
        ...(miniapp.agentAccess ?? []).map((item) => miniAppPermissionId('agent', item)),
        ...(miniapp.toolAccess?.includes('call') ? [miniAppPermissionId('tool', 'call')] : []),
        ...(miniapp.deviceAccess ?? []).map((item) => miniAppPermissionId('device', item)),
        ...(miniapp.hostAccess ?? []).map((item) => miniAppPermissionId('host', item)),
    ];
}
//# sourceMappingURL=permissions.js.map