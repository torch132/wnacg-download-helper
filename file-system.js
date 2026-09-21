import { hasZipSignature, sanitizeFileName } from "./core.js";

const DB_NAME = "wnacg-directory-access";
const STORE_NAME = "handles";
const ROOT_KEY = "download-root";

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

export async function chooseDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前 Chrome 不支持目录授权，请升级桌面版 Chrome。");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await withStore("readwrite", (store) => store.put(handle, ROOT_KEY));
  return handle;
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
