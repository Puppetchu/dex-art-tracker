'use strict';
// Dex Art Card Tracker server (TCGdex edition).
//
// Local database, built gently:
//  1. Sets: the set list is checked at start and then every 6 hours (SETS_CHECK_HOURS); every new set is fetched once.
//     A set request returns all its cards by name and image, so every card is stored from that
//     alone. Regular cards need no further requests.
//  2. Art candidates: TCGdex is asked which cards have an art rarity (a few dozen list requests), and
//     every card in a promo set counts too. Those cards get a request of their own, to read rarity,
//     dex number and price. (If the rarity search is not available, cards numbered above the official
//     set size are used instead.) Japanese sets are read the same way. Card data never changes, so it
//     is stored forever.
//  3. Prices: the cheapest few art cards per Pokémon are re-priced slowly, oldest first (one request every
//     REQUEST_DELAY_MS). Cards and Pokémon that every account owns are not re-priced.
//  Accounts: every trainer has their own dex (ticks, wish list, history); the card database is shared.
//
// The code lives in server/, in parts by subject. They are loaded here one after another into one shared scope, so
// they read as one program: a part can use what an earlier part defined, and functions of later parts once all are
// loaded.
const fs = require('fs'), path = require('path'), vm = require('vm');
global.require = require;      // the parts load their libraries relative to this file
global.__dirname = __dirname;  // and find public/ and node_modules/ from here
const PARTS = ['config.js', 'tcgdex.js', 'export.js', 'database.js', 'pictures.js', 'scan.js', 'import.js', 'accounts.js', 'http.js'];
for (const part of PARTS) {
  const file = path.join(__dirname, 'server', part);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}
