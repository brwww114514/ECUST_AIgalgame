/**
 * 单轮群聊结算（dev/v2）：从宿主拆出，保持 conversation.ts 在 300 行以内。
 * 这里只做编排：投递 → 并行 NPC 决策 → 审核 → 一次性 Proposal；不直接写状态。
 * 每个私有步骤都控制在 50 行以内（AGENTS.md §6）；runStep 只保留顺序。
 */
import { StoreCommitUnknownError } from "../store-write.ts";
import type { ArbiterApplyResult } from "../arbiter.ts";
import type {
  ActorId, ConversationEvent, ConversationSessionV2, ConversationTurnInput,
  Delivery, Envelope, Proposal, Utterance, WorldState,
} from "../../../shared/src/index.ts";
import { deliver, validateUtterance } from "./delivery.ts";
import { shouldWake, type SceneManager } from "./scene.ts";
import { mentalFields, mentalProposal, memoryProposals, publicSceneText, utteranceFields } from "./conversation.helpers.ts";
import type { ConversationDeps } from "./conversation.ts";
import type { NpcDecisionResult } from "./npc-agent.ts";

/** 重放一次落盘失败所需的全部输入；宿主重试时用同一 cause + expectedSeq 重新裁决 */
export interface StoreRetry {
  ops: Proposal[];
  cause: Envelope;
  expectedSeq: number;
}

export class StoreFlushError extends Error {
  constructor(
    readonly roomId: string,
    readonly applied: ArbiterApplyResult,
    message = "store.flush failed",
    readonly retry?: StoreRetry,
    readonly fresh: Delivery[] = [],
  ) {
    super(message);
  }
}

/**
 * ① 每个会话记住"已经成功提交的投递"，给下轮 NPC 做上下文。
 * Delivery 自带逐接收方 channels，原文里没有的通道不会出现在这里，可见性天然保持。
 * 用 WeakMap 挂 session：会话被宿主淘汰时条目自动回收，不污染冻结契约。
 */
const recentBySession = new WeakMap<ConversationSessionV2, Delivery[]>();
const MAX_RECENT_DELIVERIES = 64;

export function rememberRecent(s: ConversationSessionV2, fresh: readonly Delivery[]): void {
  if (!fresh.length) return;
  const merged = [...(recentBySession.get(s) ?? []), ...fresh].slice(-MAX_RECENT_DELIVERIES);
  recentBySession.set(s, merged);
}

type CommitFn = (s: ConversationSessionV2, applied: ArbiterApplyResult) => Promise<ConversationEvent>;
type NpcResult = NpcDecisionResult & { npcId: ActorId };
type PlayerResult =
  | { aborted: true }
  | { aborted: false; utterance?: Utterance; deliveries: ConversationEvent[] };

interface StepCtx {
  deps: ConversationDeps;
  s: ConversationSessionV2;
  input: ConversationTurnInput;
  out: ConversationEvent[];
  now: number;
  state: WorldState;
  present: readonly ActorId[];
  nameOf: (id: ActorId) => string;
  kindOf: (id: ActorId) => string | undefined;
  playerId?: ActorId;
  seq: number;
  commit: CommitFn;
  proposals: Proposal[];
  /** 本轮通过审核的投递，提交成功后才写入 recentBySession */
  fresh: Delivery[];
}

/** ① 插话：只切 phase，等玩家真正说话才推进 NPC */
function interject(ctx: StepCtx): boolean {
  const { s, input, out, now } = ctx;
  if (!input.interject) return false;
  s.phase = "listening";
  s.listenSince = now;
  out.push({ type: "conversation.phase", sessionId: s.id, phase: "listening" });
  return true;
}

/** ② 玩家发言：校验 + 审核必须在投递之前，坏话绝不能被别人看见 */
async function playerStep(ctx: StepCtx): Promise<PlayerResult> {
  const { deps, s, input, out, present, nameOf, state, seq } = ctx;
  const raw = input.utterance;
  if (!raw) return { aborted: false, deliveries: [] };
  const v = validateUtterance(raw, deps.modes, deps.policy, present);
  if (!v.ok || !v.value) {
    out.push({
      type: "conversation.error", sessionId: s.id,
      code: v.code ?? "E_SCHEMA_INVALID", message: v.message ?? deps.policy.messages.invalidUtterance,
    });
    return { aborted: true };
  }
  const utterance = v.value;
  const review = await deps.audit.review({
    roomId: s.roomId, actorId: utterance.speaker,
    playerInput: utterance.content ?? utterance.action ?? "", fields: utteranceFields(utterance),
  });
  if (review.kind === "blocked") {
    const p = await deps.audit.punishPlayer({
      roomId: s.roomId, actorId: utterance.speaker, clientTurnId: input.clientTurnId,
      verdict: review.verdict, state, seq,
    });
    out.push({ type: "conversation.notice", text: p.text, facts: p.facts });
    return { aborted: true };
  }
  if (review.kind === "unavailable") {
    out.push({ type: "conversation.error", sessionId: s.id, code: "E_CONTENT_BLOCKED", message: deps.policy.messages.auditUnavailable });
    return { aborted: true };
  }
  const deliveries: ConversationEvent[] = deliver(utterance, { recipients: present, modes: deps.modes, noticeFor: nameOf })
    .map((d) => ({ type: "conversation.utterance" as const, delivery: d }));
  return { aborted: false, utterance, deliveries };
}

