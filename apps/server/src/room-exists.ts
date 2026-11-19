/**
 * 房间存在性判定（issue #37）：以持久化事实为准，而不是"snapshot 不抛错"。
 *
 * 背景：`FileStore.snapshot` 对不存在的房间返回空 `WorldState`（不抛错），旧实现因此把
 * 任何未知 roomId 当成 200 空房间；更糟的是 `/turns` 与 `/map/tick` 会先起 SSE / 跑模块，
 * 把"幽灵日志"写进磁盘。存在性统一走 `Store.listRooms()`（契约外的可选能力，
 * `FileStore`/`EventSourcedStore` 都已实现），测试替身缺 `listRooms` 时退化为一页事件探针。
 * 两条路径都只读：不会隐式落盘建房。
 *
 * 缓存（issue #78）：`listRooms()` 每次都扫 `data/rooms/`，房间多时开销明显。这里缓存
 * 房间表，但**只缓存正结果**：判定一个"缓存表里没有"的房间时立即重扫，于是
 *   - 建房（含绕过 HTTP 端点的建房、外部写入）下一次判定就能看到，不会误报 404；
 *   - 未知房间仍每次重扫并得到 404，404 语义不变；
 *   - 已证实存在的房间在 TTL 内不再扫目录。
 * 失效入口：`invalidate()` 清掉整张缓存表——`POST /api/v1/rooms` 建房后调用；删房/
 * 外部删除可由运维调用，或等 `ttlMs`（默认 1000）到期重扫。`listRooms()` 抛错不缓存、
 * 不吞掉——下一次请求重试，保持既有 503 `E_STORE_FAULT` 语义。
 */
import type { Store } from "../../../packages/shared/src/contract/types.ts";

type StoreWithRooms = Store & { listRooms?: () => Promise<string[]> };

export interface RoomExistsOptions {
  /** 已证实存在的房间在缓存中的有效期（ms）。0 等价于每次重扫。默认 1000。 */
  ttlMs?: number;
}

/** 可调用的房间存在性判定；`invalidate()` 让下一次判定重新读存储。 */
export interface RoomExists {
  (roomId: string): Promise<boolean>;
  invalidate(): void;
}

const DEFAULT_TTL_MS = 1_000;

export function makeRoomExists(store: Store, options: RoomExistsOptions = {}): RoomExists {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const withRooms = store as StoreWithRooms;
  const hasListRooms = typeof withRooms.listRooms === "function";

  // generation 让 invalidate() 作废旧扫描，避免"失效前发出的 scan 在失效后回填过期表"。
  let generation = 0;
  let cachedRooms: Set<string> | null = null;
  let expiresAt = 0;
  let inflight: { gen: number; promise: Promise<Set<string>> } | null = null;
  // 内存替身（无 listRooms）的事件探针：同样只缓存正结果。
  const probeHits = new Map<string, number>();

  const scanRooms = async (gen: number): Promise<Set<string>> => {
    if (inflight && inflight.gen === gen) return inflight.promise;
    const promise = (async () => {
      const ids = await (withRooms.listRooms as () => Promise<string[]>).call(store);
      const set = new Set(ids);
      if (gen === generation) {
        cachedRooms = set;
        expiresAt = Date.now() + ttlMs;
      }
      return set;
    })();
    inflight = { gen, promise };
    try {
      return await promise;
    } finally {
      if (inflight?.gen === gen) inflight = null;
    }
  };

  const check = async (roomId: string): Promise<boolean> => {
    if (hasListRooms) {
      // 正结果且未过期 → 命中缓存，零扫目录。负结果不缓存：缓存表里没有就重扫，
      // 这样外部/绕过 HTTP 的建房立刻可见，未知房间依然 404。
      if (cachedRooms !== null && Date.now() < expiresAt && cachedRooms.has(roomId)) return true;
      return (await scanRooms(generation)).has(roomId);
    }
    const hitUntil = probeHits.get(roomId);
    if (hitUntil !== undefined && Date.now() < hitUntil) return true;
    const exists = (await store.events(roomId, 0, 1)).length > 0;
    if (exists) probeHits.set(roomId, Date.now() + ttlMs);
    else probeHits.delete(roomId);
    return exists;
  };

  const roomExists = check as RoomExists;
  roomExists.invalidate = () => {
    generation += 1;
    cachedRooms = null;
    expiresAt = 0;
    inflight = null;
    probeHits.clear();
  };
  return roomExists;
}
