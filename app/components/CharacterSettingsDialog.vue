<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Cpu, Connection } from "@element-plus/icons-vue";
import type { Character } from "~/utils/mock-data";

/**
 * 只要求组件真正用到的字段 —— 详情页传完整 Character，聊天页传的是精简的
 * ChatCharacter（没有 personality），两边都能直接用，不用在调用处做类型转换。
 */
type SettingsCharacter = {
  id: string;
  name: string;
  personality?: string;
  chatModel?: string;
  chatTemperature?: number;
  chatMaxTokens?: number;
  chatApiBaseUrl?: string;
  chatApiKeySource?: "character" | "environment" | "missing";
};

/**
 * 角色设置：角色资料 + 模型参数。
 * 详情页和聊天页共用这一个弹窗 —— 之前模型参数只在聊天页右上角能改，
 * 角色资料只在详情页能改，两处两套表单。合并后只有一个入口来源。
 */
const props = defineProps<{
  modelValue: boolean;
  character: SettingsCharacter | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [character: Character];
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const saving = ref(false);
const testing = ref(false);
const draftName = ref("");
const draftPersonality = ref("");
const draftChatModel = ref("");
const draftChatTemperature = ref(0.7);
const draftChatMaxTokens = ref(1800);
const draftChatApiBaseUrl = ref("");
const draftChatApiKey = ref("");
const clearSavedApiKey = ref(false);

/** 每次打开都从当前角色重新灌一遍草稿，避免上次没保存的残值留下来 */
watch(open, (isOpen) => {
  if (!isOpen) return;
  const current = props.character;
  draftName.value = current?.name ?? "";
  draftPersonality.value = current?.personality ?? "";
  draftChatModel.value = current?.chatModel ?? "";
  draftChatTemperature.value = current?.chatTemperature ?? 0.7;
  draftChatMaxTokens.value = current?.chatMaxTokens ?? 1800;
  draftChatApiBaseUrl.value = current?.chatApiBaseUrl ?? "https://api.openai.com/v1";
  draftChatApiKey.value = "";
  clearSavedApiKey.value = false;
}, { immediate: true });

const apiKeySource = computed(() => props.character?.chatApiKeySource ?? "missing");
const apiKeyPlaceholder = computed(() => {
  if (apiKeySource.value === "character") return "已加密保存；留空表示保持不变";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key；填写可覆盖";
  return "请填写 API Key";
});
const apiKeyHint = computed(() => {
  if (apiKeySource.value === "character") return "此角色已保存 API Key。留空可保持现有 Key，不会在网页中显示原文。";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key。输入新 Key 后会为本角色单独保存。";
  return "Key 只会提交到本机服务端，并使用 AES-256-GCM 加密后保存；不会回传给网页。";
});

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

async function save(keepOpen = false): Promise<boolean> {
  if (saving.value || !props.character) return false;
  saving.value = true;
  try {
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(props.character.id)}`, {
      method: "PATCH",
      body: {
        name: draftName.value.trim() || props.character.name,
        personality: draftPersonality.value.trim(),
        chatModel: draftChatModel.value.trim(),
        chatTemperature: draftChatTemperature.value,
        chatMaxTokens: draftChatMaxTokens.value,
        chatApiBaseUrl: draftChatApiBaseUrl.value.trim(),
        chatApiKey: draftChatApiKey.value,
        clearApiKey: clearSavedApiKey.value && !draftChatApiKey.value.trim(),
      },
    });
    draftChatApiKey.value = "";
    clearSavedApiKey.value = false;
    emit("saved", updated);
    if (!keepOpen) {
      open.value = false;
      ElMessage.success("角色设置已保存。");
    }
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
    return false;
  } finally {
    saving.value = false;
  }
}

/** 测试要拿服务端已存的配置去连，所以先保存再测 */
async function testConnection() {
  if (testing.value || saving.value || !props.character) return;
  testing.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(
      `/api/characters/${encodeURIComponent(props.character.id)}/chat/test-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message || "API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(readError(error, "API 连通性测试失败，请检查地址、Key 和模型名称。"));
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="角色设置"
    width="min(600px, 94vw)"
    destroy-on-close
  >
    <el-form label-position="top">
      <!-- 角色资料 -->
      <div class="cs-section">
        <div class="cs-title">
          角色资料
        </div>
        <el-form-item label="角色名称">
          <el-input
            v-model="draftName"
            maxlength="40"
            placeholder="给这个角色起个名字"
          />
        </el-form-item>
        <el-form-item label="基础人设">
          <el-input
            v-model="draftPersonality"
            type="textarea"
            :rows="4"
            placeholder="角色的性格、说话方式、行为规则……"
          />
        </el-form-item>
      </div>

      <!-- 模型参数 -->
      <div class="cs-section">
        <div class="cs-title">
          <el-icon><Cpu /></el-icon>模型参数
        </div>
        <el-form-item
          label="API 地址"
          required
        >
          <el-input
            v-model="draftChatApiBaseUrl"
            maxlength="500"
            placeholder="https://api.deepseek.com/v1"
          />
          <p class="cs-hint">
            填 API 根地址，不要追加 /chat/completions。必须 HTTPS；HTTP 仅允许本机地址。
          </p>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="draftChatApiKey"
            type="password"
            show-password
            autocomplete="new-password"
            maxlength="8192"
            :placeholder="apiKeyPlaceholder"
          />
          <p class="cs-hint">
            {{ apiKeyHint }}
          </p>
          <el-checkbox
            v-if="apiKeySource === 'character'"
            v-model="clearSavedApiKey"
          >
            移除此角色单独保存的 API Key
          </el-checkbox>
        </el-form-item>
        <el-form-item
          label="模型名称"
          required
        >
          <el-input
            v-model="draftChatModel"
            maxlength="120"
            show-word-limit
            placeholder="例如 deepseek-chat、gpt-4o-mini"
          />
        </el-form-item>
        <el-form-item label="温度">
          <el-slider
            v-model="draftChatTemperature"
            :min="0"
            :max="2"
            :step="0.1"
            show-input
          />
          <p class="cs-hint">
            越低越稳定、越像在照本宣科；越高越发散，也越容易跑题。
          </p>
        </el-form-item>
        <el-form-item label="最大输出 Token">
          <el-input-number
            v-model="draftChatMaxTokens"
            :min="256"
            :max="8192"
            :step="256"
          />
          <p class="cs-hint">
            数值越大，回复可能越长，单次请求的消耗也越高。
          </p>
        </el-form-item>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="open = false">
        取消
      </el-button>
      <el-button
        :loading="testing"
        :disabled="saving || testing"
        @click="void testConnection()"
      >
        <el-icon><Connection /></el-icon>保存并测试
      </el-button>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="testing"
        @click="void save()"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cs-section + .cs-section {
  margin-top: 22px;
  border-top: 1px solid var(--surface-3);
  padding-top: 18px;
}
.cs-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .02em;
}
.cs-title .el-icon {
  color: var(--dim);
  font-size: 14px;
}
.cs-hint {
  /* el-form-item__content 是 flex 容器，input-number 这种窄控件后面
     提示文字会跟在同一行走 —— 强制占满整行才会落到下方 */
  width: 100%;
  margin: 6px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
}
</style>
