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
    try {
      const response = await fetch(new URL("/api/characters", baseUrl));
      if (response.status === 200) return;
      lastError = `API returned HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
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

const latestList = await request("/api/characters");
assert(latestList.some((character) => character.id === created.id && character.name === edited.name), "Character changes did not appear in the list.");

console.log("Local API smoke test passed: create/read/update character, create memory scope, save/reload memory settings.");
