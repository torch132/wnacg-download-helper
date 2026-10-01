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

function collectionDownloadPage({ sourceAid, items, total = items.length, limit = 30 }) {
  const rows = items.map((item, index) => `
    <div class="ch-row" data-key="down/${item.aid}/${item.aid}.zip">
      <a class="ch-info" href="/download-index-aid-${item.aid}.html?s=${sourceAid}" title="第${index + 1}話 ${item.title}">
        <span class="ch-name">${item.title}</span>
      </a>
      <a class="ch-dl ch-dl2" href="https://dl1.wn01.download/down/${item.aid}/${item.aid}.zip?n=${item.aid}">下載地址二</a>
    </div>`).join("");
  return `<div id="ch-wrap" data-sid="${sourceAid}" data-total="${total}" data-limit="${limit}">${rows}</div>`;
}

function createEnvironment({
  localState,
  initialDownloads = new Map(),
  fetchGate,
  pageTitle,
  redirectUrl,
  downloadError,
  collection,
  libraryFiles = null
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
  const sessionReadKeys = [];
  let messageListener;
  let changedListener;
  let determiningFilenameListener;
  let downloadCalls = 0;
  const downloadStartTimes = [];
  const sentMessages = [];
  const downloads = new Map(initialDownloads);
  const downloadOptions = [];
  const fetchUrls = [];
  const sidePanelCalls = [];
  let libraryPermissionQueries = 0;

  delete globalThis.indexedDB;
  if (libraryFiles) {
    const directory = {
      async *values() {
        for (const name of libraryFiles.files) {
          yield {
            kind: "file", name,
            async getFile() {
              const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]);
              return { size: bytes.length, slice() {
                return { async arrayBuffer() { return bytes.buffer; } };
              } };
            }
          };
        }
      }
    };
    const handle = {
      async queryPermission() {
        libraryPermissionQueries += 1;
        return libraryFiles.permission || "granted";
      },
      async getDirectoryHandle(name) {
        if (name === libraryFiles.comicName) return directory;
        throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
    };
    const database = {
      transaction() { return { objectStore() { return {
        get(key) {
          const request = { result: key === "comic-library-root" ? handle : null };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        }
      }; } }; },
      close() {}
    };
    globalThis.indexedDB = { open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } };
  }

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(local),
        set: async (value) => {
          local = { ...local, ...structuredClone(value) };
        }
      },
      session: {
        get: async (key) => {
          sessionReadKeys.push(key);
          return structuredClone(session);
        },
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
    sidePanel: {
      async setPanelBehavior(options) {
        sidePanelCalls.push(structuredClone(options));
      }
    },
    downloads: {
      async download(options) {
        downloadCalls += 1;
        downloadStartTimes.push(Date.now());
        downloadOptions.push(structuredClone(options));
        const currentError = typeof downloadError === "function"
          ? downloadError(downloadCalls)
          : downloadError;
        if (currentError) throw currentError;
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
    if (String(url).includes("act=chapters")) {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      const payload = collection?.pages?.[page] || {
        code: 0,
        list: [],
        total: collection?.total || 0,
        page,
        limit: collection?.limit || 30
      };
      return { ok: true, text: async () => JSON.stringify(payload) };
    }
    if (String(url).includes("download-index")) {
      if (fetchGate) await fetchGate.promise;
      return {
        ok: true,
        text: async () => collection && aid === String(collection.sourceAid)
          ? collection.pageHtml ?? collectionDownloadPage(collection)
          : downloadPage(aid, pageTitle || `测试漫画 ${aid}話`)
      };
    }
    throw new Error(`不应由 fetch 预请求 ZIP：${url}`);
  };

  return {
    downloads,
    downloadOptions,
    downloadStartTimes,
    sessionReadKeys,
    fetchUrls,
    sentMessages,
    sidePanelCalls,
    get downloadCalls() {
      return downloadCalls;
    },
    get local() {
      return local;
    },
    get session() {
      return session;
    },
    get libraryPermissionQueries() {
      return libraryPermissionQueries;
    },
    async send(
      aid,
      tabId,
      url = "https://www.wnacg.com/albums-index.html",
      title = `测试漫画 ${aid}話`,
      isCollection = false
    ) {
      return new Promise((resolve) => {
        const keepAlive = messageListener(
          { type: "WNACG_QUICK_DOWNLOAD", aid: String(aid), title, isCollection },
          { tab: { id: tabId, url } },
          resolve
        );
        assert.equal(keepAlive, true);
      });
    },
    async states(aids, tabId = 1) {
      return new Promise((resolve) => {
        const keepAlive = messageListener(
          { type: "WNACG_QUICK_DOWNLOAD_STATES", aids },
          { tab: { id: tabId, url: "https://www.wnacg.com/albums-index.html" } },
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
  assert.deepEqual(env.sidePanelCalls, [{ openPanelOnActionClick: true }]);
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

test("不同标签页的普通漫画下载不互相等待一秒", async () => {
  const env = createEnvironment();
  await importBackground("global-download-start-spacing");
  const [first, second] = await Promise.all([
    env.send("386229", 21),
    env.send("386230", 22)
  ]);
  assert.equal(first.state, "downloading");
  assert.equal(second.state, "downloading");
  assert.equal(env.downloadCalls, 2);
  assert.ok(env.downloadStartTimes[1] - env.downloadStartTimes[0] < 500,
    "普通漫画不应受合集子话的间隔影响");
});

test("合集只间隔自身子话，不阻挡另一个普通漫画按钮", async () => {
  const sourceAid = "390900";
  const env = createEnvironment({
    collection: {
      sourceAid,
      items: [
        { aid: "390901", title: "独立合集 1話" },
        { aid: "390902", title: "独立合集 2話" }
      ],
      total: 2,
      limit: 30
    }
  });
  await importBackground("collection-local-spacing-only");
  const [collectionResult, singleResult] = await Promise.all([
    env.send(sourceAid, 24, undefined, "独立合集", true),
    env.send("386234", 25)
  ]);
  assert.equal(collectionResult.state, "downloading");
  assert.equal(singleResult.state, "downloading");
  const firstChapter = env.downloadOptions.findIndex((item) => item.url.includes("/390901/"));
  const secondChapter = env.downloadOptions.findIndex((item) => item.url.includes("/390902/"));
  const ordinary = env.downloadOptions.findIndex((item) => item.url.includes("test-386234.zip"));
  assert.ok([firstChapter, secondChapter, ordinary].every((index) => index >= 0));
  assert.ok(Math.abs(env.downloadStartTimes[ordinary] - env.downloadStartTimes[firstChapter]) < 500,
    "普通漫画应与合集第一话独立启动");
  assert.ok(env.downloadStartTimes[secondChapter] - env.downloadStartTimes[firstChapter] >= 1_000,
    "合集第二话须与第一话至少间隔一秒");
});

test("旧版 session 全局时间戳不再阻挡普通漫画下载", async () => {
  const env = createEnvironment();
  env.session.wnacgNextDownloadStartAt = Date.now() + 30_000;
  await importBackground("restored-download-start-spacing");
  const result = await env.send("386233", 23);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.ok(!env.sessionReadKeys.includes("wnacgNextDownloadStartAt"),
    "普通漫画不得读取旧版全局等待时间");
});

test("普通漫画完成后再次点击会重新下载并保留前次记录", async () => {
  const env = createEnvironment();
  await importBackground("single-explicit-redownload");
  const first = await env.send("386226", 12);
  env.downloads.get(first.downloadId).state = "complete";
  env.change({ id: first.downloadId, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.quickDownloads[0]?.status === "downloaded",
    "首次下载应完成");
  assert.equal((await env.states(["386226"])).states["386226"], "complete");

  const second = await env.send("386226", 12);
  assert.equal(second.state, "downloading");
  assert.equal(env.downloadCalls, 2);
  assert.deepEqual(env.downloadOptions.map((item) => item.filename), [
    "测试漫画/测试漫画 386226話.zip",
    "测试漫画/测试漫画 386226話.zip"
  ]);
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].status, "downloaded");
  assert.equal(env.local.wnacgStateV1.quickDownloads[1].status, "downloading");
  assert.notEqual(env.local.wnacgStateV1.quickDownloads[0].batchId,
    env.local.wnacgStateV1.quickDownloads[1].batchId);
  assert.equal((await env.states(["386226"])).states["386226"], "downloading");
});

test("漫画库权限为 prompt 时，网页按钮和状态查询都不请求目录授权", async () => {
  const env = createEnvironment({
    libraryFiles: {
      comicName: "测试漫画",
      files: ["测试漫画 386227話.zip"],
      permission: "prompt"
    }
  });
  await importBackground("quick-no-library-permission");
  assert.deepEqual((await env.states(["386227"])).states, {});
  const result = await env.send("386227", 13);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.equal((await env.states(["386227"])).states["386227"], "downloading");
  assert.equal(env.libraryPermissionQueries, 0);
});

test("前一轮下载晚于新一轮结束时，不覆盖最新按钮状态或历史", async () => {
  const env = createEnvironment();
  await importBackground("overlapping-explicit-batches");
  const first = await env.send("386228", 14);
  const second = await env.send("386228", 15);
  assert.equal(env.downloadCalls, 2);

  env.downloads.get(second.downloadId).state = "complete";
  env.change({ id: second.downloadId, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.quickDownloads[1]?.status === "downloaded",
    "新批次应先完成");
  assert.equal((await env.states(["386228"])).states["386228"], "complete");
  assert.ok(Object.values(env.session.wnacgFilenamePaths || {})
    .includes("测试漫画/测试漫画 386228話.zip"),
  "旧批次仍在下载时不得清除共用文件名映射");
  const messagesAfterSecond = env.sentMessages.length;

  env.downloads.get(first.downloadId).state = "complete";
  env.change({ id: first.downloadId, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.quickDownloads[0]?.status === "downloaded",
    "旧批次应独立完成");
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.equal((await env.states(["386228"])).states["386228"], "complete");
  assert.equal(env.sentMessages.length, messagesAfterSecond,
    "旧批次不得再次覆盖新批次按钮通知");
  assert.deepEqual(env.session.wnacgFilenamePaths || {}, {});
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
  assert.match(result.message, /Chrome 拒绝了下载文件名/);
  assert.deepEqual(env.session.wnacgFilenamePaths || {}, {});
});

test("首选文件名被 Chrome 拒绝时保留漫画目录并用 aid 文件名重试", async () => {
  const env = createEnvironment({
    downloadError: (attempt) => attempt === 1 ? new Error("Invalid filename") : null
  });
  await importBackground("invalid-filename-retry");

  const result = await env.send("386244", 55);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 2);
  assert.ok(env.downloadStartTimes[1] - env.downloadStartTimes[0] < 500,
    "同一话的文件名回退不应额外等待一秒");
  assert.equal(env.downloadOptions[0].filename, "测试漫画/测试漫画 386244話.zip");
  assert.equal(env.downloadOptions[1].filename, "测试漫画/wnacg-386244.zip");
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].relativePath, "测试漫画/wnacg-386244.zip");
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

test("浏览器重启后合集子任务独立恢复且父记录最终全部完成", async () => {
  const sourceAid = "388292";
  const firstId = 776;
  const secondId = 777;
  const records = [
    {
      aid: "230001",
      downloadAid: "230001",
      sourceAid,
      recordKey: `bundle:${sourceAid}:230001`,
      title: "恢复合集 1話",
      comicName: "恢复合集",
      isCollection: true,
      collectionTotal: 2,
      relativePath: "恢复合集/恢复合集 1話.zip",
      actualFilePath: "/Users/tester/Downloads/恢复合集/恢复合集 1話.zip",
      status: "downloaded",
      downloadId: firstId
    },
    {
      aid: "230002",
      downloadAid: "230002",
      sourceAid,
      recordKey: `bundle:${sourceAid}:230002`,
      title: "恢复合集 2話",
      comicName: "恢复合集",
      isCollection: true,
      collectionTotal: 2,
      relativePath: "恢复合集/恢复合集 2話.zip",
      status: "downloading",
      downloadId: secondId
    }
  ];
  const initialDownloads = new Map(records.map((record) => [record.downloadId, {
    id: record.downloadId,
    state: "complete",
    url: `https://dl1.wn01.download/${record.aid}.zip`,
    finalUrl: `https://dl1.wn01.download/${record.aid}.zip`,
    filename: `/Users/tester/Downloads/${record.relativePath}`,
    mime: "application/zip",
    fileSize: 64,
    exists: true
  }]));
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: records,
      activity: [],
      lastScanAt: null
    },
    initialDownloads
  });
  await importBackground("collection-recovery");

  await waitFor(
    () => env.local.wnacgStateV1.quickDownloads.every((item) => item.status === "downloaded"),
    "合集下载应按子任务从 Chrome 下载记录恢复"
  );
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.equal(
    env.local.wnacgStateV1.quickDownloads.find((item) => item.aid === "230002").actualFilePath,
    "/Users/tester/Downloads/恢复合集/恢复合集 2話.zip"
  );
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

test("合集一键下载按子章节保存多个 ZIP，全部完成后才通知父按钮", async () => {
  const sourceAid = "388288";
  const items = [
    { aid: "213231", title: "朋友的媽媽 外傳1-3話" },
    { aid: "215244", title: "朋友的媽媽 外傳4-5話" },
    { aid: "217722", title: "朋友的媽媽 外傳6-7話" }
  ];
  const env = createEnvironment({
    collection: { sourceAid, items, total: 3, limit: 30 }
  });
  await importBackground("collection-download");

  const result = await env.send(
    sourceAid,
    61,
    undefined,
    "朋友的媽媽 外傳",
    true
  );
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 3);
  assert.ok(env.downloadStartTimes.every((time, index, times) =>
    index === 0 || time - times[index - 1] >= 1_000),
  "合集相邻子话至少间隔一秒启动");
  assert.deepEqual(env.downloadOptions.map((item) => item.filename), [
    "朋友的媽媽 外傳/朋友的媽媽 外傳1-3話.zip",
    "朋友的媽媽 外傳/朋友的媽媽 外傳4-5話.zip",
    "朋友的媽媽 外傳/朋友的媽媽 外傳6-7話.zip"
  ]);
  assert.deepEqual(
    env.local.wnacgStateV1.quickDownloads.map((item) => ({
      recordKey: item.recordKey,
      sourceAid: item.sourceAid,
      aid: item.aid,
      status: item.status
    })),
    items.map((item) => ({
      recordKey: `bundle:${sourceAid}:${item.aid}`,
      sourceAid,
      aid: item.aid,
      status: "downloading"
    }))
  );

  for (const downloadId of [901, 902]) {
    env.downloads.get(downloadId).state = "complete";
    env.change({ id: downloadId, state: { current: "complete" } });
  }
  await waitFor(
    () => env.local.wnacgStateV1.quickDownloads.filter((item) => item.status === "downloaded").length === 2,
    "前两个合集子项应分别完成"
  );
  assert.equal(env.sentMessages.length, 0, "合集未全部完成时不应把父按钮标成完成");

  env.downloads.get(903).state = "complete";
  env.change({ id: 903, state: { current: "complete" } });
  await waitFor(() => env.sentMessages.length === 1, "合集全部完成后应通知父按钮");
  assert.equal(env.sentMessages[0].message.aid, sourceAid);
  assert.equal(env.sentMessages[0].message.state, "complete");
  assert.match(env.sentMessages[0].message.message, /3 个文件/);
});

test("卡片标注合集而下载页缺少章节容器时，从接口补齐全话并存入同一目录", async () => {
  const sourceAid = "390800";
  const chapter = (aid, title) => ({
    id: aid,
    name: title,
    dl2: `https://dl1.wn01.download/down/${aid}/${aid}.zip`
  });
  const env = createEnvironment({
    collection: {
      sourceAid,
      pageHtml: "<title>合集父容器</title><div>章节由接口载入</div>",
      items: [],
      total: 3,
      limit: 2,
      pages: {
        1: { code: 0, sid: sourceAid, total: 3, limit: 2, page: 1,
          list: [chapter("390801", "合集测试 1話"), chapter("390802", "合集测试 2話")] },
        2: { code: 0, sid: sourceAid, total: 3, limit: 2, page: 2,
          list: [chapter("390803", "合集测试 3話")] }
      }
    }
  });
  await importBackground("collection-card-api-fallback");

  const result = await env.send(sourceAid, 70, undefined, "合集测试", true);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 3);
  assert.deepEqual(env.downloadOptions.map((item) => item.filename), [
    "合集测试/合集测试 1話.zip",
    "合集测试/合集测试 2話.zip",
    "合集测试/合集测试 3話.zip"
  ]);
  assert.deepEqual(env.fetchUrls.slice(1), [
    `https://www.wnacg.com/?ctl=download&act=chapters&sid=${sourceAid}&page=1`,
    `https://www.wnacg.com/?ctl=download&act=chapters&sid=${sourceAid}&page=2`
  ]);
  assert.ok(env.local.wnacgStateV1.quickDownloads.every((item) =>
    item.recordKey.startsWith(`bundle:${sourceAid}:`)));
});

test("卡片标注合集但章节接口无效时不误下父 ZIP", async () => {
  const sourceAid = "390810";
  const env = createEnvironment({
    collection: {
      sourceAid,
      pageHtml: downloadPage(sourceAid, "合集父容器"),
      items: [],
      total: 2,
      pages: { 1: { code: 1, list: [] } }
    }
  });
  await importBackground("collection-card-invalid-api");

  const result = await env.send(sourceAid, 71, undefined, "合集测试", true);
  assert.equal(result.ok, false);
  assert.match(result.message, /合集章节分页响应格式无效/);
  assert.equal(env.downloadCalls, 0);
  assert.deepEqual(env.local.wnacgStateV1.quickDownloads, []);
});

test("旧独立话文件已存在时，合集按钮仍下载子话并保留历史", async () => {
  const childAid = "388404";
  const parentAid = "390062";
  const relativePath = "砲友滿屋/砲友滿屋 18-19話.zip";
  const filename = `/Users/tester/Downloads/${relativePath}`;
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [], updates: [], activity: [], lastScanAt: null,
      quickDownloads: [{
        aid: childAid, recordKey: `album:${childAid}`,
        comicName: "砲友滿屋", status: "downloaded",
        relativePath, actualFilePath: filename, downloadId: 500,
        startedAt: "2026-09-28T17:05:00Z"
      }]
    },
    initialDownloads: new Map([[500, {
      id: 500, state: "complete", filename, exists: true,
      url: "https://dl1.wn01.download/old.zip",
      finalUrl: "https://dl1.wn01.download/old.zip",
      mime: "application/zip", fileSize: 32
    }]]),
    collection: {
      sourceAid: parentAid,
      items: [{ aid: childAid, title: "砲友滿屋 18-19話" }],
      total: 1, limit: 30
    }
  });
  await importBackground("collection-reuses-old-quick-download");

  const result = await env.send(parentAid, 67, undefined, "砲友滿屋", false);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2,
    "旧独立下载历史必须保留");
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].recordKey, `album:${childAid}`);
  const record = env.local.wnacgStateV1.quickDownloads[1];
  assert.equal(record.recordKey, `bundle:${parentAid}:${childAid}`);
  assert.equal(record.status, "downloading");
  assert.equal(record.downloadMethod, "quick");
  assert.equal(env.downloadOptions[0].filename, relativePath);
});

