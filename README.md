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
- **Back and forward buttons** work inside the page: Pokémon, Sets, one set, a card list and the large picture each get their own step, and every view has its own link (for example `#/sets/sv03.5`).

## Art cards and promos

A card counts as an art card when:

- its rarity is one of `RARITIES` (default: Illustration Rare, Special Illustration Rare, Promo), or
- it comes from a promo set (name contains "Promo") and is a Pokémon card. Switch this off with `PROMO_AS_ART=0`.

The data cannot tell every art card apart (for example an older alternate art such as Lugia V in Silver Tempest is just an "Ultra Rare"). So you can correct it yourself, on the Sets tab or under **view**: **Count as art card** adds that card to the art list (one request to read its details and price), and **Not an art card** takes it off.

## Pictures

Sets show their logo (then their symbol) from TCGdex, with pokemontcg.io and Scrydex as backups and the set's id as text if nothing loads. For cards:

Pictures come from TCGdex. Brand new cards and many promos have no picture there yet. In that case the page tries pokemontcg.io and then Scrydex, and finally shows a Poké Ball placeholder with the card's name and number.

## Other languages (check first)

Japanese and Chinese sets, and cheaper copies in other languages, are not part of the database yet. TCGdex lists them, but its documentation does not say whether those cards carry prices. To find out on your own server, open these in a browser (one at a time, 20 seconds apart):

- `http://<server>:8080/api/lang-check?lang=ja`
- `http://<server>:8080/api/lang-check?lang=zh-tw`
- `http://<server>:8080/api/lang-check?lang=zh-cn`

Each check reads the newest set of that language and reports, for four of its newest cards, the rarity name, the dex number and whether a price exists. It costs about 8 requests.

## How the local database works

