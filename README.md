# Dex Art Card Tracker

A self-hosted Pokédex-style checklist for collecting one card of every Pokémon in the national dex: first any card, then an art card. Every Pokémon shows its main picture, price and two buttons, the Sets view shows every set with the cards in it and your progress, and several trainers can each keep their own dex on one server.

## Run it

```
docker compose up -d --build
```

Open http://localhost:8080 (or the server's address on your network).

## Using it

- **The top of the page.** The lens and title on the left with the colour legend under them, the search box in the middle, and the **Dex of** menu on the right to pick whose dex you are looking at.
- **Views.** The red menu at the start of the bar switches between **Pokémon**, **Sets**, **Trainers**, **Wish list & trades** and **History**.
- **Pokémon.** One entry per dex number. The LED shows your state: red = nothing yet, yellow = you have a card, green = you have the art card. Filter by what you are missing, jump to a generation, or sort by price: **Owned: price high → low** / **low → high** shows only the Pokémon you own a card of, ranked by the most expensive card you own of each (owned cards without a price last).
- **Main picture.** The most expensive card you own; otherwise the card on your wish list, else the cheapest art card. If a Pokémon has no art card, a regular card is shown instead.
- **Any card / Art card buttons.** "Art card" checks the art card that counts for that Pokémon (the one on your wish list, else the cheapest). It is the same check you see in the Sets view.
- **Wish list.** Under **view** on a Pokémon, **☆ Wish for this one** makes a card you do not own the main picture and puts it on your wish list (the tile shows ★ WISH). Cards in the Sets and Trainers views have a **☆ Wish** button too: a Pokémon card becomes that Pokémon's main picture (one wish per Pokémon), a trainer card simply goes on the list. **★ On wish list** takes a card off again. For cards you own, **Use as main** only changes the picture.
- **Wish list & trades.** Shows the wish list of the dex you are looking at with its total price, which other trainers own each card, and below it the cards this dex owns that are on another trainer's wish list.
- **History.** The cards most recently ticked in this dex, newest first and grouped by day (the last 300 are kept). Unticking a card takes it off the list. Restoring a backup is not counted.
- **Sets.** Every scanned set, with progress (cards owned / cards in the set). Open a set to see all its cards, tick the ones you own, and filter by All / Missing / Owned / Art cards. The summary shows the main set, the secret cards and the art cards separately.
- **Worth of owned art** is the price of the art cards you checked. **Left to spend** is the cheapest art card (or the one you picked) for every Pokémon you have no art card for yet.
- **Click a picture** to see it large.
- **Back and forward buttons** work inside the page: every view, one set, a card list and the large picture each get their own step, and every view has its own link (for example `#/sets/sv03.5`, `#/wish`, `#/history`).

## Art cards and promos

A card counts as an art card when:

- its rarity is one of `RARITIES` (default: Illustration Rare, Special Illustration Rare, Promo), or
- it comes from a promo set (name contains "Promo") and is a Pokémon card. Switch this off with `PROMO_AS_ART=0`.

The data cannot tell every art card apart (for example an older alternate art such as Lugia V in Silver Tempest is just an "Ultra Rare"). So the admin can correct it, in the Sets view or under **view**: **Count as art card** adds that card to the art list (one request to read its details and price), and **Not an art card** takes it off.

## Pictures

**Set pictures by hand.** On a set's own page the admin has a **Set picture…** button: paste a picture address or choose a file, the same way as for cards. The picture is checked, re-encoded and stored on the server; save with nothing filled in to go back to the automatic picture.

Sets show their logo (then their symbol) from TCGdex, with pokemontcg.io and Scrydex as backups and the set's id as text if nothing loads. For cards:

### Pictures stored on the server

The server downloads every card picture the page shows and keeps its own copy in the data folder (`images/`), so the page does not depend on the picture sites being online. Each picture is stored twice as WebP: low resolution (245 px wide, for the tiles) and high resolution (up to 734 px, for the large view and phones). Set logos are stored too. The page loads the stored copy first and only asks the outside sites for pictures that are not stored yet.

