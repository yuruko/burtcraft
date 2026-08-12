// Portable settlement geometry/state for Burtcraft.  This module deliberately
// has no Burnt runtime dependencies so the same model can ship in the standalone
// open-source core (tmp/burtcraft-repo/core) - toaster_layout.js and the
// generated toaster_plan.js it reads are pure geometry and hold to the same rule.

import {
    toasterCells, toasterManifest, glyphAt as layeredGlyphAt,
    toasterWidth as layeredWidth, toasterDepth as layeredDepth, toasterHeight as layeredHeight,
    SHELL as GLYPH_SHELL, AIR as GLYPH_AIR, FURNACE as GLYPH_FURNACE, CHEST as GLYPH_CHEST,
    BENCH as GLYPH_BENCH, BED as GLYPH_BED, TORCH as GLYPH_TORCH, WALL_TORCH as GLYPH_WALL_TORCH,
    DOOR as GLYPH_DOOR, OPENING as GLYPH_OPENING
} from './toaster_layout.js';

const clean = (value, max = 64) => String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const point = (value) => {
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
    return { x: Math.round(value.x), y: Math.round(value.y), z: Math.round(value.z) };
};

const dimension = (value) => clean(value || 'overworld', 64);

// THE LEDGER MUST OUTGROW THE BIGGEST PLAN, or the house can never be finished.
//
// this was 128 while the only homestead held 72 appliance blocks, and the
// comment saying so is what made it look safe. the layered v2 plan holds 355
// (3 benches + 32 chests + 320 furnaces), so the ledger evicted the earliest
// installs, `_filledApplianceKeys` forgot them, and the gallery re-offered
// blocks she had already filled - forever. measured: 129 unique blocks handed
// out, then a loop, with `installed` pinned at 128/355 so `complete` could
// never be true.
//
// a cap that silently truncates the very thing it is a record OF is not a
// safety limit, it is a ceiling on the feature. 512 clears the largest plan
// with room for a bigger one; this is a few hundred small objects on a
// settlement, not a memory concern. ⚠ any new plan must stay under it.
const MAX_APPLIANCE_LEDGER = 512;

export class Settlement {
    constructor({
        id = null, name, anchor, dimension: dim = 'overworld', world = null,
        width, depth, height, material = 'stone', progress = null,
        appliances = [], createdAt = Date.now(), updatedAt = Date.now()
    } = {}) {
        const p = point(anchor);
        if (!p) throw new Error('settlement needs a finite anchor');
        for (const [label, value] of Object.entries({ width, depth, height })) {
            if (!Number.isInteger(value) || value < 5 || value > 64) {
                throw new Error(`settlement ${label} must be an integer from 5 to 64`);
            }
        }
        this.id = clean(id || `settlement_${createdAt}_${Math.random().toString(36).slice(2, 8)}`, 96);
        this.name = clean(name || 'settlement', 48) || 'settlement';
        this.anchor = p;
        this.dimension = dimension(dim);
        this.world = world ? clean(world, 80) : null;
        this.width = width;
        this.depth = depth;
        this.height = height;
        this.material = clean(material || 'stone', 48);
        this.progress = progress && typeof progress === 'object' ? { ...progress } : null;
        // the ledger has to outlive the whole plan, or a slot whose record fell
        // off the end reads as empty and gets installed into a second time. the
        // homestead alone is 72 appliance blocks.
        this.appliances = Array.isArray(appliances) ? appliances.slice(-MAX_APPLIANCE_LEDGER) : [];
        this.createdAt = Number(createdAt) || Date.now();
        this.updatedAt = Number(updatedAt) || this.createdAt;
    }

    get kind() { return 'settlement'; }
    get role() { return 'settlement'; }
    get volume() { return this.width * this.depth * this.height; }
    get footprint() { return this.width * this.depth; }

    contains(position, margin = 0) {
        const p = point(position);
        if (!p) return false;
        const minX = this.anchor.x - Math.floor(this.width / 2) - margin;
        const minZ = this.anchor.z - Math.floor(this.depth / 2) - margin;
        const floorY = this.anchor.y - 1 - margin;
        return p.x >= minX && p.x < minX + this.width + margin * 2 &&
            p.z >= minZ && p.z < minZ + this.depth + margin * 2 &&
            p.y >= floorY && p.y < floorY + this.height + margin * 2;
    }

    distanceTo(position) {
        const p = point(position);
        return p ? Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z) : Infinity;
    }

    // A plain settlement has no fixture map, so it has no gallery. The 9x3 grid
    // that used to live here is deliberately gone rather than kept "just in
    // case": it was the last running copy of the layout whose z was clamped with
    // Math.min(minZ + depth - 3, ...), collapsing every row past the last onto
    // one line so slot 18 was handed the block slot 15 already held. Toasters
    // override this with positions read off the floorplan.
    applianceSlots() { return []; }
    appliancePosition() { return null; }

    withProgress(progress) {
        this.progress = progress && typeof progress === 'object' ? { ...progress } : null;
        this.updatedAt = Date.now();
        return this;
    }

    toJSON() {
        return {
            id: this.id, kind: this.kind, role: this.role, name: this.name,
            anchor: { ...this.anchor }, dimension: this.dimension, world: this.world,
            width: this.width, depth: this.depth, height: this.height,
            material: this.material, progress: this.progress ? { ...this.progress } : null,
            appliances: this.appliances.slice(), createdAt: this.createdAt, updatedAt: this.updatedAt
        };
    }
}

export class Homestead extends Settlement {
    get role() { return 'homestead'; }
}

export class Outpost extends Settlement {
    get role() { return 'outpost'; }
}

