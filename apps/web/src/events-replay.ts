/**
 * `/events` 历史回放的请求决策（issue #87）。
 *
 * dev/v2 breaking：带别人的 actorId 请求 `GET /rooms/:id/events` 现在返回 403（此前
 * 200 + 静默过滤）。前端不能因此把事件流判死：403 时退回**不带 actorId** 的同一区间
 * 再拉一次（服务端 200 + 非私信事件），只关掉私信渲染并给出人话提示；正常 200 +
 * 空事件流是老房间没有 v2 数据的空态，不是错误。
 *
 * 决策逻辑全部是纯函数（node vitest 直接测，不引 jsdom）；本文件底部只有一个很薄的
 * fetch 包装：负责 I/O + 把响应/异常归类成纯函数的输入，不掺任何渲染逻辑。
 */
import { apiFetch, httpErrorFrom } from "./http.ts";

/** 回放只需要事件的 type；其余字段原样透传给渲染层 */
export interface ReplayEvent {
  type: string;
  [key: string]: unknown;
}

export interface EventsQuery {
  /** 当前账号在本房间的玩家 actorId；不传 = 服务端不返回任何 msg.sent */
  actorId?: string;
  fromSeq?: number;
  limit?: number;
}

/** 一次 HTTP 尝试的结果；不依赖 Response/DOM 类型，便于纯函数测试 */
export interface EventsAttempt {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  events?: ReplayEvent[];
  lastSeq?: number;
}

export type EventsOutcomeKind = "ok" | "degraded" | "empty" | "error";

export interface EventsOutcome {
  kind: EventsOutcomeKind;
  /** 最终要渲染的事件流（403 降级后是重试拿到的非私信流） */
  events: ReplayEvent[];
  /** 是否渲染 msg.sent 私信 */
  renderDm: boolean;
  /** 给玩家看的提示；null = 无需提示 */
  notice: string | null;
  /** 是否发生过 403 降级 */
  degraded: boolean;
}

/** 403 的人话提示：明确告诉玩家是 actorId 无效，而不是网络故障 */
export const ACTOR_ID_INVALID_NOTICE = "actorId 无效或无房间权限，私信已隐藏；其余历史事件正常显示。";
/** 压根没拿到本人 actorId 时的软提示（不该重试，补上 actorId 即可） */
export const ACTOR_ID_MISSING_NOTICE = "未提供本人 actorId，私信不显示（不影响其他事件）。";

/** query string（纯函数）：显式传 actorId 才有私信；不传就是静默少数据的模式 */
export function buildEventsQuery(query: EventsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.actorId) params.set("actorId", query.actorId);
  if (query.fromSeq !== undefined) params.set("fromSeq", String(query.fromSeq));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params.toString();
}

/**
 * 是否是「actorId 传错」导致的拒绝。
 * 服务端 guardRoom 用 403 + E_FORBIDDEN；兼容只给 code 的老响应，不把它误判成网络错误。
 */
export function isActorIdForbidden(err: Pick<EventsAttempt, "status" | "code"> | null | undefined): boolean {
  if (!err) return false;
  return err.status === 403 || err.code === "E_FORBIDDEN";
}

/** 私信事件只按契约里的 type 判定，不猜 payload */
export function isDirectMessage(event: ReplayEvent): boolean {
  return event.type === "msg.sent";
}

/** 关私信时滤掉 msg.sent：纵深防御（服务端不带 actorId 时已过滤一遍） */
export function filterDirectMessages(events: ReplayEvent[], renderDm: boolean): ReplayEvent[] {
  return renderDm ? events : events.filter((event) => !isDirectMessage(event));
}

export interface DecideEventsInput {
  /** 首次请求（带本人 actorId，或不带） */
  primary: EventsAttempt;
  /** 首次是否带了 actorId：没带就没有私信可渲染 */
  withActorId: boolean;
  /** 403 后不带 actorId 的重试结果 */
  fallback?: EventsAttempt;
}

/**
 * 纯决策：HTTP 结果 → UI 该拿到的事件流与提示。
 * 关键约定：403 **不抛错、不返回空流**——它只意味着「这次读不到私信」，
 * 其余历史事件仍由 fallback（或已经成功的结果）正常渲染。
 */
export function decideEventsOutcome(input: DecideEventsInput): EventsOutcome {
  const { primary, withActorId, fallback } = input;

  if (primary.ok) {
    const events = filterDirectMessages(primary.events ?? [], withActorId);
    if (events.length === 0) {
      // 老房间无 v2 数据：200 + 空事件流 = 空态
      return { kind: "empty", events: [], renderDm: withActorId, notice: null, degraded: false };
    }
    return {
      kind: "ok",
      events,
      renderDm: withActorId,
      notice: withActorId ? null : ACTOR_ID_MISSING_NOTICE,
      degraded: false,
    };
  }

  if (isActorIdForbidden(primary)) {
    const events = fallback?.ok ? filterDirectMessages(fallback.events ?? [], false) : [];
    return {
      kind: "degraded",
      events,
      renderDm: false,
      notice: ACTOR_ID_INVALID_NOTICE,
      degraded: true,
    };
  }

  // 401/5xx/网络错误不是 actorId 的问题，原样给人话，由调用方决定是否重试
  const message = primary.message?.trim() || primary.code || `HTTP ${primary.status ?? 0}`;
  return { kind: "error", events: [], renderDm: false, notice: message, degraded: false };
}

// ---------------------------------------------------------------- I/O 薄包装

async function requestEvents(roomId: string, query: EventsQuery): Promise<EventsAttempt> {
  const qs = buildEventsQuery(query);
  const suffix = qs ? `?${qs}` : "";
  const res = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/events${suffix}`);
  if (!res.ok) {
    const err = await httpErrorFrom(res, "events");
    return { ok: false, status: err.status, code: err.code, message: err.message };
  }
  // /events 直接返回 {events,lastSeq}，没有 ok 字段，不能走 request()/unwrap()
  const body = (await res.json()) as { events?: unknown; lastSeq?: unknown };
  const events = Array.isArray(body.events) ? (body.events as ReplayEvent[]) : [];
  const lastSeq = typeof body.lastSeq === "number" ? body.lastSeq : undefined;
  return { ok: true, events, lastSeq };
}

function networkFailure(e: unknown): EventsAttempt {
  return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
}

/**
 * 拉一次历史事件流。传了 actorId 就显式带上（要私信必须如此）；403 自动降级重拉。
 * 除了非 403 的传输/服务端错误会以 `kind:"error"` 返回，其它情况都不抛，
 * 让调用方只管渲染 outcome，不必为一次 actorId 传错而中断整页。
 */
export async function fetchRoomEvents(roomId: string, query: EventsQuery = {}): Promise<EventsOutcome> {
  let primary: EventsAttempt;
  try {
    primary = await requestEvents(roomId, query);
  } catch (e) {
    primary = networkFailure(e);
  }

  const withActorId = Boolean(query.actorId);
  if (primary.ok || !isActorIdForbidden(primary) || !withActorId) {
    return decideEventsOutcome({ primary, withActorId });
  }

  // 用同一区间的“无 actorId”请求兜底：拿回事件流，但服务端不会返回私信
  const anonymousQuery: EventsQuery = { fromSeq: query.fromSeq, limit: query.limit };
  let fallback: EventsAttempt;
  try {
    fallback = await requestEvents(roomId, anonymousQuery);
  } catch (e) {
    fallback = networkFailure(e);
  }
  return decideEventsOutcome({ primary, withActorId, fallback });
}
