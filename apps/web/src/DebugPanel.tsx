/**
 * 调试面板（只读）：展示 NPC 记忆、心理活动、私信、世界状态摘要。
 * 平时完全隐藏——只有首页快捷键 + 正确口令才挂载。
 */
import { useEffect, useState } from "react";
import type { DebugMemory, DebugMessage, DebugNpc, DebugSnapshot } from "./debug-api.ts";
import { DebugSessionExpiredError, fetchDebugSnapshot } from "./debug-api.ts";

type Tab = "mental" | "memory" | "messages" | "npcs" | "events";

const TABS: { id: Tab; label: string }[] = [
  { id: "mental", label: "心理活动" },
  { id: "memory", label: "NPC 记忆" },
  { id: "messages", label: "私信" },
  { id: "npcs", label: "NPC 状态" },
  { id: "events", label: "事件流" },
];

function fmtTime(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function MemoryRow({ m, mental }: { m: DebugMemory; mental?: boolean }) {
  const when = `T${m.turn} · ${fmtTime(m.createdAt)}`;
  return (
    <li className="dbg-item">
      <div className="dbg-item-head">
        <strong>{m.ownerId}</strong>
        <span className="dbg-tag">{m.visibility}</span>
        {mental && <span className="dbg-tag dbg-tag-mental">心理</span>}
        <span className="dbg-meta">{when} · salience {m.salience}</span>
      </div>
      <div className="dbg-text">{m.content}</div>
      {m.tags.length > 0 && <div className="dbg-tags">{m.tags.map((t) => <span key={t}>#{t}</span>)}</div>}
      {m.about.length > 0 && <div className="dbg-meta">关于：{m.about.join(", ")}</div>}
    </li>
  );
}

function MessageRow({ m }: { m: DebugMessage }) {
  return (
    <li className="dbg-item">
      <div className="dbg-item-head">
        <strong>{m.from}</strong>
        <span className="dbg-meta">→ {m.to}</span>
        <span className="dbg-tag">{m.kind}</span>
        <span className="dbg-meta">hop {m.hop} · conf {m.confidence} · {fmtTime(m.createdAt)}</span>
      </div>
      <div className="dbg-text">{m.content}</div>
    </li>
  );
}

function NpcRow({ n }: { n: DebugNpc }) {
  const attrs = Object.entries(n.attrs)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 24);
  return (
    <li className="dbg-item">
      <div className="dbg-item-head"><strong>{n.name}</strong><span className="dbg-meta">{n.id}</span></div>
      <div className="dbg-attrs">
        {attrs.map(([k, v]) => <span key={k}><code>{k}</code>: {String(v)}</span>)}
        {attrs.length === 0 && <span className="dbg-meta">（无可展示属性）</span>}
      </div>
    </li>
  );
}

export interface DebugPanelProps {
  roomId: string;
  token: string;
  onClose: () => void;
  onExpired: () => void;
}

export default function DebugPanel({ roomId, token, onClose, onExpired }: DebugPanelProps) {
  const [tab, setTab] = useState<Tab>("mental");
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setErr("");
    try {
      const s = await fetchDebugSnapshot(roomId, token);
      setSnap(s);
    } catch (e) {
      if (e instanceof DebugSessionExpiredError) onExpired();
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const counts = snap?.counts;
  return (
    <div className="dbg-overlay" role="dialog" aria-label="调试面板">
      <div className="dbg-window">
        <div className="dbg-header">
          <h2>调试面板 <span className="dbg-meta">room {roomId}</span></h2>
          <div className="dbg-header-actions">
            {counts && (
              <span className="dbg-meta">
                NPC {snap?.npcs.length ?? 0} · 记忆 {counts.memories} · 心理 {counts.mental} · 私信 {counts.messages}
              </span>
            )}
            <button type="button" onClick={() => void refresh()} disabled={loading}>刷新</button>
            <button type="button" onClick={onClose}>关闭</button>
          </div>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="dbg-tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? "dbg-tab active" : "dbg-tab"} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="dbg-body">
          {loading && !snap ? <p className="panel-note">加载中…</p> : (
            <>
              {tab === "mental" && (
                snap?.mental.length ? <ul className="dbg-list">{snap.mental.map((m, i) => <MemoryRow key={m.id + i} m={m} mental />)}</ul>
                  : <p className="panel-note">暂无心理活动记录。</p>
              )}
              {tab === "memory" && (
                snap?.memories.length ? <ul className="dbg-list">{snap.memories.map((m, i) => <MemoryRow key={m.id + i} m={m} />)}</ul>
                  : <p className="panel-note">暂无记忆记录。</p>
              )}
              {tab === "messages" && (
                snap?.messages.length ? <ul className="dbg-list">{snap.messages.map((m) => <MessageRow key={m.id} m={m} />)}</ul>
                  : <p className="panel-note">暂无私信记录。</p>
              )}
              {tab === "npcs" && (
                snap?.npcs.length ? <ul className="dbg-list">{snap.npcs.map((n) => <NpcRow key={n.id} n={n} />)}</ul>
                  : <p className="panel-note">本房间暂无 NPC。</p>
              )}
              {tab === "events" && (
                snap?.events.length ? (
                  <ul className="dbg-list">
                    {snap.events.map((e, i) => (
                      <li key={i} className="dbg-item dbg-event">
                        <span className="dbg-meta">#{e.seq} · {fmtTime(e.ts)} · {e.actorId}</span>
                        <code>{e.type}</code>
                      </li>
                    ))}
                  </ul>
                ) : <p className="panel-note">暂无事件。</p>
              )}
              {tab === "events" && <p className="panel-note">仅展示最近 300 条事件中的最后 80 条；长房间早期记录不在此列。</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
