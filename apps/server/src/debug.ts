/**
 * 调试模式的服务端能力（只读）：
 * - 口令解锁：口令来自环境变量，不写进代码/仓库；常量时间比较，令牌有 TTL。
 * - 快照组装：世界状态 + 私忆/心理活动 + 私信 + 最近事件，全部来自服务端投影。
 *
 * 这里不新增 op、不改状态；调试面板只消费快照，不参与裁决（I1）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MemoryRecord, RoomId, Store } from "../../../packages/shared/src/contract/types.ts";

export const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 32;

export interface DebugSession {
  expiresAt: number;
}

/** 口令未配置时返回 null：调试端点整体不注册，前端点开也只会收到 404。 */
export function createDebugGate(passphrase: string): DebugGate | null {
  return passphrase.trim() ? new DebugGate(passphrase) : null;
}

export class DebugGate {
  private readonly secret: Buffer;
  private readonly sessions = new Map<string, DebugSession>();

  constructor(passphrase: string) {
    this.secret = Buffer.from(passphrase, "utf8");
  }

  unlock(passphrase: string, now = Date.now()): string | null {
    const got = Buffer.from(passphrase, "utf8");
    if (got.length !== this.secret.length || !timingSafeEqual(got, this.secret)) return null;
    this.prune(now);
    if (this.sessions.size >= MAX_TOKENS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { expiresAt: now + TOKEN_TTL_MS });
    return token;
  }

  verify(token: string, now = Date.now()): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** 只清过期令牌；上限淘汰在 unlock 里由 Map 插入顺序兜底。 */
  private prune(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export interface DebugMemory {
  id: string;
  ownerId: string;
  content: string;
  tags: string[];
  salience: number;
  about: string[];
  visibility: string;
  tier: string;
  turn: number;
  createdAt: number;
}

export interface DebugMessage {
  id: string;
  from: string;
  to: string;
  kind: string;
  content: string;
  hop: number;
  confidence: number;
  createdAt: number;
}

export interface DebugEvent {
  seq: number;
  ts: number;
  type: string;
  actorId: string;
}

export interface DebugNpc {
  id: string;
  name: string;
  kind: string;
  attrs: Record<string, unknown>;
  tags: string[];
}

export interface DebugSnapshot {
  roomId: RoomId;
  generatedAt: number;
  clock: unknown;
  npcs: DebugNpc[];
  memories: DebugMemory[];
  mental: DebugMemory[];
  messages: DebugMessage[];
  events: DebugEvent[];
  plots: unknown[];
  links: unknown[];
  counts: { entities: number; memories: number; mental: number; messages: number; events: number };
}

function toDebugMemory(r: MemoryRecord): DebugMemory {
  return {
    id: r.id,
    ownerId: r.ownerId,
    content: r.content,
    tags: r.tags,
    salience: r.salience,
    about: r.about,
    visibility: r.visibility,
    tier: r.tier,
    turn: r.turn,
    createdAt: r.createdAt,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 私信是 EventLog 的投影，不进 WorldState；这里直接读事件，调试台能看到 NPC↔NPC 的全部内容。 */
function messagesFromEvents(envs: readonly { type: string; payload: unknown }[]): DebugMessage[] {
  const out: DebugMessage[] = [];
  for (const env of envs) {
    if (env.type !== "msg.sent" || !isRecord(env.payload) || !isRecord(env.payload.message)) continue;
    const m = env.payload.message;
    if (
      typeof m.id !== "string" || typeof m.from !== "string" || typeof m.to !== "string" ||
      typeof m.content !== "string" || typeof m.kind !== "string"
    ) continue;
    out.push({
      id: m.id,
      from: m.from,
      to: m.to,
      kind: m.kind,
      content: m.content,
      hop: typeof m.hop === "number" ? m.hop : 0,
      confidence: typeof m.confidence === "number" ? m.confidence : 1,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
    });
  }
  return out;
}

export async function buildDebugSnapshot(
  roomId: RoomId,
  store: Store,
  memory: { all(roomId: RoomId): MemoryRecord[] },
): Promise<DebugSnapshot> {
  const [state, envs] = await Promise.all([store.snapshot(roomId), store.events(roomId, 0, 300)]);
  const records = memory.all(roomId);
  const mental = records
    .filter((r) => r.tags.includes("mental"))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toDebugMemory);
  const messages = messagesFromEvents(envs);
  const npcs = Object.values(state.entities)
    .filter((e) => e.kind === "npc")
    .map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      attrs: e.attrs as Record<string, unknown>,
      tags: e.tags,
    }));
  return {
    roomId,
    generatedAt: Date.now(),
    clock: state.clock,
    npcs,
    memories: records
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toDebugMemory),
    mental,
    messages,
    events: envs.slice(-80).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actorId: e.actorId })),
    plots: state.plots,
    links: state.links,
    counts: {
      entities: Object.keys(state.entities).length,
      memories: records.length,
      mental: mental.length,
      messages: messages.length,
      events: envs.length,
    },
  };
}
