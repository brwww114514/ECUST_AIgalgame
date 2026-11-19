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
import type { ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
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
});
