<script setup lang="ts">
/**
 * 跨平台身份。
 *
 * 内容排序：① 有几个身份、几个打通了（统计带）② 每个身份的归属与动作。
 * 卡片头用「首字头像 + 平台·UID」，不再用平台名塞进 36px 方块 ——「QQ 小号」四个字在里面会折成三行。
 * 三个字段改成左对齐的释义行（label 定宽 + 值紧随），不再用三条描边横线夹住右对齐的值。
 */
import { Refresh, User } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type ExternalIdentity = {
  id: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: "UNVERIFIED" | "VERIFIED" | "REVOKED";
  linkedUserId: string | null;
  linkedUsername: string | null;
  linkedEmail: string | null;
  verifiedAt: string | null;
  createdAt: string;
  characters: Array<{ characterId: string; characterName: string }>;
};

type AdminUser = { id: string; username: string; email: string | null; displayName: string | null };

const loading = ref(true);
const identities = ref<ExternalIdentity[]>([]);
const users = ref<AdminUser[]>([]);
const saving = ref(false);
const bindVisible = ref(false);
const bindTarget = ref<ExternalIdentity | null>(null);
const bindUserId = ref("");

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function platformLabel(platform: string) {
  if (platform === "bili") return "B站";
  if (platform === "qq-onebot") return "QQ 小号";
  if (platform === "wechat") return "微信";
  return platform;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 头像只放一个字：昵称取首字，没有昵称就取 UID 首位。 */
function initialOf(identity: ExternalIdentity) {
  const source = identity.displayName || identity.platformUid || "?";
  return Array.from(source)[0] ?? "?";
}

const statusMap: Record<string, { label: string; tone: string }> = {
  UNVERIFIED: { label: "未验证", tone: "pill-gray" },
  VERIFIED: { label: "已绑定", tone: "pill-green" },
  REVOKED: { label: "已撤销", tone: "pill-rose" },
};

const verifiedCount = computed(() => identities.value.filter((item) => item.status === "VERIFIED").length);
const pendingCount = computed(() => identities.value.filter((item) => item.status === "UNVERIFIED").length);

async function loadIdentities() {
  loading.value = true;
  try {
    const response = await $fetch<{ identities: ExternalIdentity[] }>("/api/admin/identities");
    identities.value = response.identities;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取外部身份列表。"));
  } finally {
    loading.value = false;
  }
}

async function loadUsers() {
  try {
    const response = await $fetch<{ users: AdminUser[] }>("/api/admin/users");
    users.value = response.users;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取用户列表。"));
  }
}

function openBind(identity: ExternalIdentity) {
  bindTarget.value = identity;
  bindUserId.value = "";
  bindVisible.value = true;
}

async function submitBind() {
  if (saving.value || !bindTarget.value) return;
  if (!bindUserId.value) {
    ElMessage.warning("请选择要绑定的站内用户。");
    return;
  }
  saving.value = true;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(bindTarget.value.id)}/verify`, {
      method: "POST",
      body: { userId: bindUserId.value },
    });
    ElMessage.success("已绑定。该外部身份的私人记忆现在对该用户可读。");
    bindVisible.value = false;
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

async function unlink(identity: ExternalIdentity) {
  const confirmed = await ElMessageBox.confirm(
    `解绑后「${identity.displayName || identity.platformUid}」的私人记忆不再对该用户可读，确定？`,
    "解绑身份",
    { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(identity.id)}/unlink`, { method: "POST" });
    ElMessage.success("已解绑。");
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
  }
}

