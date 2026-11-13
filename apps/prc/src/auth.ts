import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const COOKIE_TTL_MS = 7 * 24 * 3600 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT = 5;
const MIN_SALT_BYTES = 8;
const MIN_KEY_BYTES = 32;
const MAX_SCRYPT_N = 1_048_576;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

interface StoredHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseCost(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function decodeField(value: string, minBytes: number): Buffer | undefined {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= minBytes ? bytes : undefined;
}

function parseStored(stored: string): StoredHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [, n, r, p, salt, key] = parts;
  const N = parseCost(n, 2, MAX_SCRYPT_N);
  const costR = parseCost(r, 1, MAX_SCRYPT_R);
  const costP = parseCost(p, 1, MAX_SCRYPT_P);
  if (N === undefined || costR === undefined || costP === undefined) return undefined;
  if ((N & (N - 1)) !== 0) return undefined;
  const saltBytes = decodeField(salt, MIN_SALT_BYTES);
  const keyBytes = decodeField(key, MIN_KEY_BYTES);
  if (!saltBytes || !keyBytes) return undefined;
  return { N, r: costR, p: costP, salt: saltBytes, key: keyBytes };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, parsed.salt, parsed.key.length, {
      N: parsed.N, r: parsed.r, p: parsed.p,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(parsed.key, actual);
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function createAuth(secret: string) {
  const attempts = new Map<string, number[]>();
  const makeToken = (payload: string) => `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(secret, payload)}`;

  return {
    issueCookie(nowMs = Date.now()): string {
      const expiresAt = nowMs + COOKIE_TTL_MS;
      return makeToken(`s|${expiresAt}`);
    },
    verifyCookie(raw: string | undefined, nowMs = Date.now()): boolean {
      if (!raw) return false;
      const [body, signature] = raw.split('.');
      if (!body || !signature) return false;
      const payload = Buffer.from(body, 'base64url').toString('utf8');
      const expected = sign(secret, payload);
      if (expected.length !== signature.length) return false;
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
      const [, expiresAt] = payload.split('|');
      return Number(expiresAt) > nowMs;
    },
    issueCsrf(): string {
      return randomBytes(24).toString('base64url');
    },
    verifyCsrf(cookie: string, header: string | undefined): boolean {
      if (!header || header.length !== cookie.length) return false;
      return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
    },
    allowLogin(key: string, nowMs = Date.now()): boolean {
      const fresh = (attempts.get(key) ?? []).filter((ts) => nowMs - ts < LOGIN_WINDOW_MS);
      if (fresh.length >= LOGIN_LIMIT) {
        attempts.set(key, fresh);
        return false;
      }
      fresh.push(nowMs);
      attempts.set(key, fresh);
      return true;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
