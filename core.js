const WNACG_ORIGIN = "https://www.wnacg.com";
const DEFAULT_DOWNLOAD_HOST = "wn01.download";

export const UPDATE_STATUS = Object.freeze({
  PENDING: "pending",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  IGNORED: "ignored",
  FAILED: "failed",
});

const STATUS_TRANSITIONS = Object.freeze({
  [UPDATE_STATUS.PENDING]: new Set([
    UPDATE_STATUS.DOWNLOADING,
    UPDATE_STATUS.IGNORED,
  ]),
  [UPDATE_STATUS.DOWNLOADING]: new Set([
    UPDATE_STATUS.PENDING,
    UPDATE_STATUS.DOWNLOADED,
    UPDATE_STATUS.FAILED,
  ]),
  [UPDATE_STATUS.FAILED]: new Set([
    UPDATE_STATUS.DOWNLOADING,
    UPDATE_STATUS.IGNORED,
  ]),
  [UPDATE_STATUS.DOWNLOADED]: new Set(),
  [UPDATE_STATUS.IGNORED]: new Set(),
});

export class WnacgParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "WnacgParseError";
  }
}

export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("zh-Hans-CN");
}

const TITLE_TAG_PATTERN = /(\[中国翻訳\]|\[DL版\]|\[無修正\])/gu;

export function splitTitleTags(value) {
  return String(value ?? "")
    .split(TITLE_TAG_PATTERN)
    .filter(Boolean)
    .map((text) => ({
      text,
      kind:
        text === "[中国翻訳]"
          ? "translation"
          : text === "[DL版]"
            ? "dl"
            : text === "[無修正]"
              ? "uncensored"
              : null
    }));
}

function watchPrefix(watchItem) {
  return (
    watchItem?.normalizedPrefix ||
    watchItem?.titlePrefix ||
    watchItem?.prefix ||
    watchItem?.name ||
    watchItem?.title ||
    ""
  );
}

export function findLongestPrefixMatch(title, watchItems = []) {
  const normalizedTitle = normalizeTitle(title);
  let bestMatch = null;
  let bestLength = -1;

  for (const watchItem of watchItems) {
    if (!watchItem || watchItem.enabled === false) continue;

    const normalizedPrefix = normalizeTitle(watchPrefix(watchItem));
    if (
      normalizedPrefix &&
      normalizedTitle.startsWith(normalizedPrefix) &&
      normalizedPrefix.length > bestLength
    ) {
      bestMatch = watchItem;
      bestLength = normalizedPrefix.length;
    }
  }

  return bestMatch;
}

