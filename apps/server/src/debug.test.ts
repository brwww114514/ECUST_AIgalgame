/**
 * 调试模式回归：
 * - 口令未配置 → 端点不注册（404），不会泄漏调试入口；
 * - 口令错误 → 401，且不发令牌；
 * - 正确口令 → 拿到 TTL 令牌，令牌能读快照（含 NPC 私忆与心理活动、NPC↔NPC 私信）；
 * - 令牌错误/过期 → 401。
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import { registerRoutes } from "./routes.ts";
import { createDebugGate, type DebugGate } from "./debug.ts";
import type { ServerConfig } from "./config.ts";

const PASS = "Craneus is my father";

function testConfig(passphrase?: string): ServerConfig {
  return {
    port: 0, host: "127.0.0.1", dataDir: tempDir("galgame-debug-"), contentDir: "content",
    adminToken: "dev-admin", trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
    debugPassphrase: passphrase,
  };
}

const prevScan = process.env.GALGAME_GOSSIP_SCAN_MS;
afterAll(() => {
  if (prevScan === undefined) delete process.env.GALGAME_GOSSIP_SCAN_MS;
  else process.env.GALGAME_GOSSIP_SCAN_MS = prevScan;
});

describe("调试模式口令门", () => {
  it("口令比较正确/错误 + TTL 过期", () => {
    const gate = createDebugGate(PASS) as DebugGate;
    expect(gate.unlock("wrong")).toBeNull();
    let now = 1_000_000;
    const token = gate.unlock(PASS, now) as string;
    expect(token).toBeTruthy();
    expect(gate.verify(token, now)).toBe(true);
    now += 31 * 60 * 1000;
    expect(gate.verify(token, now)).toBe(false);
  });

  it("口令未配置时解锁端点 404", async () => {
    process.env.GALGAME_GOSSIP_SCAN_MS = "0";
    const deps = await createApp(testConfig());
    const app: FastifyInstance = Fastify();
    registerRoutes(app, deps);
    const res = await app.inject({ method: "POST", url: "/api/v1/debug/unlock", payload: { passphrase: PASS } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("错误口令 401；正确口令可解锁并读取快照（含私忆/心理活动/私信）", async () => {
    process.env.GALGAME_GOSSIP_SCAN_MS = "0";
    const deps = await createApp(testConfig(PASS));
    const { roomId } = await deps.createRoom("solo", "u_debug");
    const app: FastifyInstance = Fastify();
    registerRoutes(app, deps);

    const bad = await app.inject({ method: "POST", url: "/api/v1/debug/unlock", payload: { passphrase: "nope" } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/v1/debug/unlock", payload: { passphrase: PASS } });
    expect(ok.statusCode).toBe(200);
    const token = ok.json().token as string;
    expect(token).toBeTruthy();

    const noToken = await app.inject({ method: "GET", url: `/api/v1/debug/rooms/${roomId}/snapshot` });
    expect(noToken.statusCode).toBe(401);

    const snap = await app.inject({
      method: "GET", url: `/api/v1/debug/rooms/${roomId}/snapshot`, headers: { "x-debug-token": token },
    });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();
    expect(body.ok).toBe(true);
    expect(body.snapshot.roomId).toBe(roomId);
    expect(body.snapshot).toHaveProperty("npcs");
    expect(body.snapshot).toHaveProperty("memories");
    expect(body.snapshot).toHaveProperty("mental");
    expect(body.snapshot).toHaveProperty("messages");
    expect(body.snapshot).toHaveProperty("events");
    expect(body.snapshot.counts).toBeTruthy();
    await app.close();
  });

  it("/debug/unlock 在线爆破防护：同 IP 5 次失败/分钟 → 429", async () => {
    process.env.GALGAME_GOSSIP_SCAN_MS = "0";
    const deps = await createApp(testConfig(PASS));
    const app: FastifyInstance = Fastify();
    registerRoutes(app, deps);
    let last = 401;
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "POST", url: "/api/v1/debug/unlock", payload: { passphrase: "wrong" } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("非法 roomId 400；不存在的房间 404", async () => {
    process.env.GALGAME_GOSSIP_SCAN_MS = "0";
    const deps = await createApp(testConfig(PASS));
    const app: FastifyInstance = Fastify();
    registerRoutes(app, deps);
    const token = (await app.inject({ method: "POST", url: "/api/v1/debug/unlock", payload: { passphrase: PASS } })).json().token as string;
    const headers = { "x-debug-token": token };

    const bad = await app.inject({ method: "GET", url: "/api/v1/debug/rooms/..%2F..%2Fpwn/snapshot", headers });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: "GET", url: "/api/v1/debug/rooms/room_nope/snapshot", headers });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
