import {
  UPDATE_STATUS,
  WnacgParseError,
  buildTagPageScanPlan,
  createUpdateCandidates,
  filterAlbumsAfterBaselines,
  findReachedBaselineIds,
  findLongestPrefixMatch,
  formatBaselineLabel,
  normalizeTitle,
  parseAlbumListHtml,
  parseDownloadPageHtml,
  splitTitleTags,
  transitionUpdate
} from "./core.js";
import {
  chooseDirectory,
  ensureDirectoryPermission,
  getDirectoryHandle,
  queryDirectoryPermission,
  writeZipResponse
} from "./file-system.js";
import { addActivity, loadAppState, saveAppState, updateAppState } from "./storage.js";

const CATEGORY_URL = "https://www.wnacg.com/albums-index-cate-20.html";
const MAX_SCAN_PAGES = 20;
const MAX_TAG_SCAN_PAGES = 15;
const REQUEST_TIMEOUT_MS = 20_000;

let state;
let directoryHandle = null;
let currentPageSnapshot = null;
let editingWatchId = null;
let busy = false;
const expandedUpdateGroups = new Set();

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  collectElements();
  bindEvents();
  state = await loadAppState();

  let recovered = 0;
  state.updates = state.updates.map((record) => {
    if (record.status !== UPDATE_STATUS.DOWNLOADING) return record;
    recovered += 1;
    return transitionUpdate(record, UPDATE_STATUS.FAILED, {
      error: "上次下载因侧栏关闭或浏览器中断，请重试。"
    });
  });
  if (recovered > 0) {
    addActivity(state, "warning", `已恢复 ${recovered} 个被中断的下载任务。`);
    await saveAppState(state);
  }

  [directoryHandle, currentPageSnapshot] = await Promise.all([
    getDirectoryHandle().catch(() => null),
    refreshCurrentPageSnapshot()
  ]);
  const imported = importCurrentPageMatches(state.watches);
  if (imported.length > 0) {
    addActivity(
      state,
      "success",
      `已从当前页面识别 ${imported.length} 个匹配章节。`
    );
    await saveAppState(state);
  }
  await refreshDirectoryStatus();
  renderAll();
  if (imported.length > 0) {
    showToast(`已从当前页面加入 ${imported.length} 个章节。`, "success");
  }
}

async function readCurrentPageSnapshot() {
  if (!globalThis.chrome?.tabs?.query || !globalThis.chrome?.scripting?.executeScript) {
    return null;
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return null;

  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => {
      if (
        location.hostname !== "www.wnacg.com" ||
        !location.pathname.startsWith("/albums-")
      ) {
        return null;
      }
      const seenAids = new Set();
      const albums = [];
      for (const item of document.querySelectorAll(".gallary_item")) {
        const link =
          item.querySelector('.title a[href*="photos-index-aid-"]') ||
          item.querySelector('a[href*="photos-index-aid-"]');
        if (!link) continue;
        const href = link.getAttribute("href") || "";
        const aid = href.match(/photos-index-aid-(\d+)\.html/i)?.[1];
        const title = String(link.getAttribute("title") || link.textContent || "").trim();
        if (!aid || !title || seenAids.has(aid)) continue;
        seenAids.add(aid);
        albums.push({ aid, title, url: new URL(href, location.href).href });
      }
      return { url: location.href, title: document.title, albums };
    }
  });
  const snapshot = execution?.result;
  return snapshot?.albums?.length ? snapshot : null;
}

async function refreshCurrentPageSnapshot() {
  currentPageSnapshot = await readCurrentPageSnapshot().catch(() => null);
  return currentPageSnapshot;
}

function importCurrentPageMatches(watches) {
  if (!currentPageSnapshot?.albums?.length || watches.length === 0) return [];
  const result = createUpdateCandidates({
    albums: currentPageSnapshot.albums,
    watchItems: watches,
    existingRecords: state.updates,
    detectedAt: new Date().toISOString()
  });
  state.updates = result.records;
  return result.added;
}

