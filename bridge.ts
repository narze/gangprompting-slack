#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// Slack gangprompting bridge: read / send / long-poll / react / thread over the Slack Web API.
// Env: SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_POLL_INTERVAL (defaults loaded from .env next to this script)
// Usage (every command also takes --channel ID to override SLACK_CHANNEL for one call):
//   bridge.ts read [--limit N] [--after TS]
//   bridge.ts send <text> [--thread-ts TS]
//   bridge.ts long-poll --after TS [--timeout SECONDS] [--include-bots]
//   bridge.ts react <ts> <emoji-name>
//   bridge.ts thread <parent-ts>
//   bridge.ts download <url_private> [--out DIR]   (needs --allow-write and the files:read scope)
// Each message line is one JSON object: {id, timestamp, channel_id, author, author_id, content, thread_ts}.
// long-poll also prints plain-text lines that start with ">>>": a reminder to start long-poll again
// before acting on the messages, and the exact command to run next.

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

// `--channel ID` works on every command: pull it out of the args before dispatch so each
// command sees only its own options, and so one agent can watch several channels.
const [cmd, ...rawArgs] = Deno.args;
const channelFlag = rawArgs.indexOf("--channel");
const CHANNEL_OVERRIDE = channelFlag >= 0 ? rawArgs[channelFlag + 1] : undefined;
const rest = channelFlag >= 0 ? rawArgs.filter((_, i) => i !== channelFlag && i !== channelFlag + 1) : rawArgs;
const CHANNEL = CHANNEL_OVERRIDE ?? Deno.env.get("SLACK_CHANNEL");

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
  // Attachments were invisible before: a message whose whole point is a
  // screenshot arrived as empty `content`, so the reader had no idea evidence
  // had been posted at all. Surface enough to know something is there and to go
  // fetch it deliberately.
  const files = (msg.files ?? []).map((f: any) => ({
    name: f.name ?? null,
    mimetype: f.mimetype ?? null,
    url_private: f.url_private ?? null,
  }));
  const attachments = (msg.attachments ?? []).map((a: any) =>
    a.title || a.fallback || a.text || ""
  ).filter(Boolean);
  console.log(JSON.stringify({
    id: msg.ts,
    timestamp: msg.ts,
    channel_id: CHANNEL ?? null,
    author: msg.user ? await resolveUser(msg.user) : (msg.username || authorId),
    author_id: authorId,
    content: msg.text || "",
    thread_ts: msg.thread_ts ?? null,
    ...(files.length ? { files } : {}),
    ...(attachments.length ? { attachments } : {}),
  }));
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // A missing value must not swallow the next flag (`--after --timeout 5` would set after="--timeout").
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} needs a value`);
    Deno.exit(1);
  }
  return value;
}

async function cmdRead(args: string[]) {
  const limit = Number(argValue(args, "--limit") ?? 100);
  const oldest = argValue(args, "--after") ?? argValue(args, "--oldest");
  const params: Record<string, string | number> = { channel: CHANNEL!, limit };
  if (oldest) params.oldest = oldest;
  const body = await api("conversations.history", params, "GET");
  for (const msg of [...body.messages].reverse()) {
    if (msg.subtype === "channel_join" || msg.subtype === "channel_leave") continue;
    await emit(msg);
  }
}

async function cmdThread(args: string[]) {
  if (args.length === 0) {
    console.error("usage: bridge.ts thread <parent-ts>");
    Deno.exit(1);
  }
  const body = await api("conversations.replies", { channel: CHANNEL!, ts: args[0] }, "GET");
  for (const msg of body.messages) {
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
  if (threadTs) {
    // chat.postMessage accepts a thread_ts that matches no message and quietly
    // posts to the channel instead. That turns one mistyped digit into a reply
    // delivered to the wrong place, with an ok:true response. Check first.
    try {
      await api("conversations.replies", { channel: CHANNEL!, ts: threadTs, limit: 1 }, "GET");
    } catch {
      console.error(`refusing to send: no message with ts ${threadTs} in ${CHANNEL}. ` +
        `A wrong --thread-ts would post top-level instead of in the thread.`);
      Deno.exit(1);
    }
    params.thread_ts = threadTs;
  }
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

// Slack ts values are "seconds.micro" strings of fixed width, so they order correctly as
// numbers. Compare numerically anyway, in case a caller passes a shorter form.
const tsAfter = (a: string, b: string) => Number(a) > Number(b);

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave"]);

// How many recent top-level messages to scan for threads with new replies. A reply in a
// thread whose parent is older than this is not seen.
const THREAD_SCAN_LIMIT = 200;

// Every message (top-level or thread reply) in the channel with ts > `after`, oldest first.
// conversations.history omits thread replies entirely, so each recent parent whose
// latest_reply is newer than `after` is fetched with conversations.replies. One ts cursor
// covers both, because all ts values in a channel share one ordering.
async function fetchAfter(after: string): Promise<any[]> {
  const history = await api("conversations.history", { channel: CHANNEL!, limit: THREAD_SCAN_LIMIT }, "GET");
  const found = new Map<string, any>();
  for (const msg of history.messages) {
    if (tsAfter(msg.ts, after)) found.set(msg.ts, msg);
  }
  for (const parent of history.messages) {
    if (!parent.reply_count || !parent.latest_reply || !tsAfter(parent.latest_reply, after)) continue;
    const replies = await api(
      "conversations.replies",
      { channel: CHANNEL!, ts: parent.ts, oldest: after, limit: 200 },
      "GET",
    );
    for (const reply of replies.messages) {
      if (reply.ts !== parent.ts && tsAfter(reply.ts, after)) found.set(reply.ts, reply);
    }
  }
  return [...found.values()]
    .filter((m) => !SKIP_SUBTYPES.has(m.subtype))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// Messages that should not end the wait: bots (including this bridge's own replies) unless
// --include-bots, and anyone in IGNORE_AUTHOR_IDS.
function isQuiet(msg: any, includeBots: boolean): boolean {
  const authorId = msg.user || msg.bot_id || "";
  if (IGNORE_AUTHOR_IDS.has(authorId)) return true;
  return !includeBots && (Boolean(msg.bot_id) || msg.subtype === "bot_message");
}

async function cmdLongPoll(args: string[]) {
  const after = argValue(args, "--after");
  if (!after) {
    console.error(
      "long-poll: --after <ts> is required. Use the id of the newest message you have seen " +
        "(the last line of `read`). Without it, a message that arrives before long-poll starts is lost.",
    );
    Deno.exit(1);
  }
  const timeoutRaw = argValue(args, "--timeout");
  const timeoutSec = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
    console.error("long-poll: --timeout must be a number of seconds > 0");
    Deno.exit(1);
  }
  const includeBots = args.includes("--include-bots");
  const intervalSec = Number(Deno.env.get("SLACK_POLL_INTERVAL") ?? "20");
  const deadline = timeoutSec === undefined ? Infinity : Date.now() + timeoutSec * 1000;

  // The command to run next, with every option of this run except --after. Printed on stdout,
  // not stderr, because it is an instruction to the agent.
  const next = (ts: string) =>
    [
      "long-poll",
      `--after ${ts}`,
      CHANNEL_OVERRIDE !== undefined ? `--channel ${CHANNEL_OVERRIDE}` : "",
      timeoutRaw !== undefined ? `--timeout ${timeoutRaw}` : "",
      includeBots ? "--include-bots" : "",
    ].filter(Boolean).join(" ");

  let cursor = after;
  console.error(
    `waiting for messages in channel ${CHANNEL} after ${after} (poll every ${intervalSec}s` +
      `${timeoutSec === undefined ? "" : `, timeout ${timeoutSec}s`})`,
  );

  while (true) {
    // Poll first, sleep after: messages that arrived since `read` come back at once.
    let batch: any[] = [];
    try {
      batch = await fetchAfter(cursor);
    } catch (e) {
      // Transient failure (network, rate limit): log and keep polling.
      console.error(`poll failed: ${e}`);
    }
    const found: any[] = [];
    for (const msg of batch) {
      cursor = msg.ts; // advance past quiet messages too, or we'd refetch them forever
      if (!isQuiet(msg, includeBots)) found.push(msg);
    }
    if (found.length > 0) {
      // The reminder goes both before and after the messages: harnesses cut long output at
      // different ends.
      console.log(
        ">>> NEW MESSAGES. Before you act on them, start long-poll again in the background. " +
          "The command is at the end.",
      );
      for (const msg of found) await emit(msg);
      console.log(`>>> Start this now, in the background, before anything else: ${next(cursor)}`);
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(
        `>>> No new messages after ${timeoutSec} seconds. Start this now, in the background: ${next(cursor)}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(intervalSec * 1000, remaining)));
  }
}

