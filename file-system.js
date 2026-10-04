import {
  extractChapterLabel,
  hasZipSignature,
  normalizeTitle,
  parseUncensoredVersion,
  sanitizeFileName,
  truncateUtf8
} from "./core.js";

const DB_NAME = "wnacg-directory-access";
const STORE_NAME = "handles";
const ROOT_KEY = "download-root";
const LIBRARY_KEY = "comic-library-root";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function getDirectoryHandle() {
  return withStore("readonly", (store) => store.get(ROOT_KEY));
}

export async function getLibraryDirectoryHandle() {
  return withStore("readonly", (store) => store.get(LIBRARY_KEY));
}

export async function chooseDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前 Chrome 不支持目录授权，请升级桌面版 Chrome。");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await withStore("readwrite", (store) => store.put(handle, ROOT_KEY));
  return handle;
}

export async function chooseLibraryDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前 Chrome 不支持目录授权，请升级桌面版 Chrome。");
  }
  // 漫画库仅用于查重；选择和后续权限均为只读，不得创建或修改文件。
  const handle = await window.showDirectoryPicker({ mode: "read" });
  await withStore("readwrite", (store) => store.put(handle, LIBRARY_KEY));
  return handle;
}

export async function queryLibraryPermission(handle) {
  if (!handle) return "missing";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "unavailable";
  }
}

export async function ensureLibraryPermission(handle, request = false) {
  if (!handle) return false;
  const current = await queryLibraryPermission(handle);
  if (current === "granted") return true;
  if (request && current === "prompt") {
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  }
  return false;
}

export async function ensureLibraryWritePermission(handle, request = false) {
  if (!handle) return false;
  try {
    const options = { mode: "readwrite" };
    const current = await handle.queryPermission(options);
    if (current === "granted") return true;
    return Boolean(request && current === "prompt" &&
      await handle.requestPermission(options) === "granted");
  } catch {
    return false;
  }
}

function normalizedArchiveStem(fileName) {
  return normalizeTitle(String(fileName).replace(/\.zip$/iu, ""))
    .replace(/ \(\d+\)$/u, "");
}

function normalizeChapterIdentity(label) {
  return normalizeTitle(label).replace(/^第/u, "").replace(/話/gu, "话").replace(/巻/gu, "卷");
}

function chapterIdentity(title, comicName) {
  const { text: withoutMarker, uncensored } = parseUncensoredVersion(title, comicName);
  // 除无修正外，其他版本标签仍必须逐字一致。
  const tags = withoutMarker.match(/(?:\s*\[[^\]]+\])+$/u)?.[0] || "";
  const withoutTags = tags ? withoutMarker.slice(0, -tags.length).trim() : withoutMarker;
  return {
    label: normalizeChapterIdentity(
      extractChapterLabel(withoutTags, { seriesPrefix: comicName }) || ""
    ),
    tags: tags.replace(/\s+/gu, ""),
    uncensored
  };
}

function aidFromArchiveStem(stem) {
  return stem.match(/(?:^wnacg-|\[aid-)(\d+)(?:-\d+)?\]?$/iu)?.[1] || null;
}

/**
 * 只读取授权漫画库的第一层漫画文件夹及其中 ZIP；不进入子目录、不写入文件。
 * 返回 Map<漫画名, Array<{fileName, relativePath, size, stem, aid, chapter}>>。
 */
export async function scanLocalArchiveIndex(rootHandle, comicNames = [], source = "library") {
  if (!rootHandle) throw new Error("尚未选择本地漫画库目录。");
  const index = new Map();
  for (const comicName of new Set(comicNames.map((name) => String(name).trim()).filter(Boolean))) {
    const folderNames = [...new Set([
      sanitizeFileName(comicName),
      truncateUtf8(sanitizeFileName(comicName), 80)
    ])];
    const archives = [];
    for (const folderName of folderNames) {
      let folder;
      try {
        folder = await rootHandle.getDirectoryHandle(folderName, { create: false });
      } catch (error) {
        if (error?.name === "NotFoundError") continue;
        throw error;
      }
      for await (const handle of folder.values()) {
        if (handle.kind !== "file" || !/\.zip$/iu.test(handle.name)) continue;
        const file = await handle.getFile();
        if (file.size < 4) continue;
        const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        if (!hasZipSignature(signature) || signature[2] !== 0x03 || signature[3] !== 0x04) {
          continue;
        }
        const stem = normalizedArchiveStem(handle.name);
        archives.push({
          fileName: handle.name,
          relativePath: `${folderName}/${handle.name}`,
          size: file.size,
          lastModified: file.lastModified,
          source,
          stem,
          aid: aidFromArchiveStem(stem),
          chapter: chapterIdentity(stem, comicName)
        });
      }
    }
    index.set(comicName, archives);
  }
  return index;
}

