const PPT_SELECTION_BRIDGE_ICONS = {
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    confirm: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
};
export function buildPPTSelectionBridgeScript(options) {
    const config = JSON.stringify({
        enabled: options.enabled,
        token: options.token,
        placeholder: options.placeholder || 'Describe the change...',
        icons: PPT_SELECTION_BRIDGE_ICONS,
    });
    return `(() => {
  const config = ${config};

  if (!window.__mavisPptSelectionBridge) {
    const bridgeUiAttr = 'data-mavis-ppt-selection-ui';
    const bridgeIcons = config.icons || {};
    const markerColor = '#0A84FF';
    const submitButtonBackground = '#171717';
    const submitButtonHoverBackground = '#303030';
    const iconInteractionPrimaryDefault = '#ffffff';
    let enabled = false;
    let token = '';
    let placeholderText = 'Describe the change...';
    let startPoint = null;
    let selectionBox = null;
    let hoverBox = null;
    let hoverTarget = null;
    let composer = null;
    let activeRect = null;
    let activePayload = null;
    let activeMarker = null;
    let markerSeq = 0;
    let listenersAttached = false;
    const markers = [];

    const round = (value) => Math.round(Number(value || 0) * 100) / 100;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const rectFromPoints = (a, b) => ({
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    });
    const toRect = (rect) => ({
      x: round(rect.left),
      y: round(rect.top),
      width: round(rect.right - rect.left),
      height: round(rect.bottom - rect.top),
    });
    const intersectRect = (a, b) => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      if (right <= left || bottom <= top) return null;
      return { left, top, right, bottom };
    };
    const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    const isBridgeUi = (target) => Boolean(target && target.closest && target.closest('[' + bridgeUiAttr + ']'));

    const post = (type, payload) => {
      try {
        const bridge = window.mavisPptPreviewBridge;
        if (!bridge || typeof bridge.emitSelectionEvent !== 'function') return;
        bridge.emitSelectionEvent({ token, type, payload });
      } catch {
        // no-op
      }
    };

    const ensureStyle = () => {
      if (document.getElementById('mavis-ppt-selection-style')) return;
      const style = document.createElement('style');
      style.id = 'mavis-ppt-selection-style';
      style.textContent =
        '[' + bridgeUiAttr + ']::placeholder { color: #8c8c8c; opacity: 1; }' +
        'html[data-mavis-ppt-selection-enabled="true"], html[data-mavis-ppt-selection-enabled="true"] body { cursor: crosshair !important; }';
      (document.head || document.documentElement).appendChild(style);
    };

    const getSlides = () => Array.from(document.querySelectorAll('.slide'));

    const readSlideSize = (slide, slideViewportRect) => {
      const style = window.getComputedStyle(slide);
      const width = parseFloat(slide.style.width) || parseFloat(style.width) || slide.offsetWidth || slideViewportRect.width;
      const height = parseFloat(slide.style.height) || parseFloat(style.height) || slide.offsetHeight || slideViewportRect.height;
      return { width: round(width), height: round(height) };
    };

    const findSlide = (selectionRect) => {
      let best = null;
      const slides = getSlides();
      slides.forEach((slide, index) => {
        const slideViewportRect = slide.getBoundingClientRect();
        const slideRect = {
          left: slideViewportRect.left,
          top: slideViewportRect.top,
          right: slideViewportRect.right,
          bottom: slideViewportRect.bottom,
        };
        const intersection = intersectRect(selectionRect, slideRect);
        const score = intersection ? area(intersection) : 0;
        if (score > 0 && (!best || score > best.score)) {
          best = { slide, index, slideViewportRect, slideRect, intersection, score };
        }
      });
      return best;
    };

    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    };

    const domPathFor = (element, root) => {
      if (!element || element.nodeType !== 1) return '';
      const parts = [];
      let node = element;
      while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
        if (node === root) {
          parts.unshift('.slide');
          break;
        }
        const tag = node.tagName.toLowerCase();
        const id = node.id ? '#' + cssEscape(node.id) : '';
        const parent = node.parentElement;
        let nth = '';
        if (!id && parent) {
          const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
          if (siblings.length > 1) nth = ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(tag + id + nth);
        node = parent;
      }
      return parts.join(' > ');
    };

    const extractText = (slide, selectionRect) => {
      const out = [];
      const seen = new Set();
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || isBridgeUi(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        range.detach();
        const hits = rects.some((rect) => {
          const candidate = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          return Boolean(intersectRect(candidate, selectionRect));
        });
        if (hits) {
          const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text && !seen.has(text)) {
            seen.add(text);
            out.push(text);
          }
        }
        if (out.join(' ').length > 4000) break;
        node = walker.nextNode();
      }
      return out.join(' ').slice(0, 4000);
    };

    const payloadFromSelection = (selectionRect) => {
      const match = findSlide(selectionRect);
      if (!match) return null;
      const slideViewportRect = match.slideViewportRect;
      const slideSize = readSlideSize(match.slide, slideViewportRect);
      const intersection = match.intersection || selectionRect;
      const scaleX = slideViewportRect.width > 0 ? slideSize.width / slideViewportRect.width : 1;
      const scaleY = slideViewportRect.height > 0 ? slideSize.height / slideViewportRect.height : 1;
      const slideRect = {
        x: round((intersection.left - slideViewportRect.left) * scaleX),
        y: round((intersection.top - slideViewportRect.top) * scaleY),
        width: round((intersection.right - intersection.left) * scaleX),
        height: round((intersection.bottom - intersection.top) * scaleY),
      };
      const centerX = clamp((selectionRect.left + selectionRect.right) / 2, 0, window.innerWidth - 1);
      const centerY = clamp((selectionRect.top + selectionRect.bottom) / 2, 0, window.innerHeight - 1);
      const target = document.elementsFromPoint(centerX, centerY).find((item) => item && !isBridgeUi(item) && match.slide.contains(item));
      return {
        slideIndex: match.index,
        slideNumber: match.index + 1,
        slideSize,
        selection: {
          kind: 'rect',
          viewportRect: toRect(selectionRect),
          slideRect,
          text: extractText(match.slide, intersection),
          domPath: domPathFor(target || match.slide, match.slide),
        },
      };
    };

    const rectFromPayload = (payload, fallbackRect) => {
      if (!payload || !payload.selection || !payload.selection.slideRect || !payload.slideSize) {
        return fallbackRect;
      }
      const slide = getSlides()[Number(payload.slideIndex)];
      if (!slide) return fallbackRect;
      const slideViewportRect = slide.getBoundingClientRect();
      if (slideViewportRect.width <= 0 || slideViewportRect.height <= 0) return fallbackRect;
      const slideRect = payload.selection.slideRect;
      const slideSize = payload.slideSize;
      const scaleX = slideSize.width > 0 ? slideViewportRect.width / slideSize.width : 1;
      const scaleY = slideSize.height > 0 ? slideViewportRect.height / slideSize.height : 1;
      return {
        left: slideViewportRect.left + slideRect.x * scaleX,
        top: slideViewportRect.top + slideRect.y * scaleY,
        right: slideViewportRect.left + (slideRect.x + slideRect.width) * scaleX,
        bottom: slideViewportRect.top + (slideRect.y + slideRect.height) * scaleY,
      };
    };

    const removeComposer = () => {
      if (composer) composer.remove();
      composer = null;
      activeRect = null;
      activePayload = null;
      activeMarker = null;
    };

    const positionMarker = (marker) => {
      if (!marker || !marker.node) return;
      const rect = rectFromPayload(marker.payload, marker.rect);
      marker.rect = rect;
      const left = clamp(rect.left - 12, 8, Math.max(8, window.innerWidth - 32));
      const top = clamp(rect.bottom - 14, 8, Math.max(8, window.innerHeight - 32));
      marker.node.style.display = enabled ? 'block' : 'none';
      marker.node.style.left = left + 'px';
      marker.node.style.top = top + 'px';
    };

    const relabelMarkers = () => {
      markers.forEach((marker, index) => {
        marker.displayIndex = index + 1;
        if (marker.numberNode) marker.numberNode.textContent = String(index + 1);
      });
    };

    const createMarker = (marker) => {
      const node = document.createElement('div');
      node.setAttribute(bridgeUiAttr, 'true');
      node.setAttribute('data-mavis-ppt-selection-marker', String(marker.id));
      node.style.position = 'fixed';
      node.style.zIndex = '2147483647';
      node.style.width = '24px';
      node.style.height = '24px';
      node.style.border = '0';
      node.style.background = 'transparent';
      node.style.padding = '0';
      node.style.display = 'none';
      node.style.pointerEvents = 'auto';
      node.style.cursor = 'pointer';

      const numberNode = document.createElement('button');
      numberNode.type = 'button';
      numberNode.textContent = String(marker.displayIndex || marker.id);
      numberNode.setAttribute('data-mavis-ppt-selection-marker-number', String(marker.id));
      numberNode.style.position = 'absolute';
      numberNode.style.inset = '0';
      numberNode.style.width = '24px';
      numberNode.style.height = '24px';
      numberNode.style.border = '1.5px solid #ffffff';
      numberNode.style.borderRadius = '999px';
      numberNode.style.background = markerColor;
      numberNode.style.color = '#ffffff';
      numberNode.style.font = '500 12px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      numberNode.style.boxShadow = '0 10px 30px rgba(10,132,255,0.35)';
      numberNode.style.padding = '0';
      numberNode.style.display = 'flex';
      numberNode.style.alignItems = 'center';
      numberNode.style.justifyContent = 'center';
      numberNode.style.pointerEvents = 'auto';
      numberNode.style.cursor = 'pointer';

      const tooltip = document.createElement('div');
      tooltip.setAttribute(bridgeUiAttr, 'true');
      tooltip.setAttribute('data-mavis-ppt-selection-marker-tooltip', String(marker.id));
      tooltip.style.position = 'absolute';
      tooltip.style.left = 'calc(100% + 8px)';
      tooltip.style.top = '50%';
      tooltip.style.transform = 'translateY(-50%)';
      tooltip.style.maxWidth = '260px';
      tooltip.style.padding = '6px 12px';
      tooltip.style.borderRadius = '999px';
      tooltip.style.background = '#ffffff';
      tooltip.style.color = '#171717';
      tooltip.style.font = '500 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      tooltip.style.boxShadow = '0 0 20px rgba(10,10,10,0.08)';
      tooltip.style.whiteSpace = 'nowrap';
      tooltip.style.overflow = 'hidden';
      tooltip.style.textOverflow = 'ellipsis';
      tooltip.style.pointerEvents = 'auto';
      tooltip.style.display = 'none';
      tooltip.style.cursor = 'pointer';

      node.addEventListener('mouseenter', () => {
        marker.rect = rectFromPayload(marker.payload, marker.rect);
        tooltip.textContent = (marker.instruction || '').trim() || 'PPT selection';
        tooltip.style.display = 'block';
        updateSelectionBox(marker.rect);
      });
      node.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
        if (!composer || activeMarker !== marker) {
          if (selectionBox) selectionBox.style.display = 'none';
        }
      });
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        marker.rect = rectFromPayload(marker.payload, marker.rect);
        updateSelectionBox(marker.rect);
        showComposer(marker.rect, marker.payload, marker);
      });
      tooltip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        marker.rect = rectFromPayload(marker.payload, marker.rect);
        updateSelectionBox(marker.rect);
        showComposer(marker.rect, marker.payload, marker);
      });

      node.append(numberNode, tooltip);
      document.documentElement.appendChild(node);
      marker.node = node;
      marker.numberNode = numberNode;
      marker.tooltip = tooltip;
      positionMarker(marker);
    };

    const addOrUpdateMarker = (marker, rect, payload, instruction) => {
      const nextMarker = marker || {
        id: ++markerSeq,
        displayIndex: markers.length + 1,
        rect,
        payload,
        instruction,
        node: null,
        numberNode: null,
        tooltip: null,
      };
      nextMarker.rect = rect;
      nextMarker.payload = payload;
      nextMarker.instruction = instruction;
      if (!marker) {
        markers.push(nextMarker);
        createMarker(nextMarker);
      }
      relabelMarkers();
      positionMarker(nextMarker);
    };

    const ensureSelectionBox = () => {
      if (selectionBox) return selectionBox;
      const box = document.createElement('div');
      box.setAttribute(bridgeUiAttr, 'true');
      box.style.position = 'fixed';
      box.style.display = 'none';
      box.style.pointerEvents = 'none';
      box.style.boxSizing = 'border-box';
      box.style.zIndex = '2147483645';
      box.style.border = '2px solid ' + markerColor;
      box.style.borderRadius = '0';
      box.style.background = 'rgba(10, 132, 255, 0.12)';
      box.style.boxShadow = '0 18px 48px rgba(15,23,42,0.16)';
      document.documentElement.appendChild(box);
      selectionBox = box;
      return box;
    };

    const ensureHoverBox = () => {
      if (hoverBox) return hoverBox;
      const box = document.createElement('div');
      box.setAttribute(bridgeUiAttr, 'true');
      box.style.position = 'fixed';
      box.style.display = 'none';
      box.style.pointerEvents = 'none';
      box.style.boxSizing = 'border-box';
      box.style.zIndex = '2147483644';
      box.style.border = '2px solid ' + markerColor;
      box.style.borderRadius = '0';
      box.style.background = 'rgba(10, 132, 255, 0.08)';
      document.documentElement.appendChild(box);
      hoverBox = box;
      return box;
    };

    const updateBoxRect = (box, rect, options) => {
      if (!box || !rect) return;
      const outset = options && Number.isFinite(options.outset) ? Number(options.outset) : 0;
      const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
      const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
      const left = clamp(rect.left - outset, 0, viewportWidth);
      const top = clamp(rect.top - outset, 0, viewportHeight);
      const right = clamp(rect.right + outset, 0, viewportWidth);
      const bottom = clamp(rect.bottom + outset, 0, viewportHeight);
      if (right <= left || bottom <= top) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = Math.max(1, right - left) + 'px';
      box.style.height = Math.max(1, bottom - top) + 'px';
    };

    const updateSelectionBox = (rect) => {
      updateBoxRect(ensureSelectionBox(), rect, { outset: 0 });
    };

    const hideHoverBox = () => {
      hoverTarget = null;
      if (hoverBox) hoverBox.style.display = 'none';
    };

    const hideMarkerTooltips = () => {
      document.querySelectorAll('[data-mavis-ppt-selection-marker-tooltip]').forEach((node) => {
        node.style.display = 'none';
      });
    };

    const rectForElement = (element) => {
      if (!element || !document.documentElement.contains(element)) return null;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };

    const targetElementForPointer = (target) => {
      if (!target || !target.closest || isBridgeUi(target)) return null;
      const slide = target.closest('.slide');
      if (!slide) return null;
      let node = target.nodeType === 1 ? target : target.parentElement;
      if (!node || !slide.contains(node)) return slide;
      while (node.parentElement && node.parentElement !== slide && slide.contains(node.parentElement)) {
        node = node.parentElement;
      }
      const rect = rectForElement(node);
      if (rect && area(rect) >= 16) return node;
      return slide;
    };

    const updateHoverTarget = (target) => {
      if (!enabled || startPoint) {
        hideHoverBox();
        return;
      }
      const element = targetElementForPointer(target);
      if (!element) {
        hideHoverBox();
        return;
      }
      hoverTarget = element;
      const rect = rectForElement(element);
      if (!rect) {
        hideHoverBox();
        return;
      }
      updateBoxRect(ensureHoverBox(), rect, { outset: 2 });
    };

    const showComposer = (rect, payload, marker) => {
      removeComposer();
      hideMarkerTooltips();
      activeRect = rect;
      activePayload = payload;
      activeMarker = marker || null;
      const panel = document.createElement('div');
      panel.setAttribute(bridgeUiAttr, 'true');
      panel.setAttribute('data-mavis-ppt-selection-composer', 'true');
      panel.style.position = 'fixed';
      panel.style.zIndex = '2147483647';
      panel.style.height = '42px';
      panel.style.display = 'flex';
      panel.style.alignItems = 'center';
      panel.style.gap = '10px';
      panel.style.padding = '8px 8px 8px 12px';
      panel.style.border = '1px solid rgba(15,23,42,0.10)';
      panel.style.borderRadius = '12px';
      panel.style.background = 'rgba(255, 255, 255, 0.96)';
      panel.style.boxShadow = '0 0 20px rgba(10,10,10,0.08)';
      panel.style.backdropFilter = 'blur(12px)';
      panel.style.font = '14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

      const input = document.createElement('input');
      input.setAttribute(bridgeUiAttr, 'true');
      input.placeholder = placeholderText;
      input.value = marker && marker.instruction ? marker.instruction : '';
      input.style.flex = '1 1 auto';
      input.style.minWidth = '0';
      input.style.height = '26px';
      input.style.border = '0';
      input.style.outline = '0';
      input.style.font = '400 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      input.style.color = '#171717';
      input.style.background = 'transparent';
      input.style.caretColor = markerColor;

      const action = document.createElement('button');
      action.type = 'button';
      action.setAttribute(bridgeUiAttr, 'true');
      action.style.flex = '0 0 auto';
      action.style.width = '32px';
      action.style.height = '28px';
      action.style.border = '0';
      action.style.borderRadius = '8px';
      action.style.display = 'inline-flex';
      action.style.alignItems = 'center';
      action.style.justifyContent = 'center';
      action.style.padding = '0';
      action.style.cursor = 'pointer';
      action.style.transition = 'background-color 0.15s, color 0.15s';

      let hovering = false;
      const syncAction = () => {
        const hasValue = input.value.trim().length > 0;
        action.innerHTML = hasValue ? (bridgeIcons.confirm || 'OK') : (bridgeIcons.close || 'x');
        action.setAttribute('aria-label', hasValue ? 'Submit' : 'Cancel');
        if (hasValue) {
          action.style.background = hovering ? submitButtonHoverBackground : submitButtonBackground;
          action.style.color = iconInteractionPrimaryDefault;
        } else {
          action.style.background = hovering ? 'rgba(15, 23, 42, 0.06)' : 'transparent';
          action.style.color = hovering ? '#475569' : 'rgb(148, 163, 184)';
        }
      };

      const submit = () => {
        const instruction = String(input.value || '').trim();
        if (!instruction || !activePayload) {
          removeComposer();
          if (selectionBox) selectionBox.style.display = 'none';
          return;
        }
        post('selection-submitted', { ...activePayload, instruction });
        addOrUpdateMarker(activeMarker, rect, activePayload, instruction);
        removeComposer();
        if (selectionBox) selectionBox.style.display = 'none';
      };

      action.addEventListener('mouseenter', () => {
        hovering = true;
        syncAction();
      });
      action.addEventListener('mouseleave', () => {
        hovering = false;
        syncAction();
      });
      action.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        submit();
      });
      input.addEventListener('input', syncAction);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          submit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          removeComposer();
          if (selectionBox) selectionBox.style.display = 'none';
        }
      });
      syncAction();

      panel.append(input, action);
      document.documentElement.appendChild(panel);
      composer = panel;
      positionComposer();
      input.focus();
    };

    const positionComposer = () => {
      if (!composer) return;
      const rect = activeMarker
        ? rectFromPayload(activeMarker.payload, activeMarker.rect)
        : activeRect;
      if (!rect) return;
      if (activeMarker) activeMarker.rect = rect;
      else activeRect = rect;
      const width = Math.min(360, Math.max(260, Math.min(window.innerWidth - 32, rect.right - rect.left)));
      composer.style.width = width + 'px';
      const composerHeight = 42;
      const bottomInset = 24;
      const gap = 12;
      const left = clamp(rect.left + (rect.right - rect.left) / 2 - width / 2, 16, Math.max(16, window.innerWidth - width - 16));
      const preferredTop = rect.bottom + gap;
      const top = preferredTop + composerHeight + bottomInset <= window.innerHeight
        ? preferredTop
        : clamp(rect.top - composerHeight - gap, 16, Math.max(16, window.innerHeight - composerHeight - bottomInset));
      composer.style.left = left + 'px';
      composer.style.top = top + 'px';
    };

    const clear = () => {
      removeComposer();
      if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
      }
      if (hoverBox) {
        hoverBox.remove();
        hoverBox = null;
      }
      hoverTarget = null;
      markers.splice(0).forEach((marker) => {
        if (marker.node) marker.node.remove();
      });
      markerSeq = 0;
      startPoint = null;
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
    };

    const onPointerMove = (event) => {
      if (!enabled || !startPoint) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = rectFromPoints(startPoint, { x: event.clientX, y: event.clientY });
      updateSelectionBox(rect);
    };

    const onPointerUp = (event) => {
      if (!enabled || !startPoint) return;
      event.preventDefault();
      event.stopPropagation();
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      let rect = rectFromPoints(startPoint, { x: event.clientX, y: event.clientY });
      if (area(rect) < 64) {
        const targetRect = rectForElement(hoverTarget || targetElementForPointer(event.target));
        rect = targetRect || {
          left: clamp(event.clientX - 12, 0, window.innerWidth - 1),
          top: clamp(event.clientY - 12, 0, window.innerHeight - 1),
          right: clamp(event.clientX + 12, 1, window.innerWidth),
          bottom: clamp(event.clientY + 12, 1, window.innerHeight),
        };
      }
      startPoint = null;
      updateSelectionBox(rect);
      const payload = payloadFromSelection(rect);
      if (!payload) {
        if (selectionBox) selectionBox.style.display = 'none';
        return;
      }
      showComposer(rect, payload);
    };

    const onPointerDown = (event) => {
      if (!enabled || event.button !== 0 || isBridgeUi(event.target)) return;
      const slide = event.target && event.target.closest ? event.target.closest('.slide') : null;
      if (!slide) return;
      event.preventDefault();
      event.stopPropagation();
      removeComposer();
      hideHoverBox();
      startPoint = { x: event.clientX, y: event.clientY };
      updateSelectionBox({ left: event.clientX, top: event.clientY, right: event.clientX + 1, bottom: event.clientY + 1 });
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
    };

    const onPointerOver = (event) => {
      updateHoverTarget(event.target);
    };

    const onPointerMoveHover = (event) => {
      updateHoverTarget(event.target);
    };

    const onResize = () => {
      markers.forEach(positionMarker);
      positionComposer();
    };

    const onScroll = () => {
      markers.forEach(positionMarker);
      positionComposer();
      updateHoverTarget(hoverTarget);
    };

    const attachInteractionListeners = () => {
      if (listenersAttached) return;
      listenersAttached = true;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointerover', onPointerOver, true);
      document.addEventListener('pointermove', onPointerMoveHover, true);
      document.addEventListener('pointerleave', hideHoverBox, true);
      window.addEventListener('resize', onResize);
      document.addEventListener('scroll', onScroll, true);
    };

    const detachInteractionListeners = () => {
      if (!listenersAttached) return;
      listenersAttached = false;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointermove', onPointerMoveHover, true);
      document.removeEventListener('pointerleave', hideHoverBox, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      startPoint = null;
    };

    const setEnabled = (nextEnabled) => {
      enabled = Boolean(nextEnabled);
      if (enabled) {
        document.documentElement.setAttribute('data-mavis-ppt-selection-enabled', 'true');
        attachInteractionListeners();
      } else {
        document.documentElement.removeAttribute('data-mavis-ppt-selection-enabled');
        detachInteractionListeners();
        removeComposer();
        hideHoverBox();
        hideMarkerTooltips();
        if (selectionBox) selectionBox.style.display = 'none';
      }
      markers.forEach(positionMarker);
      if (enabled) positionComposer();
    };

    window.__mavisPptSelectionBridge = {
      configure(nextConfig) {
        ensureStyle();
        token = String(nextConfig && nextConfig.token ? nextConfig.token : token);
        placeholderText = String(nextConfig && nextConfig.placeholder ? nextConfig.placeholder : placeholderText);
        setEnabled(Boolean(nextConfig && nextConfig.enabled));
        return true;
      },
      clear,
    };
  }

  return window.__mavisPptSelectionBridge.configure(config);
})();`;
}
