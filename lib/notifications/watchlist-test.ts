export const WATCHLIST_TEST_CONTENT = [
  "**TEST · WATCHLIST**",
  "NOT EXECUTABLE",
  "VERIFY CONTRACT AFTER OPTIONS OPEN",
  "",
  "Synthetic channel wiring check only. No trade, paper position, subscriber alert, content event, readiness record, or production watchlist version is created.",
].join("\n");

export type WatchlistTestPost = (
  payload: Record<string, unknown>,
  opts: { webhook: "watchlist"; skipPublicCheck: true },
) => Promise<{ messageId: string | null; httpStatus: number; responseBodySafe?: string | null }>;

export interface WatchlistTestResult {
  ok: boolean;
  sent: boolean;
  messageId: string | null;
  httpStatus: number | null;
  error?: string;
}

export async function sendWatchlistTestMessage(opts: {
  env?: NodeJS.ProcessEnv;
  post?: WatchlistTestPost;
} = {}): Promise<WatchlistTestResult> {
  const env = opts.env ?? process.env;
  if (!String(env.DISCORD_WEBHOOK_WATCHLIST ?? "").trim()) {
    return {
      ok: false,
      sent: false,
      messageId: null,
      httpStatus: null,
      error: "DISCORD_WEBHOOK_WATCHLIST not configured",
    };
  }
  const post: WatchlistTestPost = opts.post ?? (async (
    payload: Record<string, unknown>,
    postOpts: { webhook: "watchlist"; skipPublicCheck: true },
  ) => {
    const { postToDiscord } = await import("../notifications.ts");
    return postToDiscord(payload, postOpts);
  });
  try {
    const res = await post(
      { content: WATCHLIST_TEST_CONTENT },
      { webhook: "watchlist", skipPublicCheck: true },
    );
    return {
      ok: true,
      sent: true,
      messageId: res.messageId ?? null,
      httpStatus: res.httpStatus,
    };
  } catch (err: any) {
    return {
      ok: false,
      sent: false,
      messageId: null,
      httpStatus: null,
      error: String(err?.message ?? err),
    };
  }
}