// ---------------------------------------------------------------------------
// THE FLOORPLAN
//
// One ascii map decides where every fixture in a toaster lives. The in-game
// side parses byte-identical strings (ToasterGeometry.java), so the shell
// Baritone builds and the gallery Burnt fills can never drift apart - which is
// exactly how the old layout went wrong, with a js grid and a java grid that
// had quietly stopped agreeing.
//
//   W = shell wall      T = wall torch      C = chest
//   F = furnace         S = smoker          B = bed
//   K = crafting table  ' ' on the top row  = the walk-through
//
// Every T/C/F/S/K is a COLUMN OF THREE: one on the ground, one above that, one
// above that. Banks of appliances up the walls is what makes the inside read as
// a toaster instead of a shed with a furnace in it.
export const TOASTER_STACK_HEIGHT = 3;

// THE YARD: how much open air a toaster gets on every side of it.
//
// A house with a hillside against one wall and a forest against another is not
// a home, it is a hole with a door - nothing of it reads on stream, mobs drop
// onto the roof off the high ground, and the way in is a tunnel. Ten blocks is
// enough that the whole silhouette is visible from outside and nothing has a
// block next to a wall to stand on.
//
// Must stay identical to Settlement.YARD_MARGIN in the java twin.
export const TOASTER_YARD_MARGIN = 10;

// THE TRENCH: a dry moat ringing the whole encampment, outside the lit yard.
//
// The yard's torch grid means nothing spawns INSIDE the perimeter any more, so
// the only creeper left is one that spawned in the dark somewhere else and
// walked in. Four is the number that stops it - a mob's pathfinder refuses a
// drop of more than three - and two wide because a mob clears a one-block gap
// in its stride, which makes a one-wide trench a kerb.
//
// It sits OUTSIDE the yard rather than at its edge because toasterPerimeterLights
// puts torches on yardMinX/yardMaxX exactly, and a trench there would dig out the
// lighting that made the yard safe in the first place.
//
// MUST MATCH Settlement.TRENCH_DEPTH/TRENCH_WIDTH in the java twin.
export const TOASTER_TRENCH_DEPTH = 4;
export const TOASTER_TRENCH_WIDTH = 2;

export const TOASTER_HOMESTEAD_PLAN = Object.freeze([
    'WWWWWW  WWWWWW',
    // one of the two chest stacks by the door is a crafting table stack: she
    // crafts far more often than she needs a sixth chest, and walking out of her
    // own house to reach a workbench reads as broken on stream. Three chests is
    // still 81 slots. MUST stay byte-identical to ToasterGeometry.HOMESTEAD_PLAN.
    'WSFTKT  TCTFSW',
    'WT          TW',
    'WF          FW',
    'WT          TW',
    'WF   FBBF   FW',
    'WT   FBBF   TW',
    'WSTFFFFFFFFTSW',
    'WWWWWWWWWWWWWW'
]);

// The same idea at outpost scale: one chest stack either side of the door, a
// smoker in each corner, and a furnace wall along the back.
export const TOASTER_OUTPOST_PLAN = Object.freeze([
    'WWWWW  WWWWW',
    'WSFTC  CTFSW',
    'WT        TW',
    'WF   BB   FW',
    'WT        TW',
    'WSTFFFFFFTSW',
    'WWWWWWWWWWWW'
]);

// Every character the map can hold needs an entry here AND a matching case in
// ToasterGeometry.parse + ToasterGeometry.Slot.kind() on the java side. A kind
// only one side knows is a block Burnt is sent to install and the in-game survey
// then judges against a different block, so the slot can never be satisfied.
const FIXTURE_KINDS = Object.freeze({ C: 'chest', F: 'furnace', S: 'smoker', K: 'crafting_table' });
// Install order rotates through the kinds, so the first appliances she ever fits
// are a chest, a furnace, a smoker and a workbench rather than eighteen furnaces
// and then, eventually, somewhere to put anything.
const INSTALL_WAVE = Object.freeze(['chest', 'furnace', 'smoker', 'crafting_table']);

// A wall torch's `facing` points AWAY from the block holding it up, so the
// value is decided by which wall the column hugs. Getting this wrong is not
// cosmetic: PlaceBlockTask compares the full blockstate, so a torch asked for
// with the wrong facing can never be satisfied.
function torchFacingFor(dx, dz, width, depth) {
    if (dx === 1) return 'east';
    if (dx === width - 2) return 'west';
    if (dz === 1) return 'south';
    if (dz === depth - 2) return 'north';
    return null;
}

// Read the map once, and refuse a malformed one loudly rather than building
// half a house. Offsets are from the north-west floor corner (minX, minZ).
function parseToasterPlan(rows) {
    if (!Array.isArray(rows) || rows.length < 5) throw new Error('toaster plan needs at least 5 rows');
    const depth = rows.length;
    const width = rows[0].length;
    const entrance = [];
    const torches = [];
    const columns = [];
    const beds = [];
    for (let dz = 0; dz < depth; dz += 1) {
        const row = rows[dz];
        if (row.length !== width) throw new Error(`toaster plan row ${dz} is ${row.length} wide, expected ${width}`);
        for (let dx = 0; dx < width; dx += 1) {
            const cell = row[dx];
            const edge = dx === 0 || dz === 0 || dx === width - 1 || dz === depth - 1;
            if (edge) {
                if (cell === ' ') { entrance.push({ dx, dz }); continue; }
                if (cell !== 'W') throw new Error(`toaster plan has '${cell}' on the shell at ${dx},${dz}`);
                continue;
            }
            if (cell === ' ') continue;
            if (cell === 'B') { beds.push({ dx, dz }); continue; }
            if (cell === 'T') {
                const facing = torchFacingFor(dx, dz, width, depth);
                if (!facing) throw new Error(`toaster plan torch at ${dx},${dz} is not against a wall`);
                torches.push({ dx, dz, facing });
                continue;
            }
            const kind = FIXTURE_KINDS[cell];
            if (!kind) throw new Error(`toaster plan has unknown fixture '${cell}' at ${dx},${dz}`);
            columns.push({ dx, dz, kind });
        }
    }
    if (!entrance.length) throw new Error('toaster plan has no walk-through');
    return Object.freeze({
        width, depth,
        entrance: Object.freeze(entrance),
        torches: Object.freeze(torches),
        // Install order: every ground-floor appliance first, then the second
        // course, then the third. Bottom-up is not just tidier - a block placed
        // in mid-air has no face to click on, and the one below it is the face.
        columns: Object.freeze(waveOrder(columns)),
        beds: Object.freeze(beds)
    });
}

