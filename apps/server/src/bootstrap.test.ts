/**
 * 装配层回归测试：真实 content/ + tempDir 存档。
 *
 * 覆盖三个曾经静默坏掉的点：
 *   ① canon 没写 startLocId 时开场场景必须是 locs[0]（否则建房的 move.to 全部不相邻）；
 *   ② 玩家与 NPC 的开场 located_in / presentIds 必须真的落库；
 *   ③ solo 房 members 为空时 tick 的 playerActorId 仍应是玩家而不是 "system"。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { registerRoutes } from "./routes.ts";
import { describe, expect, it } from "vitest";
import { tempDir } from "@galgame/testkit";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-bootstrap-test-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    // 审核器不配置 = NoopAudit（放行态），测试不联网
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

describe("bootstrap", () => {
  it("坏档不阻断启动，访问坏房间返回存储故障，正常房间仍可读取", async () => {
    const cfg = testConfig();
    const original = await createApp(cfg);
    const good = await original.createRoom("solo");
    const bad = await original.createRoom("solo");
    const file = path.join(cfg.dataDir, "rooms", `${bad.roomId}.jsonl`);
    const broken = (await readFile(file, "utf8")) + '{"v":1';
    await writeFile(file, broken);
    await writeFile(path.join(cfg.dataDir, "rooms", "room_old.history.jsonl"), "{}\n");

    const deps = await createApp(cfg);
    const app = Fastify();
    registerRoutes(app, deps);
    try {
      const failed = await app.inject({ url: `/api/v1/rooms/${bad.roomId}/state` });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ code: "E_STORE_FAULT" });
      const healthy = await app.inject({ url: `/api/v1/rooms/${good.roomId}/state` });
      expect(healthy.statusCode).toBe(200);
      expect(await readFile(file, "utf8")).toBe(broken);
    } finally {
      await app.close();
    }
  });

  it("建房把玩家与 NPC 的初始位置真正写进世界", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const state = await deps.store.snapshot(roomId);

    expect(state.room.scene.locId).toBe("loc_library");
    // 出生点的 NPC 开场就该在场：他们本来就在这儿，不该等下一次移动才被"看见"
    expect(state.room.scene.presentIds).toContain(actorId);
    expect(state.room.scene.presentIds).toContain("npc_lin");
    expect(state.room.scene.presentIds).toContain("npc_bai");
    // 每个 NPC 的初始位置以 canon 的 locId 为准（不在出生点的就不该出现在场列表里）
    const expected: Record<string, string> = {
      npc_zhou: "loc_teaching_1",
      npc_lin: "loc_library",
      npc_ma: "loc_canteen",
      npc_yan: "loc_teaching_1",
      npc_jin: "loc_canteen",
      npc_bai: "loc_library",
      npc_lu: "loc_playground",
    };
    for (const [npcId, locId] of Object.entries(expected)) {
      const link = state.links.find((l) => l.kind === "located_in" && l.from === npcId);
      expect(link?.to, `NPC ${npcId} 的初始 located_in`).toBe(locId);
      if (locId !== "loc_library") {
        expect(state.room.scene.presentIds, `${npcId} 不该出现在场列表`).not.toContain(npcId);
      }
    }
  });

  it("tick 用玩家 actorId 推进日程，且 NPC 真的移动", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const res = await deps.map.tick(roomId, { advance: true });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.clock.phase).toBe("noon");
    expect(res.map.player.actorId).toBe(actorId);
    // 具体移动人数取决于 npc-schedules.json 与初始位置的差集，这里只要求"确实有人动了"
    expect(res.moved.length).toBeGreaterThan(0);
    expect(res.map.npcs.every((n) => n.locId === "loc_canteen")).toBe(true);
  });

  it("建房只播种 public 属性：默认值落库，secret/self 不预填", async () => {
    const deps = await createApp(testConfig());
    const { roomId, actorId } = await deps.createRoom("solo");
    const state = await deps.store.snapshot(roomId);

    const me = state.entities[actorId];
    expect(me?.attrs.money).toBe(200); // public 默认值落库
    expect(me?.attrs.stamina).toBe(100);

    // secret 绝不预填（guard/debt），self 由玩法写入（trust/mood）
    expect(me?.attrs.guard).toBeUndefined();
    expect(me?.attrs.debt).toBeUndefined();
    expect(me?.attrs.trust).toBeUndefined();
    expect(me?.attrs.mood).toBeUndefined();

    // 隐藏坐标属性也不预填（否则所有地点叠在原点）
    expect(me?.attrs.coord_x).toBeUndefined();
    expect(me?.attrs.coord_y).toBeUndefined();

    const npc = state.entities["npc_lin"];
    expect(npc?.attrs.stamina).toBe(100);
    expect(npc?.attrs.guard).toBeUndefined();
    expect(npc?.attrs.trust).toBeUndefined();
  });
});
