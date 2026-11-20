/**
 * 调试面板 HTTP 端点（只读）。口令解锁后拿到 TTL 令牌，后续请求只认令牌。
 * 这里不做房间归属授权：调试模式是开发者全局视图，令牌本身就是第二道门。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RoomId, Store } from "../../../packages/shared/src/contract/types.ts";
import { isSafeRoomId } from "../../../packages/engine/src/store.ts";
import { buildDebugSnapshot, TOKEN_TTL_MS, type DebugGate } from "./debug.ts";
import { progressiveDelayMs, RateLimiter, sleep } from "./rate-limit.ts";

const UnlockBody = z.object({ passphrase: z.string().max(256) });
const UNLOCK_FAIL = { ok: false, code: "E_UNAUTHORIZED", message: "调试口令错误" } as const;

export interface DebugRouteDeps {
  gate: DebugGate;
  store: Store;
  memory: { all(roomId: RoomId): import("../../../packages/shared/src/contract/types.ts").MemoryRecord[] };
  roomExists(roomId: string): Promise<boolean>;
}

function tokenOf(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

export function registerDebugRoutes(app: FastifyInstance, deps: DebugRouteDeps): void {
  // P2：unlock 端点在线爆破防护——同 IP 5 次/分钟（与 auth/login 同款），失败渐进延迟。
  const unlockLimiter = new RateLimiter(5, 60_000);
  app.post("/api/v1/debug/unlock", async (req, reply) => {
    const ip = req.ip;
    const decision = unlockLimiter.hit(`dbg:${ip}`);
    if (!decision.allowed) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      return reply.code(429).send({ ok: false, code: "E_RATE_LIMITED", message: "尝试过于频繁，请稍后再试" });
    }
    await sleep(progressiveDelayMs(unlockLimiter.count(`dbg:${ip}`)));
    const parsed = UnlockBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      // 不区分“口令错/长度错”，避免探测口令结构。
      return reply.code(401).send(UNLOCK_FAIL);
    }
    const token = deps.gate.unlock(parsed.data.passphrase);
    if (!token) {
      return reply.code(401).send(UNLOCK_FAIL);
    }
    unlockLimiter.reset(`dbg:${ip}`);
    return { ok: true, token, expiresInMs: TOKEN_TTL_MS };
  });

  app.get("/api/v1/debug/rooms/:roomId/snapshot", async (req, reply) => {
    const authorized = deps.gate.verify(tokenOf(req.headers["x-debug-token"]));
    if (!authorized) {
      return reply.code(401).send({ ok: false, code: "E_UNAUTHORIZED", message: "调试会话失效，请重新输入口令" });
    }
    const { roomId } = req.params as { roomId: string };
    if (!isSafeRoomId(roomId)) {
      return reply.code(400).send({ ok: false, code: "E_SCHEMA_INVALID", message: "非法 roomId" });
    }
    if (!(await deps.roomExists(roomId))) {
      return reply.code(404).send({ ok: false, code: "E_ROOM_NOT_FOUND", message: "房间不存在" });
    }
    const snapshot = await buildDebugSnapshot(roomId, deps.store, deps.memory);
    return { ok: true, snapshot };
  });
}
