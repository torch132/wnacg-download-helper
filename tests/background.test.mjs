import assert from "node:assert/strict";
import { test } from "node:test";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function downloadPage(aid, title = `测试漫画 ${aid}話`) {
  return `<!doctype html><title>${title}.zip 下載 - 紳士漫畫</title>
    <a class="ads" href="https://dl1.wn01.download/test-${aid}.zip">备用下载</a>`;
}

function createEnvironment({
  localState,
  initialDownloads = new Map(),
  fetchGate,
  pageTitle,
  redirectUrl,
  downloadError
} = {}) {
  let local = {
    wnacgStateV1: localState || {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [],
      activity: [],
      lastScanAt: null
    }
  };
  let session = {};
  let messageListener;
  let changedListener;
  let determiningFilenameListener;
  let downloadCalls = 0;
  const sentMessages = [];
  const downloads = new Map(initialDownloads);
  const downloadOptions = [];
  const fetchUrls = [];

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(local),
        set: async (value) => {
          local = { ...local, ...structuredClone(value) };
        }
      },
      session: {
        get: async () => structuredClone(session),
        set: async (value) => {
          session = { ...session, ...structuredClone(value) };
        }
      }
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    downloads: {
      async download(options) {
        if (downloadError) throw downloadError;
        downloadCalls += 1;
        downloadOptions.push(structuredClone(options));
        const id = 900 + downloadCalls;
        const item = {
          id,
          state: "in_progress",
          url: options.url,
          finalUrl: redirectUrl || options.url,
          filename: `/Users/tester/Downloads/server-name-${id}.zip`,
          mime: "application/zip",
          fileSize: 32,
          exists: true
        };
        let suggestion = null;
        determiningFilenameListener?.(structuredClone(item), (value) => {
          suggestion = value;
        });
        if (suggestion?.filename) {
          item.filename = `/Users/tester/Downloads/${suggestion.filename}`;
        }
        downloads.set(id, item);
        return id;
      },
      async search({ id }) {
        const item = downloads.get(id);
        return item ? [structuredClone(item)] : [];
      },
      async removeFile(id) {
        const item = downloads.get(id);
        if (item) item.exists = false;
      },
      onDeterminingFilename: {
        addListener(listener) {
          determiningFilenameListener = listener;
        }
      },
      onChanged: {
        addListener(listener) {
          changedListener = listener;
        }
      }
    },
    tabs: {
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message: structuredClone(message) });
      }
    }
  };

  globalThis.fetch = async (url) => {
    fetchUrls.push(String(url));
    const aid = String(url).match(/(\d+)(?:\.html|\.zip)$/u)?.[1] || "0";
    if (String(url).includes("download-index")) {
      if (fetchGate) await fetchGate.promise;
      return {
        ok: true,
        text: async () => downloadPage(aid, pageTitle || `测试漫画 ${aid}話`)
      };
    }
    throw new Error(`不应由 fetch 预请求 ZIP：${url}`);
  };

  return {
    downloads,
    downloadOptions,
    fetchUrls,
    sentMessages,
    get downloadCalls() {
      return downloadCalls;
    },
    get local() {
      return local;
    },
    get session() {
      return session;
    },
    async send(
      aid,
      tabId,
      url = "https://www.wnacg.com/albums-index.html",
      title = `测试漫画 ${aid}話`
    ) {
      return new Promise((resolve) => {
        const keepAlive = messageListener(
          { type: "WNACG_QUICK_DOWNLOAD", aid: String(aid), title },
          { tab: { id: tabId, url } },
          resolve
        );
        assert.equal(keepAlive, true);
      });
    },
    change(delta) {
      changedListener(delta);
    }
  };
}

