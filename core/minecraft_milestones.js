// core/minecraft_milestones.js
//
// WHAT A SURVIVAL PLAYER IS ACTUALLY TRYING TO DO.
//
// burtcraft had no progression model at all. The only signal anywhere in the stack
// was a regex on the chat line "X has made the advancement [Y]", which wrote a
// `landmarks` entry that nothing but a three-line prose dump ever read. So she
// could not answer "have i beaten a trial chamber", could not tell a first kill
// from a hundredth, and - the part that actually shows on stream - had no way to
// WANT anything. A survival player without a next objective is a lawnmower.
//
// This file is the catalogue: a static list of the things people chase on a
// survival server, in roughly the order they fall. It is CODE, not data, because
// it is a description of Minecraft rather than a record of her - her side is the
// `conquests` ledger in minecraft_memory.js, keyed by the ids below.
//
// ⚠ THE IDS ARE VANILLA ADVANCEMENT IDS WHERE ONE EXISTS. That is deliberate and
// load-bearing: the java companion can read the real advancement tree
// (`ClientAdvancements`), which is SERVER-AUTHORITATIVE and already knows about
// everything she did before this system existed. Inventing our own id namespace
// would have thrown that away and made every milestone depend on us having watched
// it happen. Where vanilla has no advancement for something people obviously chase
// (a trial chamber cleared, a dungeon spawner broken) the id is prefixed `burtcraft:`
// so the two namespaces can never be confused.
//
// ⚠ `requires` is a PREREQUISITE, not a recipe. It exists so "what should i do
// next" never suggests the dragon to somebody in leather armour. It is not a tech
// tree and nothing here plans a route.

export const MILESTONE_TIERS = ['early', 'iron', 'nether', 'end', 'late'];

