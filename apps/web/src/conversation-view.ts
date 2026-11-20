/**
 * 群聊会话（v2）的纯渲染决策与视图 reducer。
 *
 * 服务端 SSE 产出的 ConversationEvent 先在这里算成可渲染的行，App 只负责把行塞进 UI。
 * 重要红线：这里不缓存权威状态。只有 conversation.committed 会把服务端 state 交回 App；
 * 私密模式靠 Delivery.channels 决定看见什么，前端绝不拿 Utterance 原文兜底。
 */
import type { ActorId } from "../../../packages/shared/src/contract/types.ts";
import type {
  Channel,
  ConversationEvent,
  ConversationPhase,
  Delivery,
  SceneBeat,
} from "../../../packages/shared/src/contract/v2.ts";
import type { Line, LineKind } from "./ui.ts";

/** 一条渲染片段：通道 + 文本。字段缺失时不产生片段，绝不回退原文。 */
export interface RenderPart {
  channel: Channel;
  text: string;
}

export interface ConversationLine {
  id: number;
  kind: "utterance" | "scene" | "notice" | "mental" | "system";
  speaker?: ActorId;
  utteranceId?: string;
  parts: RenderPart[];
  turn: number;
}

export interface ConversationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ConversationView {
  phase: ConversationPhase;
  listeningSince: number | null;
  participants: ActorId[];
  lines: ConversationLine[];
  beats: SceneBeat[];
  error: ConversationError | null;
  committedTurn: number;
}

/** 与 DEFAULT_CONVERSATION_POLICY.listenTimeoutMs 一致：服务端 30s 自动恢复 speaking */
export const DEFAULT_LISTEN_TIMEOUT_MS = 30_000;

export function initialConversationView(): ConversationView {
  return {
    phase: "speaking",
    listeningSince: null,
    participants: [],
    lines: [],
    beats: [],
    error: null,
    committedTurn: 0,
  };
}

const CHANNEL_ORDER: readonly Channel[] = ["content", "action", "notice"];
const CHANNEL_FIELD: Record<Channel, "content" | "action" | "notice"> = {
  content: "content",
  action: "action",
  notice: "notice",
};

/**
 * Delivery → 渲染片段。只看 channels 列出的通道，且对应字段必须是非空字符串。
 * whisper/signal 的非目标 Delivery 只有 action 通道，这里自然只产出 action；
 * addressed 的「对 X 说」走 notice 通道，随该通道一起渲染。
 */
export function deliveryParts(delivery: Delivery): RenderPart[] {
  const visible = new Set(delivery.channels);
  const parts: RenderPart[] = [];
  for (const channel of CHANNEL_ORDER) {
    if (!visible.has(channel)) continue;
    const text = delivery[CHANNEL_FIELD[channel]];
    if (typeof text !== "string" || text.trim() === "") continue;
    parts.push({ channel, text });
  }
  return parts;
}

export interface UtteranceGroup {
  utteranceId: string;
  deliveries: Delivery[];
}

/** 同一 utteranceId 的多条 Delivery 归组：渲染时只算一句，不按条重复计数。 */
export function groupDeliveriesByUtterance(deliveries: Delivery[]): UtteranceGroup[] {
  const groups: UtteranceGroup[] = [];
  const byId = new Map<string, UtteranceGroup>();
  for (const delivery of deliveries) {
    let group = byId.get(delivery.utteranceId);
    if (!group) {
      group = { utteranceId: delivery.utteranceId, deliveries: [] };
      byId.set(delivery.utteranceId, group);
      groups.push(group);
    }
    group.deliveries.push(delivery);
  }
  return groups;
}

