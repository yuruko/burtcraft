// Durable, bounded memory for the Minecraft agent. This deliberately stores
// compact gameplay facts rather than chat/persona memory: it is safe to load
// into the game prompt and survives a Burnt/Minecraft restart.

import fs from 'fs';
import path from 'path';
import {
    ToasterHomestead, settlementFromJSON, fitOutpostBelowHomestead
} from './settlements.js';

const DEFAULT_PATH = path.resolve(process.cwd(), 'data', 'minecraft_memory.json');
const MAX_JOURNAL = 240;
const MAX_LANDMARKS = 80;
const MAX_FAILURES = 80;
const MAX_FAVORITES = 24;
const MAX_FOOD_SPOTS = 24;
const FOOD_SPOT_MERGE_DIST = 24;
// how long a harvested field is written off for. crops regrow, so a bare field is
// NOT a dead one - forgetting it outright would throw away a renewable farm, and
// remembering it as full walks her back into an empty field for the twentieth time.
// a clock is the only honest answer to "there was wheat here and now there isn't".
const CROP_REGROW_MS = 20 * 60 * 1000;
// animals wander off and breed back. shorter, because a pasture that is empty right
// now is usually just a pasture whose cows moved forty blocks.
const HERD_RETURN_MS = 8 * 60 * 1000;
// consecutive bare arrivals before a spot is forgotten for good. a field that is
// empty three times running is not a field on a regrow timer - it is somebody's
// claimed farm, a chunk that never loads, or ground she misread on the way past.
const FOOD_SPOT_DROP_MISSES = 3;
// re-reporting the same bare field inside this window refreshes the regrow clock
// but does not spend a strike. see noteFoodSpotEmpty.
const EMPTY_NOTE_DEBOUNCE_MS = 5 * 60 * 1000;
// "there is nothing here" is only ever a claim about what she can SEE, and the
// companion's block scan is 8 blocks. matches the java `R` - keep them together.
const EMPTY_NOTE_RADIUS = 9;
// what she can actually go and get, and how she gets it. `get` targets are altoclef
// resource names; `hunt` is the meat expedition, which needs no destination at all.
export const FOOD_SPOT_KINDS = {
    wheat: { get: 'wheat', label: 'wheat', regrow: CROP_REGROW_MS, bakeable: true },
    carrot: { get: 'carrot', label: 'carrots', regrow: CROP_REGROW_MS },
    potato: { get: 'potato', label: 'potatoes', regrow: CROP_REGROW_MS },
    beetroot: { get: 'beetroot', label: 'beetroot', regrow: CROP_REGROW_MS },
    berries: { get: 'sweet_berries', label: 'berry bushes', regrow: CROP_REGROW_MS },
    animals: { get: null, label: 'animals', regrow: HERD_RETURN_MS }
};
// the named collection. must exceed the sum of OVEN_TARGETS with headroom: evicting
// a record does not remove the block from the world, it just makes her forget she
// named it - and makes the tally re-open a target she already filled.
const MAX_OVENS = 128;
// THE TRIMMINGS. things she puts around the place because she lives there, as
// opposed to the appliances, which are family. deliberately a separate ledger
// from `ovens`: an oven's truth source is the companion's block scan, and none
// of these are scanned, so this ledger is the ONLY record that a lantern ever
// went up. that also means it must never gate anything expensive - the worst
// case for a wrong entry is one missing ornament, never a loop.
// ⚠⚠ EVERY KIND HERE IS NAMED IN `ExternalControlServer.isPlacedByPeople`, AND
// THAT IS A SAFETY PROPERTY, NOT A COINCIDENCE. the ornaments stand in the yard,
// and `Settlement`'s "blocks she may never clear" predicate is literally
// `!isPlacedByPeople(state)` - so anything OFF that list is something the yard
// clear is entitled to smash. an unprotected ornament would leave `yardRemaining`
// permanently above zero: she breaks it, the wishlist puts it back, forever.
// (this also rules out `painting`, `item_frame` and `armor_stand`, which are
// ENTITIES - `@place_at` resolves through the BLOCK registry and would reject
// them outright.)
export const COMFORT_KINDS = [
    'lantern', 'composter', 'glass_pane', 'loom', 'grindstone',
    'cartography_table', 'bookshelf', 'lectern', 'anvil', 'enchanting_table'
];
// the wishlist is 8 long and one settlement's porch holds a handful, so this is
// headroom for several homes rather than a real ceiling.
const MAX_COMFORTS = 64;
// two ornaments this close are the same ornament re-reported, not a pair.
const COMFORT_MERGE_DIST = 1;
// 64-block cells, so ~4000 covers a 500x500-chunk slab of explored world
// the people roster. big enough to hold a small server's regulars across sessions;
// eviction is by how much they actually mattered, never by pure recency, so one busy
// evening of strangers cannot push out someone she has played beside for weeks.
const MAX_PLAYERS = 48;
const MAX_PLAYER_REQUESTS = 4;                  // the last few things one person asked of her
const MAX_PLAYER_NOTES = 3;
const MAX_TERRAIN_CELLS = 4000;
const MAX_CLAIMED_CELLS = 400;
const MAX_VISITED_SPOTS = 256;
// the places she knows by sight. bigger than the resource ledgers because this
// is the one that carries a WORLD rather than a supply chain - and eviction is
// by value, so hitting the cap drops a featureless hillside, never the ravine
// she named.
const MAX_PLACES = 64;
// 66 vanilla biomes and a handful of worlds. this is a runaway guard, not a
// working limit - forgetting one silently turns "i have never seen this" back
// into a lie, so it should never actually bind.
const MAX_BIOMES = 400;
// ~90 vanilla mobs and a handful of worlds. same shape as MAX_BIOMES and the
// same warning: this is a runaway guard, not a working limit. an evicted
// creature comes back as "i have never seen one of these", which is a worse
// failure than never having claimed it.
const MAX_CREATURES = 600;
// 2-second telemetry against a ledger that only ever gains ~90 distinct keys:
// without a debounce, standing in a field would rewrite the file every poll
// forever to move a `last` timestamp nobody reads at that resolution.
const CREATURE_TOUCH_DEBOUNCE_MS = 300000;
// one entry per locale. wider than a food spot (24) because a place is a
// stretch of ground rather than a block, and narrower than the visited-spot
// merge (140) because two named places 100 blocks apart are two places.
const PLACE_MERGE_DIST = 48;
const MAX_PLACE_FEATURES = 8;
// what a place can have going on. this is a PROSE table and the set the
// observer knows how to derive on its own - it is NOT a whitelist, because the
// descriptions worth keeping are the ones she or a viewer invents on the spot.
export const PLACE_FEATURES = {
    lava: 'open lava',
    open_water: 'open water',
    trees: 'heavy tree cover',
    cliff: 'a cliff',
    steep: 'steep ground',
    flat: 'flat open ground',
    high: 'high ground',
    underground: 'underground',
    cave: 'a cave mouth',
    sheltered: 'under cover',
    exposed_ore: 'ore in the open',
    herd: 'animals grazing',
    crops: 'crops growing',
    built: 'somebody has built here',
    village: 'a village',
    hostile: 'hostiles about',
    dark: 'dark even in the day',
    wet_ground: 'waterlogged ground',
    ruin: 'ruins'
};
// she is meant to remember every place she has lived, so this is a runaway
// guard rather than a working limit - and eviction is by value, never by age
// (see _evictSettlement), so hitting it drops a half-dug outpost rather than the
// first house she ever built.
const MAX_SETTLEMENTS = 48;
// merge radius for "i have already looked here". matches the tool's
// RECENT_DESTINATION_RADIUS so the persisted view and the live view agree.
const VISITED_MERGE_RADIUS = 140;
const OVEN_MERGE_DIST = 3;                  // same block, re-reported by the scan
// the oven family. every furnace/smoker/campfire the bot installs becomes a
// named unit in a collection it keeps track of - a cheap, durable source of
// "things that are mine" for a character to refer back to.
export const OVEN_KINDS = ['furnace', 'blast_furnace', 'smoker', 'campfire', 'soul_campfire'];
// auto-names for units the idle brain installs, in her antique-toaster register
// (model names, chrome-and-bakelite era, a couple of clergy). her own brain can
// override with a name when it places one through the tool.
// auto-names for units the idle brain installs, used only when the brain does
// not supply one through the tool.
//
// THIS IS CHARACTER FLAVOR, and it is the one place persona would otherwise leak
// into an otherwise neutral memory layer. the default below is deliberately
// plain. pass your own register to the constructor - burnt's, for instance, is a
// set of antique-toaster model names because she collects them:
//     new MinecraftMemory(path, { ovenNames: ['sunbeam', 'bakelite betty', ...] })
const DEFAULT_OVEN_NAME_POOL = [
    'the first one', 'old reliable', 'number two', 'the spare', 'the good one',
    'backup', 'the corner unit', 'the loud one', 'the new one', 'the small one'
];

// ---- ore spots -------------------------------------------------------------
// where the metal is. same proven shape as the food ledger, with the one
// difference that changes every rule: ORE DOES NOT GROW BACK. a harvested field
// is a farm on a clock, a mined-out vein is a hole - so there is no regrow
// window here, only a miss streak that ends in forgetting the place.
// `get` is the altoclef resource name so a caller never has to translate.
// `value` is the eviction rank and NOTHING else: diamonds and ancient debris
// are the trip she must not lose, iron is the one the whole build economy runs
// on, and the rest tie. never rank on a live reading (see _foodSpotValue) -
// mining a vein would then lower the worth of the only place she has proved has
// ore in it.
export const ORE_SPOT_KINDS = {
    diamond: { get: 'diamond', label: 'diamonds', value: 4 },
    ancient_debris: { get: 'ancient_debris', label: 'ancient debris', value: 4 },
    iron: { get: 'raw_iron', label: 'iron', value: 3 },
    coal: { get: 'coal', label: 'coal', value: 2 },
    copper: { get: 'raw_copper', label: 'copper', value: 2 },
    gold: { get: 'raw_gold', label: 'gold', value: 2 },
    redstone: { get: 'redstone', label: 'redstone', value: 2 },
    lapis: { get: 'lapis_lazuli', label: 'lapis', value: 2 },
    emerald: { get: 'emerald', label: 'emerald', value: 2 }
};
// block ids and item ids both arrive here: the companion scan reports BLOCKS
// (`deepslate_diamond_ore`), her brain and chat say ITEMS (`raw_iron`) or just
// the metal. all three name the same seam, and a kind this table cannot read is
// a spot that is silently never recorded - the quietest possible failure.
const ORE_KIND_ALIASES = {
    raw_iron: 'iron', iron_ingot: 'iron',
    raw_copper: 'copper', copper_ingot: 'copper',
    raw_gold: 'gold', gold_ingot: 'gold',
    lapis_lazuli: 'lapis',
    redstone_dust: 'redstone',
    diamonds: 'diamond', emeralds: 'emerald',
    debris: 'ancient_debris', netherite_scrap: 'ancient_debris'
};
const MAX_ORE_SPOTS = 32;
// veins are small. the 24-block food merge would fold two separate seams into
// one entry and then move the position off both of them.
const ORE_SPOT_MERGE_DIST = 10;
// three bare arrivals and the place is gone. ore never comes back, so a spot
// that keeps coming up empty is mined out, unreachable, or somebody else's mine
// - and none of those get better by waiting.
const ORE_SPOT_DROP_MISSES = 3;

// ---- quarries --------------------------------------------------------------
// A QUARRY IS A PLACE, NOT A FEATURE FLAG. the mouth is fixed ground she walks
// back to, which is the entire point: "nearest stone" measured from the build
// site is a fresh scrape every restock, measured from inside the same hole it
// deepens into a mine. levels are upgrades - 1 is a bare shaft, each level adds
// torch coverage and depth.
const MAX_QUARRIES = 8;
const MAX_QUARRY_LEVEL = 4;
// two mouths this close are one hole reported twice, not two quarries.
const QUARRY_MERGE_DIST = 8;
const MAX_QUARRY_TORCHES = 64;

// ---- stores (what is actually in her chests) -------------------------------
// THE PANTRY. every gathering decision she has ever made read her POCKETS and
// nothing else, so five hundred loaves sitting in a chest at home were invisible
// and "bread is low" was permanently true - she farmed, baked and foraged for
// food she already owned, which is the reported bug.
//
// same proven ledger shape as foodSpots/oreSpots (dimension normalized on BOTH
// sides, value-based eviction, restored in _load), with three differences that
// change every rule:
//   1. ONLY STORAGE IS A PANTRY. a furnace has a fuel slot and a smoker has
//      bread in it mid-cook; neither is somewhere she can shop. the companion
//      publishes `type` precisely so this file can tell them apart.
//   2. EVERY READING IS A BELIEF WITH A DATE ON IT. she plays multiplayer and
//      anybody can empty a chest, so entries carry `readAt` and any decision
//      that would talk her OUT of restocking has to ask how old the reading is.
//      a stale reading is not allowed to starve her.
//   3. A DOUBLE CHEST IS ONE PANTRY REPORTED TWICE. the companion keys off the
//      block that was clicked but tallies the whole 54-slot menu, so opening the
//      other half yields a second entry with identical contents. summed raw that
//      is a thousand loaves that do not exist - see _dedupeContainers.
const MAX_CONTAINERS = 40;
// THE COMPANION'S VOCABULARY IS `CHEST | SHULKER | FURNACE | BREWING | MISC`,
// and only the first two are somewhere she can shop. a furnace has a fuel slot
// and a smoker has her dinner in it mid-cook; counting either as supply is how
// you get a pantry that says she owns eight coal she is currently burning.
// ⚠ ENDER_CHEST is never published at all, by design on the java side: that
// inventory is ONE global cache with no position, so writing it at a block would
// be a lie - and two ender chests would be one pantry counted twice, the
// double-chest problem with no adjacency tell to catch it with.
export const CONTAINER_STORAGE_TYPES = new Set(['chest', 'shulker']);
// the two halves of a double chest are adjacent on one axis, at the same height.
const DOUBLE_CHEST_DIST = 1;

// fold every spelling into the companion's vocabulary. an unreadable type keeps
// whatever it said and simply never counts as a pantry - unknown means "this
// build cannot tell me", never "it is a chest".
const CONTAINER_TYPE_ALIASES = {
    trapped_chest: 'chest', barrel: 'chest', chest_minecart: 'chest',
    shulker_box: 'shulker', blast_furnace: 'furnace', smoker: 'furnace',
    brewing_stand: 'brewing'
};
export function normalizeContainerType(type) {
    const bare = cleanText(type || '', 40).toLowerCase()
        .replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
    return CONTAINER_TYPE_ALIASES[bare] || bare;
}

export function isPantryContainer(type) {
    return CONTAINER_STORAGE_TYPES.has(normalizeContainerType(type));
}

// item ids arrive namespaced off the wire (`minecraft:bread`) and bare from her
// brain, chat and every constant in the tool. one normalizer, or the ledger
// quietly answers zero for the one item the whole feature exists to count.
function bareItemName(name) {
    return cleanText(name || '', 80).toLowerCase().replace(/^minecraft:/, '');
}

// ---- per-settlement upgrades -----------------------------------------------
// the order IS the plan: nextPlannedUpgrade walks this list, not insertion
// order, so an upgrade queued late still happens in the right place.
// ⚠ unknown ids are REJECTED rather than stored. a typo'd upgrade that stores
// fine and never matches anything is a plan step that silently never runs.
// ⚠ defense_trench GOES LAST, and stays there. it is roughly 1250 block breaks -
// far and away the most expensive thing on the list - so anywhere higher up and a
// moat starves the furnaces, the chests and the field behind it for whole streams
// at a time. a house with a ditch and no storage is not a defended house.
export const SETTLEMENT_UPGRADE_ORDER = [
    'torch_inside', 'torch_outside', 'torch_perimeter', 'expand_torch_perimeter',
    'furnace', 'chest', 'glass_windows', 'porch', 'expand_porch', 'wheat_farm',
    'quarry', 'upgrade_quarry', 'expand_quarry', 'shell_iron', 'defense_trench'
];
const SETTLEMENT_UPGRADE_IDS = new Set(SETTLEMENT_UPGRADE_ORDER);
const UPGRADE_STATES = new Set(['planned', 'building', 'done']);

// ---- goals -----------------------------------------------------------------
// what she is doing now vs what she is building toward. both persisted, because
// a long goal that dies at every restart is a mood, not a goal.
const GOAL_SCOPES = new Set(['short', 'long']);
const GOAL_STATES = new Set(['open', 'active', 'done', 'abandoned']);
const GOAL_TERMINAL = new Set(['done', 'abandoned']);
const MAX_SHORT_GOALS = 12;
const MAX_LONG_GOALS = 8;

function cleanText(value, max = 120) {
    return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * HOW TO PICK THE JOB BACK UP - the difference between a goal and a wish.
 *
 * A goal used to be text: it reached her prompt and nothing else, so the only
 * way a job survived being interrupted was the owner asking again. Storing the action
 * that would resume it is what lets the idle tick carry on with a thing rather
 * than re-decide what to do from scratch every 25 seconds.
 *
 * ⚠ Kept to primitives on purpose. This is persisted to disk and fed straight
 * back into executeAction, so anything nested, functional or enormous is either
 * a serialisation bug waiting to happen or a way for one corrupt record to take
 * the file down. An unusable payload becomes null - the goal is then still a
 * goal she can talk about, just not one the tick can act on by itself.
 */
function cleanResume(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const action = cleanText(value.action, 32).toLowerCase();
    if (!action) return null;
    const params = {};
    const src = (value.params && typeof value.params === 'object' && !Array.isArray(value.params))
        ? value.params : {};
    let kept = 0;
    for (const [k, v] of Object.entries(src)) {
        if (kept >= 12) break;
        const key = cleanText(k, 32);
        if (!key) continue;
        if (typeof v === 'number' && Number.isFinite(v)) params[key] = v;
        else if (typeof v === 'boolean') params[key] = v;
        else if (typeof v === 'string') { const s = cleanText(v, 96); if (s) params[key] = s; }
        else continue;
        kept++;
    }
    return { action, params };
}

// entries that are protocol chatter rather than anything she lived. `hud` is the 30s
// in-game intent overlay; `status`/`inventory`/`coords` are read-only queries. a journal
// is what she DID, and a ring buffer full of heartbeats is a journal of nothing.
const JOURNAL_NOISE_ACTIONS = new Set(['hud', 'status', 'inventory', 'coords', 'look', 'tic']);
function isJournalNoise(entry) {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.kind !== 'completed') return false;
    const action = String(entry.action || '').trim().toLowerCase();
    if (action) return JOURNAL_NOISE_ACTIONS.has(action);
    // older entries predate the `action` field - fall back to the bare label
    return JOURNAL_NOISE_ACTIONS.has(String(entry.label || '').trim().toLowerCase());
}

// `minecraft:overworld` and `overworld` are the same place. the writers used to
// keep the prefix and the readers used to strip it, so a spot recorded by one
// companion build was invisible to the picker in the next.
function normalizeDimension(dimension) {
    return cleanText(dimension || 'overworld', 64).replace(/^minecraft:/, '') || 'overworld';
}

function safePoint(position) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
    return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) };
}