function waveOrder(columns) {
    const pools = new Map(INSTALL_WAVE.map((kind) => [kind, columns.filter((c) => c.kind === kind)]));
    // a kind the wave does not name still gets a pool of its own, and EVERY one
    // of them joins it - a `pools.has` guard here kept only the first and the
    // rest vanished from the plan silently, which the java twin does not do.
    for (const column of columns) {
        if (INSTALL_WAVE.includes(column.kind)) continue;
        if (!pools.has(column.kind)) pools.set(column.kind, []);
        pools.get(column.kind).push(column);
    }
    const ordered = [];
    while (ordered.length < columns.length) {
        let moved = false;
        for (const pool of pools.values()) {
            const next = pool.shift();
            if (next) { ordered.push(next); moved = true; }
        }
        if (!moved) break;
    }
    return ordered;
}

const PLANS = new Map();
export function toasterPlan(role = 'homestead') {
    const key = String(role || '').includes('outpost') ? 'outpost' : 'homestead';
    if (!PLANS.has(key)) {
        PLANS.set(key, parseToasterPlan(key === 'outpost' ? TOASTER_OUTPOST_PLAN : TOASTER_HOMESTEAD_PLAN));
    }
    return PLANS.get(key);
}

// How many of a kind the finished plan holds, counting all three courses.
export function toasterFixtureTarget(role, kind) {
    const plan = toasterPlan(role);
    return plan.columns.filter((column) => column.kind === kind).length * TOASTER_STACK_HEIGHT;
}

// THE FOOTPRINT IS THE PLAN, so it never changes WITHIN a version. The homestead
// used to grow by a block of width per furnace, up to 43x20x12 - a hangar, and a
// shell that had to be re-laid twenty-four times because the gallery it was
// sized around kept needing more room. A fixed optimal plan needs neither.
//
// TWO PLANS NOW LIVE AT ONCE, AND THAT IS THE WHOLE POINT OF THE VERSION.
//
//   v1 - the 14x9x8 single-map toaster, extruded upward. Everything already
//        standing in her world is one of these.
//   v2 - the LAYERED 13x21x11 toaster (toaster_plan.js / ToasterPlan.java): a
//        solid base, two slots cut clean through the roof, furnace banks lining
//        them as the elements. A single 2D map cannot describe any of that.
//
// A house that is already built must be LEFT ALONE. Without a version the swap
// would be silent and destructive: the dimensions are spread LAST in the
// constructors below - deliberately, so a stale saved footprint can never leave
// the fixture map addressing blocks outside the house - which means every saved
// 14x9x8 homestead would rehydrate as "13x21x11 at the same anchor" and she
// would set about building the big toaster on top of the one she lives in.
//
// So: a record that does not say what plan it was built to IS a v1 (nothing
// older exists), and only a settlement created fresh gets the latest. The java
// side needs no migration for this - ToasterLayout.applies() tests the exact
// dimensions, so a v1 fails it and falls through to the old ToasterGeometry.
export const TOASTER_PLAN_V1 = 1;
export const TOASTER_PLAN_V2 = 2;
export const TOASTER_PLAN_LATEST = TOASTER_PLAN_V2;

export const TOASTER_HOMESTEAD_BASE_V1 = Object.freeze({
    width: toasterPlan('homestead').width, depth: toasterPlan('homestead').depth, height: 8
});
export const TOASTER_HOMESTEAD_BASE_V2 = Object.freeze({
    width: layeredWidth(), depth: layeredDepth(), height: layeredHeight()
});
// Kept under the old name because callers import it: it is what a NEW homestead
// is built to, which is the latest plan.
export const TOASTER_HOMESTEAD_BASE = TOASTER_HOMESTEAD_BASE_V2;
// THE LAYERED PLAN HAS NO OUTPOST DRAWN FOR IT, so an outpost is a v1 by
// construction and there is nothing for it to migrate to yet. It carries a
// version anyway, so the day one is drawn this is a number and not a rewrite.
export const TOASTER_OUTPOST_BASE = Object.freeze({
    width: toasterPlan('outpost').width, depth: toasterPlan('outpost').depth, height: 6
});

/** Clamp anything a record might be carrying to a version that actually exists. */
export function toasterPlanVersion(value, latest = TOASTER_PLAN_LATEST) {
    const raw = Math.floor(Number(value));
    if (!Number.isFinite(raw)) return latest;
    return Math.min(latest, Math.max(TOASTER_PLAN_V1, raw));
}

export function toasterHomesteadDimensions(planVersion = TOASTER_PLAN_LATEST) {
    return toasterPlanVersion(planVersion) >= TOASTER_PLAN_V2
        ? { ...TOASTER_HOMESTEAD_BASE_V2 }
        : { ...TOASTER_HOMESTEAD_BASE_V1 };
}

export function toasterOutpostDimensions(planVersion = TOASTER_PLAN_V1) {
    // one plan, so the version is carried and never branched on.
    void planVersion;
    return { ...TOASTER_OUTPOST_BASE };
}

/** Is this settlement read off the layered plan rather than the 14x9 ascii? */
export function toasterIsLayered(settlement) {
    return String(settlement?.kind || '').startsWith('toaster_')
        && toasterPlanVersion(settlement?.planVersion) >= TOASTER_PLAN_V2
        // belt and braces: the constructors force the footprint from the
        // version, so this can only ever fail on a hand-built object - and
        // reading the layered plan at the wrong size would address blocks
        // outside the house, which is the one outcome worth a hard no.
        && settlement.width === layeredWidth()
        && settlement.depth === layeredDepth()
        && settlement.height === layeredHeight();
}

