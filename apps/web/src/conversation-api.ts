/**
 * 群聊会话（v2）的 HTTP/SSE 客户端 + feature detect。
 *
 * 服务端（issue #89）尚未把 ConversationHostV2 挂到 HTTP/SSE，所以进房时先探
 * GET /api/v1/rooms/:roomId/conversation；探不到（404/5xx/网络异常）一律退回 v1
 * /turns，保证老流程零回归。这里只做传输与事件分发，渲染决策在 conversation-view.ts。
 */
import type { ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
import { apiFetch, jsonHeaders } from "./http.ts";
import { parseSsePart, splitSseBuffer } from "./sse.ts";

export function conversationProbePath(roomId: string): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation`;
}

export function conversationTurnPath(roomId: string): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/conversation/turns`;
}

/** 只有 2xx 算「v2 可用」；404/405/401/403/5xx 都退回 v1（保守，宁可不接也不坏老流程）。 */
export function isConversationAvailable(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 探测失败不是错误：老服务端就该没有这个端点，返回 false 让 App 用 v1。 */
export async function detectConversation(roomId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await apiFetch(conversationProbePath(roomId), signal ? { signal } : undefined);
    return isConversationAvailable(r.status);
  } catch {
    return false;
  }
}

export interface ConversationStreamHandlers {
  onEvent?: (ev: ConversationEvent) => void;
  onError?: (code: string, message: string, retryable?: boolean) => void;
  /** 流结束但既没 committed 也没 error：交给调用方按"未确认"处理，不盲目重发 */
  onUnconfirmed?: () => void;
}

/** SSE 事件块 → ConversationEvent；坏 JSON / 未知类型直接忽略，不让一条坏事件断流。 */
export function dispatchConversationEvent(data: string, h: ConversationStreamHandlers): boolean {
  let ev: ConversationEvent;
  try {
    ev = JSON.parse(data) as ConversationEvent;
  } catch {
    return false;
  }
  if (!ev || typeof ev.type !== "string" || !ev.type.startsWith("conversation.")) return false;
  if (ev.type === "conversation.error") h.onError?.(ev.code, ev.message, ev.retryable);
  h.onEvent?.(ev);
  return true;
}

/** POST + 读 SSE：一条会话回合一条流；结局与 v1 runTurn 对齐（commit/error/unconfirmed）。 */
export async function runConversationTurn(
  roomId: string,
  actorId: string,
  input: string,
  clientTurnId: string,
  h: ConversationStreamHandlers,
  signal?: AbortSignal,
  targetNpcId?: string,
): Promise<void> {
  const r = await apiFetch(conversationTurnPath(roomId), {
    method: "POST",
    headers: { ...jsonHeaders, accept: "text/event-stream" },
    body: JSON.stringify({ actorId, input, clientTurnId, ...(targetNpcId ? { targetNpcId } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok || !r.body) {
    let code = `HTTP_${r.status}`;
    let message = `conversation ${r.status}`;
    try {
      const body = (await r.json()) as { code?: string; message?: string };
      if (body.code) code = body.code;
      if (body.message) message = body.message;
    } catch {
      // 非 JSON 错误体：保留状态码
    }
    h.onError?.(code, message);
    return;
  }

  let settled = false;
  const tracked: ConversationStreamHandlers = {
    ...h,
    onEvent: (ev) => {
      if (ev.type === "conversation.committed" || ev.type === "conversation.error") settled = true;
      h.onEvent?.(ev);
    },
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { parts, rest } = splitSseBuffer(buf);
      buf = rest;
      for (const part of parts) {
        const parsed = parseSsePart(part);
        if (parsed) dispatchConversationEvent(parsed.data, tracked);
      }
    }
  } catch {
    if (settled || signal?.aborted) return;
    h.onUnconfirmed?.();
    return;
  }
  if (!settled) h.onUnconfirmed?.();
}
