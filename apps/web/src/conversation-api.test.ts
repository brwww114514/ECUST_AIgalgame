import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationProbePath,
  conversationTurnPath,
  detectConversation,
  dispatchConversationEvent,
  isConversationAvailable,
  runConversationTurn,
} from "./conversation-api.ts";
import type { ConversationStreamHandlers } from "./conversation-api.ts";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();

function sseResponse(chunks: string[], opts: { errorAfter?: boolean } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.errorAfter) controller.error(new Error("connection reset"));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("feature detect（纯判定 + 探测退化）", () => {
  it("只有 2xx 算可用；404/405/401/403/5xx 一律退化", () => {
    expect(isConversationAvailable(200)).toBe(true);
    expect(isConversationAvailable(204)).toBe(true);
    for (const s of [301, 401, 403, 404, 405, 500, 501]) expect(isConversationAvailable(s)).toBe(false);
  });

  it("路径不猜错：探 conversation，回合走 conversation/turns", () => {
    expect(conversationProbePath("room 1")).toBe("/api/v1/rooms/room%201/conversation");
    expect(conversationTurnPath("room_1")).toBe("/api/v1/rooms/room_1/conversation/turns");
  });

  it("探测 404 → false；200 → true；fetch 抛错也当 false（不打断进房）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await detectConversation("r1")).toBe(false);
    expect(await detectConversation("r1")).toBe(true);
    expect(await detectConversation("r1")).toBe(false);
  });
});

describe("dispatchConversationEvent", () => {
  it("正常事件进 onEvent；error 事件额外触发 onError 并带 retryable", () => {
    const events: string[] = [];
    const errors: string[] = [];
    const h: ConversationStreamHandlers = {
      onEvent: (ev) => events.push(ev.type),
      onError: (code, _msg, retryable) => errors.push(`${code}:${retryable}`),
    };
    expect(dispatchConversationEvent('{"type":"conversation.utterance"}', h)).toBe(true);
    expect(dispatchConversationEvent('{"type":"conversation.error","code":"E_STORE_FAULT","message":"m","retryable":true}', h)).toBe(true);
    expect(events).toEqual(["conversation.utterance", "conversation.error"]);
    expect(errors).toEqual(["E_STORE_FAULT:true"]);
  });

  it("坏 JSON / 非 conversation 事件被忽略，不抛错", () => {
    const h: ConversationStreamHandlers = { onEvent: () => { throw new Error("should not fire"); } };
    expect(dispatchConversationEvent("not json", h)).toBe(false);
    expect(dispatchConversationEvent('{"type":"turn.commit"}', h)).toBe(false);
  });
});

describe("runConversationTurn 结局判定", () => {
  it("committed：不触发 onUnconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.committed\ndata: {"type":"conversation.committed","sessionId":"s","turn":1,"proposals":[],"state":{}}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct1", {
      onEvent: (ev) => calls.push(ev.type),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["conversation.committed"]);
  });

  it("error：透传 code 与 retryable，不触发 onUnconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.error\ndata: {"type":"conversation.error","sessionId":"s","code":"E_LLM_TIMEOUT","message":"慢","retryable":true}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct2", {
      onError: (code, _m, retryable) => calls.push(`${code}:${retryable}`),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["E_LLM_TIMEOUT:true"]);
  });

  it("EOF 无 committed/error → onUnconfirmed（交给上层核对，不盲目重发）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'event: conversation.utterance\ndata: {"type":"conversation.utterance","delivery":{"to":"plr"}}\n\n',
    ])));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct3", {
      onEvent: (ev) => calls.push(ev.type),
      onUnconfirmed: () => calls.push("unconfirmed"),
    });
    expect(calls).toEqual(["conversation.utterance", "unconfirmed"]);
  });

  it("HTTP 404 拒绝：onError 带服务端 code（探测之外的运行时兜底）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, code: "E_CONV_NOT_FOUND", message: "无会话" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )));
    const calls: string[] = [];
    await runConversationTurn("r", "plr", "hi", "ct4", {
      onError: (code, message) => calls.push(`${code}:${message}`),
    });
    expect(calls).toEqual(["E_CONV_NOT_FOUND:无会话"]);
  });
});