async function importCurrentTagPages(watches) {
  const plan = buildTagPageScanPlan(
    currentPageSnapshot?.url,
    MAX_TAG_SCAN_PAGES
  );
  if (plan.length === 0) {
    return { added: importCurrentPageMatches(watches), pagesScanned: 0 };
  }

  const added = [];
  const seenPageSignatures = new Set();
  const currentPage = plan.find(
    (entry) => entry.url === currentPageSnapshot.url
  )?.page;

  for (const entry of plan) {
    setScanProgress(entry.page, plan.length, "正在读取当前标签历史章节");
    let albums;
    if (entry.page === currentPage) {
      albums = currentPageSnapshot.albums;
    } else {
      try {
        const html = await fetchText(entry.url);
        albums = parseAlbumListHtml(html, { baseUrl: entry.url });
      } catch (error) {
        if (error instanceof WnacgParseError && /未找到 \.gallary_item/.test(error.message)) {
          break;
        }
        throw error;
      }
    }

    if (albums.length === 0) break;
    const signature = albums.map((album) => album.aid).join(",");
    if (seenPageSignatures.has(signature)) break;
    seenPageSignatures.add(signature);

    const result = createUpdateCandidates({
      albums,
      watchItems: watches,
      existingRecords: state.updates,
      detectedAt: new Date().toISOString()
    });
    state.updates = result.records;
    added.push(...result.added);
  }

  return { added, pagesScanned: seenPageSignatures.size };
}