- A background job fills the store slowly (one picture per second, at most 25 minutes per hour): cards someone owns or wishes for first, then art cards, then the rest, newest sets first. The status line shows how many are stored and how many are still to download. The first fill takes a day or two.
- Disk space: roughly 3–5 GB with every card stored in both sizes. `IMAGE_HIGH=art` keeps high resolution only for art cards, owned and wished cards (roughly 1–1.5 GB in all); `IMAGE_HIGH=none` keeps only the low one.
- A picture that came from a backup site is replaced once TCGdex has one. A card whose picture could not be found anywhere is tried again after 7 days.
- Safety: automatic downloads only come from assets.tcgdex.net, images.pokemontcg.io and images.scrydex.com over https. Every picture (also custom ones) is limited to 15 MB, decoded and saved again as a clean WebP file; anything that is not a JPG, PNG, WebP, GIF, AVIF or TIFF picture is refused, so SVG drawings and disguised files are never stored. Picture addresses pasted by the admin must be https on the normal port and may never lead (also not through a redirect) to a private, local or reserved network address such as your own 192.168.x.x / 10.x.x.x network. Stored files are named by a hash of the card id and served with headers that stop a browser from treating them as anything but a picture.
- The picture processing uses the `sharp` package, installed when the container is built (`docker compose up -d --build`, needs internet once). Without it the page simply keeps using the outside sites.

### Where pictures come from

Pictures come from TCGdex. Brand new cards and many promos have no picture there yet. For those:

