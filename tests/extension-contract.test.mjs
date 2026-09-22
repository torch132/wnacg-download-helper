import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manifest 使用最小权限并通过 action popup 打开管理界面", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.4.7");
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting", "downloads"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://www.wnacg.com/*",
    "https://*.wn01.download/*",
  ]);
  assert.equal(manifest.action.default_popup, "app.html");
  assert.deepEqual(manifest.action.default_icon, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
  });
  assert.deepEqual(manifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
  assert.equal(manifest.options_page, undefined);
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: [
        "https://www.wnacg.com/",
        "https://www.wnacg.com/albums*",
        "https://www.wnacg.com/search/*",
      ],
      js: ["content-script.js"],
      css: ["content-script.css"],
      run_at: "document_idle",
    },
  ]);
  assert.ok(!manifest.content_scripts[0].matches.includes("https://www.wnacg.com/*"));
});

test("扩展图标使用有效的 wnACG favicon PNG 尺寸", async () => {
  for (const size of [16, 32, 48, 128]) {
    const bytes = await readFile(new URL(`../icons/icon-${size}.png`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

test("弹窗从当前活动 wnACG 列表页提取可见章节", async () => {
  const app = await read("app.js");
  assert.match(app, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
  assert.match(app, /chrome\.scripting\.executeScript/);
  assert.match(app, /document\.querySelectorAll\("\.gallary_item"\)/);
  assert.match(app, /importCurrentPageMatches/);
});

test("标签系列页跨页导入且最多扫描 15 页", async () => {
  const app = await read("app.js");
  assert.match(app, /const MAX_TAG_SCAN_PAGES = 15;/);
  assert.match(app, /buildTagPageScanPlan\(/);
  assert.match(app, /async function importCurrentTagPages/);
  assert.match(app, /seenPageSignatures\.has\(signature\)/);
  assert.match(app, /error instanceof WnacgParseError/);
  assert.match(app, /await importCurrentTagPages\(\[watch\]\)/);
});

test("弹窗使用固定宽度和受控高度，不依赖新标签页", async () => {
  const css = await read("styles.css");
  assert.match(css, /html\s*\{[^}]*width:\s*760px;/s);
  assert.match(css, /body\s*\{[^}]*height:\s*600px;/s);
  assert.match(css, /body\s*\{[^}]*overflow-y:\s*auto;/s);
  const files = await Promise.allSettled([read("service-worker.js")]);
  assert.equal(files[0].status, "rejected");
});

test("管理页提供所有运行时控件且不加载远程资源", async () => {
  const html = await read("app.html");
  const requiredIds = [
    "choose-directory-btn",
    "watch-form",
    "watch-prefix-input",
    "watch-submit-btn",
    "watch-cancel-edit",
    "scan-btn",
    "scan-progress",
    "updates-list",
    "select-all-updates",
    "download-selected-btn",
    "ignore-selected-btn",
    "retry-failed-btn",
    "activity-list",
    "confirm-dialog",
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `缺少 #${id}`);
  }
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)=["']https?:/i);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
});

test("所有静态 DOM id 唯一", async () => {
  const html = await read("app.html");
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("关注卡片被约束在左侧栏内", async () => {
  const [css, app] = await Promise.all([read("styles.css"), read("app.js")]);
  assert.match(css, /\.watch-section\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.watch-list\s*\{[^}]*min-width:\s*0;/s);
  assert.match(css, /\.watch-item\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.watch-item-main\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.watch-copy\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
  assert.match(app, /formatBaselineLabel\(watch\)/);
  assert.doesNotMatch(app, /`基线：\$\{watch\.baselineTitle\}`/);
});

test("列表页下载图标注入日期区域并通过后台保存到漫画目录", async () => {
  const [content, css, background] = await Promise.all([
    read("content-script.js"),
    read("content-script.css"),
    read("background.js"),
  ]);
  assert.match(content, /querySelector\("\.info > \.info_col"\)/);
  assert.match(content, /infoColumn\.append\(createButton\(info\)\)/);
  assert.match(content, /dataset\.wnacgHelperMounted/);
  assert.match(content, /WNACG_QUICK_DOWNLOAD/);
  assert.match(content, /event\.isTrusted/);
  assert.match(content, /MutationObserver/);
  assert.match(content, /highlightTitle\(info\.titleLink\)/);
  assert.match(content, /document\.createTextNode\(part\.text\)/);
  assert.doesNotMatch(content, /innerHTML\s*=/);
  assert.match(css, /\.wnacg-helper-download\s*\{/);
  assert.match(css, /\.wnacg-helper-title-token\.is-translation\s*\{[^}]*#ff677d;[^}]*#4a1822;/s);
  assert.match(css, /\.wnacg-helper-title-token\.is-dl\s*\{[^}]*#a8e6cf;[^}]*#24483d;/s);
  assert.match(css, /\.wnacg-helper-title-token\.is-uncensored\s*\{[^}]*#6a9cbb;/s);
  assert.match(css, /vertical-align:\s*middle/);
  assert.match(background, /parseDownloadPageText/);
  assert.match(background, /parseDownloadTitleText/);
  assert.doesNotMatch(background, /probeZip/);
  assert.match(background, /chrome\.downloads\.onDeterminingFilename/);
  assert.match(background, /suggest\(\{ filename: relativePath, conflictAction: "uniquify" \}\)/);
  assert.match(background, /chrome\.downloads\.download/);
  assert.match(background, /conflictAction:\s*"uniquify"/);
  assert.match(background, /relativePath = `\$\{folder\}\/\$\{fileBase\}\.zip`/);
  assert.match(background, /chrome\.downloads\.onChanged/);
  assert.match(background, /startFlights/);
  assert.match(background, /recoverQuickDownloads/);
  assert.match(background, /chrome\.downloads\.removeFile/);
  assert.match(background, /state\.quickDownloads/);
  assert.match(background, /mutateAppState/);
});

test("弹窗使用相同的莫兰迪红绿高亮标题标签", async () => {
  const [app, css] = await Promise.all([read("app.js"), read("styles.css")]);
  assert.match(app, /appendHighlightedTitle\(titleLink, record\.title\)/);
  assert.match(app, /document\.createTextNode\(part\.text\)/);
  assert.doesNotMatch(app, /innerHTML\s*=/);
  assert.match(css, /\.title-token\.is-translation\s*\{[^}]*#ff677d;[^}]*#4a1822;/s);
  assert.match(css, /\.title-token\.is-dl\s*\{[^}]*#a8e6cf;[^}]*#24483d;/s);
  assert.match(css, /\.title-token\.is-uncensored\s*\{[^}]*#6a9cbb;/s);
});

test("更新话数按漫画默认收起并支持点击展开", async () => {
  const [app, css, html] = await Promise.all([
    read("app.js"),
    read("styles.css"),
    read("app.html"),
  ]);
  assert.match(app, /const expandedUpdateGroups = new Set\(\);/);
  assert.match(app, /addEventListener\("click", handleUpdateGroupToggle\)/);
  assert.match(app, /createElement\("button", "update-group-toggle"\)/);
  assert.match(app, /toggle\.type = "button";/);
  assert.match(app, /toggle\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.match(app, /toggle\.setAttribute\("aria-controls", rowsId\)/);
  assert.match(app, /rows\.hidden = !expanded;/);
  assert.match(app, /expandedUpdateGroups\.add\(comicName\)/);
  assert.match(app, /expandedUpdateGroups\.delete\(comicName\)/);
  assert.match(css, /\.update-group-toggle\s*\{[^}]*width:\s*100%;/s);
  assert.match(css, /\.update-group-toggle:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /\.update-group-toggle\[aria-expanded="true"\] \.update-group-chevron/s);
  assert.match(html, /class="update-group-toggle"[^>]*type="button"[^>]*aria-expanded="false"/);
  assert.match(html, /class="update-group-rows" hidden/);
});
