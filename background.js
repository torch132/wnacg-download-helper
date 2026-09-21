import {
  deriveComicName,
  findLongestPrefixMatch,
  isAllowedDownloadUrl,
  parseDownloadPageText,
  parseDownloadTitleText,
  sanitizeFileName,
  truncateUtf8
} from "./core.js";
import { addActivity, loadAppState, updateAppState } from "./storage.js";

const QUICK_DOWNLOAD = "WNACG_QUICK_DOWNLOAD";
const QUICK_DOWNLOAD_STATUS = "WNACG_QUICK_DOWNLOAD_STATUS";
const QUICK_DOWNLOAD_STATES = "WNACG_QUICK_DOWNLOAD_STATES";
const ACTIVE_KEY = "wnacgQuickDownloads";
const REQUEST_TIMEOUT_MS = 20_000;
const startFlights = new Map();
const activeMemory = new Map();
const finishPromises = new Map();
const setupPromises = new Map();
const desiredPathsByUrl = new Map();
const desiredPathsByDownloadId = new Map();
let stateWriteQueue = Promise.resolve();
let activeWriteQueue = Promise.resolve();
let recoveryPromise = null;

function validateSource(sender) {
  try {
    const url = new URL(sender.tab?.url || sender.url || "");
    return (
      url.protocol === "https:" &&
      url.hostname === "www.wnacg.com" &&
      (
        url.pathname === "/" ||
        url.pathname.startsWith("/albums") ||
        url.pathname.startsWith("/search/")
      )
    );
  } catch {
    return false;
  }
}

function validateRequest(message, sender) {
  if (!validateSource(sender)) throw new Error("拒绝来自非 wnACG 列表页的下载请求。");
  const aid = String(message?.aid ?? "");
  const title = String(message?.title ?? "").trim();
  if (!/^\d{1,12}$/u.test(aid)) throw new Error("漫画 aid 无效。");
  if (!title || title.length > 500) throw new Error("漫画标题无效。");
  return { aid, title };
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
    if (!response.ok) throw new Error(`下载页请求失败（HTTP ${response.status}）。`);
    return await response.text();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("下载页请求超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readActiveDownloads() {
  const stored = await chrome.storage.session.get(ACTIVE_KEY);
  return stored[ACTIVE_KEY] || {};
}

function mutateActiveDownloads(mutator) {
  const operation = activeWriteQueue.then(async () => {
    const active = await readActiveDownloads();
    await mutator(active);
    await chrome.storage.session.set({ [ACTIVE_KEY]: active });
    return active;
  });
  activeWriteQueue = operation.catch(() => {});
  return operation;
}

function mutateAppState(mutator) {
  const operation = stateWriteQueue.then(() => updateAppState(mutator));
  stateWriteQueue = operation.catch(() => {});
  return operation;
}

function comicNameFor(title, watches) {
  const matched = findLongestPrefixMatch(title, watches);
  return String(matched?.prefix || matched?.titlePrefix || deriveComicName(title)).trim();
}

function pathComponent(value, fallback, maxBytes) {
  return truncateUtf8(sanitizeFileName(value, fallback), maxBytes) || fallback;
}

function downloadUrlKey(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    return url.href;
  } catch {
    return String(value || "");
  }
}

function pathMatchesRelative(actualPath, relativePath) {
  const actual = String(actualPath || "").replaceAll("\\", "/");
  const relative = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  return Boolean(actual && relative && (actual === relative || actual.endsWith(`/${relative}`)));
}

async function completedQuickDownloadExists(record) {
  if (record?.status !== "downloaded") return false;
  if (!pathMatchesRelative(record.actualFilePath, record.relativePath)) return false;
  if (!Number.isInteger(record.downloadId)) return true;
  try {
    const [item] = await chrome.downloads.search({ id: record.downloadId });
    return Boolean(
      item &&
      item.exists !== false &&
      pathMatchesRelative(item.filename || record.actualFilePath, record.relativePath)
    );
  } catch {
    return true;
  }
}

function readableDownloadError(errorCode) {
  const messages = {
    SERVER_FAILED: "下载服务器暂时不可用（可能为 HTTP 503），请稍后重试",
    NETWORK_FAILED: "网络连接失败，请检查代理或网络后重试",
    NETWORK_TIMEOUT: "下载连接超时，请稍后重试",
    FILE_FAILED: "Chrome 无法写入目标文件",
    USER_CANCELED: "下载已取消"
  };
  return messages[errorCode] || errorCode || "未知原因";
}

function mergeTabIds(...collections) {
  return [...new Set(
    collections
      .flatMap((collection) => [...(collection || [])])
      .filter(Number.isInteger)
  )];
}