function collectElements() {
  for (const id of [
    "choose-directory-btn",
    "directory-name",
    "directory-status",
    "directory-indicator",
    "watch-form",
    "watch-prefix-input",
    "watch-submit-btn",
    "watch-cancel-edit",
    "watch-list",
    "watch-empty",
    "scan-btn",
    "scan-status",
    "scan-progress",
    "scan-progress-label",
    "scan-progress-value",
    "scan-progress-bar",
    "select-all-updates",
    "download-selected-btn",
    "ignore-selected-btn",
    "retry-failed-btn",
    "updates-list",
    "updates-empty",
    "activity-list",
    "activity-empty",
    "clear-activity-btn",
    "watch-count",
    "pending-count",
    "failed-count",
    "selection-count",
    "toast-region",
    "confirm-dialog",
    "confirm-title",
    "confirm-message",
    "confirm-cancel",
    "confirm-ok"
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements["choose-directory-btn"]?.addEventListener("click", handleDirectoryAction);
  elements["watch-form"]?.addEventListener("submit", handleWatchSubmit);
  elements["watch-cancel-edit"]?.addEventListener("click", cancelWatchEdit);
  elements["watch-list"]?.addEventListener("click", handleWatchListClick);
  elements["watch-list"]?.addEventListener("change", handleWatchListChange);
  elements["scan-btn"]?.addEventListener("click", scanForUpdates);
  elements["updates-list"]?.addEventListener("click", handleUpdateGroupToggle);
  elements["updates-list"]?.addEventListener("change", handleUpdateSelection);
  elements["select-all-updates"]?.addEventListener("change", handleSelectAll);
  elements["download-selected-btn"]?.addEventListener("click", downloadSelected);
  elements["ignore-selected-btn"]?.addEventListener("click", ignoreSelected);
  elements["retry-failed-btn"]?.addEventListener("click", retryFailed);
  elements["clear-activity-btn"]?.addEventListener("click", clearActivity);
}

function pageUrl(page) {
  return page === 1
    ? CATEGORY_URL
    : `https://www.wnacg.com/albums-index-page-${page}-cate-20.html`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`请求失败（HTTP ${response.status}）：${url}`);
    }
    return await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadAlbumPage(page) {
  const url = pageUrl(page);
  const html = await fetchText(url);
  return parseAlbumListHtml(html, { baseUrl: url });
}

async function handleDirectoryAction() {
  if (busy) return;
  try {
    if (directoryHandle) {
      const permission = await queryDirectoryPermission(directoryHandle);
      if (permission === "prompt") {
        const granted = await ensureDirectoryPermission(directoryHandle, true);
        if (granted) {
          await refreshDirectoryStatus();
          showToast("已恢复目录写入权限。", "success");
          return;
        }
      }
    }
    directoryHandle = await chooseDirectory();
    await refreshDirectoryStatus();
    showToast(`已选择目录：${directoryHandle.name}`, "success");
  } catch (error) {
    if (error?.name !== "AbortError") showToast(readableError(error), "error");
  }
}

async function refreshDirectoryStatus() {
  const permission = await queryDirectoryPermission(directoryHandle);
  const statusElement = elements["directory-status"];
  const nameElement = elements["directory-name"];
  const button = elements["choose-directory-btn"];
  const indicator = elements["directory-indicator"];
  if (!statusElement || !nameElement || !button) return;

  statusElement.dataset.state = permission;
  indicator?.classList.toggle("is-online", permission === "granted");
  indicator?.classList.toggle(
    "is-error",
    permission === "unavailable" || permission === "denied"
  );
  if (permission === "granted") {
    statusElement.textContent = "已连接";
    nameElement.textContent = directoryHandle.name;
    button.textContent = "更换目录";
  } else if (permission === "prompt") {
    statusElement.textContent = "需要授权";
    nameElement.textContent = directoryHandle?.name || "未选择";
    button.textContent = "重新授权";
  } else if (permission === "unavailable") {
    statusElement.textContent = "目录不可用";
    nameElement.textContent = directoryHandle?.name || "未选择";
    button.textContent = "重新选择";
  } else {
    statusElement.textContent = "未连接";
    nameElement.textContent = "未选择";
    button.textContent = "选择目录";
  }
}

async function handleWatchSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const prefix = elements["watch-prefix-input"]?.value.trim();
  if (!prefix) return;

  const normalizedPrefix = normalizeTitle(prefix);
  const duplicate = state.watches.find(
    (watch) =>
      normalizeTitle(watch.prefix) === normalizedPrefix && watch.id !== editingWatchId
  );
  if (duplicate) {
    showToast("该标题前缀已在关注列表中。", "warning");
    return;
  }

  setBusy(true, "正在建立关注基线…");
  try {
    await refreshCurrentPageSnapshot();
    const baseline = await findBaseline(prefix);
    const id = editingWatchId || crypto.randomUUID();
    const previous = state.watches.find((watch) => watch.id === editingWatchId);
    const watch = {
      id,
      prefix,
      normalizedPrefix,
      enabled: previous?.enabled ?? true,
      baselineAid: baseline.aid,
      baselineKind: baseline.kind,
      baselineTitle: baseline.title,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (editingWatchId) {
      state.watches = state.watches.map((item) => (item.id === id ? watch : item));
      state.updates = state.updates.filter((item) => item.watchId !== id);
      addActivity(state, "info", `已更新关注“${prefix}”并重新建立基线。`);
    } else {
      state.watches.push(watch);
      addActivity(state, "info", `已添加关注“${prefix}”。`);
    }
    const tagImport = await importCurrentTagPages([watch]);
    const imported = tagImport.added;
    if (imported.length > 0) {
      addActivity(
        state,
        "success",
        `已从当前标签 ${tagImport.pagesScanned || 1} 页加入 ${imported.length} 个章节。`
      );
    }
    await saveAppState(state);
    cancelWatchEdit();
    renderAll();
    showToast(
      imported.length > 0
        ? `已识别 ${tagImport.pagesScanned || 1} 页，共 ${imported.length} 个章节。`
        : baseline.kind === "series"
          ? `基线已设为：${formatBaselineLabel(watch)}`
        : "20 页内未找到该漫画，已按当前最新 aid 建立时间边界。",
      imported.length > 0 || baseline.kind === "series" ? "success" : "warning"
    );
  } catch (error) {
    showToast(readableError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function findBaseline(prefix) {
  let newestGlobal = null;
  const temporaryWatch = { id: "baseline", prefix, enabled: true };
  const tagPlan = buildTagPageScanPlan(
    currentPageSnapshot?.url,
    MAX_TAG_SCAN_PAGES
  );
  const firstTagPage = tagPlan[0];
  let baselineAlbums = currentPageSnapshot?.albums || [];
  if (firstTagPage && firstTagPage.url !== currentPageSnapshot.url) {
    const html = await fetchText(firstTagPage.url);
    baselineAlbums = parseAlbumListHtml(html, { baseUrl: firstTagPage.url });
  }
  const currentMatches = baselineAlbums
    .filter(
      (album) => findLongestPrefixMatch(album.title, [temporaryWatch]) === temporaryWatch
    )
    .sort((a, b) => Number(b.aid) - Number(a.aid));
  if (currentMatches.length > 0) {
    return {
      aid: currentMatches[0].aid,
      title: currentMatches[0].title,
      kind: "series"
    };
  }
  for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
    setScanProgress(page, MAX_SCAN_PAGES, `正在查找“${prefix}”的当前章节`);
    const albums = await loadAlbumPage(page);
    if (!newestGlobal) newestGlobal = albums[0];
    const match = albums.find(
      (album) => findLongestPrefixMatch(album.title, [temporaryWatch]) === temporaryWatch
    );
    if (match) {
      return { aid: match.aid, title: match.title, kind: "series" };
    }
  }
  if (!newestGlobal) throw new Error("栏目中没有可用的漫画条目。");
  return {
    aid: newestGlobal.aid,
    title: newestGlobal.title,
    kind: "global"
  };
}

function handleWatchListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  const watch = state.watches.find((item) => item.id === button.dataset.id);
  if (!watch) return;

  if (button.dataset.action === "edit") {
    editingWatchId = watch.id;
    elements["watch-prefix-input"].value = watch.prefix;
    elements["watch-prefix-input"].focus();
    if (elements["watch-submit-btn"]) elements["watch-submit-btn"].textContent = "保存并重建基线";
    elements["watch-cancel-edit"]?.removeAttribute("hidden");
  } else if (button.dataset.action === "delete") {
    void deleteWatch(watch);
  }
}

function handleWatchListChange(event) {
  const toggle = event.target.closest('input[data-action="toggle"]');
  if (!toggle || busy) return;
  const watch = state.watches.find((item) => item.id === toggle.dataset.id);
  if (!watch) return;
  watch.enabled = toggle.checked;
  watch.updatedAt = new Date().toISOString();
  addActivity(state, "info", `${toggle.checked ? "已启用" : "已停用"}关注“${watch.prefix}”。`);
  void saveAppState(state).then(renderAll);
}

async function deleteWatch(watch) {
  const confirmed = await confirmAction(
    "删除关注",
    `删除“${watch.prefix}”及其待处理记录？已下载文件不会被删除。`
  );
  if (!confirmed) return;
  state.watches = state.watches.filter((item) => item.id !== watch.id);
  state.updates = state.updates.filter((item) => item.watchId !== watch.id);
  addActivity(state, "info", `已删除关注“${watch.prefix}”。`);
  await saveAppState(state);
  if (editingWatchId === watch.id) cancelWatchEdit();
  renderAll();
}

function cancelWatchEdit() {
  editingWatchId = null;
  elements["watch-form"]?.reset();
  if (elements["watch-submit-btn"]) elements["watch-submit-btn"].textContent = "添加关注";
  elements["watch-cancel-edit"]?.setAttribute("hidden", "");
}

async function scanForUpdates() {
  if (busy) return;
  const watches = state.watches.filter((watch) => watch.enabled);
  if (watches.length === 0) {
    showToast("请先添加并启用至少一个关注项。", "warning");
    return;
  }

  setBusy(true, "正在检查更新…");
  const reachedBoundary = new Map(watches.map((watch) => [watch.id, false]));
  const newestMatches = new Map();
  let pagesScanned = 0;
  let tagPagesScanned = 0;
  let totalAdded = 0;

  try {
    await refreshCurrentPageSnapshot();
    const tagImport = await importCurrentTagPages(watches);
    tagPagesScanned = tagImport.pagesScanned;
    totalAdded += tagImport.added.length;
    for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
      pagesScanned = page;
      setScanProgress(page, MAX_SCAN_PAGES, "正在读取韩漫/汉化栏目");
      const albums = await loadAlbumPage(page);
      const eligibleAlbums = filterAlbumsAfterBaselines(albums, watches);
      for (const album of albums) {
        const watch = findLongestPrefixMatch(album.title, watches);
        if (!watch) continue;
        if (!newestMatches.has(watch.id)) newestMatches.set(watch.id, album);
      }

      const result = createUpdateCandidates({
        albums: eligibleAlbums,
        watchItems: watches,
        existingRecords: state.updates,
        detectedAt: new Date().toISOString()
      });
      state.updates = result.records;
      totalAdded += result.added.length;

      for (const watchId of findReachedBaselineIds(albums, watches)) {
        reachedBoundary.set(watchId, true);
      }
      if ([...reachedBoundary.values()].every(Boolean)) break;
    }

    const incomplete = watches.filter((watch) => !reachedBoundary.get(watch.id));
    for (const watch of watches) {
      if (!reachedBoundary.get(watch.id)) continue;
      const newest = newestMatches.get(watch.id);
      if (newest && Number(newest.aid) > Number(watch.baselineAid)) {
        watch.baselineAid = newest.aid;
        watch.baselineTitle = newest.title;
        watch.baselineKind = "series";
        watch.updatedAt = new Date().toISOString();
      }
    }

    state.lastScanAt = new Date().toISOString();
    addActivity(
      state,
      incomplete.length ? "warning" : "success",
      `${tagPagesScanned ? `扫描标签 ${tagPagesScanned} 页、` : ""}扫描栏目 ${pagesScanned} 页，发现 ${totalAdded} 个新章节${
        incomplete.length ? `；${incomplete.length} 个关注项未到达基线` : ""
      }。`
    );
    await saveAppState(state);
    renderAll();
    showToast(
      incomplete.length
        ? `发现 ${totalAdded} 个更新，但扫描到 20 页仍有基线未找到。`
        : `检查完成，发现 ${totalAdded} 个新章节。`,
      incomplete.length ? "warning" : "success"
    );
  } catch (error) {
    addActivity(state, "error", `检查更新失败：${readableError(error)}`);
    await saveAppState(state);
    renderAll();
    showToast(readableError(error), "error");
  } finally {
    setBusy(false);
  }
}

function handleUpdateSelection(event) {
  const checkbox = event.target.closest(".update-checkbox");
  if (!checkbox) return;
  const record = state.updates.find((item) => item.aid === checkbox.dataset.aid);
  if (!record) return;
  record.selected = checkbox.checked;
  void saveAppState(state).then(renderActions);
}

function handleUpdateGroupToggle(event) {
  const toggle = event.target.closest(".update-group-toggle");
  if (!toggle || !event.currentTarget.contains(toggle)) return;
  const group = toggle.closest(".update-group");
  const rows = group?.querySelector(".update-group-rows");
  const comicName = toggle.dataset.comicName;
  if (!rows || !comicName) return;

  const expanded = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(expanded));
  rows.hidden = !expanded;
  if (expanded) expandedUpdateGroups.add(comicName);
  else expandedUpdateGroups.delete(comicName);
}

