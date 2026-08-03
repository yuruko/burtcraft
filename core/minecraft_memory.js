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
const MAX_OVENS = 128;
// 64-block cells, so ~4000 covers a 500x500-chunk slab of explored world
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
            // looked" died with every process restart and she re-checked the same
            // ground forever. persisted here so a restart costs her nothing.
            visited: []
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
                this.data.journal = Array.isArray(parsed.journal) ? parsed.journal.slice(-MAX_JOURNAL) : [];
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
        if (settlement.role === 'outpost' && currentMain) settlement = fitOutpostBelowHomestead(settlement, currentMain);
        const idx = this.data.settlements.findIndex((entry) => entry.id === settlement.id ||
            (entry.kind === settlement.kind && entry.world === settlement.world && entry.dimension === settlement.dimension &&
                entry.anchor?.x === settlement.anchor.x && entry.anchor?.y === settlement.anchor.y && entry.anchor?.z === settlement.anchor.z));
        const json = settlement.toJSON();
        const previousMainId = this.data.mainSettlementId;
        const previous = idx >= 0 ? this.data.settlements[idx] : null;
        const comparable = (entry) => JSON.stringify(entry
            ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'updatedAt'))
            : null);
        const nextMainId = (main || settlement.role === 'homestead') ? settlement.id : previousMainId;
        if (previous && comparable(previous) === comparable(json) && nextMainId === previousMainId) {
            return settlementFromJSON(previous);
        }
        if (idx >= 0) this.data.settlements.splice(idx, 1, json); else this.data.settlements.push(json);
        while (this.data.settlements.length > MAX_SETTLEMENTS) {
            const removable = this.data.settlements.findIndex((entry) => entry.id !== this.data.mainSettlementId);
            this.data.settlements.splice(removable >= 0 ? removable : 0, 1);
        }
        if (main || settlement.role === 'homestead') this.data.mainSettlementId = settlement.id;
        this._save();
        return settlement;
    }

    listSettlements(world = null) {
        return this.data.settlements.map(settlementFromJSON).filter((entry) => entry && (!world || !entry.world || entry.world === world));
    }

    getSettlement(id) { return settlementFromJSON(this.data.settlements.find((entry) => entry.id === id)); }

    getMainSettlement(world = null) {
        const direct = this.getSettlement(this.data.mainSettlementId);
        if (direct && (!world || !direct.world || direct.world === world)) return direct;
        return this.listSettlements(world).find((entry) => entry.role === 'homestead') || null;
    }

    listOutposts(world = null) { return this.listSettlements(world).filter((entry) => entry.role === 'outpost'); }

    updateSettlementProgress(id, progress) {
        const settlement = this.getSettlement(id);
        if (!settlement) return null;
        settlement.withProgress(progress);
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
            const progress = p && Number.isFinite(Number(p.percent)) ? ` - ${Math.round(Number(p.percent))}% ${String(p.phase || 'built').replace(/_/g, ' ')}` : '';
            return `${entry.role === 'homestead' ? 'MAIN ' : ''}${entry.name} (${entry.kind.replace(/_/g, ' ')}) at ${entry.anchor.x},${entry.anchor.y},${entry.anchor.z}, ${entry.width}x${entry.depth}x${entry.height}${progress}`;
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
        this.data.home = this._favoriteKey(fav.name);
        this._save();
        return fav;
    }

    clearHome() {
        if (!this.data.home) return false;
        this.data.home = null;
        this._save();
        return true;
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
