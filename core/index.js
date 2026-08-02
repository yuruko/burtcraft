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
    PICKAXE_TIERS,
    FOOD_RE
} from './minecraft_tool.js';

export { MinecraftMemory, OVEN_KINDS } from './minecraft_memory.js';
export { MinecraftAffect, appraiseMinecraftState } from './minecraft_affect.js';
export { RecentEvents } from './recent_events.js';
