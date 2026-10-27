export default defineNuxtConfig({
  compatibilityDate: "2026-10-23",
  devtools: { enabled: false },
  // The temporary unauthenticated Phase 2 API is strictly for the local machine.
  devServer: { host: "127.0.0.1" },
  css: ["~/assets/css/main.css"],
  modules: ["@element-plus/nuxt"],
  vite: {
    ssr: {
      // SSR 侧不外部化 element-plus。外部化时它走预构建产物，模块 id 是 /@id/ 形式，
      // 而 SSR 收集 CSS 时又按文件路径 /@fs/ 记一遍 —— 同一个 el-*.css 被算成两个模块，
      // <head> 里就出两个 <link>。
      noExternal: ["element-plus"],
    },
    optimizeDeps: {
      // 配合上一条：element-plus 不预构建。
      // 实测 <head> 里样式表从 97 个降到 43 个（多的那些是同一文件被拆成 3-9 份）。
      // 剩下每个 el-*.css 仍是 @fs + @id 各一份 —— 那是 Vite 在 Windows 下把 `E:/…`
      // 这种盘符路径当成裸模块 id 造成的，配置层修不掉，只在 dev 存在（生产由 rollup 合并）。
      exclude: ["element-plus"],
    },
  },
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