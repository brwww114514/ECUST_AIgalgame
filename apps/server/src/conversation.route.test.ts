/**
 * dev/v2 群聊 HTTP 接线回归（issue #89）：
 * - 一回合 SSE 推 ConversationEvent；
 * - clientTurnId 重放不重复调模型/落库（幂等在 ConversationHostV2 内）；
 * - 老 /turns 不受影响；越权 actorId 403。
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { Proposal, WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { ConversationEvent, ConversationSessionV2 } from "../../../packages/shared/src/contract/v2.ts";
import { MockLlm } from "../../../packages/llm/src/mock.ts";
import {
  AuditGate,
  DEFAULT_AUDIT_POLICY,
  NoopAudit,
} from "../../../packages/engine/src/index.ts";
import type { EventLog } from "../../../packages/engine/src/store.ts";
import {
  ConversationAudit,
  ConversationHostV2,
  NpcAgent,
  SceneManager,
  type SceneAgentPort,
  loadConversationPolicy,
  loadModes,
} from "../../../packages/engine/src/v2/index.ts";
import { createApp, type App } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import type { ServerConfig } from "./config.ts";

const CONTENT = "content";
const MODES = `${CONTENT}/v2/utterance-modes.json`;
const POLICY = `${CONTENT}/v2/conversation-policy.json`;

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-conversation-"),
    contentDir: CONTENT,
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

const prevScan = process.env.GALGAME_GOSSIP_SCAN_MS;
afterAll(() => {
  if (prevScan === undefined) delete process.env.GALGAME_GOSSIP_SCAN_MS;
  else process.env.GALGAME_GOSSIP_SCAN_MS = prevScan;
});

async function appWith(): Promise<{ app: FastifyInstance; deps: App; roomId: string; actorId: string; llm: MockLlm }> {
  process.env.GALGAME_GOSSIP_SCAN_MS = "0";
  const deps = await createApp(testConfig());
  const { roomId, actorId } = await deps.createRoom("solo", "u_owner");

  // 用真实 host + 假 LLM：不为氛围调场景 agent，NPC 本轮一律沉默（断言只看玩家交付与结算）
  const modes = await loadModes(MODES);
  const policy = await loadConversationPolicy(POLICY);
  const scene: SceneAgentPort = { describe: async () => "test scene", summarize: async () => "test summary" };
  const llm = new MockLlm({ handler: () => JSON.stringify({ kind: "silent", reason: "test" }) });
  const audit = new NoopAudit();
  const store = deps.store as EventLog;
  const arbiter = deps.arbiter;
  deps.conversation = {
    host: new ConversationHostV2({
      store,
      arbiter,
      registry: deps.registry,
      memory: deps.memory,
      modes,
      policy,
      scene: new SceneManager(scene, () => 1000),
      npc: new NpcAgent({ llm, modes, policy }),
      audit: new ConversationAudit(audit, DEFAULT_AUDIT_POLICY, new AuditGate({ arbiter, store, registry: deps.registry, audit, policy: DEFAULT_AUDIT_POLICY })),
    }),
  };

  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps, roomId, actorId, llm };
}

/** SSE 文本 → {type, data}；断言结构不断言文案（AGENTS §6） */
function sse(body: string): { type: string; data: Record<string, unknown> }[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .flatMap((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const raw = /^data: (.+)$/m.exec(block)?.[1];
      return type && raw ? [{ type, data: JSON.parse(raw) as Record<string, unknown> }] : [];
    });
}

const payload = (actorId: string, clientTurnId: string) => ({
  actorId,
  clientTurnId,
  utterance: { id: `utt_${clientTurnId}`, mode: "broadcast", content: "大家好" },
});

