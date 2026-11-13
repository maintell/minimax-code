import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('defaults bind localhost and keep the data dir inside the app', () => {
  const config = loadConfig({}, []);
  assert.equal(config.port, 8787);
  assert.equal(config.publicUrl, 'http://127.0.0.1:8787');
  assert.match(config.dataDir, /apps[\\/]prc[\\/]data$/u);
});

test('explicit public url wins and trailing slash is stripped', () => {
  const config = loadConfig({ PRC_PUBLIC_URL: 'https://prc.example.com/' }, []);
  assert.equal(config.publicUrl, 'https://prc.example.com');
});

test('bootstrap password comes from the flag or the environment', () => {
  assert.equal(loadConfig({ PRC_PASSWORD: 'from-env' }, []).password, 'from-env');
  assert.equal(loadConfig({}, ['--password', 'from-flag']).password, 'from-flag');
});
