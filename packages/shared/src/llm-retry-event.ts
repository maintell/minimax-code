import type { LLMMetricErrorKind } from './llm-error-classifier.js';

export const SESSION_LLM_RETRY_EVENT_TYPE = 'session.llm_retry' as const;

/**
 * Retry budget that means "no practical limit": provider errors keep retrying on
 * the fixed cadence until the user cancels. The budget stays a serialisable,
 * non-negative integer because that is what the retry-event contract and every
 * consumer's parser accept; hosts and UIs must present it as unbounded instead
 * of printing the raw number.
 */
export const UNBOUNDED_RETRY_ATTEMPTS = 2_147_483_647;

/** True when a retry budget means "keeps retrying until cancelled". */
export function isUnboundedRetryBudget(maxRetries: number): boolean {
  return !Number.isFinite(maxRetries) || maxRetries >= UNBOUNDED_RETRY_ATTEMPTS;
}

/** Human-readable retry budget: `∞` for unbounded, the number otherwise. */
export function formatRetryBudget(maxRetries: number): string {
  return isUnboundedRetryBudget(maxRetries) ? '∞' : String(maxRetries);
}

export type SessionLLMRetryScope = 'agent' | 'compaction' | 'title';
export type SessionLLMRetryStatus = 'waiting' | 'recovered' | 'exhausted' | 'cancelled';
/** Retry trigger reasons plus the bounded final-attempt reason on terminal events. */
export type SessionLLMRetryReason = LLMMetricErrorKind;

export interface SessionLLMRetryEventPayload {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  callId: string;
  scope: SessionLLMRetryScope;
  status: SessionLLMRetryStatus;
  retryAttempt: number;
  maxRetries: number;
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  error?: {
    reason: SessionLLMRetryReason;
    code?: number;
    message: string;
  };
}
