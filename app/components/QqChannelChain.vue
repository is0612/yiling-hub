<script setup lang="ts">
/**
 * QQ 渠道的四段链路：小号 → 协议端网关 → 本机适配器 → 角色。
 *
 * 为什么要有这一条：
 * 「消息不回」有四种完全不同的原因（号掉线 / 网关没起 / 适配器没跑 / 没绑角色），
 * 但它们表现完全一样 —— 群里一句话没人接。以前这四种散在页面各处的小字里，
 * 只能靠人挨个去核对。这条轨道把四段并排放出来，一眼看出断在哪。
 *
 * 两个刻意的取舍：
 *
 * 1. **只标一个红点**。断点按「因果」算，不按位置：网关不通 → 适配器必然连不上 →
 *    小号状态也必然是「未连接」。若四段各标各的，屏幕上会同时红三下，反而看不出根因。
 *    所以根因那一段标红，其余没通的段落降成灰（"还没轮到"），不跟着红。
 *
 * 2. **上游没通就先不管下游**。断点之后的段落一律灰掉 —— 它们现在的状态没有意义，
 *    拿去给人看只会引着人去修错的地方。
 */
import { chainToneAt, resolveChainRoot, type ChainActionKind } from "~/utils/qq-channel";

type ChainConnection = { appId: string | null; displayName: string; status: string };
type ChainBinding = {
  characterName: string;
  routingKey: string | null;
  groupChat: { mode: "mention" | "ambient" | "all" };
};
type ChainAdapter = { running: boolean; pid?: number; startedAt?: string };
type ChainSnowluma = { installed: boolean; running: boolean; panelPort: number; home: string };
type ChainGateway = { wsUrl: string; host: string; port: number; reachable: boolean };

const props = defineProps<{
  connection: ChainConnection | null;
  binding: ChainBinding | null;
  adapter: ChainAdapter | null;
  snowluma: ChainSnowluma | null;
  gateway: ChainGateway | null;
  /** 运行时状态还没拿到时不做判断，避免首帧闪一下「断线」 */
  ready: boolean;
  /** 协议端面板地址，用于「面板在跑但节点没开」这条 */
  panelUrl: string;
}>();

const emit = defineEmits<{ (e: "action", kind: ChainActionKind): void }>();

const MODE_LABEL: Record<string, string> = {
  mention: "仅被 @ 时回复",
  ambient: "自然接话",
  all: "每条都回",
};

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: "已登录",
  DISCONNECTED: "未连接",
  ERROR: "连接异常",
  DISABLED: "已停用",
};

const accountOn = computed(() => props.connection?.status === "CONNECTED");
const gatewayOn = computed(() => props.gateway?.reachable === true);
const adapterOn = computed(() => props.adapter?.running === true);
const bindingOn = computed(() => Boolean(props.binding));

/**
 * 断点由纯函数挑（app/utils/qq-channel.ts）—— 这里的职责只是把 props 翻成四个布尔。
 * 判断本身在 scripts/test-qq-channel-chain.ts 里有断言，改规则前先看那几条。
 */
const rootIndex = computed(() => {
  if (!props.ready || !props.connection) return -1;
  return resolveChainRoot({
    accountOk: accountOn.value,
    gatewayOk: gatewayOn.value,
    adapterOk: adapterOn.value,
    bindingOk: bindingOn.value,
  });
});

const gatewayState = computed(() => {
  // 运行时状态还没回来时说「检查中」——这时候说「没读到地址」是冤的，地址可能填得好好的
  if (!props.ready) return "检查中";
  const { gateway, snowluma } = props;
  if (!gateway) return "没读到地址";
  if (gateway.reachable) return "端口在听";
  if (!snowluma?.installed) return "没找到程序";
  if (!snowluma.running) return "没启动";
  return "节点没开";
});

const hops = computed(() => {
  const root = rootIndex.value;
  const conditions = [accountOn.value, gatewayOn.value, adapterOn.value, bindingOn.value];
  const definitions = [
    {
      key: "account",
      name: "QQ 小号",
      short: "小号",
      fact: props.connection?.appId ? `QQ ${props.connection.appId}` : "未填 QQ 号",
      state: STATUS_LABEL[props.connection?.status ?? ""] ?? "未知",
      mono: true,
    },
    {
      key: "gateway",
      name: "协议端网关",
      short: "协议端",
      fact: props.gateway ? `${props.gateway.host}:${props.gateway.port}` : "未配置地址",
      state: gatewayState.value,
      mono: true,
    },
    {
      key: "adapter",
      name: "本机适配器",
      short: "适配器",
      fact: props.adapter?.running && props.adapter.pid ? `pid ${props.adapter.pid}` : "yarn onebot:run",
      state: props.adapter?.running ? "运行中" : props.adapter ? "未运行" : "检查中",
      // pid 和命令都是要照着敲/核对的东西，一律等宽，不随状态变
      mono: true,
    },
    {
      key: "character",
      name: "角色",
      short: "角色",
      fact: props.binding?.characterName ?? "未绑定",
      state: props.binding ? (MODE_LABEL[props.binding.groupChat.mode] ?? "会回复") : "没人接",
      mono: false,
    },
  ];

  return definitions.map((definition, index) => ({
    ...definition,
    tone: props.ready ? chainToneAt(index, root, conditions[index] === true) : "idle",
  }));
});