/** ③ 换地点/多目标唤醒；返回场景事件，顺序由 order 决定 */
async function wakeStep(ctx: StepCtx, utterance: Utterance | undefined, deliveries: ConversationEvent[]): Promise<ConversationEvent[]> {
  const { deps, s, state } = ctx;
  const locationChanged = !!s.lastLocId && s.lastLocId !== state.room.scene.locId;
  const wake = shouldWake({
    utterance, locationChanged,
    wakeOnMultiTarget: deps.wakeOnMultiTarget ?? deps.policy.wakeOnMultiTarget,
    wakeOnLocationChange: deps.wakeOnLocationChange ?? deps.policy.wakeOnLocationChange,
  });
  if (!wake) return [];
  // 共享场景总结只读 public 通道：悄悄话/暗号的正文不进 SceneAgent 的 recent
  const received = deliveries.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery] : []));
  const recent = publicSceneText(received, deps.modes);
  const beat = await deps.scene.wake(s.id, s.roomId, wake, recent, state.room.scene.locId);
  s.sceneBeats.push(beat);
  return [{ type: "conversation.scene", beat }];
}

/** ④ 玩家记忆草稿 + 连续 NPC 发言计数 */
function playerMemory(ctx: StepCtx, utterance?: Utterance): void {
  const { s, deps, playerId } = ctx;
  if (utterance) {
    ctx.proposals.push(...memoryProposals(utterance, s.roomId, deps.modes));
    s.npcSpeechStreak = 0;
    s.listenSince = undefined;
  } else if (playerId) {
    s.npcSpeechStreak += 1;
  }
}

/** ⑤ 每个在场 NPC 各自一次 LLM；玩家不在场时受 autonomousWhenPlayerAbsent 控制 */
async function decideStep(ctx: StepCtx, utterance?: Utterance): Promise<NpcResult[]> {
  const { deps, s, state, present, kindOf, playerId, nameOf } = ctx;
  const autonomous = deps.policy.autonomousWhenPlayerAbsent || !!playerId;
  const npcIds = autonomous ? present.filter((id) => kindOf(id) === "npc" && id !== utterance?.speaker) : [];
  const hardCap = !!playerId && !utterance && deps.policy.npcHardCap > 0 && s.npcSpeechStreak >= deps.policy.npcHardCap;
  const listening = s.phase === "listening";
  const eligible = npcIds.filter((npcId) => {
    if (!deps.budget) return true;
    const ok = deps.budget.canSpeak(s.roomId, npcId, ctx.now) === "ok";
    if (ok) deps.budget.recordCall(s.roomId);
    return ok;
  });
  return Promise.all(eligible.map(async (npcId) => {
    // ① 其他 NPC 上一轮（及更早）实际投给自己的发言，按原 Delivery 通道进本轮 prompt
    const prior = (recentBySession.get(s) ?? []).filter((d) => d.to === npcId && d.speaker !== npcId);
    const hits = [
      ...prior,
      ...(utterance ? deliver(utterance, { recipients: [npcId], modes: deps.modes, noticeFor: nameOf }) : []),
    ];
    const own = await deps.memory.recall({ roomId: s.roomId, ownerId: npcId, budgetTokens: 300, nowTurn: state.clock.tick });
    const r = await deps.npc.decide({
      npcId, npcName: nameOf(npcId), turnKey: s.turn, state, deliveries: hits,
      sceneText: deps.scene.render(s.id),
      memoryText: own.slice(0, 4).map((h) => `- ${h.record.content}`).join("\n"),
      streak: s.npcSpeechStreak, playerPresent: !!playerId, hardCapReached: hardCap, listening,
    });
    return { npcId, ...r };
  }));
}

/** ⑥ 扩面审核：不合规只丢这一位；心理活动含 plan */
async function auditStep(ctx: StepCtx, decisions: NpcResult[], utterance?: Utterance): Promise<void> {
  const { deps, s, out, present, nameOf } = ctx;
  for (const d of decisions) {
    const fields = d.decision.kind === "speak" ? utteranceFields(d.decision.utterance)
      : d.decision.kind === "think" ? mentalFields(d.decision.mental) : [];
    if (fields.length === 0) continue;
    const review = await deps.audit.review({ roomId: s.roomId, actorId: d.npcId, playerInput: utterance?.content ?? "", fields });
    if (review.kind === "ok") {
      if (d.decision.kind === "speak") {
        deps.budget?.recordSent(s.roomId, d.npcId);
        const u = d.decision.utterance;
        const spoken = deliver(u, { recipients: present, modes: deps.modes, noticeFor: nameOf });
        for (const delivery of spoken) out.push({ type: "conversation.utterance", delivery });
        ctx.fresh.push(...spoken);
        ctx.proposals.push(...memoryProposals(u, s.roomId, deps.modes));
      } else if (d.decision.kind === "think") {
        out.push({ type: "conversation.mental", actorId: d.npcId, mental: d.decision.mental });
        ctx.proposals.push(mentalProposal(d.npcId, d.decision.mental));
      }
    }
  }
}

