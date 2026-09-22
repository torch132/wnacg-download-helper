import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { SimpleDOMParser } from "./helpers/simple-dom-parser.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(testDirectory, "../core.js");
const coreSource = await readFile(corePath, "utf8");
const core = await import(
  `data:text/javascript;base64,${Buffer.from(coreSource).toString("base64")}`
);

const fixture = (name) => readFile(resolve(testDirectory, "fixtures", name), "utf8");

test("normalizeTitle 执行 NFKC、空白折叠和大小写统一", () => {
  assert.equal(core.normalizeTitle("  ＡＰＰ\t第１話\n"), "app 第1話");
  assert.equal(core.normalizeTitle(null), "");
});

test("splitTitleTags 只分段精确匹配的标题标签", () => {
  assert.deepEqual(
    core.splitTitleTags("作品 [中国翻訳][DL版][無修正] 12話"),
    [
      { text: "作品 ", kind: null },
      { text: "[中国翻訳]", kind: "translation" },
      { text: "[DL版]", kind: "dl" },
      { text: "[無修正]", kind: "uncensored" },
      { text: " 12話", kind: null },
    ],
  );
  assert.deepEqual(core.splitTitleTags("[中国翻译] DL版"), [
    { text: "[中国翻译] DL版", kind: null },
  ]);
  assert.deepEqual(core.splitTitleTags('<img onerror="x">[DL版]'), [
    { text: '<img onerror="x">', kind: null },
    { text: "[DL版]", kind: "dl" },
  ]);
  assert.deepEqual(core.splitTitleTags("[無修正品] [無修正]"), [
    { text: "[無修正品] ", kind: null },
    { text: "[無修正]", kind: "uncensored" },
  ]);
});

test("findLongestPrefixMatch 选择最长启用前缀", () => {
  const general = { id: "a", prefix: "獵艷", enabled: true };
  const exact = { id: "b", prefix: "獵艷管理員", enabled: true };
  const disabled = { id: "c", prefix: "獵艷管理員 55", enabled: false };
  assert.equal(
    core.findLongestPrefixMatch("獵艷管理員   55-56話", [general, exact, disabled]),
    exact,
  );
  assert.equal(core.findLongestPrefixMatch("其他漫畫", [general]), null);
});

test("parseAlbumListHtml 从真实页面结构提取并按 aid 去重", async () => {
  const html = `${await fixture("albums.html")}<li class="gallary_item"><a href="/photos-index-aid-384585.html" title="重複"></a></li>`;
  assert.deepEqual(
    core.parseAlbumListHtml(html, { parserCtor: SimpleDOMParser }),
    [
      {
        aid: "384588",
        title: "為民服務App 25-26話",
        url: "https://www.wnacg.com/photos-index-aid-384588.html",
      },
      {
        aid: "384585",
        title: "獵艷管理員 55-56話",
        url: "https://www.wnacg.com/photos-index-aid-384585.html",
      },
    ],
  );
});

test("parseAlbumListHtml 在结构变化或缺少 DOMParser 时明确失败", () => {
  assert.throws(
    () => core.parseAlbumListHtml("<html></html>", { parserCtor: SimpleDOMParser }),
    /页面结构可能已变化/,
  );
  assert.throws(
    () => core.parseAlbumListHtml("<html></html>", { parserCtor: null }),
    /DOMParser/,
  );
});

test("下载页只接受受信任域名上的 HTTPS ZIP 备用直链", async () => {
  const html = await fixture("download.html");
  const result = core.parseDownloadPageHtml(html, {
    parserCtor: SimpleDOMParser,
  });
  assert.equal(
    result,
    "https://dl1.wn01.download/down/9999/0123456789abcdef0123456789abcdef.zip?n=%E6%B8%AC%E8%A9%A6%E6%BC%AB%E7%95%AB",
  );
  assert.equal(core.parseDownloadPageText(html), result);
  assert.equal(
    core.parseDownloadTitleText("<title>與生巨來 1-9話.zip 下載 - 紳士漫畫</title>"),
    "與生巨來 1-9話",
  );
  assert.equal(
    core.parseDownloadPageText(
      '<a href="https://dl1.wn01.download/file.zip?n=a&amp;x=1" class="primary ads">下载</a>',
    ),
    "https://dl1.wn01.download/file.zip?n=a&x=1",
  );
  assert.equal(
    core.isAllowedDownloadUrl("https://dl2.wn01.download/file.ZIP?x=1"),
    true,
  );
  assert.equal(core.isAllowedDownloadUrl("http://dl1.wn01.download/file.zip"), false);
  assert.equal(core.isAllowedDownloadUrl("https://wn01.download.evil.test/file.zip"), false);
  assert.equal(core.isAllowedDownloadUrl("https://dl1.wn01.download/file.exe"), false);
});