export const MILESTONES = [
    // ---- getting started ---------------------------------------------------
    { id: 'minecraft:story/mine_stone', tier: 'early', label: 'first stone tools' },
    { id: 'minecraft:story/upgrade_tools', tier: 'early', label: 'a better pickaxe' },
    { id: 'minecraft:story/smelt_iron', tier: 'early', label: 'first iron' },
    { id: 'minecraft:story/obtain_armor', tier: 'iron', label: 'wearing armour' },
    { id: 'minecraft:story/lava_bucket', tier: 'iron', label: 'a bucket of lava' },
    { id: 'minecraft:story/iron_tools', tier: 'iron', label: 'iron pickaxe' },
    { id: 'minecraft:story/deflect_arrow', tier: 'iron', label: 'blocked an arrow' },
    { id: 'minecraft:story/form_obsidian', tier: 'iron', label: 'made obsidian' },
    { id: 'minecraft:story/mine_diamond', tier: 'iron', label: 'diamonds', notable: true },
    { id: 'minecraft:story/enchant_item', tier: 'iron', label: 'enchanted something' },
    { id: 'minecraft:story/shiny_gear', tier: 'iron', label: 'diamond armour', notable: true },

    // ---- underground, and the things that live there ------------------------
    // no vanilla advancement covers "cleared a dungeon", and it is one of the most
    // universally recognised things in the game, so it gets a burnt: id fed by
    // block detection rather than the tree.
    { id: 'burtcraft:dungeon_found', tier: 'early', label: 'found a mob spawner dungeon', requires: null },
    { id: 'burtcraft:dungeon_cleared', tier: 'iron', label: 'cleared a dungeon', requires: 'burtcraft:dungeon_found' },
    { id: 'burtcraft:mineshaft_found', tier: 'early', label: 'found an abandoned mineshaft' },
    { id: 'burtcraft:deep_dark_found', tier: 'nether', label: 'stood in the deep dark', notable: true },
    { id: 'minecraft:adventure/kill_mob_near_sculk_catalyst', tier: 'nether', label: 'fed a sculk catalyst' },

    // ---- trial chambers (1.21) ---------------------------------------------
    // the newest real dungeon content and the thing most worth her knowing about.
    { id: 'burtcraft:trial_chamber_found', tier: 'iron', label: 'found a trial chamber', notable: true },
    { id: 'minecraft:adventure/under_lock_and_key', tier: 'iron', label: 'opened a vault', notable: true, requires: 'burtcraft:trial_chamber_found' },
    { id: 'minecraft:adventure/revaulting', tier: 'nether', label: 'opened an ominous vault', notable: true, requires: 'minecraft:adventure/under_lock_and_key' },
    { id: 'minecraft:adventure/blowback', tier: 'nether', label: 'killed a breeze with its own charge', notable: true },
    { id: 'minecraft:adventure/who_needs_rockets', tier: 'nether', label: 'launched off a wind charge' },
    { id: 'minecraft:adventure/crafters_crafting_crafters', tier: 'iron', label: 'a crafter making crafters' },
    { id: 'burtcraft:trial_chamber_cleared', tier: 'nether', label: 'cleared a trial chamber', notable: true, requires: 'burtcraft:trial_chamber_found' },

    // ---- structures worth walking to ---------------------------------------
    { id: 'burtcraft:village_found', tier: 'early', label: 'found a village' },
    { id: 'minecraft:adventure/trade', tier: 'early', label: 'traded with a villager' },
    { id: 'burtcraft:desert_temple_looted', tier: 'iron', label: 'looted a desert temple' },
    { id: 'burtcraft:ruined_portal_found', tier: 'early', label: 'found a ruined portal' },
    { id: 'minecraft:adventure/salvage_sherd', tier: 'iron', label: 'brushed out a pottery sherd' },
    { id: 'burtcraft:ocean_monument_found', tier: 'nether', label: 'found an ocean monument', notable: true },
    { id: 'minecraft:adventure/kill_a_mob', tier: 'early', label: 'first kill' },
    { id: 'burtcraft:mansion_found', tier: 'nether', label: 'found a woodland mansion', notable: true },
    { id: 'minecraft:adventure/totem_of_undying', tier: 'late', label: 'a totem of undying', notable: true },
    { id: 'minecraft:adventure/hero_of_the_village', tier: 'nether', label: 'won a raid', notable: true },
    { id: 'minecraft:adventure/voluntary_exile', tier: 'iron', label: 'killed a raid captain' },

    // ---- the nether ---------------------------------------------------------
    { id: 'minecraft:nether/root', tier: 'nether', label: 'went to the nether', notable: true, requires: 'minecraft:story/form_obsidian' },
    { id: 'minecraft:nether/find_bastion', tier: 'nether', label: 'found a bastion', notable: true },
    { id: 'minecraft:nether/find_fortress', tier: 'nether', label: 'found a fortress', notable: true },
    { id: 'minecraft:nether/obtain_blaze_rod', tier: 'nether', label: 'blaze rods', requires: 'minecraft:nether/find_fortress' },
    { id: 'minecraft:nether/obtain_ancient_debris', tier: 'nether', label: 'ancient debris' },
    { id: 'minecraft:nether/netherite_armor', tier: 'late', label: 'netherite armour', notable: true },
    { id: 'minecraft:nether/get_wither_skull', tier: 'late', label: 'a wither skull' },
    { id: 'minecraft:nether/summon_wither', tier: 'late', label: 'summoned the wither', notable: true },
    { id: 'minecraft:nether/create_beacon', tier: 'late', label: 'built a beacon', notable: true },
    { id: 'minecraft:nether/distract_piglin', tier: 'nether', label: 'bartered with a piglin' },
    { id: 'minecraft:nether/ride_strider', tier: 'nether', label: 'rode a strider' },

    // ---- the end ------------------------------------------------------------
    { id: 'burtcraft:stronghold_found', tier: 'end', label: 'found a stronghold', notable: true },
    { id: 'minecraft:story/follow_ender_eye', tier: 'end', label: 'followed an ender eye' },
    { id: 'minecraft:story/enter_the_end', tier: 'end', label: 'went to the end', notable: true, requires: 'burtcraft:stronghold_found' },
    { id: 'minecraft:end/kill_dragon', tier: 'end', label: 'killed the ender dragon', notable: true, requires: 'minecraft:story/enter_the_end' },
    { id: 'minecraft:end/find_end_city', tier: 'end', label: 'found an end city', requires: 'minecraft:end/kill_dragon' },
    { id: 'minecraft:end/elytra', tier: 'late', label: 'got elytra', notable: true, requires: 'minecraft:end/find_end_city' },
    { id: 'minecraft:end/dragon_egg', tier: 'late', label: 'the dragon egg', notable: true },

    // ---- things she does because she is her ---------------------------------
    { id: 'minecraft:husbandry/breed_an_animal', tier: 'early', label: 'bred animals' },
    { id: 'minecraft:husbandry/plant_seed', tier: 'early', label: 'planted a crop' },
    { id: 'minecraft:husbandry/tame_an_animal', tier: 'early', label: 'tamed something' },
    { id: 'minecraft:husbandry/make_a_sign_glow', tier: 'iron', label: 'a glowing sign' },
    { id: 'minecraft:husbandry/allay_deliver_cake_to_note_block', tier: 'late', label: 'an allay delivered cake' }
];

