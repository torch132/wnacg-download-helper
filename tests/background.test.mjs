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
  collection
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
  const sidePanelCalls = [];

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
    sidePanel: {
      async setPanelBehavior(options) {
        sidePanelCalls.push(structuredClone(options));
      }
    },
    downloads: {
      async download(options) {
        downloadCalls += 1;
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
          ? collectionDownloadPage(collection)
          : downloadPage(aid, pageTitle || `测试漫画 ${aid}話`)
      };
    }
    throw new Error(`不应由 fetch 预请求 ZIP：${url}`);
  };

  return {
    downloads,
    downloadOptions,
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

test("合集部分创建失败后再次点击只重试失败子项", async () => {
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
  assert.equal(env.downloadCalls, 4, "重试不应重复创建两个已完成子项");
  assert.equal(env.downloadOptions[3].filename, "重试合集/重试合集 2話.zip");
  env.downloads.get(904).state = "complete";
  env.change({ id: 904, state: { current: "complete" } });
  await waitFor(
    () => env.sentMessages.at(-1)?.message.state === "complete",
    "失败子项重试成功后父按钮应完成"
  );
  assert.ok(env.local.wnacgStateV1.quickDownloads.every((item) => item.status === "downloaded"));
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

test("合集写回清单时移除旧版父 aid 单记录", async () => {
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
  assert.equal(env.local.wnacgStateV1.quickDownloads.length, 2);
  assert.deepEqual(
    env.local.wnacgStateV1.quickDownloads.map((item) => item.recordKey),
    [`bundle:${sourceAid}:250001`, `bundle:${sourceAid}:250002`]
  );
  assert.ok(env.local.wnacgStateV1.quickDownloads.every((item) => item.sourceAid === sourceAid));
});