export function extractAid(value) {
  const match = String(value ?? "").match(
    /(?:photos|download)-index-aid-(\d+)\.html(?:[?#]|$)/i,
  );
  return match ? match[1] : null;
}

export function parseTagListingUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.wnacg.com") return null;

  const match = url.pathname.match(
    /^\/albums-index-(?:page-(\d+)-)?tag-(.+)\.html$/i,
  );
  if (!match) return null;
  const page = Number(match[1] || 1);
  if (!Number.isSafeInteger(page) || page < 1) return null;
  return { page, tagPath: match[2] };
}

export function buildTagPageScanPlan(
  currentUrl,
  maxPages = 15,
) {
  const current = parseTagListingUrl(currentUrl);
  const cap = Math.floor(Number(maxPages));
  if (!current || !Number.isSafeInteger(cap) || cap < 1) return [];

  return Array.from({ length: cap }, (_, index) => {
    const page = index + 1;
    return {
      page,
      url: `${WNACG_ORIGIN}/albums-index-page-${page}-tag-${current.tagPath}.html`,
    };
  });
}

function documentFromHtml(html, parserCtor) {
  const Parser = parserCtor ?? globalThis.DOMParser;
  if (typeof Parser !== "function") {
    throw new WnacgParseError(
      "当前环境不支持 DOMParser；在 Node 中请注入兼容的 parserCtor。",
    );
  }

  const document = new Parser().parseFromString(String(html ?? ""), "text/html");
  if (!document || typeof document.querySelectorAll !== "function") {
    throw new WnacgParseError("HTML 解析器未返回有效文档。");
  }
  return document;
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

export function parseAlbumListHtml(
  html,
  { parserCtor, baseUrl = WNACG_ORIGIN } = {},
) {
  const document = documentFromHtml(html, parserCtor);
  const itemNodes = [...document.querySelectorAll(".gallary_item")];
  if (itemNodes.length === 0) {
    throw new WnacgParseError("栏目页面中未找到 .gallary_item，页面结构可能已变化。");
  }

  const albums = [];
  const seenAids = new Set();
  for (const item of itemNodes) {
    const link =
      item.querySelector('.title a[href*="photos-index-aid-"]') ||
      item.querySelector('a[href*="photos-index-aid-"]');
    if (!link) continue;

    const href = link.getAttribute("href") || "";
    const aid = extractAid(href);
    const title = String(
      link.getAttribute("title") || link.textContent || "",
    ).trim();
    const url = absoluteUrl(href, baseUrl);
    if (!aid || !title || !url || seenAids.has(aid)) continue;

    seenAids.add(aid);
    albums.push({ aid, title, url });
  }

  if (albums.length === 0) {
    throw new WnacgParseError("栏目页面包含条目，但未解析出有效漫画链接。");
  }
  return albums;
}

export function isAllowedDownloadUrl(
  value,
  { allowedHost = DEFAULT_DOWNLOAD_HOST } = {},
) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const expectedHost = String(allowedHost).toLowerCase();
  if (!expectedHost) return false;
  const hostAllowed =
    hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
  return (
    url.protocol === "https:" &&
    hostAllowed &&
    url.pathname.toLowerCase().endsWith(".zip")
  );
}

function decodeHtmlAttribute(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return String(value ?? "").replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt));/gi,
    (entity, decimal, hexadecimal, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return named[name.toLowerCase()] ?? entity;
    },
  );
}

function quotedAttribute(tag, name) {
  const match = String(tag).match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? "") : null;
}

export function parseDownloadPageText(
  html,
  {
    baseUrl = WNACG_ORIGIN,
    allowedHost = DEFAULT_DOWNLOAD_HOST,
  } = {},
) {
  let linkCount = 0;
  for (const match of String(html ?? "").matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const className = quotedAttribute(tag, "class");
    if (!className?.split(/\s+/u).includes("ads")) continue;
    linkCount += 1;
    const href = quotedAttribute(tag, "href");
    const resolved = href ? absoluteUrl(href, baseUrl) : null;
    if (resolved && isAllowedDownloadUrl(resolved, { allowedHost })) {
      return resolved;
    }
  }

  throw new WnacgParseError(
    linkCount === 0
      ? "下载页面中未找到备用下载链接。"
      : "下载页面未包含受信任的 HTTPS ZIP 链接。",
  );
}

export function parseDownloadTitleText(html) {
  const match = String(html ?? "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeHtmlAttribute(match[1].replace(/<[^>]*>/gu, ""))
    .replace(/\.zip\s+下載(?:\s*-\s*.*)?$/u, "")
    .trim();
  return title || null;
}

export function parseDownloadPageHtml(
  html,
  {
    parserCtor,
    baseUrl = WNACG_ORIGIN,
    allowedHost = DEFAULT_DOWNLOAD_HOST,
  } = {},
) {
  const document = documentFromHtml(html, parserCtor);
  const links = [...document.querySelectorAll("a.ads[href]")];

  for (const link of links) {
    const resolved = absoluteUrl(link.getAttribute("href") || "", baseUrl);
    if (resolved && isAllowedDownloadUrl(resolved, { allowedHost })) {
      return resolved;
    }
  }

  throw new WnacgParseError(
    links.length === 0
      ? "下载页面中未找到备用下载链接。"
      : "下载页面未包含受信任的 HTTPS ZIP 链接。",
  );
}

export function sanitizeFileName(value, fallback = "untitled") {
  const clean = (input) => String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "")
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/u, "")
    .trim();
  const sanitized = clean(value);
  const safeFallback = clean(fallback) || "untitled";
  return sanitized || safeFallback;
}

