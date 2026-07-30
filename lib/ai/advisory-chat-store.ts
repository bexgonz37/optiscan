/**
 * advisory-chat-store.ts — persistence for advisory chat conversations.
 *
 * Stores only what is needed to re-read a conversation and audit its grounding:
 * the messages, the canonical evidence ids cited, the report id, the model, and
 * the validation outcome. It deliberately does NOT store secrets, tokens, webhook
 * URLs, or raw market payloads — evidence is referenced by id, never copied.
 *
 * Every function takes a db handle so the whole module is unit-testable.
 */
import { CHAT_MODES, type ChatMode } from "./advisory-chat-evidence.ts";

type ChatDb = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes?: number; lastInsertRowid?: number | bigint };
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec?: (sql: string) => unknown;
};

export interface ChatConversation {
  conversationId: string;
  title: string;
  mode: ChatMode;
  reportId: string | null;
  messageCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  mode: ChatMode | null;
  content: string;
  evidenceIds: string[];
  reportId: string | null;
  model: string | null;
  validationStatus: string | null;
  validationFailures: unknown[];
  fixPrompt: string | null;
  feedback: "up" | "down" | null;
  feedbackNote: string | null;
  createdAtMs: number;
}

/** Additive, repeat-safe schema. Mirrors lib/db.ts so tests can build in isolation. */
export function ensureAdvisoryChatSchema(db: ChatDb): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS ai_chat_conversations (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      report_id TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      deleted_at_ms INTEGER
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      mode TEXT,
      content TEXT NOT NULL,
      evidence_ids_json TEXT,
      report_id TEXT,
      model TEXT,
      validation_status TEXT,
      validation_failures_json TEXT,
      fix_prompt TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      feedback TEXT,
      feedback_note TEXT,
      created_at_ms INTEGER NOT NULL
    )
  `).run();
}

function normalizeMode(mode: unknown): ChatMode {
  const m = String(mode ?? "EXPLAIN").toUpperCase() as ChatMode;
  return CHAT_MODES.includes(m) ? m : "EXPLAIN";
}

/** Redaction guard: a secret must never reach the transcript. */
const SECRET_PATTERNS: RegExp[] = [
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ANTHROPIC_API_KEY|SCAN_API_TOKEN|POLYGON_API_KEY|DATABASE_URL|RAILWAY_TOKEN)\s*[=:]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
];

/**
 * Strip anything secret-shaped before persisting. Defence in depth: the prompt
 * never includes secrets, but a user could paste one into the chat box.
 */
export function redactForPersistence(text: string): string {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function newId(prefix: string, nowMs: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${nowMs.toString(36)}${rand}`;
}

/** Title derived from the first user message; never from model output. */
export function titleFromMessage(message: string): string {
  const clean = redactForPersistence(String(message ?? "")).replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

export function createConversationOnDb(
  db: ChatDb,
  input: { title?: string; mode?: ChatMode; reportId?: string | null; nowMs: number },
): ChatConversation {
  ensureAdvisoryChatSchema(db);
  const conversationId = newId("chat", input.nowMs);
  const mode = normalizeMode(input.mode);
  const title = redactForPersistence(input.title ?? "New conversation").slice(0, 120) || "New conversation";
  db.prepare(`
    INSERT INTO ai_chat_conversations
      (conversation_id, title, mode, report_id, message_count, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,0,?,?)
  `).run(conversationId, title, mode, input.reportId ?? null, input.nowMs, input.nowMs);
  return {
    conversationId, title, mode, reportId: input.reportId ?? null,
    messageCount: 0, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
  };
}

export function appendMessageOnDb(
  db: ChatDb,
  input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    mode?: ChatMode | null;
    evidenceIds?: string[];
    reportId?: string | null;
    model?: string | null;
    validationStatus?: string | null;
    validationFailures?: unknown[];
    fixPrompt?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    nowMs: number;
  },
): number {
  ensureAdvisoryChatSchema(db);
  const res = db.prepare(`
    INSERT INTO ai_chat_messages
      (conversation_id, role, mode, content, evidence_ids_json, report_id, model,
       validation_status, validation_failures_json, fix_prompt,
       input_tokens, output_tokens, latency_ms, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.conversationId,
    input.role,
    input.mode ?? null,
    redactForPersistence(input.content),
    JSON.stringify(input.evidenceIds ?? []),
    input.reportId ?? null,
    input.model ?? null,
    input.validationStatus ?? null,
    input.validationFailures ? JSON.stringify(input.validationFailures) : null,
    input.fixPrompt ? redactForPersistence(input.fixPrompt) : null,
    Math.max(0, Math.floor(input.inputTokens ?? 0)),
    Math.max(0, Math.floor(input.outputTokens ?? 0)),
    Math.max(0, Math.floor(input.latencyMs ?? 0)),
    input.nowMs,
  );
  db.prepare(`
    UPDATE ai_chat_conversations
       SET message_count = message_count + 1, updated_at_ms = ?
     WHERE conversation_id = ?
  `).run(input.nowMs, input.conversationId);
  return Number(res.lastInsertRowid ?? 0);
}

function rowToMessage(r: any): ChatMessage {
  let evidenceIds: string[] = [];
  let validationFailures: unknown[] = [];
  try { evidenceIds = r.evidence_ids_json ? JSON.parse(r.evidence_ids_json) : []; } catch { evidenceIds = []; }
  try { validationFailures = r.validation_failures_json ? JSON.parse(r.validation_failures_json) : []; } catch { validationFailures = []; }
  return {
    id: Number(r.id),
    conversationId: String(r.conversation_id),
    role: r.role === "assistant" ? "assistant" : "user",
    mode: r.mode ? normalizeMode(r.mode) : null,
    content: String(r.content ?? ""),
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
    reportId: r.report_id ?? null,
    model: r.model ?? null,
    validationStatus: r.validation_status ?? null,
    validationFailures: Array.isArray(validationFailures) ? validationFailures : [],
    fixPrompt: r.fix_prompt ?? null,
    feedback: r.feedback === "up" || r.feedback === "down" ? r.feedback : null,
    feedbackNote: r.feedback_note ?? null,
    createdAtMs: Number(r.created_at_ms ?? 0),
  };
}

export function listConversationsOnDb(db: ChatDb, limit = 40): ChatConversation[] {
  ensureAdvisoryChatSchema(db);
  const rows = db.prepare(`
    SELECT conversation_id, title, mode, report_id, message_count, created_at_ms, updated_at_ms
    FROM ai_chat_conversations
    WHERE deleted_at_ms IS NULL
    ORDER BY updated_at_ms DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(200, limit))) as any[];
  return rows.map((r) => ({
    conversationId: String(r.conversation_id),
    title: String(r.title),
    mode: normalizeMode(r.mode),
    reportId: r.report_id ?? null,
    messageCount: Number(r.message_count ?? 0),
    createdAtMs: Number(r.created_at_ms ?? 0),
    updatedAtMs: Number(r.updated_at_ms ?? 0),
  }));
}

