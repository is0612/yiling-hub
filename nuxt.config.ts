export default defineNuxtConfig({
  compatibilityDate: "2026-10-23",
  devtools: { enabled: false },
  // The temporary unauthenticated Phase 2 API is strictly for the local machine.
  devServer: { host: "127.0.0.1" },
  css: ["~/assets/css/main.css"],
  modules: ["@element-plus/nuxt"],
  typescript: {
    strict: true,
    // 默认关闭 vite-plugin-checker。开启时它会在 dev 里跑全量类型检查，每次 HMR 都重跑：
    // 关闭前实测 dev 冷启动后 2 分钟内涨到 2.6GB 内存、持续吃约 2.5 核 CPU，
    // 并占掉 nuxt build 总耗时的 57%。关闭后稳态 751MB、空闲 0% CPU。
    // 类型检查改走 `yarn typecheck`（nuxt typecheck + tsc），已包含在 yarn verify:local 里。
    // 需要临时打开时：NUXT_TYPECHECK=1 yarn dev / yarn build
    typeCheck: process.env.NUXT_TYPECHECK === "1",
  },
  app: {
    head: {
      title: "忆灵小窝 · 多角色 AI 养成",
      htmlAttrs: { lang: "zh-CN" },
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#f7f8fc" },
        { name: "description", content: "管理 AI 角色、长期记忆与阶段总结的工作台。" },
      ],
    },
  },
});