function handleSelectAll(event) {
  const checked = event.target.checked;
  for (const record of actionableUpdates()) record.selected = checked;
  void saveAppState(state).then(renderAll);
}

async function ignoreSelected() {
  if (busy) return;
  const selected = actionableUpdates().filter((record) => record.selected);
  if (selected.length === 0) return;
  const confirmed = await confirmAction(
    "忽略所选更新",
    `将 ${selected.length} 个章节标记为已忽略？它们不会在后续扫描中再次出现。`
  );
  if (!confirmed) return;
  const selectedAids = new Set(selected.map((record) => record.aid));
  state.updates = state.updates.map((record) =>
    selectedAids.has(record.aid)
      ? transitionUpdate(record, UPDATE_STATUS.IGNORED, {
          ignoredAt: new Date().toISOString()
        })
      : record
  );
  addActivity(state, "info", `已忽略 ${selected.length} 个章节。`);
  await saveAppState(state);
  renderAll();
}

async function retryFailed() {
  if (busy) return;
  let count = 0;
  for (const record of state.updates) {
    if (record.status === UPDATE_STATUS.FAILED) {
      record.selected = true;
      count += 1;
    }
  }
  if (count === 0) {
    showToast("当前没有失败任务。", "info");
    return;
  }
  await saveAppState(state);
  await downloadSelected();
}