// Save a Slack file (the url_private of a message's files[]) so an agent can open it.
// Slack answers with an HTML login page instead of the file when the token lacks files:read.
async function cmdDownload(args: string[]) {
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: bridge.ts download <url_private> [--out DIR]");
    Deno.exit(1);
  }
  const outDir = argValue(args, "--out") ?? HERE + "downloads";
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const type = resp.headers.get("content-type") ?? "";
  if (!resp.ok || type.startsWith("text/html")) {
    console.error(`download failed: HTTP ${resp.status} ${type} (does the token have files:read?)`);
    Deno.exit(1);
  }
  // files-pri/<TEAM>-<FILE_ID>/<name>: keep the file id so two files with one name do not clash.
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const fileId = (parts.at(-2) ?? "file").split("-").at(-1);
  const name = decodeURIComponent(parts.at(-1) ?? "file").replace(/[^\w.\-]+/g, "_");
  await Deno.mkdir(outDir, { recursive: true });
  const path = `${outDir.replace(/\/$/, "")}/${fileId}-${name}`;
  await Deno.writeFile(path, new Uint8Array(await resp.arrayBuffer()));
  console.log(JSON.stringify({ path, content_type: type, bytes: Number(resp.headers.get("content-length") ?? 0) }));
}

switch (cmd) {
  case "read":
    await cmdRead(rest);
    break;
  case "send":
    await cmdSend(rest);
    break;
  case "long-poll":
    await cmdLongPoll(rest);
    break;
  case "monitor":
    console.error(
      "monitor was removed. Use long-poll instead: run `read` and keep the id of the newest " +
        "message, then run `long-poll --after <id>` as a background command. When it exits, " +
        "handle what it printed, and run the command on its last >>> line.",
    );
    Deno.exit(1);
    break;
  case "react":
    await cmdReact(rest);
    break;
  case "thread":
    await cmdThread(rest);
    break;
  case "download":
    await cmdDownload(rest);
    break;
  default:
    console.error("usage: bridge.ts <read|send|long-poll|react|thread|download> ... [--channel ID]");
    Deno.exit(1);
}
