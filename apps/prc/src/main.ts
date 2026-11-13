import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAuth, hashPassword } from './auth.ts';
import { CommandRouter } from './commands.ts';
import { loadConfig } from './config.ts';
import { ConsumerHub } from './consumer.ts';
import { createHttpApi } from './http.ts';
import type { Logger, ProducerSocket } from './producer.ts';
import { createServer } from './server.ts';
import { openStore } from './store.ts';

const config = loadConfig(process.env, process.argv.slice(2));
mkdirSync(config.dataDir, { recursive: true });

const logger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const operatorFile = path.join(config.dataDir, 'operator.json');
let passwordHash: string;
if (existsSync(operatorFile)) {
  const stored = JSON.parse(readFileSync(operatorFile, 'utf8')) as { hash?: unknown };
  if (typeof stored.hash !== 'string' || stored.hash.length === 0) {
    throw new Error(`${operatorFile} does not contain an operator password hash`);
  }
  passwordHash = stored.hash;
} else {
  if (!config.password) {
    throw new Error(
      'no operator password is stored yet: start once with --password <value> or PRC_PASSWORD to set it',
    );
  }
  passwordHash = hashPassword(config.password);
  writeFileSync(operatorFile, `${JSON.stringify({ hash: passwordHash }, null, 2)}\n`, { mode: 0o600 });
  logger.info(`operator password is now stored hashed in ${operatorFile}`);
}

// The cookie signing secret outlives restarts so sessions survive a redeploy.
const secretFile = path.join(config.dataDir, 'session-secret');
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
}
const secret = readFileSync(secretFile, 'utf8').trim();
if (!secret) throw new Error(`${secretFile} is empty`);

const store = openStore(path.join(config.dataDir, 'prc.sqlite'));
const auth = createAuth(secret);
const hub = new ConsumerHub();
// One live producer per binding; the router reads it, the socket layer writes it.
const producers = new Map<number, ProducerSocket>();
const router = new CommandRouter({ getProducer: (bindingId) => producers.get(bindingId), logger });
const api = createHttpApi({ auth, store, router, config, passwordHash });
const server = await createServer({
  config,
  api,
  realtime: { auth, store, router, hub, producers, logger },
});
console.log(`PRC listening on ${server.url} (public ${config.publicUrl})`);
