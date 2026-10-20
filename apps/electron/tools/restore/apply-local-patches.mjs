// Re-apply the local behavioural patches to freshly vendored snapshots.
//
// The shipped client retries a failed model request with exponential backoff and
// a five-attempt / two-minute budget, and treats a handful of transport shapes as
// terminal. This product wants the opposite: provider errors retry without a
// practical limit, on a fixed three-second cadence, so an unstable upstream
// recovers on its own.
//
// Re-vendoring a new shipped build resets these files to their shipped content,
// so the patches live here instead of being hand-edited into the snapshot. Every
// anchor is asserted: if an upgrade refactors the emitted code, this script fails
// loudly instead of silently shipping the shipped defaults.
//
// Usage: node apply-local-patches.mjs [vendorRoot]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorRoot =
  process.argv[2] ?? path.join(fileURLToPath(new URL("../..", import.meta.url)), "vendor");

function patchFile(relativePath, patches) {
  const file = path.join(vendorRoot, relativePath);
  if (!fs.existsSync(file)) throw new Error(`missing vendored file: ${file}`);
  const original = fs.readFileSync(file, "utf8");
  let text = original;
  for (const { find, replace, label } of patches) {
    // Idempotent: a snapshot that already carries the patch is left alone.
    if (text.includes(replace)) continue;
    if (!text.includes(find)) {
      throw new Error(
        `${relativePath}: anchor not found for "${label}". The shipped code changed; ` +
          "review the new implementation before re-applying this patch.",
      );
    }
    text = text.replace(find, replace);
  }
  if (text === original) {
    console.log(`[patch] ${relativePath} (already patched)`);
    return;
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(`[patch] ${relativePath}`);
}

// --- retry policy: unlimited attempts, fixed three-second cadence -------------
patchFile("@mavis/agent-core/dist/pi-turn-runner/llm-retry.js", [
  {
    label: "default retry policy",
    find: `export const DEFAULT_LLM_RETRY_POLICY = {
    maxRetries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxRetryElapsedMs: 120_000,
};`,
    replace: `export const DEFAULT_LLM_RETRY_POLICY = {
    // Local patch: provider errors retry without a practical limit on a fixed
    // three-second cadence (no backoff, no wall-clock budget). The budget is the
    // largest serialisable integer because the retry-event contract requires a
    // non-negative integer; only user cancellation, model refusals, wrong
    // credentials, exhausted quota and deterministic request rejections stay
    // terminal.
    maxRetries: 2_147_483_647,
    baseDelayMs: 3_000,
    maxDelayMs: 30_000,
    maxRetryElapsedMs: Number.POSITIVE_INFINITY,
};`,
  },
  {
    label: "retry delay",
    find: `    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryAttempt - 1));
    return Math.floor(exponential / 2 + (clampRandom(random()) * exponential) / 2);`,
    replace: `    // Local patch: unstable upstreams retry on the fixed \`baseDelayMs\` cadence
    // (no exponential growth, no jitter); a server-directed Retry-After still
    // wins above.
    return policy.baseDelayMs;`,
  },
  {
    label: "retry-everything terminal kinds",
    find: `        !normalized.facts.signals.has('refusal') &&
        !isLLMDeterministicRequestRejection(normalized) &&`,
    replace: `        !normalized.facts.signals.has('refusal') &&
        // Local patch: a wrong credential or an exhausted usage plan cannot be
        // fixed by waiting; those stay terminal under the unbounded budget.
        !['auth', 'usage_limit', 'credits_exhausted'].includes(toLLMMetricErrorKind(normalized.facts)) &&
        !isLLMDeterministicRequestRejection(normalized) &&`,
  },
]);

// --- classifier: a dropped body / 5xx is upstream instability, not a rejection
patchFile("@mavis/shared/dist/llm-error-classifier.js", [
  {
    label: "network code set",
    find: `    'ERR_HTTP2_PROTOCOL_ERROR',`,
    replace: `    'ERR_HTTP2_PROTOCOL_ERROR',
    // Local patch: a response body that ends early is the classic flaky-upstream
    // shape (the server or an intermediary dropped the connection mid-stream).
    'ERR_INCOMPLETE_CHUNKED_ENCODING',
    'ERR_EMPTY_RESPONSE',`,
  },
  {
    label: "chromium network message pattern",
    find: `HTTP2_PROTOCOL_ERROR|SSL_BAD_RECORD_MAC_ALERT)`,
    replace: `HTTP2_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|SSL_BAD_RECORD_MAC_ALERT)`,
  },
  {
    label: "retry decision tail",
    find: `    if (status === 529)
        return { retryable: true, reason: 'overloaded' };
    return { retryable: false, reason: metricKind };`,
    replace: `    if (status === 529)
        return { retryable: true, reason: 'overloaded' };
    // Local patch: any remaining server-side failure (5xx) and an empty provider
    // response are upstream instability, not a rejected request: retry them.
    if (status !== undefined && status >= 500)
        return { retryable: true, reason: 'server_error' };
    if (facts.signals.has('empty_response'))
        return { retryable: true, reason: 'empty_response' };
    return { retryable: false, reason: metricKind };`,
  },
]);

// --- renderer string table: show the unbounded retry budget as ∞ ------------
// The prebuilt renderer prints `({{attempt}}/{{total}})`, which would read
// "(3/2147483647)". The templates are plain strings in the exported bundle, so
// they are rewritten rather than the surrounding logic.
function patchRendererRetryBudget(outputRoot) {
  const chunksDir = path.join(outputRoot, "_next", "static", "chunks");
  if (!fs.existsSync(chunksDir)) throw new Error(`missing renderer chunks: ${chunksDir}`);
  let replaced = 0;
  let alreadyPatched = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(target, "utf8");
      if (!text.includes("{{total}}")) continue;
      alreadyPatched += (text.match(/\{\{attempt\}\}\/∞/gu) ?? []).length;
      const next = text
        .replaceAll("({{attempt}}/{{total}})", "({{attempt}}/∞)")
        .replaceAll("（{{attempt}}/{{total}}）", "（{{attempt}}/∞）");
      if (next !== text) {
        fs.writeFileSync(target, next, "utf8");
        replaced += 1;
      }
    }
  };
  walk(chunksDir);
  if (replaced === 0 && alreadyPatched === 0) {
    throw new Error(
      "renderer retry templates not found; the shipped bundle changed its retry copy",
    );
  }
  console.log(`[patch] renderer retry budget: ${replaced} chunk(s) rewritten`);
}

patchRendererRetryBudget(path.join(vendorRoot, "..", "out"));

console.log("[patch] local behavioural patches applied");