/** 可控假 host：只实现路由用到的 open/get/run，让 SSE 断言不依赖 LLM/NPC 数量与文案 */
function fakeConversationHost(opts: {
  events: ConversationEvent[];
  openDelayMs?: number;
  runDelayMs?: number;
}): { host: ConversationHostV2; openCalls: () => number } {
  let opens = 0;
  const sessions = new Map<string, ConversationSessionV2>();
  const host = {
    async open(spec: { roomId: string; participants: string[] }): Promise<ConversationSessionV2> {
      opens += 1;
      if (opts.openDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.openDelayMs));
      const session: ConversationSessionV2 = {
        id: `conv_${opens}`,
        roomId: spec.roomId,
        participants: [...spec.participants],
        phase: "speaking", turn: 0, maxTurns: 10, status: "open",
        queue: [], injected: [], sceneBeats: [], npcSpeechStreak: 0, visibility: "scene",
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id: string): ConversationSessionV2 | undefined { return sessions.get(id); },
    async *run(_sessionId: string): AsyncIterable<ConversationEvent> {
      if (opts.runDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.runDelayMs));
      for (const ev of opts.events) yield ev;
    },
  } as unknown as ConversationHostV2;
  return { host, openCalls: () => opens };
}

/** 换掉 host 但不换房间/账号：房间仍由 createApp 真建，guardRoom/roomGate 照常生效 */
async function appWithHost(makeHost: (roomId: string, actorId: string) => ConversationHostV2) {
  process.env.GALGAME_GOSSIP_SCAN_MS = "0";
  const deps = await createApp(testConfig());
  const { roomId, actorId } = await deps.createRoom("solo", "u_owner");
  deps.conversation = { host: makeHost(roomId, actorId) };
  const app = Fastify();
  registerRoutes(app, deps);
  return { app, roomId, actorId };
}

/** 一个已认识、一个未认识的 NPC + 带私忆/GM 字段的 committed 状态（只断言结构，不断言文案） */
function viewState(roomId: string, known: string, unknown: string): WorldState {
  const npc = (id: string, name: string, knows: boolean) => ({
    id, kind: "npc" as const, name, attrs: { knows_name: knows }, tags: [],
    origin: "seed" as const, canon: true, status: "active" as const, createdAt: 0, updatedAt: 0,
  });
  return {
    schemaVersion: 1,
    room: {
      id: roomId, mode: "solo", worldId: "w1", members: [],
      scene: { locId: "loc", presentIds: [known, unknown] }, createdAt: 0, lastActiveAt: 0,
    },
    entities: { [known]: npc(known, "白晓通", true), [unknown]: npc(unknown, "严守一", false) },
    links: [],
    clock: { day: 1, phase: "morning", tick: 0 },
    plots: [{ id: "p1", goal: "g", actors: [known], forbidReveal: "GM_SECRET", status: "active" }],
    moduleState: { m1: { hidden: "HIDDEN_MODULE" } },
  };
}

