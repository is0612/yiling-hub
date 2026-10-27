<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";

/**
 * 编辑角色资料：名称 / 简介 / 人设。
 *
 * 模型参数、API Key 已经搬到 `/characters/[id]/settings/model` 独立页面 —— 九字段全塞弹窗时，
 * 一屏装不下，而 el-dialog 滚动的是整层遮罩，打开后连保存按钮都在视野外。
 */
type ProfileCharacter = {
  id: string;
  name: string;
  /** 可选：调用方若没有该字段，就不提交，避免把库里的简介清空 */
  description?: string;
  personality?: string;
};

const props = defineProps<{
  modelValue: boolean;
  character: ProfileCharacter | null;
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
const draftName = ref("");
const draftDescription = ref("");
const draftPersonality = ref("");

/** 每次打开都从当前角色重新灌一遍草稿，避免上次没保存的残值留下来 */
watch(open, (isOpen) => {
  if (!isOpen) return;
  const current = props.character;
  draftName.value = current?.name ?? "";
  draftDescription.value = current?.description ?? "";
  draftPersonality.value = current?.personality ?? "";
}, { immediate: true });

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

async function save() {
  if (saving.value || !props.character) return;
  const name = draftName.value.trim();
  if (!name) {
    ElMessage.warning("请先填写角色名称。");
    return;
  }
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      name,
      personality: draftPersonality.value.trim(),
    };
    if (props.character.description !== undefined) {
      body.description = draftDescription.value.trim();
    }
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(props.character.id)}`, {
      method: "PATCH",
      body,
    });
    emit("saved", updated);
    open.value = false;
    ElMessage.success("角色资料已保存。");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="编辑角色资料"
    width="min(560px, 94vw)"
    destroy-on-close
  >
    <el-form
      label-position="top"
      @submit.prevent="save"
    >
      <el-form-item
        label="角色名称"
        required
      >
        <el-input
          v-model="draftName"
          maxlength="40"
          show-word-limit
          placeholder="给这个角色起个名字"
        />
      </el-form-item>
      <el-form-item label="角色简介">
        <el-input
          v-model="draftDescription"
          type="textarea"
          :rows="2"
          maxlength="2000"
          placeholder="用一句话描述角色的个性或定位。"
        />
      </el-form-item>
      <el-form-item label="基础人设">
        <el-input
          v-model="draftPersonality"
          type="textarea"
          :rows="5"
          placeholder="角色的性格、说话方式、行为规则……"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="open = false">
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="saving"
        @click="save"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>
