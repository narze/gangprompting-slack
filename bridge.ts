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
//   bridge.ts unreact <ts> <emoji-name>
//   bridge.ts done <ts>   (swap :eyes: for :white_check_mark:)
//   bridge.ts upload <file> [--thread-ts TS] [--title T] [--comment TEXT]   (files:write)
//   bridge.ts status --thread-ts TS "<text>"   (assistant:write; empty text clears it)
//   bridge.ts edit <ts> "<text>"   (chat.update; only this bot's own messages)
//   bridge.ts stream-start --thread-ts TS --recipient USER [--team TEAM] [--task T] [--done T] [--text MD] [--text-file F] [--chunks JSON]
//   bridge.ts stream-append <ts> [same chunk flags]
//   bridge.ts stream-stop <ts> [same chunk flags]
//   bridge.ts card (--spec-file F | --spec JSON) [--thread-ts TS] [--dry-run]   (json-render spec -> Block Kit message)
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
    await checkThread(threadTs);
    params.thread_ts = threadTs;
  }
  const body = await api("chat.postMessage", params);
  console.log(JSON.stringify({ ok: true, ts: body.ts, channel: body.channel }));
}

// chat.postMessage accepts a thread_ts that matches no message and quietly
// posts to the channel instead. That turns one mistyped digit into a reply
// delivered to the wrong place, with an ok:true response. Check first.
async function checkThread(threadTs: string) {
  try {
    await api("conversations.replies", { channel: CHANNEL!, ts: threadTs, limit: 1 }, "GET");
  } catch {
    console.error(`refusing to send: no message with ts ${threadTs} in ${CHANNEL}. ` +
      `A wrong --thread-ts would post top-level instead of in the thread.`);
    Deno.exit(1);
  }
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

async function cmdUnreact(args: string[]) {
  if (args.length < 2) {
    console.error("usage: bridge.ts unreact <ts> <emoji-name>");
    Deno.exit(1);
  }
  const [ts, name] = args;
  try {
    await api("reactions.remove", { channel: CHANNEL!, timestamp: ts, name });
  } catch (e) {
    if (!String(e).includes("no_reaction")) throw e; // already gone is fine
  }
  console.log(JSON.stringify({ ok: true, ts, removed: name }));
}

// Mark a message as handled: the :eyes: added when work started becomes :white_check_mark:.
async function cmdDone(args: string[]) {
  const ts = args[0];
  if (!ts) {
    console.error("usage: bridge.ts done <ts>");
    Deno.exit(1);
  }
  await cmdUnreact([ts, "eyes"]);
  try {
    await api("reactions.add", { channel: CHANNEL!, timestamp: ts, name: "white_check_mark" });
  } catch (e) {
    if (!String(e).includes("already_reacted")) throw e;
  }
  console.log(JSON.stringify({ ok: true, ts, name: "white_check_mark" }));
}

// Upload a local file into the channel (or a thread): getUploadURLExternal, POST the
// bytes, then completeUploadExternal to share it. Needs the files:write scope.
async function cmdUpload(args: string[]) {
  const path = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!path) {
    console.error("usage: bridge.ts upload <file> [--thread-ts TS] [--title T] [--comment TEXT]");
    Deno.exit(1);
  }
  const bytes = await Deno.readFile(path);
  const filename = path.split("/").pop()!;
  const { upload_url, file_id } = await api("files.getUploadURLExternal", { filename, length: bytes.length });
  const up = await fetch(upload_url, { method: "POST", body: bytes });
  if (!up.ok) throw new Error(`upload failed: HTTP ${up.status}`);
  const params: Record<string, string> = {
    files: JSON.stringify([{ id: file_id, title: argValue(args, "--title") ?? filename }]),
    channel_id: CHANNEL!,
  };
  const threadTs = argValue(args, "--thread-ts");
  const comment = argValue(args, "--comment");
  if (threadTs) params.thread_ts = threadTs;
  if (comment) params.initial_comment = comment;
  const r = await api("files.completeUploadExternal", params);
  console.log(JSON.stringify({ ok: true, file_id, permalink: r.files?.[0]?.permalink }));
}

