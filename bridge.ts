#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// Slack gangprompting bridge: read / send / monitor / react over conversations.history + chat.postMessage.
// Env: SLACK_BOT_TOKEN, SLACK_CHANNEL (defaults loaded from .env next to this script)
// Usage:
//   bridge.ts read [--limit N] [--oldest TS]
//   bridge.ts send <text> [--thread-ts TS]
//   bridge.ts monitor [--interval SECONDS]
//   bridge.ts react <ts> <emoji-name>
// Each read/monitor line is one JSON object: {id, timestamp, author, author_id, content, thread_ts}

const HERE = new URL(".", import.meta.url).pathname;

async function loadEnv() {
  try {
    const text = await Deno.readTextFile(HERE + ".env");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const k = trimmed.slice(0, idx);
      const v = trimmed.slice(idx + 1);
      if (Deno.env.get(k) === undefined) Deno.env.set(k, v);
    }
  } catch {
    // no .env file; rely on process environment
  }
}
await loadEnv();

const TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const CHANNEL = Deno.env.get("SLACK_CHANNEL");

const userCache = new Map<string, string>();

async function api(method: string, params: Record<string, string | number>, httpMethod: "GET" | "POST" = "POST") {
  const url = new URL(`https://slack.com/api/${method}`);
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
  let resp: Response;
  if (httpMethod === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    resp = await fetch(url, { headers });
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    resp = await fetch(url, { method: "POST", headers, body });
  }
  const json = await resp.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json)}`);
  return json;
}

async function resolveUser(userId?: string): Promise<string> {
  if (!userId) return "unknown";
  if (userCache.has(userId)) return userCache.get(userId)!;
  let name = userId;
  try {
    const info = (await api("users.info", { user: userId }, "GET")).user;
    name = info.real_name || info.name || userId;
  } catch {
    // fall back to raw id
  }
  userCache.set(userId, name);
  return name;
}

const IGNORE_AUTHOR_IDS = new Set((Deno.env.get("IGNORE_AUTHOR_IDS") ?? "").split(",").filter(Boolean));

async function emit(msg: any) {
  const authorId = msg.user || msg.bot_id || "";
  if (IGNORE_AUTHOR_IDS.has(authorId)) return;
  console.log(JSON.stringify({
    id: msg.ts,
    timestamp: msg.ts,
    author: msg.user ? await resolveUser(msg.user) : (msg.username || authorId),
    author_id: authorId,
    content: msg.text || "",
    thread_ts: msg.thread_ts ?? null,
  }));
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdRead(args: string[]) {
  const limit = Number(argValue(args, "--limit") ?? 100);
  const oldest = argValue(args, "--oldest");
  const params: Record<string, string | number> = { channel: CHANNEL!, limit };
  if (oldest) params.oldest = oldest;
  const body = await api("conversations.history", params, "GET");
  for (const msg of [...body.messages].reverse()) {
    if (msg.subtype === "channel_join" || msg.subtype === "channel_leave") continue;
    await emit(msg);
  }
}

async function cmdSend(args: string[]) {
  if (args.length === 0) {
    console.error("usage: bridge.ts send <text> [--thread-ts TS]");
    Deno.exit(1);
  }
  const text = args[0];
  const threadTs = argValue(args, "--thread-ts");
  const params: Record<string, string | number> = { channel: CHANNEL!, text };
  if (threadTs) params.thread_ts = threadTs;
  const body = await api("chat.postMessage", params);
  console.log(JSON.stringify({ ok: true, ts: body.ts, channel: body.channel }));
}

async function cmdReact(args: string[]) {
  if (args.length < 2) {
    console.error("usage: bridge.ts react <ts> <emoji-name>");
    Deno.exit(1);
  }
  const [ts, name] = args;
  await api("reactions.add", { channel: CHANNEL!, timestamp: ts, name });
  console.log(JSON.stringify({ ok: true, ts, name }));
}

// conversations.history omits thread replies entirely — each active thread must be
// polled separately via conversations.replies, or replies are silently lost.
async function pollThreads(historyMsgs: any[], threadSeen: Map<string, string>) {
  for (const parent of historyMsgs) {
    const replyCount = parent.reply_count || 0;
    if (replyCount === 0) continue;
    const parentTs: string = parent.ts;
    const latestReply: string = parent.latest_reply ?? parentTs;
    const seen = threadSeen.get(parentTs) ?? parentTs;
    if (latestReply <= seen) continue;
    const repliesBody = await api("conversations.replies", { channel: CHANNEL!, ts: parentTs }, "GET");
    for (const reply of repliesBody.messages) {
      if (reply.ts === parentTs || reply.ts <= seen) continue;
      if (reply.subtype === "channel_join" || reply.subtype === "channel_leave") continue;
      await emit(reply);
    }
    threadSeen.set(parentTs, latestReply);
  }
}

async function cmdMonitor(args: string[]) {
  const interval = Number(argValue(args, "--interval") ?? 20);
  const body0 = await api("conversations.history", { channel: CHANNEL!, limit: 50 }, "GET");
  let lastTs: string = body0.messages[0]?.ts ?? String(Date.now() / 1000);
  const threadSeen = new Map<string, string>();
  for (const m of body0.messages) {
    if (m.reply_count) threadSeen.set(m.ts, m.latest_reply ?? m.ts);
  }
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const body = await api("conversations.history", { channel: CHANNEL!, limit: 50 }, "GET");
    const msgs = body.messages.filter((m: any) => m.subtype !== "channel_join" && m.subtype !== "channel_leave");
    const newTopLevel = msgs.filter((m: any) => m.ts > lastTs);
    for (const msg of [...newTopLevel].reverse()) await emit(msg);
    await pollThreads(msgs, threadSeen);
    if (body.messages[0]) lastTs = body.messages[0].ts > lastTs ? body.messages[0].ts : lastTs;
  }
}

const [cmd, ...rest] = Deno.args;
switch (cmd) {
  case "read":
    await cmdRead(rest);
    break;
  case "send":
    await cmdSend(rest);
    break;
  case "monitor":
    await cmdMonitor(rest);
    break;
  case "react":
    await cmdReact(rest);
    break;
  default:
    console.error("usage: bridge.ts <read|send|monitor|react> ...");
    Deno.exit(1);
}