/**
 * 右端那句结论。四段各标自己的状态还不够 —— 人要的是「通没通、断在哪」一句话。
 * 只取断点那一段的短名，不说「协议端网关」这种四字全称。
 */
const verdict = computed(() => {
  if (!props.ready) return { text: "检查中", tone: "idle" };
  const root = rootIndex.value;
  if (root === -1) return { text: "四段全通", tone: "live" };
  return { text: `断在${hops.value[root]?.short ?? "中途"}`, tone: "break" };
});

/**
 * 断点那一行：说清「哪坏了、为什么、点一下怎么修」。
 * 只给一个动作 —— 这一屏的用途是指路，不是把所有按钮都摆出来。
 */
const fix = computed(() => {
  const root = rootIndex.value;
  if (root === -1) return null;

  if (root === 1) {
    if (!props.gateway) {
      return {
        title: "没读到网关地址",
        detail: "连接配置里没有可用的 WS 地址，适配器不知道往哪连。",
        action: { kind: "edit-connection" as ChainActionKind, label: "检查连接设置" },
      };
    }
    if (!props.snowluma?.installed) {
      return {
        title: "没找到 SnowLuma",
        detail: `自动扫描没找到 start.bat（最后找的是 ${props.snowluma?.home ?? "默认目录"}）。`,
        action: { kind: "open-steps" as ChainActionKind, label: "去第 2 步填目录" },
      };
    }
    if (!props.snowluma.running) {
      return {
        title: "SnowLuma 没启动",
        detail: `面板端口 ${props.snowluma.panelPort} 没人应答，${props.gateway.port} 上自然也没有 WS 节点。`,
        action: { kind: "start-gateway" as ChainActionKind, label: "启动 SnowLuma" },
      };
    }
    return {
      title: `面板在跑，但 ${props.gateway.port} 上没开节点`,
      detail: "到面板里新建一个 WebSocket 服务端，端口填这个号要连的那个。",
      href: props.panelUrl,
      actionLabel: "打开面板",
    };
  }

  if (root === 2) {
    return {
      title: "适配器没在跑",
      detail: "消息到了网关也没人接。它是独立进程，得一直开着。",
      action: { kind: "start-adapter" as ChainActionKind, label: "启动适配器" },
    };
  }

  if (root === 0) {
    return {
      title: "小号没在线",
      detail: "适配器连着网关，但拿不到登录态 —— 多半是这个号在 QQ 客户端里掉线了。",
      action: { kind: "open-steps" as ChainActionKind, label: "看怎么重新登录" },
    };
  }

  return {
    title: "还没绑角色",
    detail: "号通了，但消息进来没有角色接。绑一个就会开始回。",
    action: { kind: "bind-character" as ChainActionKind, label: "绑定角色" },
  };
});
</script>

<template>
  <section
    class="linkbar"
    aria-label="QQ 渠道链路状态"
  >
    <ol class="link">
      <li
        v-for="hop in hops"
        :key="hop.key"
        class="hop"
        :class="`is-${hop.tone}`"
      >
        <span
          class="dot"
          aria-hidden="true"
        />
        <span class="hop-name">{{ hop.name }}</span>
        <span
          class="hop-val"
          :class="{ 'is-mono': hop.mono }"
        >{{ hop.fact }}</span>
        <span class="hop-st">{{ hop.state }}</span>
      </li>
    </ol>

    <div class="link-end">
      <span
        class="verdict"
        :class="`is-${verdict.tone}`"
      >{{ verdict.text }}</span>
      <button
        type="button"
        class="link-btn"
        @click="emit('action', 'edit-connection')"
      >
        连接设置
      </button>
    </div>
  </section>

  <!-- 断点条：和带子分开。带子回答「通没通」，这条才回答「怎么办」 -->
  <div
    v-if="fix"
    class="fixbar"
  >
    <b>{{ fix.title }}</b>
    <p>{{ fix.detail }}</p>
    <a
      v-if="fix.href"
      class="fix-act"
      :href="fix.href"
      target="_blank"
      rel="noopener noreferrer"
    >{{ fix.actionLabel }}</a>
    <button
      v-else-if="fix.action"
      type="button"
      class="fix-act"
      @click="emit('action', fix.action.kind)"
    >
      {{ fix.action.label }}
    </button>
  </div>
