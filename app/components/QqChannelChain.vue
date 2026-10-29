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
      fact: props.connection?.appId ? `QQ ${props.connection.appId}` : "未填 QQ 号",
      state: STATUS_LABEL[props.connection?.status ?? ""] ?? "未知",
      mono: true,
    },
    {
      key: "gateway",
      name: "协议端网关",
      fact: props.gateway ? `${props.gateway.host}:${props.gateway.port}` : "未配置地址",
      state: gatewayState.value,
      mono: true,
    },
    {
      key: "adapter",
      name: "本机适配器",
      fact: props.adapter?.running && props.adapter.pid ? `pid ${props.adapter.pid}` : "yarn onebot:run",
      state: props.adapter?.running ? "运行中" : props.adapter ? "未运行" : "检查中",
      // pid 和命令都是要照着敲/核对的东西，一律等宽，不随状态变
      mono: true,
    },
    {
      key: "character",
      name: "角色",
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
    class="chain"
    aria-label="QQ 渠道链路状态"
  >
    <div class="chain-h">
      <h2>这条链路通到哪</h2>
      <span class="note">断在哪一环，后面的整段都不会动</span>
    </div>

    <ol class="track">
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
        <div class="hop-body">
          <span class="hop-name">{{ hop.name }}</span>
          <span
            class="hop-fact"
            :class="{ 'is-mono': hop.mono }"
          >{{ hop.fact }}</span>
          <span class="hop-state">{{ hop.state }}</span>
        </div>
      </li>
    </ol>

    <div
      v-if="fix"
      class="chain-fix"
    >
      <div class="fix-copy">
        <b>{{ fix.title }}</b>
        <p>{{ fix.detail }}</p>
      </div>
      <a
        v-if="fix.href"
        class="fix-btn"
        :href="fix.href"
        target="_blank"
        rel="noopener noreferrer"
      >{{ fix.actionLabel }}</a>
      <button
        v-else-if="fix.action"
        type="button"
        class="fix-btn"
        @click="emit('action', fix.action.kind)"
      >
        {{ fix.action.label }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.chain {
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 18px 16px;
}

.chain-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 16px; }
.chain-h h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.chain-h .note { margin-left: auto; color: var(--dim); font-size: 12px; }

/* ── 轨道：四段等宽并排 ─────────────────────────────── */
.track {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.hop { position: relative; min-width: 0; }

.dot {
  display: block;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--line-strong);
}
.hop.is-live .dot { background: var(--green); }
.hop.is-break .dot { background: var(--red); }

/* 连接线画在「本段圆点右侧」，一直到下一段圆点：dot 11px + 3px 呼吸 → left 14 */
.hop:not(:last-child)::after {
  position: absolute;
  top: 4.5px;
  left: 14px;
  width: calc(100% - 13px);
  height: 2px;
  border-radius: 1px;
  background: var(--line-strong);
  content: "";
}
.hop.is-live:not(:last-child)::after { background: var(--green); }
/* 断点之后那段用红虚线：不是「还没轮到」，是「就断在这儿」 */
.hop.is-break:not(:last-child)::after {
  background: repeating-linear-gradient(90deg, var(--red) 0 6px, transparent 6px 11px);
}

.hop-body { display: flex; flex-direction: column; gap: 2px; margin-top: 9px; }
.hop-name { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.4; }
.hop-fact {
  color: var(--dim);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.hop-fact.is-mono { font-family: ui-monospace, Consolas, monospace; }
.hop-state { margin-top: 1px; font-size: 12px; font-weight: 600; }
.hop.is-live .hop-state { color: var(--green); }
.hop.is-break .hop-state { color: var(--red); }
.hop.is-idle .hop-state { color: var(--faint); }

/* ── 断点提示：一行原因 + 一个动作 ─────────────────── */
.chain-fix {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 14px;
  border-radius: 8px;
  background: var(--red-soft);
  padding: 10px 12px;
}
.fix-copy { min-width: 0; flex: 1; }
.fix-copy b { display: block; color: var(--red); font-size: 13px; font-weight: 700; }
.fix-copy p { margin: 3px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.65; }

.fix-btn {
  display: inline-flex;
  height: 30px;
  flex: none;
  align-items: center;
  border: 0;
  border-radius: 7px;
  background: var(--surface);
  padding: 0 11px;
  color: var(--red);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.fix-btn:hover { background: var(--red); color: #fff; }
.fix-btn:focus-visible { outline: 2px solid var(--red); outline-offset: 2px; }

/* ── 窄屏：转纵向，圆点在左、竖线穿过 ─────────────────── */
@media (max-width: 720px) {
  .chain { padding: 14px 15px; }
  .chain-h { flex-wrap: wrap; gap: 2px 8px; margin-bottom: 14px; }
  .chain-h .note { margin-left: 0; }

  .track { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .hop {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 10px;
  }
  .dot { grid-column: 1; grid-row: 1; margin-top: 5px; }
  .hop-body { grid-column: 2; grid-row: 1; margin-top: 0; }
  .hop:not(:last-child)::after {
    top: 19px;
    bottom: -19px;
    left: 5px;
    width: 2px;
    height: auto;
  }
  /* 竖线用纵向渐变，横线那套 dashed 是 90deg，这里必须换 */
  .hop.is-break:not(:last-child)::after {
    background: repeating-linear-gradient(180deg, var(--red) 0 6px, transparent 6px 11px);
  }

  .chain-fix { flex-wrap: wrap; }
  .fix-btn { margin-left: auto; }
}
</style>
