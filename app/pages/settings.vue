<script setup lang="ts">
import { Bell, Coin, Monitor } from "@element-plus/icons-vue";
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / 系统设置"
      title="系统设置"
      description="管理管理员密码与登录设备。"
    />
    <div class="settings-grid">
      <div>
        <AccountSecurityPanel />

        <section class="surface form-section stack-gap">
          <div class="form-title">
            <el-icon class="setting-icon">
              <Coin />
            </el-icon>运行状态
          </div>
          <div class="security-row">
            <div class="security-symbol">
              <el-icon><Coin /></el-icon>
            </div><div class="character-info">
              <strong>数据库连接</strong><p class="form-help">
                PostgreSQL 与 Prisma 已在项目内配置，本页尚未接入实时连接状态检测。
              </p>
            </div><span class="pill pill-gray">未接入检测</span>
          </div>
          <div class="security-row">
            <div class="security-symbol">
              <el-icon><Bell /></el-icon>
            </div><div class="character-info">
              <strong>后台任务告警</strong><p class="form-help">
                任务监控页可查看任务状态，邮件或 Webhook 告警尚未接入。
              </p>
            </div><span class="pill pill-gray">规划中</span>
          </div>
          <div class="info-callout callout-gap">
            <el-icon><Monitor /></el-icon><span>不要将数据库密码、模型 API Key 或渠道 Token 放入前端配置；模型 API Key 在模型设置页加密保存。</span>
          </div>
        </section>
      </div>
      <aside class="surface panel">
        <div class="setting-hero">
          <div class="setting-hero-icon">
            忆
          </div><h2>忆灵小窝 Yiling Hub</h2><p>多角色 AI 养成</p>
        </div>
        <el-divider />
        <div class="metric-row">
          <span>前端框架</span><span class="metric-value">Vue 3 + Nuxt</span>
        </div>
        <div class="metric-row">
          <span>UI 组件</span><span class="metric-value">Element Plus</span>
        </div>
        <div class="metric-row">
          <span>打包工具</span><span class="metric-value">Vite（Nuxt 默认）</span>
        </div>
        <div class="metric-row">
          <span>数据库</span><span class="metric-value">PostgreSQL</span>
        </div>
        <div class="metric-row">
          <span>数据访问</span><span class="metric-value">Prisma ORM 7</span>
        </div>
        <div class="info-callout callout-gap">
          <el-icon><Monitor /></el-icon><span>管理员登录与密码管理已接入真实数据库；数据库连接检测与后台告警仍是规划项。</span>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) 336px;gap:18px;align-items:start}
.stack-gap{margin-top:16px}
.callout-gap{margin-top:16px}

.form-title{display:flex;align-items:center;gap:9px;margin-bottom:18px;color:var(--text);font-size:14px;font-weight:700}
.setting-icon{color:var(--brand);font-size:17px}

.security-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:12px 0}
.security-row:last-of-type{border-bottom:0}
.security-symbol{display:flex;width:34px;height:34px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--brand-soft);color:var(--brand);font-size:16px}
.security-row strong{color:var(--text-2);font-size:14px;font-weight:600}

.setting-hero{padding:8px 0 10px;text-align:center}
.setting-hero-icon{display:flex;width:52px;height:52px;align-items:center;justify-content:center;margin:0 auto 14px;border-radius:var(--radius);background:var(--grad-brand);box-shadow:0 14px 30px -16px rgba(217,74,118,.75);color:#fff;font-size:22px;font-weight:700}
.setting-hero h2{margin:0;color:var(--text);font-size:16px;font-weight:700;letter-spacing:-.01em}
.setting-hero p{margin:6px 0 12px;color:var(--dim);font-size:12px}

@media(max-width:1000px){.settings-grid{grid-template-columns:1fr}}
</style>