/** 精确标题优先，随后是文件名中的 aid，最后才使用唯一且版本一致的话数。 */
export function findLocalArchive(index, comicName, title, aid) {
  const archives = index?.get?.(String(comicName).trim()) || [];
  const titleStem = normalizedArchiveStem(sanitizeFileName(title));
  const exact = archives.find((archive) => archive.stem === titleStem);
  if (exact) return { ...exact, matchKind: "title" };

  const strongAid = String(aid ?? "").trim();
  const chapter = chapterIdentity(title, comicName);
  if (/^\d+$/u.test(strongAid)) {
    const aidMatch = archives.find((archive) => archive.aid === strongAid &&
      (!chapter.uncensored || archive.chapter.uncensored));
    if (aidMatch) return { ...aidMatch, matchKind: "aid" };
  }

  if (!chapter.label) return null;
  const matches = archives.filter((archive) =>
    archive.chapter.label === chapter.label && archive.chapter.tags === chapter.tags &&
    archive.chapter.uncensored === chapter.uncensored
  );
  return matches.length === 1 ? { ...matches[0], matchKind: "chapter" } : null;
}

export function findUncensoredReplacement(index, comicName, title) {
  const target = chapterIdentity(title, comicName);
  if (!target.uncensored || !target.label) return null;
  const matches = (index?.get?.(String(comicName).trim()) || []).filter((archive) =>
    archive.chapter.label === target.label && archive.chapter.tags === target.tags &&
    !archive.chapter.uncensored && !archive.aid
  );
  return matches.length === 1 ? { ...matches[0], matchKind: "replacement" } : null;
}

export async function removeLocalArchive(rootHandle, archive) {
  if (!rootHandle || !archive || !Number.isInteger(archive.size)) {
    throw new Error("无法确认待替换的本地 ZIP。");
  }
  const [folderName, fileName, ...extra] = String(archive.relativePath || "").split("/");
  if (extra.length || !folderName || fileName !== archive.fileName ||
      !/\.zip$/iu.test(fileName)) {
    throw new Error("待替换 ZIP 路径无效，已取消删除。");
  }
  const directory = await rootHandle.getDirectoryHandle(folderName, { create: false });
  const handle = await directory.getFileHandle(fileName, { create: false });
  const file = await handle.getFile();
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (file.size !== archive.size ||
      (Number.isFinite(archive.lastModified) && file.lastModified !== archive.lastModified) ||
      !hasZipSignature(signature) ||
      signature[2] !== 0x03 || signature[3] !== 0x04) {
    throw new Error("原 ZIP 已变化，已取消删除。");
  }
  await directory.removeEntry(fileName);
}

export async function queryDirectoryPermission(handle) {
  if (!handle) return "missing";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "unavailable";
  }
}

export async function ensureDirectoryPermission(handle, request = false) {
  if (!handle) return false;
  const current = await queryDirectoryPermission(handle);
  if (current === "granted") return true;
  if (request && current === "prompt") {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  }
  return false;
}

async function existingFileSize(directory, name) {
  try {
    const handle = await directory.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return file.size;
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function chooseAvailableName(directory, title, aid) {
  const base = sanitizeFileName(title).replace(/\.zip$/i, "") || `wnacg-${aid}`;
  const primary = `${base}.zip`;
  const primarySize = await existingFileSize(directory, primary);
  if (primarySize === null || primarySize === 0) return primary;

  const withAid = `${base} [aid-${aid}].zip`;
  const withAidSize = await existingFileSize(directory, withAid);
  if (withAidSize === null || withAidSize === 0) return withAid;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} [aid-${aid}-${index}].zip`;
    const candidateSize = await existingFileSize(directory, candidate);
    if (candidateSize === null || candidateSize === 0) return candidate;
  }
  throw new Error("无法生成不重复的文件名。");
}

export async function writeZipResponse({
  rootHandle,
  comicName,
  title,
  aid,
  response,
  onProgress
}) {
  if (!response.ok) {
    throw new Error(`ZIP 请求失败（HTTP ${response.status}）。`);
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !/(zip|octet-stream)/.test(contentType)) {
    throw new Error(`下载响应不是 ZIP 文件（${contentType}）。`);
  }
  if (!response.body) {
    throw new Error("浏览器未提供可读取的下载数据流。");
  }

  const reader = response.body.getReader();
  const firstRead = await reader.read();
  if (firstRead.done || !hasZipSignature(firstRead.value)) {
    reader.releaseLock();
    throw new Error("下载内容缺少 ZIP 文件头，已停止写入。");
  }

  const directoryName = sanitizeFileName(comicName) || `漫画-${aid}`;
  const comicDirectory = await rootHandle.getDirectoryHandle(directoryName, { create: true });
  const fileName = await chooseAvailableName(comicDirectory, title, aid);
  const fileHandle = await comicDirectory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  const total = Number(response.headers.get("content-length")) || 0;
  let written = 0;

  try {
    await writable.write(firstRead.value);
    written += firstRead.value.byteLength;
    onProgress?.({ written, total });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      onProgress?.({ written, total });
    }
    if (total && written !== total) {
      throw new Error(`ZIP 下载不完整：预期 ${total} 字节，实际 ${written} 字节。`);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    fileName,
    relativePath: `${directoryName}/${fileName}`,
    bytesWritten: written
  };
}

export async function writeZipReplacingArchive({ replacement, replacementRootHandle, ...download }) {
  const written = await writeZipResponse(download);
  if (!replacement) return { ...written, replacementCleanupError: null };
  try {
    await removeLocalArchive(replacementRootHandle, replacement);
    return { ...written, replacementCleanupError: null };
  } catch (error) {
    return { ...written, replacementCleanupError: error };
  }
}