Data comes from [TCGdex](https://tcgdex.dev) (free, no key) and names from pokeapi.co. Everything is stored in the `dex-data` volume.

1. **Sets.** The set list is checked when the container starts and then once a day. Each new set is fetched once. A set request lists all its cards by name and image, so regular cards are stored from that alone, with no price and no further requests. They are matched to Pokémon by name. Pokémon TCG Pocket sets are ignored.
2. **Art candidates.** Cards numbered above the official set size (for example 199/198) and every card in a promo set get a request of their own, to read rarity, dex number and price. Candidates whose name contains no Pokémon name (trainers, energy) are skipped. The result is stored for good. Newest sets are done first.
3. **Prices.** The cheapest 2 art cards per Pokémon are re-priced when older than 30 days, oldest first. Cards you checked as owned, and Pokémon whose art card you own, are never re-priced.
4. **Pace.** No daily limit, one request every 4 seconds (`REQUEST_DELAY_MS`), so the server never hammers TCGdex. The full database takes days to complete, and cards appear as they are fetched. The first build of the database runs in one go unless you set `STAGGER_INITIAL`. Cards that are still waiting for their details are shown on the status line and appear as the server works through them.

"Refresh prices" in the page fetches at most 25 cards (missing ones first, then the oldest prices), once per 10 minutes.

## Art cards without the number rule, and Japanese cards

- Art cards are found by rarity: the server asks TCGdex for the list of cards with an art rarity (about 40 list requests per language, repeated daily). Number no longer matters, so art cards inside the normal numbering are found too. If that search is not available, the old rule (number above the official set size) is used instead.
- Japanese sets and their art cards (Special illustration rare, and so on) are added with a "JA" tag. They only have € prices, so they only compete for cheapest in € mode. Regular Japanese cards are not listed. Set `LANGUAGES=en` to switch Japanese off.
- Promo sets and sets from the last 180 days are read again every day, because they keep getting new cards. A card with no dex number on TCGdex gets one from its name.
- Japanese sets count two extra kinds as art cards: the **Mega Hyper Rare** rarity (`JA_RARITIES`) and every Pokémon card numbered above the set size (the "Secret card" label in the set view). English sets use the rarity search only.
- Chinese cards are not included: TCGdex has no rarity, prices or dex numbers for them.
- The first fill of the Japanese data takes a while because it follows your daily request limit.

## Prices for every card, and shop links

- Art cards are priced as before. Regular cards get their price too: the server fills them in slowly in the background (newest sets first), and opening a Pokémon or a set fetches up to 6 missing prices straight away. Prices are stored locally and shown as "price not loaded yet" until then.
- Every card has a **Cardmarket** and a **TCGplayer** link. If TCGdex supplies Cardmarket's product number the Cardmarket link opens that exact card, otherwise it opens a search for the card name, set and number.

## Trainers tab

Trainer cards with an art rarity (for example Illustration rare or Special illustration rare trainers, English and Japanese) are listed on their own **Trainers** tab, newest set first, with a picture, price, Cardmarket and TCGplayer links and a "Have it" tick. They show owned count, worth and left to spend, and have no effect on the Pokémon counts at the top. They are found through the same rarity search as the other art cards, so the first update re-checks cards that were skipped before.

## Login and the view-only page

One port, one page. Everyone who opens it sees a **view-only** version: they can browse Pokémon, sets, trainers and cards and see what you own, but cannot change anything. The server refuses every change without a login.

- **Owner login:** click the blue lens at the top left of the Pokédex. After logging in you get the full page with the tick buttons, Refresh and Log out. The login lasts 30 days on that device.
- **Password:** set `ADMIN_PASSWORD`. If you do not, a random one is generated, printed in the container log (look for `OWNER PASSWORD`) and saved as `admin.json` in the data folder.
- **No login link at all:** share `http://yourserver:8080/view/`. It is the same view-only page and it never shows a login option, even to you.
- Eight wrong passwords from one address block further tries for 15 minutes. The money totals are hidden from visitors unless `SHOW_VALUE_PUBLIC=1`.
- **Outside your home:** only publish the page through an https reverse proxy or tunnel (the password travels as plain text over http), (`TRUST_PROXY` is on by default, so the proxy's forwarded address and https are used; set `TRUST_PROXY=0` if there is no proxy). Put the proxy rule on port 8080 only. To keep the login unreachable from outside, publish only the `/view/` path.

## Your ticks

Saved on the server in `state.json`, so every device sees the same progress. "Show backup text" copies them out as text.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REQUESTS` | 0 | Most requests per day, 0 = no limit |
| `REQUEST_DELAY_MS` | 4000 | Pause between requests in milliseconds |
| `PRICE_MAX_AGE_DAYS` | 30 | Re-price candidates older than this |
| `SETS_CHECK_DAYS` | 1 | The set list is checked at start and then every this many days |
| `PRICE_CANDIDATES` | 2 | Cheapest art cards per Pokémon kept up to date |
| `MIN_SET_DATE` | 2000-01-01 | Only sets released on or after this are scanned |
| `RARITIES` | Illustration Rare,Special Illustration Rare,Promo | Art card rarities, case-insensitive |
| `PROMO_AS_ART` | 1 | 0 = promo cards only count when their rarity is listed above |
| `DISABLE_REFRESH` | 0 | 1 = never contact the APIs |
| `JA_RARITIES` | Mega Hyper Rare | Extra art rarities for Japanese sets (comma separated) |
| `LANGUAGES` | en,ja | `en` = English only |
| `REGULAR_PRICES_PER_DAY` | 0 | Most requests per day spent on regular-card prices, 0 = no limit |
| `ADMIN_PASSWORD` | random | Owner password |
| `SHOW_VALUE_PUBLIC` | 0 | 1 = visitors also see the money totals |
| `TRUST_PROXY` | 1 | Use the reverse proxy's forwarded address and https. 0 = off |

## Limits

- Regular cards are matched to a Pokémon by name, so a few may be missing or wrong.
- Prices come from TCGdex (Cardmarket in €, TCGplayer in $). Some cards have none.
- There is no login. Keep it on your home network or behind a VPN or an authenticated proxy.