async function findActiveByAid(aid, tabIds = []) {
  const active = await readActiveDownloads();
  const entry = Object.entries(active).find(([, item]) => item.aid === aid);
  if (!entry) return null;
  const [downloadId, metadata] = entry;
  const mergedTabIds = mergeTabIds(metadata.tabIds, tabIds);
  if (mergedTabIds.length !== (metadata.tabIds || []).length) {
    metadata.tabIds = mergedTabIds;
    activeMemory.set(Number(downloadId), metadata);
    await mutateActiveDownloads((latest) => {
      if (latest[downloadId]) latest[downloadId].tabIds = metadata.tabIds;
    });
  }
  return { downloadId: Number(downloadId), metadata };
}

async function subscribeFlight(flight, tabId) {
  if (!Number.isInteger(tabId)) return;
  flight.tabIds.add(tabId);
  if (!flight.metadata) return;
  flight.metadata.tabIds = mergeTabIds(flight.metadata.tabIds, flight.tabIds);
  activeMemory.set(flight.downloadId, flight.metadata);
  await mutateActiveDownloads((active) => {
    const item = active[String(flight.downloadId)];
    if (item) item.tabIds = flight.metadata.tabIds;
  });
}

async function handleQuickDownload(message, sender) {
  const request = validateRequest(message, sender);
  const tabId = sender.tab?.id ?? null;
  const existingFlight = startFlights.get(request.aid);
  if (existingFlight) {
    await subscribeFlight(existingFlight, tabId);
    return existingFlight.promise;
  }

  const flight = {
    aid: request.aid,
    tabIds: new Set(),
    metadata: null,
    downloadId: null,
    promise: null
  };
  startFlights.set(request.aid, flight);
  if (Number.isInteger(tabId)) flight.tabIds.add(tabId);
  flight.promise = startQuickDownload(request, flight).finally(() => {
    if (startFlights.get(request.aid) === flight) startFlights.delete(request.aid);
  });
  return flight.promise;
}

async function startQuickDownload(request, flight) {
  const { aid } = request;
  await ensureRecovery();
  const activeEntry = await findActiveByAid(aid, flight.tabIds);
  if (activeEntry) {
    return { ok: true, state: "downloading", message: "该漫画正在下载。" };
  }

  const initialState = await loadAppState();
  const existing = initialState.quickDownloads.find((item) => String(item.aid) === aid);
  if (await completedQuickDownloadExists(existing)) {
    return {
      ok: true,
      state: "complete",
      message: `该漫画已下载到：${existing.actualFilePath}`
    };
  }

  const downloadPageUrl = `https://www.wnacg.com/download-index-aid-${aid}.html`;
  const html = await fetchText(downloadPageUrl);
  const zipUrl = parseDownloadPageText(html, { baseUrl: downloadPageUrl });
  const officialTitle = parseDownloadTitleText(html) || request.title;
  const latestState = await loadAppState();
  const comicName = comicNameFor(officialTitle, latestState.watches);
  const folder = pathComponent(comicName, "一键下载", 120);
  const fileBase = pathComponent(officialTitle, `wnacg-${aid}`, 180);
  const relativePath = `${folder}/${fileBase}.zip`;

  const urlKey = downloadUrlKey(zipUrl);
  desiredPathsByUrl.set(urlKey, relativePath);
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: zipUrl,
      filename: relativePath,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (error) {
    desiredPathsByUrl.delete(urlKey);
    throw error;
  }
  if (!Number.isInteger(downloadId)) {
    desiredPathsByUrl.delete(urlKey);
    throw new Error("Chrome 未能创建下载任务。");
  }
  desiredPathsByDownloadId.set(downloadId, relativePath);

  const metadata = {
    aid,
    title: officialTitle,
    comicName,
    zipUrl,
    relativePath,
    tabIds: mergeTabIds(flight.tabIds)
  };
  flight.metadata = metadata;
  flight.downloadId = downloadId;
  activeMemory.set(downloadId, metadata);
  const now = new Date().toISOString();
  const setupPromise = (async () => {
    await mutateActiveDownloads((active) => {
      active[String(downloadId)] = metadata;
    });
    await mutateAppState((state) => {
      const current = state.quickDownloads.find((item) => String(item.aid) === aid);
      const record = {
        ...(current || {}),
        aid,
        comicName,
        title: officialTitle,
        status: "downloading",
        relativePath,
        downloadId,
        startedAt: now,
        error: null
      };
      state.quickDownloads = current
        ? state.quickDownloads.map((item) => (String(item.aid) === aid ? record : item))
        : [...state.quickDownloads, record];
      addActivity(state, "info", `已开始一键下载：${relativePath}`);
    });
  })();
  setupPromises.set(downloadId, setupPromise);
  try {
    await setupPromise;
  } finally {
    setupPromises.delete(downloadId);
  }

  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item?.state === "complete" || item?.state === "interrupted") {
    return finishDownload(downloadId, item.state, item.error);
  }
  return { ok: true, state: "downloading", downloadId, message: "下载已开始。" };
}

