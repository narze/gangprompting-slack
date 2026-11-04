# gangprompting-slack

A small Slack bridge for [gangprompting](https://x.com/thdxr/status/2064732709579080021) — letting a team prompt a Claude Code agent together in a shared Slack channel.

Exposes `read` / `send` / `long-poll` / `react` / `thread` over Slack's `conversations.history`, `conversations.replies`, `chat.postMessage`, and `reactions.add` APIs, with one JSON object per line for message output. `long-poll` waits for the next message after a given ts, prints it, and exits, so an agent can run it as a background command. It also checks `conversations.replies` for recent threads, since `conversations.history` alone omits thread replies entirely.

## Setup

1. Create an internal Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Request bot scopes: `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `reactions:write`. Optional: `files:read` for `download`, `files:write` for `upload`, and `assistant:write` for `status` (Slack adds it when you declare the app an agent).
3. Install to your workspace, copy the bot token (`xoxb-…`), invite the bot to your channel.
4. Create a `.env` next to `bridge.ts`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_CHANNEL=C0123456789
   ```

## Usage

```
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts read [--limit N] [--after TS]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts send "<text>" [--thread-ts TS]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts long-poll --after TS [--timeout SECONDS] [--include-bots]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts react <ts> <emoji-name>
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts thread <parent-ts>
mise exec -- deno run --allow-net --allow-env --allow-read --allow-write bridge.ts download <url_private> [--out DIR]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts unreact <ts> <emoji-name>
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts done <ts>
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts edit <ts> "<text>"
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts upload <file> [--thread-ts TS] [--title T] [--comment TEXT]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts status --thread-ts TS "<text>"
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts stream-start --thread-ts TS --recipient USER [chunk flags]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts stream-append <ts> [chunk flags]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts stream-stop <ts> [chunk flags]
```

Every command also takes `--channel ID` to override `SLACK_CHANNEL` for one call. A flag with no value (for example `--after --timeout 5`) is an error, not a silent mix-up.

`download` saves a file that someone attached to a message (the `url_private` in the message's `files`) to `downloads/` (or `--out DIR`) and prints `{path, content_type, bytes}`. It needs `--allow-write` and the `files:read` scope; without the scope Slack returns a login page, and `download` reports the failure.

`long-poll` prints plain-text lines starting with `>>>` around the messages. The last one gives the exact `long-poll` command to run next. Bot messages (including the bridge's own replies) do not end the wait unless `--include-bots` is passed. Thread replies are found only in threads whose parent is among the 200 newest top-level messages. Set `SLACK_POLL_INTERVAL` (seconds, default 20) to change how often it polls.

Set `IGNORE_AUTHOR_IDS` (comma-separated Slack user/bot IDs) to skip messages from those authors — useful for excluding the bot's own messages or other bots sharing the channel.

## Status, edits and files

- `done <ts>` swaps the `:eyes:` reaction for `:white_check_mark:`, so a thread shows at a glance which requests are finished. `unreact` removes any one reaction.
- `edit <ts> "<text>"` replaces the text of a message the bot posted (`chat.update`, about 50 a minute).
- `upload <file>` posts a local file to the channel, or to a thread with `--thread-ts` (`files.getUploadURLExternal` + `files.completeUploadExternal`, needs `files:write`).
- `status --thread-ts TS "<text>"` sets the "<app> is …" line under a thread (`assistant.threads.setStatus`, needs `assistant:write`). An empty text clears it, and so does the bot's next reply.

## Streaming replies

`stream-start`, `stream-append` and `stream-stop` wrap `chat.startStream` / `chat.appendStream` / `chat.stopStream` (only `chat:write`). The reply appears in the thread while the agent works, with a timeline of tasks, then the final answer.

```
ts=$(bridge.ts stream-start --thread-ts 1700000000.000100 --recipient U0123 --task "Read the code" | jq -r .ts)
bridge.ts stream-append "$ts" --done "Read the code" --task "Run the tests"
bridge.ts stream-stop "$ts" --done "Run the tests" --text "All 42 tests pass. PR: https://..."
```

Chunk flags, applied in the order given: `--task TITLE` (in progress), `--done TITLE` (complete; the id comes from the title, so it matches the earlier `--task`), `--text MD`, `--text-file FILE`, `--chunks JSON` (raw chunks). Every call sends chunks, because Slack refuses to mix `markdown_text` and chunks in one stream.

Limits: in a normal channel the stream must be a thread reply and needs `--recipient` (the team id comes from `--team`, `SLACK_TEAM_ID` or `auth.test`). A stream lives at most 10 minutes from `stream-start`, then Slack closes it; post the rest with `send`. 12,000 characters and 50 tasks per stream. The Stop button Slack shows next to a stream only works when the app subscribes to the `agent_session_stopped` event, which needs Events API or Socket Mode; this bridge only polls, so the button stays disabled.
