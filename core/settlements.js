// Portable settlement geometry/state for Burtcraft.  This module deliberately
// has no Burnt runtime dependencies so the same model can ship in the standalone
// open-source core (tmp/burtcraft-repo/core).

const clean = (value, max = 64) => String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const point = (value) => {
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
    return { x: Math.round(value.x), y: Math.round(value.y), z: Math.round(value.z) };
};

const dimension = (value) => clean(value || 'overworld', 64);

const MAX_APPLIANCE_LEDGER = 128;

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
//   ' ' on the top row  = the walk-through
//
// Every T/C/F/S is a COLUMN OF THREE: one on the ground, one above that, one
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

export const TOASTER_HOMESTEAD_PLAN = Object.freeze([
    'WWWWWW  WWWWWW',
    'WSFTCT  TCTFSW',
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

const FIXTURE_KINDS = Object.freeze({ C: 'chest', F: 'furnace', S: 'smoker' });
// Install order rotates through the kinds, so the first three appliances she
// ever fits are a chest, a furnace and a smoker rather than eighteen furnaces
// and then, eventually, somewhere to put anything.
const INSTALL_WAVE = Object.freeze(['chest', 'furnace', 'smoker']);

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

// THE FOOTPRINT IS THE PLAN, so it never changes. The homestead used to grow by
// a block of width per furnace, up to 43x20x12 - a hangar, and a shell that had
// to be re-laid twenty-four times because the gallery it was sized around kept
// needing more room. A fixed optimal plan needs neither.
export const TOASTER_HOMESTEAD_BASE = Object.freeze({
    width: toasterPlan('homestead').width, depth: toasterPlan('homestead').depth, height: 8
});
export const TOASTER_OUTPOST_BASE = Object.freeze({
    width: toasterPlan('outpost').width, depth: toasterPlan('outpost').depth, height: 6
});

export function toasterHomesteadDimensions() {
    return { ...TOASTER_HOMESTEAD_BASE };
}

export function toasterOutpostDimensions() {
    return { ...TOASTER_OUTPOST_BASE };
}

// The plan's dimensions are spread LAST on purpose. A settlement rehydrated
// from an older save carries the shell size it was built at, and letting that
// win would leave the fixture map addressing blocks outside the house.
export class ToasterHomestead extends Homestead {
    constructor(options = {}) {
        const furnaceTarget = Math.max(1, Math.floor(Number(options.furnaceTarget) || 1));
        super({ ...options, ...toasterHomesteadDimensions() });
        this.furnaceTarget = furnaceTarget;
    }
    get kind() { return 'toaster_homestead'; }
    get plan() { return toasterPlan('homestead'); }
    blueprint() { return toasterBlueprint(this); }
    applianceSlots() { return toasterApplianceSlots(this); }
    applianceSlot(index) { return toasterApplianceSlot(this, index); }
    appliancePosition(index = 0) {
        const slot = this.applianceSlot(index);
        return slot ? { x: slot.x, y: slot.y, z: slot.z } : null;
    }
    toJSON() { return { ...super.toJSON(), furnaceTarget: this.furnaceTarget }; }
}

export class ToasterOutpost extends Outpost {
    constructor(options = {}) {
        const level = Math.max(1, Math.floor(Number(options.level) || 1));
        super({ ...options, ...toasterOutpostDimensions() });
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
    toJSON() { return { ...super.toJSON(), level: this.level }; }
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

// How far apart two toasters have to stand for neither one's yard to reach the
// other's walls. Without this the nearer settlement's shell sits INSIDE the
// further one's yard, and "clear the yard" becomes "demolish the outpost".
export function toasterYardSeparation(a, b) {
    const reach = (s) => Math.max(s.width, s.depth) / 2 + TOASTER_YARD_MARGIN;
    return Math.ceil(reach(a) + reach(b));
}

const planOf = (settlement) => toasterPlan(settlement?.role === 'outpost' ? 'outpost' : 'homestead');

// Every appliance block in the finished toaster, in the order she installs
// them: the whole ground course first, then the one above it, then the top.
export function toasterApplianceSlots(settlement) {
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

export function toasterBedPositions(settlement) {
    const { minX, minZ, floorY } = toasterBounds(settlement);
    return planOf(settlement).beds.map((bed) => ({ x: minX + bed.dx, y: floorY + 1, z: minZ + bed.dz }));
}

export function toasterBlueprint(settlement) {
    if (!settlement || !String(settlement.kind || '').startsWith('toaster_')) {
        throw new Error('toaster blueprint needs a toaster settlement');
    }
    const { minX, maxX, minZ, maxZ, floorY, roofY } = toasterBounds(settlement);
    const centreZ = minZ + Math.floor(settlement.depth / 2);
    const slotZ = [Math.max(minZ + 2, centreZ - 2), Math.min(maxZ - 2, centreZ + 2)];
    const slots = slotZ.map((z) => ({ from: { x: minX + 3, y: roofY, z }, to: { x: maxX - 3, y: roofY, z } }));
    // The door is wherever the plan leaves the top row open, two blocks tall.
    const walkthrough = [];
    for (const gap of planOf(settlement).entrance) {
        for (let y = floorY + 1; y <= floorY + 2; y += 1) walkthrough.push({ x: minX + gap.dx, y, z: minZ + gap.dz });
    }
    const blueprint = {
        shape: 'rectangular_prism', material: 'stone', doorRequired: false,
        bounds: { minX, maxX, minZ, maxZ, floorY, roofY },
        toastSlotCount: 2, toastSlots: slots, walkthrough,
        yard: toasterYardBounds(settlement),
        // named sideTorches for the callers that already read it; they now light
        // the inside walls, where the mobs she is keeping out would spawn.
        sideTorches: toasterTorchPositions(settlement),
        applianceSlots: toasterApplianceSlots(settlement),
        beds: toasterBedPositions(settlement),
        stackHeight: TOASTER_STACK_HEIGHT
    };
    return { ...blueprint, plan: toasterBuildPlan(settlement, blueprint) };
}

// APT-style contract: planning is explicit data, while the in-game task remains
// deterministic. This lets Burnt explain, schedule, and verify a build without
// asking an LLM to invent individual block placements.
export function toasterBuildPlan(settlement, blueprint = null) {
    const spec = blueprint || toasterBlueprint(settlement);
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
        version: 2,
        // "stone" is the FAMILY, not the recipe - the in-game task accepts any
        // shell stone (cobble, deepslate, andesite, blackstone...), so a manifest
        // that demanded smooth_stone was quoting a cost she never has to pay.
        materialManifest: {
            stone, torch: spec.sideTorches.length,
            chest: countOf('chest'), furnace: countOf('furnace'), smoker: countOf('smoker'),
            bed: Math.ceil((spec.beds || toasterBedPositions(settlement)).length / 2)
        },
        phases: [
            { id: 'survey', verify: ['anchor', 'clearance'] },
            { id: 'gather_materials', requires: ['stone', 'torch'] },
            { id: 'build_shell', verify: ['floor', 'walls', 'roof', 'toast_slots', 'walkthrough'] },
            { id: 'light_sides', verify: ['side_torches'] },
            { id: 'install_gallery', verify: ['chest_stacks', 'furnace_stacks', 'smoker_stacks'] },
            // The yard is last because it is the only phase whose size the plan
            // cannot know - open ground starts finished and a wood starts at
            // thousands of blocks - so nothing else may be made to wait behind it.
            { id: 'clear_yard', verify: ['yard'] },
            { id: 'final_survey', verify: ['complete'] }
        ]
    };
}

export function settlementFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
        if (raw.kind === 'toaster_homestead') return new ToasterHomestead(raw);
        if (raw.kind === 'toaster_outpost') return new ToasterOutpost(raw);
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
