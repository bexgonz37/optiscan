import { checkApiToken, unauthorized } from "@/lib/auth";
import { loopState } from "@/lib/scanner-loop";
import { ensureServerBoot } from "@/lib/server-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/scanner/stream — SSE emitting loopState every 1s. */
export async function GET(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  ensureServerBoot();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const push = () => {
        if (closed) return;
        try {
          const payload = JSON.stringify({ ok: true, realtime: loopState(), ts: Date.now() });
          controller.enqueue(enc.encode(`data: ${payload}\n\n`));
        } catch {
          closed = true;
          try { controller.close(); } catch { /* ignore */ }
        }
      };

      push();
      const id = setInterval(push, 1000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(id);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
