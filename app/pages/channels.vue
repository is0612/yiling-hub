<script setup lang="ts">
import { ChatDotRound, Connection, Plus, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { channels } from "~/utils/mock-data";

function showAdapter(name: string) {
  ElMessage.info(name + " 适配器尚未实现。");
}
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="系统管理 / 渠道管理" title="外部渠道接入" description="将角色与外部消息来源连接。渠道负责收发消息，角色与记忆数据仍由平台统一管理。">
      <template #actions><DemoTag /><el-button type="primary" @click="ElMessage.info('渠道接入将在后续阶段实现。')"><el-icon><Plus /></el-icon>添加渠道</el-button></template>
    </PageHeader>
    <div class="info-callout" style="margin-bottom:20px"><el-icon><Warning /></el-icon><span>当前展示的是规划占位。真实渠道尚未连接，页面不会发送或接收任何外部消息。</span></div>
    <div class="channel-grid">
      <article v-for="channel in channels" :key="channel.name" class="surface channel-card">
        <div class="channel-head">
          <div class="channel-icon" :class="'tone-' + channel.color"><el-icon><ChatDotRound /></el-icon></div>
          <div class="character-info"><h2 class="character-name">{{ channel.name }}</h2><p class="character-alias">{{ channel.description }}</p></div>
          <span class="pill pill-gray">{{ channel.status }}</span>
        </div>
        <div class="metric-row"><span>连接状态</span><span class="metric-value"><i class="status-dot" />未接入</span></div>
        <div class="metric-row"><span>已绑定角色</span><span class="metric-value">0 个</span></div>
        <div class="metric-row"><span>最近活动</span><span class="metric-value">暂无数据</span></div>
        <el-button style="width:100%;margin-top:17px" plain @click="showAdapter(channel.name)"><el-icon><Connection /></el-icon>查看接入说明</el-button>
      </article>
    </div>
    <section class="surface panel" style="margin-top:20px">
      <SectionTitle title="接入原则" description="正式渠道适配器应遵守统一事件契约" />
      <div class="principle-grid">
        <div class="principle"><div class="principle-number">01</div><strong>角色与渠道分离</strong><p>一个角色可以绑定多个渠道；记忆不会与单个平台混为一体。</p></div>
        <div class="principle"><div class="principle-number">02</div><strong>统一事件格式</strong><p>平台消息先规范化，再进入对话记录和记忆处理流程。</p></div>
        <div class="principle"><div class="principle-number">03</div><strong>凭据安全保存</strong><p>平台 Token 只由服务端读取，不能暴露给浏览器或普通日志。</p></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.channel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}
.channel-card{padding:20px}.channel-head{display:flex;align-items:flex-start;gap:11px;min-height:64px}
.channel-icon{display:flex;width:42px;height:42px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:13px;background:#f0eeff;color:#786be4;font-size:19px}
.channel-icon.tone-blue{background:#eef5ff;color:#4f7ac0}.channel-icon.tone-green{background:#e8f8f1;color:#249b77}
.status-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#c0c6d3}
.principle-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:22px}
.principle-number{margin-bottom:12px;color:#8478eb;font-size:11px;font-weight:850;letter-spacing:.12em}.principle strong{color:#47526d;font-size:12px}.principle p{margin-top:8px;color:#8792a8;font-size:11px;line-height:1.8}
@media(max-width:1000px){.channel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.principle-grid{grid-template-columns:1fr}}
@media(max-width:650px){.channel-grid{grid-template-columns:1fr}}
</style>