</template>

<style scoped>
/* ── 链路带：一条横向的带子，不套卡片 ─────────────────
   四段并排 + 右端一句结论。段与段之间的连线只在「通了」时出现，
   断开那一段之后整段不连线 —— 视觉上就停在那儿。 */
.linkbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-5);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
}

.link {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.hop { position: relative; min-width: 0; }

/* 圆点单独占一行：连线走圆点的高度，文字从下一行开始，两者不打架 */
.dot {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--line-strong);
}
.hop-name { display: block; margin-top: 6px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.hop-val {
  display: block;
  margin-top: 2px;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hop-val.is-mono { font-family: var(--mono); font-size: 12px; font-weight: 500; }
.hop-st { display: block; margin-top: 1px; color: var(--dim); font-size: 12px; }

.hop:not(:last-child)::after {
  position: absolute;
  top: 3px;
  left: 12px;
  right: calc(var(--sp-4) * -1);
  height: 2px;
  border-radius: 1px;
  background: var(--line);
  content: "";
}

.hop.is-live .dot { background: var(--green); }
.hop.is-live:not(:last-child)::after { background: var(--green); opacity: .45; }
.hop.is-break .dot { background: var(--red); }
.hop.is-break:not(:last-child)::after { background: transparent; }
.hop.is-break .hop-st { color: var(--red); font-weight: 600; }
.hop.is-off .dot { background: var(--line-strong); }

/* 断开后这两段仍在传递信息（号是多少、绑没绑），所以只降到 --dim（5.1:1），
   不用 --faint —— 它按契约只做装饰，不承载信息。 */
.hop.is-off .hop-val,
.hop.is-off .hop-st { color: var(--dim); }

.link-end { display: flex; flex: none; align-items: center; gap: var(--sp-2); }

.verdict {
  display: inline-flex;
  height: 26px;
  align-items: center;
  border-radius: 999px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.verdict.is-live { background: var(--green-soft); color: var(--green); }
.verdict.is-break { background: var(--red-soft); color: var(--red); }
.verdict.is-idle { background: var(--surface-3); color: var(--dim); }

.link-btn {
  height: 32px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 0 10px;
  color: var(--text-2);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.link-btn:hover { background: var(--surface-3); color: var(--brand-strong); }
.link-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* ── 断点条：一行原因 + 一个动作 ───────────────────── */
.fixbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
  border-radius: var(--radius);
  background: var(--red-soft);
  padding: var(--sp-3) var(--sp-4);
}
.fixbar b { flex: none; color: var(--red); font-size: 14px; font-weight: 700; }
.fixbar p { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.6; }

.fix-act {
  display: inline-flex;
  height: 32px;
  flex: none;
  align-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 0 12px;
  color: var(--red);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.fix-act:hover { background: var(--red); color: #fff; }
.fix-act:focus-visible { outline: 2px solid var(--red); outline-offset: 2px; }

/* ── 窄屏：转纵向，但每个跳点只占一行 ───────────────
   四段各写三行会把带子撑到 300px 高，比它要回答的「通没通」还显眼；
   竖排时点名、值、状态压成一行，圆点和竖线在左列把四段串起来。 */
@media (max-width: 860px) {
  .linkbar { grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); padding: var(--sp-3); }
  .link { grid-template-columns: minmax(0, 1fr); gap: 10px; }

  .hop {
    display: grid;
    grid-template-columns: 12px 68px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--sp-2);
  }
  .dot { grid-column: 1; grid-row: 1; align-self: start; margin-top: 5px; }
  .hop-name { grid-column: 2; margin-top: 0; white-space: nowrap; }
  .hop-val { grid-column: 3; min-width: 0; margin-top: 0; }
  .hop-st { grid-column: 4; margin-top: 0; text-align: right; }
  .hop:not(:last-child)::after {
    top: 13px;
    right: auto;
    bottom: -15px;
    left: 3px;
    width: 2px;
    height: auto;
  }

  .link-end { justify-content: space-between; }
  .fixbar { flex-wrap: wrap; }
  .fixbar p { flex-basis: 100%; }
  .fix-act { margin-left: auto; }
}
</style>