async function downloadSelected() {
  if (busy) return;
  const selected = actionableUpdates().filter((record) => record.selected);
  if (selected.length === 0) {
    showToast("请先选择要下载的章节。", "warning");
    return;
  }

  const permission = await ensureDirectoryPermission(directoryHandle, true).catch(() => false);
  if (!permission) {
    await refreshDirectoryStatus();
    showToast("请先选择并授权目标目录。", "warning");
    return;
  }

  setBusy(true, `准备下载 ${selected.length} 个章节…`);
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const selectedRecord = selected[index];
    let record = state.updates.find((item) => item.aid === selectedRecord.aid);
    if (!record) continue;
    record = transitionUpdate(record, UPDATE_STATUS.DOWNLOADING, {
      startedAt: new Date().toISOString()
    });
    replaceUpdate(record);
    await saveAppState(state);
    renderAll();

    try {
      setDownloadProgress(index, selected.length, record.title, 0, 0);
      const downloadHtml = await fetchText(record.downloadPageUrl);
      const zipUrl = parseDownloadPageHtml(downloadHtml, {
        baseUrl: record.downloadPageUrl
      });
      const response = await fetch(zipUrl, { cache: "no-store", credentials: "omit" });
      const written = await writeZipResponse({
        rootHandle: directoryHandle,
        comicName: record.comicName,
        title: record.title,
        aid: record.aid,
        response,
        onProgress: ({ written: bytes, total }) =>
          setDownloadProgress(index, selected.length, record.title, bytes, total)
      });
      record = transitionUpdate(record, UPDATE_STATUS.DOWNLOADED, {
        downloadedAt: new Date().toISOString(),
        filePath: written.relativePath,
        bytesWritten: written.bytesWritten
      });
      replaceUpdate(record);
      addActivity(state, "success", `已下载：${written.relativePath}`);
      succeeded += 1;
    } catch (error) {
      record = transitionUpdate(record, UPDATE_STATUS.FAILED, {
        failedAt: new Date().toISOString(),
        error: readableError(error)
      });
      replaceUpdate(record);
      addActivity(state, "error", `下载失败“${record.title}”：${record.error}`);
      failed += 1;
    }
    await saveAppState(state);
    renderAll();
  }

  setBusy(false);
  showToast(
    `下载结束：成功 ${succeeded}，失败 ${failed}。`,
    failed > 0 ? "warning" : "success"
  );
}

