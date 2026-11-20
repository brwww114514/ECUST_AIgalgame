/**
 * 「谁报出了自己的名字，玩家才认识谁」的判定（认识口径的收口点）。
 *
 * 只认**说话人标签后面的台词内容**，例如：
 *   林静：“林静。双木林，安静的静。”        ← 台词开头就是自己的名字 → 算
 *   白晓通：白晓通，住三号楼的。            ← 台词里自报姓名 → 算
 *   林静：你好——小声一点，这边有人自习。   ← 只是打招呼 → 不算
 *
 * 为什么不能只看说话人标签：模型每句台词都写成「名字：…」，标签带名字不等于他做了自我介绍，
 * 否则第一句"你好"就会把全场人的名字解锁。
 * 旁白里提到某人（"不远处的白晓通抬起头"）同样不算。
 */
import type { ConversationEvent } from "../../../packages/shared/src/contract/v2.ts";
import type { Entity, WorldState } from "../../../packages/shared/src/contract/types.ts";
import { knowsNameOf } from "./view-names.ts";

/** 玩家在问对方名字（与 content/modules/introduce 的 ASK_NAME_RE 同口径） */
const ASK_NAME_RE = /(你叫什么|你叫啥|你叫什么呢|你叫什么名字|怎么称呼你|你的名字|贵姓|你是哪位|你哪位)/u;

export function isAskNameInput(input: string): boolean {
  return ASK_NAME_RE.test(input);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 台词里是否在自报姓名。**只认姓名共现**：嘴上说"我叫/我是"但没有说出名字，
 * 不算自我介绍（审阅 P1-5 的反例："我是图书馆的老师"、"我叫你一声同学吧"）。
 *
 * 例外："姓X"且 X 与 NPC 姓氏一致——但必须是**本人自述**：
 * - 必须带自述前缀（我/本人/免贵），或整句以"姓X"开头且后面是标点；
 * - "姓林的都很轴，别惹他们"这类第三人称泛谈一律不算（review #63-2）。
 */
function surnameSelfIntro(head: string, name: string): boolean {
  const prefixed = /(?:我|本人|免贵)\s*姓([\u4e00-\u9fa5])/.exec(head);
  if (prefixed) return name.startsWith(prefixed[1] ?? "");
  const leading = /^姓([\u4e00-\u9fa5])([\s，。！？；、,.!?]|$)/.exec(head);
  if (leading) return name.startsWith(leading[1] ?? "");
  return false;
}

function speechIntroducesName(speech: string, name: string): boolean {
  const head = speech.slice(0, 60);
  if (head.includes(name)) return true;
  return surnameSelfIntro(head, name);
}

/** 从叙事/台词文本里挑出"当轮报过名字"的未认识 NPC */
export function namesIntroducedIn(text: string, npcs: readonly Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const npc of npcs) {
    if (knowsNameOf(npc)) continue;
    const name = npc.name.trim();
    if (name.length < 2) continue;
    const re = new RegExp(`${escapeRe(name)}[：:]\\s*([^\\n]{0,80})`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (speechIntroducesName(m[1] ?? "", name)) {
        out.push(npc);
        break;
      }
    }
  }
  return out;
}

/** 此刻在场、active 的 NPC 才可能被解锁（不在场的人解锁不了）。 */
function isPresentNpc(state: WorldState, id: string): boolean {
  const e = state.entities[id];
  return !!e && e.kind === "npc" && e.status === "active" && state.room.scene.presentIds.includes(id);
}

/**
 * 「玩家在问 targetId 的名字」的解锁判定（v1 `targetNpcId` / v2 `utterance.target` 共用）。
 * 只有目标是 NPC、此刻在场、且这句话确实在问名字，才返回要解锁的 id。
 */
export function askedNameTargetId(
  state: WorldState,
  targetId: string | undefined | null,
  input: string,
): string | null {
  if (!targetId || !isAskNameInput(input)) return null;
  return isPresentNpc(state, targetId) ? targetId : null;
}

/**
 * 「真名：台词」文本 → 本回合报出名字、且在场的 NPC id。
 * v1 的 turn.delta/facts 与 v2 的 delivery 还原文本共用同一判定，避免两条路径口径漂移。
 */
export function introducedPresentIds(state: WorldState, speech: string): string[] {
  if (!speech.trim()) return [];
  const npcs = Object.values(state.entities).filter((e) => e.kind === "npc" && e.status === "active");
  return namesIntroducedIn(speech, npcs)
    .filter((n) => state.room.scene.presentIds.includes(n.id))
    .map((n) => n.id);
}

/**
 * v2：把「玩家实际收到的 delivery」还原成「真名：台词」。
 * 只统计 `to === actorId`——耳语/私信给别的 NPC 的话玩家没听见，不能据此解锁；
 * 并按 channels 取内容：不含 `content` 时不拿正文判定（玩家只看到 coverAction）。
 */
export function viewerSpeech(
  state: WorldState,
  actorId: string,
  events: readonly ConversationEvent[],
): string {
  return events
    .flatMap((ev) => {
      if (ev.type !== "conversation.utterance") return [];
      const d = ev.delivery;
      if (d.to !== actorId || d.speaker === actorId) return [];
      const speaker = state.entities[d.speaker];
      const parts: string[] = [];
      if (d.channels.includes("content") && typeof d.content === "string" && d.content.trim() !== "") parts.push(d.content);
      if (d.channels.includes("action") && typeof d.action === "string" && d.action.trim() !== "") parts.push(d.action);
      return speaker && parts.length > 0 ? [`${speaker.name}：${parts.join(" ")}`] : [];
    })
    .join("\n");
}