test("网页按钮不读取已授权漫画库，已有 ZIP 也重新下载", async () => {
  const env = createEnvironment({
    libraryFiles: {
      comicName: "砲友滿屋",
      files: ["砲友滿屋 18-19話.zip"]
    },
    collection: {
      sourceAid: "390062",
      items: [{ aid: "388404", title: "砲友滿屋 18-19話" }],
      total: 1, limit: 30
    }
  });
  await importBackground("local-archive-baseline");
  const result = await env.send("390062", 67, undefined, "砲友滿屋", false);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.equal(env.libraryPermissionQueries, 0);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].downloadMethod, "quick");
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].localFilePath, undefined);
});

test("旧下载记录不会阻止网页按钮创建新下载", async () => {
  const env = createEnvironment({
    libraryFiles: { comicName: "砲友滿屋", files: [] },
    localState: {
      version: 1, watches: [], updates: [], activity: [], lastScanAt: null,
      quickDownloads: [{
        aid: "388404", recordKey: "album:388404", comicName: "砲友滿屋",
        title: "砲友滿屋 18-19話", status: "downloaded",
        relativePath: "砲友滿屋/砲友滿屋 18-19話.zip",
        actualFilePath: "/Users/tester/Downloads/砲友滿屋/砲友滿屋 18-19話.zip",
        startedAt: "2026-09-28"
      }]
    },
    collection: {
      sourceAid: "390062",
      items: [{ aid: "388404", title: "砲友滿屋 18-19話" }],
      total: 1, limit: 30
    }
  });
  await importBackground("missing-local-beats-history");
  const result = await env.send("390062", 68, undefined, "砲友滿屋", false);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].recordKey, "album:388404",
    "旧历史记录仍保留");
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
});

