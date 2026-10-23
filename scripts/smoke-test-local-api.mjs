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

const initialTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(Array.isArray(initialTimeline) && initialTimeline.length === 0, "A new character should have an empty real timeline.");

const memoryContent = `CI 长期记忆 ${unique}：用户偏好简洁回答。`;
const createdMemory = await request(`/api/characters/${created.id}/memories`, {
  method: "POST",
  body: { category: "PREFERENCE", content: memoryContent },
});
assert(typeof createdMemory.id === "string", "POST memories must return the persisted memory id.");
assert(createdMemory.category === "PREFERENCE" && createdMemory.status === "ACTIVE", "Created memory should preserve its category and active status.");
const memoryDetail = await request(`/api/memories/${createdMemory.id}`);
assert(memoryDetail.content === memoryContent, "GET memory detail should return the full persisted content.");
const revisedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { category: "FACT", content: `CI 已修改记忆 ${unique}` },
});
assert(revisedMemory.category === "FACT" && revisedMemory.content === `CI 已修改记忆 ${unique}`, "PATCH should persist memory content and category.");
const archivedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "archived" },
});
assert(archivedMemory.status === "ARCHIVED", "Memory should support the archived status.");
const archivedTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(archivedTimeline.some((entry) => entry.id === `memory:${createdMemory.id}` && entry.tag === "已归档"), "Archived memory should remain in the timeline with its status.");
const invalidatedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "invalidated" },
});
assert(invalidatedMemory.status === "INVALIDATED", "Memory should support the invalidated status.");
const reactivatedMemory = await request(`/api/memories/${createdMemory.id}`, {
  method: "PATCH",
  body: { status: "active" },
});
assert(reactivatedMemory.status === "ACTIVE", "Archived or invalidated memory should be recoverable.");

const importedConversation = await request(`/api/characters/${created.id}/conversations/import`, {
  method: "POST",
  body: {
    title: `CI 对话导入 ${unique}`,
    messages: [
      { role: "USER", content: `用户问题 ${unique}` },
      { role: "ASSISTANT", content: `角色回复 ${unique}` },
      { role: "USER", content: `用户补充 ${unique}` },
    ],
  },
});
assert(typeof importedConversation.conversationId === "string", "Transcript import must return a conversation id.");
assert(importedConversation.messageCount === 3, "Transcript import must persist all messages in a transaction.");
assert(importedConversation.timestampsEstimated === true, "Plain transcript imports must disclose estimated timestamps.");

const importedTimeline = await request(`/api/characters/${created.id}/timeline`);
assert(importedTimeline.length === 4, "The timeline should include one memory and all three imported messages.");
assert(importedTimeline.some((entry) => entry.id === `memory:${createdMemory.id}` && entry.title === "事实记忆" && entry.summary.includes(`CI 已修改记忆 ${unique}`)), "Timeline must show the updated memory content and category.");
assert(importedTimeline.filter((entry) => entry.type === "message").length === 3, "Timeline must include all imported conversation messages.");
assert(importedTimeline.some((entry) => entry.summary.includes(`角色回复 ${unique}`)), "Timeline must include imported assistant content.");

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
    anchorAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
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
assert(reloadedSettings.nextSnapshotAt && new Date(reloadedSettings.nextSnapshotAt).getTime() < Date.now(), "An old anchor should preserve the first overdue cycle boundary for scheduler backfill.");

const schedulerRun = await request("/api/tasks/scheduler/run", { method: "POST" });
assert(schedulerRun.settingsChecked >= 1, "Scheduler should discover the enabled overdue character.");
assert(schedulerRun.jobsQueued >= 3 && schedulerRun.periodsConsidered >= 3, "Scheduler should enqueue missed 3-day periods after downtime.");
const taskList = await request("/api/tasks");
assert(taskList.total >= 3 && taskList.items.filter((task) => task.characterId === created.id && task.type === "GENERATE_SNAPSHOT" && task.status === "QUEUED").length >= 3, "Task API should expose the persisted scheduled jobs.");
const repeatedSchedulerRun = await request("/api/tasks/scheduler/run", { method: "POST" });
assert(repeatedSchedulerRun.jobsQueued === 0, "A repeated scheduler scan should not enqueue duplicate work.");
const scheduledNextSnapshotAt = (await request(`/api/characters/${created.id}/memory-settings`)).nextSnapshotAt;

const createdSnapshot = await request(`/api/characters/${created.id}/snapshots`, { method: "POST" });
assert(typeof createdSnapshot.id === "string", "POST snapshots must return the persisted snapshot id.");
assert(createdSnapshot.version === 1, "The first manual snapshot must be version 1.");
const settingsAfterManualSnapshot = await request(`/api/characters/${created.id}/memory-settings`);
assert(settingsAfterManualSnapshot.nextSnapshotAt === scheduledNextSnapshotAt, "Manual snapshots must not reset the automatic schedule.");

