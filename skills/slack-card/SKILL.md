---
name: slack-card
description: Post a Slack card (Block Kit message with fields, a native table, charts, link buttons) through the gangprompting Slack bridge, built from a json-render JSON spec. Use when a Slack reply carries structure (a status across several items, rows of data, numbers to compare or a trend), or when someone asks for a card, table or chart in Slack.
---

A **card** is one Slack message built from a JSON spec. `bridge.ts card` validates the spec with `@json-render/chat`, turns it into Block Kit (a real `data_table` for tables, `data_visualization` for charts), and posts it as the bot.

## When a card earns its place

Reach for a card when the answer has a shape: several items that each have a status, rows a reader scans, numbers they compare, a trend over time, or links they will click. A conversational answer, a short reply or a code snippet stays plain text (`send` or a stream).

With a streamed reply, finish the stream with the one-line answer, then post the card in the same thread with `--thread-ts`.

## Post a card

Run from the bridge checkout (the directory holding `bridge.ts`, two levels above this skill):

```
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts card --spec-file card.json --thread-ts <thread ts> --channel <id> --dry-run
mise exec -- deno run --allow-net --allow-env --allow-read bridge.ts card --spec-file card.json --thread-ts <thread ts> --channel <id>
```

1. Write the spec to a file. `--spec '<json>'` and `--spec-file -` (stdin) work too.
2. Dry-run it. The result is `{text, blocks}`, and nothing is posted. If the spec is invalid, the command exits 1 and lists one issue per line on stderr. Fix every issue and dry-run again until it exits 0 with no `warning:` lines on stderr.
3. Post it without `--dry-run`. The output is `{ok, ts, channel}`. Keep `ts` if you will refer to the card later.

## Spec format

```json
{
  "root": "card",
  "elements": {
    "card": { "type": "Card", "props": { "title": "Release 3.2.1" }, "children": ["kpis", "note"] },
    "kpis": { "type": "Fields", "props": {}, "children": ["ios"] },
    "ios": { "type": "Field", "props": { "label": "iOS", "value": "Approved" }, "children": [] },
    "note": { "type": "Text", "props": { "content": "Checked 10 minutes ago", "style": "muted" }, "children": [] }
  }
}
```

- `elements` is a flat map of id to element. Every element has `type`, `props` and `children` (an array of ids, `[]` for a leaf).
- `root` names the `Card`. Nesting happens only through `children`: every element must be listed in some parent's `children`, or it is not shown (the command warns).
- Children render in the order listed.

Working examples, each passing a dry-run: [`examples/status.json`](examples/status.json) (fields, table, link button), [`examples/metrics.json`](examples/metrics.json) (line and pie charts), [`examples/layout.json`](examples/layout.json) (header image, section, bar and area charts, image).

## Components

| Type | Props | Children | Renders as |
|---|---|---|---|
| `Card` | `title?`, `subtitle?`, `imageUrl?` | any | header, context line, image; the root only |
| `Section` | none | any | groups its children |
| `Text` | `content`, `style?` = `plain` \| `bold` \| `muted` | none | section (`muted` is a small grey context line) |
| `Fields` | none | `Field`s | two-column section |
| `Field` | `label`, `value` (string or number) | none | bold label over value |
| `Table` | `headers: string[]`, `rows: (string\|number)[][]`, `align?: ("left"\|"center"\|"right")[]`, `caption?` | none | native `data_table` |
| `Chart` | `title`, `chart` (below) | none | native `data_visualization` |
| `Divider` | none | none | divider |
| `Image` | `url`, `alt` | none | image block (public URL) |
| `Actions` | none | `LinkButton`s | button row |
| `LinkButton` | `label`, `url` | none | button that opens the URL |

`chart` is one of:

- `{ "type": "pie", "segments": [{ "label": "iOS", "value": 46 }] }`
- `{ "type": "bar" | "line" | "area", "categories": ["Mon", "Tue"], "series": [{ "name": "orders", "values": [12, 18] }], "xLabel"?: "Day", "yLabel"?: "Orders" }`, with one value per category in each series.

Category and series names must be unique and non-empty, and pie values above 0. A chart or table Slack would refuse makes the command exit 1, so it never arrives as a code block.

Text and Field values are Slack mrkdwn: `*bold*` (`**bold**` is converted), `_italic_`, `` `code` ``, `<https://url|label>` for links, `<@U123>` for mentions, `:emoji:`. Markdown `[label](url)` links show up as literal text. Field labels are bolded already, so write them plain.

## Limits

- **Buttons: LinkButton only.** The schema also has `Button`, and it renders, but a click goes nowhere: the bridge polls and has no interactivity endpoint. The command warns when a spec contains one.
- One `Table` per message, at most 100 rows including the header, 20 columns, 10,000 characters of cell text.
- At most 2 `Chart`s per message. Chart titles up to 50 characters, labels (categories, series names, segment labels) up to 20, up to 12 series or segments, up to 20 categories.
- Up to 10 `Field`s in one `Fields`.
- Slack caps a message at 50 blocks. A Card title, subtitle and image take one block each; most components take one. Past 50 the command refuses: split the content across several cards.

More data than this fits elsewhere: summarise it in the card and attach the full set as a file, or link to it.