test("旧独立话仍在下载时，合集按钮创建独立新任务", async () => {
  const childAid = "388405";
  const parentAid = "390062";
  const relativePath = "砲友滿屋/砲友滿屋 20-21話.zip";
  const filename = `/Users/tester/Downloads/${relativePath}`;
  const url = "https://dl1.wn01.download/old-388405.zip";
  const env = createEnvironment({
    localState: {
      version: 1,
      watches: [], updates: [], activity: [], lastScanAt: null,
      quickDownloads: [{
        aid: childAid, recordKey: `album:${childAid}`,
        title: "砲友滿屋 20-21話", comicName: "砲友滿屋",
        status: "downloading", relativePath, downloadId: 500,
        zipUrl: url, startedAt: "2026-09-28T17:05:00Z"
      }]
    },
    initialDownloads: new Map([[500, {
      id: 500, state: "in_progress", filename,
      url, finalUrl: url, mime: "application/zip", fileSize: 32, exists: true
    }]]),
    collection: {
      sourceAid: parentAid,
      items: [{ aid: childAid, title: "砲友滿屋 20-21話" }],
      total: 1, limit: 30
    }
  });
  await importBackground("collection-reuses-active-old-download");

  const result = await env.send(parentAid, 68, undefined, "砲友滿屋", false);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 1);
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].recordKey, `album:${childAid}`);
  assert.equal(env.local.wnacgStateV1.quickDownloads[1].recordKey,
    `bundle:${parentAid}:${childAid}`);

  env.downloads.get(500).state = "complete";
  env.change({ id: 500, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.quickDownloads[0].status === "downloaded",
    "原下载任务应独立完成");
  assert.equal(env.local.wnacgStateV1.quickDownloads[1].status, "downloading");
  env.downloads.get(901).state = "complete";
  env.change({ id: 901, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.quickDownloads[1].status === "downloaded",
    "合集新任务应独立完成");
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.equal(env.local.wnacgStateV1.quickDownloads[1].actualFilePath,
    `/Users/tester/Downloads/${relativePath}`);
});

