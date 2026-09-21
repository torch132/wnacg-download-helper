(() => {
  const QUICK_DOWNLOAD = "WNACG_QUICK_DOWNLOAD";
  const QUICK_DOWNLOAD_STATUS = "WNACG_QUICK_DOWNLOAD_STATUS";
  const QUICK_DOWNLOAD_STATES = "WNACG_QUICK_DOWNLOAD_STATES";
  const BUTTON_CLASS = "wnacg-helper-download";

  function albumInfo(item) {
    const titleLink = item.querySelector(
      '.info > .title > a[href*="photos-index-aid-"]'
    );
    const link = titleLink ||
      item.querySelector('a[href*="photos-index-aid-"]');
    if (!link) return null;
    try {
      const url = new URL(link.getAttribute("href") || "", location.href);
      const aid = url.pathname.match(/^\/photos-index-aid-(\d+)\.html$/i)?.[1];
      const title = String(link.getAttribute("title") || link.textContent || "").trim();
      return aid && title ? { aid, title, titleLink } : null;
    } catch {
      return null;
    }
  }

  function splitTitleTags(value) {
    return String(value ?? "")
      .split(/(\[中国翻訳\]|\[DL版\])/gu)
      .filter(Boolean)
      .map((text) => ({
        text,
        kind: text === "[中国翻訳]" ? "translation" : text === "[DL版]" ? "dl" : null
      }));
  }

  function highlightTitle(link) {
    if (!link || link.dataset.wnacgHelperTitleHighlighted === "true") return;
    const title = link.textContent || "";
    const parts = splitTitleTags(title);
    if (!parts.some((part) => part.kind)) {
      link.dataset.wnacgHelperTitleHighlighted = "true";
      return;
    }
    link.replaceChildren();
    for (const part of parts) {
      if (!part.kind) {
        link.append(document.createTextNode(part.text));
        continue;
      }
      const tag = document.createElement("span");
      tag.className = `wnacg-helper-title-token is-${part.kind}`;
      tag.textContent = part.text;
      link.append(tag);
    }
    link.dataset.wnacgHelperTitleHighlighted = "true";
  }

  function icon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M12 3v12m0 0 5-5m-5 5-5-5M5 21h14");
    svg.append(path);
    return svg;
  }

  function setButtonState(button, state, message) {
    button.dataset.state = state;
    button.disabled = state === "downloading";
    const labels = {
      idle: "一键下载",
      downloading: "正在下载",
      complete: "下载完成",
      error: "下载失败，点击重试"
    };
    const label = message || labels[state] || labels.idle;
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function createButton({ aid, title }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.dataset.aid = aid;
    button.dataset.title = title;
    button.append(icon());
    setButtonState(button, "idle");
    return button;
  }

  function mountButtons(root = document) {
    const addedAids = [];
    for (const item of root.querySelectorAll?.(".gallary_item") || []) {
      if (item.dataset.wnacgHelperMounted === "true") continue;
      const info = albumInfo(item);
      const infoColumn = item.querySelector(".info > .info_col");
      if (!info || !infoColumn) continue;
      highlightTitle(info.titleLink);
      infoColumn.append(createButton(info));
      item.dataset.wnacgHelperMounted = "true";
      addedAids.push(info.aid);
    }
    if (addedAids.length > 0) void syncButtonStates(addedAids);
  }

  function buttonsForAid(aid) {
    return document.querySelectorAll(
      `.${BUTTON_CLASS}[data-aid="${CSS.escape(String(aid))}"]`
    );
  }

  async function syncButtonStates(aids) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: QUICK_DOWNLOAD_STATES,
        aids
      });
      if (!response?.ok) return;
      for (const [aid, state] of Object.entries(response.states || {})) {
        for (const button of buttonsForAid(aid)) setButtonState(button, state);
      }
    } catch {
      // 后台脚本重载期间保持默认状态，用户点击时仍会再次校验。
    }
  }

  function showToast(message, state = "info") {
    let region = document.getElementById("wnacg-helper-toast-region");
    if (!region) {
      region = document.createElement("div");
      region.id = "wnacg-helper-toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.append(region);
    }
    const toast = document.createElement("div");
    toast.className = `wnacg-helper-toast is-${state}`;
    toast.textContent = message;
    region.append(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.(`.${BUTTON_CLASS}`);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    if (button.dataset.state === "downloading") return;

    setButtonState(button, "downloading");
    try {
      const response = await chrome.runtime.sendMessage({
        type: QUICK_DOWNLOAD,
        aid: button.dataset.aid,
        title: button.dataset.title
      });
      if (!response?.ok) throw new Error(response?.message || "无法创建下载任务。");
      setButtonState(button, response.state || "downloading", response.message);
      showToast(response.message || "下载已开始。", response.state === "complete" ? "success" : "info");
    } catch (error) {
      setButtonState(button, "error", error?.message || String(error));
      showToast(`下载失败：${error?.message || String(error)}`, "error");
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== QUICK_DOWNLOAD_STATUS) return;
    for (const button of buttonsForAid(message.aid)) {
      setButtonState(button, message.state, message.message);
    }
    showToast(message.message, message.state === "complete" ? "success" : "error");
  });

  mountButtons();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(".gallary_item")) mountButtons(node.parentElement || document);
        else if (node.querySelector?.(".gallary_item")) mountButtons(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