describe("dev/v2 群聊 HTTP 端点（issue #89）", () => {
  it("正常回合：SSE 推 opened/utterance/committed，speaker 绑定为调用者", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: { ...payload(actorId, "c1"), utterance: { id: "utt_c1", mode: "broadcast", content: "大家好", speaker: "npc_forged" } },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["conversation.opened", "conversation.utterance", "conversation.committed"]));
    const deliveries = events.filter((e) => e.type === "conversation.utterance").map((e) => e.data.delivery as { speaker: string });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.speaker === actorId)).toBe(true);
    expect(events.some((e) => e.type === "conversation.error")).toBe(false);
    await app.close();
  });

  it("clientTurnId 重放：原样重放缓存事件，不重复调模型/落库", async () => {
    const { app, deps, roomId, actorId, llm } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const headers = { "x-user-id": "u_owner" };
    const first = await app.inject({ method: "POST", url, headers, payload: payload(actorId, "replay-1") });
    expect(first.statusCode).toBe(200);
    const eventsBefore = await deps.store.events(roomId, 0);
    const callsAfterFirst = llm.calls;

    const second = await app.inject({ method: "POST", url, headers, payload: payload(actorId, "replay-1") });
    expect(second.statusCode).toBe(200);
    expect(llm.calls).toBe(callsAfterFirst);
    expect(await deps.store.events(roomId, 0)).toEqual(eventsBefore);
    const committed = (body: string) => sse(body).filter((e) => e.type === "conversation.committed");
    expect(committed(second.body)).toEqual(committed(first.body));
    // 重放复用同一 session，不再发 opened
    expect(sse(second.body).some((e) => e.type === "conversation.opened")).toBe(false);
    await app.close();
  });

  it("老 /turns 不受影响", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "看看四周", clientTurnId: "v1-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(sse(res.body).map((e) => e.type)).toContain("turn.commit");
    await app.close();
  });

  it("越权 403：非本房账号不能提交群聊回合", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_other" },
      payload: payload(actorId, "denied-1"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });

  it("interject 是被插话的 NPC，不能拿来冒充调用者", async () => {
    const { app, roomId, actorId } = await appWith();
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const withoutActor = await app.inject({
      method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: { clientTurnId: "intercept-1", interject: "npc_x" },
    });
    expect(withoutActor.statusCode).toBe(400);

    // 带本人 actorId 时插话只切 phase，不推进回合；引擎收到的 interject 是 NPC id 而非玩家 id
    const withActor = await app.inject({
      method: "POST", url, headers: { "x-user-id": "u_owner" },
      payload: { actorId, clientTurnId: "intercept-2", interject: "npc_x" },
    });
    expect(withActor.statusCode).toBe(200);
    expect(sse(withActor.body).map((e) => e.type)).toContain("conversation.phase");
    await app.close();
  });

  it("事件结构与契约一致：committed 带 sessionId/turn/state", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: payload(actorId, "shape-1"),
    });
    const ev = sse(res.body).find((e) => e.type === "conversation.committed");
    expect(ev).toBeTruthy();
    const data = ev!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(typeof data.sessionId).toBe("string");
    expect(typeof data.turn).toBe("number");
    expect(data.state.room.id).toBe(roomId);
    await app.close();
  });

  it("BLOCKER-1：玩家 SSE 按观察者投影——无他人 mental/私聊，committed 私忆与 GM 字段裁掉，已认识名不回归", async () => {
    const KNOWN = "npc_known";
    const UNKNOWN = "npc_unknown";
    const { app, roomId, actorId } = await appWithHost((rid, viewer) => {
      const proposals: Proposal[] = [
        { op: "memory.write", args: { ownerId: KNOWN, content: "PUBLIC_MEMO", visibility: "public", tags: ["dialogue"], salience: 60 } },
        { op: "memory.write", args: { ownerId: KNOWN, content: "SECRET_THOUGHT_A", visibility: "secret", tags: ["mental"], salience: 80 } },
        { op: "plot.upsert", args: { id: "p1", goal: "g", forbidReveal: "GM_SECRET", status: "active" } },
      ];
      const events: ConversationEvent[] = [
        // 给别人的 whisper：正文里带标记，玩家侧连事件都不该收到
        { type: "conversation.utterance", delivery: { to: KNOWN, speaker: UNKNOWN, utteranceId: "u1", mode: "whisper", channels: ["content"], content: "SECRET_WHISPER" } },
        // 给玩家自己的广播：两个 NPC 名字都在正文里，只有未认识的应被遮掉
        { type: "conversation.utterance", delivery: { to: viewer, speaker: KNOWN, utteranceId: "u2", mode: "broadcast", channels: ["content"], content: "你好，白晓通和严守一" } },
        { type: "conversation.mental", actorId: KNOWN, mental: { actorId: KNOWN, thought: "SECRET_THOUGHT_B", salience: 4 } },
        { type: "conversation.committed", sessionId: "conv_1", turn: 1, proposals, state: viewState(rid, KNOWN, UNKNOWN) },
      ];
      return fakeConversationHost({ events }).host;
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
      payload: payload(actorId, "project-1"),
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events.some((e) => e.type === "conversation.mental")).toBe(false);
    expect(res.body).not.toContain("SECRET_THOUGHT_A");
    expect(res.body).not.toContain("SECRET_THOUGHT_B");
    expect(res.body).not.toContain("SECRET_WHISPER");
    expect(res.body).not.toContain("HIDDEN_MODULE");

    const utterances = events.filter((e) => e.type === "conversation.utterance");
    expect(utterances).toHaveLength(1);
    const delivery = (utterances[0]!.data as unknown as Extract<ConversationEvent, { type: "conversation.utterance" }>).delivery;
    expect(delivery.to).toBe(actorId);

    const committed = events.find((e) => e.type === "conversation.committed");
    expect(committed).toBeTruthy();
    const data = committed!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(data.proposals).toHaveLength(2); // 私忆 proposal 被裁掉，public 记忆与 plot 保留
    expect(data.proposals.some((p) => JSON.stringify(p).includes("SECRET_THOUGHT_A"))).toBe(false);
    expect(data.proposals.some((p) => p.op === "plot.upsert" && "forbidReveal" in p.args)).toBe(false);
    expect(data.state.plots[0]).not.toHaveProperty("forbidReveal");
    expect(Object.keys(data.state.moduleState)).toHaveLength(0);

    // 已认识的人名不回归；未认识的仍被遮成占位名（maskNamesDeep 在投影之后执行）
    expect(res.body).toContain("白晓通");
    expect(res.body).not.toContain("严守一");
    await app.close();
  });

  it("MAJOR-2：并发首回合只 open 一个会话（openOrReuse 纳入房间串行）", async () => {
    const fake = fakeConversationHost({ events: [], openDelayMs: 20, runDelayMs: 20 });
    const { app, roomId, actorId } = await appWithHost(() => fake.host);
    const url = `/api/v1/rooms/${roomId}/conversation`;
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: payload(actorId, "race-1") }),
      app.inject({ method: "POST", url, headers: { "x-user-id": "u_owner" }, payload: payload(actorId, "race-2") }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(fake.openCalls()).toBe(1);
    const opened = [a, b].flatMap((r) => sse(r.body)).filter((e) => e.type === "conversation.opened");
    expect(opened).toHaveLength(1);
    await app.close();
  });
});

