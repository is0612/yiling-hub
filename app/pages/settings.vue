<script setup lang="ts">
import { Bell, Check, Coin, Key, Monitor, Refresh, Lock } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

const instanceName = ref("羚枢 · 本地工作空间");
const defaultInterval = ref(8);
const defaultTimezone = ref("Asia/Shanghai");
const enableDemoNotifications = ref(true);
function saveSettings() {
  ElMessage.success("系统设置已保存到当前演示状态；刷新页面后将恢复默认值。");
}
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="系统管理 / 系统设置" title="系统设置" description="配置工作空间的默认行为。公开部署前必须补齐管理员登录、服务端鉴权和密钥管理。">
      <template #actions><DemoTag /></template>
    </PageHeader>
    <div class="settings-grid">
      <div>
        <section class="surface form-section">
          <div class="form-title"><el-icon class="setting-icon"><Monitor /></el-icon>工作空间</div>
          <el-form label-position="top">
            <el-form-item label="工作空间名称"><el-input v-model="instanceName" maxlength="60" /></el-form-item>
            <el-form-item label="默认记忆快照周期"><div class="interval-input"><el-input-number v-model="defaultInterval" :min="1" :max="365" /><span>天（角色可以单独设置）</span></div></el-form-item>
            <el-form-item label="默认时区"><el-select v-model="defaultTimezone" style="width:100%"><el-option label="中国标准时间（Asia/Shanghai）" value="Asia/Shanghai" /><el-option label="协调世界时（UTC）" value="UTC" /><el-option label="美国太平洋时间（America/Los_Angeles）" value="America/Los_Angeles" /></el-select></el-form-item>
          </el-form>
          <el-divider />
          <div class="toggle-row"><div><strong>演示通知</strong><p class="form-help">在演示操作完成时显示提示消息。</p></div><el-switch v-model="enableDemoNotifications" /></div>
        </section>
        <section class="surface form-section" style="margin-top:16px">
          <div class="form-title"><el-icon class="setting-icon"><Lock /></el-icon>管理员与安全</div>
          <div class="security-row"><div class="security-symbol"><el-icon><Key /></el-icon></div><div class="character-info"><strong>管理员登录</strong><p class="form-help">当前未实现安全登录会话和服务端授权校验。</p></div><el-tag type="warning" effect="light">尚未接入</el-tag></div>
          <div class="security-row"><div class="security-symbol"><el-icon><Coin /></el-icon></div><div class="character-info"><strong>数据库连接</strong><p class="form-help">PostgreSQL 与 Prisma 已有项目配置，尚未接入本页的实时状态检测。</p></div><el-tag type="info" effect="light">未验证</el-tag></div>
          <div class="security-row"><div class="security-symbol"><el-icon><Bell /></el-icon></div><div class="character-info"><strong>后台任务告警</strong><p class="form-help">真实告警与日志查询尚未接入。</p></div><el-tag type="info" effect="light">规划中</el-tag></div>
          <div class="info-callout" style="margin-top:17px"><el-icon><Lock /></el-icon><span>不要将数据库密码、模型 API Key 或渠道 Token 放入前端配置。公开部署前必须完成鉴权和权限校验。</span></div>
          <div class="form-actions"><el-button @click="ElMessage.info('演示设置已刷新。')"><el-icon><Refresh /></el-icon>恢复显示</el-button><el-button type="primary" @click="saveSettings"><el-icon><Check /></el-icon>保存设置</el-button></div>
        </section>
      </div>
      <aside class="surface panel">
        <div class="setting-hero"><div class="setting-hero-icon">羚</div><h2>羚枢 Yiling Hub</h2><p>多角色 AI 养成中枢</p><span class="pill pill-purple">本地开发预览</span></div>
        <el-divider />
        <div class="metric-row"><span>前端框架</span><span class="metric-value">Vue 3 + Nuxt</span></div>
        <div class="metric-row"><span>UI 组件</span><span class="metric-value">Element Plus</span></div>
        <div class="metric-row"><span>打包工具</span><span class="metric-value">Vite（Nuxt 默认）</span></div>
        <div class="metric-row"><span>数据库</span><span class="metric-value">PostgreSQL</span></div>
        <div class="metric-row"><span>数据访问</span><span class="metric-value">Prisma ORM 7</span></div>
        <div class="info-callout" style="margin-top:18px"><el-icon><Monitor /></el-icon><span>当前页面不代表数据库连接、身份认证或后台任务已经可用。</span></div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}
.form-title{display:flex;align-items:center;gap:9px;color:#3e4963;font-size:14px;font-weight:800;margin-bottom:22px}.setting-icon{font-size:19px;color:#8176e7}.setting-suffix{margin-left:12px;color:#8f99ad;font-size:11px}
.security-row{display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #f0f2f7}.security-row:last-of-type{border-bottom:0}.security-symbol{display:flex;width:36px;height:36px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:11px;background:#f2f0ff;color:#786be4;font-size:17px}.security-row strong{color:#48536d;font-size:12px}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:19px}.setting-hero{text-align:center;padding:12px 0}.setting-hero-icon{display:flex;width:58px;height:58px;align-items:center;justify-content:center;margin:0 auto 15px;border-radius:19px;background:linear-gradient(135deg,#887cf4,#6558dc);color:#fff;font-size:28px;font-weight:850;box-shadow:0 7px 17px #7164e833}
.setting-hero h2{color:#35405a;font-size:16px;font-weight:850}.setting-hero p{margin:7px 0 12px;color:#8c97ac;font-size:11px}
@media(max-width:1000px){.settings-grid{grid-template-columns:1fr}}
</style>
