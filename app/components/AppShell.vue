<script setup lang="ts">
import type { Component } from "vue";
import {
  DataAnalysis,
  Bell,
  Cpu,
  Calendar,
  ChatDotRound,
  DataBoard,
  Search,
  Setting,
  SwitchButton,
  User,
  UserFilled,
  Connection,
  VideoPlay,
} from "@element-plus/icons-vue";

const route = useRoute();
const { displayName, logout, isLocalDevIdentity, isAdmin } = useAuthSession();
const loggingOut = ref(false);
const avatarLetter = computed(() => (displayName.value || "管").slice(0, 1));
const roleLabel = computed(() =>
  isLocalDevIdentity.value ? "本地开发身份" : isAdmin.value ? "已登录管理员" : "已登录用户",
);

async function handleLogout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await logout();
  } finally {
    loggingOut.value = false;
  }
}
type NavigationItem = {
  key: string;
  label: string;
  href: string;
  icon: Component;
  section?: string;
  count?: string;
};

const activeCharacterId = useActiveCharacterId();

// 首屏就取到角色列表，避免侧边栏角色入口先指向列表页再跳变。
await useCharacterListData();

/**
 * 角色相关的入口必须指向数据库里的真实角色 id；
 * 未取到角色时退回角色列表，由用户在列表里新建或选择。
 */
const navigation = computed<NavigationItem[]>(() => {
  const id = activeCharacterId.value;
  const items: NavigationItem[] = [
    { key: "home", label: "总览", href: "/", icon: DataBoard, section: "工作空间" },
    { key: "characters", label: "角色管理", href: "/characters", icon: User },
    {
      key: "memory",
      label: "记忆驾驶舱",
      href: id ? `/characters/${id}` : "/characters",
      icon: Cpu,
    },
    {
      key: "chat",
      label: "AI 对话",
      href: id ? "/characters/" + id + "/chat" : "/characters",
      icon: ChatDotRound,
    },
    {
      key: "snapshots",
      label: "阶段总结",
      href: id ? `/characters/${id}/snapshots` : "/characters",
      icon: Calendar,
    },
  ];
  if (isAdmin.value) {
    items.push(
      { key: "channels", label: "渠道管理", href: "/channels", icon: ChatDotRound, section: "系统管理" },
      { key: "bili", label: "B站值班台", href: "/bili", icon: VideoPlay },
      { key: "tasks", label: "任务监控", href: "/tasks", icon: DataAnalysis },
      { key: "identities", label: "身份管理", href: "/identities", icon: Connection },
      { key: "users", label: "用户管理", href: "/users", icon: UserFilled },
      { key: "settings", label: "系统设置", href: "/settings", icon: Setting },
    );
  }
  return items;
});

function isActive(item: NavigationItem) {
  const path = route.path;
  switch (item.key) {
    case "home":
      return path === "/";
    case "characters":
      return path === "/characters";
    case "memory":
      return /^\/characters\/[^/]+(\/settings\/memory)?$/.test(path);
    case "chat":
      return path.startsWith("/characters/") && path.endsWith("/chat");
    case "snapshots":
      return /^\/characters\/[^/]+\/snapshots$/.test(path);
    case "bili":
      return path === "/bili" || path.startsWith("/bili/");
    default:
      return path === item.href || path.startsWith(`${item.href}/`);
  }
}
</script>

<template>
  <div class="app-grid">
    <aside class="sidebar">
      <div class="sidebar-top">
        <NuxtLink
          to="/"
          class="brand"
        >
          <div class="brand-mark">
            忆
          </div>
          <div class="brand-wordmark">
            <div class="brand-title">
              忆灵小窝 <span>Yiling</span>
            </div>
            <div class="brand-subtitle">
              AI CHARACTER HUB
            </div>
          </div>
        </NuxtLink>
        <div class="workspace-pill">
          <div class="workspace-copy">
            <div class="workspace-name">
              个人工作空间
            </div>
            <div class="workspace-note">
              本地演示环境
            </div>
          </div>
        </div>
      </div>

      <nav
        class="sidebar-nav"
        aria-label="主导航"
      >
        <template
          v-for="item in navigation"
          :key="item.href"
        >
          <div
            v-if="item.section"
            class="sidebar-section"
          >
            {{ item.section }}
          </div>
          <NuxtLink
            :to="item.href"
            class="sidebar-link"
            :class="{ active: isActive(item) }"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span class="sidebar-label">{{ item.label }}</span>
            <span
              v-if="item.count"
              class="nav-count"
            >{{ item.count }}</span>
          </NuxtLink>
        </template>
      </nav>

      <div class="sidebar-bottom">
        <div class="admin-row">
          <div class="admin-avatar">
            {{ avatarLetter }}
          </div>
          <div class="admin-info sidebar-bottom-copy">
            <div class="admin-name">
              {{ displayName }}
            </div>
            <div class="admin-note">
              {{ roleLabel }}
            </div>
          </div>
        </div>
        <el-button
          class="sidebar-logout"
          text
          size="small"
          :loading="loggingOut"
          @click="handleLogout"
        >
          <el-icon><SwitchButton /></el-icon>退出登录
        </el-button>
        <div class="sidebar-version">
          <span>Yiling Hub · 预览版</span><span>v0.1</span>
        </div>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <div class="topbar-search">
          <el-input
            placeholder="搜索角色、记忆、阶段总结……"
            aria-label="搜索角色、记忆、阶段总结"
            clearable
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
        </div>
        <div class="topbar-right">
          <span class="env-indicator"><span class="env-dot" />{{ isLocalDevIdentity ? "本地开发" : "已登录" }}</span>
          <el-button
            text
            circle
            aria-label="通知"
          >
            <el-icon><Bell /></el-icon>
          </el-button>
          <el-divider direction="vertical" />
          <div class="user-pill">
            <el-avatar :size="30">
              {{ avatarLetter }}
            </el-avatar><span>{{ displayName }}</span>
          </div>
          <el-button
            text
            size="small"
            :loading="loggingOut"
            @click="handleLogout"
          >
            <el-icon><SwitchButton /></el-icon>退出
          </el-button>
        </div>
      </header>
      <main><slot /></main>
    </div>
  </div>
</template>