// the one place a block/item name becomes an ore ledger kind. exported so the
// callers never grow a second copy of this - two normalizers that have quietly
// stopped agreeing is how the food ledger's dimensions went wrong.
// returns null for anything that is not one of the nine tracked ores.
export function normalizeOreKind(kind) {
    const raw = cleanText(kind, 32).toLowerCase().replace(/^minecraft:/, '');
    const bare = raw.replace(/_ore$/, '').replace(/^(?:deepslate|nether)_/, '');
    const named = ORE_KIND_ALIASES[bare] || bare;
    return ORE_SPOT_KINDS[named] ? named : null;
}

export class MinecraftMemory {
    constructor(filePath = DEFAULT_PATH, { registerExitHook = true, ovenNames = null } = {}) {
        // character flavor, injectable - see DEFAULT_OVEN_NAME_POOL above
        this.ovenNames = Array.isArray(ovenNames) && ovenNames.length ? ovenNames : DEFAULT_OVEN_NAME_POOL;
        this.filePath = filePath;
        this.data = {
            version: 2, journal: [], landmarks: [], failures: [], favorites: [], home: null, foodSpots: [],
            ovens: [], comforts: [],
            tally: { breadBaked: 0, ovensInstalled: 0, fuelRuns: 0, comfortsPlaced: 0, gearBanked: 0 },
            deathSpot: null,
            settlements: [], mainSettlementId: null,
            // coarse map of where she has been wet vs stood: "wet"/"dry" keyed by
            // 64-block cell. without this she re-learns where the ocean is by
            // swimming into it once per restart.
            terrain: {},
            // every long-distance destination she has actually committed to, as
            // {x,z,at}. this used to live ONLY in ram, so "where have i already
            // looked" died with every burnt restart and she re-checked the same
            // ground forever - exactly the "it doesn't remember previously checked
            // areas" complaint. persisted here so a restart costs her nothing.
            visited: [],
            // the people she plays with. everything about a person used to be RAM-only
            // (a last-seen timestamp and a name roster), so every restart she met the
            // whole server for the first time again - no idea who she had talked to for
            // weeks, what they said, what they asked her to do, or who she gave bread to.
            players: [],
            // 64-block cells a server told her she may not touch, as key -> when.
            // declared here because a field the constructor never names is a field
            // _load() forgets to restore.
            claims: {},
            // the standing record of "am i actually able to get home". one departure
            // that fails is nothing; the same walk failing all afternoon means the
            // home is unreachable and she should build somewhere else. this MUST be
            // persisted - the go-home loop survived several burnt restarts precisely
            // because the attempt count lived in ram and reset to zero every time.
            homeCampaign: null,
            // ⚠ EVERY FIELD DECLARED HERE HAS A MATCHING LINE IN _load(). `visited`
            // and `claims` were written for weeks with no line in that function, so
            // the first record of each session flushed an empty array over a full
            // one - both ledgers looked persisted on disk and reset at every
            // restart. declaring a field is half the job; restoring it is the job.
            // where the metal is. mined-out veins accumulate misses and are forgotten.
            oreSpots: [],
            // WHAT IS IN HER CHESTS. without this every "do i need more bread"
            // question was answered from her pockets alone, so a full pantry was
            // invisible and she re-gathered what she already owned.
            stores: [],
            // the holes she digs stone out of, one fixed mouth each.
            quarries: [],
            // upgrades hang off settlements by id in a SIBLING map, because a
            // settlement record is round-tripped through settlementFromJSON and any
            // field that class does not know about is dropped on the way through.
            settlementUpgrades: {},
            // short-term and long-term intent, persisted.
            goals: [],
            // everywhere she knows by sight, described by what is actually
            // there rather than by what she can get out of it. the only ledger
            // here that is about the world instead of the supply chain.
            places: [],
            // which biomes she has stood in, per world. the honest source of
            // "i have never been anywhere like this".
            biomes: {},
            // the bestiary: which creatures she has actually stood near, per
            // world. same job as biomes and for the same reason - it is the
            // only honest source of "i have never seen one of these before",
            // which is the single best thing she has to say about a mob.
            creatures: {}
        };
        this._dirty = false;
        this._saveTimer = null;
        this._load();
        // final flush so a clean shutdown never loses the tail of the journal
        if (registerExitHook) process.once('exit', () => this.flush());
    }

    _load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                // drop the cosmetic-heartbeat entries a previous build wrote as real
                // completions. they had taken 208 of 240 slots and evicted her actual
                // history, so filtering BEFORE the slice is what gives the surviving
                // memories their places back. harmless once the writer is fixed.
                this.data.journal = Array.isArray(parsed.journal)
                    ? parsed.journal.filter((e) => !isJournalNoise(e)).slice(-MAX_JOURNAL)
                    : [];
                this.data.landmarks = Array.isArray(parsed.landmarks) ? parsed.landmarks.slice(-MAX_LANDMARKS) : [];
                this.data.failures = Array.isArray(parsed.failures) ? parsed.failures.slice(-MAX_FAILURES) : [];
                // ⚠ THE LOAD PATH MUST EVICT BY THE SAME RULE THE WRITE PATH DOES.
                // These four used to `.slice(-cap)` - keep the LAST N, i.e. drop the
                // oldest - while every write ranks by value. So an over-cap file threw
                // away exactly what the write path spends its effort protecting: her
                // home favorite, her first house, the regular she has known for weeks,
                // her home wheat field. Restore everything, then let the real evictors
                // decide, exactly as oreSpots/stores/quarries/goals already did.
                this.data.favorites = Array.isArray(parsed.favorites) ? parsed.favorites.slice() : [];
                this.data.home = typeof parsed.home === 'string' ? parsed.home : null;
                // ⚠ AFTER `home` is restored, because _evictFavorite reads it to keep
                // the home spot. Trimming before would drop the very entry the name on
                // disk points at, leaving her with a home she cannot walk to.
                const favoritesTrimmed = this._evictFavorite();
                // food spots used to be a wheat-only list. an old file's entries are
                // real places she found, so they migrate in as `wheat` rather than
                // being dropped - but with no `ripe` field, so the first honest look
                // at one decides whether it is still worth walking to.
                // ⚠ NORMALIZE THE DIMENSION ON THE WAY IN. every spot she actually
                // owns came from a build that stored `minecraft:overworld`, and every
                // eviction path matches on the bare name - so leaving these raw makes
                // exactly the spots that caused this bug the only ones that can never
                // be struck, forgotten, or merged with.
                const legacyWheat = Array.isArray(parsed.wheatSpots)
                    ? parsed.wheatSpots.map((s) => ({ ...s, kind: 'wheat', dimension: normalizeDimension(s?.dimension) }))
                    : [];
                const storedFood = Array.isArray(parsed.foodSpots)
                    ? parsed.foodSpots.map((s) => (s ? { ...s, dimension: normalizeDimension(s.dimension) } : s))
                    : [];
                this.data.foodSpots = [...legacyWheat, ...storedFood]
                    .filter((s) => s && s.position && FOOD_SPOT_KINDS[s.kind])
                    // migrated and pre-id entries get one now, so every spot in the
                    // ledger can be named by a run that was dispatched to it.
                    .map((s) => (s.id ? s : { ...s, id: this._newFoodSpotId() }));
                // ⚠ ONLY when the load actually CHANGED something. persisting
                // unconditionally makes merely constructing this class rewrite the
                // file - a write as a side effect of a read, which is how a test run
                // ended up editing her live memory. after the one-time
                // wheatSpots->foodSpots migration this is a no-op forever.
                // the flag is collected across every migration below and spent ONCE,
                // at the end of the load.
                let changedOnLoad = legacyWheat.length > 0
                    || storedFood.some((s) => s && !s.id)
                    || storedFood.some((s, i) => s && s.dimension !== parsed.foodSpots?.[i]?.dimension)
                    || favoritesTrimmed;
                // by VALUE, not by age - a bare pasture goes before her home wheat field
                if (this._evictFoodSpot()) changedOnLoad = true;
                this.data.ovens = Array.isArray(parsed.ovens) ? parsed.ovens.slice(-MAX_OVENS) : [];
                // ⚠ THE WHITELIST TRAP. `visited` and `claims` were written for
                // weeks with no restore line here and got flushed empty at every
                // start. this ledger has no world truth source at all, so a
                // missing restore would not merely lose the record - it would put
                // her back on the first ornament of the wishlist every session,
                // forever, with the last one still standing in the yard.
                this.data.comforts = Array.isArray(parsed.comforts)
                    ? parsed.comforts.filter((c) => c && safePoint(c.position) && COMFORT_KINDS.includes(c.kind))
                        .slice(-MAX_COMFORTS)
                    : [];
                this.data.settlements = Array.isArray(parsed.settlements)
                    ? parsed.settlements.map(settlementFromJSON).filter(Boolean).map((s) => s.toJSON())
                    : [];
                this.data.mainSettlementId = typeof parsed.mainSettlementId === 'string' ? parsed.mainSettlementId : null;
                // ⚠ EVICT AFTER mainSettlementId IS SET, because `_settlementValue`
                // reads it to make the main house unevictable. Doing it before would
                // let the trim take the house she lives in.
                if (this._evictSettlement()) changedOnLoad = true;
                // ...and a main id pointing at nothing is worse than none: it reads as
                // "she has a main" while `getMainSettlement` silently falls back to any
                // homestead, so her main house moves without a decision.
                if (this.data.mainSettlementId &&
                    !this.data.settlements.some((entry) => entry.id === this.data.mainSettlementId)) {
                    this.data.mainSettlementId = null;
                    changedOnLoad = true;
                }
                this.data.terrain = parsed.terrain && typeof parsed.terrain === 'object' && !Array.isArray(parsed.terrain)
                    ? parsed.terrain
                    : {};
                this.data.deathSpot = parsed.deathSpot && typeof parsed.deathSpot === 'object' && parsed.deathSpot.position
                    ? parsed.deathSpot
                    : null;
                this.data.homeCampaign = parsed.homeCampaign && typeof parsed.homeCampaign === 'object' &&
                    !Array.isArray(parsed.homeCampaign) ? parsed.homeCampaign : null;
                this.data.players = Array.isArray(parsed.players) ? parsed.players.slice() : [];
                if (this._evictPlayer()) changedOnLoad = true;
                // WRITTEN BUT NEVER READ BACK is worse than never stored: the first
                // record of the session flushed an empty array over a full one, so
                // "where have i already looked" and "which ground is claimed" reset
                // at every restart while both looked persisted on disk. these are the
                // two ledgers that stop her re-checking the same ground forever and
                // ping-ponging between two "unclaimed land" spots.
                this.data.visited = Array.isArray(parsed.visited) ? parsed.visited.slice(-MAX_VISITED_SPOTS) : [];
                this.data.claims = parsed.claims && typeof parsed.claims === 'object' && !Array.isArray(parsed.claims)
                    ? parsed.claims
                    : {};
                // ⚠ AND THIS ONE, for the same reason. a ledger this function
                // forgets is a ledger the first write of the session erases,
                // and it looks perfectly persisted on disk the whole time.
                // ⚠ SPREAD, NOT A HAND-WRITTEN FIELD MAP. `goals` lost `resume`
                // exactly that way, and a place carries free-form features this
                // function has no business enumerating - a describing word she
                // invented is not a field anyone gets to whitelist.
                this.data.places = (Array.isArray(parsed.places) ? parsed.places : [])
                    .map((p) => {
                        if (!p || typeof p !== 'object') return null;
                        const position = safePoint(p.position);
                        if (!position) return null;
                        const dimension = normalizeDimension(p.dimension);
                        if (dimension !== p.dimension) changedOnLoad = true;
                        return {
                            ...p, position, dimension,
                            features: Array.isArray(p.features) ? p.features : [],
                            visits: Number.isFinite(p.visits) ? p.visits : 1,
                            firstSeenAt: Number.isFinite(p.firstSeenAt) ? p.firstSeenAt : (p.at || Date.now()),
                            lastSeenAt: Number.isFinite(p.lastSeenAt) ? p.lastSeenAt : (p.at || Date.now())
                        };
                    })
                    .filter(Boolean);
                for (const place of this.data.places) {
                    // places are struck BY ID, so one without an id could never be
                    // forgotten on purpose. backfill rather than drop.
                    if (!place.id) { place.id = this._mintId('p', this.data.places); changedOnLoad = true; }
                }
                // by VALUE, like every other ledger here - an over-cap file must
                // not drop the named ravine to keep forty blank hillsides.
                if (this._evictPlace()) changedOnLoad = true;
                // ⚠ and this one. losing it does not read as "i forgot" - it
                // reads as her calling somewhere new that she has walked a
                // hundred times, which is worse than saying nothing.
                this.data.biomes = parsed.biomes && typeof parsed.biomes === 'object' && !Array.isArray(parsed.biomes)
                    ? parsed.biomes
                    : {};
                // ⚠ AND THIS ONE, for exactly the same reason. a forgotten
                // bestiary does not read as amnesia, it reads as her calling her
                // four hundredth zombie the first she has ever seen - the one
                // failure that makes the whole feature worse than not having it.
                this.data.creatures = parsed.creatures && typeof parsed.creatures === 'object' && !Array.isArray(parsed.creatures)
                    ? parsed.creatures
                    : {};

                // ⚠ THE SAME LESSON, FOUR MORE LEDGERS. these restores are not
                // optional polish: a ledger this function forgets is a ledger the
                // first write of the session erases, and it looks perfectly
                // persisted on disk the whole time.
                // ⚠ and dimensions are normalized on the way IN as well as the way
                // out, so a spot written by a build that kept `minecraft:` is not
                // the one entry no reader can ever match.
                const storedOre = Array.isArray(parsed.oreSpots) ? parsed.oreSpots : [];
                this.data.oreSpots = storedOre
                    .filter((s) => s && s.position && normalizeOreKind(s.kind))
                    .map((s) => {
                        const dimension = normalizeDimension(s.dimension);
                        // normalize the KIND on the way in as well as the way out.
                        // a hand-edited or older-shaped entry keeps its place
                        // instead of being dropped without a word.
                        const kind = normalizeOreKind(s.kind);
                        if (dimension !== s.dimension || kind !== s.kind) changedOnLoad = true;
                        return {
                            ...s, dimension, kind,
                            count: Number.isFinite(s.count) ? s.count : 0,
                            misses: Number.isFinite(s.misses) ? s.misses : 0,
                            depleted: !!s.depleted
                        };
                    });
                for (const spot of this.data.oreSpots) {
                    // a spot with no id can never be struck by the run dispatched to
                    // it, which is the whole failure-witness contract. backfill.
                    if (!spot.id) { spot.id = this._mintId('o', this.data.oreSpots); changedOnLoad = true; }
                }
                // ⚠ trim through the VALUE rule, not `slice(-cap)`. an over-cap file
                // trimmed by insertion order drops whatever was written earliest,
                // which is exactly the diamond spot the eviction rule exists to keep.
                if (this._evictOreSpot()) changedOnLoad = true;

