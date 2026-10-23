<script setup lang="ts">
import {
  Activity,
  Bell,
  Brain,
  Calendar,
  ChatDotRound,
  DataBoard,
  Files,
  Search,
  Setting,
  Sparkles,
  User,
} from "@element-plus/icons-vue";

const route = useRoute();
const navigation = [
  { label: "总览", href: "/", icon: DataBoard, section: "工作空间" },
  { label: "角色管理", href: "/characters", icon: User },
  { label: "记忆驾驶舱", href: "/characters/big-fish", icon: Brain },
  { label: "周期快照", href: "/characters/big-fish/snapshots", icon: Calendar },
  { label: "渠道管理", href: "/channels", icon: ChatDotRound, section: "系统管理" },
  { label: "任务监控", href: "/tasks", icon: Activity, count: "2" },
  { label: "系统设置", href: "/settings", icon: Setting },
];

function isActive(href: string) {
  const path = route.path;
  if (href === "/") return path === "/";
  if (href === "/characters") return path === "/characters";
  if (href.includes("/snapshots")) return path.includes("/snapshots");
  if (href.includes("/characters/big-fish")) return path.startsWith("/characters/") && !path.includes("/snapshots") && !path.includes("/settings/");
  return path === href || path.startsWith(href + "/");
}
</script>

<template>
  <div class="app-grid">
    <aside class="sidebar">
      <div class="sidebar-top">
        <NuxtLink to="/" class="brand">
          <div class="brand-mark">羚</div>
          <div class="brand-wordmark">
            <div class="brand-title">羚枢 <span style="font-weight:500;color:#9ca3b5;letter-spacing:normal">Yiling</span></div>
            <div class="brand-subtitle">AI CHARACTER HUB</div>
          </div>
        </NuxtLink>
        <div class="workspace-pill">
          <div class="workspace-glyph"><el-icon><Sparkles /></el-icon></div>
          <div class="workspace-copy">
            <div class="workspace-name">个人工作空间</div>
            <div class="workspace-note">本地演示环境</div>
          </div>
        </div>
      </div>

      <nav class="sidebar-nav" aria-label="主导航">
        <template v-for="item in navigation" :key="item.href">
          <div v-if="item.section" class="sidebar-section">{{ item.section }}</div>
          <NuxtLink :to="item.href" class="sidebar-link" :class="{ active: isActive(item.href) }">
            <el-icon><component :is="item.icon" /></el-icon>
            <span class="sidebar-label">{{ item.label }}</span>
            <span v-if="item.count" class="nav-count">{{ item.count }}</span>
          </NuxtLink>
        </template>
      </nav>

      <div class="sidebar-bottom">
        <div class="admin-row">
          <div class="admin-avatar">你</div>
          <div class="admin-info sidebar-bottom-copy">
            <div class="admin-name">本地管理员</div>
            <div class="admin-note">开发预览</div>
          </div>
        </div>
        <div class="sidebar-version"><span>Yiling Hub · 预览版</span><span>v0.1</span></div>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <div class="topbar-search">
          <el-input placeholder="搜索角色、记忆、快照……" aria-label="搜索角色、记忆、快照" clearable>
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>
        <div class="topbar-right">
          <span class="env-indicator"><span class="env-dot" />本地环境</span>
          <el-button text circle aria-label="通知"><el-icon><Bell /></el-icon></el-button>
          <el-divider direction="vertical" />
          <div class="user-pill"><el-avatar :size="30">你</el-avatar><span>管理员</span></div>
        </div>
      </header>
      <main><slot /></main>
    </div>
  </div>
</template>
