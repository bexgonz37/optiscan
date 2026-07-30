import { NextResponse } from "next/server";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { deferServerBoot } from "@/lib/server-boot";
import { jsonFromRouteError } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — suggested prompts, modes, glossary, and conversation list.
 * POST — ask one question (creates a conversation when none is supplied).
 *
 * ADVISORY ONLY. This route reads canonical findings and writes chat rows. It has
 * no path to the scanner, Discord, delivery, grading, or Railway configuration.
 */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const { getDb } = await import("@/lib/db");
    const { SUGGESTED_PROMPTS, GLOSSARY } = await import("@/lib/ai/advisory-chat");
    const { CHAT_MODES } = await import("@/lib/ai/advisory-chat-evidence");
    const { listConversationsOnDb } = await import("@/lib/ai/advisory-chat-store");
    const { aiConfig } = await import("@/lib/ai/config");
    const cfg = aiConfig(process.env);
    let conversations: unknown[] = [];
    try { conversations = listConversationsOnDb(getDb() as any, 40); } catch { conversations = []; }
    return NextResponse.json({
      ok: true,
      aiEnabled: cfg.enabled,
      modes: CHAT_MODES,
      suggestedPrompts: SUGGESTED_PROMPTS,
      glossary: GLOSSARY,
      conversations,
      safety: {
        aiAuthority: "ADVISORY_ONLY",
        productionBehaviorChanged: false,
        note: "The chatbot explains canonical findings. It cannot change production behaviour.",
      },
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}

export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  deferServerBoot();
  try {
    const body = await req.json().catch(() => ({}));
    const question = String((body as any)?.message ?? "").trim();
    if (!question) {
      return NextResponse.json({ ok: false, error: "message_required" }, { status: 400 });
    }
    if (question.length > 2_000) {
      return NextResponse.json({ ok: false, error: "message_too_long" }, { status: 400 });
    }
    const mode = String((body as any)?.mode ?? "EXPLAIN").toUpperCase();
    const requestedConversationId = (body as any)?.conversationId
      ? String((body as any).conversationId)
      : null;

    const { getDb } = await import("@/lib/db");
    const { answerAdvisoryChat } = await import("@/lib/ai/advisory-chat");
    const { loadCanonicalReport, loadSupplementalEvidence } = await import("@/lib/ai/advisory-chat-sources");
    const {
      createConversationOnDb, appendMessageOnDb, getConversationOnDb, titleFromMessage,
    } = await import("@/lib/ai/advisory-chat-store");
    const db = getDb();
    const nowMs = Date.now();

    // Resolve or create the conversation.
    let conversationId = requestedConversationId;
    let history: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (conversationId) {
      const existing = getConversationOnDb(db as any, conversationId);
      if (!existing) return NextResponse.json({ ok: false, error: "conversation_not_found" }, { status: 404 });
      history = existing.messages.map((m) => ({ role: m.role, content: m.content }));
    } else {
      conversationId = createConversationOnDb(db as any, {
        title: titleFromMessage(question),
        mode: mode as any,
        nowMs,
      }).conversationId;
    }

    appendMessageOnDb(db as any, {
      conversationId, role: "user", content: question, mode: mode as any, nowMs,
    });

    // The deterministic report is loaded first; if the AI layer fails, it still stands.
    const report = loadCanonicalReport(db);
    const supplemental = loadSupplementalEvidence(db, process.env);
    const answer = await answerAdvisoryChat({
      question, mode: mode as any, report, supplemental, history,
    });

    const messageId = appendMessageOnDb(db as any, {
      conversationId,
      role: "assistant",
      content: answer.answer,
      mode: answer.mode,
      evidenceIds: answer.citedEvidenceIds,
      reportId: answer.reportId,
      model: answer.model,
      validationStatus: answer.validationStatus,
      validationFailures: answer.validationFailures,
      fixPrompt: answer.fixPrompt,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
      nowMs: Date.now(),
    });

    return NextResponse.json({
      ok: true,
      conversationId,
      messageId,
      answer: answer.answer,
      mode: answer.mode,
      degraded: answer.degraded,
      validationStatus: answer.validationStatus,
      validationFailures: answer.validationFailures,
      citedEvidenceIds: answer.citedEvidenceIds,
      // Only the cited chips travel back, so the UI can render evidence without the full packet.
      evidence: answer.evidence.filter((e) => answer.citedEvidenceIds.includes(e.id)),
      caveats: answer.caveats,
      fixPrompt: answer.fixPrompt,
      reportId: answer.reportId,
      model: answer.model,
      safety: answer.safety,
    }, { status: 200 });
  } catch (err) {
    return jsonFromRouteError(err);
  }
}
