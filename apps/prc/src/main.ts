import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const config = loadConfig(process.env, process.argv.slice(2));
const server = await createServer({ config });
console.log(`PRC listening on ${server.url} (public ${config.publicUrl})`);
