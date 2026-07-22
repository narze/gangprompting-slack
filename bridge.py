#!/usr/bin/env python3
"""Slack gangprompting bridge: read / send / monitor over conversations.history + chat.postMessage.

Env: SLACK_BOT_TOKEN, SLACK_CHANNEL (defaults from .env next to this script)
Usage:
  bridge.py read [--limit N] [--oldest TS]
  bridge.py send <text> [--thread-ts TS]
  bridge.py monitor [--interval SECONDS]
Each read/monitor line is one JSON object: {id, timestamp, author, author_id, content, thread_ts}
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    env_path = os.path.join(HERE, ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)


load_env()
TOKEN = os.environ["SLACK_BOT_TOKEN"]
CHANNEL = os.environ.get("SLACK_CHANNEL")

_user_cache = {}


def api(method, params, http_method="POST"):
    url = f"https://slack.com/api/{method}"
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if http_method == "POST":
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(url, data=data, headers=headers)
    else:
        req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers=headers)
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read())
    if not body.get("ok"):
        raise RuntimeError(f"{method} failed: {body}")
    return body


def resolve_user(user_id):
    if not user_id:
        return "unknown"
    if user_id in _user_cache:
        return _user_cache[user_id]
    try:
        info = api("users.info", {"user": user_id}, "GET")["user"]
        name = info.get("real_name") or info.get("name") or user_id
    except Exception:
        name = user_id
    _user_cache[user_id] = name
    return name


IGNORE_AUTHOR_IDS = set(a for a in os.environ.get("IGNORE_AUTHOR_IDS", "").split(",") if a)


def emit(msg):
    author_id = msg.get("user") or msg.get("bot_id") or ""
    if author_id in IGNORE_AUTHOR_IDS:
        return
    print(json.dumps({
        "id": msg["ts"],
        "timestamp": msg["ts"],
        "author": resolve_user(msg.get("user")) if msg.get("user") else msg.get("username", author_id),
        "author_id": author_id,
        "content": msg.get("text", ""),
        "thread_ts": msg.get("thread_ts"),
    }))
    sys.stdout.flush()


def cmd_read(args):
    limit = 100
    oldest = None
    i = 0
    while i < len(args):
        if args[i] == "--limit":
            limit = int(args[i + 1]); i += 2
        elif args[i] == "--oldest":
            oldest = args[i + 1]; i += 2
        else:
            i += 1
    params = {"channel": CHANNEL, "limit": limit}
    if oldest:
        params["oldest"] = oldest
    body = api("conversations.history", params, "GET")
    for msg in reversed(body["messages"]):
        if msg.get("subtype") in ("channel_join", "channel_leave"):
            continue
        emit(msg)


def cmd_send(args):
    if not args:
        print("usage: bridge.py send <text> [--thread-ts TS]", file=sys.stderr)
        sys.exit(1)
    text = args[0]
    thread_ts = None
    if "--thread-ts" in args:
        thread_ts = args[args.index("--thread-ts") + 1]
    params = {"channel": CHANNEL, "text": text}
    if thread_ts:
        params["thread_ts"] = thread_ts
    body = api("chat.postMessage", params)
    print(json.dumps({"ok": True, "ts": body["ts"], "channel": body["channel"]}))


def cmd_react(args):
    if len(args) < 2:
        print("usage: bridge.py react <ts> <emoji-name>", file=sys.stderr)
        sys.exit(1)
    ts, name = args[0], args[1]
    api("reactions.add", {"channel": CHANNEL, "timestamp": ts, "name": name})
    print(json.dumps({"ok": True, "ts": ts, "name": name}))


def poll_threads(history_msgs, thread_seen):
    """conversations.history omits thread replies entirely — each active thread
    must be polled separately via conversations.replies, or replies are silently lost."""
    for parent in history_msgs:
        reply_count = parent.get("reply_count") or 0
        if reply_count == 0:
            continue
        parent_ts = parent["ts"]
        latest_reply = parent.get("latest_reply", parent_ts)
        seen = thread_seen.get(parent_ts, parent_ts)
        if latest_reply <= seen:
            continue
        replies = api("conversations.replies", {"channel": CHANNEL, "ts": parent_ts}, "GET")["messages"]
        for reply in replies:
            if reply["ts"] == parent_ts or reply["ts"] <= seen:
                continue
            if reply.get("subtype") in ("channel_join", "channel_leave"):
                continue
            emit(reply)
        thread_seen[parent_ts] = latest_reply


def cmd_monitor(args):
    interval = 20
    if "--interval" in args:
        interval = int(args[args.index("--interval") + 1])
    body0 = api("conversations.history", {"channel": CHANNEL, "limit": 50}, "GET")
    last_ts = body0["messages"][0]["ts"] if body0["messages"] else str(time.time())
    thread_seen = {m["ts"]: m.get("latest_reply", m["ts"]) for m in body0["messages"] if m.get("reply_count")}
    while True:
        time.sleep(interval)
        body = api("conversations.history", {"channel": CHANNEL, "limit": 50}, "GET")
        msgs = [m for m in body["messages"] if m.get("subtype") not in ("channel_join", "channel_leave")]
        new_top_level = [m for m in msgs if m["ts"] > last_ts]
        for msg in reversed(new_top_level):
            emit(msg)
        poll_threads(msgs, thread_seen)
        if body["messages"]:
            last_ts = max(last_ts, body["messages"][0]["ts"])


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == "read":
        cmd_read(rest)
    elif cmd == "send":
        cmd_send(rest)
    elif cmd == "monitor":
        cmd_monitor(rest)
    elif cmd == "react":
        cmd_react(rest)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
