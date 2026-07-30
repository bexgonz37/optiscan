"use client";

/**
 * AdvisoryChat — source-grounded chat panel for /ai.
 *
 * Every numeric claim arrives with clickable evidence chips. The AI AUTHORITY and
 * PRODUCTION BEHAVIOR CHANGED banners are always visible, and a rejected or
 * unavailable answer degrades to a notice while the deterministic Findings Report
 * stays on the page. There is deliberately no APPLY action anywhere in this UI.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Shell";
import { scanHeaders } from "@/hooks/useScanner";
import { apiFetchJson } from "@/lib/client-auth";

type Mode = "EXPLAIN" | "INVESTIGATE" | "COMPARE" | "BUILD_FIX_PROMPT";

type EvidenceChip = {
  id: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  pipeline: string;
  lane: string;
  timeWindow: string;
  sampleSize: number | null;
  confidence: string;
  qualityStatus: string;
  freshness: string;
  sourceRef: string;
  meaning: string;
};

type ChatMessage = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  evidence?: EvidenceChip[];
  evidenceIds?: string[];
  caveats?: string[];
  fixPrompt?: string | null;
  validationStatus?: string | null;
  degraded?: boolean;
  feedback?: "up" | "down" | null;
};

type Conversation = { conversationId: string; title: string; messageCount: number; updatedAtMs: number };

const MODES: Mode[] = ["EXPLAIN", "INVESTIGATE", "COMPARE", "BUILD_FIX_PROMPT"];
const MODE_LABEL: Record<Mode, string> = {
  EXPLAIN: "EXPLAIN",
  INVESTIGATE: "INVESTIGATE",
  COMPARE: "COMPARE",
  BUILD_FIX_PROMPT: "BUILD FIX PROMPT",
};

function fmtValue(chip: EvidenceChip): string {
  if (chip.value == null) return "unavailable";
  const unit = chip.unit ? ` ${chip.unit}` : "";
  return `${chip.value}${unit}`;
}

export function AdvisoryChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("EXPLAIN");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [suggested, setSuggested] = useState<Array<{ prompt: string; mode: Mode }>>([]);
  const [glossary, setGlossary] = useState<Record<string, string>>({});
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const res = await apiFetchJson<{
        aiEnabled?: boolean;
        suggestedPrompts?: Array<{ prompt: string; mode: Mode }>;
        glossary?: Record<string, string>;
        conversations?: Conversation[];
      }>("/api/ai/advisory-chat");
      const meta = res.data;
      setSuggested(meta?.suggestedPrompts ?? []);
      setGlossary(meta?.glossary ?? {});
      setConversations(meta?.conversations ?? []);
      setAiEnabled(Boolean(meta?.aiEnabled));
    } catch {
      setAiEnabled(false);
    }
  }, []);

  useEffect(() => { void loadMeta(); }, [loadMeta]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const send = useCallback(async (text: string, sendMode: Mode) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    try {
      const res = await fetch("/api/ai/advisory-chat", {
        method: "POST",
        cache: "no-store",
        headers: { ...scanHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ message: question, mode: sendMode, conversationId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.error ? String(data.error) : `Request failed (${res.status}).`);
        return;
      }
      setConversationId(data.conversationId ?? null);
      setMessages((prev) => [...prev, {
        id: data.messageId,
        role: "assistant",
        content: data.answer,
        evidence: data.evidence ?? [],
        evidenceIds: data.citedEvidenceIds ?? [],
        caveats: data.caveats ?? [],
        fixPrompt: data.fixPrompt ?? null,
        validationStatus: data.validationStatus ?? null,
        degraded: Boolean(data.degraded),
        feedback: null,
      }]);
      void loadMeta();
    } catch (err: any) {
      setError(err?.message ?? "Could not reach the advisory chat.");
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, loadMeta]);

  const openConversation = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ messages?: any[] }>(`/api/ai/advisory-chat/${encodeURIComponent(id)}`);
      setConversationId(id);
      setMessages((res.data?.messages ?? []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        evidenceIds: m.evidenceIds ?? [],
        fixPrompt: m.fixPrompt ?? null,
        validationStatus: m.validationStatus ?? null,
        degraded: m.validationStatus != null && m.validationStatus !== "VALID",
        feedback: m.feedback ?? null,
      })));
    } catch (err: any) {
      setError(err?.message ?? "Could not load that conversation.");
    } finally {
      setBusy(false);
    }
  }, []);

  const rate = useCallback(async (messageId: number | undefined, feedback: "up" | "down") => {
    if (!messageId || !conversationId) return;
    try {
      await fetch(`/api/ai/advisory-chat/${encodeURIComponent(conversationId)}/feedback`, {
        method: "POST",
        headers: { ...scanHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ messageId, feedback }),
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback } : m)));
    } catch { /* feedback is best-effort and never blocks the chat */ }
  }, [conversationId]);

  const rename = useCallback(async () => {
    if (!conversationId) return;
    const title = window.prompt("Rename conversation");
    if (!title) return;
    await fetch(`/api/ai/advisory-chat/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { ...scanHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    void loadMeta();
  }, [conversationId, loadMeta]);

  const remove = useCallback(async () => {
    if (!conversationId) return;
    await fetch(`/api/ai/advisory-chat/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: scanHeaders(),
    });
    setConversationId(null);
    setMessages([]);
    void loadMeta();
  }, [conversationId, loadMeta]);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard unavailable; the textarea below is still selectable */ }
  }, []);

  return (
    <div className="advisory-chat">
      <div className="advisory-chat-authority">
        <strong>AI AUTHORITY: ADVISORY ONLY</strong>
        <strong>PRODUCTION BEHAVIOR CHANGED: NO</strong>
        <small>
          The chatbot explains canonical findings. It cannot change scanner rules, exits, thresholds,
          delivery, or Railway configuration. Every change to production goes through human-reviewed code.
        </small>
      </div>

      {aiEnabled === false ? (
        <p className="cc-term-empty">
          The AI layer is disabled or has no API key, so explanations are unavailable.
          The deterministic Findings Report on the other tabs is unaffected.
        </p>
      ) : null}

      <div className="advisory-chat-modes">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? "advisory-chat-mode is-active" : "advisory-chat-mode"}
            onClick={() => setMode(m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
        <span className="advisory-chat-mode-note">No APPLY mode exists by design.</span>
      </div>

      <div className="advisory-chat-body">
        <div className="advisory-chat-thread">
          {messages.length === 0 ? (
            <div className="advisory-chat-suggested">
              <p><strong>Ask about the latest findings</strong></p>
              {suggested.map((s) => (
                <button
                  key={s.prompt}
                  type="button"
                  className="advisory-chat-suggestion"
                  onClick={() => { setMode(s.mode); void send(s.prompt, s.mode); }}
                >
                  {s.prompt}
                </button>
              ))}
            </div>
          ) : null}

          {messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`advisory-chat-msg is-${m.role}`}>
              <div className="advisory-chat-msg-role">{m.role === "user" ? "You" : "Advisory analyst"}</div>
              <div className="advisory-chat-msg-body">{m.content}</div>

              {m.degraded && m.validationStatus && m.validationStatus !== "VALID" ? (
                <p className="advisory-chat-degraded">
                  Answer withheld ({m.validationStatus}). The deterministic Findings Report remains available
                  on the FINDINGS tab.
                </p>
              ) : null}

              {(m.evidence ?? []).length > 0 ? (
                <div className="advisory-chat-evidence">
                  <span className="advisory-chat-evidence-title">Evidence</span>
                  {(m.evidence ?? []).map((chip) => (
                    <Fragment key={chip.id}>
                      <button
                        type="button"
                        className="advisory-chat-chip"
                        onClick={() => setOpenChip(openChip === `${i}-${chip.id}` ? null : `${i}-${chip.id}`)}
                      >
                        {chip.label}: {fmtValue(chip)}
                      </button>
                      {openChip === `${i}-${chip.id}` ? (
                        <div className="advisory-chat-chip-detail">
                          <span><strong>Metric</strong>{chip.id}</span>
                          <span><strong>Meaning</strong>{chip.meaning}</span>
                          <span><strong>Pipeline</strong>{chip.pipeline}</span>
                          <span><strong>Lane</strong>{chip.lane}</span>
                          <span><strong>Window</strong>{chip.timeWindow}</span>
                          <span><strong>Sample size</strong>{chip.sampleSize ?? "unknown"}</span>
                          <span><strong>Confidence</strong>{chip.confidence}</span>
                          <span><strong>Quality</strong>{chip.qualityStatus}</span>
                          <span><strong>Freshness</strong>{chip.freshness}</span>
                          <span><strong>Source</strong>{chip.sourceRef}</span>
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : null}

              {(m.caveats ?? []).length > 0 ? (
                <details className="advisory-chat-caveats">
                  <summary>Limits on this answer ({(m.caveats ?? []).length})</summary>
                  <ul>{(m.caveats ?? []).map((c) => <li key={c}>{c}</li>)}</ul>
                </details>
              ) : null}

              {m.fixPrompt ? (
                <div className="advisory-chat-fixprompt">
                  <div className="advisory-chat-fixprompt-head">
                    <strong>Investigation prompt (export only)</strong>
                    <button type="button" onClick={() => copy(m.fixPrompt as string, `fix-${i}`)}>
                      {copied === `fix-${i}` ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <textarea readOnly rows={10} value={m.fixPrompt} />
                  <small>
                    Copying this text is the only action available. It cannot edit files, commit, deploy,
                    change Railway variables, trigger scans, or send Discord messages.
                  </small>
                </div>
              ) : null}

              {m.role === "assistant" && m.id ? (
                <div className="advisory-chat-feedback">
                  <button
                    type="button"
                    className={m.feedback === "up" ? "is-active" : undefined}
                    onClick={() => rate(m.id, "up")}
                    aria-label="Helpful"
                  >
                    Helpful
                  </button>
                  <button
                    type="button"
                    className={m.feedback === "down" ? "is-active" : undefined}
                    onClick={() => rate(m.id, "down")}
                    aria-label="Not helpful"
                  >
                    Not helpful
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {busy ? <p className="advisory-chat-busy">Reading canonical evidence...</p> : null}
          {error ? <p className="advisory-chat-error">{error}</p> : null}
          <div ref={endRef} />
        </div>

        <aside className="advisory-chat-side">
          <div className="advisory-chat-side-actions">
            <button type="button" onClick={() => { setConversationId(null); setMessages([]); setError(null); }}>
              New conversation
            </button>
            <button type="button" onClick={rename} disabled={!conversationId}>Rename</button>
            <button type="button" onClick={remove} disabled={!conversationId}>Delete</button>
          </div>
          <div className="advisory-chat-history">
            <span className="advisory-chat-evidence-title">History</span>
            {conversations.length === 0 ? (
              <p className="cc-term-empty">No saved conversations yet.</p>
            ) : conversations.map((c) => (
              <button
                key={c.conversationId}
                type="button"
                className={c.conversationId === conversationId ? "advisory-chat-conv is-active" : "advisory-chat-conv"}
                onClick={() => openConversation(c.conversationId)}
              >
                <strong>{c.title}</strong>
                <small>{c.messageCount} messages</small>
              </button>
            ))}
          </div>
        </aside>
      </div>

      <form
        className="advisory-chat-input"
        onSubmit={(e) => { e.preventDefault(); void send(input, mode); }}
      >
        <input
          type="text"
          value={input}
          placeholder="Ask about the latest findings in plain English"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>

      {Object.keys(glossary).length ? (
        <details className="advisory-chat-glossary">
          <summary>Plain-English glossary</summary>
          <dl>
            {Object.entries(glossary).map(([term, meaning]) => (
              <Fragment key={term}>
                <dt>{term}</dt>
                <dd>{meaning}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

export function AdvisoryChatCard() {
  return (
    <Card title="Chat" meta="Grounded in the canonical findings report">
      <AdvisoryChat />
    </Card>
  );
}
