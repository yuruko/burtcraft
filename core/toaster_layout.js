// READING THE TOASTER OFF ITS PLAN - burnt's side.
//
// The twin of ToasterLayout.java / ToasterTier.java. Both read the SAME
// generated plan (toaster_plan.js / ToasterPlan.java, written in one pass by
// tmp/gen_toaster_plan.mjs), so the two languages cannot disagree about where a
// block goes - which is exactly how the old hand-maintained pair went wrong.
// tmp/probe/verify_plan_parity.sh diffs them block for block anyway.
//
// She is a toast girl and she lives in a toaster, so the silhouette is the
// point: a solid base, two slots cut clean through the roof, furnace banks
// lining them as the elements, and the lever slot up the front with a torch
// either side of the step.

import { TOASTER_LAYERS } from './toaster_plan.js';

export const SHELL = 'W';
export const AIR = '.';
export const FURNACE = 'F';
export const CHEST = 'C';
export const BENCH = 'K';
export const BED = 'B';
export const TORCH = 'T';
export const WALL_TORCH = 't';
export const DOOR = 'D';
export const OPENING = 'S';

export const toasterWidth = () => TOASTER_LAYERS[0][0].length;
export const toasterDepth = () => TOASTER_LAYERS[0].length;
export const toasterHeight = () => TOASTER_LAYERS.length;

// CONTENT STAGES. Each is a superset of the one before, so growing never moves
// anything she already placed. SHELL is the whole silhouette - a toast girl
// living in a box is not the bit; she lives in a toaster from the first night
// and what arrives later is the furniture, not the shape.
export const STAGES = Object.freeze(['shell', 'lived_in', 'kitchen', 'full']);
const rank = (stage) => Math.max(0, STAGES.indexOf(stage));
export const nextStage = (stage) => STAGES[Math.min(STAGES.length - 1, rank(stage) + 1)];

// THE MATERIAL LADDER, worst to best. Cobblestone is night one. Iron is 9 ingots
// a block across 1126 blocks of shell - it is what the house becomes if she ever
// genuinely arrives, not something to plan around.
// MUST MATCH ToasterTier.materialLadder() in the java.
export const MATERIAL_LADDER = Object.freeze(['cobblestone', 'smooth_stone', 'stone_bricks', 'iron_block']);
export const MATERIAL_SWITCH_STOCK = 64;

// Openings ('D', 'S') are air on every stage and belong to no stage: they are
// CUT, not placed, and a stage that "contained" them would have her trying to
// fill in her own toast slots.
export function inStage(glyph, stage) {
    const r = rank(stage);
    switch (glyph) {
        case SHELL: return true;
        case WALL_TORCH: return true;                 // the two by the door go up with the shell
        case BED: case BENCH: case TORCH: case CHEST: return r >= rank('lived_in');
        case FURNACE: return r >= rank('kitchen');
        default: return false;
    }
}

// How many of a fixture a stage actually wants. lived_in is a HANDFUL on
// purpose - the plan holds 32 chests and 106 torches, and hauling all of that
// before she has a kitchen is the same mistake as demanding the iron up front.
export function budgetFor(glyph, stage) {
    if (stage === 'full') return Infinity;
    const r = rank(stage);
    switch (glyph) {
        case BED: return r >= rank('lived_in') ? 2 : 0;      // one bed is two blocks
        case BENCH: return r >= rank('lived_in') ? 1 : 0;
        case CHEST: return stage === 'lived_in' ? 2 : Infinity;
        case TORCH: return stage === 'lived_in' ? 12 : Infinity;
        case FURNACE: return r >= rank('kitchen') ? Infinity : 0;
        default: return Infinity;
    }
}

// build order by glyph - see cellsFor
const ORDER = [SHELL, WALL_TORCH, BENCH, BED, CHEST, FURNACE, TORCH];

const KIND = {
    [SHELL]: 'shell', [FURNACE]: 'furnace', [CHEST]: 'chest', [BENCH]: 'crafting_table',
    [BED]: 'bed', [TORCH]: 'torch', [WALL_TORCH]: 'wall_torch'
};

function bounds(settlement) {
    const minX = settlement.anchor.x - Math.floor(settlement.width / 2);
    const minZ = settlement.anchor.z - Math.floor(settlement.depth / 2);
    return { minX, minZ, floorY: settlement.anchor.y - 1 };
}

export function toasterPlanApplies(settlement) {
    return settlement
        && settlement.width === toasterWidth()
        && settlement.depth === toasterDepth()
        && settlement.height === toasterHeight();
}

