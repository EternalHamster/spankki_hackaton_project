# Customer profile card

A short, fixed-format summary of one customer that goes into the chat model's context, so overview
questions ("what kind of spender am I?", "what's safe to spend this week?", "where does my money go?")
can be answered **without tool calls**. Fewer model rounds make answers faster, cheaper and more consistent.
Tools are still needed for specific periods, lines, transactions and calculations.

**Not connected to any backend yet.** It's a standalone module with no backend dependency.

## Use

```python
from coach_context import build_profile_card, render_profile_card

card = build_profile_card("CUST04971")   # structured dict (JSON-safe), e.g. for the UI or tests
text = render_profile_card(card)         # plain text for the prompt
```

```bash
python -m coach_context CUST04971          # print the card text
python -m coach_context CUST04971 --json   # print the structured card
python -m coach_context --sizes            # token sizes over all 5,100 customers
python -m unittest discover -s coach_context/tests -t .
```

Python 3.10+ and standard library only. Loading the data takes about a second, so create one `CardSource()` at
startup and pass it to `build_profile_card(cid, source)` in a server. `KeyError` = unknown customer.

## What's in the card

Age and area (peer group), income, next payday and how often salary comes late, current balance, the three
baskets with shares, saving, actual totals for the last 12 months (including overspending), safe-to-spend this
week, safe-to-save per month, surprise-fund target and how far the balance is from it, spender type, every
spending line vs the peer median (essential lines marked "do not nag"), and up to six of the spending model's
ranked insight messages. The customer ID is never included.

Safe-to-spend and safe-to-save are rounded **down**, like BDA does, because they are promises.

Size: **about 500–860 tokens** (median ~650, estimated at 4 characters per token). The text is
deterministic: the same data always gives byte-identical output.

## Connecting it to a backend (later)

Put the card **after** the part of the prompt that's identical for every customer, so prompt caching works:

1. Tool definitions and the system prompt: the same for everyone. Put the cache breakpoint at the end of this.
2. The profile card: per customer, after the breakpoint.
3. The conversation.

With the Anthropic Messages API that means two system blocks, roughly:

```python
system=[
    {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},  # shared, cached
    {"type": "text", "text": render_profile_card(card)},                              # per customer
]
```

Also set top-level automatic caching on the request (`cache_control={"type": "ephemeral"}` next to
`model`/`messages`). The explicit marker caches the shared part for every customer; the automatic one caches
the growing tail (card, question, earlier tool rounds), so in the tool loop each round re-reads everything the
previous round sent instead of paying for it again.

The model does not remember anything between rounds: the backend resends system prompt, card and history on
every round. Build the card **once per question** (or once per session, if the backend keeps conversations)
and reuse the exact same text; any byte difference between rounds breaks the cache.

Check `usage.cache_read_input_tokens` on the second request: if it stays 0, something before the breakpoint
changes between requests (for example a timestamp in the system prompt). The cached prefix must be at least
512 tokens on Claude Haiku 5.5, otherwise it silently isn't cached.

Tell the model in the system prompt that the card exists, that its monthly figures are smoothed estimates, and
that specific periods need tools. The card itself says this in its first lines.

## Data it depends on

Only the spending model's committed outputs in `BDA/output/`: `customer_summary.csv`, `customer_line.csv`,
`insights.csv` and `spender_type.csv`, plus line labels and peer thresholds from `BDA/engine/config.py`.
When BDA is re-run, the cards update automatically. If BDA renames columns, the tests fail and point at it.
"As of" is the end of the data (2026-09-30), matching the coach's fixed "today".

## Insight context (`insight_context.py`)

A longer context for one job: letting the model write three explained key insights (backend `POST /v1/insights`).
It is the profile card plus, for every spending line, how often and how much per payment (customer and peer
median), the Finnish average, last month against the usual month, how safe-to-spend was limited, and the peer
group's model parameters. About 2,300 tokens, deterministic, standard library only.

```python
from coach_context.insight_context import InsightSource, build_insight_context, render_insight_context
src = InsightSource()                                        # once, at startup
text = render_insight_context(build_insight_context('CUST04971', src))
```

```bash
python -m coach_context.insight_context CUST04971          # print the context text
```

It contains the customer's own rows and group-level numbers only: no customer ID and no other customer's data.
Peer groups with fewer than 10 people are not described. `tests/test_insight_context.py` checks this by
changing every other customer's data and verifying the context stays byte-identical.