const BY_ID = new Map(MILESTONES.map((m) => [m.id, m]));

export function getMilestone(id) { return BY_ID.get(id) || null; }

/** vanilla ids are long; this is what she'd actually call the thing. */
export function milestoneLabel(id) {
    const m = BY_ID.get(id);
    if (m) return m.label;
    // an advancement the catalogue does not list is still real and still hers -
    // vanilla ships far more than the ~60 chased here. Render it rather than drop
    // it: "i got a thing" is worse than a slightly clumsy name.
    return String(id || '').split('/').pop().replace(/^minecraft:/, '').replace(/_/g, ' ') || 'something';
}

/**
 * WHAT SHOULD SHE GO AND DO NEXT?
 *
 * Returns milestones she has not got, whose prerequisite she HAS got, nearest tier
 * first. `notable` entries sort ahead of chores within a tier so the suggestion is
 * something worth watching rather than "plant a seed".
 *
 * ⚠ This ranks, it does not plan. Nothing here knows how to reach a trial chamber;
 * it only knows that a girl in iron armour who has never seen one probably wants to.
 */
export function nextMilestones(hasConquered, { tier = null, max = 4 } = {}) {
    const reached = (m) => !m.requires || hasConquered(m.requires);
    const open = MILESTONES.filter((m) => !hasConquered(m.id) && reached(m));
    const floor = tier ? MILESTONE_TIERS.indexOf(tier) : -1;
    // ⚠ RANK BY DISTANCE FROM WHERE SHE IS, NOT BY ABSOLUTE TIER.
    //
    // The first version sorted ascending by tier, which sounds right and is badly
    // wrong the moment `max` bites: an iron-tier burnt has every early-game chore
    // still open (she never "planted a seed" as an advancement), so the whole
    // shortlist filled with seeds and first-kills and the trial chamber she had just
    // FOUND could not place. The suggestion list would have been permanently stuck
    // in the tutorial. Caught by the test, not by reading it.
    //
    // At her tier ranks first, one above is the aspirational next step, and anything
    // below is catch-up work that sorts last - present, but never crowding out the
    // thing she is actually ready for.
    const rank = (ti) => {
        if (floor < 0) return ti;
        const d = ti - floor;
        if (d === 0) return 0;
        if (d === 1) return 1;
        return 2 + (floor - ti);
    };
    return open
        .map((m) => ({ m, ti: MILESTONE_TIERS.indexOf(m.tier) }))
        // more than one tier above where she is is not a suggestion, it is a way to
        // get her killed.
        .filter(({ ti }) => floor < 0 || ti <= floor + 1)
        .sort((a, b) => (rank(a.ti) - rank(b.ti))
            || ((b.m.notable ? 1 : 0) - (a.m.notable ? 1 : 0))
            || (a.ti - b.ti))
        .slice(0, max)
        .map(({ m }) => m);
}

/** rough "where is she up to", derived from what she has actually done. */
export function progressTier(hasConquered) {
    if (hasConquered('minecraft:end/kill_dragon')) return 'late';
    if (hasConquered('minecraft:story/enter_the_end') || hasConquered('burtcraft:stronghold_found')) return 'end';
    if (hasConquered('minecraft:nether/root')) return 'nether';
    if (hasConquered('minecraft:story/smelt_iron') || hasConquered('minecraft:story/iron_tools')) return 'iron';
    return 'early';
}