function mergeParts(existing: RenderPart[], incoming: RenderPart[]): RenderPart[] {
  const merged = [...existing];
  const seen = new Set(merged.map((p) => `${p.channel}\u0000${p.text}`));
  for (const part of incoming) {
    const key = `${part.channel}\u0000${part.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(part);
  }
  return merged;
}

/** 只取发给自己的 Delivery，合并同通道片段（SSE 可能分多条下发同一句）。 */
export function viewerParts(group: UtteranceGroup, selfActorId: string): RenderPart[] {
  let parts: RenderPart[] = [];
  for (const delivery of group.deliveries) {
    if (delivery.to !== selfActorId) continue;
    parts = mergeParts(parts, deliveryParts(delivery));
  }
  return parts;
}

/** scene beat 按 order 插到玩家发言之前(before)/之后(after)。 */
export function insertSceneBeat(
  lines: ConversationLine[],
  beat: SceneBeat,
  line: ConversationLine,
  selfActorId: string,
): ConversationLine[] {
  const next = [...lines];
  if (beat.order === "before") {
    const at = next.findIndex((l) => l.kind === "utterance" && l.speaker === selfActorId);
    next.splice(at === -1 ? next.length : at, 0, line);
  } else {
    let at = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]!.kind === "utterance" && next[i]!.speaker === selfActorId) {
        at = i;
        break;
      }
    }
    next.splice(at === -1 ? next.length : at + 1, 0, line);
  }
  return next;
}

export interface ReduceCtx {
  selfActorId: string;
  now: number;
  /** 分配稳定的数值行 id（与 App 的 lineId 共用计数器） */
  lineId: () => number;
}

/** ConversationEvent → 视图。Reducer 纯函数：同输入同输出，不读全局、不发副作用。 */
export function reduceConversationView(
  state: ConversationView,
  ev: ConversationEvent,
  ctx: ReduceCtx,
): ConversationView {
  switch (ev.type) {
    case "conversation.opened":
      return { ...initialConversationView(), participants: [...ev.participants] };

    case "conversation.utterance": {
      const delivery = ev.delivery;
      const parts = viewerParts({ utteranceId: delivery.utteranceId, deliveries: [delivery] }, ctx.selfActorId);
      if (parts.length === 0) return state; // 不是发给我的 / 没有可见通道
      const idx = state.lines.findIndex((l) => l.utteranceId === delivery.utteranceId);
      if (idx === -1) {
        return {
          ...state,
          lines: [
            ...state.lines,
            {
              id: ctx.lineId(),
              kind: "utterance",
              speaker: delivery.speaker,
              utteranceId: delivery.utteranceId,
              parts,
              turn: state.committedTurn,
            },
          ],
        };
      }
      const lines = [...state.lines];
      const existing = lines[idx]!;
      lines[idx] = { ...existing, parts: mergeParts(existing.parts, parts) };
      return { ...state, lines };
    }

    case "conversation.scene": {
      if (state.beats.some((b) => b.id === ev.beat.id)) return state; // 同一 beat 不重复插
      const line: ConversationLine = {
        id: ctx.lineId(),
        kind: "scene",
        parts: [{ channel: "notice", text: ev.beat.text }],
        turn: state.committedTurn,
      };
      return {
        ...state,
        beats: [...state.beats, ev.beat],
        lines: insertSceneBeat(state.lines, ev.beat, line, ctx.selfActorId),
      };
    }

    case "conversation.phase":
      return {
        ...state,
        phase: ev.phase,
        listeningSince: ev.phase === "listening" ? ctx.now : null,
      };

    case "conversation.notice":
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: ctx.lineId(), kind: "notice", parts: [{ channel: "notice", text: ev.text }], turn: state.committedTurn },
        ],
      };

    case "conversation.mental":
      // 心理活动只对本人可见；服务端不会给别人的 mental，前端也不请求。
      if (ev.actorId !== ctx.selfActorId) return state;
      return {
        ...state,
        lines: [
          ...state.lines,
          {
            id: ctx.lineId(),
            kind: "mental",
            speaker: ev.actorId,
            parts: [{ channel: "notice", text: ev.mental.thought }],
            turn: state.committedTurn,
          },
        ],
      };

    case "conversation.committed":
      // 只有这里推进权威轮次；state/proposals 本身由 App 直接交给 setState。
      return { ...state, committedTurn: ev.turn, error: null };

    case "conversation.error":
      return {
        ...state,
        error: { code: ev.code, message: ev.message, retryable: ev.retryable === true },
      };

    default:
      return state;
  }
}

/**
 * v2 乐观玩家行：点发送到 `committed` 之间先显示的浅色行（SSE 非流式，模型耗时期间没有即时反馈）。
 * 纯函数便于测试。去重只看**本次派发之后**追加的行（`sinceLineIndex`）：同一句在更早轮次出现过
 * 仍要显示 pending；重试（复用同一 clientTurnId）则传 0 扫全部已渲染行，真行已在就不要再挂。
 * - 正文是台词 → `player`（与真行一致）；
 * - 动作是叙述 → `narrative`（引擎对 action 通道也渲染成 narrative，contentless 不会跳样式）。
 */
export function pendingLinesFor(
  view: ConversationView,
  selfActorId: ActorId,
  content: string,
  action?: string,
  opts?: { sinceLineIndex?: number },
): { kind: LineKind; text: string }[] {
  const seen = new Set<string>();
  for (let i = opts?.sinceLineIndex ?? 0; i < view.lines.length; i++) {
    const line = view.lines[i]!;
    if (line.kind !== "utterance" || line.speaker !== selfActorId) continue;
    for (const part of line.parts) {
      if (part.text.trim() !== "") seen.add(part.text.trim());
    }
  }
  const out: { kind: LineKind; text: string }[] = [];
  const c = content.trim();
  if (c !== "" && !seen.has(c)) out.push({ kind: "player", text: c });
  const a = (action ?? "").trim();
  if (a !== "" && !seen.has(a)) out.push({ kind: "narrative", text: a });
  return out;
}

/** 服务端 listenTimeoutMs 到期会自动恢复 speaking；前端据此清掉自己的等待态。 */
export function isListeningExpired(
  view: ConversationView,
  now: number,
  timeoutMs: number = DEFAULT_LISTEN_TIMEOUT_MS,
): boolean {
  return view.phase === "listening" && view.listeningSince !== null && now - view.listeningSince >= timeoutMs;
}

function lineKindFor(line: ConversationLine, channel: Channel, selfActorId: string): LineKind {
  if (line.kind === "scene") return "narrative";
  if (line.kind === "mental") return "system";
  if (line.kind === "notice" || line.kind === "system") return "system";
  if (channel === "content") return line.speaker === selfActorId ? "player" : "npc";
  if (channel === "action") return "narrative";
  return "system";
}

export interface LinesFromViewOpts {
  selfActorId: string;
  nameOf: (actorId: ActorId) => string;
}

/** 把视图里的每段渲染片段摊平成 UI 的 Line[]（组件无需知道 v2 通道细节）。 */
/**
 * 给 utterance 片段拼展示名，规则是"名字只出现一次"：
 * - 自己说的话不加前缀（行动文本本身已是完整的一句话，再加"你"会变成"你你…"）；
 * - content 是台词，用「名字：台词」把说话人和内容分开；
 * - action 是叙述句（"X把文件夹往腋下一夹"），名字即主语，不加分隔符；
 * - 模型偶尔在台词/动作开头自带名字（服务端脱敏后就是同一个展示名），
 *   先剥掉开头这次名字，避免出现"X：X。你是哪个班的？"或"X X把文件夹…"这种重复。
 */
function renderUtterancePart(
  line: ConversationLine,
  part: RenderPart,
  index: number,
  opts: LinesFromViewOpts,
): string {
  if (line.kind !== "utterance" || part.channel === "notice" || !line.speaker) return part.text;
  if (line.speaker === opts.selfActorId) return part.text;
  const name = opts.nameOf(line.speaker);
  if (!name || part.text.trim() === "") return part.text;
  const rest = part.text.startsWith(name) ? part.text.slice(name.length) : undefined;
  const stripped = rest?.replace(/^[。，、：:！？；;\s]+/, "");
  if (part.channel === "action") {
    // 同一句已有台词时，动作是台词的延续，不再重复主语
    const hasContentBefore = line.parts.some(
      (p, i) => i < index && p.channel === "content" && p.text.trim() !== "",
    );
    if (rest !== undefined) {
      // 动作句以名字开头时名字就是主语：有台词前置时作为延续剥掉主语，否则原句已完整、直接用
      return hasContentBefore ? stripped! : part.text;
    }
    return hasContentBefore ? part.text : `${name}${part.text}`;
  }
  // 台词：只有「名字 + 分隔符/结尾」才算说话人标签；名字恰好是句子开头的一部分（"林雨来了"）
  // 时不剥，否则会把语义削掉（"来了"）。
  const isSpeakerLabel = rest !== undefined && (rest === "" || /^[。，、：:！？；;\s]/.test(rest));
  // 名字已出现在句首但不是说话人标签（"林雨来了"）：名字只出现一次，原样展示、不再拼前缀
  if (rest !== undefined && !isSpeakerLabel) return part.text;
  const body = isSpeakerLabel ? stripped! : part.text;
  return `${name}：${body}`;
}

export function linesFromView(view: ConversationView, opts: LinesFromViewOpts): Line[] {
  const out: Line[] = [];
  for (const line of view.lines) {
    line.parts.forEach((part, i) => {
      out.push({
        id: line.id * 100 + i,
        kind: lineKindFor(line, part.channel, opts.selfActorId),
        text: renderUtterancePart(line, part, i, opts),
      });
    });
  }
  return out;
}