async function importBackground(label) {
  await import(new URL(`../background.js?test=${label}-${Date.now()}-${Math.random()}`, import.meta.url));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("同一 aid 的并发点击只创建一次下载并通知全部标签", async () => {
  const gate = deferred();
  const env = createEnvironment({
    fetchGate: gate,
    localState: {
      version: 1,
      watches: [],
      updates: [{
        aid: "386225",
        title: "测试漫画 386225話",
        status: "pending",
        selected: true,
        detectedAt: "2026-09-20T00:00:00.000Z"
      }],
      quickDownloads: [],
      activity: [],
      lastScanAt: null
    }
  });
  await importBackground("concurrent");

  const first = env.send("386225", 11);
  const second = env.send("386225", 22);
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(env.downloadCalls, 1);
  assert.deepEqual(env.fetchUrls, [
    "https://www.wnacg.com/download-index-aid-386225.html"
  ]);
  assert.equal(
    env.downloadOptions[0].filename,
    "测试漫画/测试漫画 386225話.zip"
  );
  assert.equal(firstResult.state, "downloading");
  assert.equal(secondResult.state, "downloading");
  const [downloadId] = env.downloads.keys();
  assert.equal(
    env.downloads.get(downloadId).filename,
    "/Users/tester/Downloads/测试漫画/测试漫画 386225話.zip"
  );
  env.downloads.get(downloadId).state = "complete";
  env.change({ id: downloadId, state: { current: "complete" } });
  await waitFor(() => env.sentMessages.length === 2, "两个标签都应收到完成通知");
  assert.deepEqual(env.sentMessages.map((item) => item.tabId).sort(), [11, 22]);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].status, "downloaded");
  assert.equal(env.local.wnacgStateV1.updates[0].status, "downloaded");
  assert.equal(env.local.wnacgStateV1.updates[0].downloadMethod, "quick");
});

test("长标题按完整路径预算并优先使用列表标题作为目录名", async () => {
  const pageTitle = `${"服务器拼接标题 ".repeat(80)}1~6 [中国翻訳] [無修正] [DL版]`;
  const requestTitle = "[陸の孤島亭 (しゃよー)] 桜春女学院の男優 1~6 [中国翻訳] [無修正] [DL版]";
  const env = createEnvironment({ pageTitle });
  await importBackground("long-title-path");

  const result = await env.send("386240", 51, undefined, requestTitle);
  assert.equal(result.state, "downloading");
  const relativePath = env.downloadOptions[0].filename;
  assert.ok(new TextEncoder().encode(relativePath).byteLength <= 240);
  assert.match(relativePath, /^\[陸の孤島亭 \(しゃよー\)\] 桜春女学院の男優\//u);
  assert.match(relativePath, /\/\[陸の孤島亭 \(しゃよー\)\] 桜春女学院の男優 1~6 \[中国翻訳\] \[無修正\] \[DL版\]\.zip$/u);
  assert.doesNotMatch(relativePath, /服务器拼接标题/u);
  assert.ok(Object.values(env.session.wnacgFilenamePaths || {}).includes(relativePath));
});

test("重定向后仍强制使用目标相对路径", async () => {
  const env = createEnvironment({
    redirectUrl: "https://dl2.wn01.download/redirected-file.zip"
  });
  await importBackground("redirect-filename");

  const result = await env.send("386241", 52);
  assert.equal(result.state, "downloading");
  assert.equal(
    env.downloads.get(result.downloadId).filename,
    "/Users/tester/Downloads/测试漫画/测试漫画 386241話.zip"
  );
});

test("同名文件的 Chrome 冲突后缀仍视为成功", async () => {
  const env = createEnvironment();
  await importBackground("uniquified-filename");

  const result = await env.send("386242", 53);
  const item = env.downloads.get(result.downloadId);
  item.filename = "/Users/tester/Downloads/测试漫画/测试漫画 386242話 (1).zip";
  item.state = "complete";
  env.change({ id: result.downloadId, state: { current: "complete" } });

  await waitFor(
    () => env.local.wnacgStateV1.quickDownloads[0]?.status === "downloaded",
    "Chrome 的同名冲突后缀应保持 downloaded 状态"
  );
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].status, "downloaded");
});

test("Invalid filename 会转换为可恢复的中文提示", async () => {
  const env = createEnvironment({ downloadError: new Error("Invalid filename") });
  await importBackground("invalid-filename");

  const result = await env.send("386243", 54);
  assert.equal(result.ok, false);
  assert.match(result.message, /文件名仍不符合 Chrome 要求/);
  assert.deepEqual(env.session.wnacgFilenamePaths || {}, {});
});

test("外置目录已下载不会阻止 Downloads 一键下载", async () => {
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [],
      updates: [{ aid: "386231", status: "downloaded", filePath: "外置目录/旧文件.zip" }],
      quickDownloads: [],
      activity: [],
      lastScanAt: null
    }
  });
  await importBackground("managed-isolation");

  const result = await env.send("386231", 47);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
});

