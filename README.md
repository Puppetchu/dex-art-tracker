# Dex Art Card Tracker

A self-hosted checklist of the cheapest art card (Illustration Rare / Special Illustration Rare) for every Pokémon in the national dex, with pictures, prices and two tick boxes per Pokémon: any card and art card. Regular cards from the same sets are listed too, to help with the "any card" goal.

## Run it

```
docker compose up -d --build
```

Open http://localhost:8080 (or the server's address on your network).

## How the local database works

Data comes from [TCGdex](https://tcgdex.dev) (free, no key) and names from pokeapi.co. Everything is stored in the `dex-data` volume.

1. **Sets.** The set list is checked every 30 days. Each new set is fetched once. A set request lists all its cards by name and image, so regular cards (number within the official set size) are stored from that alone, with no price and no further requests. They are matched to Pokémon by name.
2. **Art cards.** Art cards always have a number above the official set size (for example 199/198). Only those cards get a request of their own, to read rarity, dex number, image and price. This is stored for good.
3. **Prices.** The cheapest 2 art cards per Pokémon are picked from the local database and re-priced when older than 30 days, oldest first. Pokémon whose art card you ticked as owned are never re-priced.
4. **Pace.** At most 300 requests per day, one per second. The first build of the database (roughly 200 sets plus the art cards, about 20 to 30 minutes) runs in one go unless you set `STAGGER_INITIAL=1`.

Only sets released since `MIN_SET_DATE` (2023-03-01, the start of Scarlet & Violet) are scanned for cards. Older sets are recorded but not read.

"Refresh prices" in the page fetches at most 25 cards (missing ones first, then the oldest prices), once per 10 minutes.

## Your ticks

Saved on the server in `state.json`, so every device sees the same progress. "Show backup text" copies them out as text.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REQUESTS` | 300 | Most requests per day |
| `PRICE_MAX_AGE_DAYS` | 30 | Re-price candidates older than this |
| `SETS_CHECK_DAYS` | 30 | How often the set list is checked for new sets |
| `PRICE_CANDIDATES` | 2 | Cheapest art cards per Pokémon kept up to date |
| `MIN_SET_DATE` | 2023-03-01 | Only sets released on or after this are scanned |
| `STAGGER_INITIAL` | 0 | 1 = first build also limited to the daily budget |
| `RARITIES` | Illustration Rare,Special Illustration Rare | Art card rarities, case-insensitive |
| `DISABLE_REFRESH` | 0 | 1 = never contact the APIs |

## Limits

- Regular cards are matched to a Pokémon by name, so a few may be missing or wrong.
- Prices come from TCGdex (Cardmarket in €, TCGplayer in $). Some cards have none.
- There is no login. Keep it on your home network or behind a VPN or an authenticated proxy.
