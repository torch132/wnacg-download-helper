import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../storage.js", import.meta.url), "utf8");
const storage = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("弹窗保存状态时保留后台的一键下载历史", async () => {
  let persisted = {
    wnacgStateV1: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [{ aid: "100", status: "downloaded", startedAt: "2026-09-20" }],
      activity: [],
      lastScanAt: null,
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(persisted),
        set: async (value) => {
          persisted = structuredClone(value);
        },
      },
    },
  };

  const stalePopupState = await storage.loadAppState();
  stalePopupState.quickDownloads = [];
  stalePopupState.watches.push({ id: "watch", prefix: "漫画" });
  await storage.saveAppState(stalePopupState);
  assert.equal(persisted.wnacgStateV1.quickDownloads[0].aid, "100");
  assert.equal(persisted.wnacgStateV1.watches[0].id, "watch");

  await storage.updateAppState((state) => {
    state.quickDownloads[0].status = "failed";
  });
  assert.equal(persisted.wnacgStateV1.quickDownloads[0].status, "failed");
});

test("弹窗陈旧快照保存时合并后台新增活动", async () => {
  let persisted = {
    wnacgStateV1: {
      version: 1,
      watches: [],
      updates: [],
      quickDownloads: [],
      activity: [{ id: "old", level: "info", message: "旧", createdAt: "2026-09-19" }],
      lastScanAt: null
    }
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(persisted),
        set: async (value) => {
          persisted = structuredClone(value);
        }
      }
    }
  };

  const stale = await storage.loadAppState();
  persisted.wnacgStateV1.activity.unshift({
    id: "background",
    level: "success",
    message: "后台完成",
    createdAt: "2026-09-20"
  });
  stale.watches.push({ id: "watch", prefix: "漫画" });
  await storage.saveAppState(stale);

  assert.deepEqual(
    persisted.wnacgStateV1.activity.map((item) => item.id),
    ["background", "old"]
  );
});