function replaceUpdate(nextRecord) {
  state.updates = state.updates.map((record) =>
    record.aid === nextRecord.aid ? nextRecord : record
  );
}

function actionableUpdates() {
  return state.updates.filter((record) =>
    [UPDATE_STATUS.PENDING, UPDATE_STATUS.FAILED].includes(record.status)
  );
}

function renderAll() {
  renderWatches();
  renderUpdates();
  renderActivity();
  renderActions();
  renderLastScan();
}

function renderWatches() {
  const list = elements["watch-list"];
  if (!list) return;
  list.replaceChildren();
  elements["watch-empty"]?.toggleAttribute("hidden", state.watches.length > 0);
  if (elements["watch-count"]) elements["watch-count"].textContent = state.watches.length;
  if (state.watches.length === 0 && elements["watch-empty"]) {
    list.append(elements["watch-empty"]);
    return;
  }

  for (const watch of state.watches) {
    const item = createElement("article", "watch-item");
    const main = createElement("div", "watch-item-main");
    const toggle = createElement("label", "switch");
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = watch.enabled;
    checkbox.dataset.action = "toggle";
    checkbox.dataset.id = watch.id;
    checkbox.setAttribute("aria-label", `${watch.enabled ? "停用" : "启用"}${watch.prefix}`);
    toggle.append(checkbox, createElement("span", "switch-track"));

    const copy = createElement("div", "watch-copy");
    copy.append(
      textElement("strong", watch.prefix, "watch-title"),
      textElement(
        "span",
        `基线：${formatBaselineLabel(watch)}`,
        "watch-meta"
      )
    );

    main.append(toggle, copy);
    const actions = createElement("div", "item-actions");
    actions.append(
      actionButton("✎", "edit", watch.id, "icon-button", "编辑关注项"),
      actionButton("×", "delete", watch.id, "icon-button is-danger", "删除关注项")
    );
    item.append(main, actions);
    list.append(item);
  }
}