// The plan's dimensions are spread LAST on purpose. A settlement rehydrated
// from an older save carries the shell size it was built at, and letting that
// win would leave the fixture map addressing blocks outside the house. Which
// plan's dimensions those are is the ONE thing the record gets to decide - see
// TOASTER_PLAN_V1 above for why an unversioned record is a v1 and not a v2.
export class ToasterHomestead extends Homestead {
    constructor(options = {}) {
        const furnaceTarget = Math.max(1, Math.floor(Number(options.furnaceTarget) || 1));
        // No version named means a settlement being CREATED, which is built to
        // the latest plan. settlementFromJSON is where a record off disk gets
        // its legacy default, because that is the only place that knows the
        // difference between rehydrating and building.
        const planVersion = toasterPlanVersion(options.planVersion);
        super({ ...options, ...toasterHomesteadDimensions(planVersion) });
        this.planVersion = planVersion;
        this.furnaceTarget = furnaceTarget;
    }
    get kind() { return 'toaster_homestead'; }
    /**
     * The ascii map, for a v1 only. The layered plan is eleven maps and no
     * single one of them is "the plan", so a v2 answers null rather than
     * handing back a 14x9 map of a house that is 13x21 - the geometry helpers
     * below are the way to ask a v2 anything.
     */
    get plan() { return toasterIsLayered(this) ? null : toasterPlan('homestead'); }
    blueprint() { return toasterBlueprint(this); }
    applianceSlots() { return toasterApplianceSlots(this); }
    applianceSlot(index) { return toasterApplianceSlot(this, index); }
    appliancePosition(index = 0) {
        const slot = this.applianceSlot(index);
        return slot ? { x: slot.x, y: slot.y, z: slot.z } : null;
    }
    toJSON() {
        return { ...super.toJSON(), planVersion: this.planVersion, furnaceTarget: this.furnaceTarget };
    }
}

export class ToasterOutpost extends Outpost {
    constructor(options = {}) {
        const level = Math.max(1, Math.floor(Number(options.level) || 1));
        // there is only one outpost plan, so this is always 1 - carried so the
        // record says what it was built to rather than leaving it to be guessed.
        const planVersion = toasterPlanVersion(options.planVersion, TOASTER_PLAN_V1);
        super({ ...options, ...toasterOutpostDimensions(planVersion) });
        this.planVersion = planVersion;
        this.level = level;
    }
    get kind() { return 'toaster_outpost'; }
    get plan() { return toasterPlan('outpost'); }
    blueprint() { return toasterBlueprint(this); }
    applianceSlots() { return toasterApplianceSlots(this); }
    applianceSlot(index) { return toasterApplianceSlot(this, index); }
    appliancePosition(index = 0) {
        const slot = this.applianceSlot(index);
        return slot ? { x: slot.x, y: slot.y, z: slot.z } : null;
    }
    toJSON() {
        return { ...super.toJSON(), planVersion: this.planVersion, level: this.level };
    }
}

// The north-west floor corner every plan offset is measured from.
export function toasterBounds(settlement) {
    const minX = settlement.anchor.x - Math.floor(settlement.width / 2);
    const minZ = settlement.anchor.z - Math.floor(settlement.depth / 2);
    const floorY = settlement.anchor.y - 1;
    return {
        minX, minZ, floorY,
        maxX: minX + settlement.width - 1,
        maxZ: minZ + settlement.depth - 1,
        roofY: floorY + settlement.height - 1
    };
}

// The band around the shell that has to be air, measured out from every wall.
// The floor course is deliberately outside it: a yard is ground she can stand
// on, not a moat. It runs up to and including the roof line, so a tree beside
// the house is felled to the height the house actually occupies.
export function toasterYardBounds(settlement) {
    const { minX, maxX, minZ, maxZ, floorY, roofY } = toasterBounds(settlement);
    return {
        margin: TOASTER_YARD_MARGIN,
        minX: minX - TOASTER_YARD_MARGIN, maxX: maxX + TOASTER_YARD_MARGIN,
        minZ: minZ - TOASTER_YARD_MARGIN, maxZ: maxZ + TOASTER_YARD_MARGIN,
        minY: floorY + 1, maxY: roofY
    };
}

// How far apart the ground torches in the yard stand. A torch is light 14 and
// block light drops 1 per block travelled, so a spot goes dark at 14. On a
// ten-block grid the worst place to stand - dead centre of four torches - is
// 5+5 away, i.e. light 4, which leaves three blocks of slack for ground that is
// not level. Hostile mobs need light ZERO, not low light.
// MUST MATCH Settlement.PERIMETER_LIGHT_SPACING in the java.
export const TOASTER_PERIMETER_LIGHT_SPACING = 10;

// Evenly spaced stops across a span, both ends included, no gap wider than the
// spacing. Stepping from one edge and stopping before an overshoot would leave
// the far edge of the yard dark, so the count rounds UP and the stops spread
// across it. Byte-for-byte the same arithmetic as Settlement#lightStops.
function lightStops(min, max) {
    const span = max - min;
    if (span <= 0) return [min];
    const steps = Math.max(1, Math.ceil(span / TOASTER_PERIMETER_LIGHT_SPACING));
    const stops = [];
    for (let i = 0; i <= steps; i++) {
        // java's Math.round is floor(x + 0.5); js Math.round matches on the
        // non-negative values a span ever produces here.
        stops.push(min + Math.round((span * i) / steps));
    }
    return stops;
}

// WHERE THE YARD GETS ITS TORCHES. The floorplan's wall torches light the INSIDE
// of the house and do nothing about the ten metres of cleared, unlit ground
// around it - which is a mob farm with a view. Derived from the yard, never
// stored, so an existing homestead gets its lights with nothing to migrate.
// Torches stand at floorY + 1 on the ground at floorY: the yard clear empties
// everything ABOVE the floor course, so that is the one height out there
// guaranteed to be air with something underneath. The house footprint is
// skipped - it has its own torches inside and its walls are not ground.
export function toasterPerimeterLights(settlement) {
    const { minX, maxX, minZ, maxZ, floorY } = toasterBounds(settlement);
    const yard = toasterYardBounds(settlement);
    const spots = [];
    for (const x of lightStops(yard.minX, yard.maxX)) {
        for (const z of lightStops(yard.minZ, yard.maxZ)) {
            if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) continue;
            spots.push({ x, y: floorY + 1, z });
        }
    }
    return spots;
}

