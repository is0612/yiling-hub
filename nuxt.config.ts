export default defineNuxtConfig({
  compatibilityDate: "2026-10-23",
  devtools: { enabled: false },
  // The temporary unauthenticated Phase 2 API is strictly for the local machine.
  devServer: { host: "127.0.0.1" },
  css: ["~/assets/css/main.css"],
  modules: ["@element-plus/nuxt"],
  typescript: {
    strict: true,
    typeCheck: true,
  },
  app: {
    head: {
      title: "忆灵小窝 · 多角色 AI 养成",
      htmlAttrs: { lang: "zh-CN" },
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#f7f8fc" },
        { name: "description", content: "管理 AI 角色、长期记忆与周期快照的工作台。" },
      ],
    },
  },
});