function renderUpdates() {
  const list = elements["updates-list"];
  if (!list) return;
  list.replaceChildren();
  const sorted = [...state.updates].sort((a, b) =>
    String(b.detectedAt).localeCompare(String(a.detectedAt))
  );
  elements["updates-empty"]?.toggleAttribute("hidden", sorted.length > 0);
  if (sorted.length === 0 && elements["updates-empty"]) {
    list.append(elements["updates-empty"]);
    return;
  }

  const groups = new Map();
  for (const record of sorted) {
    const key = record.comicName || "未分类";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  for (const comicName of expandedUpdateGroups) {
    if (!groups.has(comicName)) expandedUpdateGroups.delete(comicName);
  }

  let groupIndex = 0;
  for (const [comicName, records] of groups) {
    const group = createElement("section", "update-group");
    const heading = createElement("header", "update-group-header");
    const toggle = createElement("button", "update-group-toggle");
    const rows = createElement("div", "update-group-rows");
    const rowsId = `update-group-rows-${groupIndex}`;
    const expanded = expandedUpdateGroups.has(comicName);
    toggle.type = "button";
    toggle.dataset.comicName = comicName;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", rowsId);
    const chevron = textElement("span", "›", "update-group-chevron");
    chevron.setAttribute("aria-hidden", "true");
    toggle.append(
      chevron,
      textElement("strong", comicName, "update-group-title"),
      textElement("span", `${records.length} 项`, "update-group-count")
    );
    heading.append(toggle);
    rows.id = rowsId;
    rows.hidden = !expanded;
    rows.setAttribute("role", "region");
    rows.setAttribute("aria-label", `${comicName}章节列表`);
    for (const record of records) rows.append(renderUpdateRow(record));
    group.append(heading, rows);
    list.append(group);
    groupIndex += 1;
  }
}

function renderUpdateRow(record) {
  const row = createElement("article", `update-row status-${record.status}`);
  const selectable = [UPDATE_STATUS.PENDING, UPDATE_STATUS.FAILED].includes(record.status);
  const checkbox = createElement("input", "update-checkbox");
  checkbox.type = "checkbox";
  checkbox.dataset.aid = record.aid;
  checkbox.checked = Boolean(record.selected);
  checkbox.disabled = !selectable || busy;
  checkbox.setAttribute("aria-label", `选择${record.title}`);

  const checkboxLabel = createElement("label", "row-check");
  checkboxLabel.append(checkbox);
  const copy = createElement("div", "update-title-cell");
  const titleLink = createElement("a", "update-title");
  appendHighlightedTitle(titleLink, record.title);
  titleLink.href = record.sourceUrl;
  titleLink.target = "_blank";
  titleLink.rel = "noreferrer";
  copy.append(titleLink);
  if (record.filePath) copy.append(textElement("span", record.filePath, "file-path"));
  if (record.error) copy.append(textElement("span", record.error, "update-error"));
  row.append(
    checkboxLabel,
    copy,
    textElement("span", record.aid, "update-aid"),
    textElement("time", formatDate(record.detectedAt), "update-discovered"),
    textElement("span", statusLabel(record.status), `status-pill is-${record.status}`)
  );
  return row;
}

function appendHighlightedTitle(target, title) {
  for (const part of splitTitleTags(title)) {
    if (!part.kind) {
      target.append(document.createTextNode(part.text));
      continue;
    }
    const tag = createElement("span", `title-token is-${part.kind}`);
    tag.textContent = part.text;
    target.append(tag);
  }
}

function renderActivity() {
  const list = elements["activity-list"];
  if (!list) return;
  list.replaceChildren();
  elements["activity-empty"]?.toggleAttribute("hidden", state.activity.length > 0);
  if (state.activity.length === 0 && elements["activity-empty"]) {
    list.append(elements["activity-empty"]);
    return;
  }
  for (const entry of state.activity.slice(0, 30)) {
    const row = createElement("li", `activity-item level-${entry.level}`);
    row.append(
      textElement("time", formatDate(entry.createdAt), "activity-time"),
      textElement("span", activityLabel(entry.level), "activity-type"),
      textElement("span", entry.message, "activity-message")
    );
    list.append(row);
  }
}

function renderActions() {
  const actionable = actionableUpdates();
  const selected = actionable.filter((record) => record.selected);
  const failed = state.updates.filter((record) => record.status === UPDATE_STATUS.FAILED);
  if (elements["pending-count"]) elements["pending-count"].textContent = actionable.length;
  if (elements["failed-count"]) elements["failed-count"].textContent = failed.length;
  if (elements["selection-count"]) {
    elements["selection-count"].textContent = `已选 ${selected.length} 项`;
  }
  const allCheckbox = elements["select-all-updates"];
  if (allCheckbox) {
    allCheckbox.disabled = actionable.length === 0 || busy;
    allCheckbox.checked = actionable.length > 0 && selected.length === actionable.length;
    allCheckbox.indeterminate = selected.length > 0 && selected.length < actionable.length;
  }
  setDisabled(elements["download-selected-btn"], selected.length === 0 || busy);
  setDisabled(elements["ignore-selected-btn"], selected.length === 0 || busy);
  setDisabled(elements["retry-failed-btn"], failed.length === 0 || busy);
  setDisabled(elements["scan-btn"], busy || state.watches.every((watch) => !watch.enabled));
  setDisabled(elements["choose-directory-btn"], busy);
}

function renderLastScan() {
  const status = elements["scan-status"];
  if (!status || busy) return;
  status.textContent = state.lastScanAt
    ? `上次检查：${formatDate(state.lastScanAt)}`
    : "尚未检查";
}

function setBusy(value, message = "") {
  busy = value;
  document.body.toggleAttribute("data-busy", value);
  if (elements["scan-status"] && message) {
    elements["scan-status"].textContent = `${message} · 侧栏任务进行中`;
  }
  if (!value && elements["scan-progress"]) {
    setProgressVisual(0, MAX_SCAN_PAGES, "尚未开始", `0 / ${MAX_SCAN_PAGES} 页`);
  }
  renderActions();
  if (!value) renderLastScan();
}

function setScanProgress(current, total, message) {
  setProgressVisual(current, total, message, `${current} / ${total} 页`);
  if (elements["scan-status"]) {
    elements["scan-status"].textContent = `${message} · ${current}/${total} · 侧栏任务进行中`;
  }
}

function setDownloadProgress(index, totalFiles, title, written, totalBytes) {
  const progress = totalBytes > 0 ? Math.round((written / totalBytes) * 100) : null;
  setProgressVisual(
    totalBytes ? written : index + 1,
    totalBytes || totalFiles,
    `下载 ${index + 1}/${totalFiles}`,
    progress === null ? formatBytes(written) : `${progress}%`
  );
  if (elements["scan-status"]) {
    elements["scan-status"].textContent = `下载 ${index + 1}/${totalFiles}：${title}${
      progress === null ? (written ? ` · ${formatBytes(written)}` : "") : ` · ${progress}%`
    } · 侧栏任务进行中`;
  }
}

function showToast(message, level = "info") {
  const region = elements["toast-region"];
  if (!region) return;
  const toast = textElement("div", message, `toast toast-${level}`);
  toast.setAttribute("role", level === "error" ? "alert" : "status");
  region.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function confirmAction(title, message) {
  const dialog = elements["confirm-dialog"];
  if (!dialog) return Promise.resolve(window.confirm(message));
  elements["confirm-title"].textContent = title;
  elements["confirm-message"].textContent = message;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (result) => {
      elements["confirm-cancel"].removeEventListener("click", cancel);
      elements["confirm-ok"].removeEventListener("click", accept);
      dialog.close();
      resolve(result);
    };
    const cancel = () => finish(false);
    const accept = () => finish(true);
    elements["confirm-cancel"].addEventListener("click", cancel, { once: true });
    elements["confirm-ok"].addEventListener("click", accept, { once: true });
  });
}

