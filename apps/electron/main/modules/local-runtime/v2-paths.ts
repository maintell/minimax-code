import * as path from "node:path";
import { resolveLocalRuntimeDataDir } from "./data-dir";
export function resolveLocalRuntimeV2DirectoryContract(dataDir = resolveLocalRuntimeDataDir()) {
    const root = path.join(dataDir, 'v2');
    const sessions = path.join(root, 'sessions');
    const chats = path.join(root, 'chats');
    const observability = path.join(root, 'observability');
    const logs = path.join(observability, 'logs');
    const migration = path.join(root, 'migration');
    return {
        root,
        sessions,
        chats,
        db: path.join(chats, 'local-runtime.sqlite'),
        ledgers: path.join(chats, 'ledgers'),
        snapshots: path.join(chats, 'snapshots'),
        assets: path.join(root, 'assets'),
        observability,
        logs,
        events: path.join(observability, 'events'),
        diagnostics: path.join(observability, 'diagnostics'),
        migration,
        migrationManifests: path.join(migration, 'manifests'),
    };
}
