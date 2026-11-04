# Dex Art Card Tracker

A self-hosted Pokédex-style checklist for collecting one card of every Pokémon in the national dex: first any card, then an art card. Every Pokémon shows its main picture, price and two buttons, and a Sets tab shows every set with the cards in it and your progress.

## Run it

```
docker compose up -d --build
```

Open http://localhost:8080 (or the server's address on your network).

## Using it

- **Pokémon tab.** One entry per dex number. The LED shows your state: red = nothing yet, yellow = you have a card, green = you have the art card.
- **Main picture.** By default the cheapest art card. If a Pokémon has no art card, a regular card is shown instead. Under **view** you can pick any art or regular card as the main picture.
- **Any card / Art card buttons.** "Art card" checks the art card that counts for that Pokémon (the one you picked, else the cheapest). It is the same check you see on the Sets tab.
- **Sets tab.** Every scanned set, with progress (cards owned / cards in the set). Open a set to see all its cards, tick the ones you own, and filter by All / Missing / Owned / Art cards. The summary shows the main set, the secret cards and the art cards separately.
- **Worth of owned art** is the price of the art cards you checked. **Left to spend** is the cheapest art card (or the one you picked) for every Pokémon you have no art card for yet.
- **Click a picture** to see it large.

## Art cards and promos

A card counts as an art card when:

- its rarity is one of `RARITIES` (default: Illustration Rare, Special Illustration Rare, Promo), or
- it comes from a promo set (name contains "Promo") and is a Pokémon card. Switch this off with `PROMO_AS_ART=0`.

The data cannot tell every art card apart (for example an older alternate art such as Lugia V in Silver Tempest is just an "Ultra Rare"). So you can correct it yourself, on the Sets tab or under **view**: **Count as art card** adds that card to the art list (one request to read its details and price), and **Not an art card** takes it off.

## Pictures

Pictures come from TCGdex. Brand new cards and many promos have no picture there yet. In that case the page tries pokemontcg.io and then Scrydex, and finally shows a Poké Ball placeholder with the card's name and number.

## How the local database works

Data comes from [TCGdex](https://tcgdex.dev) (free, no key) and names from pokeapi.co. Everything is stored in the `dex-data` volume.

1. **Sets.** The set list is checked every 30 days. Each new set is fetched once. A set request lists all its cards by name and image, so regular cards are stored from that alone, with no price and no further requests. They are matched to Pokémon by name. Pokémon TCG Pocket sets are ignored.
2. **Art candidates.** Cards numbered above the official set size (for example 199/198) and every card in a promo set get a request of their own, to read rarity, dex number and price. Candidates whose name contains no Pokémon name (trainers, energy) are skipped. The result is stored for good. Newest sets are done first.
3. **Prices.** The cheapest 2 art cards per Pokémon are re-priced when older than 30 days, oldest first. Cards you checked as owned, and Pokémon whose art card you own, are never re-priced.
4. **Pace.** At most 200 requests per day, one per second. The first build of the database runs in one go unless you set `STAGGER_INITIAL`. Cards that are still waiting for their details are shown on the status line and appear as the server works through them.

"Refresh prices" in the page fetches at most 25 cards (missing ones first, then the oldest prices), once per 10 minutes.

## Your ticks

Saved on the server in `state.json`, so every device sees the same progress. "Show backup text" copies them out as text.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REQUESTS` | 200 | Most requests per day |
| `PRICE_MAX_AGE_DAYS` | 30 | Re-price candidates older than this |
| `SETS_CHECK_DAYS` | 30 | How often the set list is checked for new sets |
| `PRICE_CANDIDATES` | 2 | Cheapest art cards per Pokémon kept up to date |
| `MIN_SET_DATE` | 2000-01-01 | Only sets released on or after this are scanned |
| `RARITIES` | Illustration Rare,Special Illustration Rare,Promo | Art card rarities, case-insensitive |
| `PROMO_AS_ART` | 1 | 0 = promo cards only count when their rarity is listed above |
| `DISABLE_REFRESH` | 0 | 1 = never contact the APIs |

## Limits

- Regular cards are matched to a Pokémon by name, so a few may be missing or wrong.
- Prices come from TCGdex (Cardmarket in €, TCGplayer in $). Some cards have none.
- There is no login. Keep it on your home network or behind a VPN or an authenticated proxy.