test("合集一键下载完成会同步并合并旧独立话的失败进度", async () => {
  const childAid = "388406";
  const parentAid = "390062";
  const env = createEnvironment({
    localState: {
      version: 1, watches: [], quickDownloads: [], activity: [], lastScanAt: null,
      updates: [
        { aid: childAid, recordKey: `album:${childAid}`, comicName: "砲友滿屋",
          title: "砲友滿屋 22-23話", status: "failed", selected: true,
          error: "HTTP 503" },
        { aid: childAid, downloadAid: childAid, sourceAid: parentAid,
          recordKey: `bundle:${parentAid}:${childAid}`, isCollection: true,
          comicName: "砲友滿屋", title: "砲友滿屋 22-23話",
          status: "pending", selected: true }
      ]
    },
    collection: {
      sourceAid: parentAid,
      items: [{ aid: childAid, title: "砲友滿屋 22-23話" }],
      total: 1, limit: 30
    }
  });
  await importBackground("collection-completes-old-progress");

  const result = await env.send(parentAid, 69, undefined, "砲友滿屋", false);
  assert.equal(result.state, "downloading");
  env.downloads.get(901).state = "complete";
  env.change({ id: 901, state: { current: "complete" } });
  await waitFor(() => env.local.wnacgStateV1.updates.length === 2 &&
    env.local.wnacgStateV1.updates.every((record) => record.status === "downloaded"),
  "下载完成后应保留两条原始记录并标记已下载");
  assert.equal(env.local.wnacgStateV1.updates[0].recordKey, `album:${childAid}`);
  assert.equal(env.local.wnacgStateV1.updates[1].recordKey,
    `bundle:${parentAid}:${childAid}`);
  assert.equal(env.local.wnacgStateV1.updates[1].error, null);
});

