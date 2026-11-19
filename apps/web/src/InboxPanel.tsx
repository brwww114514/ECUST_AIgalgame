/**
 * 微信收件箱面板（issue #86）：GET 拉历史 + SSE 实时 + 防抖发送 + 回复。
 * 规则（去重/可见性/防抖/提示）都在 inbox.ts 纯函数里，组件只负责编排与渲染。
 * 服务端已按收发双方过滤 private 消息，这里不做"查看全部聊天"入口、不解码正文。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { WorldState } from "../../../packages/shared/src/contract/types.ts";
import type { MessageRecord } from "../../../packages/shared/src/contract/v2.ts";
import { fetchInbox, postMessage, streamInbox } from "./api-messages.ts";
import { HttpError, httpFailMessage } from "./http.ts";
import {
  applyGossipEvents,
  claimSend,
  confidencePercent,
  formatCreatedAt,
  inboxLoadNotice,
  kindLabel,
  mergeMessages,
  sendErrorNotice,
  SSE_RECONNECT_MS,
  visibleFor,
} from "./inbox.ts";
import type { SendLock } from "./inbox.ts";

export interface InboxPanelProps {
  roomId: string;
  actorId: string;
  /** 只用来把 actorId 显示成人名；权威状态仍由 App 持有，这里不写 */
  state: WorldState | null;
}

export default function InboxPanel({ roomId, actorId, state }: InboxPanelProps) {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [denied, setDenied] = useState(false);
  const [to, setTo] = useState("");
  const [content, setContent] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);
  const lockRef = useRef<SendLock>({ lastClaimAt: 0 });

  const nameOf = (id: string): string => state?.entities[id]?.name ?? id;

  /** 收件人候选来自房间成员表（服务端下发），不是前端猜 actorId */
  const contacts = useMemo(() => {
    const list = (state?.room.members ?? [])
      .filter((m) => m.role !== "spectator" && m.actorId !== actorId)
      .map((m) => ({ id: m.actorId, name: nameOf(m.actorId) }));
    if (to && !list.some((c) => c.id === to)) list.unshift({ id: to, name: nameOf(to) });
    return list;
  }, [state, actorId, to]);

  // 换房间/换身份：清干净上一局的 UI 状态；GET + SSE 都在同一 effect 里按版本作废
  useEffect(() => {
    setMessages([]);
    setNotice("");
    setDenied(false);
    setTo("");
    setContent("");
    setReplyTo("");
    setInFlight(false);
    inFlightRef.current = false;
    lockRef.current = { lastClaimAt: 0 };
    if (!roomId || !actorId) return;

    let alive = true;
    let forbidden = false;
    let reconnectTimer: number | undefined;
    const controller = new AbortController();
    const markForbidden = () => {
      forbidden = true;
      if (!alive) return;
      setDenied(true);
      setNotice(inboxLoadNotice(403) ?? "没有权限查看此收件箱");
    };

    void fetchInbox(roomId, actorId)
      .then((list) => {
        if (alive) setMessages((prev) => mergeMessages(prev, list));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // 403 是身份不匹配：降级提示，不当网络错误重试
        if (e instanceof HttpError && e.status === 403) markForbidden();
        else setNotice(httpFailMessage(e));
      });

    const connect = async () => {
      await streamInbox(
        roomId,
        actorId,
        {
          onMessage: (m) => {
            if (!alive) return;
            // SSE 重连会重放：mergeMessages 按 message.id 去重
            setMessages((prev) => mergeMessages(prev, [m]));
          },
          onForbidden: markForbidden,
        },
        controller.signal,
      );
      if (alive && !forbidden && !controller.signal.aborted) {
        reconnectTimer = window.setTimeout(() => void connect(), SSE_RECONNECT_MS);
      }
    };
    void connect();

    return () => {
      alive = false;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [roomId, actorId]);

  const startReply = (m: MessageRecord) => {
    setReplyTo(m.id);
    setTo(m.from);
    setNotice("");
  };

  const send = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const text = content.trim();
    if (!roomId || !actorId || !to || !text || denied || inFlightRef.current) return;
    // 500ms 时间锁 + inFlight 双保险：连点只会真正发一次请求
    const claim = claimSend(lockRef.current, Date.now());
    lockRef.current = claim.next;
    if (!claim.allowed) {
      setNotice("发送太快了，请稍等片刻再发。");
      return;
    }
    inFlightRef.current = true;
    setInFlight(true);
    setNotice("");
    try {
      const outcome = await postMessage(roomId, actorId, to, text, replyTo || undefined);
      if (!outcome.ok) {
        setNotice(`${sendErrorNotice(outcome.code)}${outcome.message ? `（${outcome.message}）` : ""}`);
        return;
      }
      // 以服务端返回的 events 为准，不另造乐观消息（避免与 SSE 推送重复）
      setMessages((prev) => applyGossipEvents(prev, outcome.events));
      setContent("");
      setReplyTo("");
    } catch (err) {
      setNotice(httpFailMessage(err));
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  };

  const visible = visibleFor(messages, actorId);
  const replyTarget = visible.find((m) => m.id === replyTo);

  return (
    <div className="inbox-page">
      <div className="inbox-list">
        {visible.length === 0 && <div className="panel-note">收件箱还是空的。给谁发条私信吧。</div>}
        {visible.map((m) => (
          <article key={m.id} className={`inbox-msg ${m.kind}${m.from === actorId ? " mine" : ""}`}>
            <header className="inbox-msg-head">
              <strong>{nameOf(m.from)}</strong>
              <span className="muted">→ {nameOf(m.to)}</span>
              <span className="msg-kind">{kindLabel(m.kind)}</span>
              {m.kind === "gossip" && <span className="msg-hop">{m.hop} 跳</span>}
              <span className="msg-conf" title="传播可信度">
                {confidencePercent(m.confidence)}
              </span>
              <time>{formatCreatedAt(m.createdAt)}</time>
            </header>
            <p className="inbox-msg-body">{m.content}</p>
            {m.replyTo && (
              <div className="muted inbox-reply-ref">
                {replyTarget ? `回复 ${nameOf(replyTarget.from)}` : `回复消息 ${m.replyTo.slice(0, 8)}`}
              </div>
            )}
            {m.from !== actorId && (
              <button type="button" className="btn ghost inbox-reply-btn" onClick={() => startReply(m)}>
                回复
              </button>
            )}
          </article>
        ))}
      </div>

      {notice && <div className="err inbox-notice">{notice}</div>}

      <form className="inbox-composer" onSubmit={(e) => void send(e)}>
        {replyTo && (
          <div className="inbox-replying">
            <span>正在回复 {replyTarget ? nameOf(replyTarget.from) : replyTo.slice(0, 8)}</span>
            <button type="button" className="btn ghost" onClick={() => setReplyTo("")}>
              取消
            </button>
          </div>
        )}
        <div className="inbox-row">
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={inFlight || denied}
            aria-label="收件人"
          >
            <option value="">选择收件人</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={replyTo ? "写下回复…" : "发一条私信…"}
            disabled={inFlight || denied}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={!to || !textReady(content) || inFlight || denied}
          >
            {inFlight ? "发送中…" : "发送"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 按钮禁用条件与 send 里的校验保持一致（纯字符串判断） */
function textReady(text: string): boolean {
  return text.trim().length > 0;
}
