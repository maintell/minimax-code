import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword, verifyPassword } from '../src/auth.ts';

test('a password round-trips through scrypt and rejects a wrong one', () => {
  const stored = hashPassword('correct horse');
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/u);
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('wrong horse', stored), false);
});

test('malformed stored hashes fail closed instead of throwing', () => {
  const cases = [
    ['scrypt$16384$8$1$c2FsdHNhbHQ=$', 'empty hash field'],
    ['scrypt$16384$8$1$c2FsdHNhbHQ=$!!!!', 'undecodable hash field'],
    ['scrypt$16384$8$1$$AAAA', 'empty salt'],
    ['scrypt$abc$8$1$AAAA$AAAA', 'non-numeric cost'],
    ['scrypt$16383$8$1$AAAA$AAAA', 'non-power-of-two cost'],
  ];
  for (const [stored, why] of cases) {
    assert.equal(verifyPassword('anything', stored), false, why);
    assert.equal(verifyPassword('', stored), false, `${why} (empty password)`);
  }
});

test('cookies are signed, expire, and reject tampering', () => {
  const auth = createAuth('server-secret');
  const cookie = auth.issueCookie(1_000);
  assert.equal(auth.verifyCookie(cookie, 2_000), true);
  assert.equal(auth.verifyCookie(cookie, 1_000 + 8 * 24 * 3600 * 1000), false);
  assert.equal(auth.verifyCookie(cookie.replace(/.$/u, 'x'), 2_000), false);
  assert.equal(auth.verifyCookie(undefined, 2_000), false);
});

test('csrf requires a matching header and cookie', () => {
  const auth = createAuth('server-secret');
  const csrf = auth.issueCsrf();
  assert.equal(auth.verifyCsrf(csrf, csrf), true);
  assert.equal(auth.verifyCsrf(csrf, 'other'), false);
});

test('login attempts are limited per key inside the window', () => {
  const auth = createAuth('server-secret');
  const now = 10_000;
  for (let i = 0; i < 5; i += 1) assert.equal(auth.allowLogin('1.2.3.4', now + i), true);
  assert.equal(auth.allowLogin('1.2.3.4', now + 6), false);
  assert.equal(auth.allowLogin('5.6.7.8', now + 6), true);
  assert.equal(auth.allowLogin('1.2.3.4', now + 61_000), true);
});
