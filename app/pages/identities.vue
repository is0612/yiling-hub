<script setup lang="ts">
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
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / 身份管理"
      title="跨平台身份"
      description="各平台外部用户跟角色互动时会被记录为「外部身份」。默认按平台隔离、不合并；管理员可显式把某个外部身份绑定到站内用户，打通跨平台私人记忆。"
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

    <div class="kpi-row is-three">
      <div class="kpi">
        <div class="k">
          全部外部身份
        </div>
        <div class="v">
          {{ identities.length }}<small>个</small>
        </div>
        <div class="foot">
          按平台隔离记录，同昵称不会自动合并
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          已绑定
        </div>
        <div class="v">
          {{ verifiedCount }}<small>个</small>
        </div>
        <div class="foot">
          私人记忆对该站内用户可读
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          待验证
        </div>
        <div class="v">
          {{ pendingCount }}<small>个</small>
        </div>
        <div class="foot">
          需要管理员显式绑定才生效
        </div>
      </div>
    </div>

    <div
      v-if="loading && !identities.length"
      class="identity-list"
    >
      <div
        v-for="i in 2"
        :key="'sk-' + i"
        class="card identity-card"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="sk"
          :style="{ height: n === 1 ? '36px' : '14px', width: n === 1 ? '58%' : '100%' }"
        />
      </div>
    </div>
    <div
      v-else-if="!identities.length"
      class="empty-block"
    >
      <span class="halo"><el-icon><User /></el-icon></span>
      <h4>还没有外部身份</h4>
      <p>角色在各平台产生互动后，这里会出现对应的外部用户记录。</p>
    </div>
    <div
      v-else
      class="identity-list"
    >
      <article
        v-for="identity in identities"
        :key="identity.id"
        class="card identity-card"
      >
        <div class="identity-head">
          <div class="identity-platform">
            {{ platformLabel(identity.platform) }}
          </div>
          <div class="identity-info">
            <div class="identity-name">
              {{ identity.displayName || identity.platformUid }}
            </div>
            <div class="identity-uid">
              {{ identity.platform }} · {{ identity.platformUid }}
            </div>
          </div>
          <span
            class="pill"
            :class="statusMap[identity.status]?.tone ?? 'pill-gray'"
          >{{ statusMap[identity.status]?.label ?? identity.status }}</span>
        </div>

        <div class="metric-row">
          <span>关联角色</span>
          <span class="metric-value">{{ identity.characters.map((c) => c.characterName).join("、") || "—" }}</span>
        </div>
        <div class="metric-row">
          <span>绑定用户</span>
          <span class="metric-value">{{ identity.linkedUsername || identity.linkedEmail || "未绑定" }}</span>
        </div>
        <div class="metric-row">
          <span>首次出现</span>
          <span class="metric-value">{{ formatDateTime(identity.createdAt) }}</span>
        </div>

        <div class="identity-actions">
          <button
            v-if="identity.status === 'UNVERIFIED'"
            type="button"
            class="btn sm"
            @click="openBind(identity)"
          >
            绑定到用户
          </button>
          <button
            v-if="identity.status === 'VERIFIED'"
            type="button"
            class="btn sm"
            @click="unlink(identity)"
          >
            解绑
          </button>
          <button
            v-if="identity.status !== 'REVOKED'"
            type="button"
            class="card-link is-danger"
            @click="revoke(identity)"
          >
            撤销身份
          </button>
        </div>
      </article>
    </div>

    <el-dialog
      v-model="bindVisible"
      title="绑定外部身份到用户"
      width="440px"
    >
      <p class="bind-hint">
        把「{{ bindTarget?.displayName || bindTarget?.platformUid }}」绑定到某个站内用户，之后该身份的私人记忆会在该用户与角色对话时被检索到。
      </p>
      <el-form label-position="top">
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
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.identity-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.identity-card{display:flex;flex-direction:column;gap:10px;padding:16px 18px}
.identity-head{display:flex;align-items:flex-start;gap:11px}
.identity-platform{display:flex;width:36px;height:36px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--brand-soft);color:var(--brand-strong);font-size:12px;font-weight:700}
.identity-info{min-width:0;flex:1}
.identity-name{overflow:hidden;color:var(--text);font-size:14px;font-weight:700;letter-spacing:-.01em;white-space:nowrap;text-overflow:ellipsis}
.identity-uid{margin-top:3px;color:var(--faint);font-size:12px;word-break:break-all}
.identity-card .metric-row{padding:9px 0}
.identity-actions{display:flex;align-items:center;gap:10px;margin-top:2px}
.identity-actions .card-link{margin-left:auto}
.card-link.is-danger{color:var(--red)}
.card-link.is-danger:hover{color:#b02338}

.bind-hint{margin:0 0 16px;color:var(--dim);font-size:12px;line-height:1.8}
@media(max-width:800px){.identity-list{grid-template-columns:1fr}}
</style>
