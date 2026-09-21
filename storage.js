const STORAGE_KEY = "wnacgStateV1";
const STATE_LOCK = "wnacg-state-write";

const EMPTY_STATE = Object.freeze({
  version: 1,
  watches: [],
  updates: [],
  quickDownloads: [],
  activity: [],
  lastScanAt: null
});

export async function loadAppState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(stored[STORAGE_KEY]);
}

function normalizeState(value = {}) {
  return {
    ...EMPTY_STATE,
    ...value,
    watches: Array.isArray(value.watches) ? value.watches : [],
    updates: Array.isArray(value.updates) ? value.updates : [],
    quickDownloads: Array.isArray(value.quickDownloads) ? value.quickDownloads : [],
    activity: Array.isArray(value.activity) ? value.activity : []
  };
}

export async function saveAppState(state) {
  return withStateLock(async () => {
    const latest = await loadAppState();
    const persisted = compactState({
      ...state,
      quickDownloads: latest.quickDownloads,
      activity: mergeActivity(state.activity, latest.activity)
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted });
    return persisted;
  });
}

function mergeActivity(submitted = [], latest = []) {
  const entries = new Map();
  for (const item of [...latest, ...submitted]) {
    if (item?.id) entries.set(item.id, item);
  }
  return [...entries.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 100);
}

export async function updateAppState(mutator) {
  return withStateLock(async () => {
    const state = await loadAppState();
    await mutator(state);
    const persisted = compactState(state);
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted });
    return normalizeState(persisted);
  });
}

function withStateLock(operation) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(STATE_LOCK, operation);
  }
  return operation();
}

function compactState(state) {
  return {
    ...state,
    version: 1,
    activity: state.activity.slice(0, 100),
    updates: compactUpdates(state.updates),
    quickDownloads: compactQuickDownloads(state.quickDownloads)
  };
}

function compactQuickDownloads(records) {
  const active = records.filter((item) => ["downloading", "failed"].includes(item.status));
  const history = records
    .filter((item) => item.status === "downloaded")
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 500);
  return [...active, ...history];
}

export function addActivity(state, level, message) {
  state.activity.unshift({
    id: crypto.randomUUID(),
    level,
    message,
    createdAt: new Date().toISOString()
  });
  state.activity = state.activity.slice(0, 100);
}

function compactUpdates(updates) {
  const actionable = updates.filter((item) =>
    ["pending", "downloading", "failed"].includes(item.status)
  );
  const history = updates
    .filter((item) => ["downloaded", "ignored"].includes(item.status))
    .sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)))
    .slice(0, 500);
  return [...actionable, ...history];
}