test("parseDownloadPageHtml 拒绝仅含不可信链接的页面", () => {
  assert.throws(
    () =>
      core.parseDownloadPageHtml(
        '<a class="ads" href="https://evil.test/file.zip">bad</a>',
        { parserCtor: SimpleDOMParser },
      ),
    /未包含受信任/,
  );
});

test("sanitizeFileName 保留中文并替换路径非法字符", () => {
  assert.equal(
    core.sanitizeFileName(' 獵艷管理員: 55/56話? "完". '),
    "獵艷管理員_ 55_56話_ _完_",
  );
  assert.equal(core.sanitizeFileName("\u0000 ... ", "未命名"), "未命名");
  assert.equal(core.sanitizeFileName("标题\u2028分隔\u2029符"), "标题分隔符");
  assert.equal(core.sanitizeFileName("", "备选/名称?"), "备选_名称_");
});

test("deriveComicName 从常见话数后缀推断漫画目录名", () => {
  assert.equal(core.deriveComicName("與生巨來 1-9話"), "與生巨來");
  assert.equal(core.deriveComicName("人妻獵人 133-134话"), "人妻獵人");
  assert.equal(core.deriveComicName("漫畫 第12巻"), "漫畫");
  assert.equal(
    core.deriveComicName("中了傳教士的美人計 34-35話 [無修正] [DL版]"),
    "中了傳教士的美人計",
  );
  assert.equal(
    core.deriveComicName("[陸の孤島亭 (しゃよー)] 桜春女学院の男優 1~6 [中国翻訳] [無修正] [DL版]"),
    "[陸の孤島亭 (しゃよー)] 桜春女学院の男優",
  );
  assert.equal(core.deriveComicName("作品名稱 [中国翻訳]"), "作品名稱");
  assert.equal(core.deriveComicName("Single Volume [DL版]"), "Single Volume");
  assert.equal(core.deriveComicName("Room 101"), "Room 101");
  assert.equal(core.deriveComicName(""), "一键下载");
  assert.equal(new TextEncoder().encode(core.truncateUtf8("漫画".repeat(100), 120)).byteLength, 120);
  assert.equal(core.truncateUtf8("abc. ", 20), "abc");
});

test("extractChapterLabel 只提取完整标题末尾的话数标签", () => {
  assert.equal(core.extractChapterLabel("中了傳教士的美人計 34-35話"), "34-35話");
  assert.equal(core.extractChapterLabel("人妻獵人 第 133 至 134 话"), "第133至134话");
  assert.equal(core.extractChapterLabel("作品 全 12 回（完）"), "全12回");
  assert.equal(core.extractChapterLabel("Comic Chapter 7 - 8"), "Chapter 7-8");
  assert.equal(core.extractChapterLabel("Comic EP. 12-13"), "EP. 12-13");
  assert.equal(core.extractChapterLabel("漫畫 第１２巻"), "第12巻");
  assert.equal(
    core.extractChapterLabel("漫畫 特別篇 2", { seriesPrefix: "漫畫 特別篇" }),
    "2",
  );
  assert.equal(core.extractChapterLabel("Single Volume [DL版]"), null);
  assert.equal(core.extractChapterLabel("作品 2026 年版"), null);
  assert.equal(core.extractChapterLabel("Room 101"), null);
});

test("formatBaselineLabel 只显示系列话数并让全局边界回退为 aid", () => {
  assert.equal(core.formatBaselineLabel({
    prefix: "中了傳教士的美人計",
    baselineTitle: "中了傳教士的美人計 34-35話",
    baselineAid: "123",
    baselineKind: "series",
  }), "34-35話");
  assert.equal(core.formatBaselineLabel({
    prefix: "未找到",
    baselineTitle: "其他漫畫 55話",
    baselineAid: "456",
    baselineKind: "global",
  }), "aid 456");
  assert.equal(core.formatBaselineLabel({ baselineTitle: "无话数", baselineAid: "789" }), "aid 789");
});

test("createUpdateCandidates 按 aid 去重、最长前缀归属并初始化 pending", () => {
  const detectedAt = "2026-09-19T00:00:00.000Z";
  const existing = [{ aid: "100", status: "downloaded" }];
  const result = core.createUpdateCandidates({
    albums: [
      { aid: "100", title: "漫畫 特別篇", url: "old" },
      { aid: "101", title: "漫畫 特別篇 2", url: "new" },
      { aid: "101", title: "漫畫 特別篇 2（重複）", url: "duplicate" },
      { aid: "102", title: "未關注", url: "other" },
    ],
    watchItems: [
      { id: "general", titlePrefix: "漫畫", comicName: "漫畫" },
      { id: "special", titlePrefix: "漫畫 特別篇", comicName: "漫畫 特別篇" },
    ],
    existingRecords: existing,
    detectedAt,
  });

  assert.equal(result.records[0], existing[0]);
  assert.deepEqual(result.added, [
    {
      aid: "101",
      watchId: "special",
      comicName: "漫畫 特別篇",
      title: "漫畫 特別篇 2",
      sourceUrl: "new",
      downloadPageUrl: "https://www.wnacg.com/download-index-aid-101.html",
      status: "pending",
      selected: true,
      detectedAt,
      error: null,
    },
  ]);
});

