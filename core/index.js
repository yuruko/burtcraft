// burtcraft core - the persona-free half of the integration.
//
// this module owns the machine: a websocket server the bridge connects to,
// action dispatch with real completion tracking, live game state, memory of
// places, and an autonomy loop for when nobody is telling her what to do.
//
// it owns NO opinions about what your vtuber says. it never calls an llm, never
// touches a database, and never speaks. it emits events and answers getStatus();
// your brain does the talking. see ../docs/INTEGRATING.md.

export {
    default as minecraftTool,   // ready-made singleton, if you only need one bot
    MinecraftTool,              // the class, if you want to construct it yourself
    setBotNames,                // which names count as "addressed to her" in chat
    // THE LIBRARY SHIPS NO DIALOGUE. the autonomy loop has a handful of places it
    // would like a line; register your own and they get used, register nothing
    // and it stays quiet and simply acts. see docs/INTEGRATING.md.
    setFlavorLines,
    clearFlavorLines,
    AUTONOMY_MODES,             // auto | gather_materials | gather_food | scout_area | secure_area
    PICKAXE_TIERS,
    FOOD_RE
} from './minecraft_tool.js';

export {
    MinecraftMemory, OVEN_KINDS,
    // the ledgers the autonomy loop reads back: what it eats, what it mines,
    // what it has stood in the yard, and the order it upgrades a settlement in.
    COMFORT_KINDS, FOOD_SPOT_KINDS, ORE_SPOT_KINDS, SETTLEMENT_UPGRADE_ORDER
} from './minecraft_memory.js';
export { MinecraftAffect, appraiseMinecraftState } from './minecraft_affect.js';
export { RecentEvents } from './recent_events.js';
// what it has noticed and not yet said anything about. perceptions become
// ranked, decaying CANDIDATES instead of racing for one speech slot, so the
// loser of a moment comes back rather than being dropped forever.
export { NoticeBoard } from './notice_board.js';
// who owns the bot and which server is its home. ALL config, no defaults - unset
// means "not configured" and every branch goes quiet.
export { isOwner, ownerName, resolvePlayerName, homeServerFor } from './identity.js';
export {
    Settlement, Homestead, Outpost, ToasterHomestead, ToasterOutpost,
    toasterHomesteadDimensions, toasterOutpostDimensions,
    settlementFromJSON, mainIsBiggest, fitOutpostBelowHomestead, toasterBlueprint,
    // ⚠ PLAN VERSIONS. v1 is the flat 14x9x8 ascii map every already-saved
    // homestead stays on forever; v2 is the layered 13x21x11 toaster a NEW one is
    // built to. a settlement carries its version, and resolving a saved record at
    // the wrong one addresses blocks outside the house.
    TOASTER_PLAN_V1, TOASTER_PLAN_V2, TOASTER_PLAN_LATEST,
    toasterPlanVersion, toasterIsLayered
} from './settlements.js';
