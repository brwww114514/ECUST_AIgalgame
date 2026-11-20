import { z } from "zod";
import type { Envelope, WorldState } from "../../shared/src/contract/types.ts";
import { EnvelopeSchema } from "../../shared/src/zod/envelope.ts";
import {
  AttrValueSchema, EntitySchema, GameClockSchema, IdSchema, LinkSchema,
  PlotSchema, RoomMemberSchema, SceneStateSchema,
} from "../../shared/src/zod/entity.ts";
import { applyEvent } from "./projection.ts";

const payloadSchemas = new Map<string, z.ZodTypeAny>([
  ["attr.changed", z.object({ entityId: IdSchema, key: z.string().min(1), to: AttrValueSchema })],
  ["entity.created", z.object({ entity: EntitySchema })],
  ["entity.updated", z.object({ entity: EntitySchema })],
  ["entity.tombstoned", z.object({ entityId: IdSchema, at: z.number().int().nonnegative() })],
  ["link.created", z.object({ link: LinkSchema })],
  ["link.removed", z.object({ linkId: IdSchema })],
  ["actor.moved", z.object({ actorId: IdSchema, to: IdSchema })],
  ["clock.advanced", z.object({ clock: GameClockSchema })],
  ["scene.changed", SceneStateSchema],
  ["plot.upserted", z.object({ plot: PlotSchema })],
  ["room.member.joined", z.object({ member: RoomMemberSchema })],
  ["room.member.left", z.object({ actorId: IdSchema })],
]);

export class RoomLogError extends Error {
  readonly code = "E_STORE_FAULT";
}

export function decodeRoomLog(text: string, roomId?: string): Envelope[] {
  const events: Envelope[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const location = `房间 ${roomId ?? "未知"} 第 ${index + 1} 行`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new RoomLogError(`${location}：无效 JSON`);
    }
    const parsed = EnvelopeSchema.safeParse(value);
    if (!parsed.success || !Object.hasOwn(parsed.data, "payload")) {
      throw new RoomLogError(`${location}：事件结构无效`);
    }
    const envelope = value as Envelope;
    roomId ??= envelope.roomId;
    if (envelope.roomId !== roomId) throw new RoomLogError(`${location}：事件房间不匹配`);
    const expected = events.length + 1;
    if (envelope.seq !== expected) {
      throw new RoomLogError(`${location}：期望 seq=${expected}，实际 seq=${envelope.seq}`);
    }
    const payload = payloadSchemas.get(envelope.type);
    if (payload && !payload.safeParse(envelope.payload).success) {
      throw new RoomLogError(`${location}：${envelope.type} 负载无效`);
    }
    events.push(envelope);
  }
  return events;
}

export function projectRoomEvents(
  state: WorldState, events: readonly Envelope[], through = Number.POSITIVE_INFINITY,
): WorldState {
  for (const event of events) {
    if (event.seq > through) break;
    try {
      state = applyEvent(state, event);
    } catch (cause) {
      throw new RoomLogError(`房间 ${event.roomId} seq=${event.seq}：${event.type} 无法投影`, { cause });
    }
  }
  return state;
}
