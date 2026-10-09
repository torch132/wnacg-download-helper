import {
  WnacgParseError,
  deriveComicName,
  findLongestPrefixMatch,
  isAllowedDownloadUrl,
  isSameChapterAcrossCollections,
  parseCollectionChapterPage,
  parseDownloadItemsText,
  parseDownloadTitleText,
  sanitizeFileName,
  truncateUtf8
} from "./core.js";
import { addActivity, loadAppState, updateAppState } from "./storage.js";

const QUICK_DOWNLOAD = "WNACG_QUICK_DOWNLOAD";
const QUICK_DOWNLOAD_STATUS = "WNACG_QUICK_DOWNLOAD_STATUS";
const QUICK_DOWNLOAD_STATES = "WNACG_QUICK_DOWNLOAD_STATES";
const ACTIVE_KEY = "wnacgQuickDownloads";
const FILENAME_PATHS_KEY = "wnacgFilenamePaths";
const REQUEST_TIMEOUT_MS = 20_000;
const COLLECTION_CHAPTER_INTERVAL_MS = 1_000;
const COLLECTION_ALARM_PREFIX = "wnacg-collection:";
const MAX_RELATIVE_PATH_BYTES = 240;
const MAX_FOLDER_BYTES = 80;
const MAX_FILE_BASE_BYTES = 180;
const startFlights = new Map();
const activeMemory = new Map();
const finishPromises = new Map();
const setupPromises = new Map();
const collectionAdvances = new Map();
const collectionTimers = new Map();
const desiredPathsByUrl = new Map();
const desiredPathsByDownloadId = new Map();
let stateWriteQueue = Promise.resolve();
let activeWriteQueue = Promise.resolve();
let filenamePathsWriteQueue = Promise.resolve();
let recoveryPromise = null;

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("wnACG 侧栏入口配置失败", error);
  }
}

async function loadFilenamePaths() {
  try {
    const stored = await chrome.storage.session.get(FILENAME_PATHS_KEY);
    for (const [key, relativePath] of Object.entries(stored[FILENAME_PATHS_KEY] || {})) {
      if (key && typeof relativePath === "string" && relativePath) {
        desiredPathsByUrl.set(key, relativePath);
      }
    }
  } catch (error) {
    console.warn("wnACG 下载路径映射恢复失败", error);
  }
}

const filenamePathsReady = loadFilenamePaths();

function mutateFilenamePaths(mutator) {
  const operation = filenamePathsWriteQueue.then(async () => {
    await filenamePathsReady;
    const stored = await chrome.storage.session.get(FILENAME_PATHS_KEY);
    const paths = { ...(stored[FILENAME_PATHS_KEY] || {}) };
    await mutator(paths);
    await chrome.storage.session.set({ [FILENAME_PATHS_KEY]: paths });
  });
  filenamePathsWriteQueue = operation.catch(() => {});
  return operation;
}

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
  return { aid, title, isCollection: message?.isCollection === true };
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

function collectionChapterPageUrl(sourceAid, page) {
  const url = new URL("https://www.wnacg.com/");
  url.search = new URLSearchParams({
    ctl: "download",
    act: "chapters",
    sid: sourceAid,
    page: String(page)
  });
  return url.href;
}

async function resolveDownloadItems({ aid, title, isCollection }) {
  const downloadPageUrl = `https://www.wnacg.com/download-index-aid-${aid}.html`;
  const html = await fetchText(downloadPageUrl);
  const officialTitle = parseDownloadTitleText(html) || title;
  let manifest;
  try {
    manifest = parseDownloadItemsText(html, {
      sourceAid: aid,
      sourceTitle: title,
      pageUrl: downloadPageUrl
    });
  } catch (error) {
    if (!isCollection || !(error instanceof WnacgParseError)) throw error;
  }
  let items = manifest ? [...manifest.items] : [];
  let firstApiPage = manifest?.isCollection &&
    items.length < Math.min(manifest.total, manifest.limit) ? 1 : 2;

  if (isCollection && !manifest?.isCollection) {
    // 卡片明确标为合集时，不能因下载页缺少章节容器而误下父 aid 的单个 ZIP。
    manifest = parseCollectionChapterPage(
      await fetchText(collectionChapterPageUrl(aid, 1)),
      { sourceAid: aid }
    );
    items = [...manifest.items];
    firstApiPage = 2;
  }

  if (manifest.isCollection) {
    const pageCount = Math.ceil(manifest.total / Math.max(1, manifest.limit));
    // 页面章节行不完整时先请求接口第一页，避免把缺失的话数当作已下载。
    for (let page = firstApiPage; page <= pageCount; page += 1) {
      const result = parseCollectionChapterPage(
        await fetchText(collectionChapterPageUrl(manifest.sourceAid, page)),
        { sourceAid: manifest.sourceAid }
      );
      items.push(...result.items);
    }
  }

  const uniqueItems = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.recordKey)) continue;
    seen.add(item.recordKey);
    uniqueItems.push(item);
  }
  if (uniqueItems.length === 0) throw new Error("下载页没有可下载的章节。");
  if (manifest.isCollection && uniqueItems.length < manifest.total) {
    throw new Error(
      `合集章节清单不完整：页面标注 ${manifest.total} 话，仅解析到 ${uniqueItems.length} 话。`
    );
  }
  return {
    ...manifest,
    officialTitle,
    total: Math.max(manifest.total, uniqueItems.length),
    items: uniqueItems
  };
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