// The "<app> is ..." status line under a thread (assistant.threads.setStatus). Needs
// assistant:write, which Slack adds when the app is declared an agent. "" clears it;
// posting a reply also clears it.
async function cmdStatus(args: string[]) {
  const threadTs = argValue(args, "--thread-ts");
  const text = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--thread-ts"));
  if (!threadTs || text === undefined) {
    console.error('usage: bridge.ts status --thread-ts TS "<text>"');
    Deno.exit(1);
  }
  await api("assistant.threads.setStatus", { channel_id: CHANNEL!, thread_ts: threadTs, status: text });
  console.log(JSON.stringify({ ok: true, thread_ts: threadTs, status: text }));
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

// Replace the text of a message this bot posted (chat.update, chat:write).
// Slack rate-limits chat.update at Tier 3 (about 50 a minute).
async function cmdEdit(args: string[]) {
  const [ts, text] = args.filter((a) => !a.startsWith("--"));
  if (!ts || text === undefined) {
    console.error('usage: bridge.ts edit <ts> "<text>"');
    Deno.exit(1);
  }
  const r = await api("chat.update", { channel: CHANNEL!, ts, text });
  console.log(JSON.stringify({ ok: true, ts: r.ts }));
}

// Streaming replies (chat.startStream / appendStream / stopStream, chat:write only).
// In an ordinary channel a stream must be a thread reply and name its recipient.
// A stream lives at most 10 minutes; 12,000 characters of text and 50 tasks in total.
// Every call sends chunks (Slack refuses to mix markdown_text and chunks in one stream),
// built from these flags in the order given:
//   --task TITLE   a task shown as in progress
//   --done TITLE   the same task, now complete
//   --text MD      markdown text appended to the reply
//   --text-file F  markdown text read from a file (for long answers)
//   --chunks JSON  raw chunks, for anything else
// A task's id is derived from its title, so --done "X" completes the --task "X" from an
// earlier call.
const taskId = (title: string) => "t_" + [...title].reduce((h, c) => (h * 31 + c.codePointAt(0)!) >>> 0, 7).toString(36);

async function streamBody(args: string[]): Promise<Record<string, string>> {
  const chunks: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--task", "--done", "--text", "--text-file", "--chunks"].includes(flag)) continue;
    if (value === undefined) {
      console.error(`${flag} needs a value`);
      Deno.exit(1);
    }
    i++;
    if (flag === "--task") chunks.push({ type: "task_update", id: taskId(value), title: value, status: "in_progress" });
    if (flag === "--done") chunks.push({ type: "task_update", id: taskId(value), title: value, status: "complete" });
    if (flag === "--text") chunks.push({ type: "markdown_text", text: value });
    if (flag === "--text-file") chunks.push({ type: "markdown_text", text: await Deno.readTextFile(value) });
    if (flag === "--chunks") chunks.push(...JSON.parse(value));
  }
  return chunks.length > 0 ? { chunks: JSON.stringify(chunks) } : {};
}

async function cmdStreamStart(args: string[]) {
  const threadTs = argValue(args, "--thread-ts");
  const recipient = argValue(args, "--recipient");
  if (!threadTs || !recipient) {
    console.error("usage: bridge.ts stream-start --thread-ts TS --recipient USER [--team TEAM] [--task T] [--done T] [--text MD] [--text-file F] [--chunks JSON]");
    Deno.exit(1);
  }
  const team = argValue(args, "--team") ?? Deno.env.get("SLACK_TEAM_ID") ?? (await api("auth.test", {})).team_id;
  const r = await api("chat.startStream", {
    channel: CHANNEL!,
    thread_ts: threadTs,
    recipient_user_id: recipient,
    recipient_team_id: team,
    ...(await streamBody(args)),
  });
  console.log(JSON.stringify({ ok: true, ts: r.ts, channel: r.channel }));
}

async function cmdStreamAppend(args: string[], method: "chat.appendStream" | "chat.stopStream") {
  const ts = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!ts) {
    console.error(`usage: bridge.ts ${method === "chat.appendStream" ? "stream-append" : "stream-stop"} <ts> [--task T] [--done T] [--text MD] [--text-file F] [--chunks JSON]`);
    Deno.exit(1);
  }
  const r = await api(method, { channel: CHANNEL!, ts, ...(await streamBody(args)) });
  console.log(JSON.stringify({ ok: true, ts: r.ts ?? ts }));
}

// Post a json-render spec (skills/slack-card/SKILL.md) as a Block Kit message.
// @json-render/chat validates the spec and turns it into a Chat SDK card; the Slack
// adapter's block builder turns the card into blocks plus fallback text for notifications.
// The libraries load only for this command, so the others keep their permissions and speed.
// Limits mirror what the block builder would otherwise degrade silently (a second table
// becomes a code block, a third chart is dropped), so toCard rejects the spec instead.
const CARD_LIMITS = {
  tables: 1,
  charts: 2, // undocumented: Slack rejects a message with more than 2 data_visualization blocks
  fields: 10,
  tableRows: 100, // including the header row
  tableColumns: 20,
  chartLabel: 20,
  chartTitle: 50,
  chartSeries: 12,
  chartPoints: 20,
};
const MAX_BLOCKS = 50;

