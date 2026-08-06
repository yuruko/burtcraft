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
const MAX_WHEAT_SPOTS = 12;
const WHEAT_SPOT_MERGE_DIST = 24;
// the named collection. must exceed the sum of OVEN_TARGETS with headroom: evicting
// a record does not remove the block from the world, it just makes her forget she
// named it - and makes the tally re-open a target she already filled.
const MAX_OVENS = 128;
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
const MAX_SETTLEMENTS = 16;
// merge radius for "i have already looked here". matches the tool's
// RECENT_DESTINATION_RADIUS so the persisted view and the live view agree.
const VISITED_MERGE_RADIUS = 140;
const OVEN_MERGE_DIST = 3;                  // same block, re-reported by the scan
// the oven family. every furnace/smoker/campfire the bot installs becomes a
// named unit in a collection it keeps track of - a cheap, durable source of
// "things that are mine" for a character to refer back to.
export const OVEN_KINDS = ['furnace', 'blast_furnace', 'smoker', 'campfire', 'soul_campfire'];
// auto-names for units the idle brain installs, used only when the brain does
// not supply one through the tool.
//
// THIS IS CHARACTER FLAVOR, and it is the one place persona leaks into the
// otherwise neutral memory layer. the default below is deliberately plain.
// pass your own register to the constructor - burnt's, for instance, is a set of
// antique-toaster model names because she collects them:
//     new MinecraftMemory(path, { ovenNames: ['sunbeam', 'bakelite betty', ...] })
const DEFAULT_OVEN_NAME_POOL = [
    'the first one', 'old reliable', 'number two', 'the spare', 'the good one',
    'backup', 'the corner unit', 'the loud one', 'the new one', 'the small one'
];

function cleanText(value, max = 120) {
    return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// entries that are protocol chatter rather than anything she lived. `hud` is the 30s
// in-game intent overlay; `status`/`inventory`/`coords` are read-only queries. a journal
// is what she DID, and a ring buffer full of heartbeats is a journal of nothing.
const JOURNAL_NOISE_ACTIONS = new Set(['hud', 'status', 'inventory', 'coords', 'look']);
function isJournalNoise(entry) {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.kind !== 'completed') return false;
    const action = String(entry.action || '').trim().toLowerCase();
    if (action) return JOURNAL_NOISE_ACTIONS.has(action);
    // older entries predate the `action` field - fall back to the bare label
    return JOURNAL_NOISE_ACTIONS.has(String(entry.label || '').trim().toLowerCase());
}

function safePoint(position) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
    return { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) };
}

