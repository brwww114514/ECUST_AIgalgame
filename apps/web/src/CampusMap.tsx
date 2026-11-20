/**
 * 校园大地图：直接在奉贤校区的底图上走。
 *
 * - 底图是 6000×4500 的实拍鸟瞰，所有坐标都用这张图自己的像素系；
 * - 主角是抠过背景的立绘 PNG，站在地图上（不随缩放变形，固定显示尺寸）；
 * - 33 个场景点位散布在图上，走近就"到达"（静默同步世界状态，不往对话流里刷字）；
 * - NPC 按 located_in 的位置摆成头像标记，走近头顶浮一句台词，点一下才开始对话。
 *
 * 关键设计：**移动循环里不允许出现任何 setState**。
 * 位置、相机、立绘 transform 全部走 ref + 直接改 DOM；
 * "附近有谁"这类要进 React 的状态，放在 160ms 的独立 interval 里算。
 * 这样无论父组件怎么重渲染，手上按着的键和每一帧的位移都不会被打断。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MapScene, MapView } from "./api.ts";
import { fetchGallery, muttersByNpcId } from "./api-gallery.ts";
import type { GalleryNpc } from "./api-gallery.ts";
import { interiorFor } from "./interior.ts";

const W = 6000;
const H = 4500;
const SCALE = 0.62;
const SPEED = 300;
const ENTER_DIST = 170;
const TALK_DIST = 140;
const PROBE_MS = 160;
/** 4 帧走路循环：并腿 → 迈左脚 → 并腿 → 迈右脚 */
const WALK_SEQ = ["", "-walk1", "", "-walk2"];
/** 每帧时长（毫秒）：4 帧约 0.6 秒一个完整步循环 */
const STEP_MS = 150;

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 图鉴拉取的一次结果：成功带 NPC 列表，失败无数据。 */
export type GalleryOutcome = { ok: true; npcs: GalleryNpc[] } | { ok: false };

/** 地图气泡状态：连同它所属的房间一起记，换房间时据此清空，避免串房泄露旧气泡。 */
export interface BubbleState {
  roomId: string;
  mutters: Record<string, string>;
}

/**
 * 纯函数：上一次气泡状态 + 本次图鉴加载事件 → 下一次气泡状态。
 * - 加载开始（outcome=null）：换房间先清空上一房间的气泡；同房间（version 重拉）保留，避免闪烁；
 * - 成功：只取图鉴里 met 且有 mutter 的 NPC（未认识不出气泡，issue #54）；
 * - 失败：换房间保持空表；同房间保留上次成功值（图鉴失败不清空气泡）。
 */
export function nextBubbleState(prev: BubbleState, roomId: string, outcome: GalleryOutcome | null): BubbleState {
  if (outcome?.ok) return { roomId, mutters: muttersByNpcId(outcome.npcs) };
  // 加载开始或加载失败：换房间一律清空，同房间保留上次成功值
  if (prev.roomId !== roomId) return { roomId, mutters: {} };
  return prev;
}

export interface CampusMapProps {
  map: MapView | null;
  /** 当前房间：气泡台词从房间图鉴读取（只对 met=true 的 NPC 下发） */
  roomId: string;
  /** 状态版本号：与 GalleryPanel 一致，解锁 NPC 后据此重拉图鉴气泡 */
  version?: number;
  heroSrc: string;
  talkingTo: string;
  busy: boolean;
  onTalk: (actorId: string, name: string) => void;
  /** 走到某个点位旁：交给上层静默同步世界状态；返回 ok=false 时允许再次触发 */
  onEnter: (sceneId: string) => Promise<{ ok: boolean; message?: string }> | void;
  /** 走近带室内场景的点位（如图书馆）并点入口：进入室内地图 */
  onEnterInterior?: (sceneId: string) => void;
}