function finishDownload(downloadId, stateName, errorCode = null) {
  const existing = finishPromises.get(downloadId);
  if (existing) return existing;
  const operation = finalizeDownload(downloadId, stateName, errorCode).finally(() => {
    finishPromises.delete(downloadId);
  });
  finishPromises.set(downloadId, operation);
  return operation;
}

async function finalizeDownload(downloadId, stateName, errorCode = null) {
  await setupPromises.get(downloadId)?.catch(() => {});
  const active = await readActiveDownloads();
  const metadata = activeMemory.get(downloadId) || active[String(downloadId)];
  if (!metadata) {
    return { ok: false, state: "error", downloadId, message: "未找到下载任务元数据。" };
  }

  const [downloadItem] = await chrome.downloads.search({ id: downloadId });
  let completed = stateName === "complete";
  let finalError = readableDownloadError(errorCode);
  if (completed && !downloadItem) {
    completed = false;
    finalError = "未找到已完成的下载任务";
  } else if (completed) {
    const finalUrl = downloadItem.finalUrl || downloadItem.url;
    const mime = String(downloadItem.mime || "").toLowerCase();
    if (!isAllowedDownloadUrl(finalUrl)) {
      completed = false;
      finalError = "最终下载域名不受信任";
    } else if (mime && !/(zip|octet-stream)/u.test(mime)) {
      completed = false;
      finalError = `文件类型不是 ZIP（${mime}）`;
    } else if (Number(downloadItem.fileSize) === 0) {
      completed = false;
      finalError = "下载文件为空";
    } else if (!pathMatchesRelative(downloadItem.filename, metadata.relativePath)) {
      completed = false;
      finalError = `实际保存路径不符合预期：${downloadItem.filename}`;
    }
  }

  if (!completed && downloadItem?.filename && downloadItem.exists !== false) {
    try {
      await chrome.downloads.removeFile(downloadId);
      finalError = `${finalError || "文件校验失败"}；失败文件已删除`;
    } catch {
      finalError = `${finalError || "文件校验失败"}；自动删除失败，请手动删除 ${downloadItem.filename}`;
    }
  }

  const actualFilePath = downloadItem?.filename || null;
  const finalizedAt = new Date().toISOString();
  await mutateAppState((state) => {
    const current = state.quickDownloads.find(
      (item) => String(item.aid) === metadata.aid
    );
    const alreadyFinal =
      current?.downloadId === downloadId &&
      ["downloaded", "failed"].includes(current.status);
    const record = {
      ...(current || metadata),
      aid: metadata.aid,
      comicName: metadata.comicName,
      title: metadata.title,
      relativePath: metadata.relativePath,
      actualFilePath,
      downloadId,
      status: completed ? "downloaded" : "failed",
      downloadedAt: completed ? finalizedAt : current?.downloadedAt,
      failedAt: completed ? current?.failedAt : finalizedAt,
      error: completed ? null : `Chrome 下载中断：${finalError || "未知原因"}`
    };
    state.quickDownloads = current
      ? state.quickDownloads.map((item) =>
          String(item.aid) === metadata.aid ? record : item
        )
      : [...state.quickDownloads, record];
    if (completed) {
      state.updates = state.updates.map((item) =>
        String(item.aid) === metadata.aid && ["pending", "failed"].includes(item.status)
          ? {
              ...item,
              status: "downloaded",
              selected: false,
              downloadedAt: finalizedAt,
              filePath: actualFilePath || metadata.relativePath,
              downloadMethod: "quick",
              error: null
            }
          : item
      );
    }
    if (!alreadyFinal) {
      addActivity(
        state,
        completed ? "success" : "error",
        completed
          ? `一键下载完成：${actualFilePath || metadata.relativePath}`
          : `一键下载失败“${metadata.title}”：${finalError || "未知原因"}`
      );
    }
  });

  const message = completed ? "下载完成。" : `下载失败：${finalError || "未知原因"}`;
  const tabIds = mergeTabIds(
    metadata.tabIds,
    startFlights.get(metadata.aid)?.tabIds
  );
  for (const tabId of tabIds) {
    await chrome.tabs.sendMessage(tabId, {
      type: QUICK_DOWNLOAD_STATUS,
      aid: metadata.aid,
      state: completed ? "complete" : "error",
      message
    }).catch(() => {});
  }
  activeMemory.delete(downloadId);
  desiredPathsByDownloadId.delete(downloadId);
  if (metadata.zipUrl) desiredPathsByUrl.delete(downloadUrlKey(metadata.zipUrl));
  await mutateActiveDownloads((latest) => {
    delete latest[String(downloadId)];
  });
  return {
    ok: completed,
    state: completed ? "complete" : "error",
    downloadId,
    message
  };
}

