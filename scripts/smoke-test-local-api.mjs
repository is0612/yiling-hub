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

const savedChatSettings = await request(`/api/characters/${created.id}`, {
  method: "PATCH",
  body: {
    chatApiBaseUrl: "http://127.0.0.1:4010/v1",
    chatApiKey: "ci-only",
    chatModel: "ci-character-model",
    chatTemperature: 0.4,
    chatMaxTokens: 1024,
  },
});
assert(savedChatSettings.chatModel === "ci-character-model", "Character model override did not round-trip.");
assert(savedChatSettings.chatTemperature === 0.4 && savedChatSettings.chatMaxTokens === 1024, "Character temperature/token settings did not round-trip.");
assert(savedChatSettings.chatApiBaseUrl === "http://127.0.0.1:4010/v1", "Character API Base URL did not round-trip.");
assert(savedChatSettings.chatApiKeyConfigured === true && savedChatSettings.chatApiKeySource === "character", "The character should report its encrypted API key as configured.");
assert(!Object.prototype.hasOwnProperty.call(savedChatSettings, "chatApiKey"), "The character DTO must never return an API key.");
const reloadedChatSettings = await request(`/api/characters/${created.id}`);
assert(reloadedChatSettings.chatModel === "ci-character-model" && reloadedChatSettings.chatMaxTokens === 1024, "Character-specific chat settings did not persist after reloading.");
assert(reloadedChatSettings.chatApiKeyConfigured === true && !Object.prototype.hasOwnProperty.call(reloadedChatSettings, "chatApiKey"), "The encrypted API Key must remain configured but never be returned.");
const apiTest = await request(`/api/characters/${created.id}/chat/test-connection`, { method: "POST" });
assert(apiTest.ok === true && apiTest.provider === "127.0.0.1", "API connection test should use the saved URL and decrypted API Key.");

const initialSettings = await request(`/api/characters/${created.id}/memory-settings`);
assert(initialSettings.snapshotIntervalDays === 8, "New character should get an 8-day default interval.");
assert(initialSettings.changePolicy === "NEXT_CYCLE", "New character should use NEXT_CYCLE by default.");

const schedulerAnchorAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const savedSettings = await request(`/api/characters/${created.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 3,
    timezone: "America/Los_Angeles",
    anchorAt: schedulerAnchorAt.toISOString(),
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

const historicalStart = new Date(schedulerAnchorAt.getTime() + 60 * 60 * 1000);
const historicalConversation = await request(`/api/characters/${created.id}/conversations/import`, {
  method: "POST",
  body: {
    title: `CI 历史周期对话 ${unique}`,
    messages: [
      { role: "USER", content: `历史周期用户消息 ${unique}`, occurredAt: historicalStart.toISOString() },
      { role: "ASSISTANT", content: `历史周期角色回复 ${unique}`, occurredAt: new Date(historicalStart.getTime() + 60 * 60 * 1000).toISOString() },
    ],
  },
});
assert(historicalConversation.timestampsEstimated === false, "Explicit historical timestamps should be preserved for the worker test.");

const workerResults = [];
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (!result.processed) break;
  workerResults.push(result);
}
assert(workerResults.some((result) => result.status === "SUCCEEDED" && typeof result.snapshotId === "string"), "Worker should generate a persisted structured snapshot for a period with messages.");
assert(workerResults.some((result) => result.status === "SKIPPED"), "Worker should skip empty overdue periods.");
const workerTaskList = await request("/api/tasks");
assert(workerTaskList.items.some((task) => task.status === "SUCCEEDED"), "Task API should show worker-completed tasks.");
assert(workerTaskList.items.some((task) => task.status === "SKIPPED"), "Task API should show skipped empty-period tasks.");
const snapshotsAfterWorker = await request(`/api/characters/${created.id}/snapshots`);
assert(snapshotsAfterWorker.length === 3, "Worker should add one automatic snapshot without rewriting the two manual snapshot versions.");
const aiSnapshot = snapshotsAfterWorker.find((snapshot) => snapshot.generatedBy === "llm");
assert(aiSnapshot && typeof aiSnapshot.id === "string", "Worker should create an AI-generated snapshot through the configured local model endpoint.");
assert(aiSnapshot.summary.includes("CI 模拟模型已分析"), "The saved snapshot should contain the model-generated period summary.");
assert(Array.isArray(aiSnapshot.analysis?.importantEvents) && aiSnapshot.analysis.importantEvents.length === 1, "The snapshot should persist structured AI event extraction and its evidence.");
const appliedAiMemory = aiSnapshot.analysis?.memoryChangesApplied.find((change) => change.result === "CREATED" && typeof change.memoryItemId === "string");
assert(appliedAiMemory?.memoryItemId, "The AI snapshot should report its persisted long-term memory change.");
const tracedAiMemory = await request(`/api/memories/${appliedAiMemory.memoryItemId}`);
assert(tracedAiMemory.sourceMessageId === tracedAiMemory.sourceMessage?.id, "Each AI-created memory should expose its direct original-message reference.");
assert(tracedAiMemory.sourceMessage?.role === "USER" && tracedAiMemory.sourceMessage.content.startsWith(`历史周期用户消息 ${unique}`), "The memory source should be the actual original dialogue, not an invented source ID.");
assert(tracedAiMemory.sourceSnapshotId === aiSnapshot.id && tracedAiMemory.sourceSnapshot?.id === aiSnapshot.id, "The AI memory should link back to the snapshot that produced it.");


const queuedAiRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: aiSnapshot.id, mode: "ai" },
});
assert(queuedAiRegeneration.queued === true && queuedAiRegeneration.status === "QUEUED", "AI regeneration should create a persisted queued worker task.");
const duplicateAiRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: aiSnapshot.id, mode: "ai" },
});
assert(duplicateAiRegeneration.jobId === queuedAiRegeneration.jobId && duplicateAiRegeneration.duplicate === true, "Repeated regeneration clicks should reuse the queued task.");

let aiRegenerationResult = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === queuedAiRegeneration.jobId) {
    aiRegenerationResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(aiRegenerationResult?.status === "SUCCEEDED" && typeof aiRegenerationResult.snapshotId === "string", "Worker should process the AI regeneration job.");
const snapshotsAfterAiRegeneration = await request(`/api/characters/${created.id}/snapshots`);
const regeneratedAiSnapshot = snapshotsAfterAiRegeneration.find((snapshot) => snapshot.id === aiRegenerationResult.snapshotId);
assert(regeneratedAiSnapshot?.kind === "AUTOMATIC" && regeneratedAiSnapshot.version === 2 && regeneratedAiSnapshot.status === "当前版本", "AI regeneration should create version 2 as the current automatic snapshot.");
assert(snapshotsAfterAiRegeneration.some((snapshot) => snapshot.id === aiSnapshot.id && snapshot.status === "已被替代"), "AI regeneration must preserve and supersede the original version.");
assert(regeneratedAiSnapshot.analysis?.memoryChangesApplied.some((change) => change.result === "NOT_APPLIED_REGENERATION"), "Regeneration should disclose proposed memory changes without silently applying them to current long-term memory.");

const queuedCancelableRegeneration = await request(`/api/characters/${created.id}/snapshots`, {
  method: "POST",
  body: { snapshotId: regeneratedAiSnapshot.id, mode: "ai" },
});
const canceledTask = await request(`/api/tasks/${queuedCancelableRegeneration.jobId}/cancel`, { method: "POST" });
assert(canceledTask.status === "CANCELLED", "Waiting tasks should be manually cancellable.");
const retriedTask = await request(`/api/tasks/${queuedCancelableRegeneration.jobId}/retry`, { method: "POST" });
assert(retriedTask.status === "QUEUED", "Cancelled snapshot tasks should be manually re-queued with attempts reset.");
let retriedRegenerationResult = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === queuedCancelableRegeneration.jobId) {
    retriedRegenerationResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(retriedRegenerationResult?.status === "SUCCEEDED", "Worker should process a manually re-queued regeneration task.");
const finalSnapshotHistory = await request(`/api/characters/${created.id}/snapshots`);
assert(finalSnapshotHistory.some((snapshot) => snapshot.id === retriedRegenerationResult.snapshotId && snapshot.version === 3 && snapshot.status === "当前版本"), "Retried regeneration should advance the same logical snapshot to version 3.");

const latestList = await request("/api/characters");
assert(latestList.some((character) => character.id === created.id && character.name === edited.name), "Character changes did not appear in the list.");

const chatReply = await request("/api/characters/" + created.id + "/chat", {
  method: "POST",
  body: { message: "请回忆一下历史周期用户消息 " + unique },
});
assert(typeof chatReply.conversationId === "string", "AI chat should persist a conversation.");
assert(chatReply.assistantMessage?.content?.includes("CI 模拟模型回复"), "Chat API should return the local mock model response.");
assert(Array.isArray(chatReply.assistantMessage?.sources?.memories), "Chat reply should expose validated memory source references.");
assert(chatReply.assistantMessage.sources.memories.length <= chatReply.retrieval.memoriesAvailable, "The chat should not cite more memory items than were retrieved.");
assert(chatReply.assistantMessage.sources.snapshots.length <= chatReply.retrieval.snapshotsAvailable, "The chat should not cite more snapshots than were retrieved.");
const chatHistory = await request("/api/characters/" + created.id + "/chat?conversationId=" + chatReply.conversationId);
assert(chatHistory.selectedConversationId === chatReply.conversationId, "GET chat should reopen the selected conversation.");
assert(chatHistory.messages.length === 2, "A new chat should persist one user message and one assistant reply.");
assert(chatHistory.messages[0].role === "USER" && chatHistory.messages[1].role === "ASSISTANT", "Persisted chat messages should keep their speaker roles.");
assert(chatHistory.messages[1].content === chatReply.assistantMessage.content, "Reopened chat should preserve the assistant reply.");

const renamedTitle = "CI 重命名会话 " + unique;
const renamedConversation = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { title: renamedTitle },
});
assert(renamedConversation.title === renamedTitle, "Conversation title PATCH should persist a renamed title.");
const renamedHistory = await request("/api/characters/" + created.id + "/chat?status=ACTIVE&q=" + encodeURIComponent(renamedTitle));
assert(renamedHistory.conversations.some((item) => item.id === chatReply.conversationId && item.title === renamedTitle), "Renamed title should be visible in history search.");

const searchedChats = await request("/api/characters/" + created.id + "/chat?status=ACTIVE&q=" + encodeURIComponent("历史周期用户消息"));
assert(searchedChats.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Chat history search should match message text, not only the conversation title.");
const archiveResult = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { status: "ARCHIVED" },
});
assert(archiveResult.status === "ARCHIVED", "Archiving a conversation should retain it with ARCHIVED status.");
const activeChatsAfterArchive = await request("/api/characters/" + created.id + "/chat");
assert(!activeChatsAfterArchive.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Archived conversations must be hidden from the active history list.");
const archivedChats = await request("/api/characters/" + created.id + "/chat?status=ARCHIVED&q=" + encodeURIComponent("历史周期用户消息"));
assert(archivedChats.conversations.some((conversation) => conversation.id === chatReply.conversationId), "Archived conversations should remain searchable and recoverable.");
const archivedHistory = await request("/api/characters/" + created.id + "/chat?status=ARCHIVED&conversationId=" + chatReply.conversationId);
assert(archivedHistory.selectedConversationId === chatReply.conversationId && archivedHistory.messages.length === 2, "Archived conversation history and messages must remain readable.");
const firstExportPage = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId + "?page=1&pageSize=1");
const secondExportPage = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId + "?page=2&pageSize=1");
assert(firstExportPage.total === 2 && firstExportPage.messages.length === 1 && firstExportPage.page === 1, "Transcript export should paginate the full conversation.");
assert(secondExportPage.total === 2 && secondExportPage.messages.length === 1 && secondExportPage.page === 2, "Transcript export should return subsequent messages with the total count.");
assert(firstExportPage.messages[0].role === "USER" && secondExportPage.messages[0].role === "ASSISTANT", "Transcript export pages should preserve chronological speaker order.");
const archivedSendResponse = await fetch(new URL("/api/characters/" + created.id + "/chat", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "不应写入归档会话", conversationId: chatReply.conversationId }),
});
assert(archivedSendResponse.status === 404, "Archived conversations must not accept new chat messages.");
const restoreResult = await request("/api/characters/" + created.id + "/chat/" + chatReply.conversationId, {
  method: "PATCH",
  body: { status: "ACTIVE" },
});
assert(restoreResult.status === "ACTIVE", "Restoring an archived conversation should make it active again.");
const restoredChat = await request("/api/characters/" + created.id + "/chat?conversationId=" + chatReply.conversationId);
assert(restoredChat.selectedConversationId === chatReply.conversationId && restoredChat.messages.length === 2, "Restored chat history must preserve its messages.");

// Isolated end-to-end retention check: only the expired message should be deleted.
const retentionCharacter = await request("/api/characters", {
  method: "POST",
  body: {
    name: "CI 消息保留策略测试 " + unique,
    alias: "CI 保留测试",
    description: "用于端到端验证过期原始消息清理。",
    personality: "仅用于自动化测试。",
  },
});
const dayMs = 24 * 60 * 60 * 1000;
const expiredAt = new Date(Date.now() - 60 * dayMs);
const retainedAt = new Date(Date.now() - 2 * dayMs);
const retentionConversation = await request(`/api/characters/${retentionCharacter.id}/conversations/import`, {
  method: "POST",
  body: {
    title: "CI 原始消息清理验收 " + unique,
    messages: [
      { role: "USER", content: "CI 过期原始消息 " + unique, occurredAt: expiredAt.toISOString() },
      { role: "ASSISTANT", content: "CI 应保留的近期消息 " + unique, occurredAt: retainedAt.toISOString() },
    ],
  },
});
const retentionSettings = await request(`/api/characters/${retentionCharacter.id}/memory-settings`, {
  method: "PATCH",
  body: {
    snapshotIntervalDays: 8,
    timezone: "America/Los_Angeles",
    anchorAt: new Date(Date.now() - 90 * dayMs).toISOString(),
    rawMessageRetentionDays: 30,
    autoSnapshotEnabled: false,
    changePolicy: "NEXT_CYCLE",
  },
});
assert(retentionSettings.rawMessageRetentionDays === 30 && retentionSettings.autoSnapshotEnabled === false, "Retention-only test character settings should persist without enabling automatic snapshots.");

await request("/api/tasks/scheduler/run", { method: "POST" });
const tasksBeforeCleanup = await request("/api/tasks?limit=100");
const retentionCleanupTask = tasksBeforeCleanup.items.find((task) =>
  task.characterId === retentionCharacter.id &&
  task.type === "CLEAN_EXPIRED_MESSAGES" &&
  task.status === "QUEUED"
);
assert(retentionCleanupTask && typeof retentionCleanupTask.id === "string", "Scheduler should enqueue a retention cleanup task for the isolated character.");

let retentionCleanupResult = null;
for (let attempt = 0; attempt < 10; attempt += 1) {
  const result = await request("/api/tasks/worker/run", { method: "POST" });
  if (result.jobId === retentionCleanupTask.id) {
    retentionCleanupResult = result;
    break;
  }
  if (!result.processed) break;
}
assert(retentionCleanupResult?.status === "SUCCEEDED", "Worker should execute the isolated raw-message retention cleanup.");

const retentionHistory = await request(
  `/api/characters/${retentionCharacter.id}/chat?conversationId=${retentionConversation.conversationId}`
);
assert(retentionHistory.messages.length === 1, "Cleanup should remove only the expired message from the imported conversation.");
assert(
  retentionHistory.messages[0].content === "CI 应保留的近期消息 " + unique,
  "Cleanup must preserve the recent message after removing the expired one."
);

const tasksAfterCleanup = await request("/api/tasks?limit=100");
const visibleCleanupTask = tasksAfterCleanup.items.find((task) => task.id === retentionCleanupTask.id);
assert(visibleCleanupTask?.status === "SUCCEEDED", "Task API should expose the completed cleanup state.");
assert(
  visibleCleanupTask.cleanupResult?.deletedMessageCount === 1,
  "Task API should read the actual deleted-message count from the cleanup audit record."
);
assert(
  typeof visibleCleanupTask.cleanupResult.cutoff === "string" &&
  Date.parse(visibleCleanupTask.cleanupResult.cutoff) > expiredAt.getTime() &&
  Date.parse(visibleCleanupTask.cleanupResult.cutoff) < retainedAt.getTime(),
  "Task API should expose the exact cutoff between the expired and retained messages."
);

console.log("Local API smoke test passed: character CRUD, encrypted per-character API settings and connection test, memory settings, transcript import, scheduler backfill, local-mock AI extraction, source-ID validation, persisted provenance, manual and AI snapshot versions, safe AI regeneration, task cancel/requeue, recycle-bin lifecycle, context-aware AI chat, conversation search/rename, archive/restore, archived write protection, and end-to-end raw-message retention cleanup with audit-result visibility.");
