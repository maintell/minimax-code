import { asRecord, asString } from "./embedded-browser-manager-helpers";
export let PAGE_RESUME_WORLD_ID = 1006;
export let MAX_PAGE_RESUME_TARGETS = 50;
const PAGE_RESUME_CAPTURE_SCRIPT = `(() => {
  const finite = (value) => Number.isFinite(value) ? value : 0;
  const escape = (value) => {
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
  };
  const selectorFor = (element) => {
    if (element.id) return '#' + escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      const parent = current.parentElement;
      if (!parent) break;
      const tag = current.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + index + ')' : ''));
      current = parent;
    }
    return parts.length ? parts.join(' > ') : null;
  };
  const targets = [];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (targets.length >= ${MAX_PAGE_RESUME_TARGETS}) break;
    const x = finite(element.scrollLeft);
    const y = finite(element.scrollTop);
    if ((x === 0 && y === 0) || (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) continue;
    const selector = selectorFor(element);
    if (selector) targets.push({ selector, x, y });
  }
  return {
    url: location.href,
    document: { x: finite(globalThis.scrollX), y: finite(globalThis.scrollY) },
    targets
  };
})()`;
export function normalizePageResumeSnapshot(value) {
    const raw = asRecord(value);
    const url = asString(raw.url);
    const documentPosition = asRecord(raw.document);
    if (!url)
        return null;
    const finite = (input) => typeof input === 'number' && Number.isFinite(input) ? Math.max(0, input) : 0;
    const targets = Array.isArray(raw.targets)
        ? raw.targets
            .slice(0, MAX_PAGE_RESUME_TARGETS)
            .map((target) => {
            const candidate = asRecord(target);
            const selector = asString(candidate.selector).slice(0, 512);
            return selector ? { selector, x: finite(candidate.x), y: finite(candidate.y) } : null;
        })
            .filter((target) => target !== null)
        : [];
    return {
        url,
        document: { x: finite(documentPosition.x), y: finite(documentPosition.y) },
        targets,
    };
}
export async function capturePageResume(controller) {
    const result = await controller.evaluateInIsolatedWorld(PAGE_RESUME_WORLD_ID, PAGE_RESUME_CAPTURE_SCRIPT);
    return result.success === false ? null : normalizePageResumeSnapshot(result.result);
}
export async function restorePageResume(controller, snapshot) {
    const script = `(() => {
    const snapshot = ${JSON.stringify(snapshot)};
    if (location.href !== snapshot.url) return { restored: false, reason: 'url-mismatch' };
    const apply = () => {
      globalThis.scrollTo(snapshot.document.x, snapshot.document.y);
      let restoredTargets = 0;
      for (const target of snapshot.targets) {
        try {
          const element = document.querySelector(target.selector);
          if (!element) continue;
          element.scrollLeft = target.x;
          element.scrollTop = target.y;
          restoredTargets += 1;
        } catch {}
      }
      return restoredTargets;
    };
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve({ restored: true, restoredTargets: apply() });
    })));
  })()`;
    const result = await controller.evaluateInIsolatedWorld(PAGE_RESUME_WORLD_ID, script);
    return result.success !== false && asRecord(result.result).restored === true;
}
