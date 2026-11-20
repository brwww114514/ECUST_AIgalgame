/** 调试面板 HTTP 层：只做解锁与拉快照，不持有任何权威状态。 */
import { apiFetch } from "./http.ts";

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

export interface DebugNpc {
  id: string;
  name: string;
  kind: string;
  attrs: Record<string, unknown>;
  tags: string[];
}

export interface DebugEvent {
  seq: number;
  ts: number;
  type: string;
  actorId: string;
}

export interface DebugSnapshot {
  roomId: string;
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

const TOKEN_KEY = "ecust.galgame.debugToken";

export function cachedDebugToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function cacheToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 无痕模式下 sessionStorage 不可用：令牌只在内存里活到刷新 */
  }
}

export function clearDebugToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 口令错误返回 null；网络/服务端未启用（404）抛错，调用方区分提示。 */
export async function unlockDebug(passphrase: string): Promise<string | null> {
  const r = await apiFetch("/api/v1/debug/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (r.status === 404) throw new Error("服务端未开启调试模式（未配置调试口令）");
  if (!r.ok) {
    if (r.status === 401) return null;
    throw new Error(`解锁失败（HTTP ${r.status}）`);
  }
  const data = (await r.json()) as { ok: boolean; token: string };
  if (!data.ok || !data.token) throw new Error("解锁响应异常");
  cacheToken(data.token);
  return data.token;
}

export async function fetchDebugSnapshot(roomId: string, token: string): Promise<DebugSnapshot> {
  const r = await apiFetch(`/api/v1/debug/rooms/${encodeURIComponent(roomId)}/snapshot`, {
    headers: { "x-debug-token": token },
  });
  if (r.status === 401) {
    clearDebugToken();
    throw new Error("调试会话已过期，请重新输入口令");
  }
  if (!r.ok) throw new Error(`读取调试快照失败（HTTP ${r.status}）`);
  const data = (await r.json()) as { ok: boolean; snapshot: DebugSnapshot };
  if (!data.ok) throw new Error("调试快照响应异常");
  return data.snapshot;
}