/** 前端（#85）契约对齐：GET 探测 + POST /conversation/turns 别名，保持与规范端点同一 SSE 形状 */
describe("dev/v2 群聊端点（issue #85/#89 契约对齐）", () => {
  it("GET /conversation 探测返回 200（前端据此判定 v2 可用，不再误退回 v1）", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_owner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, v2: true });
    await app.close();
  });

  it("MAJOR-1：GET /conversation 探测同样过 guardRoom——非本房账号 403，不能探测房间存在", async () => {
    const { app, roomId } = await appWith();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/conversation`,
      headers: { "x-user-id": "u_other" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });

  it("POST /conversation/turns 别名接受 {actorId,input,clientTurnId}，推同样 SSE 且 speaker 绑定", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "大家好", clientTurnId: "alias-1" },
    });
    expect(res.statusCode).toBe(200);
    const ev = sse(res.body).find((e) => e.type === "conversation.committed");
    expect(ev).toBeTruthy();
    const data = ev!.data as unknown as Extract<ConversationEvent, { type: "conversation.committed" }>;
    expect(data.state.room.id).toBe(roomId);
    await app.close();
  });

  it("别名端点带在场 targetNpcId 时仍能结算（addressed 模式，不因 target 校验失败）", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_owner" },
      payload: { actorId, input: "你好", clientTurnId: "alias-target-1", targetNpcId: "npc_lin" },
    });
    expect(res.statusCode).toBe(200);
    expect(sse(res.body).map((e) => e.type)).toContain("conversation.committed");
    await app.close();
  });

  it("别名端点越权 403 与规范端点一致", async () => {
    const { app, roomId, actorId } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/conversation/turns`,
      headers: { "x-user-id": "u_other" },
      payload: { actorId, input: "hi", clientTurnId: "alias-denied-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: "E_FORBIDDEN" });
    await app.close();
  });
});