test("连载合集再次点击时重新下载当前全部子章节", async () => {
  const sourceAid = "390059";
  const items = Array.from({ length: 7 }, (_, index) => ({
    aid: String(390101 + index),
    title: `连载合集 ${index + 1}話`
  }));
  const chapterPage = (chapters) => ({
    code: 0,
    sid: sourceAid,
    list: chapters.map((item) => ({
      id: item.aid,
      name: item.title,
      dl2: `https://dl1.wn01.download/down/${item.aid}/${item.aid}.zip`
    })),
    total: chapters.length,
    page: 1,
    limit: 30
  });
  const collection = {
    sourceAid,
    items: items.slice(0, 2),
    total: 7,
    limit: 30,
    pages: { 1: chapterPage(items) }
  };
  const env = createEnvironment({ collection });
  await importBackground("serial-collection-seven-chapters");

  const first = await env.send(sourceAid, 66, undefined, "连载合集", false);
  assert.equal(first.state, "downloading", "下载页结构应覆盖缺失的卡片合集标签");
  assert.equal(env.downloadCalls, 7);
  assert.ok(env.fetchUrls.some((url) => url.includes(`sid=${sourceAid}&page=1`)));
  for (let id = 901; id <= 907; id += 1) {
    env.downloads.get(id).state = "complete";
    env.change({ id, state: { current: "complete" } });
  }
  await waitFor(() => env.sentMessages.at(-1)?.message.state === "complete",
    "七话完成后父按钮应显示完成");

  const eighth = { aid: "390108", title: "连载合集 8話" };
  collection.items = items.slice(0, 3);
  collection.total = 8;
  collection.pages[1] = chapterPage([...items, eighth]);
  const second = await env.send(sourceAid, 66, undefined, "连载合集", false);
  assert.equal(second.state, "downloading");
  assert.equal(env.downloadCalls, 15, "再次点击应下载当前全部八话");
  assert.equal(env.downloadOptions.at(-1).filename, "连载合集/连载合集 8話.zip");
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 15,
    "首轮七话历史必须保留");
  assert.notEqual(env.local.wnacgStateV1.quickDownloads[0].batchId,
    env.local.wnacgStateV1.quickDownloads[7].batchId);
});

