export function sameId(a, b) {
  return String(a) === String(b);
}

export function backoffDelay(attempt) {
  return Math.min(1500 * 2 ** Math.min(attempt, 5), 30_000);
}