// THE RING, measured out from the yard rather than from the shell. `floorY` is
// the trench FLOOR - the solid course she must not dig through - and `gradeY` is
// the ground level it was cut down from, which is the settlement's own floor.
// Derived, never stored, exactly like the yard: an existing homestead gets its
// trench geometry with nothing to migrate.
export function toasterTrenchBounds(settlement) {
    const { floorY } = toasterBounds(settlement);
    const yard = toasterYardBounds(settlement);
    return {
        depth: TOASTER_TRENCH_DEPTH, width: TOASTER_TRENCH_WIDTH,
        minX: yard.minX - TOASTER_TRENCH_WIDTH, maxX: yard.maxX + TOASTER_TRENCH_WIDTH,
        minZ: yard.minZ - TOASTER_TRENCH_WIDTH, maxZ: yard.maxZ + TOASTER_TRENCH_WIDTH,
        floorY: floorY - TOASTER_TRENCH_DEPTH,
        gradeY: floorY
    };
}

// The top of the solid ground beneath a ring column. Normally the trench floor;
// in the stair run it climbs a block at a time, so the steps fall out of the same
// arithmetic that carves the void instead of being a second description of the
// same geometry. Byte-for-byte Settlement#trenchFinalGroundY - the node side
// always answers for the FINISHED trench, since it has no layer gate to clamp to.
function trenchGroundY(settlement, x, z) {
    const { floorY } = toasterBounds(settlement);
    const yard = toasterYardBounds(settlement);
    const stairX = settlement.anchor.x + 2;
    if (z === yard.maxZ + 1 && x >= stairX && x < stairX + TOASTER_TRENCH_DEPTH) {
        return floorY - 1 - (x - stairX);
    }
    return floorY - TOASTER_TRENCH_DEPTH;
}

// Where the fence gate stands: the outer lip of the causeway, so nothing can step
// onto the bridge. The causeway itself is solid at the floor course ONLY, on the
// +Z face at the anchor's x - a bridge, not a dam, so the trench floor runs
// unbroken all the way round and a fall anywhere still reaches the stairs.
export function toasterCausewayGate(settlement) {
    const { floorY } = toasterBounds(settlement);
    return { x: settlement.anchor.x, y: floorY + 1, z: toasterTrenchBounds(settlement).maxZ };
}

// TORCHES ON THE TRENCH FLOOR, on the same grid rule as the yard. Without these
// the trench is a four-block-deep unlit ditch ringing the base - at night a spawn
// platform for exactly the creepers it was dug to keep out, only now inside the
// line. One above each column's OWN floor, so a torch in the stair run lands on
// the step rather than inside the rock holding it up.
export function toasterTrenchLights(settlement) {
    const yard = toasterYardBounds(settlement);
    const trench = toasterTrenchBounds(settlement);
    const innerZLow = yard.minZ - 1, innerZHigh = yard.maxZ + 1;
    const innerXLow = yard.minX - 1, innerXHigh = yard.maxX + 1;
    const spots = [];
    // ⚠ the two loops span DIFFERENT things and that is not a typo - it is what
    // stops them landing on the same column twice. The x run walks the whole
    // trench box; the z run walks the YARD, and the x run's two z values sit one
    // block outside that span, so the runs can never meet. Same as the java.
    for (const x of lightStops(trench.minX, trench.maxX)) {
        spots.push({ x, y: trenchGroundY(settlement, x, innerZLow) + 1, z: innerZLow });
        spots.push({ x, y: trenchGroundY(settlement, x, innerZHigh) + 1, z: innerZHigh });
    }
    for (const z of lightStops(yard.minZ, yard.maxZ)) {
        spots.push({ x: innerXLow, y: trenchGroundY(settlement, innerXLow, z) + 1, z });
        spots.push({ x: innerXHigh, y: trenchGroundY(settlement, innerXHigh, z) + 1, z });
    }
    return spots;
}

// How far apart two toasters have to stand for neither one's yard to reach the
// other's walls. Without this the nearer settlement's shell sits INSIDE the
// further one's yard, and "clear the yard" becomes "demolish the outpost".
//
// ⚠ THE TRENCH WIDTH COUNTS TOO. The moat is dug OUTSIDE the yard, so a spacing
// that only clears the yards leaves two rings overlapping - and one settlement's
// "carve this column down four blocks" is the other's yard floor. Two houses
// trenching through each other is a hole where the neighbour used to stand.
export function toasterYardSeparation(a, b) {
    const reach = (s) => Math.max(s.width, s.depth) / 2 + TOASTER_YARD_MARGIN + TOASTER_TRENCH_WIDTH;
    return Math.ceil(reach(a) + reach(b));
}

const planOf = (settlement) => toasterPlan(settlement?.role === 'outpost' ? 'outpost' : 'homestead');

// ---------------------------------------------------------------------------
// THE LAYERED PLAN (v2)
//
// Everything below this line answers a v2 toaster off toaster_layout.js and
// NEVER off the ascii map above. The two describe different houses at different
// sizes, so a 13x21 settlement run through the 14x9 map does not merely give a
// worse answer - it names blocks that are outside the building.

// Every cell of the given glyphs the FINISHED plan holds. 'full' rather than the
// live stage on purpose: burnt's install ledger is an INDEX into this list, and
// a stage-scoped list renumbers itself every time the stage moves.
const layeredCells = (settlement, glyphs) =>
    toasterCells(settlement, 'full').filter((cell) => glyphs.includes(cell.glyph));

