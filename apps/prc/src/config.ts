import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  dataDir: string;
  publicUrl: string;
  password?: string;
  trustProxy: boolean;
}

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig(
  env: Record<string, string | undefined>,
  argv: string[],
): Config {
  const flagIndex = argv.indexOf('--password');
  const flagValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const password = flagValue ?? env.PRC_PASSWORD;
  const port = Number(env.PRC_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PRC_PORT: ${String(env.PRC_PORT)}`);
  }
  const dataDir = path.resolve(env.PRC_DATA_DIR ?? path.join(appDir, 'data'));
  const publicUrl = (env.PRC_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/u, '');
  // Only an explicit opt-in may trust a client-supplied forwarding header.
  const trustProxy = env.PRC_TRUST_PROXY === '1' || env.PRC_TRUST_PROXY === 'true';
  return { port, dataDir, publicUrl, trustProxy, ...(password ? { password } : {}) };
}