test("合集部分失败后再次点击仍重新下载全部子项", async () => {
  const sourceAid = "388290";
  const items = [
    { aid: "220001", title: "重试合集 1話" },
    { aid: "220002", title: "重试合集 2話" },
    { aid: "220003", title: "重试合集 3話" }
  ];
  const env = createEnvironment({
    collection: { sourceAid, items, total: 3, limit: 30 },
    downloadError: (attempt) => attempt === 2 ? new Error("network unavailable") : null
  });
  await importBackground("collection-partial-retry");

  const first = await env.send(sourceAid, 62, undefined, "重试合集", true);
  assert.equal(first.state, "downloading");
  assert.equal(env.downloadCalls, 3);
  const failed = env.local.wnacgStateV1.quickDownloads.find(
    (item) => item.recordKey === `bundle:${sourceAid}:220002`
  );
  assert.equal(failed.status, "failed");

  for (const downloadId of [901, 903]) {
    env.downloads.get(downloadId).state = "complete";
    env.change({ id: downloadId, state: { current: "complete" } });
  }
  await waitFor(
    () => env.sentMessages.at(-1)?.message.state === "error",
    "其余子项结束后父按钮应显示可重试错误"
  );

  const retry = await env.send(sourceAid, 62, undefined, "重试合集", true);
  assert.equal(retry.state, "downloading");
  assert.equal(env.downloadCalls, 6, "再次点击应为三话都创建新任务");
  assert.deepEqual(env.downloadOptions.slice(3).map((item) => item.filename),
    items.map((item) => `重试合集/${item.title}.zip`));
  for (const downloadId of [904, 905, 906]) {
    env.downloads.get(downloadId).state = "complete";
    env.change({ id: downloadId, state: { current: "complete" } });
  }
  await waitFor(
    () => env.sentMessages.at(-1)?.message.state === "complete",
    "失败子项重试成功后父按钮应完成"
  );
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 6);
  assert.equal(env.local.wnacgStateV1.quickDownloads[1].status, "failed");
  assert.ok(env.local.wnacgStateV1.quickDownloads.slice(3)
    .every((item) => item.status === "downloaded"));
});