function comicNameFor(title, watches, fallbackTitle = "") {
  const matched =
    findLongestPrefixMatch(title, watches) ||
    findLongestPrefixMatch(fallbackTitle, watches);
  return String(matched?.prefix || matched?.titlePrefix || deriveComicName(title)).trim();
}

function pathComponent(value, fallback, maxBytes) {
  return truncateUtf8(sanitizeFileName(value, fallback), maxBytes) || fallback;
}

function utf8Length(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function buildRelativePath(comicName, officialTitle, aid) {
  const folder = pathComponent(comicName, "一键下载", MAX_FOLDER_BYTES);
  const fallback = `wnacg-${aid}`;
  const initialFileBase = pathComponent(officialTitle, fallback, MAX_FILE_BASE_BYTES);
  const availableFileBytes = Math.max(
    utf8Length(fallback),
    MAX_RELATIVE_PATH_BYTES - utf8Length(folder) - 1 - utf8Length(".zip")
  );
  const fileBase =
    truncateUtf8(initialFileBase, availableFileBytes) ||
    truncateUtf8(fallback, availableFileBytes) ||
    "wnacg";
  const relativePath = `${folder}/${fileBase}.zip`;
  if (utf8Length(relativePath) <= MAX_RELATIVE_PATH_BYTES) return relativePath;

  const emergencyFileBytes = Math.max(1, MAX_RELATIVE_PATH_BYTES - utf8Length(folder) - 1 - 4);
  const emergencyFileBase = truncateUtf8(fallback, emergencyFileBytes) || "wnacg";
  return `${folder}/${emergencyFileBase}.zip`;
}

function isInvalidFilenameError(error) {
  return /invalid[ _-]?filename/iu.test(error?.message || String(error || ""));
}

async function createChromeDownload(zipUrl, relativePath) {
  await rememberFilenamePath(zipUrl, relativePath);
  try {
    const downloadPromise = chrome.downloads.download({
      url: zipUrl,
      filename: relativePath,
      conflictAction: "uniquify",
      saveAs: false
    });
    const downloadId = await downloadPromise;
    if (!Number.isInteger(downloadId)) {
      throw new Error("Chrome 未能创建下载任务。");
    }
    return downloadId;
  } catch (error) {
    await forgetFilenamePath(zipUrl, relativePath);
    throw error;
  }
}

function downloadUrlKeys(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    return [...new Set([url.href, `${url.origin}${url.pathname}`])];
  } catch {
    const key = String(value || "");
    return key ? [key] : [];
  }
}

async function rememberFilenamePath(url, relativePath) {
  await filenamePathsReady;
  const keys = downloadUrlKeys(url);
  for (const key of keys) desiredPathsByUrl.set(key, relativePath);
  await mutateFilenamePaths((paths) => {
    for (const key of keys) paths[key] = relativePath;
  }).catch((error) => {
    console.warn("wnACG 下载路径映射保存失败", error);
  });
}

async function forgetFilenamePath(url, relativePath) {
  await filenamePathsReady;
  // 同一 ZIP 被再次点击且两轮下载重叠时，仍在进行的任务还需要这条文件名映射。
  if ([...activeMemory.values()].some((item) =>
    item.zipUrl === url && item.relativePath === relativePath
  )) return;
  const keys = downloadUrlKeys(url);
  for (const key of keys) {
    if (desiredPathsByUrl.get(key) === relativePath) desiredPathsByUrl.delete(key);
  }
  await mutateFilenamePaths((paths) => {
    for (const key of keys) {
      if (paths[key] === relativePath) delete paths[key];
    }
  }).catch((error) => {
    console.warn("wnACG 下载路径映射清理失败", error);
  });
}

