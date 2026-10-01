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
