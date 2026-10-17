import path from "node:path";
export function resolveDevelopmentUserDataPath({ defaultUserDataPath, userDataAppName, override, }) {
    const explicitPath = override?.trim();
    if (explicitPath) {
        if (!path.isAbsolute(explicitPath)) {
            throw new Error('MAVIS_ELECTRON_DEV_USER_DATA_DIR must be an absolute path');
        }
        return path.normalize(explicitPath);
    }
    return path.join(path.dirname(defaultUserDataPath), userDataAppName);
}