function pathMatchesRelative(actualPath, relativePath) {
  const actual = String(actualPath || "").replaceAll("\\", "/");
  const relative = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!actual || !relative) return false;
  if (actual === relative || actual.endsWith(`/${relative}`)) return true;

  // Chrome 的 uniquify 会在文件扩展名前追加 " (1)"，这仍属于同一目标路径。
  const extensionMatch = relative.match(/(\.[^./]+)$/u);
  if (!extensionMatch) return false;
  const extension = extensionMatch[1];
  const stem = relative.slice(0, -extension.length);
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped(stem)} \\(\\d+\\)${escaped(extension)}$`, "u").test(actual);
}

function readableDownloadError(errorCode) {
  const messages = {
    SERVER_FAILED: "下载服务器暂时不可用（可能为 HTTP 503），请稍后重试",
    NETWORK_FAILED: "网络连接失败，请检查代理或网络后重试",
    NETWORK_TIMEOUT: "下载连接超时，请稍后重试",
    FILE_FAILED: "Chrome 无法写入目标文件",
    USER_CANCELED: "下载已取消",
    INVALID_FILENAME: "Chrome 拒绝了下载文件名，请重试"
  };
  return messages[errorCode] || errorCode || "未知原因";
}

function readableDownloadException(error) {
  const message = error?.message || String(error || "未知原因");
  if (isInvalidFilenameError(error)) {
    return "Chrome 拒绝了下载文件名，请重试";
  }
  return message;
}

function mergeTabIds(...collections) {
  return [...new Set(
    collections
      .flatMap((collection) => [...(collection || [])])
      .filter(Number.isInteger)
  )];
}

function recordKeyFor(record) {
  return String(record?.recordKey || `album:${record?.downloadAid || record?.aid || ""}`);
}

function sourceAidFor(record) {
  return String(record?.sourceAid || record?.aid || "");
}

function recordsForSource(records, sourceAid, batchId) {
  const matching = records.filter((record) =>
    sourceAidFor(record) === String(sourceAid) && !record.supersededByCollection
  );
  const selectedBatch = batchId === undefined
    ? matching.at(-1)?.batchId || null
    : batchId || null;
  return matching.filter((record) => (record.batchId || null) === selectedBatch);
}

function sameQuickTask(record, target) {
  return recordKeyFor(record) === recordKeyFor(target) &&
    (record?.batchId || null) === (target?.batchId || null);
}

function aggregateSourceState(records) {
  if (records.length === 0) return { state: "idle", completed: 0, total: 0 };
  const expectedTotal = Math.max(
    records.length,
    ...records.map((record) => Number(record.collectionTotal) || 1)
  );
  const completed = records.filter((record) => record.status === "downloaded").length;
  if (records.some((record) => ["queued", "starting", "downloading"].includes(record.status))) {
    return { state: "downloading", completed, total: expectedTotal };
  }
  if (
    records.length >= expectedTotal &&
    records.every((record) => record.status === "downloaded")
  ) {
    return { state: "complete", completed, total: expectedTotal };
  }
  return { state: "error", completed, total: expectedTotal };
}

async function subscribeFlight(flight, tabId) {
  if (!Number.isInteger(tabId)) return;
  flight.tabIds.add(tabId);
  await mutateAppState((state) => {
    for (const record of state.quickDownloads) {
      if (sourceAidFor(record) === flight.aid && record.batchId === flight.batchId) {
        record.tabIds = mergeTabIds(record.tabIds, flight.tabIds);
      }
    }
  });
  if (flight.metadatas.size === 0) return;
  for (const [downloadId, metadata] of flight.metadatas) {
    metadata.tabIds = mergeTabIds(metadata.tabIds, flight.tabIds);
    activeMemory.set(downloadId, metadata);
  }
  await mutateActiveDownloads((active) => {
    for (const [downloadId, metadata] of flight.metadatas) {
      const item = active[String(downloadId)];
      if (item) item.tabIds = metadata.tabIds;
    }
  });
}

async function subscribeCollectionBatch(records, tabId) {
  if (!Number.isInteger(tabId)) return;
  const { sourceAid, batchId } = records[0];
  await mutateAppState((state) => {
    for (const record of state.quickDownloads) {
      if (sourceAidFor(record) === String(sourceAid) && record.batchId === batchId) {
        record.tabIds = mergeTabIds(record.tabIds, [tabId]);
      }
    }
  });
  await mutateActiveDownloads((active) => {
    for (const [id, metadata] of Object.entries(active)) {
      if (sourceAidFor(metadata) !== String(sourceAid) || metadata.batchId !== batchId) continue;
      metadata.tabIds = mergeTabIds(metadata.tabIds, [tabId]);
      if (activeMemory.has(Number(id))) activeMemory.get(Number(id)).tabIds = metadata.tabIds;
    }
  });
}

function collectionQueueKey(sourceAid, batchId) {
  return `${sourceAid}:${batchId}`;
}

function scheduleCollectionAdvance(sourceAid, batchId, readyAt) {
  const key = collectionQueueKey(sourceAid, batchId);
  clearTimeout(collectionTimers.get(key));
  const delay = Math.max(0, Number(readyAt || 0) - Date.now());
  const timer = setTimeout(() => {
    collectionTimers.delete(key);
    void advanceCollectionBatch(sourceAid, batchId).catch((error) =>
      console.error("wnACG 合集队列推进失败", error)
    );
  }, delay);
  collectionTimers.set(key, timer);
  // MV3 worker 可能在短定时器触发前被回收；alarm 作为持久保底唤醒。
  chrome.alarms?.create(`${COLLECTION_ALARM_PREFIX}${key}`, {
    when: Math.max(Date.now() + 30_000, Number(readyAt || 0))
  });
}

function advanceCollectionBatch(sourceAid, batchId) {
  const key = collectionQueueKey(sourceAid, batchId);
  if (collectionAdvances.has(key)) return collectionAdvances.get(key);
  const operation = runCollectionAdvance(sourceAid, batchId).finally(() => {
    collectionAdvances.delete(key);
  });
  collectionAdvances.set(key, operation);
  return operation;
}

async function runCollectionAdvance(sourceAid, batchId) {
  const state = await loadAppState();
  const records = recordsForSource(state.quickDownloads, sourceAid, batchId);
  if (records.some((record) => ["starting", "downloading", "failed", "paused"].includes(record.status))) return;
  const next = records.find((record) => record.status === "queued");
  if (!next) return;
  const readyAt = Number(next.readyAt || 0);
  if (readyAt > Date.now()) {
    scheduleCollectionAdvance(sourceAid, batchId, readyAt);
    return;
  }

  await mutateAppState((latest) => {
    const current = latest.quickDownloads.find((record) => sameQuickTask(record, next));
    if (current?.status === "queued") {
      current.status = "starting";
      current.startingAt = new Date().toISOString();
    }
  });
  const flight = {
    batchId,
    tabIds: new Set(mergeTabIds(...records.map((record) => record.tabIds))),
    metadatas: new Map()
  };
  try {
    await startDownloadItem({
      item: next,
      manifest: { sourceAid, total: next.collectionTotal, isCollection: true },
      request: { title: next.sourceTitle },
      comicName: next.comicName,
      flight
    });
  } catch (error) {
    await markStartFailure(next, next.comicName,
      { sourceAid, total: next.collectionTotal }, batchId, error);
    await pauseCollectionQueue(sourceAid, batchId, readableDownloadException(error));
  }
}

async function pauseCollectionQueue(sourceAid, batchId, reason) {
  const latest = await mutateAppState((state) => {
    for (const record of state.quickDownloads) {
      if (sourceAidFor(record) === String(sourceAid) && record.batchId === batchId &&
          record.status === "queued") {
        record.status = "paused";
        record.error = `前一话下载失败，剩余话数未启动：${reason}`;
      }
    }
  });
  const records = recordsForSource(latest.quickDownloads, sourceAid, batchId);
  const aggregate = aggregateSourceState(records);
  const tabIds = mergeTabIds(...records.map((record) => record.tabIds));
  for (const tabId of tabIds) {
    await chrome.tabs.sendMessage(tabId, {
      type: QUICK_DOWNLOAD_STATUS,
      aid: String(sourceAid),
      state: "error",
      message: `合集下载已暂停，已完成 ${aggregate.completed}/${aggregate.total}；再次点击将从未完成话数继续。`
    }).catch(() => {});
  }
}

function latestCollectionBatch(records, sourceAid) {
  const batches = new Map();
  records.forEach((record, index) => {
    if (sourceAidFor(record) !== String(sourceAid) || record.supersededByCollection) return;
    const batchId = String(record.batchId || "");
    if (!batchId) return;
    const batch = batches.get(batchId) || { batchId, records: [], lastIndex: index };
    batch.records.push(record);
    batch.lastIndex = index;
    batches.set(batchId, batch);
  });
  return [...batches.values()].sort((first, second) => first.lastIndex - second.lastIndex).at(-1) || null;
}

function collectionBatchNeedsResume(batch, manifest) {
  if (!batch || !batch.records.some((record) => record.isCollection)) return false;
  if (batch.records.some((record) => ["starting", "downloading"].includes(record.status))) {
    return false;
  }
  const knownKeys = new Set(batch.records.map((record) => recordKeyFor(record)));
  const hasNewChapter = manifest.items.some((item) => !knownKeys.has(recordKeyFor(item)));
  const hasInterruptedChapter = batch.records.some((record) =>
    ["failed", "paused", "queued"].includes(record.status)
  );
  return hasNewChapter || hasInterruptedChapter;
}

async function resumeCollectionBatch({ manifest, request, comicName, flight, batch }) {
  const now = new Date().toISOString();
  const batchId = batch.batchId;
  flight.batchId = batchId;
  await mutateAppState((state) => {
    const existingKeys = new Set(
      state.quickDownloads
        .filter((record) => sourceAidFor(record) === String(manifest.sourceAid) &&
          record.batchId === batchId)
        .map((record) => recordKeyFor(record))
    );
    state.quickDownloads = state.quickDownloads.map((record) => {
      if (sourceAidFor(record) !== String(manifest.sourceAid) || record.batchId !== batchId) {
        return record;
      }
      const latestItem = manifest.items.find((item) => recordKeyFor(item) === recordKeyFor(record));
      const refreshed = latestItem ? { ...record, ...latestItem } : record;
      const shouldQueue = ["failed", "paused", "queued"].includes(record.status);
      return {
        ...refreshed,
        sourceAid: manifest.sourceAid,
        sourceTitle: request.title,
        comicName,
        collectionTotal: manifest.total,
        downloadMethod: "quick",
        tabIds: mergeTabIds(record.tabIds, flight.tabIds),
        ...(shouldQueue ? {
          status: "queued",
          downloadId: null,
          actualFilePath: null,
          readyAt: 0,
          startedAt: now,
          failedAt: null,
          error: null
        } : {})
      };
    });
    for (const item of manifest.items) {
      if (existingKeys.has(recordKeyFor(item))) continue;
      state.quickDownloads.push({
        ...item,
        batchId,
        aid: item.downloadAid,
        sourceAid: manifest.sourceAid,
        sourceTitle: request.title,
        comicName,
        collectionTotal: manifest.total,
        downloadMethod: "quick",
        status: "queued",
        tabIds: mergeTabIds(flight.tabIds),
        startedAt: now,
        error: null
      });
    }
  });
  await advanceCollectionBatch(manifest.sourceAid, batchId);
  return batchId;
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
    batchId: crypto.randomUUID(),
    tabIds: new Set(),
    metadatas: new Map(),
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
  await ensureRecovery();
  const currentState = await loadAppState();
  const currentRecords = recordsForSource(currentState.quickDownloads, request.aid);
  if (currentRecords.some((record) =>
    record.isCollection && ["queued", "starting", "downloading"].includes(record.status)
  )) {
    for (const tabId of flight.tabIds) await subscribeCollectionBatch(currentRecords, tabId);
    return { ok: true, state: "downloading", message: "该合集正在逐话下载。" };
  }
  const manifest = await resolveDownloadItems(request);
  const initialState = await loadAppState();
  const comicName = comicNameFor(
    request.title,
    initialState.watches,
    manifest.officialTitle
  );
  const latestBatch = latestCollectionBatch(initialState.quickDownloads, manifest.sourceAid);
  if (manifest.isCollection && collectionBatchNeedsResume(latestBatch, manifest)) {
    await resumeCollectionBatch({ manifest, request, comicName, flight, batch: latestBatch });
    const resumedState = await loadAppState();
    const aggregate = aggregateSourceState(
      recordsForSource(resumedState.quickDownloads, manifest.sourceAid, flight.batchId)
    );
    return {
      ok: aggregate.state !== "error",
      state: aggregate.state,
      message: aggregate.state === "error"
        ? `合集下载失败，已完成 ${aggregate.completed}/${aggregate.total}；再次点击将从未完成话数继续。`
        : `合集将从未完成话数继续（${aggregate.completed}/${aggregate.total}）。`
    };
  }
  const now = new Date().toISOString();
  await mutateAppState((state) => {
    // 网页按钮每次点击都是新批次；旧记录仅保留为历史，不参与是否下载的判断。
    state.quickDownloads = state.quickDownloads
      .map((record) => manifest.isCollection &&
        sourceAidFor(record) === manifest.sourceAid && !record.batchId
          ? { ...record, supersededByCollection: true }
          : record)
      .concat(manifest.items.map((item) => ({
        ...item,
        batchId: flight.batchId,
        aid: item.downloadAid,
        sourceAid: manifest.sourceAid,
        sourceTitle: request.title,
        comicName,
        collectionTotal: manifest.total,
        downloadMethod: "quick",
        status: manifest.isCollection ? "queued" : "downloading",
        tabIds: mergeTabIds(flight.tabIds),
        startedAt: now,
        error: null
      })));
  });

  if (manifest.isCollection) {
    await advanceCollectionBatch(manifest.sourceAid, flight.batchId);
    const latestState = await loadAppState();
    const aggregate = aggregateSourceState(
      recordsForSource(latestState.quickDownloads, manifest.sourceAid, flight.batchId)
    );
    return {
      ok: aggregate.state !== "error",
      state: aggregate.state,
      message: aggregate.state === "error"
        ? "合集下载已暂停，再次点击将从未完成话数继续。"
        : `合集正在逐话下载（共 ${aggregate.total} 个文件）。`
    };
  }

  const results = [];
  for (const item of manifest.items) {
    try {
      results.push(await startDownloadItem({
        item,
        manifest,
        request,
        comicName,
        flight
      }));
    } catch (error) {
      await markStartFailure(item, comicName, manifest, flight.batchId, error);
      results.push({ ok: false, state: "error", message: readableDownloadException(error) });
    }
  }

  const latestState = await loadAppState();
  const aggregate = aggregateSourceState(
    recordsForSource(latestState.quickDownloads, manifest.sourceAid, flight.batchId)
  );
  const firstDownloadId = results.find((result) => Number.isInteger(result?.downloadId))?.downloadId;
  if (aggregate.state === "complete") {
    return {
      ok: true,
      state: "complete",
      downloadId: firstDownloadId,
      message: manifest.isCollection
        ? `合集 ${aggregate.total} 个文件均已下载。`
        : "该漫画已下载。"
    };
  }
  if (aggregate.state === "error") {
    return {
      ok: false,
      state: "error",
      downloadId: firstDownloadId,
      message: manifest.isCollection
        ? `合集下载失败，已完成 ${aggregate.completed}/${aggregate.total}；再次点击将从未完成话数继续。`
        : results.find((result) => result?.ok === false)?.message || "下载创建失败。"
    };
  }
  return {
    ok: true,
    state: "downloading",
    downloadId: firstDownloadId,
    message: manifest.isCollection
      ? `合集已开始下载（${aggregate.total} 个文件）。`
      : "下载已开始。"
  };
}

async function startDownloadItem({ item, manifest, request, comicName, flight }) {
  let relativePath = buildRelativePath(comicName, item.title || request.title, item.downloadAid);
  let downloadId;
  try {
    downloadId = await createChromeDownload(item.zipUrl, relativePath);
  } catch (error) {
    if (!isInvalidFilenameError(error)) throw error;
    // 首选标题仍被 Chrome 拒绝时，保留漫画目录并改用只含 aid 的安全文件名重试。
    const fallbackPath = buildRelativePath(comicName, `wnacg-${item.downloadAid}`, item.downloadAid);
    if (fallbackPath === relativePath) throw error;
    relativePath = fallbackPath;
    downloadId = await createChromeDownload(item.zipUrl, relativePath);
  }
  desiredPathsByDownloadId.set(downloadId, relativePath);

  const metadata = {
    ...item,
    batchId: flight.batchId,
    aid: item.downloadAid,
    sourceAid: manifest.sourceAid,
    sourceTitle: request.title,
    comicName,
    collectionTotal: manifest.total,
    relativePath,
    tabIds: mergeTabIds(flight.tabIds)
  };
  flight.metadatas.set(downloadId, metadata);
  activeMemory.set(downloadId, metadata);
  const startedAt = new Date().toISOString();
  const setupPromise = (async () => {
    await mutateActiveDownloads((active) => {
      active[String(downloadId)] = metadata;
    });
    await mutateAppState((state) => {
      const current = state.quickDownloads.find(
        (record) => sameQuickTask(record, metadata)
      );
      const record = {
        ...(current || metadata),
        ...metadata,
        status: "downloading",
        relativePath,
        downloadId,
        startedAt,
        error: null
      };
      state.quickDownloads = current
        ? state.quickDownloads.map((entry) =>
            sameQuickTask(entry, metadata) ? record : entry
          )
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

  const [downloadItem] = await chrome.downloads.search({ id: downloadId });
  if (downloadItem?.state === "complete" || downloadItem?.state === "interrupted") {
    return finishDownload(downloadId, downloadItem.state, downloadItem.error);
  }
  return { ok: true, state: "downloading", downloadId };
}

async function markStartFailure(item, comicName, manifest, batchId, error) {
  const message = readableDownloadException(error);
  await mutateAppState((state) => {
    const identity = { ...item, batchId };
    const current = state.quickDownloads.find(
      (record) => sameQuickTask(record, identity)
    );
    const failedAt = new Date().toISOString();
    const record = {
      ...(current || item),
      ...item,
      batchId,
      aid: item.downloadAid,
      sourceAid: manifest.sourceAid,
      comicName,
      collectionTotal: manifest.total,
      downloadMethod: "quick",
      status: "failed",
      downloadId: null,
      actualFilePath: null,
      failedAt,
      error: message
    };
    state.quickDownloads = current
      ? state.quickDownloads.map((entry) =>
          sameQuickTask(entry, identity) ? record : entry
        )
      : [...state.quickDownloads, record];
    addActivity(state, "error", `一键下载创建失败“${item.title}”：${message}`);
  });
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
  const latestState = await mutateAppState((state) => {
    const current = state.quickDownloads.find(
      (item) => sameQuickTask(item, metadata)
    );
    const alreadyFinal =
      current?.downloadId === downloadId &&
      ["downloaded", "failed"].includes(current.status);
    const record = {
      ...(current || metadata),
      aid: metadata.aid,
      batchId: metadata.batchId || null,
      recordKey: recordKeyFor(metadata),
      sourceAid: sourceAidFor(metadata),
      downloadAid: metadata.downloadAid || metadata.aid,
      comicName: metadata.comicName,
      title: metadata.title,
      relativePath: metadata.relativePath,
      actualFilePath,
      downloadId,
      downloadMethod: "quick",
      status: completed ? "downloaded" : "failed",
      downloadedAt: completed ? finalizedAt : current?.downloadedAt,
      failedAt: completed ? current?.failedAt : finalizedAt,
      error: completed ? null : `Chrome 下载中断：${finalError || "未知原因"}`
    };
    state.quickDownloads = current
      ? state.quickDownloads.map((item) =>
          sameQuickTask(item, metadata) ? record : item
        )
      : [...state.quickDownloads, record];
    if (completed) {
      state.updates = state.updates.map((item) =>
        (
          recordKeyFor(item) === recordKeyFor(metadata) ||
          isSameChapterAcrossCollections(item, metadata) ||
          (
            !item.recordKey &&
            !metadata.isCollection &&
            String(item.aid) === String(metadata.aid)
          )
        ) && ["pending", "failed"].includes(item.status)
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
    if (metadata.isCollection) {
      const queue = state.quickDownloads.filter((item) =>
        sourceAidFor(item) === sourceAidFor(metadata) && item.batchId === metadata.batchId
      );
      const next = queue.find((item) => item.status === "queued");
      if (next && completed) {
        // 从前一话真正结束的时刻起等待一秒，而非从创建 Chrome 任务起计时。
        next.readyAt = Date.now() + COLLECTION_CHAPTER_INTERVAL_MS;
      } else if (!completed) {
        for (const item of queue.filter((entry) => entry.status === "queued")) {
          item.status = "paused";
          item.error = `前一话下载失败，剩余话数未启动：${finalError}`;
        }
      }
    }
  });

  const aggregate = aggregateSourceState(
    recordsForSource(latestState.quickDownloads, sourceAidFor(metadata), metadata.batchId)
  );
  const isLatestBatch = recordsForSource(
    latestState.quickDownloads, sourceAidFor(metadata)
  ).some((record) => sameQuickTask(record, metadata));
  const isCollection = Boolean(metadata.isCollection || aggregate.total > 1);
  const message = aggregate.state === "complete"
    ? isCollection
      ? `合集下载完成，共 ${aggregate.total} 个文件。`
      : "下载完成。"
    : aggregate.state === "error"
      ? isCollection
        ? `合集下载失败，已完成 ${aggregate.completed}/${aggregate.total}；再次点击将从未完成话数继续。`
        : `下载失败：${finalError || "未知原因"}`
      : `正在下载（${aggregate.completed}/${aggregate.total}）。`;
  const tabIds = mergeTabIds(
    metadata.tabIds,
    startFlights.get(sourceAidFor(metadata))?.tabIds
  );
  if (isLatestBatch && (aggregate.state === "complete" || aggregate.state === "error")) {
    for (const tabId of tabIds) {
      await chrome.tabs.sendMessage(tabId, {
        type: QUICK_DOWNLOAD_STATUS,
        aid: sourceAidFor(metadata),
        state: aggregate.state,
        message
      }).catch(() => {});
    }
  }
  activeMemory.delete(downloadId);
  desiredPathsByDownloadId.delete(downloadId);
  if (metadata.zipUrl) await forgetFilenamePath(metadata.zipUrl, metadata.relativePath);
  await mutateActiveDownloads((latest) => {
    delete latest[String(downloadId)];
  });
  if (metadata.isCollection && completed) {
    const next = recordsForSource(
      latestState.quickDownloads, sourceAidFor(metadata), metadata.batchId
    ).find((item) => item.status === "queued");
    if (next) scheduleCollectionAdvance(sourceAidFor(metadata), metadata.batchId, next.readyAt);
  }
  return {
    ok: completed,
    state: aggregate.state === "downloading"
      ? "downloading"
      : completed ? "complete" : "error",
    downloadId,
    message
  };
}

async function markRecoveryFailure(record, reason) {
  await mutateAppState((state) => {
    const current = state.quickDownloads.find(
      (item) => sameQuickTask(item, record)
    );
    if (!current || !["downloading", "starting"].includes(current.status)) return;
    current.status = "failed";
    current.failedAt = new Date().toISOString();
    current.error = reason;
    addActivity(state, "error", `一键下载恢复失败“${current.title}”：${reason}`);
  });
}

async function recoverQuickDownloads() {
  await filenamePathsReady;
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
      recordKey: recordKeyFor(record),
      sourceAid: sourceAidFor(record),
      tabIds: mergeTabIds(previous.tabIds)
    });
  }

  // 创建任务到保存下载 ID 之间若 worker 重启，不能盲目重提交同一 ZIP。
  for (const record of state.quickDownloads.filter((item) => item.status === "starting")) {
    await markRecoveryFailure(record, "下载启动时后台重启，无法安全确认任务编号；请重新点击合集按钮。");
    if (record.isCollection) {
      await pauseCollectionQueue(sourceAidFor(record), record.batchId,
        "下载启动状态无法确认");
    }
  }

  for (const [downloadId, metadata] of records) {
    activeMemory.set(downloadId, metadata);
    if (metadata.relativePath) {
      desiredPathsByDownloadId.set(downloadId, metadata.relativePath);
      if (metadata.zipUrl) {
        for (const key of downloadUrlKeys(metadata.zipUrl)) {
          desiredPathsByUrl.set(key, metadata.relativePath);
        }
      }
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
  const recovered = await loadAppState();
  const latestCollections = new Map();
  for (const record of recovered.quickDownloads) {
    if (record.isCollection && record.batchId) {
      latestCollections.set(sourceAidFor(record), record.batchId);
    }
  }
  for (const [sourceAid, batchId] of latestCollections) {
    await advanceCollectionBatch(sourceAid, batchId);
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
    const records = recordsForSource(state.quickDownloads, aid);
    const aggregate = aggregateSourceState(records);
    if (aggregate.state !== "idle") {
      result[aid] = aggregate.state;
    }
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
      sendResponse({ ok: false, state: "error", message: readableDownloadException(error) })
    );
  return true;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const urlKeys = [
    ...downloadUrlKeys(item.url),
    ...downloadUrlKeys(item.finalUrl)
  ].filter((key, index, keys) => key && keys.indexOf(key) === index);
  const relativePath =
    desiredPathsByDownloadId.get(item.id) ||
    urlKeys.map((key) => desiredPathsByUrl.get(key)).find(Boolean);
  if (!relativePath) return;

  desiredPathsByDownloadId.set(item.id, relativePath);
  suggest({ filename: relativePath, conflictAction: "uniquify" });
});

chrome.downloads.onChanged.addListener((delta) => {
  const stateName = delta.state?.current;
  if (stateName === "complete" || stateName === "interrupted") {
    void finishDownload(delta.id, stateName, delta.error?.current).catch((error) =>
      console.error("wnACG 下载终态处理失败", error)
    );
  }
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (!alarm.name?.startsWith(COLLECTION_ALARM_PREFIX)) return;
  const [sourceAid, batchId] = alarm.name.slice(COLLECTION_ALARM_PREFIX.length).split(":");
  if (sourceAid && batchId) {
    void advanceCollectionBatch(sourceAid, batchId).catch((error) =>
      console.error("wnACG 合集恢复失败", error)
    );
  }
});

void ensureRecovery().catch((error) => {
  console.error("wnACG 一键下载恢复失败", error);
});

void configureSidePanel();
