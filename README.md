# gangprompting-slack

A small Slack bridge for [gangprompting](https://x.com/thdxr/status/2064732709579080021) — letting a team prompt a Claude Code agent together in a shared Slack channel.

Exposes `read` / `send` / `monitor` / `react` over Slack's `conversations.history`, `chat.postMessage`, and `reactions.add` APIs, with one JSON object per line for `read`/`monitor` output. `monitor` also polls `conversations.replies` per active thread, since `conversations.history` alone omits thread replies entirely.

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
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts read [--limit N] [--oldest TS]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts send "<text>" [--thread-ts TS]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts monitor [--interval SECONDS]
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts react <ts> <emoji-name>
```

Set `IGNORE_AUTHOR_IDS` (comma-separated Slack user/bot IDs) to skip messages from those authors — useful for excluding the bot's own messages or other bots sharing the channel.

`bridge.py` is an earlier Python-stdlib-only implementation of the same interface, kept for reference.
