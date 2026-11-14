# Rahavuotesi: Money Wrapped

A Spotify Wrapped-style story of the customer's last 12 months of money (Oct 2025 – Sep 2026), in Finnish.
Shown in the UI as full-screen swipeable cards: open it from the green **Rahavuotesi on valmis** card on the
home screen of `ui-demos`.

Every number is precomputed from the data: the raw transactions and the BDA spending model's outputs.
No AI is needed to show the story. Each card's **Kysy valmentajalta tästä** ("ask the coach about this")
button opens the chat with a ready-made question about that card.

## Pipeline

```bash
python wrapped/build_facts.py      # ~3 min: one pass over Data/, writes wrapped/output/facts.json (all 5,100 customers)
python -m wrapped.export_ui        # writes ui-demos/server-data/wrapped-data.json (UI demo customers + demo personas)
python -m wrapped.export_ui CUST00042   # ...plus any extra customers
python -m unittest discover -s wrapped/tests -t .
```

Stdlib Python only. `cards.py` turns facts + `BDA/output/` into cards; `build_cards(customer_id, load_sources())`
works for any of the 5,100 customers.

## The cards

Each person gets 9–12 cards in story order (intro and tip always; the rest only when they say something):

| Card | Example |
|---|---|
| Intro | "Lokakuu 2025 – syyskuu 2026 · 256 korttiostosta" |
| Year in numbers | Income, spending, saving, and what was left |
| Top 5 | Purchase categories with bars |
| Favourite | "Ravintolat: 100 kertaa, keskimäärin 47 €" (never groceries or health) |
| Regular place | Most visited merchant, by type and number (names are not in the data) |
| Your time | Busiest weekday and time of day, busiest hour |
| Small stuff adds up | Purchases under €10, count and total |
| Biggest purchase | The year's largest single purchase |
| Biggest month | Most and least expensive months |
| Days in the green | Days with a positive balance, longest streak, recoveries |
| Saver | Amount saved and in how many months |
| Vs last year | Spending change over the same 11 months a year earlier |
| Spending personality | BDA's spender type, translated, with the peer group |
| Next year's goal | BDA's safe-to-save, or how much less spending balances the budget, or a surprise fund |

Tone rules: never shame. Overdrafts are shown as progress ("palasit plussalle joka kerta", "you got back
into the green every time"), essential spending is never a "favourite", and every story ends with one
concrete, positive goal. Tests check these rules for all 5,100 customers.

## UI

`ui-demos/public/wrapped.js` and `wrapped.css`. Stories auto-advance every 7 s. Controls:
- **Navigate:** tap the right or left side, swipe, or use the arrow keys.
- **Pause:** hold the screen, or use the pause button or the space bar.
- **Close:** swipe down, press Esc or use the close button.

With reduced motion requested by the device, there is no auto-advance and no animation. The deep link
`#rahavuosi` opens the story (`#rahavuosi/3` opens card 3), e.g. from a push notification.
`server-data/wrapped-data.json` holds the source recaps. On page load, the server returns only the configured customer's recap through `/wrapped-data.json`.

Text is Finnish for now. The cards carry plain strings, so a language switch means building the cards in
another language in `cards.py`.

The source recap bundle is private. The UI server exposes `/wrapped-data.json` filtered to its configured synthetic customer and rejects customer query parameters. It never serves the multi-customer source as a static file.
