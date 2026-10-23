const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getJson(response) {
  return response.json().catch(() => null);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await getJson(response);
  if (!response.ok) {
    const message = payload && typeof payload === "object"
      ? payload.statusMessage || payload.message
      : undefined;
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${message || JSON.stringify(payload)}`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  let lastError = "Nuxt dev server did not become ready.";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    let response;
    try {
      response = await fetch(new URL("/api/characters", baseUrl));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
      continue;
    }

    if (response.status === 200) return;
    lastError = `API returned HTTP ${response.status}: ${await response.text()}`;
    if (response.status === 403) throw new Error(`Local API guard rejected the smoke test: ${lastError}`);
    await sleep(500);
  }
  throw new Error(`Nuxt server readiness timed out: ${lastError}`);
}

await waitForServer();

const firstList = await request("/api/characters");
assert(Array.isArray(firstList), "GET /api/characters must return a list.");

const unique = Date.now().toString();
const created = await request("/api/characters", {
  method: "POST",
  body: {
    name: `CI 持久化测试角色 ${unique}`,
    alias: "CI 验收",
    description: "用于验证数据库持久化的临时角色。",
    personality: "请保持语气清晰、温和。",
  },
});
assert(typeof created.id === "string" && created.id.length > 0, "POST must return the created character id.");
assert(created.name === `CI 持久化测试角色 ${unique}`, "Created character name did not round-trip.");
assert(Array.isArray(created.channels), "Character DTO must include a channels array.");

const loaded = await request(`/api/characters/${created.id}`);
assert(loaded.name === created.name, "GET by id did not return the new character.");

const edited = await request(`/api/characters/${created.id}`, {
  method: "PATCH",
  body: {
    name: `CI 持久化测试角色 ${unique}（已编辑）`,
    personality: "角色人设已持久化更新。",
  },
});
assert(edited.name.endsWith("（已编辑）"), "PATCH did not update the character name.");
assert(edited.personality === "角色人设已持久化更新。", "PATCH did not update the character personality.");

const initialSettings = await request(`/api/characters/${created.id}/memory-settings`);
assert(initialSettings.snapshotIntervalDays === 8, "New character should get an 8-day default interval.");
assert(initialSettings.changePolicy === "NEXT_CYCLE", "New character should use NEXT_CYCLE by default.");

const savedSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 3,
    timezone: "America/Los_Angeles",
    anchorAt: new Date().toISOString(),
    rawMessageRetentionDays: 30,
    autoSnapshotEnabled: true,
    changePolicy: "IMMEDIATE_RECALC",
  },
});
assert(savedSettings.snapshotIntervalDays === 3, "Memory interval was not saved.");
assert(savedSettings.timezone === "America/Los_Angeles", "Timezone was not saved.");
assert(savedSettings.rawMessageRetentionDays === 30, "Message retention was not saved.");
assert(savedSettings.changePolicy === "IMMEDIATE_RECALC", "Change policy was not saved.");

const reloadedSettings = await request(`/api/characters/${created.id}/memory-settings`);
assert(reloadedSettings.snapshotIntervalDays === 3, "Memory interval did not persist after a new read.");
assert(reloadedSettings.autoSnapshotEnabled === true, "Auto-snapshot switch did not persist.");
assert(reloadedSettings.changePolicy === "IMMEDIATE_RECALC", "Change policy did not persist after a new read.");

const createdSnapshot = await request(`/api/characters/${created.id}/snapshots`, { method: "POST" });
assert(typeof createdSnapshot.id === "string", "POST snapshots must return the persisted snapshot id.");
assert(createdSnapshot.version === 1, "The first manual snapshot must be version 1.");

const snapshotList = await request(`/api/characters/${created.id}/snapshots`);
assert(Array.isArray(snapshotList) && snapshotList.length === 1, "GET snapshots must return the created snapshot.");
assert(snapshotList[0].id === createdSnapshot.id, "Snapshot list did not return the created snapshot.");
assert(snapshotList[0].status === "当前版本", "The first snapshot should be current.");
assert(snapshotList[0].messages === 0, "A snapshot without ingested messages must report zero source messages.");

const regeneratedSnapshot = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: createdSnapshot.id },
});
assert(typeof regeneratedSnapshot.id === "string" && regeneratedSnapshot.id !== createdSnapshot.id, "Regeneration must create a new snapshot version.");

const snapshotHistory = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotHistory.length === 2, "Regeneration must preserve the old snapshot version.");
assert(snapshotHistory.some((snapshot) => snapshot.id === createdSnapshot.id && snapshot.status === "已被替代"), "The previous snapshot must be marked as superseded.");
assert(snapshotHistory.some((snapshot) => snapshot.id === regeneratedSnapshot.id && snapshot.version === 2 && snapshot.status === "当前版本"), "The regenerated version must be current and increment to version 2.");

const latestList = await request("/api/characters");
assert(latestList.some((character) => character.id === created.id && character.name === edited.name), "Character changes did not appear in the list.");

console.log("Local API smoke test passed: character CRUD, memory settings persistence, manual snapshot create/read, and version regeneration.");
