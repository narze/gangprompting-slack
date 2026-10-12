# gangprompting-slack

A small Slack bridge for [gangprompting](https://x.com/thdxr/status/2064732709579080021) — letting a team prompt a Claude Code agent together in a shared Slack channel.

Exposes `read` / `send` / `long-poll` / `react` / `thread` over Slack's `conversations.history`, `conversations.replies`, `chat.postMessage`, and `reactions.add` APIs, with one JSON object per line for message output. `long-poll` waits for the next message after a given ts, prints it, and exits, so an agent can run it as a background command. It also checks `conversations.replies` for recent threads, since `conversations.history` alone omits thread replies entirely.

## Setup

1. Create an internal Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Request bot scopes: `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `users:read`, `reactions:write`.
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
```

Every command also takes `--channel ID` to override `SLACK_CHANNEL` for one call.

`long-poll` prints plain-text lines starting with `>>>` around the messages. The last one gives the exact `long-poll` command to run next. Bot messages (including the bridge's own replies) do not end the wait unless `--include-bots` is passed. Thread replies are found only in threads whose parent is among the 200 newest top-level messages. Set `SLACK_POLL_INTERVAL` (seconds, default 20) to change how often it polls.

Set `IGNORE_AUTHOR_IDS` (comma-separated Slack user/bot IDs) to skip messages from those authors — useful for excluding the bot's own messages or other bots sharing the channel.