async function cmdCard(args: string[]) {
  const specFile = argValue(args, "--spec-file");
  const specInline = argValue(args, "--spec");
  const threadTs = argValue(args, "--thread-ts");
  const dryRun = args.includes("--dry-run");
  if ((specFile === undefined) === (specInline === undefined)) {
    console.error("usage: bridge.ts card (--spec-file F | --spec JSON) [--thread-ts TS] [--dry-run]   (--spec-file - reads stdin)");
    Deno.exit(1);
  }
  const raw = specInline ??
    (specFile === "-" ? await new Response(Deno.stdin.readable).text() : await Deno.readTextFile(specFile!));
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    console.error(`card: spec is not valid JSON: ${(e as Error).message}`);
    Deno.exit(1);
  }

  const { toCard, CardSpecError } = await import("npm:@json-render/chat@0.22.0");
  const { cardToSlackBlocks, cardToSlackFallbackText } = await import("npm:@chat-adapter/slack@4.44.0/blocks");
  let card;
  try {
    card = toCard(spec, { limits: CARD_LIMITS });
  } catch (e) {
    if (!(e instanceof CardSpecError)) throw e;
    console.error(`card: invalid spec, ${e.issues.length} issue(s). Fix them and run again:`);
    for (const issue of e.issues) console.error(`- ${issue}`);
    Deno.exit(1);
  }
  // deno-lint-ignore no-explicit-any
  const slackCard = card as any; // chat's CardElement and the adapter's SlackCardElement are the same shape
  // The builder cuts the list at 50 blocks without a word; count first so nothing goes missing.
  const blocks = cardToSlackBlocks(slackCard, { maxBlocks: Infinity });
  if (blocks.length > MAX_BLOCKS) {
    console.error(`card: the spec makes ${blocks.length} blocks; Slack allows ${MAX_BLOCKS} per message. Split it into several cards.`);
    Deno.exit(1);
  }
  const elements: Record<string, { type?: string; children?: string[] }> = spec.elements;
  if (Object.values(elements).some((el) => el?.type === "Button")) {
    console.error("card: warning: Button clicks go nowhere (this bridge has no interactivity endpoint). Use LinkButton.");
  }
  // toCard drops elements that no parent lists in its children, without a word.
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const child of elements[id]?.children ?? []) walk(child);
  };
  walk(spec.root);
  const orphans = Object.keys(elements).filter((id) => !reached.has(id));
  if (orphans.length > 0) {
    console.error(`card: warning: not in any children list, so not shown: ${orphans.join(", ")}`);
  }
  // Past toCard's checks, the block builder still turns a table or chart Slack would refuse
  // into a code block (pie value <= 0, duplicate category or series names, a series whose
  // value count differs from its categories, table text over 10,000 characters). Refuse instead.
  // Elements with `visible` or `repeat` can render zero or many times, so they stay out of the count.
  const shown = [...reached].map((id) => elements[id])
    .filter((el) => el && !("visible" in el) && !("repeat" in el))
    .map((el) => el.type);
  const count = (pred: (type?: string) => boolean, list: (string | undefined)[]) => list.filter(pred).length;
  const blockTypes = blocks.map((b) => (b as { type: string }).type);
  const fellBack = [
    count((t) => t === "Table", shown) > count((t) => t === "data_table" || t === "table", blockTypes) ? "Table" : "",
    count((t) => t === "Chart", shown) > count((t) => t === "data_visualization", blockTypes) ? "Chart" : "",
  ].filter(Boolean);
  if (fellBack.length > 0) {
    console.error(
      `card: Slack cannot render a ${fellBack.join(" or ")} natively, so it would arrive as a code block. ` +
        "Check: pie values > 0; categories and series names unique and non-empty; each series has one value per category; table cell text under 10,000 characters.",
    );
    Deno.exit(1);
  }
  const text = cardToSlackFallbackText(slackCard);
  if (dryRun) {
    console.log(JSON.stringify({ text, blocks }, null, 2));
    return;
  }
  const params: Record<string, string> = { channel: CHANNEL!, text, blocks: JSON.stringify(blocks) };
  if (threadTs) {
    await checkThread(threadTs);
    params.thread_ts = threadTs;
  }
  const body = await api("chat.postMessage", params);
  const warnings = body.response_metadata?.warnings;
  console.log(JSON.stringify({ ok: true, ts: body.ts, channel: body.channel, ...(warnings ? { warnings } : {}) }));
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
  case "unreact":
    await cmdUnreact(rest);
    break;
  case "done":
    await cmdDone(rest);
    break;
  case "upload":
    await cmdUpload(rest);
    break;
  case "status":
    await cmdStatus(rest);
    break;
  case "edit":
    await cmdEdit(rest);
    break;
  case "stream-start":
    await cmdStreamStart(rest);
    break;
  case "stream-append":
    await cmdStreamAppend(rest, "chat.appendStream");
    break;
  case "stream-stop":
    await cmdStreamAppend(rest, "chat.stopStream");
    break;
  case "card":
    await cmdCard(rest);
    break;
  default:
    console.error("usage: bridge.ts <read|send|long-poll|react|thread|download|unreact|done|upload|status|edit|stream-start|stream-append|stream-stop|card> ... [--channel ID]");
    Deno.exit(1);
}