                // ⚠ AND AGAIN. a ledger this function forgets is a ledger the
                // first write of the session erases, and it looks perfectly
                // persisted on disk the whole time. the pantry is the worst
                // possible one to lose: forgetting it does not read as "i do not
                // know what i have", it reads as "i have nothing", and she goes
                // farming for five hundred loaves she is standing next to.
                this.data.stores = (Array.isArray(parsed.stores) ? parsed.stores : [])
                    .filter((c) => c && typeof c === 'object' && [c.x, c.y, c.z].every(Number.isFinite))
                    .map((c) => {
                        const dimension = normalizeDimension(c.dimension);
                        const type = normalizeContainerType(c.type);
                        const key = this._containerKey(dimension, c.x, c.y, c.z);
                        // an entry rehydrated with a raw `minecraft:overworld` or a
                        // `CHEST` is the one entry no reader can ever match - the
                        // documented food-ledger failure, on the pantry.
                        if (dimension !== c.dimension || type !== c.type || key !== c.key) changedOnLoad = true;
                        return {
                            key, dimension, type,
                            x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z),
                            items: c.items && typeof c.items === 'object' && !Array.isArray(c.items)
                                ? Object.fromEntries(Object.entries(c.items)
                                    .map(([k, v]) => [bareItemName(k), Math.max(0, Number(v) | 0)])
                                    .filter(([k, v]) => k && v > 0))
                                : {},
                            empty: Number.isFinite(c.empty) ? Math.max(0, c.empty | 0) : null,
                            full: c.full === true,
                            // ⚠ a reading with NO date is not a fresh one. it is a
                            // reading whose age cannot be judged, and every
                            // suppression downstream is gated on freshness - so
                            // dating it `now` at load would let a chest she read
                            // last week talk her out of eating today.
                            readAt: Number.isFinite(c.readAt) ? c.readAt : 0,
                            world: c.world ? cleanText(c.world, 64) : null,
                            settlementId: c.settlementId ? cleanText(c.settlementId, 96) : null
                        };
                    });
                if (this._evictContainer()) changedOnLoad = true;

                this.data.quarries = (Array.isArray(parsed.quarries) ? parsed.quarries : [])
                    .filter((q) => q && safePoint(q.mouth))
                    .map((q) => ({
                        ...q,
                        mouth: safePoint(q.mouth),
                        dimension: normalizeDimension(q.dimension),
                        torches: Array.isArray(q.torches) ? q.torches.filter(Boolean).slice(-MAX_QUARRY_TORCHES) : [],
                        depth: Number.isFinite(q.depth) ? Math.max(0, q.depth | 0) : 0,
                        level: Number.isFinite(q.level) ? Math.min(MAX_QUARRY_LEVEL, Math.max(1, q.level | 0)) : 1
                    }));
                for (const quarry of this.data.quarries) {
                    if (!quarry.id) { quarry.id = this._mintId('q', this.data.quarries); changedOnLoad = true; }
                }
                if (this._evictQuarry()) changedOnLoad = true;

                this.data.goals = (Array.isArray(parsed.goals) ? parsed.goals : [])
                    .filter((g) => g && typeof g === 'object' && GOAL_SCOPES.has(g.scope) && cleanText(g.text))
                    .map((g) => ({
                        id: g.id || null,
                        scope: g.scope,
                        text: cleanText(g.text, 160),
                        // lowercased on both sides, or a dedupe key minted by
                        // addGoal stops matching the one that came off disk.
                        kind: g.kind ? cleanText(g.kind, 32).toLowerCase() : null,
                        targetId: g.targetId ? cleanText(g.targetId, 96) : null,
                        state: GOAL_STATES.has(g.state) ? g.state : 'open',
                        createdAt: Number.isFinite(g.createdAt) ? g.createdAt : Date.now(),
                        updatedAt: Number.isFinite(g.updatedAt) ? g.updatedAt : Date.now(),
                        progressNote: g.progressNote ? cleanText(g.progressNote, 120) : null,
                        attempts: Number.isFinite(g.attempts) ? g.attempts : 0,
                        // ⚠ THIS MAP IS A WHITELIST, so a field added to addGoal
                        // and not added here is written to disk and silently
                        // dropped at every restart - which is precisely the bug
                        // `resume` exists to fix, one layer down. `visited` and
                        // `claims` were lost that way for weeks.
                        resume: cleanResume(g.resume),
                        lastRunAt: Number.isFinite(g.lastRunAt) ? g.lastRunAt : 0
                    }));
                for (const goal of this.data.goals) {
                    if (!goal.id) { goal.id = this._mintId('g', this.data.goals); changedOnLoad = true; }
                }
                for (const scope of GOAL_SCOPES) if (this._evictGoals(scope)) changedOnLoad = true;

                // ⚠ MUST RUN AFTER `settlements` IS RESTORED - the prune asks which
                // settlements still exist, and against an empty list it would delete
                // every upgrade plan in the file.
                if (this._restoreSettlementUpgrades(parsed.settlementUpgrades)) changedOnLoad = true;

                if (changedOnLoad) this._save();
                // older memory files predate the tally; start it at zero rather
                // than inventing a history she never lived.
                const t = parsed.tally && typeof parsed.tally === 'object' ? parsed.tally : {};
                this.data.tally = {
                    breadBaked: Number.isFinite(t.breadBaked) ? t.breadBaked : 0,
                    ovensInstalled: Number.isFinite(t.ovensInstalled) ? t.ovensInstalled : 0,
                    fuelRuns: Number.isFinite(t.fuelRuns) ? t.fuelRuns : 0,
                    comfortsPlaced: Number.isFinite(t.comfortsPlaced) ? t.comfortsPlaced : 0,
                    gearBanked: Number.isFinite(t.gearBanked) ? t.gearBanked : 0
                };
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn(`[minecraft-memory] unable to load memory: ${err.message}`);
                // a truncated file used to escalate into TOTAL loss: the catch left
                // the empty constructor defaults in place and the next record flushed
                // them straight over her journal, landmarks, home and settlements.
                // keep the damaged copy so the history is recoverable by hand.
                try {
                    const aside = `${this.filePath}.corrupt-${Date.now()}`;
                    fs.renameSync(this.filePath, aside);
                    console.warn(`[minecraft-memory] kept the unreadable file at ${aside}`);
                } catch { /* nothing left to save */ }
            }
        }
    }

    // debounced persistence: records mark dirty and one unref'd timer flushes the
    // batch. events burst exactly when gameplay is busiest (mining/combat/task
    // completions), and a synchronous full-file write per record was stalling the
    // same event loop burnt's chat/tts runs on. worst case a hard crash loses the
    // final ~1.5s of gameplay journal - acceptable for an enhancement.
    _save() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flush(); }, 1500);
        if (this._saveTimer.unref) this._saveTimer.unref();
    }

    flush() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            // the temp name carries pid+time because a FIXED sibling is shared by
            // every writer on this path (a restart racing the old process, a test on
            // the default path), and two interleaved write+rename pairs let one
            // process rename the other's half-written json over the real file - which
            // is precisely the corrupt load the guard above now has to clean up.
            const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            const fd = fs.openSync(temp, 'w');
            try {
                fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8');
                fs.fsyncSync(fd);   // rename is only atomic against a file that reached the disk
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temp, this.filePath);
        } catch (err) {
            // Memory is an enhancement, never a reason to stop playing.
            // Keep it dirty so the next record/explicit flush retries instead
            // of silently declaring an unwritten journal durable.
            this._dirty = true;
            console.warn(`[minecraft-memory] unable to save memory: ${err.message}`);
        }
    }

    record(kind, label, { action = null, target = null, position = null, dimension = null, details = null } = {}) {
        const entry = {
            at: Date.now(),
            kind: cleanText(kind, 32),
            label: cleanText(label),
            action: action ? cleanText(action, 32) : null,
            target: target ? cleanText(target, 80) : null,
            position: safePoint(position),
            dimension: dimension ? cleanText(dimension, 64) : null,
            details: details ? cleanText(details) : null
        };
        this.data.journal.push(entry);
        if (this.data.journal.length > MAX_JOURNAL) this.data.journal.shift();
        this._save();
        return entry;
    }

    recordLandmark(label, state = {}) {
        const point = safePoint(state.position);
        if (!point) return null;
        const entry = { at: Date.now(), label: cleanText(label), position: point, dimension: cleanText(state.dimension || 'overworld', 64) };
        // ⚠ scoped, like every other spatial ledger here. an unscoped landmark
        // puts the place she died on one server onto the map of every other.
        if (state.world) entry.world = cleanText(state.world, 64);
        const samePlace = this.data.landmarks.findIndex((old) => old.label === entry.label && old.dimension === entry.dimension &&
            !(entry.world && old.world && old.world !== entry.world) &&
            old.position && Math.abs(old.position.x - point.x) <= 8 && Math.abs(old.position.z - point.z) <= 8);
        if (samePlace >= 0) this.data.landmarks.splice(samePlace, 1);
        this.data.landmarks.push(entry);
        if (this.data.landmarks.length > MAX_LANDMARKS) this.data.landmarks.shift();
        this._save();
        return entry;
    }

    recordFailure(action, target, reason) {
        const entry = { at: Date.now(), action: cleanText(action, 32), target: cleanText(target || '', 80), reason: cleanText(reason) };
        this.data.failures.push(entry);
        if (this.data.failures.length > MAX_FAILURES) this.data.failures.shift();
        this.record('failure', `${entry.action}${entry.target ? ` ${entry.target}` : ''} failed`, { action: entry.action, target: entry.target, details: entry.reason });
        this._save();
        return entry;
    }

    failureCount(action, target, windowMs = 15 * 60 * 1000) {
        const now = Date.now();
        const normalizedAction = cleanText(action, 32);
        const normalizedTarget = cleanText(target || '', 80);
        return this.data.failures.filter((entry) => entry.action === normalizedAction && entry.target === normalizedTarget && now - entry.at <= windowMs).length;
    }

    // ---- food spots ---------------------------------------------------------
    // places she can go and EAT: fields she's walked past, berry patches, a
    // pasture with cows in it. altoclef replants what it harvests, so a field is
    // a renewable farm she can come back to - but only once it has grown back,
    // which is the whole reason these carry a clock.
    //
    // ⚠ A SPOT IS A PLACE, NOT A PROMISE. she walked to the same harvested field
    // over and over because this list was WRITE-ONLY: one recorder, one
    // nearest-picker, and eviction by age - which protected the dead field,
    // since walking past it refreshed its timestamp. every entry now has to be
    // able to say "there was nothing here", and be dropped when it says it
    // enough times.

    // ⚠ normalize BOTH sides. a raw `minecraft:overworld` on one side and a bare
    // `overworld` on the other is the same place, and comparing them raw is what
    // made a whole ledger of real spots unmatchable.
    // ⚠ A SPOT NEEDS AN IDENTITY THAT ITS POSITION CANNOT INVALIDATE. `recordFoodSpot`
    // moves `position` when it sees a bigger part of the same field, so a run tagged
    // by coordinates and failing after such a merge struck nothing at all - the
    // silent-miss version of the original bug. ids are stable for the entry's life.
    // time + per-instance sequence + a little noise. the sequence resets on
    // restart and backfilled ids all share one Date.now(), so two instances
    // loading in the same millisecond would otherwise mint the same ids.
    // every ledger whose entries get struck BY ID mints through here.
    _mintId(prefix, existing = []) {
        this._idSeq = (this._idSeq || 0) + 1;
        const id = `${prefix}${Date.now().toString(36)}${this._idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        return existing.some((e) => e && e.id === id) ? `${id}x` : id;
    }

    _newFoodSpotId() {
        return this._mintId('f', this.data.foodSpots);
    }

    getFoodSpotById(id) {
        const key = String(id || '');
        return key ? this.data.foodSpots.find((s) => s.id === key) || null : null;
    }

    _foodSpotAt(point, dim, kind, radius = FOOD_SPOT_MERGE_DIST) {
        const want = normalizeDimension(dim);
        return this.data.foodSpots.find((s) => s.kind === kind &&
            normalizeDimension(s.dimension) === want &&
            Math.hypot(s.position.x - point.x, s.position.z - point.z) <= radius);
    }

    // `ripe` is what she can harvest RIGHT NOW; `count` is how big the place is.
    // an older companion jar doesn't know the difference and sends no `ripe` at
    // all, which stays null - readers treat that as "unknown", never as zero.
    recordFoodSpot(kind, position, dimension = 'overworld', { count = 0, ripe = null, world = null } = {}) {
        const type = cleanText(kind, 24).toLowerCase();
        if (!FOOD_SPOT_KINDS[type]) return null;
        const point = safePoint(position);
        if (!point) return null;
        // normalize on the WAY IN as well as the way out. the readers strip
        // `minecraft:` and the writer used to keep it, so a companion that sent a
        // bare `overworld` created a second entry for a field she already knew.
        const dim = normalizeDimension(dimension);
        const existing = this._foodSpotAt(point, dim, type);
        if (existing) {
            existing.at = Date.now();
            if (world) existing.world = cleanText(world, 64);
            if (ripe != null) {
                existing.ripe = Math.max(0, ripe | 0);
                // seeing something harvestable is the only thing that clears the
                // regrow clock and the miss streak. a spot cannot recover just by
                // being walked past, or the depleted field never expires.
                if (existing.ripe > 0) { existing.emptyAt = null; existing.misses = 0; existing.everRipe = true; }
            }
            if (count > (existing.count || 0)) { existing.count = count; existing.position = point; }
            this._save();
            return existing;
        }
        const entry = {
            id: this._newFoodSpotId(),
            at: Date.now(), kind: type, position: point, dimension: dim,
            count: Math.max(0, count | 0), ripe: ripe == null ? null : Math.max(0, ripe | 0),
            everRipe: ripe > 0, emptyAt: null, misses: 0
        };
        if (world) entry.world = cleanText(world, 64);
        this.data.foodSpots.push(entry);
        this._evictFoodSpot();
        this._save();
        return entry;
    }

    // ⚠ EVICT THE CHEAPEST ENTRY, NOT THE OLDEST. a plain FIFO drops by insertion
    // order, and pastures are recorded wherever animals happen to be standing - so
    // an afternoon of walking would fill all 24 slots with herds and quietly evict
    // the one wheat field the bread pipeline exists to use.
    //
    // ⚠ AND IT RANKS ON `everRipe`, NOT THE LIVE READING. scoring the live `ripe`
    // meant HARVESTING a field lowered its value - noteFoodSpotEmpty sets ripe to
    // 0, so her home field dropped below a patch she had never once used, and on a
    // jar that cannot report ripeness at all every crop tied and it degenerated
    // back into the FIFO this replaced. `everRipe` is sticky: proof she has seen
    // food there, which harvesting it does not undo.
    _foodSpotValue(spot) {
        if (spot.kind === 'animals') return 0;
        // a wheat field outranks a beetroot patch because the bread pipeline asks
        // for wheat first by construction - losing it costs her more.
        return 2 + (spot.everRipe ? 1 : 0) + (FOOD_SPOT_KINDS[spot.kind]?.bakeable ? 1 : 0);
    }

    _evictFoodSpot() {
        let removed = false;
        while (this.data.foodSpots.length > MAX_FOOD_SPOTS) {
            let worstIdx = 0;
            let worstScore = Infinity;
            for (let i = 0; i < this.data.foodSpots.length; i++) {
                const s = this.data.foodSpots[i];
                const score = this._foodSpotValue(s);
                if (score < worstScore || (score === worstScore && (s.at || 0) < (this.data.foodSpots[worstIdx].at || 0))) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            this.data.foodSpots.splice(worstIdx, 1);
            removed = true;
        }
        return removed;
    }

    // she went, and there was nothing to take. starts the regrow clock, and after
    // FOOD_SPOT_DROP_MISSES straight bare trips forgets the place entirely -
    // three empties in a row is not a growth cycle, it's a claimed farm or ground
    // she misread on the way past.
    //
    // returns 'regrowing' | 'forgotten' | null so the caller can say which.
    //
    // ⚠ A MISS IS A TRIP, NOT A TICK. telemetry arrives every ~2s, so counting
    // every bare reading would burn the whole three-strike budget in six seconds
    // of standing still - the streak is meant to catch a field that is empty on
    // three separate VISITS, which is a different claim entirely.
    //
    // ⚠ AND IT IS A TIGHTER RADIUS THAN THE MERGE. the companion only sees 8 blocks,
    // so "nothing ripe here" is a claim about 8 blocks - applied at the 24-block
    // merge radius it lets a few seedlings by the house strike a real field she is
    // nowhere near, and three of those delete it. she may only report on ground she
    // can actually see.
    noteFoodSpotEmpty(position, dimension = 'overworld', kind = null, radius = EMPTY_NOTE_RADIUS, { reported = false } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const now = Date.now();
        const dim = normalizeDimension(dimension);
        const kinds = kind ? [cleanText(kind, 24).toLowerCase()] : Object.keys(FOOD_SPOT_KINDS);
        let result = null;
        for (const k of kinds) {
            const verdict = this._markSpotEmpty(this._foodSpotAt(point, dim, k, radius), now, { reported });
            if (verdict === 'forgotten' || !result) result = verdict || result;
        }
        if (result) this._save();
        return result;
    }

    // the same verdict, for a run that was DISPATCHED to a known spot. this is the
    // failure witness's door: it names the entry outright instead of guessing from
    // where her body ended up, which is both more accurate (a stalled goal is
    // aborted up to LOOP_CONFINE_RADIUS away) and safer (a `get wheat` that failed
    // near her homestead for unrelated reasons is not evidence against her field).
    noteFoodSpotEmptyById(id, now = Date.now()) {
        const result = this._markSpotEmpty(this.getFoodSpotById(id), now);
        if (result) this._save();
        return result;
    }

    // `reported` = somebody TOLD her, rather than her own eyes or her own failed
    // trip. it may start the regrow clock, but it may never spend the last strike:
    // forgetting a place for good has to rest on something she experienced, or one
    // confident stranger can delete a farm she has used for weeks.
    _markSpotEmpty(spot, now = Date.now(), { reported = false } = {}) {
        if (!spot) return null;
        const restating = spot.emptyAt && now - spot.emptyAt < EMPTY_NOTE_DEBOUNCE_MS;
        spot.emptyAt = now;
        spot.ripe = 0;
        // she was just there, so it is not a STALE entry - keep it fresh for the
        // eviction tie-break. the miss streak, not age, is what retires it.
        spot.at = now;
        if (restating) return 'regrowing';
        const next = (spot.misses || 0) + 1;
        if (reported) {
            spot.misses = Math.min(next, FOOD_SPOT_DROP_MISSES - 1);
            return 'regrowing';
        }
        spot.misses = next;
        if (spot.misses >= FOOD_SPOT_DROP_MISSES) {
            this.data.foodSpots = this.data.foodSpots.filter((s) => s !== spot);
            return 'forgotten';
        }
        return 'regrowing';
    }

    // is this place worth the walk yet? a spot inside its own regrow window is
    // not a candidate - that window IS the fix for the "goes to the depleted
    // wheat spot" loop.
    foodSpotIsReady(spot, now = Date.now()) {
        if (!spot || !FOOD_SPOT_KINDS[spot.kind]) return false;
        if (!spot.emptyAt) return true;
        return now - spot.emptyAt >= FOOD_SPOT_KINDS[spot.kind].regrow;
    }

    // the explicit forget. `near` + `radius` removes the field she is standing in;
    // `kind` alone wipes a whole category; neither means everything. this is the
    // lever a viewer or her own brain pulls when the memory is simply wrong, and
    // it does NOT wait for a miss streak.
    removeFoodSpots({ near = null, dimension = null, radius = FOOD_SPOT_MERGE_DIST, kind = null, world = null, all = false } = {}) {
        const before = this.data.foodSpots.length;
        const type = kind ? cleanText(kind, 24).toLowerCase() : null;
        const point = near ? safePoint(near) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        if (!all && !point && !type) return 0;
        const here = world ? cleanText(world, 64) : null;
        this.data.foodSpots = this.data.foodSpots.filter((s) => {
            if (type && s.kind !== type) return true;
            if (dim && normalizeDimension(s.dimension) !== dim) return true;
            // a wipe-by-kind must not reach across servers: "forget the wheat" said
            // on one server should not delete the fields she found on another.
            if (here && s.world && s.world !== here) return true;
            if (point && Math.hypot(s.position.x - point.x, s.position.z - point.z) > radius) return true;
            return false;
        });
        const removed = before - this.data.foodSpots.length;
        if (removed) this._save();
        return removed;
    }

    getFoodSpots() {
        return Array.isArray(this.data.foodSpots) ? this.data.foodSpots : [];
    }

    // --- wheat-shaped wrappers ------------------------------------------------
    // the bread pipeline still thinks in wheat, and so does everything that reads
    // her context. these keep that vocabulary without a second store behind it.

    recordWheatSpot(position, dimension = 'overworld', count = 0, ripe = null) {
        return this.recordFoodSpot('wheat', position, dimension, { count, ripe });
    }

    // --- death spot (where her stuff is) --------------------------------------
    // servers with a grave/corpse mod keep a lootable body where you died, so the
    // spot is worth remembering and walking back to. vanilla drops despawn, so the
    // caller decides whether it's still worth the trip.
    recordDeathSpot(position, dimension = 'overworld') {
        const point = safePoint(position);
        if (!point) return null;
        this.data.deathSpot = {
            at: Date.now(),
            position: point,
            dimension: cleanText(dimension || 'overworld', 64),
            looted: false
        };
        this._save();
        return this.data.deathSpot;
    }

    getDeathSpot() {
        const spot = this.data.deathSpot;
        return spot && spot.position && !spot.looted ? spot : null;
    }

    clearDeathSpot() {
        if (!this.data.deathSpot) return false;
        this.data.deathSpot = null;
        this._save();
        return true;
    }

    // ---- places -------------------------------------------------------------
    // THE GENERAL PLACE RECORD, and the only ledger in this file that is not
    // about getting something. food/ore/stores/quarries all answer "where do i
    // go for X", so anywhere with no use - the ravine with the lava fall in it,
    // the ridge the sun comes over, the flat ugly bit she keeps ending up in -
    // had nowhere to live and was gone the moment she walked out of it.
    //
    // ⚠ KEYED BY FEATURES, NOT BY KIND. a `kind` field needs a taxonomy of
    // every interesting thing a world can hold, and the places worth
    // remembering are exactly the ones the taxonomy has no word for. features
    // are just what was true of the ground while she stood on it, so a place
    // she cannot name is still findable later.
    //
    // ⚠ A NAME IS OPTIONAL AND A NAME IS EVERYTHING. most entries are written
    // by walking into them; naming is what SHE or a viewer does afterwards, and
    // it is most of _placeValue. recording only named places would mean she can
    // only remember somewhere she already had a word for, which is backwards.
    _newPlaceId() {
        return this._mintId('p', this.data.places);
    }

    getPlaceById(id) {
        const key = String(id || '');
        return key ? this.data.places.find((p) => p.id === key) || null : null;
    }

    // features are free-form on purpose: her brain and the people she plays
    // with will describe things this file has never heard of, and rejecting an
    // unknown word would throw away the only description that exists. the
    // vocabulary in PLACE_FEATURES is for PROSE and for what the observer can
    // derive on its own, never a whitelist.
    _cleanFeatures(features) {
        if (!Array.isArray(features)) return [];
        const out = [];
        for (const raw of features) {
            const f = cleanText(raw, 24).toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim().replace(/\s+/g, '_');
            if (f && !out.includes(f)) out.push(f);
            if (out.length >= MAX_PLACE_FEATURES) break;
        }
        return out;
    }

    _placeAt(point, dim, world, radius = PLACE_MERGE_DIST) {
        const want = normalizeDimension(dim);
        const here = world ? cleanText(world, 64) : null;
        return this.data.places.find((p) => normalizeDimension(p.dimension) === want &&
            // an entry with no world predates the field and matches anything, so
            // legacy places stay mergeable instead of quietly doubling up.
            !(here && p.world && p.world !== here) &&
            Math.hypot(p.position.x - point.x, p.position.z - point.z) <= radius);
    }

    // walking into somewhere is the common case, so this MERGES by default -
    // one entry per locale, gaining detail every time she passes through. a
    // second entry for ground she already knows is how a 40-slot ledger fills
    // with one hillside.
    recordPlace(position, dimension = 'overworld', {
        world = null, biome = null, features = [], shape = null,
        name = null, note = null, source = 'seen'
    } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        const feats = this._cleanFeatures(features);
        const cleanName = name ? cleanText(name, 48) : null;
        const cleanNote = note ? cleanText(note, 160) : null;
        const cleanBiome = biome ? cleanText(biome, 48).toLowerCase().replace(/^minecraft:/, '') : null;
        const existing = this._placeAt(point, dim, world);
        if (existing) {
            existing.lastSeenAt = Date.now();
            existing.visits = (existing.visits || 1) + 1;
            if (world && !existing.world) existing.world = cleanText(world, 64);
            if (cleanBiome) existing.biome = cleanBiome;
            if (shape) existing.shape = cleanText(shape, 24).toLowerCase();
            // ⚠ NEVER let a later sighting erase a name or a note. the observer
            // passes neither, and it fires every time she walks past - so an
            // unconditional assign would wipe the one thing that made the entry
            // worth keeping, on the very next lap.
            if (cleanName) { existing.name = cleanName; existing.source = 'named'; }
            if (cleanNote) existing.note = cleanNote;
            // union, so a place seen at night and again at noon keeps both readings
            if (feats.length) {
                existing.features = this._cleanFeatures([...(existing.features || []), ...feats]);
            }
            this._save();
            return existing;
        }
        const entry = {
            id: this._newPlaceId(),
            name: cleanName,
            position: point,
            dimension: dim,
            biome: cleanBiome,
            features: feats,
            shape: shape ? cleanText(shape, 24).toLowerCase() : null,
            note: cleanNote,
            source: cleanName ? 'named' : cleanText(source, 16).toLowerCase(),
            visits: 1,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now()
        };
        if (world) entry.world = cleanText(world, 64);
        this.data.places.push(entry);
        this._evictPlace();
        this._save();
        return entry;
    }

    // ⚠ BY VALUE, NEVER FIFO - the same rule the food ledger had to learn. she
    // walks through far more bare ground than interesting ground, so insertion
    // order evicts precisely the named place she has been coming back to for a
    // week and keeps the last forty featureless hillsides.
    _placeValue(place) {
        if (!place) return 0;
        let score = 0;
        if (place.name) score += 6;                     // somebody gave it a word
        if (place.note) score += 2;
        if (place.source === 'told') score += 1;        // a person bothered to say it
        score += Math.min(4, (place.features || []).length);
        // returning to somewhere is evidence about the place, not about the clock
        score += Math.min(3, Math.max(0, (place.visits || 1) - 1));
        return score;
    }

    _evictPlace() {
        let removed = false;
        while (this.data.places.length > MAX_PLACES) {
            let worstIdx = 0;
            let worstScore = Infinity;
            for (let i = 0; i < this.data.places.length; i++) {
                const p = this.data.places[i];
                const score = this._placeValue(p);
                if (score < worstScore ||
                    (score === worstScore && (p.lastSeenAt || 0) < (this.data.places[worstIdx].lastSeenAt || 0))) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            this.data.places.splice(worstIdx, 1);
            removed = true;
        }
        return removed;
    }

    // naming somewhere she is standing, or somewhere she already knows. this is
    // the difference between a log of ground and a map with words on it.
    namePlace(id, name, { note = null, source = 'named' } = {}) {
        const place = this.getPlaceById(id);
        if (!place) return null;
        const cleanName = name ? cleanText(name, 48) : null;
        if (cleanName) place.name = cleanName;
        if (note) place.note = cleanText(note, 160);
        place.source = cleanText(source, 16).toLowerCase();
        place.lastSeenAt = Date.now();
        this._save();
        return place;
    }

    addPlaceFeatures(id, features) {
        const place = this.getPlaceById(id);
        if (!place) return null;
        const feats = this._cleanFeatures(features);
        if (!feats.length) return place;
        place.features = this._cleanFeatures([...(place.features || []), ...feats]);
        place.lastSeenAt = Date.now();
        this._save();
        return place;
    }

    // ⚠ STRUCK BY ID, never by coordinates - `recordPlace` moves nothing today,
    // but the food ledger proved that a coordinate handle issued before a merge
    // matches nothing after it and the strike vanishes without a word.
    forgetPlace(id) {
        const key = String(id || '');
        const before = this.data.places.length;
        this.data.places = this.data.places.filter((p) => p.id !== key);
        const removed = this.data.places.length !== before;
        if (removed) this._save();
        return removed;
    }

    getPlaces() {
        return Array.isArray(this.data.places) ? this.data.places : [];
    }

    // the label a place is spoken by. an unnamed place is described by what is
    // actually there, which is the whole point of storing features - "cliff +
    // lava" is a usable handle and "place #7" is not.
    placeLabel(place) {
        if (!place) return null;
        if (place.name) return place.name;
        const feats = (place.features || []).slice(0, 2).map((f) => PLACE_FEATURES[f] || f.replace(/_/g, ' '));
        if (feats.length) return feats.join(' + ');
        return place.biome ? place.biome.replace(/_/g, ' ') : null;
    }

    nearestPlace(position, dimension = 'overworld', {
        world = null, features = null, named = false, minDistance = 0, maxDistance = Infinity, exclude = null
    } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        const here = world ? cleanText(world, 64) : null;
        const want = features ? this._cleanFeatures(features) : null;
        const skip = exclude ? new Set([].concat(exclude)) : null;
        let best = null;
        let bestD = Infinity;
        for (const p of this.data.places) {
            if (normalizeDimension(p.dimension) !== dim) continue;
            // somewhere on another server is not somewhere she can walk to.
            if (here && p.world && p.world !== here) continue;
            if (named && !p.name) continue;
            if (skip && skip.has(p.id)) continue;
            if (want && !want.every((f) => (p.features || []).includes(f))) continue;
            const d = Math.hypot(p.position.x - point.x, p.position.z - point.z);
            if (d < minDistance || d > maxDistance) continue;
            if (d < bestD) { bestD = d; best = p; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    // free-text lookup for "go back to the lava ravine" - matches a name first,
    // then a feature word, so a viewer who half-remembers still gets there.
    findPlace(query, { world = null, dimension = null } = {}) {
        const q = cleanText(query, 48).toLowerCase().trim();
        if (!q) return null;
        const here = world ? cleanText(world, 64) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        const pool = this.data.places.filter((p) => {
            if (here && p.world && p.world !== here) return false;
            if (dim && normalizeDimension(p.dimension) !== dim) return false;
            return true;
        });
        const byName = pool.filter((p) => p.name && p.name.toLowerCase() === q);
        if (byName.length) return byName[byName.length - 1];
        const partial = pool.filter((p) => p.name && (p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase())));
        if (partial.length) return partial[partial.length - 1];
        const token = q.replace(/\s+/g, '_');
        const byFeature = pool.filter((p) => (p.features || []).some((f) => f === token || f.includes(token)));
        if (byFeature.length) {
            // the most-visited match, so a word that fits three places picks the
            // one she actually knows rather than whichever sorted first.
            return byFeature.slice().sort((a, b) => (b.visits || 0) - (a.visits || 0))[0];
        }
        return null;
    }

    // NEAREST first with live distances, like every other *Context in this file -
    // a list ordered by when she happened to walk past is not a map.
    placesContext(position, max = 4, dimension = null, world = null) {
        const point = safePoint(position);
        const dim = dimension ? normalizeDimension(dimension) : null;
        const here = world ? cleanText(world, 64) : null;
        return this.data.places
            .filter((p) => {
                if (dim && normalizeDimension(p.dimension) !== dim) return false;
                if (here && p.world && p.world !== here) return false;
                // somewhere with no name and nothing true about it teaches her
                // nothing and costs a line of prompt. it stays on disk (it still
                // means "i have been here"), it just does not get spoken.
                return !!(p.name || (p.features || []).length);
            })
            .map((p) => ({
                place: p,
                d: point ? Math.hypot(p.position.x - point.x, p.position.z - point.z) : Infinity
            }))
            .sort((a, b) => a.d - b.d)
            .slice(0, max)
            .map(({ place, d }) => {
                const feats = (place.features || []).slice(0, 3).map((f) => PLACE_FEATURES[f] || f.replace(/_/g, ' '));
                let line = `${this.placeLabel(place)} at ${place.position.x},${place.position.y},${place.position.z}`;
                line += ` (${normalizeDimension(place.dimension)})`;
                if (Number.isFinite(d)) line += ` ~${Math.round(d)}m`;
                // the features go in even when they made the label, because the
                // label only ever shows two and the third is often the reason.
                if (feats.length) line += ` - ${feats.join(', ')}`;
                if (place.note) line += ` - "${place.note}"`;
                return line;
            });
    }

    // ---- biomes she has actually been in -------------------------------------
    // tiny and cheap, and it buys the one thing places cannot: "i have never
    // seen this before". places are capped and evicted by value, so deriving
    // novelty from them would quietly start calling old ground new again the
    // moment the ledger turned over. this is a set, so it never lies about a
    // first time.
    _biomeKey(biome, world) {
        const b = cleanText(biome || '', 48).toLowerCase().replace(/^minecraft:/, '');
        if (!b) return null;
        return `${world ? cleanText(world, 64) : 'local'}|${b}`;
    }

    // returns true the FIRST time she stands in a biome on a given world.
    noteBiome(biome, world = null) {
        const key = this._biomeKey(biome, world);
        if (!key) return false;
        if (!this.data.biomes || typeof this.data.biomes !== 'object') this.data.biomes = {};
        const now = Date.now();
        const existing = this.data.biomes[key];
        if (existing) {
            existing.last = now;
            existing.visits = (existing.visits || 1) + 1;
            this._save();
            return false;
        }
        const keys = Object.keys(this.data.biomes);
        if (keys.length >= MAX_BIOMES) delete this.data.biomes[keys[0]];
        this.data.biomes[key] = { first: now, last: now, visits: 1 };
        this._save();
        return true;
    }

    hasSeenBiome(biome, world = null) {
        const key = this._biomeKey(biome, world);
        return !!(key && this.data.biomes && this.data.biomes[key]);
    }

    // how much of this world she has actually walked in, as a count of biomes.
    biomeCount(world = null) {
        const prefix = `${world ? cleanText(world, 64) : 'local'}|`;
        return Object.keys(this.data.biomes || {}).filter((k) => k.startsWith(prefix)).length;
    }

    // ---- the bestiary: creatures she has actually stood near --------------------
    // deliberately the same shape as biomes above, for the same reason: it is a
    // SET, so it cannot lie about a first time. everything else about a mob is
    // transient (the count in her prompt, the threat gating, the defense chain)
    // and none of it survives a restart - so without this, the four hundredth
    // enderman and the first are indistinguishable to her.
    _creatureKey(type, world) {
        const t = cleanText(type || '', 48).toLowerCase().replace(/^minecraft:/, '');
        if (!t) return null;
        return `${world ? cleanText(world, 64) : 'local'}|${t}`;
    }

    // batch, because the caller has a whole bubble of them every 2 seconds.
    // returns the types that are genuinely new on this world, in the order given.
    // ⚠ ONE _save() FOR THE WHOLE BATCH, and only when something actually
    // changed: a per-type save against 2-second telemetry is a file rewrite
    // several times a second for a timestamp at 5-minute resolution.
    noteCreatures(types, world = null) {
        if (!Array.isArray(types) || !types.length) return [];
        if (!this.data.creatures || typeof this.data.creatures !== 'object') this.data.creatures = {};
        const now = Date.now();
        const fresh = [];
        let changed = false;
        for (const type of types) {
            const key = this._creatureKey(type, world);
            if (!key) continue;
            const existing = this.data.creatures[key];
            if (existing) {
                existing.seen = (existing.seen || 1) + 1;
                if (now - (existing.last || 0) >= CREATURE_TOUCH_DEBOUNCE_MS) {
                    existing.last = now;
                    changed = true;
                }
                continue;
            }
            const keys = Object.keys(this.data.creatures);
            if (keys.length >= MAX_CREATURES) delete this.data.creatures[keys[0]];
            this.data.creatures[key] = { first: now, last: now, seen: 1 };
            fresh.push(cleanText(type, 48).toLowerCase().replace(/^minecraft:/, ''));
            changed = true;
        }
        if (changed) this._save();
        return fresh;
    }

    hasSeenCreature(type, world = null) {
        const key = this._creatureKey(type, world);
        return !!(key && this.data.creatures && this.data.creatures[key]);
    }

    // how many times she has been near this kind, ever, on this world. the
    // difference between "the second one" and "the two hundredth" is the
    // difference between a line worth saying and filler.
    creatureSeenCount(type, world = null) {
        const key = this._creatureKey(type, world);
        const entry = key && this.data.creatures ? this.data.creatures[key] : null;
        return entry ? (entry.seen || 1) : 0;
    }

    // how many kinds of creature she has actually met here - the bestiary's
    // answer to biomeCount, and the number that makes a first sighting land.
    creatureCount(world = null) {
        const prefix = `${world ? cleanText(world, 64) : 'local'}|`;
        return Object.keys(this.data.creatures || {}).filter((k) => k.startsWith(prefix)).length;
    }

    // --- terrain (where the water is) -----------------------------------------
    // one entry per 64-block cell, 'wet' or 'dry'. persisted so she stops
    // re-discovering the same ocean by swimming into it after every restart.
    getTerrain() {
        return this.data.terrain || {};
    }

    // only writes when the cell is genuinely new or has flipped, so the common
    // case (walking around ground she already knows) never touches disk.
    recordTerrainCell(key, wet) {
        const k = cleanText(key, 32);
        if (!k) return false;
        if (!this.data.terrain || typeof this.data.terrain !== 'object') this.data.terrain = {};
        const value = wet ? 'wet' : 'dry';
        if (this.data.terrain[k] === value) return false;
        const keys = Object.keys(this.data.terrain);
        if (keys.length >= MAX_TERRAIN_CELLS && this.data.terrain[k] === undefined) {
            // drop an arbitrary old cell rather than growing without bound; the
            // map is a hint, not a survey.
            delete this.data.terrain[keys[0]];
        }
        this.data.terrain[k] = value;
        this._save();
        return true;
    }

    // land the server refused to let her touch. keyed by the same coarse cell as
    // terrain so the two maps line up. deliberately NO expiry: terrain is a hint that
    // can be wrong, but a claim does not unclaim itself, and forgetting one just walks
    // her back into the same denial - which is how she ended up ping-ponging between
    // two "unclaimed land" spots forever.
    getClaimedAreas() {
        return this.data.claims || {};
    }

    recordClaimedArea(key) {
        const k = cleanText(key, 32);
        if (!k) return false;
        if (!this.data.claims || typeof this.data.claims !== 'object') this.data.claims = {};
        if (this.data.claims[k]) return false;   // already known - don't touch disk
        const keys = Object.keys(this.data.claims);
        if (keys.length >= MAX_CLAIMED_CELLS) delete this.data.claims[keys[0]];
        this.data.claims[k] = Date.now();
        this._save();
        return true;
    }

    // ground she has already gone and looked at. NOT a claim (she may be perfectly
    // welcome there) - just "i have been sent here before", which is what stops her
    // re-checking the same land after a restart. kept as a flat list because the
    // reader matches by radius, not by cell.
    // ⚠ SCOPED, and it was not. "i have already looked here" is a claim about a
    // stretch of ground on ONE world - unscoped, coordinate 500,3400 on a server
    // marked the same square as 500,3400 in a singleplayer save, and the nether's
    // 8:1 grid overlapped the overworld's. no filter given means "everything",
    // so old callers and legacy rows behave exactly as before.
    getVisitedSpots({ world = null, dimension = null } = {}) {
        const list = Array.isArray(this.data.visited) ? this.data.visited : [];
        if (!world && !dimension) return list;
        const here = world ? cleanText(world, 64) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        return list.filter((v) => {
            // an entry with no world predates the scoping and counts anywhere,
            // the same convention every other ledger here uses for legacy rows.
            if (here && v.world && v.world !== here) return false;
            if (dim && v.dimension && v.dimension !== dim) return false;
            return true;
        });
    }

    recordVisitedSpot(x, z, at = Date.now(), { world = null, dimension = null } = {}) {
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
        if (!Array.isArray(this.data.visited)) this.data.visited = [];
        const here = world ? cleanText(world, 64) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        // one slot per PLACE: refresh a nearby entry rather than appending a second,
        // or a cap-sized ring quietly evicts the very spot she keeps returning to.
        for (const v of this.data.visited) {
            // ...but only merge with somewhere that is actually the same place.
            // without this a walk on one server refreshes - and so protects from
            // eviction - a spot on another world with matching coordinates.
            if (here && v.world && v.world !== here) continue;
            if (dim && v.dimension && v.dimension !== dim) continue;
            if (Math.hypot(px - v.x, pz - v.z) < VISITED_MERGE_RADIUS) {
                v.at = at;
                if (here && !v.world) v.world = here;
                if (dim && !v.dimension) v.dimension = dim;
                this._save();
                return true;
            }
        }
        const entry = { x: Math.round(px), z: Math.round(pz), at };
        if (here) entry.world = here;
        if (dim) entry.dimension = dim;
        this.data.visited.push(entry);
        while (this.data.visited.length > MAX_VISITED_SPOTS) this.data.visited.shift();
        this._save();
        return true;
    }

    // the nearest place of these kinds she can actually eat from right now.
    // `includeRegrowing` is for the context line, which should still be able to
    // say "that field is coming back" - never for the picker, which is what used
    // to march her into a bare field on a loop.
    nearestFoodSpot(position, dimension = 'overworld', { kinds = null, includeRegrowing = false, world = null, now = Date.now() } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        const here = world ? cleanText(world, 64) : null;
        const want = kinds ? new Set(kinds.map((k) => String(k).toLowerCase())) : null;
        let best = null;
        let bestD = Infinity;
        for (const s of this.data.foodSpots) {
            if (normalizeDimension(s.dimension) !== dim) continue;
            // a field on another server is not a place she can walk to. an entry
            // with no world recorded predates the field and matches anything -
            // legacy spots stay usable rather than silently vanishing.
            if (here && s.world && s.world !== here) continue;
            if (want && !want.has(s.kind)) continue;
            if (!includeRegrowing && !this.foodSpotIsReady(s, now)) continue;
            const d = Math.hypot(s.position.x - point.x, s.position.z - point.z);
            if (d < bestD) { bestD = d; best = s; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    nearestWheatSpot(position, dimension = 'overworld', opts = {}) {
        return this.nearestFoodSpot(position, dimension, { ...opts, kinds: ['wheat'] });
    }

    // NEAREST first, not most-recently-appended: the old `slice(-max)` showed her
    // the last three fields she happened to walk past, which on a long trip is
    // three places on the other side of the world.
    foodSpotsContext(currentPosition = null, max = 3, dimension = null) {
        const now = Date.now();
        const here = currentPosition && Number.isFinite(currentPosition.x) ? currentPosition : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        return this.data.foodSpots
            .filter((s) => !dim || normalizeDimension(s.dimension) === dim)
            .map((s) => ({ s, d: here ? Math.hypot(here.x - s.position.x, here.z - s.position.z) : 0 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, max)
            .map(({ s, d }) => {
                const label = FOOD_SPOT_KINDS[s.kind]?.label || s.kind;
                let line = `${label} at ${s.position.x},${s.position.y},${s.position.z} (${normalizeDimension(s.dimension)})`;
                if (here) line += ` ~${Math.round(d)}m`;
                if (!this.foodSpotIsReady(s, now)) {
                    const mins = Math.max(1, Math.ceil((FOOD_SPOT_KINDS[s.kind].regrow - (now - s.emptyAt)) / 60000));
                    line += ` [picked clean, ~${mins}m to regrow]`;
                }
                return line;
            });
    }

    wheatSpotsContext(currentPosition = null, max = 3) {
        return this.foodSpotsContext(currentPosition, max);
    }

    // ---- ore spots ----------------------------------------------------------
    // where to mine. built on the food ledger's hard-won shape - stable ids,
    // strike-by-id, debounced misses, eviction by value - with the one honest
    // difference: no regrow clock, because a vein does not grow back. `depleted`
    // takes a struck spot out of the picker IMMEDIATELY, so she never walks to a
    // hole a second time while it sits out the rest of its strikes.

    getOreSpotById(id) {
        const key = String(id || '');
        return key ? this.data.oreSpots.find((s) => s.id === key) || null : null;
    }

    _oreSpotAt(point, dim, kind, radius = ORE_SPOT_MERGE_DIST) {
        const want = normalizeDimension(dim);
        return this.data.oreSpots.find((s) => s.kind === kind &&
            normalizeDimension(s.dimension) === want &&
            Math.hypot(s.position.x - point.x, s.position.z - point.z) <= radius &&
            Math.abs(s.position.y - point.y) <= radius);
    }

    // recording ore at a place is a POSITIVE OBSERVATION - she is looking at ore
    // blocks - so it revives a struck spot, the same way seeing something ripe
    // revives a field.
    // ⚠ but not inside the debounce window. a failed run strikes the spot and the
    // block scan re-reports the same visible vein two seconds later; without this
    // guard those two readings revive each other forever and the strike can never
    // land. a vein still SEEN after the window is real evidence; one seen in the
    // same breath as the failure is the reading that just failed.
    recordOreSpot(kind, position, dimension = 'overworld', { count = 0, world = null } = {}) {
        const type = normalizeOreKind(kind);
        if (!type) return null;
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        const now = Date.now();
        const existing = this._oreSpotAt(point, dim, type);
        if (existing) {
            existing.at = now;
            if (world) existing.world = cleanText(world, 64);
            if (!existing.emptyAt || now - existing.emptyAt >= EMPTY_NOTE_DEBOUNCE_MS) {
                existing.depleted = false;
                existing.misses = 0;
                existing.emptyAt = null;
            }
            // a bigger reading is a better description of the same seam, so the
            // entry moves onto it. this is exactly why callers must strike by id.
            if (count > (existing.count || 0)) { existing.count = count; existing.position = point; }
            this._save();
            return existing;
        }
        const entry = {
            id: this._mintId('o', this.data.oreSpots),
            at: now, kind: type, position: point, dimension: dim,
            world: world ? cleanText(world, 64) : null,
            count: Math.max(0, count | 0), depleted: false, misses: 0,
            emptyAt: null, lastMinedAt: null
        };
        this.data.oreSpots.push(entry);
        this._evictOreSpot();
        this._save();
        return entry;
    }

    // she actually took something out of it. keeps the place fresh for the
    // eviction tie-break and gives the context line something true to say.
    noteOreSpotMined(id, { count = null } = {}) {
        const spot = this.getOreSpotById(id);
        if (!spot) return null;
        const now = Date.now();
        spot.lastMinedAt = now;
        spot.at = now;
        // mining it is proof there was ore there, so the streak resets - a spot is
        // only ever retired by coming up EMPTY.
        spot.misses = 0;
        spot.depleted = false;
        spot.emptyAt = null;
        if (Number.isFinite(count)) spot.count = Math.max(0, count | 0);
        this._save();
        return spot;
    }

    // ⚠ EVICT THE CHEAPEST, NEVER THE OLDEST. a coal seam is reported from every
    // cave mouth she walks past; a FIFO would fill all 32 slots with coal and
    // quietly drop the one diamond spot she has ever found. `value` is a fixed
    // property of the kind, so mining a vein cannot lower the worth of the only
    // place she has proved has ore in it.
    _oreSpotValue(spot) {
        const base = ORE_SPOT_KINDS[spot.kind]?.value ?? 1;
        // a struck spot is worth less than a live one of the same kind, but still
        // more than a cheaper kind - it is on its way out via the miss streak.
        return base * 4 - (spot.depleted ? 1 : 0);
    }

    // returns whether anything was dropped, so a loader can tell a trim from a
    // no-op without diffing the array.
    _evictOreSpot() {
        let removed = false;
        while (this.data.oreSpots.length > MAX_ORE_SPOTS) {
            let worstIdx = 0;
            let worstScore = Infinity;
            for (let i = 0; i < this.data.oreSpots.length; i++) {
                const s = this.data.oreSpots[i];
                const score = this._oreSpotValue(s);
                if (score < worstScore || (score === worstScore && (s.at || 0) < (this.data.oreSpots[worstIdx].at || 0))) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            this.data.oreSpots.splice(worstIdx, 1);
            removed = true;
        }
        return removed;
    }

    // the failure witness's door: the run that was DISPATCHED to a spot names the
    // entry outright. never by proximity - recordOreSpot MOVES `position` onto a
    // bigger reading of the same seam, so a coordinate tag issued before that
    // merge matches nothing afterwards and the strike vanishes silently.
    // returns 'depleted' | 'forgotten' | null.
    // `reported` rides along because a viewer saying "that seam's dead" resolves
    // to a known entry too, and a claim she did not live must not be able to
    // delete a mine - see _markOreSpotEmpty.
    noteOreSpotEmptyById(id, now = Date.now(), { reported = false } = {}) {
        const result = this._markOreSpotEmpty(this.getOreSpotById(id), now, { reported });
        if (result) this._save();
        return result;
    }

    // the eyes-on version, for "there is nothing left in this hole" said about
    // ground she is standing in. same tight radius as the food ledger's: "nothing
    // here" is only ever a claim about what the companion scan can SEE.
    noteOreSpotEmpty(position, dimension = 'overworld', kind = null, radius = EMPTY_NOTE_RADIUS, { reported = false } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const now = Date.now();
        const dim = normalizeDimension(dimension);
        // a named kind that is not an ore is a claim about nothing - striking
        // every kind because the name was unreadable would be worse than useless.
        const kinds = kind ? [normalizeOreKind(kind)].filter(Boolean) : Object.keys(ORE_SPOT_KINDS);
        let result = null;
        for (const k of kinds) {
            const verdict = this._markOreSpotEmpty(this._oreSpotAt(point, dim, k, radius), now, { reported });
            if (verdict === 'forgotten' || !result) result = verdict || result;
        }
        if (result) this._save();
        return result;
    }

    // `reported` = somebody TOLD her. it may mark the spot dead for the picker,
    // but it may never spend the last strike: deleting a place for good has to
    // rest on something she experienced, or one confident stranger wipes the mine
    // she has been working all week.
    _markOreSpotEmpty(spot, now = Date.now(), { reported = false } = {}) {
        if (!spot) return null;
        const restating = spot.emptyAt && now - spot.emptyAt < EMPTY_NOTE_DEBOUNCE_MS;
        spot.emptyAt = now;
        spot.depleted = true;
        // she was just there, so the entry is not STALE - the miss streak, never
        // age, is what retires it.
        spot.at = now;
        if (restating) return 'depleted';
        const next = (spot.misses || 0) + 1;
        if (reported) {
            spot.misses = Math.min(next, ORE_SPOT_DROP_MISSES - 1);
            return 'depleted';
        }
        spot.misses = next;
        if (spot.misses >= ORE_SPOT_DROP_MISSES) {
            this.data.oreSpots = this.data.oreSpots.filter((s) => s !== spot);
            return 'forgotten';
        }
        return 'depleted';
    }

    getOreSpots() {
        return Array.isArray(this.data.oreSpots) ? this.data.oreSpots : [];
    }

    nearestOreSpot(position, dimension = 'overworld', { kinds = null, world = null, includeDepleted = false } = {}) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        const here = world ? cleanText(world, 64) : null;
        const want = kinds ? new Set(kinds.map(normalizeOreKind).filter(Boolean)) : null;
        // she asked for a kind that does not exist. answering with the nearest
        // anything would send her to mine coal because she said "tin".
        if (want && !want.size) return null;
        let best = null;
        let bestD = Infinity;
        for (const s of this.data.oreSpots) {
            if (normalizeDimension(s.dimension) !== dim) continue;
            // a seam on another server is not somewhere she can walk. an entry with
            // no world recorded predates the field and matches anything.
            if (here && s.world && s.world !== here) continue;
            if (want && !want.has(s.kind)) continue;
            if (!includeDepleted && s.depleted) continue;
            const d = Math.hypot(s.position.x - point.x, s.position.z - point.z);
            if (d < bestD) { bestD = d; best = s; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    // the explicit forget, for when the memory is simply wrong. does NOT wait for
    // a miss streak. `all` is the only way to wipe everything - a bare call is a
    // no-op rather than a catastrophe.
    removeOreSpots({ near = null, dimension = null, radius = ORE_SPOT_MERGE_DIST, kind = null, world = null, all = false } = {}) {
        const before = this.data.oreSpots.length;
        const type = kind ? normalizeOreKind(kind) : null;
        // ⚠ an unreadable kind must not DEGRADE into a wipe of everything near
        // her. "forget the tin round here" would otherwise delete the iron.
        if (kind && !type) return 0;
        const point = near ? safePoint(near) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        if (!all && !point && !type) return 0;
        const here = world ? cleanText(world, 64) : null;
        this.data.oreSpots = this.data.oreSpots.filter((s) => {
            if (type && s.kind !== type) return true;
            if (dim && normalizeDimension(s.dimension) !== dim) return true;
            // a wipe-by-kind must not reach across servers.
            if (here && s.world && s.world !== here) return true;
            if (point && Math.hypot(s.position.x - point.x, s.position.z - point.z) > radius) return true;
            return false;
        });
        const removed = before - this.data.oreSpots.length;
        if (removed) this._save();
        return removed;
    }

    // NEAREST first, like the food lines - the last few seams she happened to walk
    // past are, on a long trip, three places on the other side of the world.
    oreSpotsContext(currentPosition = null, max = 3, dimension = null) {
        const here = currentPosition && Number.isFinite(currentPosition.x) ? currentPosition : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        return this.data.oreSpots
            .filter((s) => !dim || normalizeDimension(s.dimension) === dim)
            .map((s) => ({ s, d: here ? Math.hypot(here.x - s.position.x, here.z - s.position.z) : 0 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, max)
            .map(({ s, d }) => {
                const label = ORE_SPOT_KINDS[s.kind]?.label || s.kind;
                let line = `${label} at ${s.position.x},${s.position.y},${s.position.z} (${normalizeDimension(s.dimension)})`;
                if (here) line += ` ~${Math.round(d)}m`;
                if (s.depleted) line += ' [mined out]';
                return line;
            });
    }

    // ---- stores (the pantry) ------------------------------------------------
    // WHAT SHE OWNS, as opposed to what she is holding. these are two different
    // questions and the whole feature turns on never letting them become one sum:
    // the loaf she hands a stranger has to be in her HAND, and the reason not to
    // farm another field is what is in her CHEST.

    // a container IS a block, so its identity is its block - no merge radius, no
    // moving position, none of the strike-by-id machinery the food ledger needs.
    _containerKey(dimension, x, y, z) {
        return `${normalizeDimension(dimension)}:${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
    }

    // one reading of one container. accepts the companion's wire shape
    // ({dim,x,y,z,type,items,empty,full,at}) as well as the tidier one, because
    // a second translation layer between the packet and this file is a second
    // place for the names to drift apart.
    recordContainer(entry = {}) {
        if (!entry || typeof entry !== 'object') return null;
        const point = safePoint(entry.position || entry);
        if (!point) return null;
        const dimension = normalizeDimension(entry.dimension || entry.dim);
        const key = this._containerKey(dimension, point.x, point.y, point.z);
        // ⚠ AN UNDATED READING IS NOT A FRESH ONE - IT IS ONE WHOSE AGE CANNOT BE
        // JUDGED, so it dates to 0 and no freshness gate downstream will ever
        // accept it. this is not pedantry: the bridge merges every state packet
        // with `Object.assign`, so a key that STOPS being sent keeps its last
        // value forever. per-entry dates are the whole reason that is safe - a
        // stuck array simply ages out and she falls back to carried-only. dating
        // an undated entry `now` would re-date that stuck array on every poll and
        // turn a dead read into a permanently fresh lie about her own shelves.
        const readAt = Number.isFinite(entry.readAt) ? entry.readAt
            : (Number.isFinite(entry.at) ? entry.at : 0);
        const items = {};
        const rawItems = entry.items && typeof entry.items === 'object' && !Array.isArray(entry.items)
            ? entry.items : {};
        for (const [name, count] of Object.entries(rawItems)) {
            const bare = bareItemName(name);
            const n = Math.max(0, Number(count) | 0);
            if (bare && n > 0) items[bare] = (items[bare] || 0) + n;
        }
        const record = {
            key, dimension, type: normalizeContainerType(entry.type),
            x: point.x, y: point.y, z: point.z,
            items,
            empty: Number.isFinite(entry.empty) ? Math.max(0, entry.empty | 0) : null,
            full: entry.full === true,
            readAt,
            world: entry.world ? cleanText(entry.world, 64) : null,
            settlementId: entry.settlementId ? cleanText(entry.settlementId, 96) : null
        };
        const idx = this.data.stores.findIndex((c) => c.key === key);
        if (idx >= 0) {
            const previous = this.data.stores[idx];
            // a re-read of the same chest REPLACES its contents rather than
            // merging them. a chest that was emptied has to be able to say so, and
            // a union of every tally it has ever held could only ever grow.
            record.world = record.world || previous.world;
            record.settlementId = record.settlementId || previous.settlementId;
            // an unreadable type on a later packet must not erase a good one.
            record.type = record.type || previous.type;
            // ⚠ AN UNCHANGED READING IS NOT A WRITE. state packets arrive every
            // ~2s and the bridge's Object.assign keeps the last container array
            // alive forever, so an unconditional _save() here is a full-file disk
            // write every 1.5 seconds for the rest of the session - on the same
            // event loop burnt's chat and tts run on. same rule recordTerrainCell
            // and upsertSettlement already follow: only persist a real change.
            if (JSON.stringify(previous) === JSON.stringify(record)) return previous;
            this.data.stores.splice(idx, 1, record);
        } else {
            this.data.stores.push(record);
            this._evictContainer();
        }
        this._save();
        return record;
    }

    getContainer(key) {
        const k = String(key || '');
        return k ? this.data.stores.find((c) => c.key === k) || null : null;
    }

    forgetContainer(key) {
        const k = String(key || '');
        const idx = k ? this.data.stores.findIndex((c) => c.key === k) : -1;
        if (idx < 0) return false;
        this.data.stores.splice(idx, 1);
        this._save();
        return true;
    }

    getContainers() {
        return Array.isArray(this.data.stores) ? this.data.stores : [];
    }

    // `pantryOnly` is the honest default for anything that reasons about supply:
    // a furnace's fuel slot is not a shop, and neither is a smoker with her dinner
    // in it. pass false to see every container she has ever opened.
    listContainers({ world = null, dimension = null, near = null, radius = null,
        maxAgeMs = null, pantryOnly = true, now = Date.now() } = {}) {
        const here = world ? cleanText(world, 64) : null;
        const dim = dimension ? normalizeDimension(dimension) : null;
        const point = near ? safePoint(near) : null;
        return this.getContainers().filter((c) => {
            if (pantryOnly && !isPantryContainer(c.type)) return false;
            if (dim && normalizeDimension(c.dimension) !== dim) return false;
            // a chest on another server is not one she can walk to. an entry with
            // no world predates the field and matches anything, the same
            // convention favorites, food spots and quarries already follow.
            if (here && c.world && c.world !== here) return false;
            if (Number.isFinite(maxAgeMs) && now - (c.readAt || 0) > maxAgeMs) return false;
            if (point && Number.isFinite(radius) &&
                Math.hypot(c.x - point.x, c.z - point.z) > radius) return false;
            return true;
        });
    }

    // ⚠ A DOUBLE CHEST IS ONE PANTRY REPORTED TWICE. the companion keys an entry
    // off the block that was clicked but tallies the whole 54-slot menu, so
    // opening the other half writes a second entry with an identical tally at the
    // block next door. summing raw turns 320 loaves into 640, which is worse than
    // no reading at all - it is a confident wrong one that stops her restocking.
    //
    // two adjacent same-type containers with identical contents are treated as
    // one. that is a heuristic and it is deliberately the CONSERVATIVE way round:
    // two genuine single chests side by side holding exactly the same tally are
    // undercounted, which can only ever make her restock something she has - never
    // starve her of something she has not.
    _dedupeContainers(list) {
        const out = [];
        const signature = (c) => JSON.stringify(Object.entries(c.items || {}).sort());
        for (const c of list) {
            const sig = signature(c);
            const twin = out.find((kept) => kept.type === c.type &&
                normalizeDimension(kept.dimension) === normalizeDimension(c.dimension) &&
                kept.y === c.y &&
                Math.abs(kept.x - c.x) + Math.abs(kept.z - c.z) <= DOUBLE_CHEST_DIST &&
                signature(kept) === sig);
            // an EMPTY pair is two empty chests, not one double chest - there is
            // nothing to double-count, and folding them would quietly lose a place
            // she could put things.
            if (twin && Object.keys(c.items || {}).length) continue;
            out.push(c);
        }
        return out;
    }

    // HOW MANY OF THIS ITEM SHE OWNS BUT IS NOT CARRYING.
    //
    // ⚠ `maxAgeMs` is not optional in spirit. a reading is a belief with a date on
    // it, and a caller using this to decide NOT to go and get something must pass
    // a horizon - otherwise a chest she read last week can talk her out of eating
    // today. callers that merely want to know what she has ever seen may omit it.
    storedCount(itemName, opts = {}) {
        const want = bareItemName(itemName);
        if (!want) return 0;
        const list = this._dedupeContainers(this.listContainers({ ...opts, pantryOnly: true }));
        let total = 0;
        for (const c of list) total += Number(c.items?.[want]) || 0;
        return total;
    }

    // everything she owns and is not carrying, as one merged tally. same filters
    // and the same de-dup as storedCount - for callers that need to score a whole
    // pantry (how much FOOD is in there) rather than count one item, so that
    // question costs one pass instead of one pass per item name.
    storedTotals(opts = {}) {
        const out = {};
        for (const c of this._dedupeContainers(this.listContainers({ ...opts, pantryOnly: true }))) {
            for (const [name, count] of Object.entries(c.items || {})) {
                out[name] = (out[name] || 0) + (Number(count) || 0);
            }
        }
        return out;
    }

    // SHE TOOK SOME OUT. the ledger is a belief and a withdraw is the one moment
    // she KNOWS it changed, so spend it here rather than waiting for the next
    // reading - otherwise a companion that does not re-publish after a withdraw
    // leaves her believing in loaves she is now carrying, and she never restocks.
    // deliberately does NOT refresh `readAt`: taking bread out is not looking in.
    noteContainerTaken(key, itemName, count = 1) {
        const entry = this.getContainer(key);
        const want = bareItemName(itemName);
        if (!entry || !want || !entry.items || !(entry.items[want] > 0)) return null;
        const left = Math.max(0, entry.items[want] - Math.max(0, Number(count) | 0));
        if (left > 0) entry.items[want] = left;
        else delete entry.items[want];
        this._save();
        return entry;
    }

    // the nearest pantry that actually holds the thing, so a caller can decide
    // between "take it out of the chest" and "walk to the chest first" instead of
    // dispatching a withdraw at a container three thousand blocks away.
    nearestContainerWith(itemName, position, opts = {}) {
        const want = bareItemName(itemName);
        const point = safePoint(position);
        if (!want || !point) return null;
        let best = null;
        let bestD = Infinity;
        // ⚠ `near` MUST be handed down or listContainers has nothing to measure a
        // radius from and silently returns everything. shipped without it once:
        // the caller's PANTRY_TRIP_MAX was accepted, ignored, and she was sent on
        // a four-thousand-block walk to her own chest.
        for (const c of this.listContainers({ near: point, ...opts, pantryOnly: true })) {
            if (!(Number(c.items?.[want]) > 0)) continue;
            const d = Math.hypot(c.x - point.x, c.z - point.z);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    // ⚠ EVICT THE CHEAPEST, NEVER THE OLDEST. she opens loot chests, dungeon
    // chests and empty village barrels constantly; a FIFO would fill the ledger
    // with roadside junk and quietly drop the home chest with the whole pantry in
    // it - the one entry this ledger exists for.
    _containerValue(entry) {
        if (!isPantryContainer(entry.type)) return 0;      // not a pantry at all
        const items = entry.items || {};
        const names = Object.keys(items);
        if (!names.length) return 1;                       // a known empty chest is still a place
        let value = 3;
        // food is the thing a full pantry is supposed to stop her re-gathering,
        // so a chest with food in it is the one to keep.
        if (names.some((n) => /bread|wheat|beef|porkchop|mutton|chicken|potato|carrot|beetroot|berries|kelp|stew|apple/.test(n))) value += 3;
        if (names.some((n) => /diamond|iron|gold|coal|emerald|netherite|copper|lapis|redstone/.test(n))) value += 2;
        // a chest at one of her own buildings is furniture she chose; a chest in a
        // ravine is one she happened to open.
        if (entry.settlementId) value += 2;
        return value;
    }

    _evictContainer() {
        let removed = false;
        while (this.data.stores.length > MAX_CONTAINERS) {
            let worstIdx = 0;
            let worstScore = Infinity;
            for (let i = 0; i < this.data.stores.length; i++) {
                const c = this.data.stores[i];
                const score = this._containerValue(c);
                if (score < worstScore ||
                    (score === worstScore && (c.readAt || 0) < (this.data.stores[worstIdx].readAt || 0))) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            this.data.stores.splice(worstIdx, 1);
            removed = true;
        }
        return removed;
    }

    // NEAREST first, like every other context line here, and de-duped so the
    // prompt never states a double chest's contents twice. it says how old each
    // reading is on purpose: "as of 40m ago" is the difference between a fact and
    // a belief, and she should be able to say which one she is working from.
    storesContext(currentPosition = null, max = 3, dimension = null, world = null) {
        const here = currentPosition && Number.isFinite(currentPosition.x) ? currentPosition : null;
        const now = Date.now();
        return this._dedupeContainers(this.listContainers({ dimension, world, pantryOnly: true }))
            .map((c) => ({ c, d: here ? Math.hypot(here.x - c.x, here.z - c.z) : 0 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, max)
            .map(({ c, d }) => {
                const top = Object.entries(c.items || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`);
                let line = `${(c.type || 'container').replace(/_/g, ' ')} at ${c.x},${c.y},${c.z}`;
                if (here) line += ` ~${Math.round(d)}m`;
                line += top.length ? `: ${top.join(', ')}` : ': empty';
                const ageMin = Math.round((now - (c.readAt || 0)) / 60000);
                if (ageMin >= 5) line += ` [last looked ${ageMin}m ago]`;
                return line;
            });
    }

    // ---- the oven family ----------------------------------------------------
    // every furnace/smoker/campfire she installs joins a named collection that
    // survives restarts. this is the minecraft version of her antique toasters:
    // the units are individuals with names, not a block count.

    // pick a name that isn't taken yet; falls back to a numbered unit once the
    // pool is exhausted so a big collection never collides.
    _nextOvenName() {
        const taken = new Set(this.data.ovens.map((o) => String(o.name || '').toLowerCase()));
        const free = this.ovenNames.filter((n) => !taken.has(n));
        if (free.length) return free[Math.floor(Math.random() * free.length)];
        return `unit ${this.data.ovens.length + 1}`;
    }

    // returns { entry, isNew } so the caller can tell "a new one moved in" from
    // "the scan saw the same block again".
    //
    // dedupe defaults on for scan-sourced records (the same block gets re-reported
    // every poll). a COMPLETED place is authoritative - it is always a new unit,
    // even if she placed it without moving - so that path passes dedupe:false.
    // otherwise two units placed from one standing spot merge into one, the count
    // never reaches its target, and she re-places the same oven forever.
    recordOven(kind, position, dimension = 'overworld', name = null, { dedupe = true, settlementId = null } = {}) {
        const point = safePoint(position);
        const k = cleanText(kind, 32).toLowerCase().replace(/^minecraft:/, '');
        if (!point || !OVEN_KINDS.includes(k)) return null;
        const dim = cleanText(dimension || 'overworld', 64).replace(/^minecraft:/, '');
        const existing = dedupe ? this.data.ovens.find((o) => o.kind === k && o.dimension === dim &&
            Math.hypot(o.position.x - point.x, o.position.z - point.z) <= OVEN_MERGE_DIST &&
            Math.abs(o.position.y - point.y) <= OVEN_MERGE_DIST) : null;
        if (existing) {
            existing.at = Date.now();
            if (name) existing.name = cleanText(name, 40);
            this._save();
            return { entry: existing, isNew: false };
        }
        const entry = {
            at: Date.now(),
            kind: k,
            name: cleanText(name || this._nextOvenName(), 40),
            position: point,
            dimension: dim,
            settlementId: settlementId ? cleanText(settlementId, 96) : null
        };
        this.data.ovens.push(entry);
        if (this.data.ovens.length > MAX_OVENS) this.data.ovens.shift();
        this.data.tally.ovensInstalled += 1;
        this.record('oven', `installed ${entry.kind.replace(/_/g, ' ')} "${entry.name}"`, {
            target: entry.kind, position: point, dimension: dim
        });
        this._save();
        return { entry, isNew: true };
    }

    listOvens() {
        return this.data.ovens.slice();
    }

    // counts per kind plus the total, for the prompt readout and the drive's
    // "does the collection need another unit" checks.
    ovenTally() {
        const out = { total: this.data.ovens.length };
        for (const kind of OVEN_KINDS) out[kind] = 0;
        for (const o of this.data.ovens) if (out[o.kind] !== undefined) out[o.kind] += 1;
        return out;
    }

    // most recent units first, with live distance when a position is given
    ovensContext(currentPosition = null, currentDimension = null, max = 6) {
        return this.data.ovens.slice(-max).reverse().map((o) => {
            let line = `${o.name} (${o.kind.replace(/_/g, ' ')})`;
            if (currentPosition && Number.isFinite(currentPosition.x) &&
                (!currentDimension || String(currentDimension).replace(/^minecraft:/, '') === o.dimension)) {
                line += ` ~${Math.round(Math.hypot(currentPosition.x - o.position.x, currentPosition.z - o.position.z))}m`;
            }
            return line;
        });
    }

    // THE TRIMMINGS LEDGER. an ornament she put up somewhere, remembered because
    // nothing in the game will remember it for her - the companion's block scan
    // reports furnaces and beds, not paintings.
    //
    // ⚠ NO `dedupe` PARAMETER, unlike `recordOven`. that flag exists because an
    // oven is re-reported by every scan, so a scan-sourced record has to merge
    // while a completed placement must not. nothing ever scans a lantern, so the
    // only writer here is a completed placement and merging is purely the
    // "she placed two things at one spot" guard.
    recordComfort(kind, position, dimension = 'overworld', { settlementId = null, note = null } = {}) {
        const point = safePoint(position);
        const k = cleanText(kind, 32).toLowerCase().replace(/^minecraft:/, '');
        if (!point || !COMFORT_KINDS.includes(k)) return null;
        const dim = cleanText(dimension || 'overworld', 64).replace(/^minecraft:/, '');
        const existing = this.data.comforts.find((c) => c.kind === k && c.dimension === dim &&
            Math.hypot(c.position.x - point.x, c.position.z - point.z) <= COMFORT_MERGE_DIST &&
            Math.abs(c.position.y - point.y) <= COMFORT_MERGE_DIST);
        if (existing) {
            existing.at = Date.now();
            this._save();
            return { entry: existing, isNew: false };
        }
        const entry = {
            at: Date.now(),
            kind: k,
            position: point,
            dimension: dim,
            note: note ? cleanText(note, 80) : null,
            settlementId: settlementId ? cleanText(settlementId, 96) : null
        };
        this.data.comforts.push(entry);
        if (this.data.comforts.length > MAX_COMFORTS) this.data.comforts.shift();
        this.data.tally.comfortsPlaced += 1;
        this.record('comfort', `put up a ${entry.kind.replace(/_/g, ' ')} at home`, {
            target: entry.kind, position: point, dimension: dim
        });
        this._save();
        return { entry, isNew: true };
    }

    // everything she has put up, optionally scoped to one settlement. the scope
    // matters: an outpost's lantern must not tell the homestead its porch is done.
    listComforts({ settlementId = null } = {}) {
        const all = this.data.comforts.slice();
        if (!settlementId) return all;
        return all.filter((c) => c.settlementId === settlementId);
    }

    // has this exact ornament already gone up here?
    hasComfort(kind, { settlementId = null } = {}) {
        const k = String(kind || '').toLowerCase();
        return this.listComforts({ settlementId }).some((c) => c.kind === k);
    }

    // most recent first, with live distance when a position is given - the same
    // shape ovensContext uses so her prompt reads consistently.
    comfortsContext(currentPosition = null, currentDimension = null, max = 4) {
        return this.data.comforts.slice(-max).reverse().map((c) => {
            let line = c.kind.replace(/_/g, ' ');
            if (currentPosition && Number.isFinite(currentPosition.x) &&
                (!currentDimension || String(currentDimension).replace(/^minecraft:/, '') === c.dimension)) {
                line += ` ~${Math.round(Math.hypot(currentPosition.x - c.position.x, currentPosition.z - c.position.z))}m`;
            }
            return line;
        });
    }

    // lifetime counters she can actually brag about ("loaf number 41")
    getTally() {
        return { ...this.data.tally };
    }

    bumpTally(key, by = 1) {
        if (!Object.prototype.hasOwnProperty.call(this.data.tally, key)) return null;
        this.data.tally[key] += by;
        this._save();
        return this.data.tally[key];
    }

    // ---- favorite spots + home --------------------------------------------
    // named places she chose to remember ("lava falls base", "villager mall").
    // one of them can be HOME - the spot she returns to, puts her bed, chests,
    // builds. names are her own words; matching is case-insensitive.

    _favoriteKey(name) {
        return cleanText(name, 48).toLowerCase();
    }

    setFavorite(name, position, dimension = 'overworld', note = null, world = null) {
        const key = this._favoriteKey(name);
        const point = safePoint(position);
        if (!key || !point) return null;
        const entry = {
            name: cleanText(name, 48),
            position: point,
            dimension: cleanText(dimension || 'overworld', 64),
            note: note ? cleanText(note, 120) : null,
            // which server/save this place is ON. coordinates mean nothing without it.
            world: world ? cleanText(world, 80) : null,
            at: Date.now()
        };
        const existing = this.data.favorites.findIndex((f) => this._favoriteKey(f.name) === key);
        if (existing >= 0) this.data.favorites.splice(existing, 1);
        this.data.favorites.push(entry);
        this._evictFavorite();      // never evicts home - see _evictFavorite
        this._save();
        return entry;
    }

    getFavorite(name) {
        const key = this._favoriteKey(name);
        if (!key) return null;
        return this.data.favorites.find((f) => this._favoriteKey(f.name) === key) || null;
    }

    removeFavorite(name) {
        const key = this._favoriteKey(name);
        const idx = this.data.favorites.findIndex((f) => this._favoriteKey(f.name) === key);
        if (idx < 0) return false;
        this.data.favorites.splice(idx, 1);
        if (this.data.home === key) this.data.home = null;
        this._save();
        return true;
    }

    listFavorites() {
        return this.data.favorites.slice();
    }

    // ---- homesteads + outposts -------------------------------------------

    upsertSettlement(value, { main = false } = {}) {
        let settlement = value instanceof ToasterHomestead ? value : settlementFromJSON(value);
        if (!settlement) return null;
        const currentMain = this.getMainSettlement(settlement.world);
        if (settlement.role === 'outpost' && currentMain) {
            settlement = fitOutpostBelowHomestead(settlement, currentMain);
        }
        const idx = this.data.settlements.findIndex((entry) => entry.id === settlement.id ||
            (entry.kind === settlement.kind && entry.world === settlement.world &&
                entry.dimension === settlement.dimension && entry.anchor?.x === settlement.anchor.x &&
                entry.anchor?.y === settlement.anchor.y && entry.anchor?.z === settlement.anchor.z));
        const json = settlement.toJSON();
        const previousMainId = this.data.mainSettlementId;
        const previous = idx >= 0 ? this.data.settlements[idx] : null;
        // `updatedAt` is bookkeeping, not a state change. Survey packets arrive
        // every couple seconds, so ignoring it prevents a permanently complete
        // house from rewriting the memory file forever.
        const comparable = (entry) => JSON.stringify(entry
            ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'updatedAt'))
            : null);
        // MAIN IS A DECISION, NOT A SIDE EFFECT OF BEING TOUCHED.
        //
        // this used to read `main || settlement.role === 'homestead'`, so EVERY
        // homestead upsert claimed the title - and survey packets upsert every
        // couple of seconds. the practical effect was that "main" meant "the
        // homestead a packet touched most recently": walking past an old house
        // was enough to steal it, and with several homes she could never keep a
        // stable answer to where she lives.
        //
        // so it is claimed only when asked for explicitly, or when the seat is
        // genuinely vacant (nothing set, or the record it pointed at is gone).
        const mainMissing = !this.data.mainSettlementId
            || !this.data.settlements.some((entry) => entry.id === this.data.mainSettlementId);
        const nextMainId = (main || (mainMissing && settlement.role === 'homestead'))
            ? settlement.id
            : previousMainId;
        if (previous && comparable(previous) === comparable(json) && nextMainId === previousMainId) {
            return settlementFromJSON(previous);
        }
        if (idx >= 0) this.data.settlements.splice(idx, 1, json);
        else this.data.settlements.push(json);
        this.data.mainSettlementId = nextMainId;
        while (this.data.settlements.length > MAX_SETTLEMENTS) this._evictSettlement();
        this._save();
        return settlement;
    }

    /**
     * WHICH HOME SHE CAN AFFORD TO FORGET.
     *
     * eviction used to take `findIndex(id !== main)` - the first non-main entry,
     * i.e. the OLDEST. that is precisely backwards for "remember all her old
     * homes": the first house she ever built is the one with the history in it,
     * and it was always the first to go.
     *
     * ranked by value instead, oldest only as a tie-break, and the main seat is
     * never evictable at any score.
     */
    _settlementValue(entry) {
        if (!entry) return -1;
        if (entry.id === this.data.mainSettlementId) return Number.MAX_SAFE_INTEGER;
        let value = 0;
        if (entry.role === 'homestead') value += 4;
        else if (entry.role === 'outpost') value += 2;
        // a finished building is a place she actually lived; a stub is a site she
        // walked away from.
        if (entry.progress?.complete) value += 3;
        else if (Number(entry.progress?.percent) > 0) value += 1;
        if (Array.isArray(entry.appliances) && entry.appliances.length) value += 1;
        return value;
    }

    // ⚠ TRIMS TO THE CAP, not "removes one", and reports whether it did.
    //
    // The add path only ever goes one over, but the LOAD path can hand this a file that
    // is well over - and it runs there now, because loading used to take the last N
    // entries, i.e. drop the OLDEST. The docblock above says taking the oldest is
    // "precisely backwards", and it was right: the first house she ever built was the
    // first thing a full file forgot.
    _evictSettlement() {
        let any = false;
        while (this.data.settlements.length > MAX_SETTLEMENTS) {
            let worst = -1;
            let worstValue = Infinity;
            let worstAt = Infinity;
            this.data.settlements.forEach((entry, i) => {
                const value = this._settlementValue(entry);
                const at = Number(entry.updatedAt) || 0;
                if (value < worstValue || (value === worstValue && at < worstAt)) {
                    worst = i;
                    worstValue = value;
                    worstAt = at;
                }
            });
            if (worst < 0) break;
            this.data.settlements.splice(worst, 1);
            any = true;
        }
        return any;
    }

    // ⚠ HOME IS NEVER THE ONE THAT GOES. Extracted from setFavorite so the load path
    // gets the same rule: it used to take the last N, and `this.data.home` is restored
    // independently as a NAME - so trimming the home favorite left her with a home name
    // on disk and `getHome()` returning null, which is `go_home` dead and no house.
    _evictFavorite() {
        let any = false;
        while (this.data.favorites.length > MAX_FAVORITES) {
            const homeKey = this.data.home;
            const idx = this.data.favorites.findIndex((f) => this._favoriteKey(f.name) !== homeKey);
            this.data.favorites.splice(idx >= 0 ? idx : 0, 1);
            any = true;
        }
        return any;
    }

    // ⚠ BY WEIGHT, not by arrival order - same rule the write path already used, now on
    // the load path too. Taking the last N dropped the regular she has known for weeks
    // in favour of last night's strangers.
    _evictPlayer() {
        let any = false;
        while (this.data.players.length > MAX_PLAYERS) {
            let worstAt = 0;
            for (let i = 1; i < this.data.players.length; i++) {
                const a = this.data.players[i], b = this.data.players[worstAt];
                const wa = this._playerWeight(a), wb = this._playerWeight(b);
                if (wa < wb || (wa === wb && (a.lastSeen || 0) < (b.lastSeen || 0))) worstAt = i;
            }
            this.data.players.splice(worstAt, 1);
            any = true;
        }
        return any;
    }

    /**
     * name which of her homes is THE home. returns the settlement, or null if the
     * id is unknown - an unknown id must not silently clear the seat.
     */
    setMainSettlement(id) {
        const found = this.data.settlements.find((entry) => entry.id === id);
        if (!found) return null;
        if (this.data.mainSettlementId === id) return settlementFromJSON(found);
        this.data.mainSettlementId = id;
        this._save();
        return settlementFromJSON(found);
    }

    listSettlements(world = null) {
        return this.data.settlements.map(settlementFromJSON).filter((entry) => entry &&
            (!world || !entry.world || entry.world === world));
    }

    getSettlement(id) {
        return settlementFromJSON(this.data.settlements.find((entry) => entry.id === id));
    }

    getMainSettlement(world = null) {
        const direct = this.getSettlement(this.data.mainSettlementId);
        if (direct && (!world || !direct.world || direct.world === world)) return direct;
        return this.listSettlements(world).find((entry) => entry.role === 'homestead') || null;
    }

    listOutposts(world = null) {
        return this.listSettlements(world).filter((entry) => entry.role === 'outpost');
    }

    updateSettlementProgress(id, progress) {
        const settlement = this.getSettlement(id);
        if (!settlement) return null;
        settlement.withProgress(progress);
        return this.upsertSettlement(settlement, { main: settlement.id === this.data.mainSettlementId });
    }

    // which planned slots are already filled. positions, not a count: the
    // gallery is a fixed map now, so "how many have i installed" is the wrong
    // question - two installs into the same block is one appliance and a
    // permanently unfinished plan.
    recordSettlementAppliance(id, kind, position) {
        const settlement = this.getSettlement(id);
        const p = position && [position.x, position.y, position.z].every(Number.isFinite) ? position : null;
        if (!settlement || !p) return null;
        const at = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
        const key = `${at.x},${at.y},${at.z}`;
        const existing = settlement.appliances.find((entry) => `${entry.x},${entry.y},${entry.z}` === key);
        if (existing) return settlement;
        settlement.appliances.push({ kind: String(kind || 'appliance'), ...at, at: Date.now() });
        return this.upsertSettlement(settlement, { main: settlement.id === this.data.mainSettlementId });
    }

    removeSettlement(id) {
        const idx = this.data.settlements.findIndex((entry) => entry.id === id);
        if (idx < 0) return false;
        this.data.settlements.splice(idx, 1);
        if (this.data.mainSettlementId === id) this.data.mainSettlementId = null;
        // the plan for a house that no longer exists is scenery. the quarry is
        // NOT - the hole is still in the ground and she can still mine it, so it
        // only loses the settlement it belonged to.
        delete this.data.settlementUpgrades[id];
        for (const quarry of this.data.quarries) {
            if (quarry.settlementId === id) { quarry.settlementId = null; quarry.updatedAt = Date.now(); }
        }
        this._save();
        return true;
    }

    settlementsContext(world = null, max = 8) {
        const main = this.getMainSettlement(world);
        const rest = this.listSettlements(world).filter((entry) => !main || entry.id !== main.id);
        return [main, ...rest].filter(Boolean).slice(0, max).map((entry) => {
            const p = entry.progress;
            const progress = p && Number.isFinite(Number(p.percent))
                ? ` - ${Math.round(Number(p.percent))}% ${String(p.phase || 'built').replace(/_/g, ' ')}` : '';
            return `${entry.role === 'homestead' ? 'MAIN ' : ''}${entry.name} (${entry.kind.replace(/_/g, ' ')}) at ` +
                `${entry.anchor.x},${entry.anchor.y},${entry.anchor.z}, ${entry.width}x${entry.depth}x${entry.height}${progress}`;
        });
    }

    // ---- quarries ---------------------------------------------------------
    // A QUARRY IS A PLACE, NOT A FEATURE FLAG. one fixed mouth she walks back to,
    // so "nearest stone" is measured from inside the same hole every restock and
    // the hole deepens into a mine instead of scraping a fresh crater beside the
    // house every time. levels are upgrades: 1 is a bare shaft, each level adds
    // torch coverage and depth.

    getQuarry(id) {
        const key = String(id || '');
        return key ? this.data.quarries.find((q) => q.id === key) || null : null;
    }

    quarryForSettlement(settlementId) {
        const key = settlementId ? cleanText(settlementId, 96) : null;
        return key ? this.data.quarries.find((q) => q.settlementId === key) || null : null;
    }

    // returns { entry, isNew } so the caller can tell "i dug a new one" from "that
    // is the hole i already have". dedupe is by settlement first (a settlement has
    // ONE quarry - a second mouth behind the same house is the bug this ledger
    // exists to stop) and then by a mouth close enough to be the same hole.
    recordQuarry({ settlementId = null, mouth = null, dimension = 'overworld', world = null, name = null, depth = 0, level = 1 } = {}) {
        const point = safePoint(mouth);
        if (!point) return null;
        const sid = settlementId ? cleanText(settlementId, 96) : null;
        const dim = normalizeDimension(dimension);
        const here = world ? cleanText(world, 64) : null;
        const existing = (sid ? this.quarryForSettlement(sid) : null) ||
            this.data.quarries.find((q) => normalizeDimension(q.dimension) === dim &&
                (!here || !q.world || q.world === here) &&
                Math.hypot(q.mouth.x - point.x, q.mouth.z - point.z) <= QUARRY_MERGE_DIST);
        if (existing) {
            // ⚠ THE MOUTH DOES NOT MOVE. the torches, the depth and every walk-here
            // goal are all measured from it, so re-reporting a hole from two blocks
            // over must not slide the entrance out from under its own lighting.
            existing.updatedAt = Date.now();
            if (sid && !existing.settlementId) existing.settlementId = sid;
            if (here && !existing.world) existing.world = here;
            if (name) existing.name = cleanText(name, 48);
            this._save();
            return { entry: existing, isNew: false };
        }
        const now = Date.now();
        const entry = {
            id: this._mintId('q', this.data.quarries),
            settlementId: sid,
            name: cleanText(name || 'the quarry', 48),
            mouth: point,
            dimension: dim,
            world: here,
            depth: Number.isFinite(depth) ? Math.max(0, depth | 0) : 0,
            level: Math.min(MAX_QUARRY_LEVEL, Math.max(1, Number.isFinite(level) ? level | 0 : 1)),
            torches: [],
            lastWorkedAt: null,
            createdAt: now,
            updatedAt: now
        };
        this.data.quarries.push(entry);
        this._evictQuarry();
        this.record('quarry', `opened ${entry.name}`, { position: point, dimension: dim });
        this._save();
        return { entry, isNew: true };
    }

    // a quarry attached to a settlement outranks a loose hole, and a lit, deep one
    // outranks a scrape - the work already put in is what a cap should protect.
    _quarryValue(quarry) {
        return (quarry.settlementId ? 8 : 0) + (quarry.level || 1) * 2 + Math.min(4, (quarry.torches?.length || 0));
    }

    _evictQuarry() {
        let removed = false;
        while (this.data.quarries.length > MAX_QUARRIES) {
            let worstIdx = 0;
            let worstScore = Infinity;
            for (let i = 0; i < this.data.quarries.length; i++) {
                const q = this.data.quarries[i];
                const score = this._quarryValue(q);
                const worst = this.data.quarries[worstIdx];
                const age = (x) => x.lastWorkedAt || x.updatedAt || x.createdAt || 0;
                if (score < worstScore || (score === worstScore && age(q) < age(worst))) {
                    worstScore = score;
                    worstIdx = i;
                }
            }
            this.data.quarries.splice(worstIdx, 1);
            removed = true;
        }
        return removed;
    }

    // only the fields that can honestly change. `mouth` is deliberately absent -
    // see recordQuarry.
    updateQuarry(id, patch = {}) {
        const quarry = this.getQuarry(id);
        if (!quarry || !patch || typeof patch !== 'object') return null;
        if (patch.name) quarry.name = cleanText(patch.name, 48);
        if (Number.isFinite(patch.depth)) quarry.depth = Math.max(0, patch.depth | 0);
        if (Number.isFinite(patch.level)) quarry.level = Math.min(MAX_QUARRY_LEVEL, Math.max(1, patch.level | 0));
        if (patch.settlementId !== undefined) {
            quarry.settlementId = patch.settlementId ? cleanText(patch.settlementId, 96) : null;
        }
        if (patch.world) quarry.world = cleanText(patch.world, 64);
        // `true` means "just now" - the caller that has been mining does not have
        // to reach for a clock.
        if (patch.lastWorkedAt === true) quarry.lastWorkedAt = Date.now();
        else if (Number.isFinite(patch.lastWorkedAt)) quarry.lastWorkedAt = patch.lastWorkedAt;
        quarry.updatedAt = Date.now();
        this._save();
        return quarry;
    }

    // one torch, one block. deduped on the exact block because a re-survey
    // re-reports every light in the shaft, and a torch counted twice is a level
    // of coverage she never actually placed.
    recordQuarryTorch(id, position) {
        const quarry = this.getQuarry(id);
        const point = safePoint(position);
        if (!quarry || !point) return null;
        if (!Array.isArray(quarry.torches)) quarry.torches = [];
        const already = quarry.torches.some((t) => t.x === point.x && t.y === point.y && t.z === point.z);
        if (already) return quarry;
        quarry.torches.push(point);
        while (quarry.torches.length > MAX_QUARRY_TORCHES) quarry.torches.shift();
        quarry.updatedAt = Date.now();
        this._save();
        return quarry;
    }

    listQuarries(world = null) {
        const here = world ? cleanText(world, 64) : null;
        // an entry with no world predates the field and stays usable everywhere,
        // the same convention favorites and food spots already follow.
        return this.data.quarries.filter((q) => !here || !q.world || q.world === here);
    }

    nearestQuarry(position, dimension = 'overworld', world = null) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = normalizeDimension(dimension);
        let best = null;
        let bestD = Infinity;
        for (const q of this.listQuarries(world)) {
            if (normalizeDimension(q.dimension) !== dim) continue;
            const d = Math.hypot(q.mouth.x - point.x, q.mouth.z - point.z);
            if (d < bestD) { bestD = d; best = q; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    removeQuarry(id) {
        const idx = this.data.quarries.findIndex((q) => q.id === id);
        if (idx < 0) return false;
        this.data.quarries.splice(idx, 1);
        this._save();
        return true;
    }

    quarriesContext(currentPosition = null, max = 2, world = null) {
        const here = currentPosition && Number.isFinite(currentPosition.x) ? currentPosition : null;
        return this.listQuarries(world)
            .map((q) => ({ q, d: here ? Math.hypot(here.x - q.mouth.x, here.z - q.mouth.z) : 0 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, max)
            .map(({ q, d }) => {
                let line = `${q.name} (lvl ${q.level}${q.depth ? `, ${q.depth} deep` : ''}) at ` +
                    `${q.mouth.x},${q.mouth.y},${q.mouth.z} (${normalizeDimension(q.dimension)})`;
                if (here) line += ` ~${Math.round(d)}m`;
                if (q.torches?.length) line += `, ${q.torches.length} lit`;
                return line;
            });
    }

    // ---- per-settlement upgrades ------------------------------------------
    // what each house still wants doing. kept in a SIBLING map keyed by
    // settlement id rather than on the settlement itself, because a settlement
    // record is round-tripped through settlementFromJSON on every load and save -
    // any field that class does not know about is silently dropped on the way
    // through, so an upgrade stored there would vanish at the next survey packet.

    _upgradeBook(settlementId, create = false) {
        const key = settlementId ? cleanText(settlementId, 96) : null;
        if (!key) return null;
        if (!this.data.settlementUpgrades || typeof this.data.settlementUpgrades !== 'object') {
            this.data.settlementUpgrades = {};
        }
        if (!this.data.settlementUpgrades[key]) {
            if (!create) return null;
            this.data.settlementUpgrades[key] = {};
        }
        return this.data.settlementUpgrades[key];
    }

    // ⚠ an unknown upgrade id is REJECTED, not stored. an id nothing can execute
    // stores perfectly, reads back perfectly, and is a plan step that silently
    // never runs - the exact shape of the floorplan's "unknown kind defaults to
    // furnace" bug, one layer up.
    setSettlementUpgrade(settlementId, upgradeId, patch = {}) {
        const uid = cleanText(upgradeId, 48).toLowerCase();
        if (!SETTLEMENT_UPGRADE_IDS.has(uid)) return null;
        const p = patch && typeof patch === 'object' ? patch : {};
        // ⚠ every rejection happens BEFORE the book is created, or a refused write
        // still leaves an empty plan behind for a settlement that never had one.
        if (p.state !== undefined && !UPGRADE_STATES.has(p.state)) return null;
        const book = this._upgradeBook(settlementId, true);
        if (!book) return null;
        const now = Date.now();
        const record = book[uid] || { state: 'planned', at: now, attempts: 0, lastAttemptAt: null, note: null };
        if (p.state) record.state = p.state;
        if (p.note !== undefined) record.note = p.note ? cleanText(p.note, 120) : null;
        if (Number.isFinite(p.attempts)) record.attempts = Math.max(0, p.attempts | 0);
        // `attempt: true` is the common case - she tried it again just now.
        if (p.attempt) { record.attempts = (record.attempts || 0) + 1; record.lastAttemptAt = now; }
        record.at = now;
        book[uid] = record;
        this._save();
        return { ...record };
    }

    getSettlementUpgrades(settlementId) {
        const book = this._upgradeBook(settlementId);
        if (!book) return {};
        const out = {};
        for (const [uid, record] of Object.entries(book)) out[uid] = { ...record };
        return out;
    }

    settlementUpgradeState(settlementId, upgradeId) {
        const book = this._upgradeBook(settlementId);
        const uid = cleanText(upgradeId, 48).toLowerCase();
        return book?.[uid]?.state || null;
    }

    // in PLAN order, never insertion order: an upgrade queued late still happens
    // where it belongs (you cannot glaze windows into a shell that isn't up yet).
    nextPlannedUpgrade(settlementId) {
        const book = this._upgradeBook(settlementId);
        if (!book) return null;
        return SETTLEMENT_UPGRADE_ORDER.find((uid) => book[uid]?.state === 'planned') || null;
    }

    clearSettlementUpgrades(settlementId) {
        const key = settlementId ? cleanText(settlementId, 96) : null;
        if (!key || !this.data.settlementUpgrades?.[key]) return false;
        delete this.data.settlementUpgrades[key];
        this._save();
        return true;
    }

    // drop plans for houses that no longer exist, and any id this build cannot
    // execute. returns whether anything changed, so the caller (the loader) can
    // decide whether a write is even warranted.
    // ⚠ ONLY MEANINGFUL AFTER `settlements` IS POPULATED - run against an empty
    // list it deletes every plan in the file.
    _restoreSettlementUpgrades(raw) {
        const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const live = new Set(this.data.settlements.map((entry) => entry && entry.id).filter(Boolean));
        const kept = {};
        let changed = false;
        for (const [sid, book] of Object.entries(source)) {
            if (!live.has(sid) || !book || typeof book !== 'object') { changed = true; continue; }
            const page = {};
            for (const [uid, record] of Object.entries(book)) {
                if (!SETTLEMENT_UPGRADE_IDS.has(uid) || !record || typeof record !== 'object') { changed = true; continue; }
                page[uid] = {
                    state: UPGRADE_STATES.has(record.state) ? record.state : 'planned',
                    at: Number.isFinite(record.at) ? record.at : Date.now(),
                    attempts: Number.isFinite(record.attempts) ? record.attempts : 0,
                    lastAttemptAt: Number.isFinite(record.lastAttemptAt) ? record.lastAttemptAt : null,
                    note: record.note ? cleanText(record.note, 120) : null
                };
                if (!UPGRADE_STATES.has(record.state)) changed = true;
            }
            if (Object.keys(page).length) kept[sid] = page;
            else changed = true;
        }
        this.data.settlementUpgrades = kept;
        return changed;
    }

    settlementUpgradesContext(settlementId, max = 3) {
        const book = this._upgradeBook(settlementId);
        if (!book) return [];
        const lines = [];
        for (const uid of SETTLEMENT_UPGRADE_ORDER) {
            const record = book[uid];
            if (!record || record.state === 'done') continue;
            lines.push(`${uid.replace(/_/g, ' ')} - ${record.state}${record.note ? ` (${record.note})` : ''}`);
            if (lines.length >= max) break;
        }
        return lines;
    }

    // mark a favorite as home. A POSITION ALWAYS WINS: this used to be
    // `if (!fav && position)`, so setting home under a name she had used before
    // silently kept the OLD coordinates. the auto-settle name is the constant
    // 'the homestead', which made every home after the first a no-op - she could
    // never move house anywhere, by any route.
    setHome(name, position = null, dimension = 'overworld', note = null, world = null) {
        const fav = position
            ? this.setFavorite(name, position, dimension, note || 'home', world)
            : this.getFavorite(name);
        if (!fav) return null;
        const moved = this.data.home !== this._favoriteKey(fav.name) || !!position;
        this.data.home = this._favoriteKey(fav.name);
        // a new house (or the same name at new coordinates) is a clean slate. carrying
        // the old home's failed-departure count forward would condemn the replacement
        // before she has walked to it once.
        if (moved) this.data.homeCampaign = null;
        this._save();
        return fav;
    }

    clearHome() {
        if (!this.data.home) return false;
        this.data.home = null;
        this.data.homeCampaign = null;
        this._save();
        return true;
    }

    // ---- people -------------------------------------------------------------
    // a username is a person, not a session artifact. these records are what let her
    // say "you're the one who asked me to build a bridge" instead of greeting a regular
    // as a stranger every time burnt restarts.

    _playerKey(name) { return cleanText(name, 16).toLowerCase(); }

    _findPlayer(name) {
        const key = this._playerKey(name);
        if (!key) return null;
        return this.data.players.find((p) => p.key === key) || null;
    }

    // significance, not recency: someone she has traded words with outranks a hundred
    // people who walked past. used only for eviction.
    _playerWeight(p) {
        return (p.chats || 0) * 4 + (p.requests?.length || 0) * 4 + (p.gifts || 0) * 3 + Math.min(p.sightings || 0, 20);
    }

    _upsertPlayer(name, world = null) {
        const key = this._playerKey(name);
        if (!key) return null;
        let p = this._findPlayer(key);
        if (!p) {
            p = {
                key, name: cleanText(name, 16), firstMet: Date.now(), lastSeen: Date.now(),
                sightings: 0, chats: 0, gifts: 0, lastSaid: null, lastSaidAt: null,
                requests: [], notes: [], world: world || null
            };
            this.data.players.push(p);
            this._evictPlayer();    // by weight, not arrival order - see _evictPlayer
        }
        if (world) p.world = world;
        p.lastSeen = Date.now();
        return p;
    }

    recordPlayerSighting(name, world = null) {
        const p = this._upsertPlayer(name, world);
        if (!p) return null;
        p.sightings = (p.sightings || 0) + 1;
        this._save();
        return p;
    }

    // what they actually SAID. the old roster kept names and timestamps with the text
    // stripped, so she could know someone had spoken and never what about.
    recordPlayerChat(name, text, world = null) {
        const p = this._upsertPlayer(name, world);
        if (!p) return null;
        const said = cleanText(text, 160);
        p.chats = (p.chats || 0) + 1;
        if (said) { p.lastSaid = said; p.lastSaidAt = Date.now(); }
        this._save();
        return p;
    }

    recordPlayerGift(name, item = 'bread', world = null) {
        const p = this._upsertPlayer(name, world);
        if (!p) return null;
        p.gifts = (p.gifts || 0) + 1;
        p.lastGift = cleanText(item, 32);
        this._save();
        return p;
    }

    // something they asked her to do, and whether she ever did it. requests used to
    // evaporate after ten minutes, so "you never built that thing i asked for" had no
    // possible answer.
    recordPlayerRequest(name, text, action = null, world = null) {
        const p = this._upsertPlayer(name, world);
        if (!p) return null;
        const ask = cleanText(text, 120);
        if (!ask) return p;
        if (!Array.isArray(p.requests)) p.requests = [];
        p.requests.push({ at: Date.now(), text: ask, action: action ? cleanText(action, 32) : null, done: false });
        while (p.requests.length > MAX_PLAYER_REQUESTS) p.requests.shift();
        this._save();
        return p;
    }

    // mark the most recent matching open request as actually carried out
    completePlayerRequest(name, action = null) {
        const p = this._findPlayer(name);
        if (!p || !Array.isArray(p.requests)) return null;
        for (let i = p.requests.length - 1; i >= 0; i--) {
            const r = p.requests[i];
            if (r.done) continue;
            if (action && r.action && r.action !== cleanText(action, 32)) continue;
            r.done = true;
            this._save();
            return r;
        }
        return null;
    }

    notePlayer(name, note, world = null) {
        const p = this._upsertPlayer(name, world);
        if (!p) return null;
        const text = cleanText(note, 120);
        if (!text) return p;
        if (!Array.isArray(p.notes)) p.notes = [];
        if (!p.notes.includes(text)) {
            p.notes.push(text);
            while (p.notes.length > MAX_PLAYER_NOTES) p.notes.shift();
            this._save();
        }
        return p;
    }

    getPlayer(name) { return this._findPlayer(name); }

    listPlayers({ max = 10, world = null } = {}) {
        return this.data.players
            .filter((p) => !world || !p.world || p.world === world)
            .slice()
            .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
            .slice(0, max);
    }

    // one compact prompt block. people standing next to her come first and are marked,
    // because "who is this" is the question she needs answered fastest.
    playersContext(nearbyNames = [], max = 6, world = null) {
        const near = new Set((Array.isArray(nearbyNames) ? nearbyNames : [])
            .map((n) => this._playerKey(n)).filter(Boolean));
        const known = this.data.players
            .filter((p) => !world || !p.world || p.world === world)
            .slice()
            .sort((a, b) => {
                const an = near.has(a.key) ? 1 : 0, bn = near.has(b.key) ? 1 : 0;
                if (an !== bn) return bn - an;
                return (b.lastSeen || 0) - (a.lastSeen || 0);
            })
            .slice(0, max);
        if (!known.length) return [];
        const now = Date.now();
        const ago = (at) => {
            const mins = Math.round((now - (at || now)) / 60000);
            if (mins < 60) return `${Math.max(1, mins)}m ago`;
            const hrs = Math.round(mins / 60);
            return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
        };
        return known.map((p) => {
            const bits = [];
            if (near.has(p.key)) bits.push('HERE NOW');
            const met = Math.round((now - (p.firstMet || now)) / 86400000);
            bits.push(met >= 1 ? `known ${met}d` : 'met today');
            if (p.chats) bits.push(`${p.chats} talk${p.chats === 1 ? '' : 's'}`);
            if (p.gifts) bits.push(`${p.gifts} loaf${p.gifts === 1 ? '' : 's'} given`);
            if (!near.has(p.key)) bits.push(`last seen ${ago(p.lastSeen)}`);
            const open = (p.requests || []).filter((r) => !r.done).slice(-1)[0];
            if (open) bits.push(`still wants: ${open.text}`);
            if (p.lastSaid) bits.push(`said "${p.lastSaid}"`);
            if (p.notes?.length) bits.push(p.notes[p.notes.length - 1]);
            return `${p.name} - ${bits.join('; ')}`;
        });
    }

    // ---- home reachability campaign -----------------------------------------
    // AltoClef's escalating wander is the only "I cannot get there" the GAME emits,
    // and it never fires when the walk is being shredded by something else: a
    // 2600-block ocean route interrupted by drowned every ten seconds re-paths from
    // scratch forever and never escalates anything. so judge the CAMPAIGN instead -
    // how many times she set out for home, and whether any departure actually closed
    // the gap. lives in the memory file because the loop this exists to break has
    // already survived several restarts on a ram-only counter.

    _campaignKey(name) { return cleanText(name || '', 80).toLowerCase(); }

    getHomeCampaign(world = null, homeName = null, staleMs = 6 * 60 * 60 * 1000) {
        const c = this.data.homeCampaign;
        if (!c || typeof c !== 'object') return null;
        if (world && c.world && c.world !== world) return null;
        if (homeName && c.home !== this._campaignKey(homeName)) return null;
        if (Number.isFinite(staleMs) && staleMs > 0 && Date.now() - (c.lastAt || 0) > staleMs) return null;
        return c;
    }

    // a departure is one accepted "walk home" goal. distance is measured at the
    // moment she sets out, so bestDistance can only improve from a real approach.
    noteHomeDeparture(world, homeName, distance) {
        const key = this._campaignKey(homeName);
        if (!key) return null;
        const d = Number(distance);
        let c = this.getHomeCampaign(world, homeName);
        if (!c) {
            c = {
                world: world || null, home: key, attempts: 0, startedAt: Date.now(), lastAt: Date.now(),
                startDistance: Number.isFinite(d) ? d : null,
                bestDistance: Number.isFinite(d) ? d : null,
                declaredAt: null
            };
        }
        c.attempts = (c.attempts || 0) + 1;
        c.lastAt = Date.now();
        if (Number.isFinite(d)) {
            if (!Number.isFinite(c.startDistance)) c.startDistance = d;
            if (!Number.isFinite(c.bestDistance) || d < c.bestDistance) c.bestDistance = d;
        }
        this.data.homeCampaign = c;
        this._homeBestWritten = Number.isFinite(d) ? d : null;   // a departure always writes
        this._save();
        return c;
    }

    // called with the live distance while a home walk is running. the ONLY thing
    // that proves the route works is the gap actually shrinking.
    //
    // meaningful progress REBASES the campaign rather than merely recording a better
    // number: a walk that got a third of the way home has demonstrably not failed, so
    // it starts over from where it got to. without this, a long legitimate march would
    // spend its attempts on the way and get its own home condemned out from under it -
    // and conversely a bot that crawls forward then stalls forever would be forgiven
    // permanently by one early gain.
    noteHomeProgress(world, homeName, distance, progressFraction = 0.35) {
        const c = this.getHomeCampaign(world, homeName);
        const d = Number(distance);
        if (!c || !Number.isFinite(d)) return null;
        if (Number.isFinite(c.bestDistance) && d >= c.bestDistance) return c;

        const base = Number(c.startDistance);
        const rebase = Number.isFinite(base) && base > 0 && (base - d) / base >= progressFraction;
        // persist on a rebase or a real gain only. this is polled every autonomy tick
        // while she walks, and a full-file sync write per tick is exactly the stall this
        // file's own debounce comment exists to avoid - the verdict needs "roughly how
        // close did she get", never sub-block precision. measured against the last value
        // actually WRITTEN, not the last one seen, so a steady crawl of small gains still
        // reaches disk instead of drifting forever below the threshold.
        const watermark = Number.isFinite(this._homeBestWritten) ? this._homeBestWritten : c.bestDistance;
        const worthWriting = rebase || !Number.isFinite(watermark) || (watermark - d) >= 16;
        c.bestDistance = d;
        c.lastAt = Date.now();
        if (rebase) {
            c.startDistance = d;
            c.attempts = 0;
            c.startedAt = Date.now();
            c.declaredAt = null;
        }
        this.data.homeCampaign = c;
        if (worthWriting) { this._homeBestWritten = d; this._save(); }
        return c;
    }

    // she got there. the home is provably fine - wipe the doubt entirely so one
    // bad afternoon never counts against a home she uses every day.
    clearHomeCampaign() {
        this._homeBestWritten = null;
        if (!this.data.homeCampaign) return false;
        this.data.homeCampaign = null;
        this._save();
        return true;
    }

    markHomeCampaignDeclared() {
        const c = this.data.homeCampaign;
        if (!c) return null;
        c.declaredAt = Date.now();
        this._save();
        return c;
    }

    // `world` scopes home to the server/save it was set on. a home is a PLACE, and
    // coordinates from another world point at somebody else's dirt - without this she
    // walks to her old server's house the moment she joins a new one. entries saved
    // before worlds were tracked carry no world and stay valid everywhere.
    getHome(world = null) {
        if (!this.data.home) return null;
        const fav = this.data.favorites.find((f) => this._favoriteKey(f.name) === this.data.home) || null;
        if (!fav) return null;
        if (world && fav.world && fav.world !== world) return null;
        return fav;
    }

    // compact prompt lines: home first (marked), then the most recent spots.
    // distances are computed against the live position when given.
    favoritesContext(currentPosition = null, currentDimension = null, max = 5) {
        const home = this.getHome();
        const rest = this.data.favorites
            .filter((f) => !home || this._favoriteKey(f.name) !== this.data.home)
            .slice(-Math.max(0, max - (home ? 1 : 0)))
            .reverse();
        const fmt = (f, isHome) => {
            const p = f.position;
            let line = `${isHome ? 'HOME: ' : ''}${f.name} at ${p.x},${p.y},${p.z} (${f.dimension.replace(/^minecraft:/, '')})`;
            if (currentPosition && Number.isFinite(currentPosition.x) &&
                (!currentDimension || String(currentDimension).replace(/^minecraft:/, '') === f.dimension.replace(/^minecraft:/, ''))) {
                const d = Math.round(Math.hypot(currentPosition.x - p.x, currentPosition.z - p.z));
                line += ` ~${d}m away`;
            }
            if (f.note) line += ` - ${f.note}`;
            return line;
        };
        const lines = [];
        if (home) lines.push(fmt(home, true));
        for (const f of rest) lines.push(fmt(f, false));
        return lines;
    }

    // ---- goals --------------------------------------------------------------
    // what she is doing now (`short`) and what she is building toward (`long`).
    // both live on disk, because a long goal that dies at every restart is a mood
    // rather than a goal - and the whole complaint that produced this file is that
    // she starts the same afternoon over and over.

    // ⚠ dedupe on what the goal IS ABOUT when it says so - two "mine iron" goals
    // pointed at the same seam are one goal - and fall back to the text when it
    // doesn't, or every untargeted goal in a scope would collapse into the first.
    _goalKey(goal) {
        const kind = goal.kind || '';
        const target = goal.targetId || '';
        if (!kind && !target) return `${goal.scope}|text:${String(goal.text || '').toLowerCase()}`;
        return `${goal.scope}|${kind}|${target}`;
    }

    addGoal({ scope = 'short', text = '', kind = null, targetId = null, resume = null } = {}) {
        const s = cleanText(scope, 8).toLowerCase();
        if (!GOAL_SCOPES.has(s)) return null;
        const body = cleanText(text, 160);
        if (!body) return null;
        const draft = {
            scope: s, text: body,
            kind: kind ? cleanText(kind, 32).toLowerCase() : null,
            targetId: targetId ? cleanText(targetId, 96) : null
        };
        const key = this._goalKey(draft);
        // only LIVE goals dedupe. a goal she finished or gave up on months ago
        // must not swallow the decision to go and do it again.
        const existing = this.data.goals.find((g) => !GOAL_TERMINAL.has(g.state) && this._goalKey(g) === key);
        if (existing) {
            existing.updatedAt = Date.now();
            // ⚠ ASKING AGAIN IS THE WHOLE POINT OF ASKING AGAIN. dedupe is right -
            // "make the wheat farm" twice is one job - but a re-ask must also
            // REARM it: the attempt count that had it one strike from being
            // abandoned goes back to zero, and a fresh resume payload wins.
            // without this, asking a second time hit the dedupe and changed
            // nothing, which is the exact complaint that produced this file.
            const fresh = cleanResume(resume);
            if (fresh) existing.resume = fresh;
            // ⚠ AND THE WORDS HAVE TO FOLLOW THE PLAN. `_goalKey` is
            // `scope|kind|targetId`, and a request for a verb that names no target
            // - move, go_home, deposit, withdraw, build_plan - has a null targetId,
            // so EVERY such request collapses onto one goal. updating `resume` and
            // not `text` meant she walked to the second person's coordinates while
            // her prompt, the HUD and "finished ..." all still named the first
            // person's. `text` is the only field any reader displays.
            existing.text = body;
            existing.attempts = 0;
            existing.lastRunAt = 0;
            this._save();
            return existing;
        }
        const now = Date.now();
        const entry = {
            id: this._mintId('g', this.data.goals),
            ...draft,
            state: 'open',
            createdAt: now,
            updatedAt: now,
            progressNote: null,
            attempts: 0,
            resume: cleanResume(resume),
            lastRunAt: 0
        };
        this.data.goals.push(entry);
        this._evictGoals(s);
        this._save();
        return entry;
    }

    getGoal(id) {
        const key = String(id || '');
        return key ? this.data.goals.find((g) => g.id === key) || null : null;
    }

    updateGoal(id, patch = {}) {
        const goal = this.getGoal(id);
        if (!goal || !patch || typeof patch !== 'object') return null;
        // an unknown state is rejected outright rather than coerced. a goal parked
        // in a state nothing looks for is a goal that never finishes and never
        // gets evicted either.
        if (patch.state !== undefined && !GOAL_STATES.has(patch.state)) return null;
        if (patch.state) goal.state = patch.state;
        if (patch.text) goal.text = cleanText(patch.text, 160);
        if (patch.kind !== undefined) goal.kind = patch.kind ? cleanText(patch.kind, 32).toLowerCase() : null;
        if (patch.targetId !== undefined) goal.targetId = patch.targetId ? cleanText(patch.targetId, 96) : null;
        if (patch.progressNote !== undefined) {
            goal.progressNote = patch.progressNote ? cleanText(patch.progressNote, 120) : null;
        }
        if (Number.isFinite(patch.attempts)) goal.attempts = Math.max(0, patch.attempts | 0);
        if (patch.attempt) goal.attempts = (goal.attempts || 0) + 1;
        if (patch.resume !== undefined) goal.resume = cleanResume(patch.resume);
        if (Number.isFinite(patch.lastRunAt)) goal.lastRunAt = patch.lastRunAt;
        goal.updatedAt = Date.now();
        // a goal that just went terminal may free the slot a live one needs
        this._evictGoals(goal.scope);
        this._save();
        return goal;
    }

    completeGoal(id) {
        return this.updateGoal(id, { state: 'done' });
    }

    abandonGoal(id, reason = null) {
        return this.updateGoal(id, { state: 'abandoned', progressNote: reason || null });
    }

    // insertion order, so "oldest" means what it says at every call site.
    listGoals({ scope = null, state = null } = {}) {
        const s = scope ? cleanText(scope, 8).toLowerCase() : null;
        return this.data.goals.filter((g) => (!s || g.scope === s) && (!state || g.state === state));
    }

    // the one she is actually on. most recently touched wins - if two are somehow
    // active, the one she moved last is the one she is standing in.
    activeGoal(scope = null) {
        return this.listGoals({ scope, state: 'active' })
            .slice()
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
    }

    /**
     * The jobs she could actually pick back up, the one she is already on first.
     *
     * A goal with no `resume` is still a real goal - "get better at building" is
     * a thing to say and nothing to dispatch - it just cannot be the answer to
     * "what should I do with this tick", so it is not offered here.
     *
     * Ordering is the anti-flitting rule: whatever she is ACTIVE on outranks
     * everything, so a half-built wheat farm is picked back up rather than
     * traded for a newer idea. Among equals the most recently touched wins,
     * which is how a fresh ask from a person takes over.
     */
    resumableGoals() {
        const rank = (g) => (g.state === 'active' ? 0 : 1);
        return this.data.goals
            .filter((g) => !GOAL_TERMINAL.has(g.state) && g.resume && g.resume.action)
            .slice()
            .sort((a, b) => (rank(a) - rank(b)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    }

    // ⚠ SPEND FINISHED BUSINESS FIRST. evicting by pure age drops the long goal
    // she has been chipping at for a week to make room for the fifth "get some
    // wood" of the afternoon.
    _evictGoals(scope) {
        const cap = scope === 'long' ? MAX_LONG_GOALS : MAX_SHORT_GOALS;
        const stamp = (g) => (GOAL_TERMINAL.has(g.state) ? (g.updatedAt || 0) : (g.createdAt || 0));
        let removed = false;
        for (;;) {
            const inScope = this.data.goals.filter((g) => g.scope === scope);
            if (inScope.length <= cap) break;
            const terminal = inScope.filter((g) => GOAL_TERMINAL.has(g.state));
            const pool = terminal.length ? terminal : inScope;
            let worst = pool[0];
            for (const g of pool) if (stamp(g) < stamp(worst)) worst = g;
            this.data.goals = this.data.goals.filter((g) => g !== worst);
            removed = true;
        }
        return removed;
    }

    // live goals only, the one she is on first. finished ones are history, and
    // history belongs in the journal.
    goalsContext(max = 4) {
        const rank = (g) => (g.state === 'active' ? 0 : 1);
        return this.data.goals
            .filter((g) => !GOAL_TERMINAL.has(g.state))
            .slice()
            .sort((a, b) => (rank(a) - rank(b)) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
            .slice(0, max)
            .map((g) => {
                let line = `${g.scope === 'long' ? 'long-term' : 'right now'}: ${g.text}`;
                if (g.state === 'active') line += ' [doing it]';
                if (g.progressNote) line += ` - ${g.progressNote}`;
                return line;
            });
    }

    context(max = 6, { position = null, dimension = null, world = null } = {}) {
        const journal = this.data.journal.slice(-max).reverse().map((entry) => entry.label);
        const here = world ? cleanText(world, 64) : null;
        const landmarks = this.data.landmarks
            // a landmark on another server is not somewhere she can walk to. a
            // legacy entry carries no world and still counts, as everywhere else.
            .filter((entry) => !(here && entry.world && entry.world !== here))
            .slice(-3).reverse().map((entry) =>
                `${entry.label} at ${entry.position.x},${entry.position.y},${entry.position.z} (${entry.dimension.replace(/^minecraft:/, '')})`);
        const out = { journal, landmarks };
        // everywhere she knows by sight, nearest first. this is the one that
        // makes her sound like she has been somewhere before.
        const places = this.placesContext(position, 4, dimension, world);
        if (places.length) out.places = places;
        // ⚠ only what earns its line. an empty ledger contributes NOTHING rather
        // than an empty heading - the game-state block is already long, and a
        // prompt full of "quarries: none" teaches her she has nothing.
        const goals = this.goalsContext(3);
        if (goals.length) out.goals = goals;
        const ore = this.oreSpotsContext(position, 2, dimension);
        if (ore.length) out.ore = ore;
        const quarries = this.quarriesContext(position, 1, world);
        if (quarries.length) out.quarries = quarries;
        const main = this.getMainSettlement(world);
        const upgrades = main ? this.settlementUpgradesContext(main.id, 2) : [];
        if (upgrades.length) out.upgrades = upgrades;
        return out;
    }
}