// Openings ('D', 'S') belong to no stage - they are CUT, not placed - so they
// are absent from toasterCells and have to be read off the map directly.
function layeredGlyphPositions(settlement, glyph, layer = null) {
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const found = [];
    for (let l = 0; l < layeredHeight(); l += 1) {
        if (layer !== null && l !== layer) continue;
        for (let dz = 0; dz < layeredDepth(); dz += 1) {
            for (let dx = 0; dx < layeredWidth(); dx += 1) {
                const pos = { x: minX + dx, y: floorY + l, z: minZ + dz };
                if (layeredGlyphAt(settlement, pos) === glyph) found.push({ ...pos, dx, dz, layer: l });
            }
        }
    }
    return found;
}

// Minecraft's own horizontal order, so this and the java twin walk the sides in
// the same sequence and cannot disagree about a corner.
const HORIZONTAL = Object.freeze([['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]]);

// A wall torch points AWAY from the block holding it up, so the answer is
// whichever neighbour is shell. Getting it wrong is not cosmetic: the in-game
// placer compares the whole blockstate, so a torch asked for with the wrong
// facing is a spot that can never be satisfied.
//
// The authority is ToasterLayout.wallTorchFacing in the java. This copy lives
// here only because the node twin (toaster_layout.js) does not export one yet;
// it belongs there, next to the rest of the plan reading.
function layeredWallTorchFacing(settlement, pos) {
    for (const [name, ox, oz] of HORIZONTAL) {
        if (layeredGlyphAt(settlement, { x: pos.x - ox, y: pos.y, z: pos.z - oz }) === GLYPH_SHELL) return name;
    }
    return 'north';
}

// Every appliance block in the finished toaster, in the order she installs
// them: the whole ground course first, then the one above it, then the top.
export function toasterApplianceSlots(settlement) {
    if (toasterIsLayered(settlement)) {
        // cellsFor's order is the build order - bench, then chests, then the
        // furnace banks, bottom course of each first. Filtering preserves it.
        return layeredCells(settlement, [GLYPH_BENCH, GLYPH_CHEST, GLYPH_FURNACE]).map((cell, index) => ({
            // `level` is the PLAN LAYER for a v2, not a course within a stack of
            // three - the layered toaster has no stacks, it has banks.
            index, kind: cell.kind, level: cell.layer, x: cell.x, y: cell.y, z: cell.z
        }));
    }
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const plan = planOf(settlement);
    const slots = [];
    for (let level = 0; level < TOASTER_STACK_HEIGHT; level += 1) {
        for (const column of plan.columns) {
            slots.push({
                index: slots.length, kind: column.kind, level,
                x: minX + column.dx, y: floorY + 1 + level, z: minZ + column.dz
            });
        }
    }
    return slots;
}

export function toasterApplianceSlot(settlement, index = 0) {
    const slots = toasterApplianceSlots(settlement);
    if (!slots.length) return null;
    const n = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0;
    return slots[n % slots.length];
}

// Three torches up each wall column, low to high.
export function toasterTorchPositions(settlement) {
    if (toasterIsLayered(settlement)) {
        // TWO KINDS OF TORCH. The layered plan holds 104 FLOOR torches standing
        // on the banks and the deck, and 2 WALL torches - the pair either side
        // of the door. A standing torch has no wall to point away from, so its
        // facing is 'up', which is also what tells a placer to click the block
        // BENEATH it instead of a neighbouring wall.
        return layeredCells(settlement, [GLYPH_WALL_TORCH, GLYPH_TORCH]).map((cell) => ({
            x: cell.x, y: cell.y, z: cell.z,
            facing: cell.glyph === GLYPH_WALL_TORCH ? layeredWallTorchFacing(settlement, cell) : 'up'
        }));
    }
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const plan = planOf(settlement);
    const torches = [];
    // level-major, exactly like the in-game side: the whole low course of the
    // room lights before she starts reaching up, and the two implementations
    // hand out the same spot in the same order.
    for (let level = 0; level < TOASTER_STACK_HEIGHT; level += 1) {
        for (const spot of plan.torches) {
            torches.push({ x: minX + spot.dx, y: floorY + 1 + level, z: minZ + spot.dz, facing: spot.facing });
        }
    }
    return torches;
}

// Interior floor the plan leaves empty, in reading order. Collection pieces
// that the map has no square for - campfires, blast furnaces, a workbench -
// stand here, so an unplanned unit can never take a planned stack's block.
export function toasterOpenFloor(settlement) {
    if (toasterIsLayered(settlement)) return layeredOpenFloor(settlement);
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const plan = planOf(settlement);
    const taken = new Set();
    const claim = (dx, dz) => taken.add(`${dx},${dz}`);
    for (const column of plan.columns) claim(column.dx, column.dz);
    for (const torch of plan.torches) claim(torch.dx, torch.dz);
    for (const bed of plan.beds) claim(bed.dx, bed.dz);
    // and the square just inside the door stays walkable, whichever wall it is in
    for (const gap of plan.entrance) {
        if (gap.dz === 0) claim(gap.dx, 1);
        else if (gap.dz === plan.depth - 1) claim(gap.dx, plan.depth - 2);
        else if (gap.dx === 0) claim(1, gap.dz);
        else if (gap.dx === plan.width - 1) claim(plan.width - 2, gap.dz);
    }
    const open = [];
    for (let dz = 1; dz < plan.depth - 1; dz += 1) {
        for (let dx = 1; dx < plan.width - 1; dx += 1) {
            if (taken.has(`${dx},${dz}`)) continue;
            open.push({ x: minX + dx, y: floorY + 1, z: minZ + dz });
        }
    }
    return open;
}

// The room floor of a LAYERED toaster: layer 1, because layer 0 is the solid
// base she stands on rather than a course of the room.
//
// "Air" alone is not enough of a test. The doorstep juts two rows past the back
// of the map, so layer 1 has open cells beside and beyond it that are the garden,
// not the room - and calling those open floor would have her set a workbench down
// outside her own front door. A square only counts with a floor under it AND a
// roof over it, which is exactly what the base course and the roof course are.
function layeredOpenFloor(settlement) {
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const y = floorY + 1;
    const top = floorY + layeredHeight() - 1;
    const claimed = new Set();
    // the square just inside the door stays walkable, whichever wall it is in
    for (const door of layeredGlyphPositions(settlement, GLYPH_DOOR, 1)) {
        for (const [, ox, oz] of HORIZONTAL) claimed.add(`${door.dx + ox},${door.dz + oz}`);
    }
    const open = [];
    for (let dz = 1; dz < layeredDepth() - 1; dz += 1) {
        for (let dx = 1; dx < layeredWidth() - 1; dx += 1) {
            if (claimed.has(`${dx},${dz}`)) continue;
            const spot = { x: minX + dx, y, z: minZ + dz };
            if (layeredGlyphAt(settlement, spot) !== GLYPH_AIR) continue;
            if (layeredGlyphAt(settlement, { ...spot, y: floorY }) !== GLYPH_SHELL) continue;
            if (layeredGlyphAt(settlement, { ...spot, y: top }) !== GLYPH_SHELL) continue;
            open.push(spot);
        }
    }
    return open;
}

export function toasterBedPositions(settlement) {
    if (toasterIsLayered(settlement)) {
        // ON THE UPPER DECK, not on the ground: the layered plan puts the bed
        // where a toaster's carriage sits, six courses up. The position is the
        // plan's own, so a caller that walks her to it walks her upstairs.
        return layeredCells(settlement, [GLYPH_BED]).map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }));
    }
    const { minX, minZ, floorY } = toasterBounds(settlement);
    return planOf(settlement).beds.map((bed) => ({ x: minX + bed.dx, y: floorY + 1, z: minZ + bed.dz }));
}

