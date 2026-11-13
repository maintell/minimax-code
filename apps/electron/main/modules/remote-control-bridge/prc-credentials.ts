// Desktop half of PRC mode: read the operator-declared gateway URL and trade
// the operator password for a one-shot binding ticket. Deliberately free of
// Electron and module state — `fetchImpl` is injected — so the bridge stays the
// only owner of the audit trail. Never log a ticket.

export interface PrcConfig {
  baseUrl: string;
  password: string;
  allowInsecureOrigin: boolean;
}

export interface PrcCredentials {
  binding_id: number;
  ticket: string;
  endpoint: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parsePrcConfig(raw: unknown): PrcConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const url = text(record.url);
  const password = text(record.password);
  if (!url || !password) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return {
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`,
    password,
    allowInsecureOrigin: record.allowInsecureOrigin === true,
  };
}

export function buildBindingUrl(baseUrl: string): string {
  return `${baseUrl}/minimax-cloud/api/v1/remote-control/desktop/bindings?rc_protocol_version=3`;
}

export async function fetchPrcBinding(deps: {
  config: PrcConfig;
  deviceId: string;
  clientVersion: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; credentials: PrcCredentials } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(buildBindingUrl(deps.config.baseUrl), {
      method: 'GET',
      // The password travels in a custom header, and custom headers survive a
      // redirect, so a 307/308 could replay it to another origin. A redirect is
      // a misconfiguration; surface it as a transport failure and never follow.
      redirect: 'error',
      headers: {
        'X-PRC-Password': deps.config.password,
        'X-Device-Id': deps.deviceId,
        'X-Producer-Type': 'desktop',
        'X-Client-Version': deps.clientVersion,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    return { ok: false, error: `network:${error instanceof Error ? error.name : 'unknown'}` };
  }
  if (response.status === 401) return { ok: false, error: 'not_authenticated' };
  if (!response.ok) return { ok: false, error: `http_${response.status}` };
  // A JSON body is untrusted whatever its shape: `null`, an array, or a scalar
  // all parse "successfully" and would throw on the field reads below.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'not_bound' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'not_bound' };
  }
  const record = body as Record<string, unknown>;
  const bindingId = record.binding_id;
  const ticket = text(record.ticket);
  const endpoint = text(record.endpoint);
  if (
    record.state !== 'bound' ||
    typeof bindingId !== 'number' ||
    !Number.isSafeInteger(bindingId) ||
    bindingId <= 0 ||
    !ticket ||
    !endpoint
  ) {
    return { ok: false, error: 'not_bound' };
  }
  return { ok: true, credentials: { binding_id: bindingId, ticket, endpoint } };
}
