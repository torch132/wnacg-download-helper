import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const coreSource = await readFile(new URL("../core.js", import.meta.url), "utf8");
const coreUrl = `data:text/javascript;base64,${Buffer.from(coreSource).toString("base64")}`;
const fileSystemSource = (await readFile(new URL("../file-system.js", import.meta.url), "utf8"))
  .replace('from "./core.js"', `from "${coreUrl}"`);
const fileSystem = await import(
  `data:text/javascript;base64,${Buffer.from(fileSystemSource).toString("base64")}`
);

function zipFile(name, bytes = [0x50, 0x4b, 0x03, 0x04, 1]) {
  return {
    kind: "file",
    name,
    async getFile() {
      return {
        size: bytes.length,
        slice() {
          return { async arrayBuffer() { return Uint8Array.from(bytes).buffer; } };
        }
      };
    }
  };
}

function libraryFixture(folders) {
  const accesses = [];
  const root = {
    async getDirectoryHandle(name, options) {
      accesses.push({ name, options });
      if (!(name in folders)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      return {
        async *values() {
          for (const file of folders[name]) yield file;
        }
      };
    }
  };
  return { root, accesses };
}

test("本地索引只读取漫画子目录中的有效 ZIP，绝不创建或修改文件", async () => {
  const { root, accesses } = libraryFixture({
    "砲友滿屋": [
      zipFile("砲友滿屋 18-19話.zip"),
      zipFile("坏文件.zip", [1, 2, 3, 4]),
      zipFile("伪ZIP.zip", [0x50, 0x4b, 0x48, 0x54, 0x4d, 0x4c]),
      zipFile("空文件.zip", []),
      zipFile("说明.txt"),
      { kind: "directory", name: "子目录" }
    ]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["砲友滿屋", "不存在"]);
  assert.equal(index.get("砲友滿屋").length, 1);
  assert.equal(index.get("不存在").length, 0);
  assert.ok(accesses.every(({ options }) => options?.create === false));
  assert.equal(
    fileSystem.findLocalArchive(index, "砲友滿屋", "砲友滿屋 18-19話", "388404")?.relativePath,
    "砲友滿屋/砲友滿屋 18-19話.zip"
  );
});

test("合集标题简化后可按唯一话数匹配旧独立话，但不混淆版本", async () => {
  const { root } = libraryFixture({
    "砲友滿屋": [
      zipFile("砲友滿屋 18-19話.zip"),
      zipFile("砲友滿屋 20-21話 [DL版].zip")
    ]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["砲友滿屋"]);
  assert.equal(
    fileSystem.findLocalArchive(index, "砲友滿屋", "18-19話", "388404")?.matchKind,
    "chapter"
  );
  assert.equal(fileSystem.findLocalArchive(index, "砲友滿屋", "20-21話", "388405"), null);
  assert.equal(
    fileSystem.findLocalArchive(index, "砲友滿屋", "20-21話 [DL版]", "388405")?.matchKind,
    "chapter"
  );
});

test("无修正版只替换唯一同话数普通版，保留其他版本标签", async () => {
  const { root } = libraryFixture({
    "作品": [
      zipFile("作品 33-55話.zip"),
      zipFile("作品 33-55話 [DL版].zip"),
      zipFile("作品 56話.zip")
    ]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  const replacement = fileSystem.findUncensoredReplacement(index, "作品", "作品 33-55話 [無修正]");
  assert.equal(replacement?.relativePath, "作品/作品 33-55話.zip");
  assert.equal(replacement?.source, "library");
  assert.equal(fileSystem.findLocalArchive(index, "作品", "作品 33-55話 [無修正]", "123"), null);
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 33-55話 [DL版][无修正]")?.fileName,
    "作品 33-55話 [DL版].zip", "DL 标签相同才可替换");
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 33-55話 [中国翻訳][无修正]"),
    null, "其他标签不同不可互换");
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 33-54話 [无修正]"),
    null, "区间话数必须完全一致");
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 56話 無修正" )?.fileName,
    "作品 56話.zip");
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 56話無修正" )?.fileName,
    "作品 56話.zip");
});