test("transitionUpdate 强制合法状态流并维护选择/错误状态", () => {
  const pending = { aid: "101", status: "pending", selected: true, error: "旧错误" };
  const downloading = core.transitionUpdate(pending, "downloading");
  assert.deepEqual(downloading, {
    aid: "101",
    status: "downloading",
    selected: false,
    error: null,
  });
  const failed = core.transitionUpdate(downloading, "failed", { error: "网络失败" });
  assert.equal(failed.selected, true);
  assert.equal(failed.error, "网络失败");
  assert.equal(core.transitionUpdate(failed, "downloading").error, null);
  assert.throws(() => core.transitionUpdate(pending, "downloaded"), /不允许/);
  assert.throws(() => core.transitionUpdate(pending, "unknown"), /未知更新状态/);
});

test("extractAid 同时识别相册页和下载页", () => {
  assert.equal(core.extractAid("/photos-index-aid-384585.html"), "384585");
  assert.equal(core.extractAid("https://www.wnacg.com/download-index-aid-42.html?q=1"), "42");
  assert.equal(core.extractAid("/albums-index-cate-20.html"), null);
});

test("标签分页计划从第 1 页开始并严格限制为最多 15 页", () => {
  const current =
    "https://www.wnacg.com/albums-index-page-1-tag-%E4%BA%BA%E5%A6%BB%E7%8D%B5%E4%BA%BA.html";
  const page4 =
    "https://www.wnacg.com/albums-index-page-4-tag-%E4%BA%BA%E5%A6%BB%E7%8D%B5%E4%BA%BA.html";
  assert.deepEqual(core.parseTagListingUrl(current), {
    page: 1,
    tagPath: "%E4%BA%BA%E5%A6%BB%E7%8D%B5%E4%BA%BA",
  });
  const capped = core.buildTagPageScanPlan(current, 15);
  assert.equal(capped.length, 15);
  assert.equal(capped[0].page, 1);
  assert.equal(capped[3].url, page4);
  assert.equal(capped.at(-1).page, 15);
  assert.deepEqual(core.buildTagPageScanPlan("https://evil.test/albums-index-tag-x.html"), []);
  assert.deepEqual(core.buildTagPageScanPlan("https://www.wnacg.com/albums.html"), []);
});

test("基线过滤使用最长前缀，并在页面越过 aid 边界后停止", () => {
  const watches = [
    { id: "general", prefix: "漫画", baselineAid: "105" },
    { id: "special", prefix: "漫画 特别篇", baselineAid: "108" },
  ];
  const albums = [
    { aid: "110", title: "漫画 特别篇 3" },
    { aid: "107", title: "漫画 普通篇" },
    { aid: "104", title: "其他作品" },
  ];

  assert.deepEqual(core.filterAlbumsAfterBaselines(albums, watches), [albums[0], albums[1]]);
  assert.deepEqual(
    [...core.findReachedBaselineIds(albums, watches)].sort(),
    ["general", "special"],
  );
});

test("ZIP 文件头校验接受 PK 并拒绝 HTML", () => {
  assert.equal(core.hasZipSignature(new Uint8Array([0x50, 0x4b, 3, 4])), true);
  assert.equal(core.hasZipSignature(new TextEncoder().encode("<html>")), false);
});

test("系列标签页的全部话数都能进入首次候选队列", () => {
  const watch = { id: "love", prefix: "戀愛版本更新中", enabled: true };
  const albums = [
    ["384357", "23-24話"],
    ["380872", "21-22話"],
    ["377353", "19-20話"],
    ["374681", "17-18話"],
    ["372058", "15-16話"],
    ["369028", "13-14話"],
    ["366212", "11-12話"],
    ["363885", "9-10話"],
    ["361803", "7-8話"],
    ["359705", "1-6話"],
  ].map(([aid, chapter]) => ({
    aid,
    title: `戀愛版本更新中 ${chapter}`,
    url: `https://www.wnacg.com/photos-index-aid-${aid}.html`,
  }));
  const result = core.createUpdateCandidates({ albums, watchItems: [watch] });
  assert.equal(result.added.length, 10);
  assert.deepEqual(result.added.map((item) => item.aid), albums.map((item) => item.aid));
});
