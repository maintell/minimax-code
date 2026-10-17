/**
 * Iframe 元素高亮注入脚本
 * 需要在目标网站中引入此脚本来支持跨域 iframe 高亮功能
 *
 * 使用方法：
 * 1. 将此脚本添加到目标网站的 HTML 中
 * 2. 或通过浏览器扩展、用户脚本等方式注入
 */

(function () {
  "use strict";

  // 检查是否在 iframe 中
  if (window.self === window.top) {
    return; // 不在 iframe 中，不执行
  }

  // 检查是否已经初始化过
  if (window.__iframeHighlightInitialized) {
    return;
  }
  window.__iframeHighlightInitialized = true;

  console.log("Iframe 高亮脚本已加载");

  // 创建高亮覆盖层
  const overlay = document.createElement("div");
  overlay.id = "iframe-highlight-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 999999;
    overflow: hidden;
  `;

  // 创建悬停高亮框（虚线边框）
  const highlightBox = document.createElement("div");
  highlightBox.id = "iframe-highlight-box";
  highlightBox.style.cssText = `
    position: absolute;
    border: 2px dashed #007AFF;
    background: rgba(0, 122, 255, 0.08);
    pointer-events: none;
    display: none;
    transition: all 0.1s ease;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.8);
    border-radius: 2px;
  `;

  // 创建选中节点的常驻高亮框（实线边框）
  const selectedBox = document.createElement("div");
  selectedBox.id = "iframe-selected-box";
  selectedBox.style.cssText = `
    position: absolute;
    border: 2px solid #007AFF;
    pointer-events: none;
    display: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 107, 53, 0.4);
    border-radius: 2px;
    z-index: 1000000;
  `;

  // 创建悬停标签显示
  const tagLabel = document.createElement("div");
  tagLabel.id = "iframe-tag-label";
  tagLabel.style.cssText = `
    position: absolute;
    background: #007AFF;
    color: white;
    padding: 2px 6px;
    font-size: 11px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    border-radius: 2px;
    pointer-events: none;
    display: none;
    white-space: nowrap;
    z-index: 1000001;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    font-weight: 500;
  `;

  // 创建选中节点标签
  const selectedLabel = document.createElement("div");
  selectedLabel.id = "iframe-selected-label";
  selectedLabel.style.cssText = `
    position: absolute;
    background: #007AFF;
    color: white;
    padding: 3px 8px;
    font-size: 11px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    border-radius: 3px;
    pointer-events: none;
    display: none;
    white-space: nowrap;
    z-index: 1000002;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    font-weight: 600;
  `;

  overlay.appendChild(highlightBox);
  overlay.appendChild(selectedBox);
  overlay.appendChild(tagLabel);
  overlay.appendChild(selectedLabel);
  document.body.appendChild(overlay);

  // 存储当前选中的元素
  let selectedElement = null;
  let highlightEnabled = true;

  // 更新选中元素的高亮显示
  function updateSelectedHighlight(element) {
    console.log("updateSelectedHighlight called with:", element);

    if (!element) {
      selectedBox.style.display = "none";
      selectedLabel.style.display = "none";
      selectedElement = null;
      console.log("Cleared selected highlight");
      return;
    }

    selectedElement = element;
    const rect = element.getBoundingClientRect();

    console.log("Selected element rect:", rect);

    // 更新选中高亮框位置
    selectedBox.style.display = "block";
    selectedBox.style.left = `${rect.left - 2}px`;
    selectedBox.style.top = `${rect.top - 2}px`;
    selectedBox.style.width = `${rect.width + 4}px`;
    selectedBox.style.height = `${rect.height + 4}px`;

    // 更新选中标签位置和内容
    selectedLabel.style.display = "block";
    selectedLabel.textContent = `✓ <${element.tagName.toLowerCase()}>`;

    // 计算标签位置，确保不超出视窗
    let labelTop = rect.top - 28;
    let labelLeft = rect.left;

    // 如果标签会超出顶部，显示在元素下方
    if (labelTop < 5) {
      labelTop = rect.bottom + 5;
    }

    // 如果标签会超出右侧，向左调整
    const labelWidth = selectedLabel.offsetWidth || 100; // 预估宽度
    if (labelLeft + labelWidth > window.innerWidth - 10) {
      labelLeft = window.innerWidth - labelWidth - 10;
    }

    selectedLabel.style.left = `${Math.max(5, labelLeft)}px`;
    selectedLabel.style.top = `${labelTop}px`;

    console.log("Selected highlight positioned at:", {
      left: selectedBox.style.left,
      top: selectedBox.style.top,
      width: selectedBox.style.width,
      height: selectedBox.style.height,
    });
  }

  function getElementSelector(element) {
    if (!(element instanceof Element)) 
        throw new Error('Argument must be a DOM element');

    const segments = [];
    let current = element;

    while (current !== document.documentElement) {
        let selector = '';
        // 优先检查唯一ID
        if (current.id && document.querySelectorAll(`#${current.id}`).length === 1) {
            segments.unshift(`#${current.id}`);
            break; // ID唯一，无需继续向上
        }

        // 生成类名选择器（取第一个有效类名）
        const classes = Array.from(current.classList).filter(c => !c.startsWith('js-'));
        const className = classes.length > 0 ? `.${classes[0]}` : '';

        // 生成位置索引（nth-child）
        const tag = current.tagName.toLowerCase();
        // 同时标记 classname 和 :nth-child(index)
        const siblings = Array.from(current.parentNode.children);
        const index = siblings.findIndex(el => el === current) + 1;
        if (className) {
            selector = `${tag}${className}:nth-child(${index})`;
        } else {
            selector = `${tag}:nth-child(${index})`;
        }

        segments.unshift(selector);
        current = current.parentElement;
    }

    // 处理根元素
    if (current === document.documentElement) {
        segments.unshift('html');
    }

    return segments.join(' > ');
}

  // 获取元素文本内容
  function getElementText(element) {
    if (element.tagName === "INPUT") {
      return element.value || element.placeholder || "";
    }
    if (element.tagName === "TEXTAREA") {
      return element.value || element.placeholder || "";
    }

    const text = element.textContent?.trim() || "";
    return text.length > 50 ? text.substring(0, 50) + "..." : text;
  }

  // 获取元素属性信息
  function getElementAttributes(element) {
    const attrs = {};
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  // 鼠标悬停事件处理
  function handleMouseOver(e) {
    if (!highlightEnabled) return;

    const target = e.target;
    if (
      !target ||
      target === overlay ||
      target === highlightBox ||
      target === tagLabel ||
      target === selectedBox ||
      target === selectedLabel
    ) {
      return;
    }

    // 避免高亮 html 和 body 元素
    if (target === document.documentElement || target === document.body) {
      return;
    }

    // 如果是已选中的元素，不显示悬停高亮
    if (target === selectedElement) {
      highlightBox.style.display = "none";
      tagLabel.style.display = "none";
      return;
    }

    const rect = target.getBoundingClientRect();
    const selector = getElementSelector(target);
    const text = getElementText(target);
    const attributes = getElementAttributes(target);

    // 更新悬停高亮框位置
    highlightBox.style.display = "block";
    highlightBox.style.left = `${rect.left - 2}px`;
    highlightBox.style.top = `${rect.top - 2}px`;
    highlightBox.style.width = `${rect.width + 4}px`;
    highlightBox.style.height = `${rect.height + 4}px`;

    // 更新标签位置和内容
    tagLabel.style.display = "block";
    tagLabel.textContent = `<${target.tagName.toLowerCase()}>`;

    // 计算标签位置，确保不超出视窗
    let labelTop = rect.top - 22;
    let labelLeft = rect.left;

    // 如果标签会超出顶部，显示在元素下方
    if (labelTop < 0) {
      labelTop = rect.bottom + 5;
    }

    // 如果标签会超出右侧，向左调整
    if (labelLeft + tagLabel.offsetWidth > window.innerWidth) {
      labelLeft = window.innerWidth - tagLabel.offsetWidth - 5;
    }

    tagLabel.style.left = `${Math.max(0, labelLeft)}px`;
    tagLabel.style.top = `${labelTop}px`;

    // 发送消息到父窗口
    const elementInfo = {
      tagName: target.tagName.toLowerCase(),
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      },
      selector: selector,
      text: text,
      attributes: attributes,
      url: window.location.href,
      path: window.location.pathname,
      timestamp: Date.now(),
    };

    try {
      window.parent.postMessage(
        {
          type: "iframe-element-hover",
          data: elementInfo,
          source: "iframe-highlight-injector",
        },
        "*"
      );
    } catch (error) {
      console.warn("无法发送消息到父窗口:", error);
    }
  }

  // 鼠标离开事件处理
  function handleMouseOut(e) {
    if (!highlightEnabled) return;

    const relatedTarget = e.relatedTarget;

    // 如果鼠标移动到高亮相关元素上，不隐藏高亮
    if (
      relatedTarget &&
      (relatedTarget === highlightBox ||
        relatedTarget === tagLabel ||
        relatedTarget === overlay ||
        relatedTarget === selectedBox ||
        relatedTarget === selectedLabel)
    ) {
      return;
    }

    highlightBox.style.display = "none";
    tagLabel.style.display = "none";

    try {
      window.parent.postMessage(
        {
          type: "iframe-element-hover",
          data: null,
          source: "iframe-highlight-injector",
        },
        "*"
      );
    } catch (error) {
      console.warn("无法发送消息到父窗口:", error);
    }
  }

  // 点击事件处理
  function handleClick(e) {
    const target = e.target;
    if (
      !target ||
      target === overlay ||
      target === highlightBox ||
      target === tagLabel ||
      target === selectedBox ||
      target === selectedLabel
    ) {
      return;
    }

    // 避免处理 html 和 body 元素
    if (target === document.documentElement || target === document.body) {
      return;
    }

    // 检查是否是交互元素，这些元素需要保留默认行为
    const isInteractiveElement = ['input', 'textarea', 'select', 'button', 'a'].includes(
      target.tagName.toLowerCase()
    );

    // 如果高亮功能启用，对于非交互元素阻止默认行为和事件传播
    if (highlightEnabled) {
      e.preventDefault();
      e.stopPropagation();
    }

    const rect = target.getBoundingClientRect();
    const selector = getElementSelector(target);
    const text = getElementText(target);
    const attributes = getElementAttributes(target);

    console.log("Element clicked:", {
      tagName: target.tagName,
      selector,
      rect,
    });

    // 立即更新选中高亮
    updateSelectedHighlight(target);

    // 隐藏悬停高亮，因为现在是选中状态
    highlightBox.style.display = "none";
    tagLabel.style.display = "none";

    const elementInfo = {
      tagName: target.tagName.toLowerCase(),
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      },
      selector: selector,
      text: text,
      attributes: attributes,
      url: window.location.href,
      path: window.location.pathname,
      timestamp: Date.now(),
    };

    try {
      window.parent.postMessage(
        {
          type: "iframe-element-click",
          data: elementInfo,
          source: "iframe-highlight-injector",
        },
        "*"
      );
    } catch (error) {
      console.warn("无法发送消息到父窗口:", error);
    }
  }

  // 监听来自父窗口的消息
  function handleParentMessage(event) {
    console.log("Received message from parent:", event.data);

    if (event.data.type === "iframe-highlight-toggle") {
      const enabled = event.data.enabled;
      console.log("Highlight toggle:", enabled);
      if (enabled) {
        enableHighlight();
      } else {
        disableHighlight();
      }
    } else if (event.data.type === "enable-iframe-highlight") {
      console.log("Enable iframe highlight");
      enableHighlight();
    } else if (event.data.type === "disable-iframe-highlight") {
      console.log("Disable iframe highlight");
      disableHighlight();
    } else if (event.data.type === "toggle-iframe-highlight") {
      const enabled = event.data.enabled !== undefined ? event.data.enabled : !highlightEnabled;
      console.log("Toggle iframe highlight to:", enabled);
      if (enabled) {
        enableHighlight();
      } else {
        disableHighlight();
      }
    } else if (event.data.type === "update-selected-element") {
      const { selector } = event.data;
      console.log("Update selected element with selector:", selector);
      if (selector) {
        try {
          const element = document.querySelector(selector);
          console.log("Found element by selector:", element);
          updateSelectedHighlight(element);
        } catch (error) {
          console.warn("Failed to select element:", error);
          updateSelectedHighlight(null);
        }
      } else {
        updateSelectedHighlight(null);
      }
    } else if (event.data.type === "clear-selected-element") {
      console.log("Clear selected element");
      updateSelectedHighlight(null);
    }
  }

  // 启用高亮功能
  function enableHighlight() {
    console.log("Enabling highlight");
    highlightEnabled = true;
    document.addEventListener("mouseover", handleMouseOver, true);
    document.addEventListener("mouseout", handleMouseOut, true);
    document.addEventListener("click", handleClick, false);
    overlay.style.display = "block";
  }

  // 禁用高亮功能
  function disableHighlight() {
    console.log("Disabling highlight");
    highlightEnabled = false;
    // 保持事件监听器，但通过 highlightEnabled 变量控制行为
    // 这样可以保留选中状态的显示
    highlightBox.style.display = "none";
    tagLabel.style.display = "none";
    // 不隐藏 selectedBox 和 selectedLabel，保留选中状态
  }

  // 完全禁用高亮功能（移除所有监听器）
  function fullyDisableHighlight() {
    console.log("Fully disabling highlight");
    highlightEnabled = false;
    document.removeEventListener("mouseover", handleMouseOver, true);
    document.removeEventListener("mouseout", handleMouseOut, true);
    document.removeEventListener("click", handleClick, true);
    overlay.style.display = "none";
    highlightBox.style.display = "none";
    tagLabel.style.display = "none";
    selectedBox.style.display = "none";
    selectedLabel.style.display = "none";
  }

  // 添加事件监听
  enableHighlight();
  window.addEventListener("message", handleParentMessage);

  // 暴露全局函数供外部调用
  window.__iframeHighlightControl = {
    enable: enableHighlight,
    disable: disableHighlight,
    fullyDisable: fullyDisableHighlight,
    isEnabled: () => highlightEnabled,
    getSelectedElement: () => selectedElement,
    updateSelected: updateSelectedHighlight,
    // 通过消息发送开关控制
    sendToggleMessage: (enabled) => {
      window.parent.postMessage({
        type: 'iframe-highlight-status',
        enabled: enabled || highlightEnabled,
        source: 'iframe-highlight-injector'
      }, '*');
    }
  };

  // 通知父窗口脚本已加载
  try {
    window.parent.postMessage(
      {
        type: "iframe-highlight-ready",
        data: {
          url: window.location.href,
          userAgent: navigator.userAgent,
          timestamp: Date.now(),
        },
        source: "iframe-highlight-injector",
      },
      "*"
    );
  } catch (error) {
    console.warn("无法发送就绪消息到父窗口:", error);
  }

  // 清理函数
  window.__iframeHighlightCleanup = function () {
    fullyDisableHighlight();
    window.removeEventListener("message", handleParentMessage);
    if (overlay.parentElement) {
      overlay.parentElement.removeChild(overlay);
    }
    delete window.__iframeHighlightInitialized;
    delete window.__iframeHighlightCleanup;
  };
})();