// WHERE THE SLOTS ARE CUT, off the layered plan.
//
// A v1 toaster's slots are two rows in the roof, which is all a single extruded
// map can express. The layered plan cuts two two-block-wide shafts clean through
// it, so each one is reported as the box it actually occupies - found by walking
// the roof course's openings and joining the columns that touch.
function layeredToastSlots(settlement) {
    const roof = layeredHeight() - 1;
    const groups = [];
    const cells = layeredGlyphPositions(settlement, GLYPH_OPENING, roof)
        .sort((a, b) => a.dx - b.dx || a.dz - b.dz);
    for (const cell of cells) {
        const last = groups[groups.length - 1];
        if (last && cell.dx - last.maxDx <= 1) {
            last.maxDx = Math.max(last.maxDx, cell.dx);
            last.minDz = Math.min(last.minDz, cell.dz);
            last.maxDz = Math.max(last.maxDz, cell.dz);
            continue;
        }
        groups.push({ minDx: cell.dx, maxDx: cell.dx, minDz: cell.dz, maxDz: cell.dz });
    }
    const { minX, minZ, floorY } = toasterBounds(settlement);
    const y = floorY + roof;
    return groups.map((group) => ({
        from: { x: minX + group.minDx, y, z: minZ + group.minDz },
        to: { x: minX + group.maxDx, y, z: minZ + group.maxDz }
    }));
}

export function toasterBlueprint(settlement) {
    if (!settlement || !String(settlement.kind || '').startsWith('toaster_')) {
        throw new Error('toaster blueprint needs a toaster settlement');
    }
    const { minX, maxX, minZ, maxZ, floorY, roofY } = toasterBounds(settlement);
    const layered = toasterIsLayered(settlement);
    let slots;
    const walkthrough = [];
    if (layered) {
        slots = layeredToastSlots(settlement);
        // The door is wherever the plan cuts a walk-through, at whatever height
        // it cuts it - the layered map says so itself instead of being assumed
        // to be two blocks tall in the top row.
        for (const door of layeredGlyphPositions(settlement, GLYPH_DOOR)) {
            walkthrough.push({ x: door.x, y: door.y, z: door.z });
        }
    } else {
        const centreZ = minZ + Math.floor(settlement.depth / 2);
        const slotZ = [Math.max(minZ + 2, centreZ - 2), Math.min(maxZ - 2, centreZ + 2)];
        slots = slotZ.map((z) => ({ from: { x: minX + 3, y: roofY, z }, to: { x: maxX - 3, y: roofY, z } }));
        // The door is wherever the plan leaves the top row open, two blocks tall.
        for (const gap of planOf(settlement).entrance) {
            for (let y = floorY + 1; y <= floorY + 2; y += 1) walkthrough.push({ x: minX + gap.dx, y, z: minZ + gap.dz });
        }
    }
    const blueprint = {
        shape: 'rectangular_prism', material: 'stone', doorRequired: false,
        bounds: { minX, maxX, minZ, maxZ, floorY, roofY },
        toastSlotCount: slots.length, toastSlots: slots, walkthrough,
        yard: toasterYardBounds(settlement),
        // named sideTorches for the callers that already read it; they now light
        // the inside walls, where the mobs she is keeping out would spawn.
        sideTorches: toasterTorchPositions(settlement),
        // the ring of ground torches out in the cleared yard. the wall torches
        // above stop things spawning INSIDE the house; these are what stop them
        // spawning ten blocks from the front door and walking in.
        yardLights: toasterPerimeterLights(settlement),
        applianceSlots: toasterApplianceSlots(settlement),
        beds: toasterBedPositions(settlement),
        stackHeight: TOASTER_STACK_HEIGHT
    };
    return { ...blueprint, plan: toasterBuildPlan(settlement, blueprint) };
}

