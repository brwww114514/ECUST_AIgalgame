/**
 * 微信收件箱的纯逻辑：去重 / 可见性 / 发送防抖 / 错误提示。
 * 与 React、fetch 解耦，node 环境 vitest 可直接测（vitest.config.ts 只收 *.test.ts）。
 * 权威数据只来自服务端：这里只读 MessageRecord 的信封字段，绝不解析正文里的秘密。
 */
import { z } from "zod";
import type { GossipEvent, MessageRecord, MsgKind } from "../../../packages/shared/src/contract/v2.ts";

/** 服务端不节流玩家发信，前端 500ms 锁 + inFlight 双保险 */
export const SEND_LOCK_MS = 500;
/** SSE 断线后的重连间隔；重连重放的消息由 id 去重兜底 */
export const SSE_RECONNECT_MS = 1500;

/** SSE/HTTP 外部输入的边界校验：zod 解析一次，后面都是强类型 */
export const MessageRecordSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(["gossip", "reply", "player", "system"]),
  content: z.string(),
  rootId: z.string().optional(),
  replyTo: z.string().optional(),
  hop: z.number(),
  confidence: z.number(),
  visibility: z.literal("private"),
  createdAt: z.number(),
  seq: z.number(),
});

/** 只认 gossip.message 事件；其它 GossipEvent（delivered/dropped/committed/error）不进收件箱 */
export function parseGossipMessageEvent(data: string): MessageRecord | null {
  try {
    const raw: unknown = JSON.parse(data);
    if (typeof raw !== "object" || raw === null) return null;
    const obj = raw as { type?: unknown; message?: unknown };
    if (obj.type !== "gossip.message") return null;
    const parsed = MessageRecordSchema.safeParse(obj.message);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 按 message.id 去重并稳定排序。
 * 先出现的记录保留（GET 的权威列表优先于 SSE 重放），seq 决定时间顺序。
 */
export function mergeMessages(
  current: readonly MessageRecord[],
  incoming: readonly MessageRecord[],
): MessageRecord[] {
  const byId = new Map<string, MessageRecord>();
  for (const m of current) if (!byId.has(m.id)) byId.set(m.id, m);
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/** 一条 SSE 事件投影进收件箱；非 gossip.message 原样返回当前列表 */
export function applyGossipEvent(current: readonly MessageRecord[], ev: GossipEvent): MessageRecord[] {
  return ev.type === "gossip.message" ? mergeMessages(current, [ev.message]) : [...current];
}

/** POST 成功后以服务端返回的 events 为准批量并入（一次请求可能带多条） */
export function applyGossipEvents(current: readonly MessageRecord[], events: readonly GossipEvent[]): MessageRecord[] {
  return events.reduce<MessageRecord[]>((acc, ev) => applyGossipEvent(acc, ev), [...current]);
}

/**
 * 收件箱只渲染服务端判定为"本人收发"的消息。
 * 用服务端下发的 from/to/visibility 信封字段判断，不自行解码正文；
 * 即使 SSE 重连重放或有人伪造事件，第三方的 private 消息也不会显示。
 */
export function visibleFor(messages: readonly MessageRecord[], actorId: string): MessageRecord[] {
  if (!actorId) return [];
  return messages.filter((m) => m.visibility === "private" && (m.from === actorId || m.to === actorId));
}

export interface SendLock {
  /** 上次成功占用发送的时间戳；0 = 还没发过 */
  lastClaimAt: number;
}

/**
 * 发送锁的纯状态转移：锁内连点返回 allowed:false 且不更新时间戳，
 * 所以连点不会续期锁；锁过期后下一次点击立即放行。
 */
export function claimSend(
  lock: SendLock,
  now: number,
  lockMs = SEND_LOCK_MS,
): { allowed: boolean; next: SendLock } {
  if (lock.lastClaimAt > 0 && now - lock.lastClaimAt < lockMs) return { allowed: false, next: lock };
  return { allowed: true, next: { lastClaimAt: now } };
}

const SEND_ERROR_NOTICES: Record<string, string> = {
  E_CONTENT_BLOCKED: "内容被审核拦截，消息未发送；请修改后重试。",
  E_AUDIT_UNAVAILABLE: "审核服务暂不可用，消息未发送；请稍后重试。",
};

/** 审核拦截不能静默吞掉，给玩家可见提示 */
export function sendErrorNotice(code: string): string {
  return SEND_ERROR_NOTICES[code] ?? `发送失败（${code}）`;
}

/** 越权 403 是"身份不匹配"，不是网络错误：给降级提示且不自动重试；其它状态交给通用错误处理 */
export function inboxLoadNotice(status: number): string | null {
  if (status === 403) return "没有权限查看此收件箱：actorId 与当前身份不符。请返回标题重新进入房间。";
  if (status === 400) return "收件箱请求缺少身份信息，请重新进入房间。";
  return null;
}

const KIND_LABELS: Record<MsgKind, string> = {
  player: "发送",
  gossip: "八卦",
  reply: "回复",
  system: "系统",
};

export function kindLabel(kind: MsgKind): string {
  return KIND_LABELS[kind] ?? "消息";
}

/** 0~1 的传播可信度 → 百分比文案 */
export function confidencePercent(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

export function formatCreatedAt(createdAt: number): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
