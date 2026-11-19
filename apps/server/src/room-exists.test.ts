/**
 * 房间存在性缓存回归测试（issue #78）。
 *
 * 目标：`listRooms()` 不再被每次判定重复调用，同时建房/删房/外部写入后判定能刷新；
 * 404 语义与 listRooms 故障的 503 语义都不变。
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@galgame/testkit";
import type { Envelope, Store } from "../../../packages/shared/src/contract/types.ts";
import { createApp } from "./bootstrap.ts";
import type { ServerConfig } from "./config.ts";
import { makeRoomExists } from "./room-exists.ts";
import { registerRoutes } from "./routes.ts";

type RoomStore = Store & { listRooms?: () => Promise<string[]> };
type ListRoomsMock = ReturnType<typeof vi.fn<() => Promise<string[]>>>;

function roomStore(rooms: string[]): { store: RoomStore; listRooms: ListRoomsMock } {
  const listRooms: ListRoomsMock = vi.fn<() => Promise<string[]>>(async () => [...rooms]);
  const store = {
    listRooms,
    events: vi.fn(async () => [] as Envelope[]),
    snapshot: vi.fn(async () => ({}) as never),
    replay: vi.fn(async () => ({}) as never),
    flush: vi.fn(async () => {}),
  } as unknown as RoomStore;
  return { store, listRooms };
}

function testConfig(): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: tempDir("galgame-room-exists-"),
    contentDir: "content",
    adminToken: "dev-admin",
    trustUserHeader: true,
    llm: { baseUrl: "", model: "mock", apiKey: "", timeoutMs: 1000 },
    audit: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1000 },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("房间存在性缓存（issue #78）", () => {
  it("已证实存在的房间重复判定只扫一次；未知房间仍重扫并保持 404", async () => {
    const { store, listRooms } = roomStore(["room_a", "room_b"]);
    const exists = makeRoomExists(store, { ttlMs: 60_000 });

    expect(await exists("room_a")).toBe(true);
    expect(await exists("room_a")).toBe(true);
    expect(await exists("room_b")).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(1); // 三个正结果共享一次 listRooms()

    // 负结果不缓存：每次重扫，结论仍是 404（不改变 404 语义）
    expect(await exists("room_missing")).toBe(false);
    expect(await exists("room_missing")).toBe(false);
    expect(listRooms).toHaveBeenCalledTimes(3);
  });

  it("外部建房：房间不在缓存表 → 立即重扫可见（无需 invalidate）", async () => {
    const { store, listRooms } = roomStore(["room_a"]);
    const exists = makeRoomExists(store, { ttlMs: 60_000 });
    expect(await exists("room_a")).toBe(true);

    listRooms.mockImplementation(async () => ["room_a", "room_new"]);
    // 绕过 HTTP 端点的建房不进缓存，下一次判定重扫就能看到，不会误报 404
    expect(await exists("room_new")).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  it("删房：invalidate() 清掉正结果缓存，立刻变 404", async () => {
    const { store, listRooms } = roomStore(["room_a"]);
    const exists = makeRoomExists(store, { ttlMs: 60_000 });
    expect(await exists("room_a")).toBe(true);

    listRooms.mockImplementation(async () => []);
    expect(await exists("room_a")).toBe(true); // 淘汰前仍命中正结果缓存

    exists.invalidate();
    expect(await exists("room_a")).toBe(false);
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  it("TTL 到期：正结果缓存过期后重新扫目录", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { store, listRooms } = roomStore(["room_a"]);
    const exists = makeRoomExists(store, { ttlMs: 1000 });

    expect(await exists("room_a")).toBe(true);
    vi.setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
    expect(await exists("room_a")).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(1); // TTL 内命中缓存

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    expect(await exists("room_a")).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(2); // TTL 到期重扫
  });

  it("listRooms 故障不缓存：错误原样传播，恢复后下一次重试成功", async () => {
    const { store, listRooms } = roomStore([]);
    listRooms.mockImplementationOnce(async () => {
      throw Object.assign(new Error("EACCES: /secret/rooms"), { code: "EACCES" });
    });
    listRooms.mockResolvedValueOnce(["room_recovered"]);
    const exists = makeRoomExists(store, { ttlMs: 60_000 });

    await expect(exists("room_recovered")).rejects.toThrow("EACCES: /secret/rooms");
    expect(await exists("room_recovered")).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  it("无 listRooms 的事件探针替身：正结果缓存、负结果不缓存、invalidate 清空", async () => {
    const events = vi.fn(async (roomId: string) => (roomId === "room_a" ? ([{}] as Envelope[]) : []));
    const store = {
      events,
      snapshot: vi.fn(async () => ({}) as never),
      replay: vi.fn(async () => ({}) as never),
      flush: vi.fn(async () => {}),
    } as unknown as Store;
    const exists = makeRoomExists(store, { ttlMs: 60_000 });

    expect(await exists("room_a")).toBe(true);
    expect(await exists("room_a")).toBe(true);
    expect(events).toHaveBeenCalledTimes(1); // 正结果命中缓存

    expect(await exists("room_missing")).toBe(false);
    expect(events).toHaveBeenCalledTimes(2);

    // 外部新建房间：负结果没被缓存，立刻可见
    events.mockImplementation(async (roomId: string) => (["room_a", "room_ext"].includes(roomId) ? ([{}] as Envelope[]) : []));
    expect(await exists("room_ext")).toBe(true);
    expect(events).toHaveBeenCalledTimes(3);

    exists.invalidate();
    expect(await exists("room_a")).toBe(true);
    expect(events).toHaveBeenCalledTimes(4);
  });

  it("HTTP：缓存预热后建房仍可立刻 /state（invalidate 已接线），未知房间仍 404", async () => {
    const deps = await createApp(testConfig());
    const app = Fastify();
    registerRoutes(app, deps);
    const headers = { "x-user-id": "u78" };

    // 预热缓存：rooms 表此刻为空 → room_preheat 走 404，空表被缓存
    const pre = await app.inject({ method: "GET", url: "/api/v1/rooms/room_preheat/state", headers });
    expect(pre.statusCode).toBe(404);

    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers, payload: { mode: "solo", userId: "u78" } });
    expect(created.statusCode).toBe(200);
    const roomId = (created.json() as { roomId: string }).roomId;

    const state = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/state`, headers });
    expect(state.statusCode).toBe(200);

    const missing = await app.inject({ method: "GET", url: "/api/v1/rooms/room_never_created/state", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, code: "E_ROOM_NOT_FOUND" });
    await app.close();
  });
});