test("旧记录保存到错误根路径时允许按新目录结构重新下载", async () => {
  const oldId = 700;
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [{
        aid: "386232",
        title: "测试漫画 386232話",
        comicName: "测试漫画",
        relativePath: "测试漫画/测试漫画 386232話.zip",
        actualFilePath: "/Users/tester/Downloads/测试漫画 386232話.zip",
        status: "downloaded",
        downloadId: oldId
      }],
      activity: [],
      lastScanAt: null
    },
    initialDownloads: new Map([[oldId, {
      id: oldId,
      state: "complete",
      url: "https://dl1.wn01.download/old.zip",
      finalUrl: "https://dl1.wn01.download/old.zip",
      filename: "/Users/tester/Downloads/测试漫画 386232話.zip",
      mime: "application/zip",
      fileSize: 10,
      exists: true
    }]])
  });
  await importBackground("wrong-root-redownload");

  const result = await env.send("386232", 48);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  const newItem = env.downloads.get(901);
  assert.equal(
    newItem.filename,
    "/Users/tester/Downloads/测试漫画/测试漫画 386232話.zip"
  );
});

test("服务器失败会提示可能的 503 并清理残留文件", async () => {
  const env = createEnvironment();
  await importBackground("server-failed-cleanup");

  const result = await env.send("386233", 49);
  const item = env.downloads.get(result.downloadId);
  item.state = "interrupted";
  item.error = "SERVER_FAILED";
  item.filename = "/Users/tester/Downloads/server-error.html";
  item.mime = "text/html";
  env.change({
    id: result.downloadId,
    state: { current: "interrupted" },
    error: { current: "SERVER_FAILED" }
  });

  await waitFor(
    () => env.local.wnacgStateV1.quickDownloads[0]?.status === "failed",
    "服务器失败应收敛为 failed"
  );
  assert.equal(item.exists, false);
  assert.match(env.local.wnacgStateV1.quickDownloads[0].error, /HTTP 503/);
  assert.match(env.sentMessages.at(-1).message.message, /HTTP 503/);
});

test("极快完成时请求直接返回 complete 而不是重新覆盖为 downloading", async () => {
  const env = createEnvironment();
  const originalDownload = chrome.downloads.download;
  chrome.downloads.download = async (options) => {
    const id = await originalDownload(options);
    env.downloads.get(id).state = "complete";
    return id;
  };
  await importBackground("fast-complete");

  const result = await env.send("386226", 33);
  assert.equal(result.ok, true);
  assert.equal(result.state, "complete");
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].status, "downloaded");
});

test("浏览器重启后从本地记录恢复并收敛已完成下载", async () => {
  const downloadId = 777;
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [{
        aid: "386227",
        title: "测试漫画 386227話",
        comicName: "测试漫画",
        relativePath: "测试漫画/测试漫画 386227話.zip",
        status: "downloading",
        downloadId,
        startedAt: "2026-09-20T00:00:00.000Z"
      }],
      activity: [],
      lastScanAt: null
    },
    initialDownloads: new Map([[downloadId, {
      id: downloadId,
      state: "complete",
      url: "https://dl1.wn01.download/test-386227.zip",
      finalUrl: "https://dl1.wn01.download/test-386227.zip",
      filename: "/Users/tester/Downloads/测试漫画/测试漫画 386227話.zip",
      mime: "application/zip",
      fileSize: 64
    }]])
  });
  await importBackground("recovery");

  await waitFor(
    () => env.local.wnacgStateV1.quickDownloads[0].status === "downloaded",
    "恢复流程应把已完成任务标记为 downloaded"
  );
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].actualFilePath,
    "/Users/tester/Downloads/测试漫画/测试漫画 386227話.zip");
});

test("精确主页允许一键下载，但详情页与伪造主机仍被拒绝", async () => {
  const env = createEnvironment();
  await importBackground("homepage-source");

  const homepage = await env.send("386228", 44, "https://www.wnacg.com/?from=test#latest");
  assert.equal(homepage.ok, true);
  assert.equal(homepage.state, "downloading");
  assert.equal(env.downloadCalls, 1);

  const detail = await env.send(
    "386229",
    45,
    "https://www.wnacg.com/photos-index-aid-386229.html"
  );
  const forged = await env.send("386230", 46, "https://www.wnacg.com.evil.test/");
  assert.equal(detail.ok, false);
  assert.equal(forged.ok, false);
  assert.equal(env.downloadCalls, 1);
});
