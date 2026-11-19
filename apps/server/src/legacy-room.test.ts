/**
 * issue #92：旧房间兼容回归。
 *
 * v2 没有给 WorldState / v1 事件日志加必填字段：会话在进程内、私信由 msg.sent
 * 事件投影，都不落进 `data/rooms/<roomId>.jsonl`。因此 v2 之前建的存档只有 v1
 * 事件（无 msg.sent、无 audience）。新代码必须仍能 /state /events /history 走
 * 默认值，并可继续跑一回合。断言结构与状态码，不断言叙事文案。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { Envelope, TurnEvent } from "../../../packages/shared/src/index.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { registerRoutes } from "./routes.ts";

function testConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

async function collect(iterable: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const prevScan = process.env.GALGAME_GOSSIP_SCAN_MS;
afterAll(() => {
  if (prevScan === undefined) delete process.env.GALGAME_GOSSIP_SCAN_MS;
  else process.env.GALGAME_GOSSIP_SCAN_MS = prevScan;
});

describe("旧房间兼容（issue #92）", () => {
  it("无 v2 字段的旧存档：/state /events /history 走默认值，且能继续跑一回合", async () => {
    // 关掉后台八卦扫描，避免测试期间生成 msg.sent 干扰"旧存档无 v2 字段"的前提
    process.env.GALGAME_GOSSIP_SCAN_MS = "0";
    const dataDir = tempDir("galgame-legacy-room-");

    // ① 生成一个只有 v1 事件的房间存档（模拟 v2 之前建好的旧存档）
    const first = await createApp(testConfig(dataDir));
    const { roomId, actorId } = await first.createRoom("solo", "u_old");
    const turn1 = await collect(first.turn.run({ roomId, actorId, input: "去图书馆", clientTurnId: "c1", userId: "u_old" }));
    expect(turn1.at(-1)?.type).toBe("turn.commit");

    const raw = await readFile(join(dataDir, "rooms", `${roomId}.jsonl`), "utf8");
    const envs: Envelope[] = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Envelope);
    expect(envs.length).toBeGreaterThan(0);
    // 这份存档确实没有任何 v2 字段
    expect(envs.some((e) => e.type === "msg.sent")).toBe(false);
    expect(envs.some((e) => e.audience !== undefined)).toBe(false);

    // ② 重启（同 dataDir）：新代码读旧存档，三个只读端点都应走默认值
    const deps = await createApp(testConfig(dataDir));
    const app = Fastify();
    registerRoutes(app, deps);
    const headers = { "x-user-id": "u_old" };
    try {
      const stateRes = await app.inject({ url: `/api/v1/rooms/${roomId}/state`, headers });
      expect(stateRes.statusCode).toBe(200);
      expect(stateRes.json()).toMatchObject({
        schemaVersion: expect.any(Number),
        room: expect.any(Object),
        entities: expect.any(Object),
        clock: expect.any(Object),
        plots: expect.any(Array),
        moduleState: expect.any(Object),
      });

      const eventsRes = await app.inject({ url: `/api/v1/rooms/${roomId}/events?actorId=${actorId}`, headers });
      expect(eventsRes.statusCode).toBe(200);
      const eventsBody = eventsRes.json();
      expect(Array.isArray(eventsBody.events)).toBe(true);
      expect(eventsBody.events.some((e: { type: string }) => e.type === "msg.sent")).toBe(false);
      expect(typeof eventsBody.lastSeq).toBe("number");

      const historyRes = await app.inject({ url: `/api/v1/rooms/${roomId}/history`, headers });
      expect(historyRes.statusCode).toBe(200);
      expect(Array.isArray(historyRes.json().history)).toBe(true);
    } finally {
      await app.close();
    }

    // ③ 旧存档上接着跑一回合：seq 连续、正常 commit
    const before = await deps.store.events(roomId, 0);
    const lastSeq = before.at(-1)?.seq ?? 0;
    const turn2 = await collect(deps.turn.run({ roomId, actorId, input: "继续", clientTurnId: "c2", userId: "u_old" }));
    const commit = turn2.at(-1);
    expect(commit?.type).toBe("turn.commit");
    if (commit?.type === "turn.commit") expect(commit.seq).toBeGreaterThanOrEqual(lastSeq);
  });
});