test("同话数普通版有两个候选或仅 aid 文件名时不自动删除", async () => {
  const { root } = libraryFixture({
    "作品": [zipFile("作品 33-55話.zip"), zipFile("33-55話.zip"), zipFile("wnacg-123.zip")]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  assert.equal(fileSystem.findUncensoredReplacement(index, "作品", "作品 33-55話 [無修正]"), null);
  assert.equal(fileSystem.findLocalArchive(index, "作品", "作品 33-55話 [無修正]", "123"), null,
    "同 aid 但版本未知时不能当成无修正版已下载");
});

test("替换候选保留授权根目录来源，双根同名时不猜测删除目标", async () => {
  const { root } = libraryFixture({ "作品": [zipFile("作品 33-55話.zip")] });
  const saveIndex = await fileSystem.scanLocalArchiveIndex(root, ["作品"], "save");
  assert.equal(fileSystem.findUncensoredReplacement(
    saveIndex, "作品", "作品 33-55話 [無修正]"
  )?.source, "save");
  const libraryIndex = await fileSystem.scanLocalArchiveIndex(root, ["作品"], "library");
  saveIndex.set("作品", [...saveIndex.get("作品"), ...libraryIndex.get("作品")]);
  assert.equal(fileSystem.findUncensoredReplacement(
    saveIndex, "作品", "作品 33-55話 [無修正]"
  ), null, "两个授权根目录均有旧 ZIP 时必须停止自动删除");
});

test("新版 ZIP 写入成功后仅删除原 ZIP；下载不完整或源文件变化均保留原件", async () => {
  const files = new Map([["作品 33-55話.zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1])]]);
  const removed = [];
  const directory = {
    async *values() {
      for (const [name, bytes] of files) yield zipFile(name, [...bytes]);
    },
    async getFileHandle(name, options) {
      if (!files.has(name) && !options?.create) {
        throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
      if (!files.has(name)) files.set(name, new Uint8Array());
      return {
        async getFile() {
          const bytes = files.get(name);
          return { size: bytes.length, slice() {
            return { async arrayBuffer() { return bytes.buffer; } };
          } };
        },
        async createWritable() {
          let chunks = [];
          return {
            async write(value) { chunks.push(Uint8Array.from(value)); },
            async close() { files.set(name, Uint8Array.from(chunks.flatMap((part) => [...part]))); },
            async abort() { chunks = []; }
          };
        }
      };
    },
    async removeEntry(name) { removed.push(name); files.delete(name); }
  };
  const root = { async getDirectoryHandle(name) {
    assert.equal(name, "作品");
    return directory;
  } };
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  const old = fileSystem.findUncensoredReplacement(index, "作品", "作品 33-55話 [無修正]");
  const makeResponse = (bytes, expected) => ({
    ok: true,
    headers: { get(key) { return key === "content-type" ? "application/zip"
      : key === "content-length" ? String(expected) : null; } },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    } })
  });
  await assert.rejects(fileSystem.writeZipReplacingArchive({
    rootHandle: root, comicName: "作品", title: "作品 33-55話 [無修正]",
    aid: "123", response: makeResponse([0x50, 0x4b, 0x03, 0x04, 2], 6),
    replacement: old, replacementRootHandle: root
  }), /不完整/);
  assert.ok(files.has(old.fileName));
  assert.deepEqual(removed, []);

  files.set(old.fileName, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
  const written = await fileSystem.writeZipReplacingArchive({
    rootHandle: root, comicName: "作品", title: "作品 33-55話 [無修正]",
    aid: "123", response: makeResponse([0x50, 0x4b, 0x03, 0x04, 2], 5),
    replacement: old, replacementRootHandle: root
  });
  assert.match(written.replacementCleanupError.message, /已变化/);
  assert.ok(files.has(old.fileName), "旧文件在下载或安全核验失败时必须保留");
  assert.ok(files.has(written.fileName));
  files.set(old.fileName, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  await assert.rejects(fileSystem.removeLocalArchive(root, { ...old, lastModified: 123 }),
    /已变化/, "同尺寸但修改时间变化也不能删除");
  const replaced = await fileSystem.writeZipReplacingArchive({
    rootHandle: root, comicName: "作品", title: "作品 33-55話 [無修正]",
    aid: "123", response: makeResponse([0x50, 0x4b, 0x03, 0x04, 3], 5),
    replacement: old, replacementRootHandle: root
  });
  assert.equal(replaced.replacementCleanupError, null);
  assert.deepEqual(removed, ["作品 33-55話.zip"]);
  assert.ok(files.has(written.fileName));
  assert.ok(files.has(replaced.fileName));
});

test("aid 文件名可直接查重；有多个同话数版本时不猜测", async () => {
  const { root } = libraryFixture({
    "作品": [
      zipFile("wnacg-388404.zip"),
      zipFile("作品 18-19話.zip"),
      zipFile("18-19話.zip")
    ]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  assert.equal(fileSystem.findLocalArchive(index, "作品", "未知章节", "388404")?.matchKind, "aid");
  assert.equal(fileSystem.findLocalArchive(index, "作品", "18-19話", "999999")?.matchKind, "title");
  assert.equal(fileSystem.findLocalArchive(index, "作品", "作品 18-19話", "999999")?.matchKind, "title");
});

test("只凭话数遇到多个候选时不判为已下载", async () => {
  const { root } = libraryFixture({
    "作品": [zipFile("作品 18-19話.zip"), zipFile("其他标题 18-19話.zip")]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  assert.equal(fileSystem.findLocalArchive(index, "作品", "18-19話", "999999"), null);
});

test("Chrome 同名编号与第字前缀可对应已存在 ZIP", async () => {
  const { root } = libraryFixture({
    "作品": [zipFile("作品 第18-19話 (1).zip")]
  });
  const index = await fileSystem.scanLocalArchiveIndex(root, ["作品"]);
  assert.equal(
    fileSystem.findLocalArchive(index, "作品", "作品 第18-19話", "999999")?.matchKind,
    "title"
  );
  assert.equal(
    fileSystem.findLocalArchive(index, "作品", "18-19话", "999999")?.matchKind,
    "chapter"
  );
});

test("扫描目录权限失效时传播错误，不把漫画库误判为空", async () => {
  const root = {
    async getDirectoryHandle() {
      throw Object.assign(new Error("权限失效"), { name: "NotAllowedError" });
    }
  };
  await assert.rejects(
    fileSystem.scanLocalArchiveIndex(root, ["作品"]),
    { name: "NotAllowedError" }
  );
});

test("漫画库句柄独立保存，并且只请求 read 权限", async () => {
  const originalWindow = globalThis.window;
  const originalIndexedDB = globalThis.indexedDB;
  const stored = new Map();
  const database = {
    objectStoreNames: { contains: () => true },
    transaction() {
      return {
        objectStore() {
          return {
            get(key) {
              const request = { result: stored.get(key) };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
            put(value, key) {
              stored.set(key, value);
              const request = { result: key };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            }
          };
        }
      };
    },
    close() {}
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };
  const modes = [];
  const libraryHandle = {
    name: "Downloads",
    async queryPermission(options) { modes.push(options.mode); return "prompt"; },
    async requestPermission(options) { modes.push(options.mode); return "granted"; }
  };
  globalThis.window = {
    async showDirectoryPicker(options) {
      modes.push(options.mode);
      return libraryHandle;
    }
  };
  try {
    stored.set("download-root", { name: "原下载目录" });
    assert.equal(await fileSystem.chooseLibraryDirectory(), libraryHandle);
    assert.equal(await fileSystem.getLibraryDirectoryHandle(), libraryHandle);
    assert.equal((await fileSystem.getDirectoryHandle()).name, "原下载目录");
    assert.equal(await fileSystem.queryLibraryPermission(libraryHandle), "prompt");
    assert.equal(await fileSystem.ensureLibraryPermission(libraryHandle, true), true);
    assert.deepEqual(modes, ["read", "read", "read", "read"]);
  } finally {
    globalThis.window = originalWindow;
    globalThis.indexedDB = originalIndexedDB;
  }
});

test("替换旧 ZIP 时单独请求漫画库写入权限，拒绝时不允许删除", async () => {
  const modes = [];
  const handle = {
    async queryPermission(options) {
      modes.push(`query:${options.mode}`);
      return "prompt";
    },
    async requestPermission(options) {
      modes.push(`request:${options.mode}`);
      return "denied";
    }
  };
  assert.equal(await fileSystem.ensureLibraryWritePermission(handle, false), false);
  assert.equal(await fileSystem.ensureLibraryWritePermission(handle, true), false);
  assert.deepEqual(modes, ["query:readwrite", "query:readwrite", "request:readwrite"]);
});