export function truncateUtf8(value, maxBytes = 180) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 0));
  const encoder = new TextEncoder();
  let result = "";
  let length = 0;
  for (const character of String(value ?? "")) {
    const size = encoder.encode(character).byteLength;
    if (length + size > limit) break;
    result += character;
    length += size;
  }
  return result.replace(/[. ]+$/u, "").trim();
}

const CHAPTER_SUFFIX_PATTERN = /(?:^|\s)((?:全\s*)?(?:第\s*)?\d+(?:\.\d+)?(?:\s*[-–—~至]\s*\d+(?:\.\d+)?)?\s*(?:話|话|回|章|卷|巻)|(?:ch(?:apter)?|ep(?:isode)?)\.?\s*\d+(?:\.\d+)?(?:\s*[-–—~至]\s*\d+(?:\.\d+)?)?)(?:\s*[\[(（]?(?:完|完結|完结)[\])）]?)?$/iu;
const CHAPTER_REMAINDER_PATTERN = /^((?:(?:全\s*)?(?:第\s*)?\d+(?:\.\d+)?(?:\s*[-–—~至]\s*\d+(?:\.\d+)?)?\s*(?:話|话|回|章|卷|巻)?|(?:ch(?:apter)?|ep(?:isode)?)\.?\s*\d+(?:\.\d+)?(?:\s*[-–—~至]\s*\d+(?:\.\d+)?)?|(?:番外篇|外傳|外传|特別篇|特别篇|序章|終章|终章|後記|后记)(?:\s*\d+)?))(?:\s*[\[(（]?(?:完|完結|完结)[\])）]?)?$/iu;
const BARE_CHAPTER_SUFFIX_PATTERN = /\s+(?:第\s*)?\d+(?:\.\d+)?\s*[-–—~至]\s*\d+(?:\.\d+)?\s*$/u;

function compactChapterLabel(value) {
  return value
    .replace(/\s*([-–—~至])\s*/gu, "$1")
    .replace(/^(全|第)\s+/u, "$1")
    .replace(/\s+(?=[話话回章卷巻]$)/u, "")
    .trim();
}