const snapshotList = await request(`/api/characters/${created.id}/snapshots`);
assert(Array.isArray(snapshotList) && snapshotList.length === 1, "GET snapshots must return the created snapshot.");
assert(snapshotList[0].id === createdSnapshot.id, "Snapshot list did not return the created snapshot.");
assert(snapshotList[0].status === "当前版本", "The first snapshot should be current.");
assert(snapshotList[0].messages === 3, "A manual snapshot should link the three persisted messages in its time range.");

const regeneratedSnapshot = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: createdSnapshot.id },
});
assert(typeof regeneratedSnapshot.id === "string" && regeneratedSnapshot.id !== createdSnapshot.id, "Regeneration must create a new snapshot version.");

const snapshotHistory = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotHistory.length === 2, "Regeneration must preserve the old snapshot version.");
assert(snapshotHistory.some((snapshot) => snapshot.id === createdSnapshot.id && snapshot.status === "已被替代"), "The previous snapshot must be marked as superseded.");
assert(snapshotHistory.some((snapshot) => snapshot.id === regeneratedSnapshot.id && snapshot.version === 2 && snapshot.status === "当前版本"), "The regenerated version must be current and increment to version 2.");

const timelineAfterSnapshots = await request(`/api/characters/${created.id}/timeline`);
assert(Array.isArray(timelineAfterSnapshots) && timelineAfterSnapshots.length === 6, "The real timeline should include the saved memory, three messages, and both snapshot versions.");
assert(timelineAfterSnapshots.some((entry) => entry.id === `snapshot:${createdSnapshot.id}` && entry.type === "snapshot" && entry.tag === "已被替代"), "The timeline should show superseded snapshot versions.");
assert(timelineAfterSnapshots.some((entry) => entry.id === `snapshot:${regeneratedSnapshot.id}` && entry.type === "snapshot" && entry.tag === "当前版本"), "The timeline should show the current snapshot version.");

const trashedMemory = await request(`/api/memories/${createdMemory.id}/trash`, { method: "POST" });
assert(trashedMemory.status === "TRASHED" && trashedMemory.statusBeforeTrash === "ACTIVE", "Moving a memory to trash should retain its prior status.");
assert(typeof trashedMemory.deletedAt === "string", "Trashed memory should record its deletion time.");
const trashList = await request(`/api/characters/${created.id}/memories/trash`);
assert(trashList.some((memory) => memory.id === createdMemory.id && memory.content === `CI 已修改记忆 ${unique}`), "Recycle-bin API should return the soft-deleted memory.");
const timelineWithoutTrashedMemory = await request(`/api/characters/${created.id}/timeline`);
assert(!timelineWithoutTrashedMemory.some((entry) => entry.id === `memory:${createdMemory.id}`), "Trashed memories must not appear in the active timeline.");
assert(timelineWithoutTrashedMemory.length === 5, "Moving a memory to trash should preserve messages and both snapshot versions.");

const restoredFromTrash = await request(`/api/memories/${createdMemory.id}/restore`, { method: "POST" });
assert(restoredFromTrash.status === "ACTIVE" && restoredFromTrash.statusBeforeTrash === null && restoredFromTrash.deletedAt === null, "Restoring a memory should return it to its prior status and clear trash metadata.");
assert((await request(`/api/characters/${created.id}/memories/trash`)).every((memory) => memory.id !== createdMemory.id), "Restored memory should disappear from the recycle bin.");
assert((await request(`/api/characters/${created.id}/timeline`)).some((entry) => entry.id === `memory:${createdMemory.id}`), "Restored memory should return to the timeline.");

await request(`/api/memories/${createdMemory.id}/trash`, { method: "POST" });
const permanentDelete = await request(`/api/memories/${createdMemory.id}`, { method: "DELETE" });
assert(permanentDelete.permanentlyDeleted === true, "Permanent deletion should remove the current memory item.");
assert(permanentDelete.snapshotsPreserved === true && permanentDelete.preservedSnapshotReferences >= 2, "Permanent deletion must preserve historical snapshot source records.");
const finalTrashList = await request(`/api/characters/${created.id}/memories/trash`);
assert(finalTrashList.every((memory) => memory.id !== createdMemory.id), "Permanently deleted memory should no longer exist in the recycle bin.");
const timelineAfterPermanentDelete = await request(`/api/characters/${created.id}/timeline`);
assert(!timelineAfterPermanentDelete.some((entry) => entry.id === `memory:${createdMemory.id}`), "Permanently deleted memory should not appear in the timeline.");
const snapshotsAfterPermanentDelete = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotsAfterPermanentDelete.length === 2, "Permanent deletion must not rewrite or remove existing snapshot versions.");
const missingMemoryResponse = await fetch(new URL(`/api/memories/${createdMemory.id}`, baseUrl));
assert(missingMemoryResponse.status === 404, "Permanently deleted memory should no longer be addressable.");

const latestList = await request("/api/characters");
assert(latestList.some((character) => character.id === created.id && character.name === edited.name), "Character changes did not appear in the list.");

console.log("Local API smoke test passed: character CRUD, memory settings, manual memory creation, transcript import, database-backed timeline, snapshot source/version persistence, recycle-bin restore, and permanent deletion with historical snapshot preservation.");