- **Automatic lookup.** The server asks the pokemontcg.io card search for the exact picture of every English card the page shows that has no TCGdex picture, promo sets first. It searches by set and number, and if the set is named differently there, by name and number, only taking an unambiguous match. Found pictures are stored for good; a card without a result is asked about again after 30 days. It runs in the background at the usual pace, at most 200 cards per hour and `PICTURES_PER_DAY` per day. The status line shows how many cards are still to look up. Japanese cards are not on pokemontcg.io.
- **By hand.** The admin sees a **Picture…** button on every card (Sets view and a Pokémon's card list). Paste the address of a picture of that card (for example "Copy image address" on a shop or card site) or choose a picture file from your computer; a preview shows it first. The server downloads or reads it once, checks it and stores a low and a high resolution copy, so the original site is not needed afterwards. Save with nothing filled in to go back to the automatic picture.
- Otherwise the page still tries pokemontcg.io and Scrydex addresses based on the set id, and finally shows a Poké Ball placeholder with the card's name and number.

## Other languages

English sets are always read. Japanese and **Chinese (Simplified)** sets are added with the `LANGUAGES` setting (Admin settings → Card database → Languages; default English and Japanese). Their cards get a **JA** or **ZH** tag, their names are matched to Pokémon through the Japanese and Chinese Pokémon names from PokeAPI, and cards numbered past the set size count as art cards. Searching for an English name (for example "pikachu") also finds the Japanese and Chinese cards of that Pokémon, and the Sets list has a language menu (English, Japanese or Chinese sets) when more than one language is read.

To see what another language offers before switching it on, open `http://<server>:8080/api/lang-check?lang=zh-cn` (or `ja`, `zh-tw`, ...): it reads the newest set of that language and reports, for four of its newest cards, the rarity name, the dex number and whether a price exists (about 8 requests).

## How the local database works

Data comes from [TCGdex](https://tcgdex.dev) (free, no key) and names from pokeapi.co. Everything is stored in the `dex-data` volume.

1. **Sets.** The set list is checked when the container starts and then once a day. Each new set is fetched once. A set request lists all its cards by name and image, so regular cards are stored from that alone, with no price and no further requests. They are matched to Pokémon by name. Pokémon TCG Pocket sets are ignored.
2. **Art candidates.** Cards numbered above the official set size (for example 199/198) and every card in a promo set get a request of their own, to read rarity, dex number and price. Candidates whose name contains no Pokémon name (trainers, energy) are skipped. The result is stored for good. Newest sets are done first.
3. **Prices.** The cheapest 2 art cards per Pokémon, and every card on someone's wish list, are re-priced when older than 30 days, oldest first. Cards and Pokémon (art card owned) are only skipped when every account owns them.
4. **Pace.** No daily limit, one request every 2 seconds (`REQUEST_DELAY_MS`), so the server never hammers TCGdex. The full database takes days to complete, and cards appear as they are fetched. The first build of the database runs in one go unless you set `STAGGER_INITIAL`. Cards that are still waiting for their details are shown on the status line and appear as the server works through them.

"Refresh prices" in the page fetches at most 25 cards (missing ones first, then the oldest prices), once per 10 minutes.

## Art cards without the number rule, and Japanese cards

- Art cards are found by rarity: the server asks TCGdex for the list of cards with an art rarity (about 40 list requests per language, repeated daily). Number no longer matters, so art cards inside the normal numbering are found too. If that search is not available, the old rule (number above the official set size) is used instead.
- Japanese sets and their art cards (Special illustration rare, and so on) are added with a "JA" tag. They only have € prices, so they only compete for cheapest with `PRICE_SOURCE=cardmarket` (the default). Regular Japanese cards are linked to a Pokédex number too (see below). Set `LANGUAGES=en` to switch Japanese off.
- Promo sets and sets from the last 180 days are read again every day, because they keep getting new cards. A card with no dex number on TCGdex gets one from its name.
- Besides the art rarities, every language counts the **Mega Hyper Rare**, **Ultra Rare** and **Holo Rare** rarities (`EXTRA_RARITIES`). Japanese sets also count every Pokémon card numbered above the set size (the "Secret card" label in the set view).
- Cards the rarity search lists (and promo or secret-numbered cards) are shown as art cards at once, from the set data the server already has, with "price pending". Their details and price are fetched afterwards in the background and replace the pending entry. Japanese set listings only contain the Japanese card name, so the server downloads the Japanese Pokémon names once from PokeAPI (one bulk request, or one request per Pokémon at your request pace if that is not available) and matches them against the card names (longest name wins, so ミュウ is not found inside ミュウツー). This makes Japanese regular cards show up under their Pokémon, with a price fetched in the background like English ones. If a Japanese card still has no Pokémon, it is a trainer, energy or a name the match cannot read; the detail fetch fills in the dex number where TCGdex has one.
- When these rules change, cards rejected earlier are checked again on the next start. Only cards that now qualify cost a request.
- Chinese cards are not included: TCGdex has no rarity, prices or dex numbers for them.
- The first fill of the Japanese data takes a while, because it follows the same slow request pace (and `DAILY_REQUESTS`, if you set one).

## Prices for every card, and shop links

- Art cards are priced as before. Regular cards get their price too: the server fills them in slowly in the background (newest sets first), and opening a Pokémon or a set fetches up to 6 missing prices straight away. Prices are stored locally and shown as "price not loaded yet" until then.
- **Every printing has its own price.** Cardmarket gives two prices per card, the card itself (standard print) and its reverse holo; TCGplayer gives one per printing (normal, holo, reverse holo, 1st edition, unlimited ...). The card shows its main price (the standard print; the reverse holo only for cards without one) and, under it, each printing with its own price. Older cards with 1st edition and unlimited prints show those separately.
- **Up or down:** next to a Cardmarket price, **▲ +12%** or **▼ −8%** compares the day price (the average of yesterday's sales) with the 30-day average.
- **Price graphs for the wish list:** cards on someone's wish list are priced again every day, and every price the server fetches is noted in `price-history.json` in the data folder. Each card on the wish list shows a small graph of its price; tap it for a larger graph with the lowest and highest price, Cardmarket's 1, 7 and 30-day averages (the 30-day average is the dashed line) and the price of every printing. A graph starts with the first daily price and grows from there.
- Every card has a **Cardmarket** and a **TCGplayer** link. If TCGdex supplies Cardmarket's product number the Cardmarket link opens that exact card, otherwise it opens a search for the card name, set and number.

## Trainers tab

Trainer cards with an art rarity (for example Illustration rare or Special illustration rare trainers, English and Japanese) are listed in their own **Trainers** view, newest set first, with a picture, price, Cardmarket and TCGplayer links and a "Have it" tick. They show owned count, worth and left to spend, and have no effect on the Pokémon counts at the top. They are found through the same rarity search as the other art cards, so the first update re-checks cards that were skipped before.

## Accounts, login and the view-only page

One port, one page. Every account (trainer) has its own dex with its own ticks; the card database is shared. Everyone who opens the page sees a **view-only** version: they can browse Pokémon, sets, trainers and cards and see what that trainer owns, but cannot change anything. The server refuses every change without a login.

- **Dex of:** the menu at the top picks whose dex you are looking at. Every dex has its own link (`/?dex=<id>`).
- **Login:** open your own dex and click the blue lens at the top left. A login only opens the dex it was made on: on someone else's dex you are view-only (and the lens logs you in to *that* dex). After logging in you get the full page with the tick buttons, Refresh, Trainer name, Password and Log out, and the lens becomes the camera button for scanning. The login lasts 30 days on that device.
- **Admin:** the admin is not a trainer and has no dex. The admin has its own address: `http://yourserver:8080/admin/`. Click the blue lens there and enter the admin password; this is the only place the admin can log in, and its login cookie is only sent to `/admin/`, so a trainer login and the admin login in the same browser never mix. The admin password is `ADMIN_PASSWORD`; if you do not set it, a random one is generated, printed in the container log (look for `ADMIN PASSWORD`) and saved as `admin.json` in the data folder. The admin sees every dex as a visitor does, plus **Admin settings** (in the view menu, or click the lens), Refresh prices, the art-card and Picture… buttons, and the account menu. (Older installs: the admin's own "Owner" dex is removed on the first start; its ticks are kept as `removed-owner-dex.json`.)
- **Admin settings:** a page with a dropdown for most settings below (prices, which sets to read, languages, pictures, scanning and the AI reader with its model and key, proxy). Choices made there are saved in `settings.json` in the data folder and win over the container's settings; **Default** uses the container's value or the built-in one. Saving restarts the server by itself in a few seconds. AI keys are never shown again on the page.
- **Signing up:** visitors can make their own dex: **Create your own dex** in the login box on the website, or **＋ New trainer** on the app's closed Pokédex (a trainer name and a password of at least 8 characters; they are logged in right away). The admin switches this on or off and sets the limits under Admin settings → Trainers (`SIGNUP`, `SIGNUP_PER_DAY`, `MAX_TRAINERS`); at most 3 sign-ups per internet address per day. Accounts made this way show "signed up" in the admin's account list.
- **Adding accounts:** logged in as the admin, open the **Dex of** menu and choose **+ Add account…**. Enter a trainer name and a password (or leave it empty and one is made up). The password is shown once. **Manage accounts…** in the same menu gives an account a new password (this logs them out) or deletes it (its ticks are kept as `states/<id>.deleted-….json`).
- **Trainer name and password:** every account owner can rename their own dex with the **Trainer name** button and change their password with **Password** (the current password is asked first; other devices logged in to that dex are logged out). The admin changes the admin password with the same button, unless it is set with `ADMIN_PASSWORD`: then change it there. An admin password changed on the page is stored as a salted hash in `admin.json`.
- **Shared art list:** "Count as art card" / "Not an art card" change the art list for every dex, so only the admin sees them. Other accounts can tick cards, use Get price and Refresh prices.
- Background re-pricing only skips a card or Pokémon when every account owns it.
- **The /admin/ address:** everything except `/admin/` is the normal page for visitors and trainers. The old `/view/` address still works (the first Android app opens it) and is the same as `/`.
- Eight wrong passwords from one address block further tries for 15 minutes. The money totals are hidden from visitors unless `SHOW_VALUE_PUBLIC=1`.
- **Outside your home:** only publish the page through an https reverse proxy or tunnel (the password travels as plain text over http), (`TRUST_PROXY` is on by default, so the proxy's forwarded address and https are used; set `TRUST_PROXY=0` if there is no proxy). The visitor's address is taken from the end of `X-Forwarded-For`, where the proxy adds it, so a made-up address cannot get around the wrong-password limit; with two proxies in a row set `PROXY_HOPS=2`. Passwords need at least 8 characters. Put the proxy rule on port 8080 only. To keep the admin login unreachable from outside while trainers can still log in, put `/admin` and `/admin/*` behind your proxy's own login (or do not publish them) and let everything else through. With Pangolin: protect the resource and add "Bypass Auth" rules for every path except `/admin/*` (for example a bypass rule for `/*` placed after a rule that requires login for `/admin/*`).

## What the background job never overwrites

- A card you took off the art list by hand stays off it.
- A card you counted as art by hand stays counted, and is re-priced first.
- Prices already fetched for regular cards survive the daily re-read of growing sets.
- When a refresh finds no picture or no price, the last known picture and price are kept.
- Your ticks and picks are only ever changed by you.

## Get price button

A card without a price shows a **Get price** button (only when logged in to your own dex, not on the view-only page). It asks the card service about that one card at once, ignoring the usual pause, stores the result and refreshes the page. If the card turns out not to be an art card, or the service has no price for it, the page says so.

## App and card scanning

On phones the page is compact: two cards per row (three on wider phones), a smaller header with the totals in a strip you can swipe, and a menu bar that scrolls away.

The page can be installed as an app on Android (and iPhone): open it in Chrome over https, then use **Install app** at the top right (or Chrome's menu → *Install app* / *Add to home screen*). It gets its own icon and opens full screen. The app is the same page, so it updates with the server. Without a connection it still shows the cards, ticks and pictures it loaded last.

**Scanning.** When you are logged in to your own dex, the blue Pokédex lens at the top left (with the small camera mark) opens the camera. Hold one card in view, or lay several cards side by side (up to 12), and tap the big lens below the picture to take it. The server reads all the text on the photo, wherever it is: every card number (for example `201/198`, `TG05/TG30` or a promo number) is paired with the large name above it, and each pair is one card. A card whose number cannot be read is still found by its name, and a photo taken sideways or upside down is turned and read again. For every card found, the server looks up the cards that fit and ranks them, also comparing that part of the photo with the stored pictures.

**Scanning a pile: the queue and the check screen.** Every tap of the lens adds the photo to a queue and the camera stays ready for the next one; the photos are scanned one by one in the background (the line under the camera shows how many are waiting). **Use photos** adds several saved pictures at once (this also works without https). **Check N cards →** opens the check screen: every card found is shown as your photo of it next to the card it was recognised as, marked *Sure*, *Check this* or *No match*.
- **✓ Add / Skip** decides whether the card is added; **✕** removes it from the list.
- **Change** shows the other suggestions and a search over all cards (name and/or number, for example `toxtricity gg09`); tapping one picks it.
- **Add N to my dex** ticks all approved cards at once (they appear in History); skipped cards stay on the list.
- The list is kept on the phone (per dex), so you can scan now and check later; **Clear list** empties it.

- The camera only works on an https address (your reverse proxy), not on `http://<ip>:8080`.
- How a scan works: the server finds every card's outline on the photo (OpenCV), straightens the card, and compares it with the stored pictures of all cards (a small colour fingerprint per picture, built in the background and kept in `fingerprints.bin`), which works even when no text can be read. It also reads the name and card number: with an AI model if you connect one (below), otherwise with Tesseract on the server itself. Text is matched tolerantly ("Toxtr" still finds Toxtricity), and a card in a sleeve, lying sideways or upside down is handled.
- Without an AI everything runs on your server and nothing is sent anywhere. A scan takes one to a few seconds.
- Results are best with good light and the card numbers sharp; with several cards, get close enough that the small numbers stay readable. Holo glare or tiny print can need a second try; if nothing fits, the page says what it read. Japanese cards are found by their number and set size (the Japanese name cannot be read).
- Only logged-in trainers can scan, one scan at a time on the server. `SCAN=0` switches scanning off; `SCAN_DEBUG=1` writes what every scan found and read to the log.

**Better AI readings.** The AI is also asked for the set code printed at the bottom of newer cards ("PAL", "SVI", "MEW" ...) and the card's language; a matching set and language count heavily, so the same card number in another set, or the Japanese print of an English card, no longer wins. OpenAI gets the card in high detail and must answer in JSON. When the card finder sees one or two card shapes, the AI also looks at the whole photo and decides how many cards there are: a single card then gives one result, read from the whole photo, even if the finder only caught the card's picture or half of it; cards cut off at the edge of the photo are left out.

**Reading cards with an AI.** An AI model that understands pictures reads names and card numbers far better than Tesseract, also on shiny cards, in sleeves and in Japanese (it also names the Pokémon in English). Set `SCAN_AI` to the service, `SCAN_AI_KEY` to its API key and optionally `SCAN_AI_MODEL`:

| `SCAN_AI` | Service | Default model |
|---|---|---|
| `gemini` | Google Gemini | `gemini-flash-latest` |
| `openai` | OpenAI (GPT) | `gpt-5-mini` |
| `claude` | Anthropic Claude | `claude-haiku-5-5` |
| `mistral` | Mistral | `mistral-small-latest` |
| `openrouter` | OpenRouter (many models with one key) | `openrouter/auto` |
| `local` | Your own model: Ollama, LM Studio, llama.cpp or any server with an OpenAI-style `/v1/chat/completions` | `llama3.2-vision` |

For `local`, set `SCAN_AI_URL` to the server's address including `/v1` (default `http://host.docker.internal:11434/v1`, Ollama on the machine running Docker; add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service on Linux). The model must understand images (for example `llama3.2-vision`, `gemma3`, `qwen2.5vl`). The AI only reads what is printed on each card; finding the card in your database stays on your server. Each card on a photo is one request (straightened, about 770 px wide). If the AI cannot be reached the built-in reader takes over and the scan says so. With a cloud service the card photos go to that service.
- Through a reverse proxy with login rules (for example Pangolin), the app needs every path except `/admin/` to get through without the proxy's login.

## Android app

The `android/` folder holds a small Android app that opens your server's page full screen and uses the server for everything. It starts as a closed Pokédex: pick a trainer and either tap **View dex** to look at their dex without logging in (the lens leads back), or enter the password and it opens on your own dex (inside the app you only see your own dex; the web page is unchanged). Scanning, wish lists and history work as on the web page. See `android/README.md` for installing and building; GitHub builds the APK with `.github/workflows/android.yml`.

**Getting and updating the app.** Every GitHub build is also published as the release `android-latest` (`dex-art.apk` plus `version.json`). On an Android phone the website shows an **Android app** button that downloads the newest build (through `<server>/android.apk`). The app asks the server (`<server>/android.json`) once a day whether a newer build exists and then offers to download it; **Check for updates** in the app's back-button menu asks right away. Android always asks before installing, and installing over the old app keeps the login. The download address is the `ANDROID_RELEASE` setting (Admin settings → Android app); `ANDROID_APP=0` hides the button and the update check.

## Wish list at a card show

The wish list can be ordered **cheapest first** (the default), most expensive first, by Pokédex, name or newest set, and the price buttons (**≤ €1** … **≤ €100**) hide everything above what you want to pay. The search box at the top filters it too (name, set, number or Pokémon), so at a stand you can type a name and see your card and its price. The order and price limit are remembered on that device; **Show all** clears them.

## Importing from another site

Logged in to your dex, click **Import** at the top (or **Import from another site…** at the bottom of the page) and choose a file, or paste the text. Two kinds work: a CSV export of your collection, for example from Collectr (your portfolio → Export), and a card list with set codes, one card per line like `1 Pikachu ex MEW 25` (Pokémon TCG Live, Limitless and other deck builders; `CRZ-GG 32` and `LOR-TG 1` are gallery cards GG32 and TG01, and codes like `M6` count as Japanese sets). Choose whether the cards go to your **owned cards** or your **wish list**. Every row is matched to a card by its card number (without the "/set size"), checked by name (for Japanese cards: by Pokémon), and the set name and set size decide between sets with the same number; rows marked *check* had no exact set-name match. You see every match first and can untick rows; nothing is added until you click **Add**. Rows that cannot be matched are listed with the reason (for example Chinese cards, or sets the server has not read). Other sites' exports work too when they have a card name and card number column (and ideally a set column).

## Generations

The Pokémon tab is split into the nine generations, each with a header showing its range and how many Pokémon you have a card and an art card for. The "Jump to generation" menu next to the filter scrolls straight to the one you pick.

## Your ticks

Saved on the server (`states/<id>.json` for every account), so every device sees the same progress. "Show backup text" copies them out as text.

## Settings (environment variables)

Most of these can also be chosen on the **Admin settings** page; a choice saved there wins over the value set here.

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REQUESTS` | 0 | Most requests per day, 0 = no limit |
| `REQUEST_DELAY_MS` | 2000 | Pause between requests in milliseconds |
| `PRICE_MAX_AGE_DAYS` | 30 | Re-price candidates older than this |
| `SETS_CHECK_HOURS` | 6 | The set list is checked at start and then every this many hours (the older `SETS_CHECK_DAYS` still works) |
| `PRICE_CANDIDATES` | 2 | Cheapest art cards per Pokémon kept up to date |
| `MIN_SET_DATE` | any | Only sets released on or after this date (YYYY-MM-DD) are read; `any` reads every set, including the 1999 Base Set |
| `RARITIES` | Illustration Rare,Special Illustration Rare,Promo | Art card rarities, case-insensitive |
| `PROMO_AS_ART` | 1 | 0 = promo cards only count when their rarity is listed above |
| `DISABLE_REFRESH` | 0 | 1 = never contact the APIs |
| `EXTRA_RARITIES` | Mega Hyper Rare,Ultra Rare,Holo Rare | Extra rarities that count as art cards in every language (comma separated) |
| `LANGUAGES` | en,ja | Languages whose sets are read: `en`, `ja` (Japanese), `zh-cn` (Chinese Simplified), for example `en,ja,zh-cn` |
| `SIGNUP` | 1 | Visitors can sign up for their own dex (0 = only the admin adds trainers) |
| `SIGNUP_PER_DAY` | 20 | Sign-ups per day for the whole server |
| `MAX_TRAINERS` | 200 | No more sign-ups beyond this many trainers |
| `REGULAR_PRICES_PER_DAY` | 0 | Most requests per day spent on regular-card prices, 0 = no limit |
| `ADMIN_PASSWORD` | random | The admin password (log in on `/admin/`) |
| `ANDROID_APP` | 1 | Offer the Android app: the website button and the app's update check (0 = off) |
| `ANDROID_RELEASE` | this repository's `releases/latest/download/` | Folder with `dex-art.apk` and `version.json` |
| `IMAGE_CACHE` | 1 | 0 = do not store pictures on the server (the page then loads them from the picture sites) |
| `IMAGE_HIGH` | all | Which cards also get a high resolution copy: `all`, `art` (art, owned and wished cards) or `none` |
| `IMAGE_DELAY_MS` | 1000 | Pause between two picture downloads, in milliseconds |
| `PICTURE_LOOKUP` | 1 | 0 = do not look up missing pictures on pokemontcg.io |
| `PICTURES_PER_DAY` | 500 | Most picture lookups per day, 0 = no limit (each card takes one or two requests) |
| `PTCG_API_KEY` | (none) | Optional free pokemontcg.io API key, for a higher request limit there |
| `PRICE_SOURCE` | cardmarket | Prices shown on the page for every dex: `cardmarket` (€) or `tcgplayer` ($) |
| `SHOW_VALUE_PUBLIC` | 0 | 1 = visitors also see the money totals |
| `TRUST_PROXY` | 1 | Use the reverse proxy's forwarded address and https. 0 = off |
| `PROXY_HOPS` | 1 | Number of reverse proxies in a row in front of the server |
| `SCAN` | 1 | 0 = switch card scanning off |
| `SCAN_AI` | (none) | Read cards with an AI: `gemini`, `openai`, `claude`, `mistral`, `openrouter` or `local` |
| `SCAN_AI_KEY` | (none) | API key for that service |
| `SCAN_AI_MODEL` | per service | Model to use (must understand images) |
| `SCAN_AI_URL` | per service | Address of a local AI server (or another endpoint), including `/v1` |
| `SCAN_AI_TIMEOUT` | 45 | Seconds to wait for the AI |
| `SCAN_AI_BACKUP_MODEL` | `gemini-flash-lite-latest` for Gemini, none for others | Model to use when the main one is busy or out of quota (comma-separated for more, `none` to switch off). A busy model is tried 3 times first. |
| `SCAN_DEBUG` | 0 | 1 = log what each scan found and read |

## Limits

- Regular cards are matched to a Pokémon by name (including Nidoran♀/♂, Farfetch’d and Sirfetch’d, which are spelled differently by the card service), so a few may still be missing or wrong.
- Prices come from TCGdex (Cardmarket in €, TCGplayer in $; the server shows one of them, see `PRICE_SOURCE`). Some cards have none.
- Passwords travel as plain text over http. Keep the page on your home network, or put it behind an https reverse proxy, tunnel or VPN before opening it to the internet.