export function getConversationOnDb(
  db: ChatDb,
  conversationId: string,
): { conversation: ChatConversation; messages: ChatMessage[] } | null {
  ensureAdvisoryChatSchema(db);
  const c = db.prepare(`
    SELECT conversation_id, title, mode, report_id, message_count, created_at_ms, updated_at_ms
    FROM ai_chat_conversations WHERE conversation_id=? AND deleted_at_ms IS NULL
  `).get(conversationId) as any;
  if (!c) return null;
  const rows = db.prepare(
    "SELECT * FROM ai_chat_messages WHERE conversation_id=? ORDER BY created_at_ms ASC, id ASC",
  ).all(conversationId) as any[];
  return {
    conversation: {
      conversationId: String(c.conversation_id),
      title: String(c.title),
      mode: normalizeMode(c.mode),
      reportId: c.report_id ?? null,
      messageCount: Number(c.message_count ?? 0),
      createdAtMs: Number(c.created_at_ms ?? 0),
      updatedAtMs: Number(c.updated_at_ms ?? 0),
    },
    messages: rows.map(rowToMessage),
  };
}

export function renameConversationOnDb(
  db: ChatDb, conversationId: string, title: string, nowMs: number,
): boolean {
  ensureAdvisoryChatSchema(db);
  const clean = redactForPersistence(title).replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return false;
  const res = db.prepare(
    "UPDATE ai_chat_conversations SET title=?, updated_at_ms=? WHERE conversation_id=? AND deleted_at_ms IS NULL",
  ).run(clean, nowMs, conversationId);
  return Number(res.changes ?? 0) > 0;
}

/** Soft delete so an audit trail survives while the conversation leaves the UI. */
export function deleteConversationOnDb(db: ChatDb, conversationId: string, nowMs: number): boolean {
  ensureAdvisoryChatSchema(db);
  const res = db.prepare(
    "UPDATE ai_chat_conversations SET deleted_at_ms=?, updated_at_ms=? WHERE conversation_id=? AND deleted_at_ms IS NULL",
  ).run(nowMs, nowMs, conversationId);
  return Number(res.changes ?? 0) > 0;
}

export function recordFeedbackOnDb(
  db: ChatDb,
  input: { conversationId: string; messageId: number; feedback: "up" | "down"; note?: string | null },
): boolean {
  ensureAdvisoryChatSchema(db);
  if (input.feedback !== "up" && input.feedback !== "down") return false;
  const res = db.prepare(`
    UPDATE ai_chat_messages SET feedback=?, feedback_note=?
     WHERE id=? AND conversation_id=? AND role='assistant'
  `).run(
    input.feedback,
    input.note ? redactForPersistence(input.note).slice(0, 500) : null,
    Math.floor(input.messageId),
    input.conversationId,
  );
  return Number(res.changes ?? 0) > 0;
}
