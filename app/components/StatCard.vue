<script setup lang="ts">
withDefaults(defineProps<{
  label: string;
  value: string | number;
  note: string;
  symbol?: string;
  tone?: "purple" | "blue" | "green" | "amber";
}>(), { symbol: "✦", tone: "purple" });
</script>

<template>
  <div class="surface surface-hover stat-card">
    <div class="stat-top">
      <div class="stat-label">{{ label }}</div>
      <div class="stat-symbol" :class="tone">{{ symbol }}</div>
    </div>
    <div class="stat-bottom">
      <span class="stat-value">{{ value }}</span>
      <span class="stat-note">{{ note }}</span>
    </div>
  </div>
</template>