function actionButton(label, action, id, extraClass = "text-button", ariaLabel = label) {
  const button = textElement("button", label, extraClass);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  button.setAttribute("aria-label", ariaLabel);
  button.title = ariaLabel;
  return button;
}

function setProgressVisual(current, total, label, valueLabel) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const track = elements["scan-progress"];
  if (track) {
    track.setAttribute("aria-valuemax", String(total));
    track.setAttribute("aria-valuenow", String(current));
  }
  if (elements["scan-progress-bar"]) {
    elements["scan-progress-bar"].style.width = `${Math.round(ratio * 100)}%`;
  }
  if (elements["scan-progress-label"]) elements["scan-progress-label"].textContent = label;
  if (elements["scan-progress-value"]) elements["scan-progress-value"].textContent = valueLabel;
}

async function clearActivity() {
  if (busy || state.activity.length === 0) return;
  const confirmed = await confirmAction("清空活动记录", "清空全部活动记录？下载与关注状态不会受到影响。");
  if (!confirmed) return;
  state.activity = [];
  await updateAppState((latest) => {
    latest.activity = [];
  });
  renderAll();
}

function createElement(tagName, className = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function textElement(tagName, text, className = "") {
  const element = createElement(tagName, className);
  element.textContent = text;
  return element;
}

function setDisabled(element, disabled) {
  if (element) element.disabled = disabled;
}

function statusLabel(status) {
  return {
    [UPDATE_STATUS.PENDING]: "待处理",
    [UPDATE_STATUS.DOWNLOADING]: "下载中",
    [UPDATE_STATUS.DOWNLOADED]: "已下载",
    [UPDATE_STATUS.IGNORED]: "已忽略",
    [UPDATE_STATUS.FAILED]: "失败"
  }[status] || status;
}

function activityLabel(level) {
  return {
    success: "成功",
    warning: "警告",
    error: "错误",
    info: "信息"
  }[level] || "信息";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function readableError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "未知错误");
}
