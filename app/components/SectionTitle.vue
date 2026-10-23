<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="section-title">
    <div>
      <h2 class="section-heading">{{ title }}</h2>
      <p v-if="description" class="section-description">{{ description }}</p>
    </div>
    <slot name="action" />
  </div>
</template>
