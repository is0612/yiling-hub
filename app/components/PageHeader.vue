<script setup lang="ts">
import { computed } from "vue";

/**
 * 页面标题行 —— 对齐 bili-desk 的 .crumb + .page-h。
 * eyebrow 用「A / B」的写法，自动拆成面包屑，最后一段加粗。
 */
const props = defineProps<{ eyebrow?: string; title: string; description?: string }>();

const crumbs = computed(() =>
  (props.eyebrow ?? "").split("/").map((part) => part.trim()).filter(Boolean),
);
</script>

<template>
  <div>
    <div
      v-if="crumbs.length"
      class="crumb"
    >
      <template
        v-for="(part, index) in crumbs"
        :key="`${part}-${index}`"
      >
        <template v-if="index < crumbs.length - 1">
          <span>{{ part }}</span>
          <span>/</span>
        </template>
        <b v-else>{{ part }}</b>
      </template>
    </div>

    <div class="page-h">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="description">
          {{ description }}
        </p>
      </div>
      <div
        v-if="$slots.actions"
        class="ph-r"
      >
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
