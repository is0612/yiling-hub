<script setup lang="ts">
import { Lock, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

definePageMeta({ layout: false });

const { refresh } = useAuthSession();
const username = ref("");
const password = ref("");
const submitting = ref(false);
const errorMessage = ref("");

function readErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return "登录失败，请检查用户名和密码后重试。";
}

async function submit() {
  if (submitting.value) return;
  errorMessage.value = "";
  if (!username.value.trim() || !password.value) {
    errorMessage.value = "请填写用户名和密码。";
    return;
  }
  submitting.value = true;
  try {
    await $fetch("/api/auth/login", {
      method: "POST",
      body: { username: username.value.trim(), password: password.value },
    });
    password.value = "";
    await refresh();
    ElMessage.success("已登录。");
    await navigateTo("/");
  } catch (error) {
    errorMessage.value = readErrorMessage(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-mark">
          忆
        </div>
        <div>
          <div class="login-title">
            忆灵小窝 Yiling Hub
          </div>
          <div class="login-subtitle">
            多角色 AI 养成 · 管理员登录
          </div>
        </div>
      </div>

      <el-alert
        v-if="errorMessage"
        :title="errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="login-alert"
      />

      <el-form
        label-position="top"
        @submit.prevent="submit"
      >
        <el-form-item label="邮箱或用户名">
          <el-input
            v-model="username"
            size="large"
            autocomplete="username"
            placeholder="请输入邮箱或用户名"
            :prefix-icon="User"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            size="large"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入密码"
            :prefix-icon="Lock"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button
          type="primary"
          size="large"
          class="login-submit"
          :loading="submitting"
          @click="submit"
        >
          登录
        </el-button>
      </el-form>

      <p class="login-note">
        登录会话保存在服务端，浏览器只持有 HttpOnly、SameSite=Strict 的会话 Cookie。连续输错会被临时限流。
      </p>
      <p class="login-note is-centered">
        还没有账号？<NuxtLink
          to="/register"
          class="register-link"
        >
          用邮箱注册
        </NuxtLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex; min-height: 100vh; align-items: center; justify-content: center;
  background: radial-gradient(circle at 18% 12%, var(--accent-soft) 0%, transparent 42%),
    radial-gradient(circle at 82% 88%, var(--brand-soft) 0%, transparent 46%), var(--surface-2);
  padding: 32px 18px;
}
.login-card {
  width: min(420px, 100%); border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); box-shadow: none; padding: 30px 28px 24px;
}
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.login-mark {
  display: flex; width: 44px; height: 44px; align-items: center; justify-content: center;
  border-radius: var(--radius); background: var(--grad-brand); box-shadow: 0 14px 30px -16px rgba(217, 74, 118, .75); color: #fff;
  font-size: 20px; font-weight: 700;
}
.login-title { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.login-subtitle { margin-top: 3px; color: var(--dim); font-size: 12px; }
.login-alert { margin-bottom: 16px; }
.login-submit { width: 100%; margin-top: 4px; }
.login-note { margin: 18px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.login-note.is-centered { text-align: center; margin-top: 10px; }
.register-link { color: var(--brand-strong); font-weight: 600; }
</style>