export function extractChapterLabel(title, { seriesPrefix = "" } = {}) {
  const value = String(title ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const prefix = String(seriesPrefix ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();

  if (prefix && value.startsWith(prefix)) {
    let remainder = value.slice(prefix.length).replace(/^[\s\-/_:：#]+/u, "").trim();
    const wrapped = remainder.match(/^[\[(（](.*)[\])）]$/u);
    if (wrapped) remainder = wrapped[1].trim();
    const remainderMatch = remainder.match(CHAPTER_REMAINDER_PATTERN);
    if (remainderMatch) return compactChapterLabel(remainderMatch[1]);
  }

  const match = value.match(CHAPTER_SUFFIX_PATTERN);
  return match ? compactChapterLabel(match[1]) : null;
}

export function formatBaselineLabel(watch = {}) {
  const aid = String(watch.baselineAid ?? "").trim() || "未知";
  if (watch.baselineKind === "global") return `aid ${aid}`;
  return extractChapterLabel(watch.baselineTitle, {
    seriesPrefix: watch.prefix || watch.titlePrefix || ""
  }) || `aid ${aid}`;
}

export function deriveComicName(title) {
  const value = String(title ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const withoutTags = value.replace(/(?:\s*\[[^\]\r\n]{1,80}\])+\s*$/gu, "").trim();
  const withoutChapter = withoutTags
    .replace(CHAPTER_SUFFIX_PATTERN, "")
    .replace(BARE_CHAPTER_SUFFIX_PATTERN, "")
    .trim();
  return withoutChapter || withoutTags || value || "一键下载";
}

function comicNameFor(watchItem) {
  return String(
    watchItem?.comicName ||
      watchItem?.name ||
      watchItem?.titlePrefix ||
      watchItem?.prefix ||
      "",
  ).trim();
}

export function createUpdateCandidates({
  albums = [],
  watchItems = [],
  existingRecords = [],
  detectedAt = new Date().toISOString(),
} = {}) {
  const existingAids = new Set(
    existingRecords.map((record) => String(record?.aid ?? "")),
  );
  const addedAids = new Set();
  const added = [];

  for (const album of albums) {
    const aid = String(album?.aid ?? extractAid(album?.url) ?? "");
    if (!aid || existingAids.has(aid) || addedAids.has(aid)) continue;

    const watchItem = findLongestPrefixMatch(album?.title, watchItems);
    if (!watchItem) continue;

    addedAids.add(aid);
    added.push({
      aid,
      watchId: watchItem.id ?? null,
      comicName: comicNameFor(watchItem),
      title: String(album.title ?? "").trim(),
      sourceUrl:
        album.url || `${WNACG_ORIGIN}/photos-index-aid-${aid}.html`,
      downloadPageUrl: `${WNACG_ORIGIN}/download-index-aid-${aid}.html`,
      status: UPDATE_STATUS.PENDING,
      selected: true,
      detectedAt,
      error: null,
    });
  }

  return {
    records: [...existingRecords, ...added],
    added,
  };
}

export function filterAlbumsAfterBaselines(albums = [], watchItems = []) {
  return albums.filter((album) => {
    const watchItem = findLongestPrefixMatch(album?.title, watchItems);
    if (!watchItem) return false;
    const aid = Number(album?.aid ?? extractAid(album?.url));
    const baselineAid = Number(watchItem?.baselineAid);
    return Number.isFinite(aid) && Number.isFinite(baselineAid) && aid > baselineAid;
  });
}

export function findReachedBaselineIds(albums = [], watchItems = []) {
  const aids = albums.map((album) => Number(album?.aid)).filter(Number.isFinite);
  if (aids.length === 0) return new Set();
  const oldestAid = Math.min(...aids);
  return new Set(
    watchItems
      .filter((watchItem) => Number(watchItem?.baselineAid) >= oldestAid)
      .map((watchItem) => watchItem.id),
  );
}

export function hasZipSignature(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function transitionUpdate(record, nextStatus, patch = {}) {
  if (!record || typeof record !== "object") {
    throw new TypeError("更新记录必须是对象。");
  }
  if (!Object.values(UPDATE_STATUS).includes(nextStatus)) {
    throw new TypeError(`未知更新状态：${nextStatus}`);
  }

  const currentStatus = record.status ?? UPDATE_STATUS.PENDING;
  if (currentStatus === nextStatus) return { ...record, ...patch };
  if (!STATUS_TRANSITIONS[currentStatus]?.has(nextStatus)) {
    throw new Error(`不允许从 ${currentStatus} 切换到 ${nextStatus}。`);
  }

  const nextRecord = { ...record, ...patch, status: nextStatus };
  if (
    nextStatus === UPDATE_STATUS.DOWNLOADING ||
    nextStatus === UPDATE_STATUS.DOWNLOADED
  ) {
    nextRecord.error = null;
  }
  if (
    nextStatus === UPDATE_STATUS.DOWNLOADING ||
    nextStatus === UPDATE_STATUS.DOWNLOADED ||
    nextStatus === UPDATE_STATUS.IGNORED
  ) {
    nextRecord.selected = false;
  }
  if (nextStatus === UPDATE_STATUS.FAILED) {
    nextRecord.selected = true;
  }
  return nextRecord;
}