export default function CampusMap({
  map,
  roomId,
  version = 0,
  heroSrc,
  talkingTo,
  busy,
  onTalk,
  onEnter,
  onEnterInterior,
}: CampusMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [nearScene, setNearScene] = useState<MapScene | null>(null);
  const [nearNpc, setNearNpc] = useState<{ id: string; name: string } | null>(null);
  /** 头顶气泡台词：只取房间图鉴里 met=true 的 NPC；换房间清空，图鉴失败保留上次成功值 */
  const [bubbles, setBubbles] = useState<BubbleState>({ roomId: "", mutters: {} });

  useEffect(() => {
    if (!roomId) {
      setBubbles({ roomId: "", mutters: {} });
      return;
    }
    let alive = true;
    // 换房间立即清空旧气泡（不串房泄露）；同房间 version 重拉保留上次成功值（不闪烁）
    setBubbles((prev) => nextBubbleState(prev, roomId, null));
    fetchGallery(roomId)
      .then((gallery) => {
        if (alive) setBubbles((prev) => nextBubbleState(prev, roomId, { ok: true, npcs: gallery.npcs }));
      })
      .catch(() => {
        if (alive) setBubbles((prev) => nextBubbleState(prev, roomId, { ok: false }));
      });
    return () => {
      alive = false;
    };
  }, [roomId, version]);

  const posRef = useRef<{ x: number; y: number } | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const camRef = useRef({ x: 0, y: 0 });
  const mapRef = useRef<MapView | null>(null);
  mapRef.current = map;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  // 四方向立绘：heroSrc 指向 down 图，其余按 -up / -side / -left 推导
  const heroBase = useMemo(
    () => (heroSrc.endsWith("-down.png") ? heroSrc.slice(0, -"-down.png".length) : heroSrc.replace(/\.png$/, "")),
    [heroSrc],
  );
  const heroImgRef = useRef<HTMLImageElement | null>(null);
  const heroDirRef = useRef("down");
  const heroStepRef = useRef(0);
  const heroLastStepRef = useRef(0);
  const heroBaseRef = useRef(heroBase);
  heroBaseRef.current = heroBase;

  // 预加载所有帧，切方向 / 换步不闪
  useEffect(() => {
    for (const d of ["up", "side", "left", "down-walk1", "down-walk2", "side-walk1", "side-walk2", "left-walk1", "left-walk2"]) {
      const im = new Image();
      im.src = `${heroBase}-${d}.png`;
    }
  }, [heroBase]);

  const coordRef = useRef<HTMLSpanElement | null>(null);
  const nearSceneRef = useRef<string>("");
  const nearNpcRef = useRef<string>("");
  const enteredRef = useRef<string>("");
  const startRef = useRef("");

  const scenes = map?.scenes ?? [];
  const spawn = useMemo(() => {
    const here = scenes.find((s) => s.id === map?.player.locId);
    return here ? { x: here.x, y: here.y } : { x: W / 2, y: H / 2 };
  }, [map?.player.locId, scenes]);

  // 出生：放在当前 locId 对应的点位
  useEffect(() => {
    if (!map || posRef.current) return;
    posRef.current = { ...spawn };
    setReady(true);
  }, [map, spawn]);

  // 用地图层传送（点小地图）后，人跟着点位走
  useEffect(() => {
    if (!map) return;
    const here = map.scenes.find((s) => s.id === map.player.locId);
    if (!here) return;
    if (startRef.current === here.id) return;
    startRef.current = here.id;
    if (posRef.current && Math.hypot(posRef.current.x - here.x, posRef.current.y - here.y) > 320) {
      posRef.current = { x: here.x, y: here.y };
      enteredRef.current = here.id;
    }
  }, [map]);

  // 键盘只绑一次：不随任何 React 状态重建
  useEffect(() => {
    const keys = keysRef.current;
    const onDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS.has(k)) return;
      keys.add(k);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const onBlur = () => keys.clear();

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 位移 + 相机：这一帧只碰 DOM，不碰 React
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const p = posRef.current;
      const vp = viewportRef.current;
      if (p && vp) {
        const keys = keysRef.current;
        let vx = 0;
        let vy = 0;
        if (keys.has("a") || keys.has("arrowleft")) vx -= 1;
        if (keys.has("d") || keys.has("arrowright")) vx += 1;
        if (keys.has("w") || keys.has("arrowup")) vy -= 1;
        if (keys.has("s") || keys.has("arrowdown")) vy += 1;
        if (vx !== 0 || vy !== 0) {
          const len = Math.hypot(vx, vy);
          p.x = clamp(p.x + (vx / len) * SPEED * dt, 40, W - 40);
          p.y = clamp(p.y + (vy / len) * SPEED * dt, 40, H - 40);
        }
        const viewW = vp.clientWidth / SCALE;
        const viewH = vp.clientHeight / SCALE;
        const cam = camRef.current;
        const targetX = clamp(p.x - viewW / 2, 0, Math.max(0, W - viewW));
        const targetY = clamp(p.y - viewH / 2, 0, Math.max(0, H - viewH));
        cam.x += (targetX - cam.x) * 0.22;
        cam.y += (targetY - cam.y) * 0.22;

        const world = worldRef.current;
        if (world) world.style.transform = `translate3d(${Math.round(-cam.x * SCALE)}px, ${Math.round(-cam.y * SCALE)}px, 0)`;
        const hero = heroRef.current;
        if (hero) {
          hero.style.transform = `translate3d(${Math.round(p.x * SCALE)}px, ${Math.round(p.y * SCALE)}px, 0)`;
          // 走动时给立绘一点起伏，肉眼就能确认"人在动"
          hero.classList.toggle("walking", vx !== 0 || vy !== 0);
          // 四方向朝向 + 走路帧：只换图，不碰 React
          const img = heroImgRef.current;
          if (img) {
            const moving = vx !== 0 || vy !== 0;
            let dir = "";
            if (vx < 0) dir = "left";
            else if (vx > 0) dir = "side";
            else if (vy < 0) dir = "up";
            else if (vy > 0) dir = "down";

            let changed = false;
            if (dir && dir !== heroDirRef.current) {
              heroDirRef.current = dir;
              changed = true;
            }
            // 4 帧走路循环：并腿 → 迈左脚 → 并腿 → 迈右脚
            if (moving && dir && dir !== "up") {
              if (now - heroLastStepRef.current > STEP_MS) {
                heroLastStepRef.current = now;
                heroStepRef.current = (heroStepRef.current + 1) % WALK_SEQ.length;
                changed = true;
              }
            } else if (heroStepRef.current !== 0) {
              heroStepRef.current = 0;
              changed = true;
            }
            if (changed) {
              const d = heroDirRef.current;
              const suffix = d !== "up" ? WALK_SEQ[heroStepRef.current] : "";
              img.src = `${heroBaseRef.current}-${d}${suffix}.png`;
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  // 附近有谁：与渲染解耦的低频探测（160ms），setState 和 enter 都放这里
  useEffect(() => {
    if (!ready) return;
    const probe = () => {
      const p = posRef.current;
      const live = mapRef.current;
      if (!p || !live) return;

      // 调试读数：直接改 DOM，不触发重渲染
      if (coordRef.current) {
        coordRef.current.textContent = `x=${Math.round(p.x)} y=${Math.round(p.y)}`;
      }

      let bestScene: MapScene | null = null;
      let bestD = ENTER_DIST;
      for (const s of live.scenes) {
        if (s.status !== "built") continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) {
          bestD = d;
          bestScene = s;
        }
      }
      const sceneKey = bestScene?.id ?? "";
      if (sceneKey !== nearSceneRef.current) {
        nearSceneRef.current = sceneKey;
        setNearScene(bestScene);
        if (bestScene && bestScene.id !== live.player.locId && enteredRef.current !== bestScene.id) {
          enteredRef.current = bestScene.id;
          // 传送失败就把"已进入"标记清掉，让人还能再试一次，而不是永远卡在门口
          const pending = onEnterRef.current(bestScene.id);
          if (pending && typeof (pending as Promise<unknown>).then === "function") {
            (pending as Promise<{ ok: boolean }>)
              .then((r) => {
                if (!r || !r.ok) enteredRef.current = "";
              })
              .catch(() => {
                enteredRef.current = "";
              });
          }
        }
        if (!bestScene) enteredRef.current = "";
      }

      let bestNpc: { id: string; name: string } | null = null;
      let bestNpcD = TALK_DIST;
      for (const n of live.npcs) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < bestNpcD) {
          bestNpcD = d;
          bestNpc = { id: n.id, name: n.name };
        }
      }
      const npcKey = bestNpc?.id ?? "";
      if (npcKey !== nearNpcRef.current) {
        nearNpcRef.current = npcKey;
        setNearNpc(bestNpc);
      }
    };
    probe();
    const timer = window.setInterval(probe, PROBE_MS);
    return () => window.clearInterval(timer);
  }, [ready]);

  if (!map) {
    return (
      <div className="campus-loading">
        <span>正在加载校园地图…</span>
      </div>
    );
  }

  return (
    <div
      className="campus"
      ref={viewportRef}
      // 点场景 = 把焦点从输入框挪开；否则 WASD 会被当成打字
      onClick={() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el !== document.body) el.blur();
      }}
    >
      <div className="campus-world" ref={worldRef} style={{ width: W * SCALE, height: H * SCALE }}>
        <div
          className="campus-ground"
          style={{ backgroundImage: `url(${map.image ?? "/map/campus-wide.jpg"})` }}
        />

        {map.scenes.map((s) => {
          const built = s.status === "built";
          const isNear = nearScene?.id === s.id;
          const hasInterior = built && interiorFor(s.id) !== null;
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                className={`campus-poi${built ? "" : " planned"}${isNear ? " near" : ""}`}
                style={{ left: Math.round(s.x * SCALE), top: Math.round(s.y * SCALE) }}
                title={built ? s.name : `${s.name}（${s.status === "planned" ? "规划中" : "在建"}）`}
                onClick={() => built && onEnter(s.id)}
              >
                <i />
                <span>{s.name}</span>
              </button>
              {hasInterior && (
                <button
                  type="button"
                  className={`campus-entry${isNear ? " near" : ""}`}
                  style={{ left: Math.round(s.x * SCALE) + 34, top: Math.round(s.y * SCALE) - 44 }}
                  title={`进入${s.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEnter(s.id);
                    onEnterInterior?.(s.id);
                  }}
                >
                  <i>进</i>
                  <span>进入{s.name}</span>
                </button>
              )}
            </Fragment>
          );
        })}

        {map.npcs.map((n) => {
          const isNear = nearNpc?.id === n.id;
          const isTalking = talkingTo === n.id;
          const mutter = bubbles.mutters[n.id];
          return (
            <button
              type="button"
              key={n.id}
              className={`campus-npc${isNear ? " near" : ""}${isTalking ? " talking" : ""}`}
              style={{ left: Math.round(n.x * SCALE), top: Math.round(n.y * SCALE) }}
              onClick={() => onTalk(n.id, n.name)}
              disabled={busy}
              title={`和${n.name}说话`}
            >
              {/* 走近时头顶浮一句短台词：只提示"可以聊"，不打断你走路 */}
              {isNear && !talkingTo && mutter && <span className="campus-mutter">{mutter}</span>}
              <img
                src={`/portraits/npc-${n.id.replace(/^npc_/, "")}.png`}
                alt=""
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
              <span className="npc-name">{n.name}</span>
            </button>
          );
        })}

        <div className="campus-hero" ref={heroRef}>
          <img
            ref={heroImgRef}
            src={heroSrc}
            alt=""
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </div>
      </div>

      <div className="campus-controls">
        <span className="campus-key">W</span>
        <span className="campus-key">A</span>
        <span className="campus-key">S</span>
        <span className="campus-key">D</span>
        <span className="campus-hint">走动</span>
        <span className="campus-coord" ref={coordRef} />
      </div>

      {nearScene && (
        <div className="campus-tip">
          <strong>{nearScene.name}</strong>
          <span>
            {nearScene.id === map.player.locId
              ? "你就在这里"
              : nearScene.status === "built"
                ? "走近即到达"
                : "尚未开放"}
          </span>
        </div>
      )}
    </div>
  );
}