async function markRecoveryFailure(record, reason) {
  await mutateAppState((state) => {
    const current = state.quickDownloads.find(
      (item) => String(item.aid) === String(record.aid)
    );
    if (!current || current.status !== "downloading") return;
    current.status = "failed";
    current.failedAt = new Date().toISOString();
    current.error = reason;
    addActivity(state, "error", `一键下载恢复失败“${current.title}”：${reason}`);
  });
}

async function recoverQuickDownloads() {
  const [active, state] = await Promise.all([readActiveDownloads(), loadAppState()]);
  const records = new Map();
  for (const [id, metadata] of Object.entries(active)) {
    const downloadId = Number(id);
    if (Number.isInteger(downloadId)) records.set(downloadId, metadata);
  }
  for (const record of state.quickDownloads.filter((item) => item.status === "downloading")) {
    if (!Number.isInteger(record.downloadId)) {
      await markRecoveryFailure(record, "浏览器重启后缺少下载任务编号。");
      continue;
    }
    const previous = records.get(record.downloadId) || {};
    records.set(record.downloadId, {
      ...record,
      ...previous,
      aid: String(record.aid),
      tabIds: mergeTabIds(previous.tabIds)
    });
  }

  for (const [downloadId, metadata] of records) {
    activeMemory.set(downloadId, metadata);
    if (metadata.relativePath) {
      desiredPathsByDownloadId.set(downloadId, metadata.relativePath);
    }
    let item;
    try {
      [item] = await chrome.downloads.search({ id: downloadId });
    } catch {
      item = null;
    }
    if (item?.state === "in_progress") {
      await mutateActiveDownloads((latest) => {
        latest[String(downloadId)] = metadata;
      });
    } else {
      await finishDownload(
        downloadId,
        item?.state === "complete" ? "complete" : "interrupted",
        item?.error || "浏览器重启后未找到下载任务"
      );
    }
  }
}

function ensureRecovery() {
  if (!recoveryPromise) {
    recoveryPromise = recoverQuickDownloads().catch((error) => {
      recoveryPromise = null;
      throw error;
    });
  }
  return recoveryPromise;
}

async function quickDownloadStates(message, sender) {
  if (!validateSource(sender)) throw new Error("拒绝来自非 wnACG 列表页的状态请求。");
  const aids = [...new Set((message?.aids || []).map(String))]
    .filter((aid) => /^\d{1,12}$/u.test(aid))
    .slice(0, 200);
  await ensureRecovery();
  const state = await loadAppState();
  const result = {};
  for (const aid of aids) {
    const quick = state.quickDownloads.find((item) => String(item.aid) === aid);
    if (await completedQuickDownloadExists(quick)) result[aid] = "complete";
    else if (quick?.status === "downloading") result[aid] = "downloading";
    else if (quick?.status === "failed") result[aid] = "error";
  }
  return { ok: true, states: result };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message?.type === QUICK_DOWNLOAD
    ? handleQuickDownload
    : message?.type === QUICK_DOWNLOAD_STATES
      ? quickDownloadStates
      : null;
  if (!handler) return false;
  handler(message, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, state: "error", message: error?.message || String(error) })
    );
  return true;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const urlKeys = [downloadUrlKey(item.url), downloadUrlKey(item.finalUrl)];
  const relativePath =
    desiredPathsByDownloadId.get(item.id) ||
    urlKeys.map((key) => desiredPathsByUrl.get(key)).find(Boolean);
  if (!relativePath) return;

  desiredPathsByDownloadId.set(item.id, relativePath);
  for (const key of urlKeys) desiredPathsByUrl.delete(key);
  suggest({ filename: relativePath, conflictAction: "uniquify" });
});

chrome.downloads.onChanged.addListener((delta) => {
  const stateName = delta.state?.current;
  if (stateName === "complete" || stateName === "interrupted") {
    void finishDownload(delta.id, stateName, delta.error?.current);
  }
});

void ensureRecovery().catch((error) => {
  console.error("wnACG 一键下载恢复失败", error);
});