test("超过 30 话的合集会读取分页接口并下载完整清单", async () => {
  const sourceAid = "388291";
  const firstPageItems = Array.from({ length: 30 }, (_, index) => ({
    aid: String(300001 + index),
    title: `分页合集 ${index + 1}話`
  }));
  const env = createEnvironment({
    collection: {
      sourceAid,
      items: firstPageItems,
      total: 31,
      limit: 30,
      pages: {
        2: {
          code: 0,
          list: [{
            id: 300031,
            idx: 31,
            name: "分页合集 31話",
            dl2: "https://dl1.wn01.download/down/300031/300031.zip?n=300031"
          }],
          total: 31,
          page: 2,
          limit: 30
        }
      }
    }
  });
  await importBackground("collection-pagination");

  const result = await env.send(sourceAid, 63, undefined, "分页合集", true);
  assert.equal(result.state, "downloading");
  assert.equal(env.downloadCalls, 31);
  assert.equal(
    env.fetchUrls[1],
    `https://www.wnacg.com/?ctl=download&act=chapters&sid=${sourceAid}&page=2`
  );
  assert.equal(env.downloadOptions.at(-1).filename, "分页合集/分页合集 31話.zip");
});

test("合集章节清单不完整时在创建任何 Chrome 下载前终止", async () => {
  const sourceAid = "388293";
  const env = createEnvironment({
    collection: {
      sourceAid,
      items: [
        { aid: "240001", title: "残缺合集 1話" },
        { aid: "240002", title: "残缺合集 2話" }
      ],
      total: 3,
      limit: 30
    }
  });
  await importBackground("collection-incomplete");

  const result = await env.send(sourceAid, 64, undefined, "残缺合集", true);
  assert.equal(result.ok, false);
  assert.match(result.message, /章节清单不完整/);
  assert.equal(env.downloadCalls, 0);
  assert.deepEqual(env.local.wnacgStateV1.quickDownloads, []);
});

