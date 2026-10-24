<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ layout: false });

const { refresh } = useAuthSession();
const email = ref("");
const displayName = ref("");
const password = ref("");
const confirm = ref("");
const submitting = ref(false);
const errorMessage = ref("");

function readErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return "注册失败，请稍后重试。";
}

async function submit() {
  if (submitting.value) return;
  errorMessage.value = "";
  if (!email.value.trim() || !password.value) {
    errorMessage.value = "请填写邮箱和密码。";
    return;
  }
  if (password.value !== confirm.value) {
    errorMessage.value = "两次输入的密码不一致。";
    return;
  }
  submitting.value = true;
  try {
    await $fetch("/api/auth/register", {
      method: "POST",
      body: {
        email: email.value.trim(),
        password: password.value,
        displayName: displayName.value.trim(),
      },
    });
    password.value = "";
    confirm.value = "";
    await refresh();
    ElMessage.success("注册成功，已自动登录。");
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
          羚
        </div>
        <div>
          <div class="login-title">
            注册账号
          </div>
          <div class="login-subtitle">
            羚枢 Yiling Hub · 用邮箱创建你的账号
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
        <el-form-item label="邮箱">
          <el-input
            v-model="email"
            size="large"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </el-form-item>
        <el-form-item label="显示名（可选）">
          <el-input
            v-model="displayName"
            size="large"
            placeholder="默认取邮箱前缀"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            size="large"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="至少 10 位，含字母和数字"
          />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input
            v-model="confirm"
            size="large"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="再次输入密码"
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
          注册并登录
        </el-button>
      </el-form>

      <p class="login-note">
        已有账号？<NuxtLink
          to="/login"
          class="register-link"
        >
          直接登录
        </NuxtLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex; min-height: 100vh; align-items: center; justify-content: center;
  background: radial-gradient(circle at 18% 12%, #efeaff 0%, transparent 42%),
    radial-gradient(circle at 82% 88%, #e8f4ff 0%, transparent 46%), #f7f8fc;
  padding: 32px 18px;
}
.login-card {
  width: min(420px, 100%); border: 1px solid var(--line); border-radius: 20px;
  background: var(--surface); box-shadow: 0 18px 50px rgba(40, 52, 93, .09); padding: 30px 28px 24px;
}
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.login-mark {
  display: flex; width: 44px; height: 44px; align-items: center; justify-content: center;
  border-radius: 14px; background: linear-gradient(135deg, #887cf4, #6558dc); color: #fff;
  font-size: 22px; font-weight: 800; box-shadow: 0 8px 18px rgba(113, 100, 232, .26);
}
.login-title { color: #29324b; font-size: 17px; font-weight: 800; letter-spacing: -.02em; }
.login-subtitle { margin-top: 3px; color: var(--muted); font-size: 11px; }
.login-alert { margin-bottom: 16px; }
.login-submit { width: 100%; margin-top: 4px; }
.login-note { margin: 18px 0 0; color: var(--muted); font-size: 11px; line-height: 1.7; text-align: center; }
.register-link { color: #6d5fe0; font-weight: 700; }
</style>