// APT-style contract: planning is explicit data, while the in-game task remains
// deterministic. This lets Burnt explain, schedule, and verify a build without
// asking an LLM to invent individual block placements.
// v1: the shell is every face of the prism that is not an opening, counted block
// by block. A map that is extruded rather than drawn course by course cannot be
// priced any other way.
function asciiMaterialManifest(settlement, spec, yardLights) {
    const { minX, maxX, minZ, maxZ, floorY, roofY } = spec.bounds;
    const blocked = new Set([
        ...spec.walkthrough.map((p) => `${p.x},${p.y},${p.z}`),
        ...spec.toastSlots.flatMap((slot) => {
            const positions = [];
            for (let x = slot.from.x; x <= slot.to.x; x += 1) {
                positions.push(`${x},${slot.from.y},${slot.from.z}`);
            }
            return positions;
        })
    ]);
    let stone = 0;
    for (let x = minX; x <= maxX; x += 1) {
        for (let y = floorY; y <= roofY; y += 1) {
            for (let z = minZ; z <= maxZ; z += 1) {
                const edge = y === floorY || y === roofY || x === minX || x === maxX || z === minZ || z === maxZ;
                if (edge && !blocked.has(`${x},${y},${z}`)) stone += 1;
            }
        }
    }
    const appliances = spec.applianceSlots || toasterApplianceSlots(settlement);
    const countOf = (kind) => appliances.filter((slot) => slot.kind === kind).length;
    return {
        stone, torch: spec.sideTorches.length + yardLights.length,
        chest: countOf('chest'), furnace: countOf('furnace'), smoker: countOf('smoker'),
        crafting_table: countOf('crafting_table'),
        bed: Math.ceil((spec.beds || toasterBedPositions(settlement)).length / 2)
    };
}

// v2: THE LAYERED PLAN PRICES ITSELF. toasterManifest counts the same cells the
// build order is drawn from and it knows a bed is two blocks but ONE item, and
// that a furnace is eight cobble on top of being a placement. Counting the prism
// faces here instead would be a second copy of the plan's arithmetic, and the
// one it would disagree with is the one she actually builds from.
function layeredMaterialManifest(settlement, yardLights) {
    const owed = toasterManifest(settlement, 'full', 'stone');
    return {
        stone: owed.stone,
        torch: owed.torch + yardLights.length,
        chest: owed.chest,
        furnace: owed.furnace,
        // the furnaces are the single biggest lump of work in the plan and they
        // are not free just because they are "a furnace" - 8 cobble each.
        cobblestone_for_furnaces: owed.cobblestone_for_furnaces,
        // the layered plan draws no smokers at all; named so a reader is not
        // left wondering whether the count went missing.
        smoker: 0,
        crafting_table: owed.crafting_table,
        bed: owed.bed
    };
}

export function toasterBuildPlan(settlement, blueprint = null) {
    const spec = blueprint || toasterBlueprint(settlement);
    const yardLights = spec.yardLights || toasterPerimeterLights(settlement);
    return {
        version: 2,
        // "stone" is the FAMILY, not the recipe - the in-game task accepts any
        // shell stone (cobble, deepslate, andesite, blackstone...), so a manifest
        // that demanded smooth_stone was quoting a cost she never has to pay.
        materialManifest: toasterIsLayered(settlement)
            ? layeredMaterialManifest(settlement, yardLights)
            : asciiMaterialManifest(settlement, spec, yardLights),
        phases: [
            { id: 'survey', verify: ['anchor', 'clearance'] },
            { id: 'gather_materials', requires: ['stone', 'torch'] },
            { id: 'build_shell', verify: ['floor', 'walls', 'roof', 'toast_slots', 'walkthrough'] },
            { id: 'light_sides', verify: ['side_torches'] },
            { id: 'install_gallery', verify: ['chest_stacks', 'furnace_stacks', 'smoker_stacks', 'crafting_table_stacks'] },
            // The yard is last because it is the only phase whose size the plan
            // cannot know - open ground starts finished and a wood starts at
            // thousands of blocks - so nothing else may be made to wait behind it.
            { id: 'clear_yard', verify: ['yard'] },
            // AFTER the yard, not before: a ground torch needs ground, and until
            // the yard is felled "the ground" out there is whatever tree is
            // standing on it.
            { id: 'light_yard', verify: ['yard_lights'] },
            { id: 'final_survey', verify: ['complete'] }
        ]
    };
}

export function settlementFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
        // A RECORD THAT DOES NOT SAY WHICH PLAN IT WAS BUILT TO IS A v1, because
        // nothing older than v1 has ever existed and every house standing in her
        // world today is one. This is the ONE place that distinction can be
        // made - the constructors cannot tell being rehydrated from being
        // created, and defaulting to the latest in there would quietly re-size
        // her home under her and send her to build the layered toaster on top of
        // it. Everything else about the round trip is preserved by toJSON.
        if (raw.kind === 'toaster_homestead') {
            return new ToasterHomestead({ planVersion: TOASTER_PLAN_V1, ...raw });
        }
        if (raw.kind === 'toaster_outpost') {
            return new ToasterOutpost({ planVersion: TOASTER_PLAN_V1, ...raw });
        }
        if (raw.role === 'homestead') return new Homestead(raw);
        if (raw.role === 'outpost') return new Outpost(raw);
        return new Settlement(raw);
    } catch {
        return null;
    }
}

export function mainIsBiggest(main, settlements = []) {
    if (!main) return false;
    return settlements.every((candidate) => !candidate || candidate.id === main.id ||
        (main.width > candidate.width && main.depth > candidate.depth && main.height > candidate.height));
}

export function fitOutpostBelowHomestead(outpost, homestead) {
    if (!outpost || !homestead) return outpost;
    // A TOASTER IS ITS FLOORPLAN. Shrinking one below the map it is built from
    // would leave every chest, furnace and torch addressing a block outside the
    // house. The two plans are already drawn to keep the homestead strictly
    // bigger, so there is nothing to clamp - this only ever applies to plain
    // settlements, which have no fixture map to break.
    if (String(outpost.kind || '').startsWith('toaster_')) return outpost;
    outpost.width = Math.min(outpost.width, Math.max(5, homestead.width - 2));
    outpost.depth = Math.min(outpost.depth, Math.max(5, homestead.depth - 2));
    outpost.height = Math.min(outpost.height, Math.max(5, homestead.height - 2));
    return outpost;
}