/** ⑦ 玩家发言后若 phase=listening，恢复 speaking */
function restorePhase(ctx: StepCtx, utterance?: Utterance, listening = false): void {
  const { s, out } = ctx;
  if (!listening || !utterance) return;
  s.phase = "speaking";
  s.listenSince = undefined;
  out.push({ type: "conversation.phase", sessionId: s.id, phase: "speaking" });
}

/** ⑧ 唯一写入口：整批 Proposal 一次裁决；无提案也发 committed 让对端收口 */
async function commitStep(ctx: StepCtx, utterance?: Utterance): Promise<boolean> {
  const { deps, s, input, out, now, seq, commit } = ctx;
  const { store, arbiter, memory, policy } = deps;
  const cause = {
    v: 1 as const, id: `evt_conv_${input.clientTurnId}`, roomId: s.roomId, seq: seq + 1,
    ts: now, actorId: utterance?.speaker ?? "sys", type: "dialogue.speak" as const, payload: {},
  };
  // lastLocId 只在提交成功后前移，失败时下轮仍能检测换地点（三审 P3-⑥）
  const finish = async (applied: ArbiterApplyResult): Promise<void> => {
    out.push(await commit(s, applied));
    s.lastLocId = ctx.state.room.scene.locId;
  };
  if (!ctx.proposals.length) {
    await finish({ ok: true, mode: "atomic", seq: seq + 1, stateAfter: ctx.state, applied: [], rejected: [], events: [] });
    return true;
  }
  const applied = await arbiter.apply(s.roomId, ctx.proposals, cause, { expectedSeq: seq, captureState: true });
  if (!applied.ok) {
    // ③ 写盘失败是暂时故障：必须走 retryable 分支，绝不能进 seen 缓存
    if (applied.error?.code === "E_STORE_FAULT") {
      throw new StoreFlushError(s.roomId, applied, deps.policy.messages.storeFlushFailed, {
        ops: ctx.proposals, cause, expectedSeq: seq,
      }, ctx.fresh);
    }
    out.push({
      type: "conversation.error", sessionId: s.id,
      code: applied.error?.code ?? applied.rejected[0]?.code ?? "E_MODULE_FAULT",
      message: applied.error?.message ?? policy.messages.memoryRejected,
    });
    return false;
  }
  for (const ev of applied.events) memory.ingest(ev); // PR#4 P0-1：写了必须能读到
  try {
    await store.flush(s.roomId);
  } catch (error) {
    if (error instanceof StoreCommitUnknownError) throw error;
    throw new StoreFlushError(s.roomId, applied, deps.policy.messages.storeFlushFailed, undefined, ctx.fresh);
  }
  await finish(applied);
  return true;
}

export async function runStep(
  deps: ConversationDeps,
  s: ConversationSessionV2,
  input: ConversationTurnInput,
  out: ConversationEvent[],
  now: number,
  commit: CommitFn,
): Promise<void> {
  const state = await deps.store.snapshot(s.roomId);
  const present = state.room.scene.presentIds ?? [];
  const ctx: StepCtx = {
    deps, s, input, out, now, state, present,
    nameOf: (id) => state.entities[id]?.name ?? id,
    kindOf: (id) => state.entities[id]?.kind,
    playerId: present.find((id) => state.entities[id]?.kind === "plr"),
    seq: await deps.store.load(s.roomId),
    commit,
    proposals: [],
    fresh: [],
  };
  if (interject(ctx)) return;
  const player = await playerStep(ctx);
  if (player.aborted) return;
  const sceneEvents = await wakeStep(ctx, player.utterance, player.deliveries);
  const first = sceneEvents[0];
  out.push(...(first?.type === "conversation.scene" && first.beat.order === "before"
    ? [...sceneEvents, ...player.deliveries] : [...player.deliveries, ...sceneEvents]));
  playerMemory(ctx, player.utterance);
  ctx.fresh.push(...player.deliveries.flatMap((e) => (e.type === "conversation.utterance" ? [e.delivery] : [])));
  const listening = s.phase === "listening";
  const decisions = await decideStep(ctx, player.utterance);
  await auditStep(ctx, decisions, player.utterance);
  restorePhase(ctx, player.utterance, listening);
  if (await commitStep(ctx, player.utterance)) rememberRecent(s, ctx.fresh);
}