test("合集写回清单时保留旧版父 aid 历史但不计入当前下载", async () => {
  const sourceAid = "388294";
  const env = createEnvironment({
    collection: {
      sourceAid,
      items: [
        { aid: "250001", title: "迁移合集 1話" },
        { aid: "250002", title: "迁移合集 2話" }
      ],
      total: 2,
      limit: 30
    },
    localState: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [{
        aid: sourceAid,
        title: "迁移合集",
        comicName: "迁移合集",
        status: "failed",
        relativePath: "迁移合集/迁移合集.zip",
        error: "旧版父记录"
      }],
      activity: [],
      lastScanAt: null
    }
  });
  await importBackground("collection-remove-legacy-parent");

  const result = await env.send(sourceAid, 65, undefined, "迁移合集", true);
  assert.equal(result.state, "downloading");
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 3);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].aid, sourceAid);
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].error, "旧版父记录");
  assert.equal(env.local.wnacgStateV1.quickDownloads[0].supersededByCollection, true);
  assert.deepEqual(
    env.local.wnacgStateV1.quickDownloads.slice(1).map((item) => item.recordKey),
    [`bundle:${sourceAid}:250001`, `bundle:${sourceAid}:250002`]
  );
  assert.ok(env.local.wnacgStateV1.quickDownloads.slice(1)
    .every((item) => item.sourceAid === sourceAid));
});
