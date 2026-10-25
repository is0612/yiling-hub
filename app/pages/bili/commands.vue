<script setup lang="ts">
/**
 * 「B站命令」已合并进「B站值班台」(/bili)。
 * 这个路由保留成跳转，避免旧书签或外部链接 404，并把命令 id 透传过去。
 */
const route = useRoute();
const cmd = typeof route.query.cmd === "string" ? route.query.cmd : "";
await navigateTo({ path: "/bili", query: cmd ? { cmd } : {} }, { replace: true });
</script>

<template>
  <div />
</template>