async function revoke(identity: ExternalIdentity) {
  const confirmed = await ElMessageBox.confirm(
    `撤销后「${identity.displayName || identity.platformUid}」的私人记忆不再参与任何检索（数据保留），确定？`,
    "撤销身份",
    { confirmButtonText: "撤销", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(identity.id)}/revoke`, { method: "POST" });
    ElMessage.success("已撤销。");
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "撤销失败，请稍后重试。"));
  }
}

onMounted(async () => {
  await Promise.all([loadIdentities(), loadUsers()]);
});
</script>

<template>
  <div class="page-wrap idt-a">
    <PageHeader
      eyebrow="系统管理 / 身份管理"
      title="跨平台身份"
      description="各平台的外部用户跟角色互动时会被记为「外部身份」。默认按平台隔离、不合并；绑定到站内用户后，跨平台的私人记忆才会打通。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadIdentities"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </template>
    </PageHeader>

    <!-- 空的时候不摆一排 0：统计带说的就是「有几个」，没有就没有 -->
    <div
      v-if="identities.length"
      class="band"
    >
      <div class="band-cell">
        <span class="band-k">全部外部身份</span>
        <span class="band-v">{{ identities.length }}<small>个</small></span>
        <span class="band-f">按平台隔离记录，同昵称不会自动合并</span>
      </div>
      <div class="band-cell">
        <span class="band-k">已绑定</span>
        <span class="band-v">{{ verifiedCount }}<small>个</small></span>
        <span class="band-f">私人记忆对该站内用户可读</span>
      </div>
      <div class="band-cell">
        <span class="band-k">待验证</span>
        <span class="band-v">{{ pendingCount }}<small>个</small></span>
        <span class="band-f">需要管理员显式绑定才生效</span>
      </div>
    </div>

    <div
      v-if="loading && !identities.length"
      class="identity-grid"
    >
      <div
        v-for="i in 2"
        :key="'sk-' + i"
        class="identity-card is-skeleton"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="sk"
          :style="{ height: n === 1 ? '32px' : '14px', width: n === 1 ? '58%' : '100%' }"
        />
      </div>
    </div>

    <div
      v-else-if="!identities.length"
      class="empty-block"
    >
      <span class="empty-icon"><el-icon><User /></el-icon></span>
      <h3>还没有外部身份</h3>
      <p>角色在 B站、QQ 等平台产生互动后，这里会出现对应的外部用户记录，再手动绑定到站内账号。</p>
    </div>

    <div
      v-else
      class="identity-grid"
    >
      <article
        v-for="identity in identities"
        :key="identity.id"
        class="identity-card"
      >
        <div class="idt-head">
          <span class="idt-avatar">{{ initialOf(identity) }}</span>
          <div class="idt-id">
            <h3 class="idt-name">
              {{ identity.displayName || identity.platformUid }}
            </h3>
            <p class="idt-sub">
              {{ platformLabel(identity.platform) }}<span class="sep">·</span>{{ identity.platformUid }}
            </p>
          </div>
          <span
            class="pill"
            :class="statusMap[identity.status]?.tone ?? 'pill-gray'"
          >{{ statusMap[identity.status]?.label ?? identity.status }}</span>
        </div>

        <dl class="idt-kv">
          <div>
            <dt>关联角色</dt>
            <dd>{{ identity.characters.map((c) => c.characterName).join("、") || "—" }}</dd>
          </div>
          <div>
            <dt>绑定用户</dt>
            <dd :class="{ 'is-muted': !identity.linkedUsername && !identity.linkedEmail }">
              {{ identity.linkedUsername || identity.linkedEmail || "未绑定" }}
            </dd>
          </div>
          <div>
            <dt>首次出现</dt>
            <dd>{{ formatDateTime(identity.createdAt) }}</dd>
          </div>
        </dl>

        <div class="idt-foot">
          <button
            v-if="identity.status !== 'REVOKED'"
            type="button"
            class="tlink is-danger"
            @click="revoke(identity)"
          >
            撤销身份
          </button>
          <span class="grow" />
          <button
            v-if="identity.status === 'UNVERIFIED'"
            type="button"
            class="abtn is-lead"
            @click="openBind(identity)"
          >
            绑定到用户
          </button>
          <button
            v-if="identity.status === 'VERIFIED'"
            type="button"
            class="abtn"
            @click="unlink(identity)"
          >
            解绑
          </button>
        </div>
      </article>
    </div>

    <el-dialog
      v-model="bindVisible"
      title="绑定外部身份到用户"
      width="440px"
    >
      <p class="dlg-lead">
        把「{{ bindTarget?.displayName || bindTarget?.platformUid }}」绑到某个站内用户，之后该身份的私人记忆会在该用户与角色对话时被检索到。
      </p>
      <el-form
        label-position="top"
        class="dlg-form"
      >
        <el-form-item label="站内用户">
          <el-select
            v-model="bindUserId"
            placeholder="选择要绑定的用户"
            style="width:100%"
          >
            <el-option
              v-for="user in users"
              :key="user.id"
              :label="user.displayName || user.email || user.username"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dlg-foot">
          <span class="dlg-foot-note">绑定立刻生效，随时可以解绑</span>
          <span class="dlg-foot-actions">
            <el-button @click="bindVisible = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="saving"
              @click="submitBind"
            >
              绑定
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影。全部规则挂在 .idt-a 下（作用域 + 压过 main.css 单类规则）。 */
.idt-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.idt-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }

/* 统计带：三格数字并进一张白砖，脚注静音 */
.band {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 24px;
  margin-bottom: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 20px 17px;
}
.band-cell { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.band-k { color: var(--dim); font-size: 12px; }
.band-v { color: var(--text); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.25; }
.band-v small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; letter-spacing: 0; }
.band-f { overflow: hidden; color: var(--dim); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }

/* 上限 620：只剩一张卡时不要被拉到整行宽 —— 三行释义会被中间的空白拉散 */
.identity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 620px)); justify-content: start; gap: var(--sp-4); align-items: start; }
.identity-card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 18px 12px;
}
.identity-card.is-skeleton { gap: 10px; padding-bottom: 18px; }

.idt-head { display: flex; align-items: flex-start; gap: 11px; }
/* 首字头像：比「平台名塞进方块」稳 —— 平台名长短不一，四个字就会折行 */
.idt-avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 16px;
  font-weight: 700;
}
.idt-id { min-width: 0; flex: 1; }
.idt-name { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.idt-sub { margin: 2px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.idt-sub .sep { margin: 0 5px; color: var(--faint); }

/* 释义行：label 定宽 56px，值紧跟在后（原来值被推到最右，中间空一大片） */
.idt-kv { display: flex; flex-direction: column; gap: 7px; margin: 14px 0 0; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.idt-kv > div { display: flex; gap: 10px; align-items: baseline; }
.idt-kv dt { flex: 0 0 56px; color: var(--dim); font-size: 12px; }
.idt-kv dd { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.idt-kv dd.is-muted { color: var(--dim); font-weight: 500; }

.idt-foot { display: flex; align-items: center; gap: 4px; margin-top: 12px; border-top: 1px solid var(--surface-3); padding-top: 8px; }
.idt-foot .grow { flex: 1; }

.abtn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 8px;
  background: none;
  padding: 0 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn:hover { background: var(--surface-2); color: var(--brand-strong); }
.abtn.is-lead { background: var(--surface-2); }
.abtn.is-lead:hover { background: var(--brand-soft); }

/* 危险动作常态灰、hover 才红 */
.tlink {
  display: inline-flex;
  height: 28px;
  align-items: center;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 7px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.tlink.is-danger:hover { background: var(--red-soft); color: var(--red); }

/* 空态：居中白砖 + 圆形图标，不用虚线框 */
.empty-block {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--surface);
  padding: 32px 24px;
  text-align: center;
}
.empty-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.empty-block h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.empty-block p { max-width: 440px; margin: 8px 0 0; color: var(--dim); font-size: 14px; line-height: 1.75; }

/* 弹窗 */
.dlg-lead { margin: 0 0 14px; color: var(--dim); font-size: 12px; line-height: 1.75; }
.dlg-form :deep(.el-form-item) { margin-bottom: 0; }
.dlg-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dlg-foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.dlg-foot-actions { display: flex; }

@media (max-width: 860px) {
  .identity-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  /* 三个数字仍排一行，脚注收掉 */
  .band { gap: 0 12px; padding: 14px 16px 15px; }
  .band-f { display: none; }
}
@media (max-width: 560px) {
  .dlg-foot { flex-direction: column-reverse; align-items: stretch; }
  .dlg-foot-actions { justify-content: flex-end; }
  .dlg-foot-note { text-align: center; }
}
</style>