export class MinecraftMemory {
    constructor(filePath = DEFAULT_PATH, { registerExitHook = true, ovenNames = null } = {}) {
        // character flavor, injectable - see DEFAULT_OVEN_NAME_POOL above
        this.ovenNames = Array.isArray(ovenNames) && ovenNames.length ? ovenNames : DEFAULT_OVEN_NAME_POOL;
        this.filePath = filePath;
        this.data = {
            version: 2, journal: [], landmarks: [], failures: [], favorites: [], home: null, wheatSpots: [],
            ovens: [], tally: { breadBaked: 0, ovensInstalled: 0, fuelRuns: 0 }, deathSpot: null,
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
            // the standing record of "am i actually able to get home". one departure
            // that fails is nothing; the same walk failing all afternoon means the
            // home is unreachable and she should build somewhere else. this MUST be
            // persisted - the go-home loop survived several burnt restarts precisely
            // because the attempt count lived in ram and reset to zero every time.
            homeCampaign: null
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
                this.data.favorites = Array.isArray(parsed.favorites) ? parsed.favorites.slice(-MAX_FAVORITES) : [];
                this.data.home = typeof parsed.home === 'string' ? parsed.home : null;
                this.data.wheatSpots = Array.isArray(parsed.wheatSpots) ? parsed.wheatSpots.slice(-MAX_WHEAT_SPOTS) : [];
                this.data.ovens = Array.isArray(parsed.ovens) ? parsed.ovens.slice(-MAX_OVENS) : [];
                this.data.settlements = Array.isArray(parsed.settlements)
                    ? parsed.settlements.map(settlementFromJSON).filter(Boolean).slice(-MAX_SETTLEMENTS).map((s) => s.toJSON())
                    : [];
                this.data.mainSettlementId = typeof parsed.mainSettlementId === 'string' ? parsed.mainSettlementId : null;
                this.data.terrain = parsed.terrain && typeof parsed.terrain === 'object' && !Array.isArray(parsed.terrain)
                    ? parsed.terrain
                    : {};
                this.data.deathSpot = parsed.deathSpot && typeof parsed.deathSpot === 'object' && parsed.deathSpot.position
                    ? parsed.deathSpot
                    : null;
                this.data.homeCampaign = parsed.homeCampaign && typeof parsed.homeCampaign === 'object' &&
                    !Array.isArray(parsed.homeCampaign) ? parsed.homeCampaign : null;
                this.data.players = Array.isArray(parsed.players) ? parsed.players.slice(-MAX_PLAYERS) : [];
                // older memory files predate the tally; start it at zero rather
                // than inventing a history she never lived.
                const t = parsed.tally && typeof parsed.tally === 'object' ? parsed.tally : {};
                this.data.tally = {
                    breadBaked: Number.isFinite(t.breadBaked) ? t.breadBaked : 0,
                    ovensInstalled: Number.isFinite(t.ovensInstalled) ? t.ovensInstalled : 0,
                    fuelRuns: Number.isFinite(t.fuelRuns) ? t.fuelRuns : 0
                };
            }
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn(`[minecraft-memory] unable to load memory: ${err.message}`);
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
            const temp = `${this.filePath}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
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
        const samePlace = this.data.landmarks.findIndex((old) => old.label === entry.label && old.dimension === entry.dimension &&
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

    // ---- wheat spots --------------------------------------------------------
    // fields she's walked past, remembered for the bread pipeline. altoclef
    // replants what it harvests (replantCrops), so a remembered field is a
    // renewable farm she can come back to forever.

    recordWheatSpot(position, dimension = 'overworld', count = 0) {
        const point = safePoint(position);
        if (!point) return null;
        const dim = cleanText(dimension || 'overworld', 64);
        const existing = this.data.wheatSpots.find((s) => s.dimension === dim &&
            Math.hypot(s.position.x - point.x, s.position.z - point.z) <= WHEAT_SPOT_MERGE_DIST);
        if (existing) {
            existing.at = Date.now();
            if (count > (existing.count || 0)) { existing.count = count; existing.position = point; }
            this._save();
            return existing;
        }
        const entry = { at: Date.now(), position: point, dimension: dim, count: Math.max(0, count | 0) };
        this.data.wheatSpots.push(entry);
        if (this.data.wheatSpots.length > MAX_WHEAT_SPOTS) this.data.wheatSpots.shift();
        this._save();
        return entry;
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
    getVisitedSpots() {
        return Array.isArray(this.data.visited) ? this.data.visited : [];
    }

    recordVisitedSpot(x, z, at = Date.now()) {
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
        if (!Array.isArray(this.data.visited)) this.data.visited = [];
        // one slot per PLACE: refresh a nearby entry rather than appending a second,
        // or a cap-sized ring quietly evicts the very spot she keeps returning to.
        for (const v of this.data.visited) {
            if (Math.hypot(px - v.x, pz - v.z) < VISITED_MERGE_RADIUS) {
                v.at = at;
                this._save();
                return true;
            }
        }
        this.data.visited.push({ x: Math.round(px), z: Math.round(pz), at });
        while (this.data.visited.length > MAX_VISITED_SPOTS) this.data.visited.shift();
        this._save();
        return true;
    }

    nearestWheatSpot(position, dimension = 'overworld') {
        const point = safePoint(position);
        if (!point) return null;
        const dim = cleanText(dimension || 'overworld', 64).replace(/^minecraft:/, '');
        let best = null;
        let bestD = Infinity;
        for (const s of this.data.wheatSpots) {
            if (s.dimension.replace(/^minecraft:/, '') !== dim) continue;
            const d = Math.hypot(s.position.x - point.x, s.position.z - point.z);
            if (d < bestD) { bestD = d; best = s; }
        }
        return best ? { ...best, distance: Math.round(bestD) } : null;
    }

    wheatSpotsContext(currentPosition = null, max = 3) {
        return this.data.wheatSpots.slice(-max).reverse().map((s) => {
            let line = `wheat at ${s.position.x},${s.position.y},${s.position.z} (${s.dimension.replace(/^minecraft:/, '')})`;
            if (currentPosition && Number.isFinite(currentPosition.x)) {
                line += ` ~${Math.round(Math.hypot(currentPosition.x - s.position.x, currentPosition.z - s.position.z))}m`;
            }
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
        if (this.data.favorites.length > MAX_FAVORITES) {
            // never evict home while trimming
            const homeKey = this.data.home;
            const idx = this.data.favorites.findIndex((f) => this._favoriteKey(f.name) !== homeKey);
            this.data.favorites.splice(idx >= 0 ? idx : 0, 1);
        }
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
        const nextMainId = (main || settlement.role === 'homestead') ? settlement.id : previousMainId;
        if (previous && comparable(previous) === comparable(json) && nextMainId === previousMainId) {
            return settlementFromJSON(previous);
        }
        if (idx >= 0) this.data.settlements.splice(idx, 1, json);
        else this.data.settlements.push(json);
        while (this.data.settlements.length > MAX_SETTLEMENTS) {
            const removable = this.data.settlements.findIndex((entry) => entry.id !== this.data.mainSettlementId);
            this.data.settlements.splice(removable >= 0 ? removable : 0, 1);
        }
        if (main || settlement.role === 'homestead') this.data.mainSettlementId = settlement.id;
        this._save();
        return settlement;
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
            if (this.data.players.length > MAX_PLAYERS) {
                let worstAt = 0;
                for (let i = 1; i < this.data.players.length; i++) {
                    const a = this.data.players[i], b = this.data.players[worstAt];
                    const wa = this._playerWeight(a), wb = this._playerWeight(b);
                    if (wa < wb || (wa === wb && (a.lastSeen || 0) < (b.lastSeen || 0))) worstAt = i;
                }
                this.data.players.splice(worstAt, 1);
            }
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

    context(max = 6) {
        const journal = this.data.journal.slice(-max).reverse().map((entry) => entry.label);
        const landmarks = this.data.landmarks.slice(-3).reverse().map((entry) =>
            `${entry.label} at ${entry.position.x},${entry.position.y},${entry.position.z} (${entry.dimension.replace(/^minecraft:/, '')})`);
        return { journal, landmarks };
    }
}