/** What the plan wants at this world position, or null when off the map. */
export function glyphAt(settlement, pos) {
    const { minX, minZ, floorY } = bounds(settlement);
    const layer = pos.y - floorY, dz = pos.z - minZ, dx = pos.x - minX;
    if (layer < 0 || layer >= toasterHeight()) return null;
    if (dz < 0 || dz >= toasterDepth()) return null;
    const row = TOASTER_LAYERS[layer][dz];
    if (dx < 0 || dx >= row.length) return null;
    return row[dx];
}

export const isOpening = (glyph) => glyph === DOOR || glyph === OPENING;

/**
 * EVERY BLOCK THE STAGE OWES, IN THE ORDER SHE SHOULD LAY IT.
 *
 * shell (bottom course up - the floor first, because she stands on it to build
 * everything above), then the two torches by the door, then bench -> bed ->
 * chests (the three that turn a structure into somewhere she can sleep, craft
 * and put things down), then the furnace banks, then the floor torches last
 * because they are the one job still correct after everything else moved.
 *
 * BYTE-FOR-BYTE THE SAME ORDER AS ToasterLayout.cellsFor - the parity probe
 * compares this list index by index.
 */
export function toasterCells(settlement, stage = 'shell') {
    const { minX, minZ, floorY } = bounds(settlement);
    const out = [];
    // what this stage has claimed so far, in plan coordinates. ORDER puts every
    // placeable rank ahead of the floor torches, so by the time a torch is
    // considered this set is complete for everything underneath it.
    const claimed = new Set();
    const key = (layer, dx, dz) => (layer * toasterDepth() + dz) * toasterWidth() + dx;
    // A TORCH NEEDS SOMETHING TO STAND ON, AND THE STAGE DECIDES WHETHER IT
    // EXISTS YET. 104 of the 106 torches stand on the furnace banks; lived_in
    // builds no furnaces, so the 12 lowest torches bottom-up are 12 torches in
    // mid-air over blocks this stage never places - the stage could never be
    // satisfied and the lighting step rotates on impossible cells forever.
    // a PLAN question, not a world question. skipped without spending budget, so
    // the tally never learns to ignore outstanding work: the cell simply is not
    // part of this stage, and returns when the stage that builds its support does.
    const supported = (layer, dx, dz) => {
        if (layer === 0) return true;
        if (TOASTER_LAYERS[layer - 1][dz][dx] === SHELL) return true;
        return claimed.has(key(layer - 1, dx, dz));
    };
    for (const glyph of ORDER) {
        const budget = budgetFor(glyph, stage);
        if (budget <= 0 || !inStage(glyph, stage)) continue;
        let taken = 0;
        for (let layer = 0; layer < toasterHeight() && taken < budget; layer++) {
            for (let dz = 0; dz < toasterDepth() && taken < budget; dz++) {
                const row = TOASTER_LAYERS[layer][dz];
                for (let dx = 0; dx < row.length && taken < budget; dx++) {
                    if (row[dx] !== glyph) continue;
                    if (glyph === TORCH && !supported(layer, dx, dz)) continue;
                    out.push({
                        x: minX + dx, y: floorY + layer, z: minZ + dz,
                        glyph, layer, kind: KIND[glyph]
                    });
                    claimed.add(key(layer, dx, dz));
                    taken++;
                }
            }
        }
    }
    return out;
}

/** Everything the plan wants, ignoring stages - for manifests and probes. */
export function toasterTally() {
    const counts = new Map();
    for (const layer of TOASTER_LAYERS) {
        for (const row of layer) {
            for (const c of row) counts.set(c, (counts.get(c) || 0) + 1);
        }
    }
    return counts;
}

/**
 * What a stage costs her, as items rather than placements.
 *
 * Chests and benches are wood, furnaces are 8 cobble each, a bed is 2 blocks but
 * ONE item, and torches are a stick and a coal. Quoting placements at her would
 * overstate the bed and understate everything smelted.
 */
export function toasterManifest(settlement, stage = 'shell', shellMaterial = 'cobblestone') {
    const cells = toasterCells(settlement, stage);
    const count = (g) => cells.filter((c) => c.glyph === g).length;
    return {
        [shellMaterial]: count(SHELL),
        furnace: count(FURNACE),
        cobblestone_for_furnaces: count(FURNACE) * 8,
        chest: count(CHEST),
        crafting_table: count(BENCH),
        bed: Math.ceil(count(BED) / 2),
        torch: count(TORCH) + count(WALL_TORCH)
    };
}
