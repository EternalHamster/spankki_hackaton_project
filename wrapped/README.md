# Rahavuotesi: Money Wrapped

A Spotify Wrapped-style story of the customer's last 12 months of money (Oct 2025 – Sep 2026), in Finnish.
Shown in the UI as full-screen swipeable cards: open it from the green **Rahavuotesi on valmis** card on the
home screen of `ui-demos`.

The latest story has a **Mikä muuttui** card with the drastic changes since the previous year. Its
**Katso edellinen rahavuotesi** button opens a second story for the year before (Oct 2024 – Sep 2025), which
ends with a button back to the comparison card. That button is the only way in: a customer with no drastic
changes has no comparison card and so no route to the older story.

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

Each person gets 9–13 cards in story order (intro and tip always; the rest only when they say something):

| Card | Example |
|---|---|
| Intro | "Lokakuu 2025 – syyskuu 2026 · 256 korttiostosta" |
| Year in numbers | Income, spending, saving, and what was left |
| You and your peer group | Annual spending, purchase count and average purchase side by side with the same age-and-area group's averages |
| Top 5 | Purchase categories with bars |
| Favourite | "Ravintolat: 100 kertaa, keskimäärin 47 €", plus the group's average annual spending in that category (never groceries or health) |
| Regular place | Most visited merchant, by type and number (names are not in the data) |
| Your time | Busiest weekday and time of day, busiest hour |
| Small stuff adds up | Purchases under €10, count and total, compared with the group's annual total |
| Biggest purchase | The year's largest single purchase |
| Biggest month | Most and least expensive months |
| Days in the green | Days with a positive balance, longest streak, recoveries |
| Saver | Amount saved and in how many months, with the group's average net transfers into savings |
| What changed | Up to 4 drastic changes since the previous year, biggest first. Income, spending or saving must move by 20 % and €300, a purchase category by 50 % and €500, the number of purchases by 20 %; days in the green are listed only when up by 10 points. No card when nothing changed that much |
| Spending personality | BDA's spender type, translated, with the peer group |
| Next year's goal | BDA's safe-to-save, or how much less spending balances the budget, or a surprise fund |

The previous-year story (`build_cards(customer_id, src, year='previous')`) uses the same cards for
Oct 2024 – Sep 2025. It leaves out three things: the spending personality and the goal,
because BDA's outputs describe the customer today; the changes card, which belongs to the latest story; and
the "ask the coach" buttons on the cards, because the coach's ready-made questions are about the latest year.
The data starts in October 2024 (97 % of accounts by 4 Oct,
all by 23 Oct), so the previous year can be a few days short of a full year.

Tone rules: never shame. Overdrafts are shown as progress ("palasit plussalle joka kerta", "you got back
into the green every time"), essential spending is never a "favourite", and every story ends with one
concrete, positive goal. Tests check these rules for all 5,100 customers.

Peer comparisons are calculated locally by `peers.py` from each recap year's recorded facts. The peer group
is the existing BDA age-band-and-area group. The customer is excluded, and averages require at least ten
other group members. Annual amounts and purchase counts use the per-person mean, including zero spending
in a category; average purchase size uses all peers' purchase euros divided by their purchase count.
The card labels the group and its size. Only formatted aggregates are exported, never other customers'
records or identities. Current and previous years use separate totals; neither uses smoothed monthly
model estimates as a yearly comparison. Group averages are descriptive, not spending targets.

## UI

`ui-demos/public/wrapped.js` and `wrapped.css`. Stories auto-advance every 14 s. Controls:
- **Navigate:** tap the right or left side, swipe, or use the arrow keys.
- **Pause:** hold the screen, or use the pause button or the space bar.
- **Close:** swipe down, press Esc or use the close button.

With reduced motion requested by the device, there is no auto-advance and no animation. The deep link
`#rahavuosi` opens the story (`#rahavuosi/3` opens card 3), e.g. from a push notification.
`server-data/wrapped-data.json` holds the source recaps. On page load, the server returns only the configured customer's recap through `/wrapped-data.json`.

Text is Finnish for now. The cards carry plain strings, so a language switch means building the cards in
another language in `cards.py`.

The source recap bundle is private. The UI server exposes `/wrapped-data.json` filtered to its configured synthetic customer and rejects customer query parameters. It never serves the multi-customer source as a static file.
