// core/minecraft_tool.js
// the controller half of burtcraft: the machine that owns the minecraft body.
//
// this module runs a websocket SERVER. the bridge (bridge/minecraft_bot_bridge.js,
// which relays into the game) is the CLIENT that connects to it. your vtuber is
// the always-on endpoint, so it is the stable one; the bridge reconnects to it
// whenever minecraft (re)launches.
//
//   your vtuber's brain (an llm - yours)
//      -> MinecraftTool  (ws server, THIS file, port 7431)
//         <-> minecraft_bot_bridge.js  (ws client, relays commands)
//             <-> altoclef external control server (in-game)
//                 <-> baritone -> minecraft world
//
// responsibilities kept here (decoupled from altoclef command syntax, which the
// bridge owns):
//   - action dispatch with ack + final-response + timeout
//   - live game-state sync from bridge events/state/heartbeat
//   - autonomous behavior (idle / mood-weighted / reactive safety)
//   - natural-language chat-command interpretation for viewer-driven play
//   - session stats + an internal commentary queue
//
// what is deliberately NOT here: any llm call, database, http request, or spoken
// output. this file emits events and answers getStatus(); your character does
// the talking. commentary entries are CUES for your brain to rewrite, never
// lines to speak verbatim. see docs/INTEGRATING.md.
//
// import is side-effect free apart from the module-level singleton export at the
// bottom (which constructs a MinecraftMemory rooted at ./data relative to cwd).
// import { MinecraftTool } instead of the default if you want to control that.
// the server + timers only start on initialize().

import { WebSocketServer } from 'ws';
import EventEmitter from 'events';
import { RecentEvents } from './recent_events.js';
import { MinecraftMemory, OVEN_KINDS } from './minecraft_memory.js';
import {
    ToasterHomestead, ToasterOutpost, toasterHomesteadDimensions,
    toasterOutpostDimensions, fitOutpostBelowHomestead, mainIsBiggest, toasterBlueprint,
    toasterFixtureTarget, toasterOpenFloor, toasterBedPositions, TOASTER_STACK_HEIGHT,
    TOASTER_YARD_MARGIN, toasterYardSeparation
} from './settlements.js';
import { MinecraftAffect } from './minecraft_affect.js';

const DEFAULT_PORT = parseInt(process.env.MINECRAFT_BRIDGE_PORT || '7431', 10);

// how long to wait for the bridge's final response before giving up on an action.
// altoclef tasks can be long-running (mine diamonds), so the bridge is expected
// to send an 'executing' ack promptly and a 'success'/'error' when the task
// actually finishes; the ack resets this timer.
const DEFAULT_ACTION_TIMEOUT = 90000;

// autonomous idle cadence - how often to consider doing something unprompted.
const DEFAULT_AUTONOMOUS_TICK_MS = 25000;

// min gap between reactions of the same kind, so chat can't farm spam and a
// stream of damage events doesn't flood commentary.
const REACTION_COOLDOWN_MS = 8000;
// nagging states (still hungry, still dark, still being hit) re-fire as long as
// the condition holds, so 8s makes her repeat herself about the same fact. these
// get their own, much longer gap.
const REACTION_COOLDOWN_OVERRIDES = {
    low_hunger: 90 * 1000,
    nightfall: 120 * 1000,
    damage_taken: 25 * 1000,
    hostiles_nearby: 45 * 1000,
    weather_changed: 90 * 1000
};
// once she has decided to get out of the rain, let her get there. re-deciding it
// every idle tick is how a pull turns into the loop with better narration.
const RAIN_SHELTER_COOLDOWN_MS = 5 * 60 * 1000;
// far enough to be worth walking home for, near enough that she isn't crossing
// the map because a cloud showed up.
const RAIN_SHELTER_MAX_DIST = 700;
const VIEWER_SUGGESTION_COOLDOWN_MS = 10000;
// who is allowed to INTERRUPT work already in flight. 'agent' is her own brain calling
// the minecraft tool - the case that was impossible before, so she could not change her
// own mind once a goal was running. the idle menu ('autonomous') is deliberately absent:
// idle picks interrupting each other is exactly the thrash the busy guard prevents.
const PREEMPTING_SOURCES = new Set(['agent', 'operator', 'request', 'mode-switch', 'gamer']);
// work a NON-operator interrupt may replace: her own idle choices and automation.
// keeps one viewer from cancelling an operator's instruction.
const REPLACEABLE_SOURCES = new Set([
    'autonomous', 'request', 'dwell-rotation', 'recovery', 'loop-recovery',
    'orphan-recovery', 'homestead', 'water-escape', 'pinned', 'protection', 'unreachable'
]);
const MAX_VIEWER_SUGGESTIONS = 12;
const MAX_TELEMETRY_AGE_MS = 15000;
// The relay heartbeats every 30s. If it goes silent for more than two beats,
// treat the socket as half-open and force a reconnect. A world that still
// claims to be ready but has produced no client-thread telemetry for 45s is
// similarly unsafe to control; dropping the relay link makes its fail-safe stop
// the in-game task before it reconnects.
const BRIDGE_SILENCE_MS = 75000;
const TELEMETRY_FAULT_MS = 45000;
// No finite job gets to look alive while producing absolutely no movement or
// inventory change for 45 seconds. Crafting is especially tight: when a recipe
// chain is parked on an absent ingredient, AltoClef otherwise sits in an infinite
// wander/rescan loop while the HUD confidently says "crafting".
const AUTONOMOUS_STALL_MS = 45000;
// how many distinct inventory states count as "recently visited" when deciding
// whether a change is real progress or a task tree swinging between two states.
// the observed craft-oscillation cycles through ~6-8 states at ~1.4Hz while state
// packets arrive every ~2s, so this holds several full cycles.
const INVENTORY_HISTORY_MAX = 24;
const INVENTORY_OSCILLATION_WARN_AT = 3;
const ACTION_STALL_MS = Object.freeze({
    craft: 20000,
    // A speedrun may legitimately spend longer than a normal goal calculating
    // or fighting in one area, but it may not be a statue indefinitely. The
    // macro has no wall-clock ceiling, so this is its only external liveness
    // bound when an internal task silently wedges.
    speedrun: 90000,
    // building is LEGITIMATELY stationary - she stands on one wall placing smooth
    // stone for minutes at a time, which is the exact shape the 45s default reads
    // as a stall. that blacklisted build_settlement for two minutes and handed the
    // tick to the wander menu, so the toaster lost ground every time she worked on
    // it. for THIS action the survey is the ONLY progress signal that counts (see
    // _observeGoalProgress) - position and inventory are ignored, because a wedged
    // build that still gets jostled by mobs or nudges one block kept refreshing the
    // clock forever and the 6 minutes never once elapsed.
    build_settlement: 6 * 60 * 1000,
    install_appliance: 90000
});
// Build phases where the task has handed off to a resource subtask and is
// legitimately away from the site: there movement and inventory ARE the
// progress signal. Every other phase claims she is laying blocks, and only the
// survey can vouch for that.
const BUILD_SUBTASK_PHASES = new Set(['gathering_stone', 'crafting_side_torches', 'walking_to_quarry']);
// The in-game builder parks on this exact string once baritone has refused the
// site outright (ToasterBuildTask.BLOCKED_PHASE). It is a definite answer, not a
// guess, so it does not have to serve out the full build budget.
const BUILD_BLOCKED_PHASE = 'blocked_baritone_cannot_build';
const BUILD_BLOCKED_GRACE_MS = 45000;
// loop detection: she can "make progress" (position keeps changing) while going nowhere -
// orbiting one patch, or grinding a goal that never resolves. catch both.
const LOOP_CONFINE_RADIUS = 24;            // blocks (horizontal): orbiting within this = "same spot"
const LOOP_CONFINE_MS = 5 * 60 * 1000;     // confined to that patch this long (while moving) -> loop
const DEFAULT_FINITE_GOAL_MAX_MS = 15 * 60 * 1000;
const GOAL_MAX_RUNTIME_MS = {
    // A full speedrun is intentionally long-lived. Movement/confinement and
    // no-progress checks still apply, but there is no arbitrary wall-clock stop.
    speedrun: null,
    // A large smooth-stone toaster is a multi-session construction project.
    // Progress is supervised from settlementBuild telemetry, not an arbitrary
    // fifteen-minute wall clock.
    build_settlement: null
};
const LOOP_AVOID_MS = 2 * 60 * 1000;       // after a break, don't re-pick the same action for this long
// "pinned": the freeze where altoclef's MobDefenseChain (priority 70-80) preempts burnt's
// task chain (priority 50) faster than baritone can finish a path, so she twitches in one
// spot under attack and never actually goes anywhere. NEITHER existing watchdog can see it:
// the oscillation moves her >= 1 block constantly, so _observeGoalProgress keeps refreshing
// lastProgressAt (AUTONOMOUS_STALL_MS never fires), and LOOP_CONFINE_MS is 5 minutes, which
// is an eternity to stand still on stream. deliberately tighter and faster than the loop
// detector, and gated on actually being hurt so a stationary miner is never touched.
const PINNED_RADIUS = 8;                   // blocks (horizontal), vs LOOP_CONFINE_RADIUS 24
const PINNED_MS = 45 * 1000;               // held inside that radius this long...
const PINNED_DAMAGE_WINDOW_MS = 30 * 1000; // ...while still taking hits...
const PINNED_COOLDOWN_MS = 3 * 60 * 1000;  // ...and at most this often
const LOOP_FAILURE_LIMIT = 3;
const LOOP_FAILURE_WINDOW_MS = 15 * 60 * 1000;
// after a real task finishes/fails the outcome is queued to burnt's brain, which
// usually picks the next goal. hold the fixed idle menu back this long so her own
// reasoned choice leads instead of a dice roll stealing the task slot first.
// How long the fixed idle menu waits after a task ends so her own reasoned
// choice can lead instead.
//
// It was 20 seconds, and it was only CHECKED on the 25-second autonomous tick,
// so the real wait was 20-50 depending on where the task happened to land -
// observed at 44 seconds of a motionless bot on stream, twice. Two things fix
// that: `_noteTaskOutcome` now wakes the loop exactly when the grace expires,
// and the grace itself is short. It can afford to be: her brain outranks the
// menu (`agent` is an unconditional preempting source), so a goal that arrives
// late still wins - it replaces the menu's pick instead of waiting for silence.
// Deciding out loud and changing her mind is in character. Standing still is not.
const LLM_GOAL_GRACE_MS = 6000;
const SAFETY_ACTIONS = new Set(['stop', 'eat', 'defend', 'cover_lava']);
// `@food <n>` targets how much food she ENDS UP HOLDING, so these are stock
// levels, not bites. small on purpose - see _foodTarget.
const EAT_TOPUP_TARGET = 3;
const EAT_GATHER_TARGET = 3;
// eating is not instant and hunger may legitimately stay low for a moment. don't
// re-issue on the very next 25s tick - that spent every cycle on food and looked
// like she was frozen.
const EAT_RETRY_GAP_MS = 60 * 1000;
// 'look' is instant (just a rotation), so it must not be tracked as a goal or
// the stall/loop watchdogs would supervise a thing that finishes immediately
// 'hud' is text on a screen, not a goal: being in here keeps it off the goal tracker
// AND exempt from the f1 guard below, which is deliberate - when the operator takes the
// keyboard the hud should still be able to say so rather than freeze on a stale line.
// 'set_home' is a memory write, not a goal - and it stays allowed under f1 so the operator can
// walk her somewhere good and say "this is home" while holding the keyboard.
const NON_TASK_ACTIONS = new Set(['chat', 'stop', 'status', 'inventory', 'coords', 'enable', 'disable', 'autonomous', 'look', 'boat', 'hud', 'set_home', 'set_outpost', 'outposts']);

// the in-game intent line: "<what she's doing>" / "<why>" / "<live altoclef phase>".
// verbs are present-continuous so the hud reads as a sentence about a person rather
// than a command echo ("crafting a stone pickaxe", not "craft stone_pickaxe").
const INTENT_VERBS = {
    craft: 'crafting', get: 'getting', mine: 'mining', collect: 'collecting',
    move: 'heading to', follow: 'following', explore: 'exploring', idle: 'killing time',
    defend: 'fighting back', attack: 'going after', eat: 'eating', hunt: 'hunting',
    equip: 'gearing up', deposit: 'stashing loot', stash: 'stashing loot',
    place: 'placing', install_appliance: 'installing', build_settlement: 'building',
    speedrun: 'speedrunning', locate: 'searching for',
    give: 'handing over', cover_lava: 'capping lava', boat: 'sorting out a boat'
};
// fallback WHY when a goal carries no `say` of its own - keyed on who wanted it.
// '' means "no explanation needed", not "unknown".
const INTENT_SOURCE_WHY = {
    agent: 'my idea', request: 'someone asked me to', gamer: 'gamer mode',
    safety: 'staying alive', pinned: 'i was getting pinned down',
    protection: 'that land was claimed', 'water-escape': 'getting out of the water',
    'loop-recovery': 'i was going in circles', 'dwell-rotation': 'did that long enough',
    'orphan-recovery': 'that task lost its owner', 'mode-switch': 'just clocked in',
    recovery: 'recovering from a stall', autonomous: ''
};
const INTENT_PUSH_MIN_GAP_MS = 900;   // state lands ~2s apart; this only guards bursts
const INTENT_HEARTBEAT_MS = 30000;    // refresh before the companion's 90s ttl expires
// multiplayer chat manners: what reaches her brain and how fast she may type.
// addressed lines (her name / the owner) always surface (per-sender gap only);
// ambient server chatter is sampled so she joins in occasionally like a person
// instead of replying to every line on a public server.
// the names YOUR vtuber answers to. a server line containing one of these counts
// as addressed to her and always surfaces to your brain (ambient chatter is
// sampled instead). set BOT_NAMES="ada,ada bot" in the env, pass
// `new MinecraftTool({ names: [...] })`, or call setBotNames([...]) at runtime.
// include the misspellings your chat actually types - the same list decides
// whether a named line counts as an instruction (see _looksAddressed below).
function buildAddressedRe(names) {
    const alt = (Array.isArray(names) ? names : [])
        .map((n) => String(n).trim())
        .filter(Boolean)
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    // no names configured -> a regex that never matches, so every line is
    // treated as ambient rather than everything being treated as addressed.
    return alt ? new RegExp(`\\b(${alt})\\b`, 'i') : /(?!)/;
}
// `let`, not `const`: setBotNames() rebinds it and the call sites below read the
// live binding, so renaming works without touching them.
let CHAT_ADDRESSED_RE = buildAddressedRe((process.env.BOT_NAMES || '').split(','));
export function setBotNames(names) {
    CHAT_ADDRESSED_RE = buildAddressedRe(names);
    return CHAT_ADDRESSED_RE;
}
// greetings/hails aimed at a named person. these are the ones she must never
// answer on someone else's behalf ("hi marble" -> "i'm not marble but sure").
const CHAT_GREETING_RE = /\b(hi|hey|hello|yo|sup|hiya|heya|morning|welcome|wb|gm|gn|bye|cya|ty|thanks|thank you)\b/i;
const CHAT_SENDER_GAP_MS = 8000;
const CHAT_AMBIENT_GAP_MS = 75000;
const CHAT_AMBIENT_SAMPLE = 0.5;
// a conversation is a STATE, not a keyword. once she has actually answered
// somebody in game chat they are in an exchange with her, and no human re-types
// her name every line - the follow-up is just "do you still have iron armor on?".
// without a window that follow-up fell through to the ambient path (50% dice
// behind a 75s gap her OWN reply had just reset), so she answered the one line
// carrying "melba" and went silent on every one after it. these keep an answered
// person addressed while the back-and-forth is genuinely alive.
const CHAT_EXCHANGE_MS = 150000;      // how long an answered person stays "talking to her"
const CHAT_EXCHANGE_MAX_MS = 600000;  // ceiling: a window can be extended, never forever
const CHAT_EXCHANGE_GAP_MS = 2000;    // in-exchange per-sender gap (two quick lines both land)
const CHAT_ADDRESSER_RECENT_MS = 120000; // how recently they must have addressed her to be answered
const CHAT_OUT_MIN_GAP_MS = 3000;
const CHAT_OUT_PER_MIN = 8;
// a destination-less move refused twice inside this window is a loop, not a typo.
// wide enough to span the turn boundary: the observed repeats were 1.4s apart
// inside one turn and 48s apart across two.
const NOWHERE_MOVE_REPEAT_MS = 90000;
// one server line can reach us more than once (see _recentChatText). duplicates
// arrive within milliseconds of each other, so the window only has to be wide
// enough to cover delivery jitter.
const CHAT_DUP_WINDOW_MS = 2500;
const CHAT_DUP_CACHE = 64;
// how live the room is. a person doing something interesting in a dead channel
// says so; the same person talks over a running conversation and is a nuisance.
// so the ROOM decides how chatty she gets about her own play, not a timer.
const ROOM_CHAT_WINDOW_MS = 2 * 60 * 1000;
const ROOM_BUSY_LINES = 3;             // others' lines inside the window = a conversation
const ROOM_BUSY_RECENT_MS = 30 * 1000; // somebody spoke this recently = still mid-exchange
const ROOM_DEAD_MS = 10 * 60 * 1000;   // nobody has said anything for this long
// how often she may volunteer what she's up to into a quiet room, and how often
// she actually takes the opening. deliberately sparse - the failure mode here is
// a bot narrating its own inventory at strangers.
const ROOM_NARRATE_GAP_MS = 6 * 60 * 1000;
const ROOM_NARRATE_SAMPLE = 0.5;
// SOMEBODY WALKED UP. how often she may react to an arrival at all, how long before
// the SAME person is a fresh event again (walking in and out of render distance must
// not re-trigger), and how often an arrival gets a reaction rather than being
// ignored. she is not a greeter bot; most people who wander past get nothing.
const ARRIVAL_GAP_MS = 60 * 1000;
const ARRIVAL_PER_PLAYER_GAP_MS = 12 * 60 * 1000;
const ARRIVAL_SAMPLE = 0.6;
// of the arrivals she DOES react to, how often the reaction is bread rather than
// just talking. bread is the point, but a bot that force-feeds every passer-by is a
// nuisance, so a real share of them are only a hello.
const ARRIVAL_BREAD_SHARE = 0.65;
const PERSISTENT_ACTIONS = new Set(['follow', 'idle', 'explore']);
// Keep this explicit for a genuinely self-supervising macro, but default to no
// exemptions. A claimed internal recovery path is not enough: if the macro is
// producing no movement or inventory progress, Burnt still needs a finite way
// out. Speedrun therefore uses a generous action-specific stall budget above.
const WATCHDOG_EXEMPT_ACTIONS = new Set();
// autonomous-sourced persistent behaviors never emit a finish, so the tick loop
// rotates them out after a bounded dwell instead of parking on them forever.
// idle gets a longer stay: it's the nightfall shelter behavior and a full
// minecraft night is ~10 real minutes.
const PERSISTENT_DWELL_MS = 5 * 60 * 1000;
// standing still is dead air on stream, so idle gets a much shorter leash than
// it used to (was 10min - long enough to read as "she's broken").
const PERSISTENT_IDLE_DWELL_MS = 3 * 60 * 1000;
// a persistent goal SHE or a viewer asked for gets a longer leash than one the
// idle menu picked, but never an unlimited one.
const PERSISTENT_REQUESTED_DWELL_MULT = 3;
// taking hits ends a parked goal this fast, whoever asked for it
const PERSISTENT_DANGER_BREAK_MS = 15 * 1000;
// a task with no burnt-side goal behind it is unsupervised - cut it loose after
// this long rather than letting it block every future pick
const ORPHAN_TASK_LIMIT_MS = 90 * 1000;
// kit vocabulary, shared with modes.js deriveKit() so the autonomous loop and
// the prompt block agree on what "no pickaxe / no food" means.
export const PICKAXE_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
// best -> worst, so a lower index is a better piece (see _armorToWear)
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle'];
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
// words people and llms use for "armour" that are not minecraft item ids. an equip
// carrying one of these means "wear what you have", not "wear a thing called gear".
const GENERIC_ARMOR_WORDS = new Set([
    'armor', 'armour', 'armor_set', 'armour_set', 'gear', 'equipment', 'my_armor',
    'my_armour', 'your_armor', 'your_armour', 'all', 'everything', 'kit'
]);
// shapes that read as "please do something" - imperatives, favours, invitations.
// used only to decide whether an ask reaches her; she still chooses freely.
// how long a person's request stays actionable. long enough that she finishes
// the current 25s tick and still honours it, short enough that she isn't acting
// on something someone said ten minutes ago.
const REQUEST_ACT_WINDOW_MS = 90 * 1000;
// what counts as somebody asking her for something. deliberately LOOSE: a false
// positive is one ignorable prompt line, a false negative is a real person being
// ignored to their face.
// the polite forms ("can you", "would you") were the whole list, which missed the way
// people ACTUALLY direct someone standing next to them - bare imperatives. real lines
// that were silently dropped: "burnt go to town , i got one for you", "burnt stand
// still", "stand still burnt". none of them registered as a request at all, so nothing
// downstream ever had a chance to act on them.
const REQUEST_SHAPE_RE = new RegExp([
    // polite / offered
    '\\b(can|could|would|will|wanna|want to|plz|pls|please|lets|let\'?s)\\b',
    // bare imperatives - how directions are actually given
    '\\b(help|come|bring|make|build|get|find|follow|show|give|go|head|meet|wait|hold|stand|stay|stop|mine|dig|craft|place|put|drop|take|open|break|attack|kill|defend|guard|protect|look|turn|jump|run|walk|climb|jump|trade|sell|buy)\\b',
    // deictic directions ("over here", "this way", "up there")
    '\\b(over|this|that|up|down|back)\\s+(here|there|way)\\b',
    // a question
    '\\?\\s*$'
].join('|'), 'i');
// on a server her NAME is the strongest signal a line is aimed at her, and a named
// line that is not just a greeting is nearly always an instruction. same configured
// name list as the chat-manners test above (see buildAddressedRe / setBotNames).
const GREETING_ONLY_RE = /^\W*(hi|hey|hello|yo|sup|wb|welcome back|gm|gn|o7|hru|lol|lmao)\b[\s\S]{0,12}$/i;
// "go to -777, 7777" - somebody handing her a destination.
// TWO numbers is the form people actually type, and it means x and z: nobody
// quotes a y when they mean "walk over there", which is why baritone's own
// command takes `goto x z` as well as `goto x y z`. the old rule demanded three
// numbers, so every real two-number ask parsed to nothing at all.
// decimals are what the f3 screen hands you, so they parse too (rounded here).
const COORD_NUM = String.raw`[-+]?\d+(?:\.\d+)?`;
const TRAVEL_COORD_RE = new RegExp(
    String.raw`\b(?:go(?:to)?|move|walk|head|run|travel|come)\s+(?:(?:over\s+)?to\s+|over\s+)?` +
    // the middle label is y in a three-number ask and z in a two-number one
    String.raw`(?:x\s*[:=]?\s*)?(${COORD_NUM})\s*[, ]\s*(?:[yz]\s*[:=]?\s*)?(${COORD_NUM})` +
    String.raw`(?:\s*[, ]\s*(?:z\s*[:=]?\s*)?(${COORD_NUM}))?`,
    'i'
);
// the edge of the world, same bound the bridge enforces before a goto is built
const WORLD_EDGE = 29999984;
export const FOOD_RE = /(bread|apple|carrot|potato|beef|porkchop|mutton|chicken|cod|salmon|rabbit|stew|melon|berries|cooked_|golden_apple|pumpkin_pie|honey_bottle|dried_kelp)/;
// how long to leave survival prep alone after an attempt, so a missing-inventory
// telemetry gap can't turn "craft a pickaxe" into the only thing she ever does.
const SURVIVAL_PREP_COOLDOWN_MS = 4 * 60 * 1000;
// homestead drive: her default way of living - settle deep in the wilderness,
// provision a home (ovens! bed, chest, torches), keep bread flowing. it's a
// PREFERENCE (sampled), never a lock: viewer/llm/operator goals always preempt,
// and the mood menu still gets its turns.
// water is NEVER content. Every goal, including the speedrun macro, gets three
// tripwires:
//   1. an inefficient trail (distance travelled but little displacement) catches circles
//   2. weak net progress catches wading/pathing stalls
//   3. a hard ceiling ends even a productive open-water crossing
// Recovery retraces known dry ground/the water entry before trying deterministic
// outward headings. Random headings made consecutive recoveries undo each other.
const OCEAN_BIOME_RE = /ocean|river/i;
const WATER_ORBIT_WINDOW_MS = 18 * 1000;
const WATER_WADE_LIMIT_MS = 15 * 1000;
const WATER_PROGRESS_BLOCKS = 32;
// a hard rule, stated plainly: the bot is NEVER in open water for minutes. half a
// minute of continuous swimming is already too long on stream, so the ceiling
// is 30s and the wade tripwire is 15s. baritone is separately priced out of
// water entirely (baritone Settings.avoidWaterWhileDry), so this is the net
// under the net - it should almost never have to fire at all.
const WATER_TOTAL_LIMIT_MS = 30 * 1000;
const WATER_TRAIL_WINDOW_MS = 90 * 1000;
const WATER_ORBIT_MIN_PATH_BLOCKS = 24;
const WATER_ORBIT_MAX_EFFICIENCY = 0.32;
const WATER_ESCAPE_COOLDOWN_MS = 20 * 1000;
// an escape swim is allowed to take real time. it is only re-issued when it has
// stopped closing on its destination for this long - never merely because the
// cooldown lapsed while she is still (correctly) swimming home.
const WATER_ESCAPE_STALL_MS = 45 * 1000;
const WATER_ESCAPE_PROGRESS_BLOCKS = 6;
// after climbing out, hold the long random wanders back briefly so the very next
// idle pick doesn't fling her straight back into the sea she just left.
const WATER_EXIT_SETTLE_MS = 5 * 60 * 1000;
// coarse terrain memory (see _cellKey): 64-block cells, bounded, route-sampled
const TERRAIN_CELL = 64;
// how far a single protection refusal is taken to extend, in 64-block cells either
// way (1 => a 3x3 block of cells, ~192 blocks across). server land claims are much
// bigger than one cell, and being wrong here is cheap: the world is large and she
// only loses ground she was refused from anyway.
const CLAIM_SPREAD_CELLS = 1;
const TERRAIN_CELL_CAP = 4000;
const LANDING_SPOT_TRIES = 48;
// a long march into terrain she knows NOTHING about is the actual engine of every
// ocean incident: on a coastal server roughly half of all bearings end in sea, and
// a 900-block blind bearing commits her to swimming it. so an unknown route is
// capped short - she learns the coastline a hop at a time - while a route made of
// cells she has personally walked may run long.
const BLIND_WANDER_MAX = 200;
const KNOWN_ROUTE_MIN_DRY_FRACTION = 0.5;
// bearings that ended in water are remembered as directions, not just cells: the
// cells she swam are a thin line, but "the sea is that way" covers the whole arc.
const DROWNED_BEARING_MS = 45 * 60 * 1000;
const DROWNED_BEARING_ARC = Math.PI / 5;      // +-36 degrees
const DROWNED_BEARING_RANGE = 700;            // blocks from where she went in
const DROWNED_BEARING_CAP = 24;
// anti-ping-pong. the landing-spot scorer deliberately prefers ground she already
// knows is dry (that IS the anti-ocean fix and must stay), which has an ugly second
// effect: the best-scoring escape from a claim at A is the familiar ground at B, and
// from B it is A. she then walks back and forth between two spots forever. so every
// committed long-distance destination is remembered and refused for a while.
const RECENT_DESTINATION_CAP = 96;
// "where have i already looked" is a SEARCH memory, not a ping-pong guard. at 30
// minutes she forgot mid-hunt and re-checked the same land, and a burnt restart
// wiped it outright (it was ram-only). hours, persisted, so a night of hunting for
// unclaimed land actually covers new ground. the relaxed pass in _pickLandingSpot
// stops a long memory from ever boxing her in.
const RECENT_DESTINATION_TTL_MS = 6 * 60 * 60 * 1000;
const VISITED_SPOT_TTL_MS = RECENT_DESTINATION_TTL_MS;
const RECENT_DESTINATION_RADIUS = 140;        // blocks: wider than a claim, tighter than a venture
// only long relocations record the place she is LEAVING. without that the first hop
// back is never caught (she started at A, so A was never a recorded destination), but
// applying it to short drifts (120-180 blocks) would fight the 140-block radius.
const LONG_RELOCATION_MIN = 300;
// AltoClef's own distress signal. an unreachable goto NEVER fails - GetToBlockTask has
// no failure state, it just falls into TimeoutWanderTask with an escalating radius
// (5, 10, 15, 20, 25, 30...) and retries forever, which on stream looks exactly like
// walking back and forth between two spots. watching that ladder climb is the only
// honest "this target cannot be reached" the game ever gives us.
const WANDER_ESCALATION_LIMIT = 3;
// ...except the radius only climbs while ONE TimeoutWanderTask instance survives.
// When the parent task tree is rebuilt instead, AltoClef constructs a fresh
// TimeoutWanderTask(5, true) and the radius restarts at 5 - so the ladder never
// climbs and an escalation-only detector is blind to it. That is the COMMON shape,
// not the rare one: measured 33 wanders in 311s and 21 in 327s across the game
// logs, every single one "wander for 5.0 blocks", with nothing to end them but the
// 5-minute loop detector. So also count wander EPISODES in a window - a goal that
// has to re-unstick itself this often is not travelling, whatever the radius says.
const WANDER_STORM_WINDOW_MS = 75 * 1000;
const WANDER_STORM_LIMIT = 3;
// Actions that legitimately shimmy in place while working a site: PlaceBlockTask,
// PlaceBlockNearbyTask and CraftInTableTask each own a finite TimeoutWanderTask, so
// a burst of short wanders there is normal work, not a wedge. They already have
// their own budgets (ACTION_STALL_MS / survey telemetry). The storm rule is for
// travel and for goals that are supposed to be getting somewhere.
const WANDER_STORM_EXEMPT = new Set(['build_settlement', 'install_appliance', 'place', 'craft']);
// WEDGED IN ONE SPOT. see _noteStallHere: aborts counted BY PLACE rather than by
// job, because every other recovery here answers "that task failed" and none of
// them can answer "this ground is the problem". three inside a few blocks is not
// bad luck with tasks.
const STUCK_STREAK = 3;
const STUCK_RADIUS = 6;               // blocks: "the same spot", not "the same area"
const STUCK_WINDOW_MS = 8 * 60 * 1000;
// the break-out is a DOOR, not a journey. long destinations are exactly the ones
// that could not be pathed, so asking for another one is asking for the freeze.
const STUCK_ESCAPE_MAX = 64;
const HOMESTEAD_STEP_COOLDOWN_MS = 4 * 60 * 1000;
const HOMESTEAD_SETTLE_DIST_MP = 1100;             // min blocks from session anchor (multiplayer)
const HOMESTEAD_SETTLE_DIST_SP = 350;              // min blocks (singleplayer)
// How far one "get out of the settled ring" hop reaches. Was 500-900 on a
// server: far enough to leave spawn, nowhere near far enough to leave the part
// of the map people actually live on, so every site she surfaced at was already
// somebody's. Each hop is still clamped by BLIND_WANDER_MAX when the route
// ahead is unknown, so this is a direction of travel, not one blind leap.
const VENTURE_MIN_MP = 1200;
const VENTURE_SPAN_MP = 1400;
const VENTURE_MIN_SP = 400;
const VENTURE_SPAN_SP = 400;
const HOMESTEAD_NEAR_HOME = 32;                    // "at home" radius for placement steps
const HOME_RELOCATION_MIN_DISTANCE = 1200;         // beyond this, one proven-bad home route may become a move
const HOME_SEARCH_STEP_COOLDOWN_MS = 45 * 1000;
const HOME_SEARCH_MIN_DISTANCE = 48;
const HOME_SEARCH_MAX_DISTANCE = 160;
const HOME_SEARCH_MAX_ATTEMPTS = 6;
const HOME_SEARCH_MAX_ORIGIN_RADIUS = 360;
const HOME_RELOCATION_BACKOFF_MS = 15 * 60 * 1000;
// THE SPAWN REGION. On a community server the land around world spawn is one
// enormous block she can never own - spawn protection, warps, and the ring of
// plots everyone claimed on day one. Both of her existing memories are the wrong
// SHAPE to describe it: a protection refusal marks 64-block cells spread one cell
// either way (192 blocks across), and the nearby-home hunt never reaches further
// than HOME_SEARCH_MAX_ORIGIN_RADIUS from where it began. So when she respawned
// at spawn with an unreachable home she searched, was refused, gave up, backed
// off and searched again forever, every single candidate inside the same unusable
// box - the live "heading to a better nearby home site" loop. Modelled as a
// CUBOID because that is the shape server region plugins actually use, and only
// ever applied on multiplayer: her own singleplayer world is all hers.
const SPAWN_EXCLUSION_RADIUS = Math.max(0, parseInt(process.env.MINECRAFT_SPAWN_EXCLUSION || '1000', 10) || 0);
const SPAWN_EXCLUSION_CENTER = (() => {
    const raw = String(process.env.MINECRAFT_SPAWN_CENTER || '0,0').split(',').map(Number);
    return { x: Number.isFinite(raw[0]) ? raw[0] : 0, z: Number.isFinite(raw[1]) ? raw[1] : 0 };
})();
// leaving is a MARCH, not one leap - an unknown route is still clipped to
// BLIND_WANDER_MAX, so she crosses the region a hop at a time and each hop only
// has to earn ground outward. below this gain a "way out" is just shuffling.
const SPAWN_ESCAPE_MIN_GAIN = 60;
// INSIDE THE REGION HER OWN AUTONOMY MAY ONLY MOVE AND STAY ALIVE. refusing to
// SETTLE there was not enough by half: survival prep chops wood and mines stone,
// the homestead arc quarries, the idle menu collects, and the last-resort branch
// does a "small wood run" - so she stood in the server's front garden felling
// its trees while technically declining to live there. the rule has to bind
// every world-touching action she chooses for herself, not just the home site.
// the operator, chat and the safety chain are all still free to ask for anything.
const SPAWN_REGION_ALLOWED_ACTIONS = new Set([
    'move', 'go_home', 'follow', 'explore',                     // getting out, or getting to someone
    'eat', 'defend', 'attack', 'cover_lava', 'boat', 'equip'    // staying alive on the way
]);
// her own choices, as opposed to a person's instruction or the safety chain
const SPAWN_REGION_GATED_SOURCES = new Set(['autonomous', 'agent']);
// stop a little PAST the edge: standing exactly on the boundary means the first
// site she assesses forty blocks the wrong way is inside again.
const SPAWN_ESCAPE_MARGIN = 240;
// short: a completed hop wakes the loop ~6s later, and a 30s gate meant she then
// waited for the NEXT 25s tick - half the march was standing at the roadside.
const SPAWN_ESCAPE_COOLDOWN_MS = 10 * 1000;
// Enough open air for the toaster's fixed 14x9 footprint plus elbow room. It
// was 21, sized for a shell that started at 19 wide and GREW - a rule the fixed
// floorplan retired, and one that now turns down sites the house fits in easily.
// How many surveyed columns may show somebody's blockwork before the ground
// counts as occupied. Not zero: one fence post from a ruin or a stray village
// path 48 blocks out should not condemn a whole valley. Anything that is
// actually a base or a village lights up dozens of columns at once.
const BUILT_GROUND_TOLERANCE = 3;
// Verdicts that are about the GROUND and will still be true tomorrow. Hostiles
// and passing players are not - they must never condemn a site permanently.
const SITE_GROUND_REASONS = /not enough open room|uneven footing|terrain too steep|water|no open sky|awkward elevation|lava|not in the overworld/;
const REJECTED_CELL_CAP = 4000;
const HOME_SITE_MIN_CLEAR_EDGE = 17;
// the site-standard ladder in _homeSiteAssessment only defines rungs 0-3 (rung 3
// waives the open-sky rule). anything past 3 is not "less fussy", it is no
// standard at all, so relax is clamped here.
const HOME_SITE_MAX_RELAX = 3;
// THE GO-HOME LOOP. observed live: home 2620 blocks away across ocean on a server,
// the homestead arc re-issuing go_home every 4 minutes for FIVE HOURS, each walk
// shredded by drowned inside ten seconds. every existing guard missed it - the wander
// ladder never climbed (baritone kept finding fresh paths), _avoidAction compared
// against 'move' because go_home is rewritten before the goal record is built, and
// relocation demanded goal.source === 'autonomous' plus 1200 blocks. so give her the
// judgement a person has: if setting out for home keeps failing and the gap never
// closes, that home is unreachable - go build somewhere else.
const HOME_UNREACHABLE_ATTEMPTS = 4;                // failed departures before the home is suspect
const HOME_UNREACHABLE_CAMPAIGN_MS = 25 * 60 * 1000; // ...or this long trying, whichever lands first
const HOME_PROGRESS_FRACTION = 0.35;                // closed this much of the gap = the route works, keep walking
const HOME_CAMPAIGN_STALE_MS = 6 * 60 * 60 * 1000;  // no departure this long = the doubt has expired
const HOME_UNREACHABLE_MIN_DISTANCE = 96;           // never abandon a home she is basically standing in
const HOME_INSTINCT_COOLDOWN_MS = 6 * 60 * 1000;    // the night pull is a pull, not a metronome
// the relocation search itself suppresses the idle menu (a bounded nearby hunt must not
// be dragged 500 blocks by boredom), so it MUST be wall-clock bounded too. a search that
// can never find a candidate would otherwise be a brand new way to stand still forever -
// the exact failure this whole change exists to remove.
const HOME_RELOCATION_MAX_MS = 20 * 60 * 1000;
// people rows are upserted in place, so re-writing one is cheap but pointless churn.
// significant contact (they spoke, asked for something, took bread) bypasses this.
const PLAYER_RAG_THROTTLE_MS = 5 * 60 * 1000;
// THE OBSESSION: furnaces, smokers, bread, fire. the homestead arc provisions the
// first of each once; this is the part that never finishes. a person with a
// fixation doesn't tick it off a list - she keeps the fuel bin full, keeps adding
// units to the collection, keeps the bread stocked and the fires lit. it's a
// sampled preference like the homestead (viewer/llm/operator goals always win),
// and every step is cooldown-gated so a failing one goes quiet instead of looping.
const OBSESSION_STEP_COOLDOWN_MS = 5 * 60 * 1000;
const OBSESSION_BIAS = 0.6;                        // chance it outranks the mood menu when something is due
const FUEL_RE = /\b(coal|charcoal)\b/;
const FUEL_FLOOR = 8;                              // below this she goes and gets fuel
const FUEL_COMFORT = 24;                           // a fuel bin she's happy with
const BREAD_FLOOR = 4;                             // below this the bread pipeline runs
const BREAD_COMFORT = 8;
// what she'd LIKE to be carrying, as opposed to what survival needs. bread is the
// whole personality: she wants a stupid amount of it on her at all times, partly to
// eat and mostly so she always has some to hand to whoever turns up. kept as a
// separate, LOWER-priority step than BREAD_COMFORT for the same reason the oven
// hoard is separate from OVEN_TARGETS - one big number would outrank tools, fire and
// shelter, and she'd stand in a field baking while a creeper walked up.
const BREAD_HOARD = 32;
// she will hand out bread down to this, never past it. giving away her last loaf is
// generosity that ends with her starving on stream.
const BREAD_KEEP_BACK = 3;
// Specialty targets. Plain furnaces and the first smoker are managed by the
// deterministic floorplan gallery instead of this secondary collection.
const OVEN_TARGETS = { furnace: 3, smoker: 2, campfire: 2, blast_furnace: 1, soul_campfire: 1 };
// How many of each appliance the floorplan holds, counting all three courses of
// every stack. Read off the map rather than typed here, so redrawing the plan
// moves the target with it instead of leaving a stale 24 behind.
const TOASTER_FURNACE_TARGET = toasterFixtureTarget('homestead', 'furnace');
const TOASTER_SMOKER_TARGET = toasterFixtureTarget('homestead', 'smoker');
const TOASTER_CHEST_TARGET = toasterFixtureTarget('homestead', 'chest');
const TOASTER_NEAR_RADIUS = 40;
// How stale the in-game survey may get during the gallery phase before she
// walks the house again. The build task is the ONLY thing that ever looks at
// the toaster, and it stops the moment the shell is finished - so without this
// nothing re-reads the world for the entire time she is filling it, and the
// world can never correct a booking it cannot see.
const GALLERY_RESURVEY_MS = 15 * 60 * 1000;
// How long a yard that REFUSED TO SHRINK is left alone.
//
// The yard is the one homestead step whose size the plan cannot know, so it is
// also the one that can turn out to be impossible - a block inside a cliff she
// cannot path to, a stump under someone's protected fence. The normal 4-minute
// step cooldown would then walk her out to swing at the same unreachable block
// every four minutes for the rest of the stream, which is not a freeze but is
// indistinguishable from one to watch. One retry an hour is enough to pick the
// job back up if the world changes, and rare enough to stop being the show.
const YARD_STUCK_BACKOFF_MS = 60 * 60 * 1000;
const OUTPOST_MIN_HOME_DISTANCE = 180;
// what she needs before an oven kind is even craftable, so the drive never asks
// for a blast furnace with no iron and burns a cooldown on a doomed goal.
const OVEN_PREREQ = {
    blast_furnace: /iron_ingot|iron_block/,
    // a soul campfire is nether shopping. without this she wants one she cannot make
    // and burns the collection's cooldown on a doomed craft every five minutes.
    soul_campfire: /soul_sand|soul_soil/
};
const MAX_LAVA_PILGRIMAGES = 1;                    // per home; a shrine, not a hobby
const SAFETY_INTERVENTION_COOLDOWN_MS = 12 * 1000;
// how long the "too hurt, do nothing" answer may hold her before it gives up and
// lets normal behaviour resume. without a ceiling it is a hang: health does not
// recover on its own when there is nothing to eat, so the condition that produced
// the park is exactly the condition that keeps it true.
const LOW_HEALTH_PARK_MAX_MS = 45 * 1000;
// the urgent-safety branch returns before EVERY other behaviour, so a safety
// answer that never resolves is not caution - it is a hang. found live
// 2026-08-01: the game refused every eat ("nothing edible in the inventory")
// while she was carrying bread, so the 8hp branch re-issued `eat` on every tick
// and nothing else ever ran. goal "eat" on screen, absolutely nothing happening,
// until the world was closed. safety gets a ceiling and then has to share.
const URGENT_SAFETY_MAX_MS = 90 * 1000;    // how long safety may own the loop
const URGENT_SAFETY_YIELD_MS = 60 * 1000;  // then the rest of the brain gets a turn
// consecutive failed eats after which eating is treated as unavailable instead
// of retried into the ground. an eat that errors twice is a broken pipe, not bad luck.
const EAT_FAIL_STREAK_LIMIT = 2;
const EAT_FAIL_BACKOFF_MS = 5 * 60 * 1000;
const MINECRAFT_MOOD_MAP = {
    cozy: 'happy',
    hype: 'excited',
    salty: 'angry',
    sleepy: 'sad',
    reflective: 'sad',
    unhinged: 'chaotic',
    chaotic: 'chaotic',
    fearful: 'scared',
    scared: 'scared',
    playful: 'happy',
    thoughtful: 'neutral'
};

function defaultGameState() {
    return {
        health: 20,
        hunger: 20,
        position: { x: 0, y: 0, z: 0 },
        dimension: 'overworld',
        inventory: [],
        nearbyEntities: [],
        nearbyHostiles: 0,
        nearbyHostileTypes: [],
        nearbyPlayers: 0,
        biome: 'unknown',
        weather: 'clear',
        // the sky's mood vs HER weather. `weather` is global (a desert, a cave
        // and the nether all report rain); `rainingHere` is the companion's
        // isRainingAt, which is biome-, sky- and roof-aware, so it is the only
        // one that means "she is getting wet right now".
        rainingHere: false,
        skyVisible: true,
        xpLevel: 0,
        selectedItem: 'empty',
        offhandItem: 'empty',
        armor: [],
        air: 300,
        maxAir: 300,
        inLava: false,
        inWater: false,
        underwater: false,
        overWater: false,
        isInCombat: false,
        currentTask: null,
        settlementBuild: null,
        // live altoclef task readout from the in-game companion: botTask is the
        // high-level goal + phase ("beating the game.: getting blaze rods"),
        // botAction is the concrete micro-action underneath. empty when idle.
        botTask: '',
        botAction: '',
        botTaskPath: [],
        botTaskDepth: 0,
        timeOfDay: 'day',
        onGround: true,
        // multiplayer truth from the companion: which server (if any) the client
        // is actually on, and who's around. false/null until the game says so.
        multiplayer: false,
        server: null,
        nearbyPlayerNames: []
    };
}

// map a completed burnt action to a short past-tense "recently" label
function mcCompletionLabel(action, params) {
    const t = params.target;
    switch (action) {
        case 'get': case 'mine': case 'collect': return t ? `got ${t}` : 'gathered resources';
        case 'craft': return t ? `crafted ${t}` : 'crafted something';
        case 'move': return 'reached the destination';
        case 'follow': return (t && !['player', 'nearest', 'me'].includes(t)) ? `caught up to ${t}` : 'caught up';
        case 'attack': case 'defend': return 'won a fight';
        case 'hunt': return 'hunted for food';
        case 'eat': return 'ate';
        case 'equip': return t ? `equipped ${t}` : 'geared up';
        case 'deposit': case 'stash': return 'stored items';
        case 'speedrun': return 'made speedrun progress';
        case 'explore': return 'explored around';
        case 'give': return t ? `handed over ${t}` : 'gave items';
        case 'locate': return t ? `found the ${t}` : 'located a structure';
        case 'place': return t ? `placed ${t.replace(/_/g, ' ')} at the spot` : 'placed a block';
        case 'install_appliance': return t ? `installed ${t.replace(/_/g, ' ')} in its slot in the toaster` : 'installed an appliance';
        case 'build_settlement': return `finished the ${String(params.role || 'toaster').replace(/_/g, ' ')}`;
        case 'build': return 'built something';
        default: return null; // status/coords/inventory/idle/stop/etc - not accomplishments
    }
}

class MinecraftTool extends EventEmitter {
    constructor({ memory = null, registerMemoryExitHook = true, names = null, broadcast = null, remember = null } = {}) {
        super();

        // names she answers to on a public server (see buildAddressedRe above).
        if (names) setBotNames(names);
        // optional sink for internal commentary cues, mirrored to your UI.
        this.broadcast = broadcast;
        // optional long-term-memory sink. this library has no database of its
        // own; if your brain keeps one, pass { player, gameplay } callbacks and
        // the milestones worth recalling tomorrow get handed over. see
        // _rememberMilestone / _bridgePlayerToMemory below.
        this.remember = remember;

        this.config = {
            port: DEFAULT_PORT,
            actionTimeout: DEFAULT_ACTION_TIMEOUT,
            autonomousTickMs: DEFAULT_AUTONOMOUS_TICK_MS,
            // kill a stale NODE process squatting our port and rebind. off by
            // default - see the EADDRINUSE branch in initialize().
            reclaimPort: false,
            debug: false
        };

        // ws server + the single connected bridge client
        this.wss = null;
        this.initializePromise = null;
        this.client = null;
        this.connected = false;
        // `connected` means the node bridge is online. `gameConnected` means
        // that bridge also has its in-game AltoClef companion link.
        this.gameConnected = false;
        this.companionSocketConnected = false;
        this.gameUsername = null;
        this.capabilities = [];
        this.lastBridgeMessageAt = 0;
        this.fault = null;

        // gates - both default off so importing/initializing does nothing visible
        this.enabled = false;
        this.autonomous = false;
        // gamer mode: the built-in @gamer speedrun engaged as a committed, narrated
        // activity. off by default; startGamerMode() flips it. tracked separately
        // from a plain 'speedrun' action so burnt knows to call out her live
        // speedrun phase ("current goal: getting blaze rods") as it changes.
        this.gamerMode = false;
        this._lastBotTaskPhase = '';   // last surfaced high-level task phase
        this._lastPhaseChangeAt = 0;

        // live game state, kept in sync from bridge messages
        this.gameState = defaultGameState();
        this.lastGameStateAt = 0;
        this.mood = 'neutral';
        // Minecraft-specific subjective state. This stays separate from her
        // global conversational mood and changes with this run's telemetry,
        // danger, preparation, successes, setbacks, and novelty.
        this.affect = new MinecraftAffect();
        this.minecraftState = this.affect.snapshot();

        // action bookkeeping
        this.pendingActions = new Map(); // id -> { resolve, reject, timer, action }
        this.currentAction = null;       // the action string we're mid-flight on
        this.currentActionId = null;     // ids keep concurrent chat/look from stealing a goal
        this.currentTask = null;         // human-readable current task
        this.activeGoal = null;          // persistent/long-running goal + progress watchdog

        // session stats for stream overlays / commentary
        this.stats = {
            deaths: 0,
            blocksMined: 0,
            mobsKilled: 0,
            itemsCollected: 0,
            actionsRun: 0,
            sessionStart: null
        };

        // burnt-voice reactions waiting to be spoken by whoever subscribes.
        // we deliberately do NOT push into burnt's tts/speech queue from here -
        // that path has bitten us before (chat-lock deadlock). consumers pull
        // via pullCommentary() or subscribe to the 'commentary' event.
        this.commentaryQueue = [];
        this.reactionCooldowns = new Map();

        // Viewer requests are deliberately collected separately from actions. A
        // chat message is a suggestion, not authority to interrupt the current
        // task or grief a server. The LLM gets this short queue in its live
        // context and can accept a safe, relevant idea with the minecraft tool.
        this.viewerSuggestions = [];
        this.viewerSuggestionCooldowns = new Map();

        // rolling log of notable recent events (for the "recently" context line)
        this.recentEvents = new RecentEvents();
        this._lastCompletionAt = 0;
        // when a real task last finished OR failed - gates the idle menu grace
        this._lastTaskOutcomeAt = 0;
        // one-shot wake so the post-outcome grace ends on its own schedule
        // instead of whenever the 25s tick next happens to look
        this._idleWakeTimer = null;
        // Per-step cooldowns keep a failed prep goal from looping without making
        // her wait four minutes between acquiring a pickaxe, food, and a sword.
        this._survivalPrepCooldowns = new Map();
        this._safetyIntervention = null;
        this._lastSafetyInterventionAt = 0;
        this._requestIntervention = null;
        this.memory = memory || new MinecraftMemory(undefined, { registerExitHook: registerMemoryExitHook });

        // multiplayer chat manners state (see shouldSurfaceChat / chat pacing)
        this._chatSeenText = new Map();   // lowercased line -> last arrival, for the fan-out dedup
        this._roomChatAt = [];            // when OTHER people last talked (see chatRoom)
        this._chatSenderLastAt = new Map();
        this._lastAmbientChatAt = 0;
        this._chatSendTimes = [];
        // last time a move was refused for having nowhere to go (see the rejection
        // site) - a second one in quick succession gets a different answer
        this._lastNowhereMoveAt = 0;
        // open exchanges: who she is currently in a back-and-forth with, so their
        // follow-ups reach her without her name in them (see CHAT_EXCHANGE_MS)
        this._chatExchanges = new Map();  // senderKey -> { until, since, name }
        this._recentAddressers = [];      // who addressed her lately, awaiting her reply
        // "just standing there" guards: when she last took a hit, and how long a
        // task has been running with no burnt-side goal behind it
        this._lastDamageAt = 0;
        this._orphanTaskSince = 0;
        // eat health: a refused eat is a real answer and has to be remembered,
        // otherwise the safety branch reissues it forever (see URGENT_SAFETY_MAX_MS)
        this._lastEatAttemptAt = 0;
        this._lastEatFailureAt = 0;
        this._eatFailStreak = 0;
        // how long the urgent-safety branch has continuously owned the tick
        this._urgentSafetySince = 0;
        this._urgentSafetyYieldUntil = 0;
        // in-game intent hud: last line sent, so it only goes on real change
        this._lastIntentSignature = null;
        this._lastIntentPushAt = 0;
        // pinned-by-mobs detector (see PINNED_* constants)
        this._pinnedAnchor = null;
        this._pinnedAnchorAt = 0;
        this._lastPinRecoveryAt = 0;
        this._recoveringPin = false;

        // f1 manual control: the human owns keyboard/mouse; bot goals blocked
        this.manualControl = false;
        // homestead drive state
        this._homesteadCooldowns = new Map();
        this._homesteadArmed = null;      // cooldown armed by the last pass, released if refused
        this._lastSettlementProgressSignature = '';
        this._sessionAnchor = null;
        this._homeRelocation = null;
        this._homeRelocationBackoffUntil = 0;
        this._lastWheatRecordAt = 0;
        // the obsession (ovens / bread / fire): its own cooldown map so a stalled
        // homestead step can't starve the drive that never finishes, and vice versa
        this._obsessionCooldowns = new Map();
        this._lavaPilgrimages = 0;
        // ocean-wading watchdog state
        this._waterSinceAt = 0;
        this._lastWaterEscapeAt = 0;
        this._waterContinuousSince = 0;
        this._waterAnchor = null;
        this._waterEntryPosition = null;
        this._waterTrail = [];
        this._lastDryPosition = null;
        this._waterEscapeIndex = 0;
        this._waterEscapeInFlight = false;
        // an in-flight escape must be allowed to FINISH. re-issuing stop+move on
        // every cooldown tick was the actual "she just floats there" bug: the swim
        // home takes minutes, the watchdog cancelled it every 30s, and baritone
        // never got to arrive. these track escape progress so it is only re-issued
        // when it has genuinely stalled.
        this._waterEscapeDest = null;
        this._waterEscapeIssuedAt = 0;
        this._waterEscapeBestDist = Infinity;
        this._waterEscapeProgressAt = 0;
        this._lastWaterExitAt = 0;
        // coarse terrain memory: which 64-block cells she has been wet in vs stood
        // on. random bearings kept marching her into the same ocean because nothing
        // remembered where the water was.
        this._wetCells = new Map();
        this._dryCells = new Map();
        // directions that ended in open water. cells only record the thin line she
        // swam; a bearing records the whole arc of sea behind it.
        this._drownedBearings = [];
        this._claimedCells = new Set();      // ground the server refused her, persisted
        // ground she walked out to, assessed, and turned down. session-scoped:
        // terrain never improves, but a fresh run deserves a fresh look in case
        // the standards themselves changed.
        this._rejectedCells = new Set();
        this._recentDestinations = [];       // where she has just been sent (anti-ping-pong)
        // server protection denials ("you are not allowed to interact...") -
        // repeated hits mean claimed land: abort the goal and relocate far
        this._protectionDenials = [];
        this._stallAnchor = null;      // wedged-in-one-spot detector (see _noteStallHere)
        this._lastProtectionEscapeAt = 0;
        this._escapingProtection = false;

        this.autonomousTimer = null;
        this.lastAutonomousAt = 0;
        // Singular cancellation barrier. A replacement task waits for the
        // currently dispatched stop to be confirmed instead of racing it onto
        // the wire and being immediately cancelled by the older transition.
        this._stopInFlight = null;
        this._gamerStartInFlight = null;
    }

    log(level, message, data = null) {
        if (!this.config.debug && level === 'debug') return;
        const stamp = new Date().toISOString();
        const line = `[${stamp}] [minecraft-tool] [${level}] ${message}`;
        if (data !== null && data !== undefined) console.log(line, data);
        else console.log(line);
    }

    _setFault(code, message) {
        if (this.fault?.code === code) return this.fault;
        this.fault = { code, message, at: Date.now() };
        this.log('warn', `fault detected: ${message}`);
        this.emit('faultDetected', { ...this.fault });
        return this.fault;
    }

    _clearFault(code = null) {
        if (!this.fault || (code && this.fault.code !== code)) return false;
        const cleared = this.fault;
        this.fault = null;
        this.emit('faultCleared', { ...cleared, clearedAt: Date.now() });
        return true;
    }

    // ---- lifecycle -------------------------------------------------------

    // start the ws server + autonomous tick. idempotent - safe to call again.
    async initialize(opts = {}) {
        Object.assign(this.config, opts);
        if (this.wss) return this; // already running
        if (this.initializePromise) {
            await this.initializePromise;
            return this;
        }

        this.initializePromise = new Promise((resolve, reject) => {
            let server;
            const failStartup = (err) => {
                // A failed listen must be retryable. Leaving `wss` set here made
                // every later mode switch think the bridge server was healthy.
                if (this.wss === server) this.wss = null;
                try { server?.close(); } catch { /* nothing was listening */ }
                reject(err);
            };
            try {
                // The relay and companion are same-machine processes. Binding
                // only loopback keeps the unauthenticated game-control plane
                // off the LAN, matching the Java companion and Tetris bridge.
                server = new WebSocketServer({
                    port: this.config.port,
                    host: '127.0.0.1',
                    maxPayload: 64 * 1024
                });
                this.wss = server;
                server.on('connection', (ws) => this._onConnection(ws));
                server.on('error', (err) => {
                    this.log('error', 'ws server error', err.message);
                    // EventEmitter treats an unhandled `error` event as fatal.
                    // Logging is enough here; callers receive startup failures
                    // through initialize()/gameControl instead.
                });
                server.once('error', failStartup);
                server.once('listening', () => {
                    server.off('error', failStartup);
                    this.log('info', `listening for bot bridge on ws://localhost:${this.config.port}`);
                    resolve();
                });
            } catch (err) {
                failStartup(err);
            }
        });

        try {
            await this.initializePromise;
        } catch (err) {
            this.initializePromise = null;
            // EADDRINUSE = a stale tool / test stand-in is still squatting our
            // port. with `reclaimPort: true` the latest instance wins: stop the
            // old NODE process holding it and bind again, so a restart never
            // needs manual cleanup.
            //
            // OFF BY DEFAULT, deliberately. this kills another process, and on a
            // dev box the thing on your port is at least as likely to be an
            // unrelated node server you care about. opt in only when this
            // controller owns the port outright:
            //     await mc.initialize({ port: 7431, reclaimPort: true })
            if (this.config.reclaimPort
                && (err?.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err?.message)))
                && !opts._portReclaimed) {
                const freed = await this._reclaimPort(this.config.port);
                if (freed) return this.initialize({ ...opts, _portReclaimed: true });
            }
            throw err;
        } finally {
            this.initializePromise = null;
        }

        this.stats.sessionStart = Date.now();
        this._startAutonomousLoop();
        return this;
    }

    // find the process listening on our port and stop it - but ONLY if it's a
    // node process (a stale burnt instance or test harness). anything else gets
    // a loud log and a refusal, never a blind kill.
    async _reclaimPort(port) {
        try {
            const { exec } = await import('child_process');
            const run = (cmd) => new Promise((resolve) => {
                exec(cmd, { windowsHide: true, timeout: 8000 }, (e, out) => resolve(String(out || '')));
            });
            const out = await run('netstat -ano -p tcp');
            const line = out.split(/\r?\n/).find((l) => new RegExp(`[:.]${port}\\s`).test(l) && /LISTENING/i.test(l));
            const pid = line ? parseInt(line.trim().split(/\s+/).pop(), 10) : NaN;
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
            const task = await run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
            if (!/node\.exe/i.test(task)) {
                this.log('warn', `port ${port} is held by pid ${pid} (${task.split(',')[0] || 'unknown'}) - not a node process, refusing to kill it`);
                return false;
            }
            this.log('warn', `port ${port} held by a stale node process (pid ${pid}) - stopping it so the latest instance can bind`);
            process.kill(pid);
            await new Promise((r) => setTimeout(r, 1200));
            return true;
        } catch (err) {
            this.log('warn', `port ${port} reclaim failed: ${err.message}`);
            return false;
        }
    }

    _onConnection(ws) {
        // only one bridge at a time; a new connection replaces the old.
        if (this.client && this.client.readyState === 1) {
            this.log('warn', 'second bridge connected, dropping the previous one');
            try { this.client.close(); } catch { /* ignore */ }
        }
        this.client = ws;
        this.connected = true;
        this.lastBridgeMessageAt = Date.now();
        this._clearFault('bridge_silent');
        this._clearFault('stop_unconfirmed');
        this.log('info', 'bot bridge connected');
        this.emit('connected');

        // tell the bridge our current desired config on connect
        this.send({ type: 'config', enabled: this.enabled, autonomous: this.autonomous });
        this.send({ type: 'query' });

        ws.on('message', (raw) => this._onMessage(raw));
        ws.on('close', () => {
            if (this.client === ws) {
                this.connected = false;
                this.gameConnected = false;
                this.companionSocketConnected = false;
                this.client = null;
                this.activeGoal = null;
                this.manualControl = false;
                this.lastBridgeMessageAt = 0;
                this.log('info', 'bot bridge disconnected');
                this.emit('disconnected');
                // fail any in-flight actions so callers don't hang
                this._failAllPending('bridge disconnected');
            }
        });
        ws.on('error', (err) => this.log('error', 'bridge socket error', err.message));
    }

    _onMessage(raw) {
        this.lastBridgeMessageAt = Date.now();
        this._clearFault('bridge_silent');
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (err) {
            this.log('error', 'bad message from bridge', raw.toString().slice(0, 200));
            return;
        }
        if (!msg || typeof msg.type !== 'string') {
            this.log('warn', 'bridge message missing a type');
            return;
        }
        this.log('debug', `bridge -> ${msg.type}`, msg);

        switch (msg.type) {
            case 'handshake':
                this.capabilities = msg.capabilities || [];
                this.log('info', 'bridge handshake', { version: msg.version, caps: this.capabilities.length });
                break;
            case 'bridge_status':
                this._applyBridgeStatus(msg);
                break;
            case 'response':
                this._handleResponse(msg);
                break;
            case 'state':
                this._applyState(msg.gameState || {}, msg.observedAt);
                break;
            case 'event':
                this._handleEvent(msg.event, msg.data || {});
                break;
            case 'heartbeat':
                // A heartbeat may contain the bridge's last snapshot, not a new
                // client-thread observation, so it must never make stale state
                // look fresh.
                if (msg.gameState) this._applyState(msg.gameState, null, false);
                this.send({ type: 'heartbeat_ack', timestamp: Date.now() });
                break;
            case 'queue_status':
                this.emit('queueStatus', msg);
                break;
            case 'log':
                this.log('debug', `bridge log: ${msg.message}`);
                break;
            default:
                this.log('warn', 'unknown bridge message type', msg.type);
        }
    }

    // the bridge re-sends bridge_status on a ~5s heartbeat, not just on change.
    // logging/emitting every one of those buried the console (~12 identical
    // "companion disconnected" lines a minute, forever) and re-fired the mode
    // broadcast on each. only react when the link actually changed state.
    _applyBridgeStatus(msg) {
        const wasInWorld = this.gameConnected;
        const wasSocket = this.companionSocketConnected;
        const nowInWorld = !!msg.altoclefConnected;
        const nowSocket = !!msg.companionSocketConnected;
        if (msg.username) this.gameUsername = msg.username;
        this.gameConnected = nowInWorld;
        this.companionSocketConnected = nowSocket;
        // A successful companion reconnect that explicitly reports "waiting
        // for world" proves the client/control thread is answering again even
        // though there is no fresh in-world telemetry to clear the stale fault.
        if (nowSocket && !nowInWorld) this._clearFault('telemetry_stale');
        if (nowInWorld === wasInWorld && nowSocket === wasSocket) return;

        this.emit('gameConnection', { connected: nowInWorld, username: msg.username || this.gameUsername || null });
        this.log('info', `minecraft companion ${nowInWorld
            ? 'ready in world'
            : nowSocket ? 'connected, waiting for world' : 'disconnected'}`);

        if (nowInWorld && !wasInWorld) {
            this.recentEvents.record(wasSocket ? 'joined the world' : 'reconnected to the world');
            this._setMinecraftState(this.affect.applyEvent('world_joined', {}, this.gameState));
            return;
        }
        if (!nowInWorld && wasInWorld) this._standDownSession();
    }

    // the world went away (game closed, world exited, mod crashed). the
    // autonomous loop already refuses to act without a live companion, but the
    // status kept advertising a task she can no longer be doing. clear the
    // stale goal, mark it in recent events, and say it ONCE.
    _standDownSession() {
        this.recentEvents.record('the world dropped out from under me');
        // a fresh world/session starts with the bot in control and a clean slate
        this.manualControl = false;
        this._protectionDenials = [];
        this._sessionAnchor = null;
        this._stallAnchor = null;
        this._homeRelocation = null;
        this._lavaPilgrimages = 0;
        // forget what the hud was last told, so a reconnect re-pushes instead of
        // trusting a line that only exists in the old game's memory
        this._lastIntentSignature = null;
        this._setMinecraftState(this.affect.applyEvent('session_lost', {}, this.gameState));
        const stranded = this.activeGoal
            ? this._describeTask(this.activeGoal.action, this.activeGoal.params)
            : this.currentTask;
        // A ready->not-ready transition can happen without the TCP socket
        // closing (world exit, frozen client thread, main menu). Do not leave
        // action timers alive for minutes after the world that owned them is gone.
        this._failAllPending('minecraft world disconnected');
        try {
            this.memory.record('recovery', stranded
                ? `lost the world mid-${stranded}`
                : 'lost the world', {
                position: this.gameState.position,
                dimension: this.gameState.dimension
            });
        } catch { /* memory best-effort */ }
        this.emit('sessionEnded', { strandedTask: stranded || null, username: this.gameUsername || null });
    }

    _handleResponse(msg) {
        const pending = this.pendingActions.get(msg.action_id);
        if (!pending) return;

        if (msg.status === 'executing') {
            // ack - the bot picked up the task. reset the timeout since real
            // tasks (mining, pathing) take a while to actually complete.
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
                this._expirePendingAction(
                    msg.action_id,
                    pending,
                    `action timed out: ${pending.action}`
                );
            }, pending.timeoutMs);
            this.emit('actionAck', { id: msg.action_id, action: pending.action });
            // Tool-initiated finite jobs return as soon as the game accepts
            // them, so they need the same stall/loop supervision as autonomous
            // jobs. Idle/follow remain visible but may legitimately stand;
            // explore is persistent yet still receives movement supervision.
            if (!NON_TASK_ACTIONS.has(pending.action) &&
                (pending.source === 'autonomous' || !pending.waitForCompletion)) {
                this._trackActiveGoal(pending, msg.action_id);
            }
            if (!pending.waitForCompletion && !pending.settled) {
                pending.settled = true;
                pending.resolve({
                    started: true,
                    action_id: msg.action_id,
                    task: this._describeTask(pending.action, pending.params || {})
                });
            }
            return;
        }

        // terminal response
        clearTimeout(pending.timer);
        this.pendingActions.delete(msg.action_id);
        const ownsCurrentAction = this.currentActionId === msg.action_id;
        const ownsActiveGoal = this.activeGoal?.id === msg.action_id;
        if (msg.result?.persistent) {
            // A persistent command may acknowledge before the local send path
            // has assigned currentAction, so derive its state from the pending
            // record rather than relying on timing-sensitive currentAction.
            if (ownsCurrentAction) {
                this.currentAction = null;
                this.currentActionId = null;
            }
            this.currentTask = this._describeTask(pending.action, pending.params || {});
            this._trackActiveGoal(pending, msg.action_id);
            this.memory.record('started', this.currentTask, {
                action: pending.action,
                target: pending.params?.target,
                position: this.gameState.position,
                dimension: this.gameState.dimension
            });
        } else if (ownsCurrentAction || ownsActiveGoal) {
            this.currentAction = null;
            this.currentActionId = null;
            this.currentTask = null;
            if (ownsActiveGoal) this.activeGoal = null;
        }
        this.stats.actionsRun++;
        // a terminal speedrun outcome (finished, failed, or superseded by a stop)
        // ends gamer mode; the run is no longer live to narrate. this is the exit
        // that fires when a viewer/llm goal PREEMPTS the run, so it has to hand
        // self-play back too - otherwise "burnt, build your house instead" ends
        // the speedrun and silently ends idle play with it.
        this._noteTaskEnded(pending.action);

        if (pending.action === 'eat') this._noteEatOutcome(msg.status === 'success');

        // a goal WE aborted is not a goal she finished (see _markPendingAborted).
        // the game cannot tell us apart - it reports a cancelled task exactly like
        // a completed one - so the only place that knows is here, where our own
        // stop is still remembered against this action id. treat it as the
        // interruption it was: no completion memory, no "finished the toaster",
        // no arc step ticked off, and no cooldown earned by a house that isn't up.
        if (msg.status === 'success' && pending.abortedByRecovery) {
            this.log('warn', `${pending.action} came back finished after we stopped it (${pending.abortedByRecovery}) - recording an abort, not a build`);
            if (!pending.settled) {
                pending.settled = true;
                pending.reject(new Error(`stopped: ${pending.abortedByRecovery}`));
            }
            // deliberately silent: the watchdog that issued the stop has already
            // recorded the failure and put the words in her mouth. emitting
            // actionFailed here would hand the same abort to burnt.js's fault
            // voice as well, and she would complain about it twice.
            return;
        }

        if (msg.status === 'success') {
            if (msg.result?.persistent) {
                this.emit('actionStarted', { id: msg.action_id, action: pending.action, params: pending.params, result: msg.result });
            } else {
                const notable = !NON_TASK_ACTIONS.has(pending.action);
                if (notable) this._noteTaskOutcome();
                if (notable) this._applyMinecraftOutcome(true, pending.action);
                this._recordCompletion(pending.action, pending.params);
                // the two lines above already filter NON_TASK_ACTIONS; this one did not,
                // so the cosmetic 30s `hud` heartbeat was written to the durable journal
                // as a completed task. it filled 208 of 240 slots and evicted every real
                // memory - her "game memory:" prompt line was six copies of the word hud.
                // chat is exempted too: her own outgoing lines were being stored with no
                // addressee and no prompting message, which is not a memory of anything.
                if (notable) {
                    this.memory.record('completed', this._describeTask(pending.action, pending.params || {}), {
                        action: pending.action,
                        target: pending.params?.target,
                        position: this.gameState.position,
                        dimension: this.gameState.dimension
                    });
                    // somebody asked for this and she actually did it. closing the
                    // request is what turns her people memory from a list of demands
                    // into a record of what she followed through on.
                    if (pending.requestedBy) {
                        try { this.memory.completePlayerRequest(pending.requestedBy, pending.action); } catch { /* best-effort */ }
                    }
                }
                this.emit('actionComplete', { id: msg.action_id, action: pending.action, params: pending.params, result: msg.result });
            }
            if (!pending.settled) {
                pending.settled = true;
                pending.resolve(msg.result || { success: true });
            }
        } else {
            const error = new Error(msg.error || 'action failed');
            // a superseded goal errors out with 'task stopped' whenever a stop
            // lands (chat re-task, stall recovery, dwell rotation). that's a
            // deliberate interruption, not a goal failure: recording it trips the
            // repeated-failure gate after a few re-tasks, and narrating it makes
            // burnt announce a failure that never happened.
            const wasStopped = /^task stopped$/i.test((error.message || '').trim());
            if (!NON_TASK_ACTIONS.has(pending.action)) {
                this._noteTaskOutcome();
                if (!wasStopped) this.memory.recordFailure(pending.action, pending.params?.target, error.message);
            }
            if (this.activeGoal?.id === msg.action_id) this.activeGoal = null;
            if (wasStopped) {
                // silent event for observers - whoever issued the stop already
                // voiced why, so there is nothing to narrate here.
                this.emit('actionStopped', { id: msg.action_id, action: pending.action, params: pending.params });
            } else {
                if (!NON_TASK_ACTIONS.has(pending.action)) this._applyMinecraftOutcome(false, pending.action);
                // mark it so executeAction's catch does not report the same failure a
                // second time when this rejection surfaces there.
                error._reported = true;
                this.emit('actionFailed', { id: msg.action_id, action: pending.action, params: pending.params, error: error.message });
            }
            if (!pending.settled) {
                pending.settled = true;
                pending.reject(error);
            }
        }
    }

    _applyState(partial, observedAt = null, freshObservation = true) {
        if (!partial || typeof partial !== 'object') return;
        Object.assign(this.gameState, partial);
        // remember whether this companion build actually reports water, so the
        // legacy biome fallback in _isInWater can tell "dry" from "never told"
        if (partial.inWater !== undefined) this._sawInWaterField = true;
        // standing on the grave counts as collecting it - drop the reminder so
        // she stops being told to go fetch something she is already holding.
        try {
            const grave = this.memory.getDeathSpot();
            const here = this.gameState.position;
            if (grave && here && this._dimMatches(grave.dimension, this.gameState.dimension) &&
                Math.hypot(here.x - grave.position.x, here.z - grave.position.z) <= 3) {
                this.memory.clearDeathSpot();
                this.recentEvents.record('picked her stuff back up off the ground');
            }
        } catch { /* best-effort */ }
        if (partial.currentTask !== undefined) this.currentTask = partial.currentTask;
        if (partial.settlementBuild && typeof partial.settlementBuild === 'object') {
            this._persistSettlementSurvey(partial.settlementBuild);
        }
        if (freshObservation && Number.isFinite(observedAt) && observedAt > 0) {
            this.lastGameStateAt = observedAt;
            if (Date.now() - observedAt <= MAX_TELEMETRY_AGE_MS) this._clearFault('telemetry_stale');
        }
        const pos = this.gameState.position;
        const realPos = pos && [pos.x, pos.y, pos.z].every(Number.isFinite) && !(pos.x === 0 && pos.y === 0 && pos.z === 0);
        // session anchor: where this session started - the homestead drive
        // measures "how deep into the wilderness am i" against it
        if (!this._sessionAnchor && realPos) {
            this._sessionAnchor = { x: pos.x, y: pos.y, z: pos.z };
        }
        // wheat memory: walking past a field records it (dedup + merge in the
        // memory layer; altoclef replants what it harvests, so these spots are
        // renewable bread farms she can come back to forever)
        const nb = this.gameState.nearby;
        if (realPos && nb && nb.wheat != null && Date.now() - (this._lastWheatRecordAt || 0) > 30000) {
            this._lastWheatRecordAt = Date.now();
            try { this.memory.recordWheatSpot(pos, this.gameState.dimension, nb.wheatCount || 0); } catch { /* best-effort */ }
        }
        this._observeMinecraftState();
        this._observeGoalProgress(partial);
        this._observePinned();
        this._observeWaterState();
        this._observeBotTaskPhase(partial);
        this.emit('stateUpdate', this.gameState);
        // State arrives about every two seconds; water recovery must not wait for
        // the slower autonomous-choice cadence. It also protects operator/LLM
        // goals when self-play is disabled.
        if (freshObservation && this.connected && this.gameConnected) {
            // Cosmetic state belongs to the live game connection, not autonomy.
            // Keep affects visible while Burnt is enabled but idle/manual, too.
            this._pushIntentHud();
        }
        if (freshObservation && this.enabled && this.connected && this.gameConnected) {
            // WATER GOES FIRST. it used to run third, behind two recoveries that
            // `return` when they fire - so any tick where she was pinned by mobs or
            // chasing an unreachable target skipped the water check entirely. those
            // are exactly the states that strand her in the sea, so the one watchdog
            // with a hard deadline was starved precisely when it was needed. it
            // returns true only while an escape is genuinely still closing on land,
            // and that legitimately outranks both of the others.
            if (this._waterWatchdog()) return;
            // State arrives every ~2s, so use it as the progress watchdog clock.
            // Waiting for the 25s autonomy tick made even a 20s craft deadline land
            // anywhere from 25-50s later, and did nothing when self-play was off.
            if (this._recoverStalledGoal()) return;
            if (this._recoverPinnedByMobs()) return;
            if (this._observeUnreachableTarget()) return;
            this._maybeNarrateToRoom();
            this._maybeGreetArrival();
        }
    }

    // people are standing around a bot that is visibly DOING something and never
    // says a word about it. when the room is populated but chat has gone idle,
    // nudge her brain to volunteer a line in game - a CUE, never a written line,
    // so the words are hers (see the no-canned-responses rule). rare and sampled:
    // company, not a commentary track.
    // SOMEBODY WALKED UP TO HER.
    //
    // bread is the whole personality, so an arrival is an opportunity: throw them a
    // loaf, offer them one, or just say something. WHICH of those happens is decided
    // here; WHAT SHE SAYS is never decided here - the gesture goes out as an event
    // and her brain writes the words (see the no-canned-responses rule). the throw
    // is a real `@give <player> bread 1`, so the loaf genuinely leaves her inventory
    // and lands at their feet.
    //
    // deliberately restrained: sampled, rate-limited globally AND per person, and it
    // never interrupts work she is already doing. a bot that greets every passer-by
    // every time is a nuisance, and one that drops its task to do it is broken.
    _maybeGreetArrival(now = Date.now()) {
        const g = this.gameState;
        if (!this.enabled || this.manualControl) return false;
        if (g.multiplayer !== true || !this.gameConnected) return false;
        // never yank her out of something to hand out bread
        if (this.currentAction || this.activeGoal || this.pendingActions?.size) return false;

        const nearby = (Array.isArray(g.nearbyPlayerNames) ? g.nearbyPlayerNames : [])
            .map((n) => String(n || '').trim())
            .filter((n) => n && /^[A-Za-z0-9_]{1,16}$/.test(n)
                && n.toLowerCase() !== String(this.gameUsername || '').toLowerCase());

        if (!this._seenNearby) this._seenNearby = new Map();
        // ARRIVALS ONLY: someone already standing there is not an event. a name that
        // dropped out and came back inside the per-player window is not one either -
        // people drift across render distance constantly and that is not "walking up".
        const arrivals = nearby.filter((n) => now - (this._seenNearby.get(n) || 0) > ARRIVAL_PER_PLAYER_GAP_MS);
        for (const n of nearby) this._seenNearby.set(n, now);
        // forget people who left long ago so the map cannot grow forever
        if (this._seenNearby.size > 64) {
            for (const [k, at] of this._seenNearby) {
                if (now - at > ARRIVAL_PER_PLAYER_GAP_MS * 2) this._seenNearby.delete(k);
            }
        }
        if (!arrivals.length) return false;
        if (now - (this._lastArrivalAt || 0) < ARRIVAL_GAP_MS) return false;
        if (Math.random() > ARRIVAL_SAMPLE) return false;

        const who = arrivals[Math.floor(Math.random() * arrivals.length)];
        const loaves = this._breadCount();
        const canSpare = loaves > BREAD_KEEP_BACK;
        // with bread to spare she usually makes it about bread; otherwise she just
        // talks. offering rather than throwing keeps it from being a vending machine.
        let gesture = 'talk';
        if (canSpare && Math.random() < ARRIVAL_BREAD_SHARE) {
            gesture = Math.random() < 0.6 ? 'give' : 'offer';
        }
        this._lastArrivalAt = now;

        if (gesture === 'give') {
            // a real throw - the loaf leaves her inventory and lands at their feet
            this._safeExecute('give', { player: who, item: 'bread', amount: 1 }, null);
        }
        this._rememberPlayerDurably('sighting', who);
        if (gesture === 'give') this._rememberPlayerDurably('gift', who, 'bread');
        this.recentEvents.record(`${who} walked up${gesture === 'give' ? ' and got a loaf' : ''}`);
        this.emit('gameEvent', 'player_approached', {
            player: who, gesture, loaves, alsoNearby: nearby.filter((n) => n !== who).slice(0, 4)
        });
        return true;
    }

    _maybeNarrateToRoom(now = Date.now()) {
        if (this.manualControl) return;
        const room = this.chatRoom(now);
        if (room.level !== 'quiet') return;                 // busy = don't talk over them
        if (now - (this._lastRoomNarrateAt || 0) < ROOM_NARRATE_GAP_MS) return;
        const doing = this.currentTask || this.activeGoal?.action || this.botTask;
        if (!doing) return;                                  // nothing to say = say nothing
        if (Math.random() > ROOM_NARRATE_SAMPLE) return;
        this._lastRoomNarrateAt = now;
        this.emit('gameEvent', 'room_quiet_moment', {
            task: String(doing).slice(0, 120),
            quietForMs: room.quietForMs,
            people: room.people
        });
    }

    // detect a change in the live altoclef task phase (from the companion's
    // botTask readout) and surface it as a narratable "current goal" beat. keyed
    // off the ROOT task (high-level goal + phase) so it fires on real transitions -
    // getting wood -> stone -> iron -> nether -> blaze rods -> stronghold -> the
    // end - not on the constantly-changing micro-action underneath. this is what
    // lets burnt say what she's actually doing during a long @gamer speedrun.
    _observeBotTaskPhase(partial = {}) {
        if (!Object.prototype.hasOwnProperty.call(partial, 'botTask')) return;
        const phase = this._cleanPhase(this.gameState.botTask);
        if (phase === this._lastBotTaskPhase) return;
        const now = Date.now();
        const previous = this._lastBotTaskPhase;
        this._lastBotTaskPhase = phase; // update immediately so we never re-fire the same phase
        // collapse poll-to-poll jitter of the root debug state: genuine phases are
        // minutes apart, so an 8s floor never eats a real transition (the next poll
        // re-emits the settled phase anyway) but kills flapping between two
        // near-simultaneous sub-goals.
        if (now - this._lastPhaseChangeAt < 8000) return;
        this._lastPhaseChangeAt = now;
        if (!phase) return; // task ended / went idle - nothing to announce
        this.recentEvents.record(phase);
        // carry the intent along: a bare phase string ("getting stick x 2") gives her
        // nothing to react TO. what she thinks she's doing, and why, is the reactable part.
        const intent = this._intentPayload();
        this.emit('botTaskPhase', {
            phase, previous, gamerMode: this.gamerMode,
            what: intent.what, why: intent.why
        });
        // overlay-only 'phase' commentary (burnt.js narrates the spoken version via
        // the botTaskPhase event on its own rate limit)
        this._pushCommentary(phase, 'phase');
    }

    // normalize the raw altoclef task toString ("beating the game.: getting blaze
    // rods") into a compact phase label. altoclef already lowercases it; trim a
    // dangling ": " when a task has no debug state yet.
    _cleanPhase(raw) {
        if (!raw || typeof raw !== 'string') return '';
        return raw.replace(/\s+/g, ' ').replace(/:\s*$/, '').trim().slice(0, 100);
    }

    // is anyone listening, and are they mid-conversation? this is what decides
    // whether she says what she's doing OUT LOUD in the server or keeps it to the
    // stream. levels: solo (singleplayer - nobody to tell), busy (a conversation
    // is running - don't talk over it), quiet (people here, chat idle - the best
    // time to say something), dead (nobody has spoken in ages).
    chatRoom(now = Date.now()) {
        const g = this.gameState;
        const people = Number(g.nearbyPlayers) || 0;
        if (g.multiplayer !== true) return { level: 'solo', lines: 0, quietForMs: Infinity, people };
        this._roomChatAt = this._roomChatAt.filter((t) => now - t <= ROOM_CHAT_WINDOW_MS * 6);
        const lines = this._roomChatAt.filter((t) => now - t <= ROOM_CHAT_WINDOW_MS).length;
        const last = this._roomChatAt[this._roomChatAt.length - 1] || 0;
        const quietForMs = last ? now - last : Infinity;
        let level = 'quiet';
        if (lines >= ROOM_BUSY_LINES || quietForMs <= ROOM_BUSY_RECENT_MS) level = 'busy';
        else if (quietForMs >= ROOM_DEAD_MS && people <= 0) level = 'dead';
        return { level, lines, quietForMs, people };
    }

    // true when this exact line already arrived moments ago (a duplicate delivery
    // of one server message), false the first time. bounded so a long session
    // can't grow the map.
    _recentChatText(text) {
        const now = Date.now();
        const seen = this._chatSeenText.get(text);
        if (seen && now - seen < CHAT_DUP_WINDOW_MS) {
            this._chatSeenText.set(text, now);
            return true;
        }
        this._chatSeenText.set(text, now);
        if (this._chatSeenText.size > CHAT_DUP_CACHE) {
            for (const [key, at] of this._chatSeenText) {
                if (now - at >= CHAT_DUP_WINDOW_MS) this._chatSeenText.delete(key);
            }
            while (this._chatSeenText.size > CHAT_DUP_CACHE) {
                this._chatSeenText.delete(this._chatSeenText.keys().next().value);
            }
        }
        return false;
    }

    _handleEvent(event, data) {
        // The client receives its own sent chat through the game event bus. Do
        // not feed that back into Burnt or she will reply to herself forever.
        if (event === 'chat' && this.gameUsername &&
            String(data.sender || '').toLowerCase() === String(this.gameUsername).toLowerCase()) {
            return;
        }
        // ONE server line, ONE event. The companion listens on three delivery
        // paths (signed chat mixin, fabric CHAT event, system-channel plugin
        // formats) and its dedup keyed on sender+text - but the sender is exactly
        // what differs between paths when one parses `<(Member) > Name>` and
        // another falls back to the fabric sender. Live proof: the identical
        // sentence arrived 4x under 4 different names, and she answered 4 times.
        // Dedup on TEXT alone: two people typing the same words inside 2.5s is
        // rare, and losing that is far cheaper than replying four times.
        if (event === 'chat') {
            const text = String(data.text || '').trim().toLowerCase();
            if (text && this._recentChatText(text)) return;
            // room traffic counts EVERY line other people say, including the ones
            // that never reach her brain - two players talking to each other is
            // still a live conversation she shouldn't narrate over.
            this._roomChatAt.push(Date.now());
            if (this._roomChatAt.length > 64) this._roomChatAt.shift();
        }
        // The companion samples nearby hostiles continuously. Treat a group
        // that remains nearby as state, not a new show moment: only surface
        // the first contact or a meaningful escalation. Without this gate the
        // same zombies keep re-entering Burnt's priority queue every poll.
        const previousHostiles = this.gameState.nearbyHostiles || 0;
        const reportedHostiles = Number.isFinite(data.count) ? data.count : 0;
        const repeatedHostileAlert = event === 'hostiles_nearby' &&
            previousHostiles > 0 && reportedHostiles > 0 &&
            reportedHostiles < previousHostiles + 3;

        switch (event) {
            case 'damage_taken':
                if (typeof data.health === 'number') this.gameState.health = data.health;
                // standing still while something chews on her is the worst
                // possible response - _autonomousTick reads this to cut a parked
                // persistent goal (idle/follow/explore) short.
                this._lastDamageAt = Date.now();
                break;
            case 'position_update':
                if (data.position) this.gameState.position = data.position;
                break;
            case 'inventory_change':
                if (data.inventory) this.gameState.inventory = data.inventory;
                break;
            case 'dimension_changed':
                if (data.dimension) this.gameState.dimension = data.dimension;
                if (data.position) this.gameState.position = data.position;
                break;
            case 'weather_changed':
                if (data.weather) this.gameState.weather = data.weather;
                // the reaction below decides whether to walk home, so it needs
                // "is it on ME" before the next 2s state packet, not after.
                if (typeof data.rainingHere === 'boolean') this.gameState.rainingHere = data.rainingHere;
                if (typeof data.skyVisible === 'boolean') this.gameState.skyVisible = data.skyVisible;
                break;
            case 'hostiles_nearby':
                if (typeof data.count === 'number') this.gameState.nearbyHostiles = data.count;
                if (Array.isArray(data.types)) this.gameState.nearbyHostileTypes = data.types;
                break;
            case 'block_broken':
                this.stats.blocksMined++;
                break;
            case 'item_collected':
                this.stats.itemsCollected++;
                break;
            case 'entity_killed':
                this.stats.mobsKilled++;
                break;
            case 'death':
                this.stats.deaths++;
                // remember where the body fell BEFORE health/position get reset.
                // this server runs a grave mod, so her stuff is still standing
                // there waiting to be picked up - she just never knew that.
                if (this.gameState.multiplayer === true) {
                    try {
                        this.memory.recordDeathSpot(
                            data.position || this.gameState.position,
                            this.gameState.dimension
                        );
                    } catch { /* best-effort */ }
                }
                this.gameState.health = 0;
                this.gameState.isInCombat = false;
                // The in-game task died with the player. Do not carry a stale
                // pending goal across respawn and block the recovery plan.
                this._failAllPending('died in minecraft');
                break;
            case 'respawn':
                this.gameState.health = 20;
                if (data.position) this.gameState.position = data.position;
                break;
            case 'time_update':
                if (data.timeOfDay) this.gameState.timeOfDay = data.timeOfDay;
                break;
            case 'low_hunger':
                if (typeof data.hunger === 'number') this.gameState.hunger = data.hunger;
                break;
            case 'manual_control':
                this.manualControl = data.on === true;
                this.recentEvents.record(this.manualControl
                    ? 'the operator took the keyboard (f1) - hands off the controls'
                    : 'got the controls back from the operator');
                if (this.manualControl) this._failAllPending('operator took manual control (f1)');
                break;
            case 'protection_denied': {
                const now = Date.now();
                this._protectionDenials = this._protectionDenials.filter((t) => now - t < 60000);
                this._protectionDenials.push(now);
                this.recentEvents.record('the server blocked me from touching a block here (claimed land)');
                // remember the GROUND on the very first denial, not just when it
                // escalates to a relocation: one refusal is already proof this cell
                // belongs to somebody, and the spot picker needs that to stop
                // choosing it again on the way back through.
                this._recordClaimHere(this.gameState.position);
                if (this._protectionDenials.length === 1) {
                    this.memory.record('blocked', 'server protection blocked interaction here - claimed land', {
                        position: this.gameState.position, dimension: this.gameState.dimension,
                        details: String(data.text || '').slice(0, 120)
                    });
                }
                // one denial can be a stray click; two in a minute mid-goal means
                // the goal is grinding someone's claim - bail and put distance down
                if (this._protectionDenials.length >= 2 && (this.activeGoal || this.currentAction)) {
                    this._escapeProtectedArea();
                }
                break;
            }
        }
        // These events are direct client-thread observations too. If the bulk
        // state packet is delayed, an actual hit/air/hunger update should still
        // be fresh enough to authorize the corresponding survival response.
        if ([
            'damage_taken', 'position_update', 'inventory_change', 'dimension_changed',
            'weather_changed', 'hostiles_nearby', 'death', 'respawn', 'time_update',
            'low_hunger', 'creeper_spotted'
        ].includes(event)) {
            this.lastGameStateAt = Date.now();
        }

        if (repeatedHostileAlert) {
            // The repeated poll is still useful objective state, but must not
            // repeatedly spike fear as if a brand-new ambush happened.
            this._observeMinecraftState();
            return;
        }
        this._applyMinecraftEvent(event, data);
        this.emit('gameEvent', event, data);

        // track notable events for the "recently" line, then let the personality react
        this._recordGameEvent(event, data);
        this._react(event, data);

        // Do not wait for the 25-second autonomous tick when a hit leaves us
        // genuinely vulnerable. This is a gameplay response, not narration:
        // the spoken reaction can wait its turn, but survival should not.
        if (event === 'damage_taken' && this.enabled && this.autonomous &&
            Number.isFinite(data.health) && data.health > 0 && data.health <= 8) {
            const safety = this._urgentSafetyBehavior();
            if (safety) this._requestSafetyIntervention(safety.action, safety.params, safety.say);
        }
    }

    // record a completed action as a short past-tense "recently" entry
    _recordCompletion(action, params) {
        const label = mcCompletionLabel(action, params || {});
        if (label) { this.recentEvents.record(label); this._lastCompletionAt = Date.now(); }
        this._recordObsessionCompletion(action, params || {});
    }

    // the obsession's ledger. a placed oven joins the named collection (this is
    // the minecraft version of her antique toasters - units with names, not a
    // block count), and a baked loaf goes on the lifetime tally. both are
    // durable, so the collection and the loaf count survive a restart.
    _recordObsessionCompletion(action, params) {
        const target = String(params.target || '').toLowerCase().replace(/^minecraft:/, '');
        try {
            const furnishing = action === 'place' || action === 'install_appliance';
            if (furnishing && (OVEN_KINDS.includes(target) || target === 'chest' || target === 'crafting_table')) {
                // the companion cannot tell us "cancelled" - UserTaskChain.cancel runs
                // the same onFinish path as a real completion, so an F1 takeover or a
                // stop mid-place arrives here as a SUCCESS. minting an oven from that
                // invents a furnace that does not exist, and phantom furnaces are
                // expensive: the count drives furnaceTarget, which regrows the shell and
                // wipes the survey, so she rebuilds forever for appliances she never
                // placed. when we know a cancellation was in flight, believe that instead.
                if (this.manualControl || this._stopInFlight) {
                    this.log('debug', `not recording ${target} - the place was cancelled, not completed`);
                    return;
                }
                // a finished place is a real new unit, so never merge it into a
                // neighbour just because she didn't move between installs
                const exactPosition = [params.x, params.y, params.z].every(Number.isFinite)
                    ? { x: params.x, y: params.y, z: params.z }
                    : this.gameState.position;
                const settlement = params.settlementId
                    ? this.memory.getSettlement(params.settlementId)
                    : this.memory.listSettlements(this._worldId()).find((entry) => entry.contains(exactPosition, 3));
                // THE PLAN'S LEDGER: which block of the floorplan is now full,
                // whatever went into it. Only an exact-coordinate install counts
                // - a "place one somewhere" has no square to tick off, and
                // guessing one would retire a slot she never filled.
                if (settlement && action === 'install_appliance'
                    && [params.x, params.y, params.z].every(Number.isFinite)) {
                    this.memory.recordSettlementAppliance(settlement.id, target, exactPosition);
                }
                // a chest is furniture, not a unit in the collection - it gets a
                // block in the plan, never a name and a place in the tally.
                if (!OVEN_KINDS.includes(target)) return;
                const recorded = this.memory.recordOven(target, exactPosition, this.gameState.dimension, params.name || null, {
                    dedupe: false,
                    settlementId: settlement?.id || null
                });
                if (recorded?.isNew) {
                    const tally = this.memory.ovenTally();
                    this.recentEvents.record(`installed ${target.replace(/_/g, ' ')} "${recorded.entry.name}" (${tally.total} in the collection)`);
                    this._pushCommentary(`that one's "${recorded.entry.name}". ${tally.total} in the collection now`);
                    this.emit('gameEvent', 'oven_installed', { kind: target, name: recorded.entry.name, total: tally.total });
                }
                return;
            }
            if (target === 'bread' && (action === 'craft' || action === 'get')) {
                const made = Math.max(1, Number(params.amount) || 1);
                const total = this.memory.bumpTally('breadBaked', made);
                if (total) this.recentEvents.record(`baked bread (loaf #${total} all time)`);
            }
        } catch (err) {
            // the ledger is flavor, never a reason to drop a completion
            this.log('warn', `obsession ledger: ${err.message}`);
        }
    }

    // record a notable game event (death, pickups, combat, milestones)
    _recordGameEvent(event, data = {}) {
        let label = null;
        switch (event) {
            case 'death': label = 'died'; break;
            case 'respawn': label = 'respawned'; break;
            case 'damage_taken': label = 'took damage'; break;
            case 'item_collected': if (data.item) label = `picked up ${data.item}`; break;
            case 'entity_killed': label = data.type ? `killed a ${data.type}` : 'killed a mob'; break;
            case 'diamond_found': label = 'found diamonds!'; break;
            case 'creeper_spotted': label = 'dodged a creeper'; break;
            case 'achievement': label = data.name ? `unlocked ${data.name}` : 'got an achievement'; break;
            case 'nightfall': label = 'night fell'; break;
            case 'dimension_changed': label = data.dimension ? `entered ${data.dimension}` : 'changed dimension'; break;
            case 'weather_changed': label = data.weather ? `weather changed to ${data.weather}` : 'weather changed'; break;
            case 'hostiles_nearby': label = data.count ? `${data.count} hostiles nearby` : 'hostiles nearby'; break;
            case 'task_finished':
                // the command-completion path already logged this goal; only record
                // altoclef's own task-finished if it wasn't just captured
                if (Date.now() - this._lastCompletionAt > 3000) {
                    const t = String(data.task || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                    if (t) label = t;
                }
                break;
            default: return; // block_broken etc are too frequent to log
        }
        if (label) {
            this.recentEvents.record(label);
            this.memory.record('event', label, {
                position: data.position || this.gameState.position,
                dimension: this.gameState.dimension,
                details: data.name || data.item || data.type || data.task
            });
        }
        if (event === 'death' || event === 'respawn' || event === 'achievement' || event === 'diamond_found') {
            this.memory.recordLandmark(label || event, { position: data.position || this.gameState.position, dimension: this.gameState.dimension });
        }
        this._rememberMilestone(event, data, label);
    }

    // the handful of game events worth carrying between sessions. everything else she
    // does is already visible as live state; these are the ones a person would still
    // be telling you about tomorrow, so they are handed to YOUR long-term memory,
    // where your chat brain can retrieve them long after the journal ring has
    // rolled over. no sink injected -> these are simply not recorded; this library
    // owns no database of its own. see the `remember` constructor option.
    _rememberMilestone(event, data = {}, label = null) {
        if (typeof this.remember?.gameplay !== 'function') return;
        const p = this.gameState.position;
        const where = p && [p.x, p.z].every(Number.isFinite)
            ? ` at ${Math.round(p.x)},${Math.round(p.z)}` : '';
        const dim = this.gameState.dimension && this.gameState.dimension !== 'overworld'
            ? ` in the ${String(this.gameState.dimension).replace(/_/g, ' ')}` : '';
        const server = this.gameState.multiplayer === true && this.gameState.server
            ? ` on ${this.gameState.server}` : '';
        // the in-game username, so the stored line names whoever is actually
        // playing rather than a hardcoded character.
        const who = this.gameUsername || 'the bot';
        let line = null;
        if (event === 'death') {
            const cause = data.cause || data.killer || label || 'something';
            line = `${who} died in minecraft to ${cause}${where}${dim}${server}`;
        } else if (event === 'diamond_found') {
            line = `${who} found diamonds in minecraft${where}${dim}${server}`;
        } else if (event === 'achievement') {
            line = `${who} unlocked "${data.achievement || label}" in minecraft${server}`;
        }
        if (!line) return;
        try {
            this.remember.gameplay(line, { tags: [event, String(data.cause || data.killer || '')] });
        } catch { /* enhancement only */ }
    }

    // people are upserted, so this can run often - but a row rewrite per sighting is
    // pointless churn. anything SIGNIFICANT (they spoke, asked, or got bread) writes
    // immediately; a bare walk-past waits out the throttle.
    _bridgePlayerToMemory(name, { immediate = false } = {}) {
        if (typeof this.remember?.player !== 'function') return;
        const who = String(name || '').trim();
        if (!who) return;
        if (!this._rememberPlayerAt) this._rememberPlayerAt = new Map();
        const key = who.toLowerCase();
        const now = Date.now();
        if (!immediate && now - (this._rememberPlayerAt.get(key) || 0) < PLAYER_RAG_THROTTLE_MS) return;
        this._rememberPlayerAt.set(key, now);
        if (this._rememberPlayerAt.size > 128) {
            for (const [k, at] of this._rememberPlayerAt) {
                if (now - at > PLAYER_RAG_THROTTLE_MS * 4) this._rememberPlayerAt.delete(k);
            }
        }
        try {
            const player = this.memory.getPlayer(who);
            if (player) this.remember.player(player, this._worldId());
        } catch { /* enhancement only */ }
    }

    // point your long-term memory at the bot after construction. pass null to
    // unhook. shape: { player(playerRecord, worldId), gameplay(text, { tags }) }
    setRemember(sink) {
        this.remember = sink && typeof sink === 'object' ? sink : null;
        return this.remember;
    }

    // point internal commentary cues at your UI / overlay. pass null to unhook.
    setBroadcast(fn) {
        this.broadcast = typeof fn === 'function' ? fn : null;
        return this.broadcast;
    }

    // rename the bot at runtime (which names count as "addressed to her" in
    // multiplayer chat). same as the `names` constructor option.
    setBotNames(names) {
        return setBotNames(names);
    }

    // ---- outbound --------------------------------------------------------

    send(message) {
        if (!this.connected || !this.client || this.client.readyState !== 1) {
            return false;
        }
        try {
            this.client.send(JSON.stringify(message));
            return true;
        } catch (err) {
            this.log('error', 'failed to send to bridge', err.message);
            return false;
        }
    }

    generateId() {
        return `mc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    // ---- gates -----------------------------------------------------------

    enable() {
        this.enabled = true;
        this.send({ type: 'config', enabled: true });
        this.emit('enabled');
        return this.enabled;
    }

    disable({ stopWork = true } = {}) {
        // "Disabled" must describe the real bot, not only this process's UI
        // gate. Halt live work before hiding the controls; otherwise AltoClef
        // can keep mining/fighting indefinitely while Burnt reports it is off.
        const hasLiveWork = this.connected && this.gameConnected &&
            (this.currentAction || this.currentTask || this.activeGoal ||
                [...this.pendingActions.values()].some((p) => !NON_TASK_ACTIONS.has(p.action)));
        if (stopWork && hasLiveWork && this.currentAction !== 'stop') {
            this.executeAction('stop', {}, {
                priority: 'urgent',
                source: 'disable',
                waitForCompletion: false,
                timeoutMs: 30000
            }).catch((err) => this.log('warn', `disable stop failed: ${err.message}`));
        }
        this.enabled = false;
        this.autonomous = false;
        this.gamerMode = false;
        // a hard off cancels the gamer-mode loan too - nothing to hand back
        this._autonomyDisarmedByGamer = false;
        this.send({ type: 'config', enabled: false, autonomous: false });
        this.emit('disabled');
        return this.enabled;
    }

    setAutonomousMode(on) {
        this.autonomous = !!on;
        // an explicit set is the new truth: it cancels any pending "gamer mode
        // borrowed the bot and owes it back" restore. this is what keeps the ■
        // stop button (modes.js gameControl('stop') -> setAutonomousMode(false))
        // from being undone a moment later when the speedrun's terminal packet
        // lands and gamer mode exits.
        this._autonomyDisarmedByGamer = false;
        this.send({ type: 'config', autonomous: this.autonomous });
        this.log('info', `autonomous mode ${this.autonomous ? 'on' : 'off'}`);
        return this.autonomous;
    }

    setMood(mood) {
        if (typeof mood === 'string' && mood.trim()) {
            const normalized = mood.trim().toLowerCase();
            this.mood = MINECRAFT_MOOD_MAP[normalized] || normalized;
        }
        return this.mood;
    }

    _setMinecraftState(next, { emit = true } = {}) {
        if (!next || typeof next !== 'object') return this.minecraftState;
        const previous = this.minecraftState || {};
        this.minecraftState = { ...next };
        const materialChange = previous.label !== next.label ||
            ['confidence', 'fear', 'security', 'fun'].some((key) =>
                Math.abs((Number(next[key]) || 0) - (Number(previous[key]) || 0)) >= 5);
        if (emit && materialChange) {
            this.emit('affectUpdate', { ...this.minecraftState });
        }
        return this.minecraftState;
    }

    _observeMinecraftState({ emit = true } = {}) {
        return this._setMinecraftState(this.affect.observe(this.gameState), { emit });
    }

    _applyMinecraftEvent(event, data = {}) {
        return this._setMinecraftState(this.affect.applyEvent(event, data, this.gameState));
    }

    _applyMinecraftOutcome(success, action) {
        return this._setMinecraftState(this.affect.applyOutcome(success, action, this.gameState));
    }

    // ---- gamer mode ------------------------------------------------------
    // engage the built-in @gamer speedrun as a committed, narrated activity.
    // enables the tool if needed, turns idle self-play OFF (so nothing competes
    // for altoclef's single task runner), flips gamerMode on (so the live
    // speedrun phase gets narrated), then dispatches the run. resolves once the
    // game accepts it - the speedrun then tracks + narrates its phases in the
    // background. no-op-friendly: if a speedrun is already live it just marks the
    // mode instead of tripping the busy guard with a second dispatch.
    startGamerMode() {
        if (this._gamerStartInFlight) return this._gamerStartInFlight;
        let tracked;
        tracked = this._startGamerModeOnce().finally(() => {
            if (this._gamerStartInFlight === tracked) this._gamerStartInFlight = null;
        });
        this._gamerStartInFlight = tracked;
        return tracked;
    }

    async _startGamerModeOnce() {
        if (!this.enabled) this.enable();
        if (this.currentAction === 'speedrun' || this.activeGoal?.action === 'speedrun') {
            this.gamerMode = true;
            return { started: true, alreadyRunning: true, task: 'speedrun (.gamer)' };
        }
        this.gamerMode = true;
        // the speedrun owns the bot while it runs, so idle play stands down - but
        // it is BORROWED, not surrendered. remember whether self-play was on so
        // _exitGamerMode can hand it back. (set after the call: setAutonomousMode
        // clears this flag by design.)
        const hadAutonomy = this.autonomous;
        this.setAutonomousMode(false);
        this._autonomyDisarmedByGamer = hadAutonomy;
        this._lastBotTaskPhase = '';
        try {
            const result = await this.executeAction('speedrun', {}, { source: 'gamer', waitForCompletion: false });
            this.emit('gamerMode', { on: true });
            return result;
        } catch (err) {
            // dispatch failed (offline / stale / busy) - don't leave the flag set,
            // and give self-play back: the run never started, so nothing borrowed it
            this._exitGamerMode();
            throw err;
        }
    }

    // the one way out of gamer mode. clears the flag and RETURNS self-play if
    // gamer mode is what took it away.
    //
    // this used to be three separate `this.gamerMode = false` sites that all left
    // `autonomous` off, and nothing anywhere turned it back on. so a single
    // .gamer speedrun permanently disarmed idle play: _autonomousTick returns at
    // `if (!this.autonomous) return;` before the homestead arc, the bread run and
    // the whole idle menu, and she just stood there for the rest of the session
    // waiting for a human to type "autonomous on". observed 2026-08-05: gamer at
    // 02:56 -> `autonomous mode off` -> never re-armed -> idle all night.
    _exitGamerMode() {
        this.gamerMode = false;
        this._lastBotTaskPhase = '';
        if (this._autonomyDisarmedByGamer) {
            // setAutonomousMode clears the flag itself
            this.setAutonomousMode(true);
            this.log('info', 'gamer mode ended - self-play handed back');
        }
    }

    // a speedrun has more than one way to die and only ONE of them was a terminal
    // response packet. the live case was a preemption: an agent goal dispatches a
    // stop, and the stop path cancels every other pending record locally
    // (_dispatchAction's `action === 'stop'` branch) - the speedrun just vanishes
    // from pendingActions without ever reaching the terminal handler. it can also
    // time out (_expirePendingAction) or go down with the socket (_failAllPending).
    // route all of them through here so gamer mode cannot survive its own run.
    _noteTaskEnded(action) {
        if (action === 'speedrun' && this.gamerMode) this._exitGamerMode();
    }

    // leave gamer mode: stop the speedrun and clear the flag.
    stopGamerMode() {
        this._exitGamerMode();
        this.emit('gamerMode', { on: false });
        return this.executeAction('stop', {}, { priority: 'urgent', source: 'gamer', waitForCompletion: false });
    }

    // ---- status ----------------------------------------------------------

    getStatus() {
        // Keep slow emotional recovery current even when a caller polls status
        // between telemetry packets. Do not emit from a read-only status call.
        if (this.gameConnected && this.lastGameStateAt) this._observeMinecraftState({ emit: false });
        return {
            connected: this.connected,
            gameConnected: this.gameConnected,
            companionSocketConnected: this.companionSocketConnected,
            gameUsername: this.gameUsername,
            enabled: this.enabled,
            autonomous: this.autonomous,
            gamerMode: this.gamerMode,
            mood: this.mood,
            minecraftState: { ...this.minecraftState },
            gameState: this.gameState,
            stateAgeMs: this.lastGameStateAt ? Math.max(0, Date.now() - this.lastGameStateAt) : null,
            fault: this.fault ? { ...this.fault } : null,
            currentTask: this.currentTask,
            currentAction: this.currentAction,
            // live "what am i actually doing" readout from the in-game task chain:
            // botTask = high-level goal + phase, botAction = concrete micro-action
            botTask: this._cleanPhase(this.gameState.botTask),
            botAction: this._cleanPhase(this.gameState.botAction),
            activeGoal: this.activeGoal ? {
                action: this.activeGoal.action,
                target: this.activeGoal.params?.target || null,
                source: this.activeGoal.source,
                runningForMs: Date.now() - this.activeGoal.startedAt,
                lastProgressAgeMs: Date.now() - this.activeGoal.lastProgressAt,
                confinedMs: this.activeGoal.anchorAt ? Date.now() - this.activeGoal.anchorAt : 0,
                percent: this.activeGoal.action === 'build_settlement'
                    ? (Number(this.gameState.settlementBuild?.percent) || 0) : null,
                phase: this.activeGoal.action === 'build_settlement'
                    ? (this.gameState.settlementBuild?.phase || null) : null
            } : null,
            queued: this.pendingActions.size,
            stats: { ...this.stats },
            recent: this.recentEvents.summary(),
            capabilities: this.capabilities,
            viewerSuggestions: this.getViewerSuggestions(),
            memory: this.memory.context(),
            // multiplayer truth (companion-reported) + her saved places
            manualControl: this.manualControl,
            multiplayer: this.gameState.multiplayer === true,
            server: this.gameState.server || null,
            nearbyPlayerNames: Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames.slice(0, 8) : [],
            favorites: this.memory.favoritesContext(this.gameState.position, this.gameState.dimension),
            home: this._home()?.name || null,
            homeSpec: this._home() ? this.homeSpecLine() : null,
            homeProject: this._home() ? this._publicHomeProject() : null,
            settlements: this.memory.listSettlements(this._worldId()).map((entry) => entry.toJSON()),
            outposts: this.memory.listOutposts(this._worldId()).map((entry) => ({
                ...entry.toJSON(), blueprint: toasterBlueprint(entry)
            })),
            deathSpot: this.memory.getDeathSpot(),
            knownPlayers: this.knownPlayers(12),
            // knownPlayers above is a RAM roster of who has spoken recently. this is the
            // durable half: people she actually knows, with what they said, what they
            // asked for, and whether she ever did it - across restarts.
            people: this.memory.playersContext(
                Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames : [],
                6, this._worldId()
            ),
            chatRoom: this.chatRoom(),
            wheatSpots: this.memory.wheatSpotsContext(this.gameState.position),
            // the obsession, as live state she can actually speak from: the named
            // oven collection, the fuel bin, the pantry, and whether there's a
            // fire burning within sight of her right now.
            ovens: {
                list: this.memory.ovensContext(this.gameState.position, this.gameState.dimension),
                tally: this.memory.ovenTally(),
                fuel: this._fuelCount(),
                bread: this._breadCount(),
                wheat: this._wheatCount(),
                torches: this._inventoryCount('torch'),
                hasFlintSteel: /flint_and_steel/.test(this._carrying()),
                fireNearby: (this.gameState.nearby?.campfire ?? null) !== null || (this.gameState.nearby?.lava ?? null) !== null,
                lifetime: this.memory.getTally()
            }
        };
    }

    // ---- action dispatch -------------------------------------------------

    // send an action to the bridge and resolve when the bot reports it done.
    // execute_minecraft() guards connected/enabled before calling, but we
    // re-check defensively so no caller can hang on a dead socket.
    // AltoClef owns ONE task runner, so a second goal silently replaces the first -
    // that is what the busy guard in _dispatchAction exists to prevent. but it had no
    // notion of WHO was asking, so her own brain calling the minecraft tool got
    // "minecraft is busy with move home (home)" and she stood there for a minute
    // unable to change her own mind. a deliberate decision must be able to interrupt
    // idle work; idle picks still must not stomp each other.
    async executeAction(action, params = {}, opts = {}) {
        try {
            const act = String(action || '').trim().toLowerCase();
            if (act === 'stop') return await this._runStopTransition(opts);
            if (act && !NON_TASK_ACTIONS.has(act) && this._stopInFlight) {
                await this._stopInFlight;
            }
            // BEFORE ANYTHING ELSE: is she standing in the server's spawn region?
            // Then nothing she picked for herself may touch the world here. This
            // sits at the top of the ONE door every action goes through, so it
            // holds for her brain's tool calls as well as the idle menu - the
            // menu-level gate alone left "collect oak_log" a live option.
            const refusal = this._spawnRegionRefusal(act, opts.source, params);
            if (refusal) {
                this.log('info', `refused ${act} inside the spawn region`);
                throw new Error(refusal);
            }
            const preemption = this._preemptIfWarranted(action, opts);
            if (preemption) await preemption;
            return await this._dispatchAction(action, params, opts);
        } catch (err) {
            // SURFACE EVERY FAILURE, not just the ones the game reports back.
            // failures raised HERE - "minecraft is busy with X", a missing required
            // param, no armour to put on, an unsupported action - rejected straight
            // out of _dispatchAction and never emitted actionFailed, so they only
            // ever reached a console.error. the operator could not tell a broken bot from an
            // idle one. the companion-reported path already emits (and marks the
            // error), so this only covers the gap and never double-reports.
            if (err && !err._reported) {
                err._reported = true;
                const stopped = /^task stopped$/i.test(String(err.message || '').trim());
                if (!stopped) {
                    this.emit('actionFailed', {
                        id: null, action, params, error: err.message || 'action failed', local: true
                    });
                }
            }
            throw err;
        }
    }

    _runStopTransition(opts = {}) {
        if (this._stopInFlight) return this._stopInFlight;
        // Cancellation is a barrier: an executing ACK only says the command was
        // accepted, not that the old AltoClef tree is gone. Always wait for the
        // terminal stop response before releasing a replacement task.
        const stop = this._dispatchAction('stop', {}, { ...opts, waitForCompletion: true });
        let tracked;
        tracked = stop.finally(() => {
            if (this._stopInFlight === tracked) this._stopInFlight = null;
        });
        this._stopInFlight = tracked;
        return tracked;
    }

    _preemptIfWarranted(action, opts = {}) {
        const act = String(action || '').trim().toLowerCase();
        if (!act || NON_TASK_ACTIONS.has(act)) return;      // chat/stop/hud never queue
        const source = opts.source || 'agent';
        if (!PREEMPTING_SOURCES.has(source)) return;        // the idle menu waits its turn
        const inFlight = [...this.pendingActions.values()].filter((p) => !NON_TASK_ACTIONS.has(p.action));
        const active = this.activeGoal;
        const hasTaskState = inFlight.length > 0 || !!active ||
            (!!this.currentAction && !NON_TASK_ACTIONS.has(this.currentAction)) || !!this.currentTask;
        if (!hasTaskState) return;
        // her own brain may replace anything, including its own earlier goal - changing
        // your mind is not a conflict. The gamer button is an operator mode switch,
        // so it has the same authority. A person in chat may only replace idle work,
        // so one viewer cannot cancel an operator's instruction.
        const unconditional = ['agent', 'operator', 'mode-switch', 'gamer'].includes(source);
        const owners = [
            ...inFlight.map((pending) => pending.source),
            active?.source
        ].filter(Boolean);
        if (!unconditional && (!owners.length || !owners.every((owner) => REPLACEABLE_SOURCES.has(owner)))) return;
        this.log('info', `preempting "${this.currentTask || active?.action || inFlight[0]?.action || 'current minecraft task'}" for ${act} (${source})`);
        return this._runStopTransition({
            priority: 'urgent', source: 'preempt', timeoutMs: 30000
        });
    }

    _dispatchAction(action, params = {}, opts = {}) {
        return new Promise((resolve, reject) => {
            if (typeof action !== 'string' || !action.trim()) {
                reject(new Error('minecraft action must be a non-empty string'));
                return;
            }
            action = action.trim().toLowerCase();
            if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

            // "put your armor on" names no item, and altoclef's @equip needs one - so
            // the bridge translated a target-less equip to null and answered "no
            // built-in task for equip", i.e. she stood there while chat watched. an
            // instruction to gear up is about the SLOTS, not a named item: resolve it
            // from what she is actually carrying. also covers the llm asking for the
            // generic "armor", which is not an item id either.
            if (action === 'equip') {
                const named = String(params.target || '').trim().toLowerCase();
                const generic = !named || GENERIC_ARMOR_WORDS.has(named.replace(/\s+/g, '_'));
                if (generic && !Array.isArray(params.items)) {
                    const picks = this._allArmorToWear();
                    // the bridge's _itemList wants {item} OBJECTS (it is the same
                    // ItemList syntax `deposit` uses) - a bare string array is silently
                    // filtered to empty and falls through to the null/"no such task" path.
                    if (picks.length) params = { ...params, target: undefined, items: picks.map((p) => ({ item: p.item })) };
                    else {
                        reject(new Error(this._armorRefusalReason()));
                        return;
                    }
                }
            }

            // favorite-spot navigation: 'go_home' and 'move' with a saved-spot
            // name both resolve to real coordinates here, so every caller (llm
            // tool, autonomy tick, chat suggestion) can use her remembered places.
            // a place she deliberately SAVED is exempt from the no-water rule
            // below: terrain cells are 64 blocks wide, so one swim past a coastal
            // home is enough to mark the cell she lives in as ocean.
            let savedPlace = false;
            // 'go_home' becomes a plain 'move' a few lines down, and every watchdog
            // downstream then blacklists 'move'. keeping the ASKED-FOR verb means the
            // two-minute "don't re-pick what just died" suppression finally covers the
            // home route, which was the single loudest reason she could re-issue a
            // doomed walk home every four minutes forever.
            const requestedAction = action;
            let homeDeparture = null;
            // claiming a home never reaches the game - it is a memory write. handled
            // here rather than only in tools.js so EVERY caller can do it: her own
            // brain, the autonomy tick, and a person in chat saying "make this home".
            if (action === 'set_home') {
                try {
                    const entry = this.setHome(String(params.target || params.name || 'home'), params.note || null);
                    resolve({ status: 'success', result: { home: entry.name, position: entry.position } });
                } catch (err) {
                    reject(err);
                }
                return;
            }
            if (action === 'set_outpost') {
                try {
                    const entry = this.setOutpostHere(String(params.target || params.name || 'toaster outpost'), params.level || 1);
                    resolve({ status: 'success', result: { outpost: entry.toJSON() } });
                } catch (err) {
                    reject(err);
                }
                return;
            }
            if (action === 'outposts') {
                resolve({
                    status: 'success',
                    result: this.memory.listOutposts(this._worldId()).map((entry) => entry.toJSON())
                });
                return;
            }
            if (action === 'go_outpost') {
                const outpost = this._findOutpost(params.target || params.name);
                if (!outpost) {
                    reject(new Error('no matching toaster outpost is saved'));
                    return;
                }
                action = 'move';
                params = {
                    ...params, x: outpost.anchor.x, y: outpost.anchor.y, z: outpost.anchor.z,
                    dimension: this._dimForMove(outpost.dimension), target: `outpost (${outpost.name})`
                };
                savedPlace = true;
            }
            if (action === 'build_outpost') {
                const outpost = this._findOutpost(params.target || params.name);
                if (!outpost) {
                    reject(new Error('no matching toaster outpost is saved'));
                    return;
                }
                action = 'build_settlement';
                params = {
                    ...params, role: 'outpost', settlementId: outpost.id,
                    x: outpost.anchor.x, y: outpost.anchor.y, z: outpost.anchor.z,
                    width: outpost.width, depth: outpost.depth, height: outpost.height,
                    target: outpost.name
                };
            }
            if (action === 'build_settlement') {
                try {
                    params = this._canonicalSettlementBuildParams(params);
                } catch (err) {
                    reject(err);
                    return;
                }
            }
            if (action === 'go_home') {
                const home = this.memory.getHome(this._worldId());
                if (!home) {
                    reject(new Error('no home set yet - stand somewhere good and use set_home first'));
                    return;
                }
                // the old house has already been judged unreachable and she is out
                // looking for ground to rebuild on. every source is refused here on
                // purpose - her own brain and chat included - because the loop was
                // re-armed just as happily by an LLM go_home as by the homestead arc.
                if (this._homeRelocation) {
                    reject(new Error(`${home.name} can't be walked to from here - i've been trying all day. i'm claiming new ground nearby and rebuilding instead`));
                    return;
                }
                action = 'move';
                params = {
                    ...params,
                    x: home.position.x, y: home.position.y, z: home.position.z,
                    dimension: this._dimForMove(home.dimension),
                    target: `home (${home.name})`
                };
                savedPlace = true;
                homeDeparture = home;
            } else if (action === 'move' && params.x === undefined && String(params.target || '').trim()) {
                const fav = this.memory.getFavorite(params.target);
                if (fav) {
                    params = {
                        ...params,
                        x: fav.position.x, y: fav.position.y, z: fav.position.z,
                        dimension: this._dimForMove(fav.dimension),
                        target: fav.name
                    };
                    savedPlace = true;
                }
            }

            // A MOVE WITH NOWHERE TO GO.
            //
            // The bridge answers this with `"move" is missing something it needs -
            // check its parameters`, which names neither the parameter nor the fix.
            // So her brain cannot correct it: on 2026-08-05 a player asked her a
            // question in game chat, she answered by trying to walk to a place that
            // does not exist, got that sentence back, retried the identical empty
            // call 37 seconds later, and never said one word to the person who
            // asked. Two turns spent on an error message that could not teach her
            // anything.
            //
            // Fail with the specific thing that is wrong AND what she already
            // knows, so the next turn can be an answer rather than a repeat.
            if (action === 'move' && !savedPlace && params.x === undefined) {
                const named = String(params.target || '').trim();
                let spots = [];
                try { spots = (this.memory.listFavorites() || []).map((f) => f.name).filter(Boolean); } catch { /* best-effort */ }
                const knows = spots.length
                    ? `places i've saved: ${spots.slice(0, 8).join(', ')}`
                    : `i haven't saved any places yet - use set_home or favorite to name one`;
                // THE SECOND ONE IS NOT A SYNTAX PROBLEM.
                //
                // Naming the missing field was supposed to be the fix, and it wasn't:
                // on 2026-08-05 she called an empty `move` twice per turn, four times
                // across the two turns a player spent waiting on an answer. The first
                // message teaches the syntax; if she is straight back with the same
                // empty call then syntax was never what was wrong - she has nowhere to
                // go and is reaching for the tool anyway. So the list of saved places
                // is dropped from the repeat: a menu reads as an invitation to pick one
                // and call move again, and every one of those costs a whole llm round
                // trip while somebody in the room is waiting. Say so, and point her at
                // the thing she actually owes.
                const nowhereAt = Date.now();
                const repeated = nowhereAt - this._lastNowhereMoveAt < NOWHERE_MOVE_REPEAT_MS;
                this._lastNowhereMoveAt = nowhereAt;
                if (repeated) {
                    reject(new Error('i just tried that exact move and it went nowhere - it is not a syntax slip, i have no destination. stop reaching for move; if someone is waiting on me, answer them with chat instead.'));
                    return;
                }
                reject(new Error(named
                    ? `i've never saved anywhere called "${named}", so i can't walk to it. ${knows}. for somewhere unsaved give me x and z instead.`
                    : `move needs somewhere to go - x and z, or the name of a place i've saved. ${knows}.`));
                return;
            }

            // open water is not a destination. a goto whose target sits in a cell
            // she has personally been wet in is refused before it ever reaches
            // baritone - whoever asked, her own brain included. the escape swim is
            // the one exemption: that goal exists to get her OUT.
            if (action === 'move' && !savedPlace && opts.source !== 'water-escape' && this._destinationIsWet(params)) {
                reject(new Error('that spot is open water and i have a strict no-swimming policy. pick land'));
                return;
            }

            // her words have two legal homes - params.message and params.target -
            // and only target was ever read downstream. answering somebody she put
            // THEIR NAME in target and the sentence in message, so the server
            // watched her post a bare "MarDotIO" eight times in six minutes while
            // every real line was dropped on the floor. the sentence wins whenever
            // there is one, and a line that is only a username is an address, not
            // an answer. enforced HERE so her autonomy and a viewer command get the
            // same guarantee the llm tool call does.
            if (action === 'chat') {
                const spoken = String(params.message || '').trim() || String(params.target || '').trim();
                if (!spoken) {
                    reject(new Error('that chat line came through empty - the words go in message'));
                    return;
                }
                const named = this._bareRosterName(spoken);
                if (named) {
                    reject(new Error(`"${spoken}" is only ${named}'s name, so nothing went out - the words i say to them go in message`));
                    return;
                }
                params = { ...params, target: spoken, message: spoken };
            }

            // outgoing chat pacing: talk like a person, never spam the server.
            // Only a message actually handed to the bridge consumes the budget.
            let chatSendAt = null;
            if (action === 'chat') {
                const nowChat = Date.now();
                this._chatSendTimes = this._chatSendTimes.filter((t) => nowChat - t < 60000);
                const lastSend = this._chatSendTimes[this._chatSendTimes.length - 1] || 0;
                if (this._chatSendTimes.length >= CHAT_OUT_PER_MIN) {
                    reject(new Error('easing off server chat for a few seconds so it doesn\'t read as spam'));
                    return;
                }
                // a line two seconds late is still an answer; a dropped one is
                // silence, and the person who asked reads it as being ignored.
                // only the per-minute cap refuses outright now - the 3s gap waits
                // its turn instead, bounded to a single hop so a burst can't push
                // her reply back forever.
                const waitMs = CHAT_OUT_MIN_GAP_MS - (nowChat - lastSend);
                if (waitMs > 0) {
                    if (opts._chatGapWaited) {
                        reject(new Error('easing off server chat for a few seconds so it doesn\'t read as spam'));
                        return;
                    }
                    setTimeout(() => {
                        this._dispatchAction(action, params, { ...opts, _chatGapWaited: true })
                            .then(resolve, reject);
                    }, waitMs + 25);
                    return;
                }
                chatSendAt = nowChat;
            }

            // f1 manual control: the human owns the keyboard - bot goals are
            // refused (the companion enforces this too); chat/status still work
            if (this.manualControl && !NON_TASK_ACTIONS.has(action)) {
                reject(new Error('manual control is on (f1) - the operator has the keyboard right now'));
                return;
            }

            if (!this.connected) {
                reject(new Error('minecraft bot not connected'));
                return;
            }

            if (!SAFETY_ACTIONS.has(action) && this._stateIsStale()) {
                reject(new Error('minecraft telemetry is stale; wait for a fresh world-state update before sending a new goal'));
                return;
            }
            if (!this.gameConnected) {
                reject(new Error('minecraft companion not connected (launch Fabric/AltoClef and join a world first)'));
                return;
            }

            // AltoClef owns a single task runner. Concurrent goal commands can
            // silently replace each other, which looks like Burnt ignored chat.
            // Chat and stop remain responsive while a goal is running.
            const isTaskAction = !NON_TASK_ACTIONS.has(action);
            const hasPendingTask = [...this.pendingActions.values()]
                .some((pendingAction) => !NON_TASK_ACTIONS.has(pendingAction.action));
            const hasLiveTask = hasPendingTask || !!this.activeGoal ||
                (!!this.currentAction && !NON_TASK_ACTIONS.has(this.currentAction)) || !!this.currentTask;
            if (isTaskAction && hasLiveTask) {
                reject(new Error(`minecraft is busy with ${this.currentTask || this.currentAction || 'another task'}`));
                return;
            }

            const target = params.target || '';
            if (isTaskAction && !SAFETY_ACTIONS.has(action) &&
                this.memory.failureCount(action, target, LOOP_FAILURE_WINDOW_MS) >= LOOP_FAILURE_LIMIT) {
                reject(new Error(`goal "${this._describeTask(action, params)}" is paused after repeated failures; inspect the fresh state and choose a different recovery step`));
                return;
            }

            const id = this.generateId();
            const priority = opts.priority || 'normal';
            const waitForCompletion = opts.waitForCompletion !== false;
            // Accepted long-running goals return control to Burnt immediately,
            // but remain tracked for completion/recent-event reporting.
            const timeoutMs = opts.timeoutMs || (waitForCompletion
                ? this.config.actionTimeout
                : 4 * 60 * 60 * 1000);
            // the 'executing' ack only means the companion accepted the command
            // and should land within seconds. arm a short pre-ack timer so a
            // frozen client can't hold an awaited call (or a mode transition)
            // hostage for the full completion window - _handleResponse re-arms
            // the real window when the ack arrives.
            const ackTimeoutMs = Math.min(timeoutMs, 30000);

            const timer = setTimeout(() => {
                this._expirePendingAction(
                    id,
                    pending,
                    `no ack from the game in ${Math.round(ackTimeoutMs / 1000)}s for ${action} - is the minecraft client responding?`
                );
            }, ackTimeoutMs);

            const pending = {
                resolve,
                reject,
                timer,
                action,
                requestedAction,
                params,
                waitForCompletion,
                timeoutMs,
                source: opts.source || 'agent',
                why: opts.why || null,
                requestedBy: opts.requestedBy || null,
                settled: false
            };
            this.pendingActions.set(id, pending);

            const ok = this.send({ type: 'action', action, params, id, priority });
            if (!ok) {
                clearTimeout(timer);
                this.pendingActions.delete(id);
                reject(new Error('failed to send action to bridge'));
                return;
            }
            // one real departure for home, counted against the persisted campaign.
            // deliberately after the dispatch succeeds - a walk the bridge never
            // carried is a dead socket, not evidence about the route - and measured
            // as she sets out, so bestDistance can only improve from an approach she
            // actually made.
            if (homeDeparture) {
                try {
                    this.memory.noteHomeDeparture(this._worldId(), homeDeparture.name, this._homeDistance());
                } catch { /* memory is an enhancement, never a reason to stop playing */ }
            }
            if (chatSendAt !== null) {
                this._chatSendTimes.push(chatSendAt);
                // she answered the room: whoever was waiting on her is now in an
                // open exchange, so their follow-up reaches her without her name.
                this._openChatExchange();
                // her line is really on its way to the server. burnt.js listens so
                // its spoken-reply mirror knows the answer already landed and stays
                // out of the way (see the in-game reply mirror there).
                this.emit('chatSent', { text: String(params.message || params.target || '') });
            }

            // Only a task owns the singular action/task slots. Chat, look and
            // boat controls may run while a mine/path is active and must not
            // erase that goal when their instant response arrives.
            if (isTaskAction) {
                this.currentAction = action;
                this.currentActionId = id;
                this.currentTask = this._describeTask(action, params);
                // altoclef runs a single task at a time, so a new task action
                // supersedes whatever persistent goal (follow/idle/explore) was
                // still tracked. drop a now-defunct activeGoal for a different
                // action so its watchdog line can't linger and so the next
                // autonomous goal can be tracked again (the !activeGoal guard).
                // the response handler re-establishes activeGoal if this new goal
                // is itself persistent or autonomous.
                if (isTaskAction && this.activeGoal && this.activeGoal.action !== action) {
                    this.activeGoal = null;
                }
            } else if (action === 'stop') {
                // A stop is the local cancellation boundary, not merely a
                // request whose old task remains "busy" until a second packet
                // comes back. If that terminal response is lost, a background
                // goal otherwise leaves a four-hour pending record that blocks
                // every replacement action even though the HUD was cleared.
                for (const [pendingId, oldPending] of this.pendingActions) {
                    if (pendingId === id || NON_TASK_ACTIONS.has(oldPending.action)) continue;
                    clearTimeout(oldPending.timer);
                    this.pendingActions.delete(pendingId);
                    if (!oldPending.settled) {
                        oldPending.settled = true;
                        oldPending.reject(new Error('task stopped'));
                    }
                    this._noteTaskEnded(oldPending.action);
                    this.emit('actionStopped', {
                        id: pendingId,
                        action: oldPending.action,
                        params: oldPending.params
                    });
                }
                this.currentAction = null;
                this.currentActionId = null;
                this.currentTask = null;
                this.activeGoal = null;
            }
            this.emit('actionSent', { id, action, params, priority });
        });
    }

    _stateIsStale() {
        return !this.lastGameStateAt || Date.now() - this.lastGameStateAt > MAX_TELEMETRY_AGE_MS;
    }

    _point(position) {
        if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
        return { x: position.x, y: position.y, z: position.z };
    }

    _inventorySignature(inventory = this.gameState.inventory) {
        if (!Array.isArray(inventory)) return '';
        // The companion's inventory is already a compact, bounded summary.
        return inventory.map((item) => String(item)).join('\u001f');
    }

    _trackActiveGoal(pending, id) {
        if (this.activeGoal?.id === id) return this.activeGoal;
        const now = Date.now();
        const persistent = PERSISTENT_ACTIONS.has(pending.action);
        const watchdogExempt = WATCHDOG_EXEMPT_ACTIONS.has(pending.action);
        this.activeGoal = {
            id,
            action: pending.action,
            // the verb she asked for, before go_home/favorite rewriting flattened it
            // to 'move'. watchdogs suppress on this so a dead home route is actually
            // suppressed as a home route.
            requestedAction: pending.requestedAction || pending.action,
            params: pending.params || {},
            source: pending.source,
            why: pending.why || null,   // her stated reason, for the in-game hud
            persistent,
            // Idle and follow may correctly stand still (idle by definition;
            // follow while already beside its player). Explore may not: it is a
            // movement promise, and leaving it watchdog-exempt recreates the
            // exact infinite-wander statue under a different label.
            watchdog: !watchdogExempt && (!persistent || pending.action === 'explore'),
            maxRuntimeMs: persistent
                ? null
                : (Object.prototype.hasOwnProperty.call(GOAL_MAX_RUNTIME_MS, pending.action)
                    ? GOAL_MAX_RUNTIME_MS[pending.action]
                    : DEFAULT_FINITE_GOAL_MAX_MS),
            startedAt: now,
            lastProgressAt: now,
            lastInventoryProgressAt: now,
            lastPosition: this._point(this.gameState.position),
            lastInventorySignature: this._inventorySignature(),
            // recently-visited inventory states, newest last. a signature we have
            // already seen in this goal is not new information - see the revisit
            // check in _observeGoalProgress.
            inventoryHistory: [],
            oscillationHits: 0,
            lastSettlementSignature: this._settlementProgressSignature(this.gameState.settlementBuild)
        };
        return this.activeGoal;
    }

    _observeGoalProgress(partial = {}) {
        if (!this.activeGoal) return;
        const now = Date.now();
        let progressed = false;
        // While she is actually laying blocks, the settlement survey is the only
        // thing that proves anything happened. Letting position or inventory
        // vouch for it is what made the 6-minute build budget unreachable - a
        // builder wedged for seven silent minutes still drifts a block and still
        // has its hotbar shuffled, and either one reset the clock.
        //
        // Gathering and crafting are the exception, and the phase is what tells
        // them apart: there the build task has handed off to a resource subtask
        // that legitimately spends minutes away from the site without touching a
        // single block of it, so inventory and movement are the real signal.
        const buildPhase = partial.settlementBuild?.phase
            || this.gameState.settlementBuild?.phase || null;
        const surveyOnly = this.activeGoal.action === 'build_settlement'
            && !BUILD_SUBTASK_PHASES.has(buildPhase);
        const point = this._point(this.gameState.position);
        const previous = this.activeGoal.lastPosition;
        let moved = false;
        if (point && (!previous || Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) >= 1)) {
            this.activeGoal.lastPosition = point;
            moved = true;
            if (!surveyOnly) progressed = true;
        }
        // Mining, crafting, and smelting can make real progress without moving
        // a full block. Treat a changed inventory snapshot as progress too, so
        // the stall watchdog does not cancel a productive stationary task.
        //
        // ...but "changed" is not "advanced". A CHANGING signature was enough to
        // hold the watchdog off forever, and AltoClef has a failure mode that
        // produces exactly that: a task tree that oscillates between two states
        // shuffles the inventory on every swing. Observed 2026-08-05 - crafting a
        // furnace wants a crafting_table item, crafting that wants 4 planks, the
        // planks need the 2x2 inventory grid, which forces the container shut and
        // interrupts the furnace task, which reopens it: ~1.4 full cycles/sec for
        // 3+ minutes (1203 task events), every cycle moving items between the grid
        // and the inventory. Position never changed, so the inventory vote was the
        // ONLY thing feeding lastProgressAt - and it never stopped voting.
        //
        // Real work is monotonic: logs -> planks -> table never revisits a state.
        // Churn returns to where it was. So a signature already seen during this
        // goal is not progress. Only applied while she is standing still; if she
        // is moving, position already vouches for her.
        if (Object.prototype.hasOwnProperty.call(partial, 'inventory')) {
            const inventorySignature = this._inventorySignature();
            if (inventorySignature !== this.activeGoal.lastInventorySignature) {
                this.activeGoal.lastInventorySignature = inventorySignature;
                const history = this.activeGoal.inventoryHistory || (this.activeGoal.inventoryHistory = []);
                const revisited = !moved && history.includes(inventorySignature);
                if (revisited) {
                    // oscillation: withhold the inventory vote so lastProgressAt can
                    // finally age out and the stall watchdog does its job.
                    this.activeGoal.oscillationHits = (this.activeGoal.oscillationHits || 0) + 1;
                    if (this.activeGoal.oscillationHits === INVENTORY_OSCILLATION_WARN_AT) {
                        this.log('warn', `inventory is oscillating, not advancing, during ${this.activeGoal.action} - not counting it as progress`);
                    }
                } else {
                    history.push(inventorySignature);
                    if (history.length > INVENTORY_HISTORY_MAX) history.splice(0, history.length - INVENTORY_HISTORY_MAX);
                    this.activeGoal.lastInventoryProgressAt = now;
                    if (!surveyOnly) progressed = true;
                }
            }
        }
        if (Object.prototype.hasOwnProperty.call(partial, 'settlementBuild')) {
            const settlementSignature = this._settlementProgressSignature(partial.settlementBuild);
            if (settlementSignature && settlementSignature !== this.activeGoal.lastSettlementSignature) {
                this.activeGoal.lastSettlementSignature = settlementSignature;
                progressed = true;
            }
        }
        if (progressed) this.activeGoal.lastProgressAt = now;
        if (!point) return;
        // confinement anchor for loop detection: horizontal-only, since walking in circles
        // keeps y ~flat. if she travels beyond the confine radius she genuinely relocated ->
        // re-anchor here and reset the clock; otherwise the anchor persists and orbiting one
        // spot accrues "confined" time even though lastProgressAt keeps refreshing.
        if (!this.activeGoal.anchorPosition) {
            this.activeGoal.anchorPosition = point;
            this.activeGoal.anchorAt = now;
        } else if (Math.hypot(point.x - this.activeGoal.anchorPosition.x, point.z - this.activeGoal.anchorPosition.z) > LOOP_CONFINE_RADIUS) {
            this.activeGoal.anchorPosition = point;
            this.activeGoal.anchorAt = now;
        }
    }

    // tool-level (deliberately NOT goal-scoped) anchor for the pinned check.
    // _observeGoalProgress's anchor hangs off activeGoal, re-anchors only past 24 blocks,
    // and does not exist at all when there is no watchdog'd goal - but being held in place
    // by mobs does not care whether she happens to own a goal at the time.
    // watch AltoClef climb its wander ladder under an active move. three escalations
    // (5 -> 10 -> 15) is not exploring, it is a goto that cannot land. abandon the
    // destination rather than let her pace around it until someone notices.
    _observeUnreachableTarget() {
        const goal = this.activeGoal;
        if (!goal || !goal.watchdog || WANDER_STORM_EXEMPT.has(goal.action)) {
            this._wanderLadder = 0;
            this._lastWanderRadius = 0;
            this._wanderGoalId = null;
            this._wanderEpisodes = [];
            this._wanderWasActive = false;
            return false;
        }
        if (this._wanderGoalId !== goal.id) {      // a new goal starts a fresh ladder
            this._wanderGoalId = goal.id;
            this._wanderLadder = 0;
            this._lastWanderRadius = 0;
            this._wanderEpisodes = [];
            this._wanderWasActive = false;
        }
        const now = Date.now();
        const raw = `${this.gameState.botTask || ''} ${this.gameState.botAction || ''}`;
        // Only FINITE radii count. "wander for infinity blocks" is
        // AbstractDoToClosestObjectTask searching for something it has not sighted
        // yet (ore, a mob, a chest) - that is the task working, not failing, and
        // counting it would abort every legitimate mining trip. The regex declines
        // to match "infinity" on its own, which is the behaviour we want.
        const found = raw.match(/wander for ([\d.]+) blocks/i);
        const radius = found ? Number(found[1]) : NaN;
        const wandering = Number.isFinite(radius);
        // An episode is a fresh unstuck attempt: either she re-entered a wander
        // after being out of one, or the radius grew inside a continuous wander.
        // The first covers the rebuilt-task-tree case (5, 5, 5, ...), the second
        // the surviving-instance case (5, 10, 15, ...). Both mean the same thing.
        const reentered = wandering && !this._wanderWasActive;
        const escalated = wandering && radius > (this._lastWanderRadius || 0);
        if (wandering) this._lastWanderRadius = radius;
        this._wanderWasActive = wandering;
        if (!wandering) return false;
        if (escalated) this._wanderLadder = (this._wanderLadder || 0) + 1;
        if (!reentered && !escalated) return false;

        const episodes = this._wanderEpisodes || (this._wanderEpisodes = []);
        episodes.push(now);
        while (episodes.length && now - episodes[0] > WANDER_STORM_WINDOW_MS) episodes.shift();
        const stormed = episodes.length >= WANDER_STORM_LIMIT;
        const laddered = this._wanderLadder >= WANDER_ESCALATION_LIMIT;
        if (!stormed && !laddered) return false;

        const where = goal.params || {};
        const label = this._describeTask(goal.action, where);
        const why = laddered
            ? `altoclef has escalated its wander to ${radius} blocks`
            : `altoclef has re-wandered ${episodes.length}x in ${Math.round(WANDER_STORM_WINDOW_MS / 1000)}s at ${radius} blocks`;
        this.log('warn', `unreachable: ${label} - ${why}, giving up on it`);
        try {
            this.memory.recordFailure(goal.action, where.target || null, 'could not be reached (altoclef wander ladder)');
        } catch { /* best-effort */ }
        // Only a real destination can be blacklisted or trigger the home search;
        // for everything else this is just an abort, same shape as a stall.
        const travelling = goal.action === 'move';
        const relocatingHome = travelling ? this._beginNearbyHomeSearch(goal) : false;
        // do not offer this destination again for a while - it is not that the walk
        // failed, it is that the SPOT cannot be stood on.
        if (travelling) this._rememberDestination(where);
        this._markPendingAborted(goal.id, why);
        this._applyMinecraftEvent('stalled');
        this._avoidAction = goal.requestedAction || goal.action;
        this._avoidUntil = now + LOOP_AVOID_MS;
        this._wanderLadder = 0;
        this._wanderGoalId = null;
        this._wanderEpisodes = [];
        this._wanderWasActive = false;
        this.activeGoal = null;
        this.currentTask = null;
        this._pushCommentary(relocatingHome
            ? `the old home is ${Math.round(this._homeRelocation.distance)} blocks away and its route is broken. i'm finding better ground near here and moving the toaster project`
            : travelling
                ? `whatever is at ${where.target || 'that spot'} cannot actually be walked to. i've been circling it. dropping it`
                : `i can't get to what ${label} needs - i've just been shuffling in place. dropping it`, 'unreachable');
        this.emit('gameEvent', 'target_unreachable', { target: where.target || null, radius, relocatingHome });
        this.executeAction('stop', {}, { priority: 'urgent', source: 'unreachable', waitForCompletion: false })
            .catch((err) => this.log('warn', `failed to stop unreachable goal: ${err.message}`));
        return true;
    }

    _observePinned() {
        const point = this._point(this.gameState.position);
        if (!point) return;
        const now = Date.now();
        if (!this._pinnedAnchor ||
            Math.hypot(point.x - this._pinnedAnchor.x, point.z - this._pinnedAnchor.z) > PINNED_RADIUS) {
            this._pinnedAnchor = point;
            this._pinnedAnchorAt = now;
        }
    }

    // held inside a few blocks for a while AND still being hit AND hostiles are around:
    // that is the defense-chain pin, not mining and not a pathing orbit. altoclef's
    // MobDefenseChain outranks anything node can issue (70-80 vs UserTaskChain's 50), so
    // this deliberately does NOT try to win the fight - it stops pretending the current
    // goal is progressing, gets it on the record, hands her brain the situation so the
    // freeze is never silent on stream again, and walks her out once the chain lets go.
    _recoverPinnedByMobs() {
        if (!this.autonomous || this.manualControl) return false;
        if (this._recoveringPin) return false;
        const now = Date.now();
        if (now - (this._lastPinRecoveryAt || 0) < PINNED_COOLDOWN_MS) return false;
        if (!this._pinnedAnchorAt || now - this._pinnedAnchorAt < PINNED_MS) return false;
        if (now - (this._lastDamageAt || 0) > PINNED_DAMAGE_WINDOW_MS) return false;
        const g = this.gameState;
        if (!(Number(g.nearbyHostiles) > 0)) return false;
        if (this._isInWater()) return false;   // the water watchdog owns that case

        this._recoveringPin = true;
        this._lastPinRecoveryAt = now;
        const heldSec = Math.round((now - this._pinnedAnchorAt) / 1000);
        const failed = this.activeGoal?.action || this.currentAction || null;
        const pinnedOn = failed || this.currentTask || 'whatever i was doing';
        this.log('warn', `pinned: ${heldSec}s inside ${PINNED_RADIUS} blocks, still taking hits from ${g.nearbyHostiles} hostile(s) - breaking ${pinnedOn}`);
        try {
            this.memory.record('recovery', `got pinned by mobs and had to leave (${heldSec}s stuck)`, {
                action: failed, position: g.position, dimension: g.dimension
            });
        } catch { /* memory best-effort */ }
        this._applyMinecraftEvent('pinned', { count: g.nearbyHostiles });
        this._pushCommentary(`stuck in the same few blocks for ${heldSec} seconds, ${g.nearbyHostiles} of them chewing on me, and ${pinnedOn} has not moved an inch`, 'pinned');
        this.emit('gameEvent', 'pinned_by_mobs', { heldSec, hostiles: g.nearbyHostiles, health: g.health });

        if (failed && !NON_TASK_ACTIONS.has(failed)) {
            this._avoidAction = failed;
            this._avoidUntil = now + LOOP_AVOID_MS;
        }
        this.activeGoal = null;
        this.currentTask = 'getting out of a spot that was killing me';
        (async () => {
            try { await this.executeAction('stop', {}, { priority: 'urgent', source: 'pinned', timeoutMs: 30000 }); } catch { /* may not be running */ }
            // real distance, not a short hop - a few blocks just re-enters the same mobs'
            // aggro range. _pickLandingSpot keeps the bearing on land (the ocean lesson).
            const p = this.gameState.position || { x: 0, y: 64, z: 0 };
            // RETREAT OUTWARD WHEN THERE IS AN OUTWARD. a pin inside the spawn
            // region used to break in a random direction, so half of them threw
            // away the walk she was in the middle of - that is the "goes to the
            // edge, gets chased back to the middle" half of the loop. getting
            // away from the mobs is still the point, so this is a preference
            // with a plain fallback, never a reason to stay pinned.
            const region = this._standingInSpawnRegion() ? this._spawnRegion() : null;
            const spot = (region && this._pickLandingSpot(p, 120, 260, {
                outward: { depth: (x, z) => this._spawnDepth(x, z), here: this._spawnDepth(p.x, p.z), min: 1 }
            })) || this._pickLandingSpot(p, 120, 260);
            if (!spot) {
                this.recentEvents.record('pinned down, and no dry way out of it that i know of');
                return;
            }
            await this.executeAction('move', { ...spot, target: 'anywhere but here' }, {
                source: 'pinned', waitForCompletion: false
            });
        })().catch((err) => this.log('warn', `pin recovery failed: ${err.message}`))
            .finally(() => {
                this._recoveringPin = false;
                this._pinnedAnchor = null;
                this._pinnedAnchorAt = 0;
            });
        return true;
    }

    // WHAT she is doing, in her own frame. the mechanical chain says "doing stuff in
    // crafting_table x 1 container: [[stone_pickaxe] x 1]"; this says "crafting stone
    // pickaxe". both go on the hud, stacked, because the gap between them is usually
    // the interesting part - and reading that gap is exactly what was impossible.
    _intentWhat() {
        const goal = this.activeGoal;
        if (goal) {
            const verb = INTENT_VERBS[goal.action] || goal.action;
            const p = goal.params || {};
            const target = p.target
                || (Number.isFinite(Number(p.x)) ? `${Math.round(Number(p.x))}, ${Math.round(Number(p.z))}` : '');
            const noun = String(target || '').replace(/_/g, ' ').trim();
            return noun ? `${verb} ${noun}` : String(verb);
        }
        return this.currentTask ? String(this.currentTask) : '';
    }

    // altoclef's raw phase strings are machine spew:
    //   "doing stuff in crafting_table x 1 container: [[stone_pickaxe] x 1]"
    //   "collect recipe resources: {recipetarget{_recipe=craftingrecipe{craft
    //    stone_pickaxe}, _item=minecraft:stone_pickaxe x 1}}: getting cobblestone x 3"
    // the useful part is WHAT IS IN THE JOB - the item and what it still needs - which
    // is exactly what you want on screen while she is stood at a bench doing nothing
    // visible. pull that out and leave everything else alone.
    _prettyPhase(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        // "...: getting cobblestone x 3" -> the outstanding ingredient wins, it is the
        // reason she is standing there
        const needs = s.match(/getting\s+([a-z0-9_]+)\s*x\s*(\d+)/i);
        if (needs) return `needs ${needs[1].replace(/_/g, ' ')} x${needs[2]}`;
        // a container job carries its output list: [[stone_pickaxe] x 1]
        const container = s.match(/\b(crafting_table|furnace|smoker|blast_furnace|campfire)\b[^:]*:\s*\[\[([^\]]+)\]\s*x\s*(\d+)/i);
        if (container) {
            const verb = /crafting_table/i.test(container[1]) ? 'crafting' : 'smelting';
            const item = container[2].split(',')[0].replace(/_/g, ' ').trim();
            return `${verb} ${item}${Number(container[3]) > 1 ? ` x${container[3]}` : ''}`;
        }
        // "craft 2x2 task recipetarget{...craft sticks...}" -> crafting sticks
        const recipe = s.match(/craft\s+([a-z0-9_]+)\}/i) || s.match(/\bcraft\s+([a-z0-9_]+)\b/i);
        if (recipe && /recipe|craft/i.test(s)) return `crafting ${recipe[1].replace(/_/g, ' ')}`;
        // "mine and collect: [[cobblestone] x 1]"
        const collect = s.match(/mine and collect:\s*\[\[([^\],]+)/i);
        if (collect) return `mining ${collect[1].replace(/_/g, ' ').trim()}`;
        // "getting to block blockpos{x=-183, y=70, z=334} in dimension overworld:
        //  wandering..." - the most common line on screen, and the least readable.
        // the wander suffix matters: it is altoclef saying it cannot find a way.
        const going = s.match(/getting to block blockpos\{x=(-?\d+),\s*y=(-?\d+),\s*z=(-?\d+)/i);
        if (going) {
            const lost = /wandering/i.test(s) ? ' (looking for a way)' : '';
            return `walking to ${going[1]}, ${going[3]}${lost}`;
        }
        return s;
    }

    _liveGoalPhase() {
        const path = Array.isArray(this.gameState.botTaskPath)
            ? this.gameState.botTaskPath.map((part) => this._cleanPhase(part)).filter(Boolean)
            : [];
        // Dependency acquisition is the most honest explanation for a goal
        // whose headline says "crafting": it distinguishes using a recipe from
        // roaming the world for an ingredient. The companion now supplies the
        // whole task path so this useful middle layer is no longer discarded.
        for (let i = path.length - 1; i >= 0; i--) {
            if (/getting\s+[a-z0-9_]+\s*x\s*\d+/i.test(path[i])) return this._prettyPhase(path[i]);
        }
        return this._prettyPhase(this._cleanPhase(this.gameState.botAction))
            || this._prettyPhase(path.at(-1))
            || this._prettyPhase(this._cleanPhase(this.gameState.botTask))
            || '';
    }

    _intentPayload() {
        const trim = (s, n = 88) => {
            const one = String(s || '').replace(/\s+/g, ' ').trim();
            return one.length > n ? `${one.slice(0, n - 1)}…` : one;
        };
        const what = trim(this._intentWhat());
        const goal = this.activeGoal;
        // her own `say` if she had a reason; otherwise who wanted this
        const why = what && goal ? (goal.why || INTENT_SOURCE_WHY[goal.source] || '') : '';
        const phase = what ? this._liveGoalPhase() : '';
        const mind = this.minecraftState || this.affect.snapshot();
        const affect = (key) => Math.max(0, Math.min(100, Math.round(Number(mind[key]) || 0)));
        return {
            what,
            why: trim(why),
            phase: trim(phase),
            fear: affect('fear'),
            confidence: affect('confidence'),
            security: affect('security'),
            fun: affect('fun')
        };
    }

    // only ever sent when the line actually changes - the hud is cosmetic and must
    // never become traffic. an empty payload clears it (the companion also expires a
    // stale line on its own, so burnt dying never leaves a lie on screen).
    _pushIntentHud() {
        if (!this.connected || !this.gameConnected) return;
        const now = Date.now();
        if (now - (this._lastIntentPushAt || 0) < INTENT_PUSH_MIN_GAP_MS) return;
        const payload = this._intentPayload();
        const signature = JSON.stringify(payload);
        // An unchanged payload still needs a heartbeat. The companion expires stale
        // text after 90s so a dead node cannot leave a lie on screen forever.
        if (signature === this._lastIntentSignature &&
            now - this._lastIntentPushAt < INTENT_HEARTBEAT_MS) return;
        this._lastIntentSignature = signature;
        this._lastIntentPushAt = now;
        const encoded = Buffer.from(signature, 'utf8').toString('base64');
        this.executeAction('hud', { payload: encoded }, { source: 'hud', waitForCompletion: false })
            .catch(() => { /* cosmetic - an old jar without the verb must not look like a fault */ });
    }

    _describeTask(action, params) {
        const t = params.target ? ` ${params.target}` : '';
        return `${action}${t}`.trim();
    }

    // normalize any dimension spelling to the bridge's move vocabulary
    _dimForMove(d) {
        const n = String(d || 'overworld').replace(/^minecraft:/, '').toLowerCase();
        if (n.includes('nether')) return 'nether';
        if (n.includes('end')) return 'end';
        return 'overworld';
    }

    _dimMatches(a, b) {
        return this._dimForMove(a) === this._dimForMove(b);
    }

    // ---- favorite spots + home (llm/tools.js entry points) ----------------

    // which server/save she is on. coordinates are meaningless without it - her old
    // server's house is somebody else's dirt here.
    // ONLY a named server counts as a confident world identity. singleplayer saves are
    // indistinguishable from in here, and - the dangerous case - a transiently missing
    // multiplayer flag must never make her home vanish, because a homeless burnt
    // immediately goes and settles somewhere else. null means "don't filter".
    _worldId() {
        const g = this.gameState;
        return (g.multiplayer === true && g.server) ? String(g.server).slice(0, 80) : null;
    }

    // where she lives ON THIS WORLD. every "am i home / how far is home / go home"
    // question has to be world-scoped, or on a new server she measures against a house
    // that is somebody else's dirt here.
    _home() {
        return this.memory.getHome(this._worldId());
    }

    _homeOvens(kind = null) {
        const home = this._home();
        if (!home) return [];
        const settlement = this.memory.getMainSettlement?.(this._worldId());
        return this.memory.listOvens().filter((oven) => {
            if (kind && oven.kind !== kind) return false;
            if (!this._dimMatches(oven.dimension, home.dimension)) return false;
            if (settlement?.contains) return settlement.contains(oven.position, 3);
            return Math.hypot(oven.position.x - home.position.x, oven.position.z - home.position.z) <= TOASTER_NEAR_RADIUS;
        });
    }

    _homeFurnaceCount() { return this._homeOvens('furnace').length; }

    // a half-built toaster at home is a standing obligation, not a preference: the
    // idle menu must not march her hundreds of blocks off while a shell is waiting.
    // NO home yet means nothing to abandon - out there, walking IS the search.
    _toasterUnfinished() {
        try {
            if (!this._home()) return false;
            return this.homeSpec().met !== true;
        } catch { return false; }
    }

    _settlementProgressSignature(progress) {
        if (!progress || typeof progress !== 'object') return '';
        const keys = [
            'kind', 'role', 'x', 'y', 'z', 'width', 'depth', 'height', 'phase',
            'percent', 'complete', 'clear', 'floor', 'walls', 'roof', 'toastSlots',
            'toastSlotCount', 'walkthrough', 'lit', 'smoothStoneRemaining',
            // felling a yard IS the work during that phase. Without these two the
            // signature never moves while she clears it, and build_settlement's
            // six-minute survey-only stall budget condemns a builder that is
            // visibly chopping down a wood.
            'housed', 'yardClear', 'yardRemaining',
            'clearRemaining', 'torches', 'torchesRequired'
        ];
        return JSON.stringify(Object.fromEntries(keys.map((key) => [key, progress[key] ?? null])));
    }

    // the nearest saved toaster she could actually walk to, same dimension first.
    _nearestSettlement(list = []) {
        if (!Array.isArray(list) || !list.length) return null;
        const sameDim = list.filter((entry) => this._dimMatches(entry.dimension, this.gameState.dimension));
        const pool = sameDim.length ? sameDim : list;
        const here = this.gameState.position;
        if (!here) return pool[0];
        try {
            return pool.slice().sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0];
        } catch { return pool[0]; }
    }

    // RESUME THE SAVED BLUEPRINT. the house is already persisted - id, anchor,
    // dimensions, progress - so demanding that she echo seven exact values back
    // was ceremony that could only fail: the home line she actually reads carries
    // the WxDxH and nothing else, no anchor, no role, no id, so the exact() match
    // was UNSATISFIABLE for the homestead and every attempt to build her own
    // house came back "must match a saved toaster blueprint" (2026-08-05, said on
    // stream as "my own house button rejected me. i am being denied housing by a
    // toaster blueprint"). her numbers are still never trusted - they are
    // REPLACED by the saved ones below - but a missing one now RESOLVES instead
    // of refusing. the only real error left is having no blueprint at all.
    _canonicalSettlementBuildParams(params = {}) {
        const world = this._worldId();
        const saved = this.memory.listSettlements(world);
        if (!saved.length) {
            throw new Error('no toaster blueprint is saved on this world yet - stand where the house should go and set_home (or set_outpost) first');
        }
        const id = String(params.settlementId || '').trim();
        const role = String(params.role || '').trim().toLowerCase();
        const named = String(params.target || params.name || '').trim().toLowerCase();
        const exact = (entry) => entry.role === role &&
            entry.anchor.x === Number(params.x) && entry.anchor.y === Number(params.y) &&
            entry.anchor.z === Number(params.z) && entry.width === Number(params.width) &&
            entry.depth === Number(params.depth) && entry.height === Number(params.height);
        const settlement =
            (id ? saved.find((entry) => entry.id === id) : null) ||
            saved.find(exact) ||
            (named ? saved.find((entry) => String(entry.name || '').trim().toLowerCase() === named) : null) ||
            (role === 'outpost' ? this._nearestSettlement(saved.filter((entry) => entry.role === 'outpost')) : null) ||
            this.memory.getMainSettlement(world) ||
            this._nearestSettlement(saved);
        if (!settlement) {
            throw new Error('no toaster blueprint is saved on this world yet - stand where the house should go and set_home (or set_outpost) first');
        }
        return {
            ...params,
            role: settlement.role,
            settlementId: settlement.id,
            x: settlement.anchor.x,
            y: settlement.anchor.y,
            z: settlement.anchor.z,
            width: settlement.width,
            depth: settlement.depth,
            height: settlement.height,
            target: settlement.name
        };
    }

    _persistSettlementSurvey(progress) {
        const signature = this._settlementProgressSignature(progress);
        if (!signature || signature === this._lastSettlementProgressSignature) return;
        this._lastSettlementProgressSignature = signature;
        const settlement = this.memory.listSettlements(this._worldId()).find((entry) =>
            entry.kind === String(progress.kind || '') &&
            entry.anchor.x === Number(progress.x) && entry.anchor.y === Number(progress.y) &&
            entry.anchor.z === Number(progress.z) && entry.width === Number(progress.width) &&
            entry.depth === Number(progress.depth) && entry.height === Number(progress.height));
        if (!settlement) return;
        const durable = { ...progress };
        delete durable.active;
        delete durable.updatedAt;
        this.memory.updateSettlementProgress(settlement.id, durable);
    }

    // THE FOOTPRINT NEVER MOVES. The toaster used to grow a block of width per
    // furnace, up to 43x20x12, and every expansion re-laid the shell and wiped
    // the survey - twenty-four rebuilds of the same house because the gallery it
    // was sized around kept needing another row. The floorplan is fixed and its
    // gallery fits inside it, so this now just keeps the record pointed at home.
    _ensureMainToaster() {
        const home = this._home();
        if (!home) return null;
        const furnaces = this._homeFurnaceCount();
        const furnaceTarget = Math.min(TOASTER_FURNACE_TARGET, Math.max(1, furnaces + 1));
        const dimensions = toasterHomesteadDimensions();
        const existing = this.memory.getMainSettlement?.(this._worldId());
        const sameAnchor = existing && this._dimMatches(existing.dimension, home.dimension) &&
            Math.hypot(existing.anchor.x - home.position.x, existing.anchor.z - home.position.z) <= 3;
        // A SURVEY IS ONLY VALID FOR THE HOUSE IT WAS TAKEN OF, and the survey's
        // OWN recorded size is the only surviving evidence of that. Comparing
        // `existing.width` cannot work: rehydrating a settlement runs it through
        // the ToasterHomestead constructor, which coerces every saved shell to
        // the floorplan, so both sides of that test read 14 whatever is on disk.
        // The live save was a 20x13x9 at "90% done, 6 torches required" - kept
        // against a 14x9x8 house that needs 36, which she would then narrate.
        const surveyed = existing?.progress;
        const sameDimensions = sameAnchor && !!surveyed &&
            Number(surveyed.width) === dimensions.width &&
            Number(surveyed.depth) === dimensions.depth &&
            Number(surveyed.height) === dimensions.height;
        const settlement = new ToasterHomestead({
            ...(existing ? existing.toJSON() : {}),
            name: home.name || 'the homestead',
            anchor: home.position,
            dimension: home.dimension,
            world: home.world || this._worldId(),
            furnaceTarget,
            progress: sameDimensions ? existing.progress : null,
            appliances: sameAnchor ? existing.appliances : [],
            ...dimensions
        });
        // OLD-GRID GHOSTS. The ledger carried forward from a settlement built on
        // the previous 9x3 gallery holds blocks the floorplan has no square for.
        // Left in, one of them retires a planned slot that was never filled.
        settlement.appliances = this._planOnlyAppliances(settlement);
        return this.memory.upsertSettlement(settlement, { main: true });
    }

    /** Ledger entries that land on a block the plan actually uses. */
    _planOnlyAppliances(settlement) {
        const at = (p) => `${p.x},${p.y},${p.z}`;
        const usable = new Set([
            ...settlement.applianceSlots().map(at),
            ...toasterOpenFloor(settlement).map(at)
        ]);
        return (settlement.appliances || []).filter((entry) =>
            [entry.x, entry.y, entry.z].every(Number.isFinite) && usable.has(at(entry)));
    }

    _matchingBuild(settlement) {
        const live = this.gameState.settlementBuild;
        if (!live || !settlement) return null;
        const same = String(live.kind || '') === settlement.kind &&
            Number(live.x) === settlement.anchor.x && Number(live.y) === settlement.anchor.y &&
            Number(live.z) === settlement.anchor.z && Number(live.width) === settlement.width &&
            Number(live.depth) === settlement.depth && Number(live.height) === settlement.height;
        return same ? live : null;
    }

    // Exact companion survey, never inventory inference. Torches in her bag do
    // not light a building; two slots are two verified openings in the roof.
    homeSpec() {
        const settlement = this._ensureMainToaster();
        const furnaces = this._homeFurnaceCount();
        const live = this._matchingBuild(settlement);
        const progress = live || settlement?.progress || null;
        const components = progress || {};
        // THE HOUSE, NOT THE YARD. `complete` now means "house AND ten clear
        // blocks all round it", and the yard has no fixed size - a wood is
        // thousands of blocks - so gating the gallery on it would mean one bad
        // treeline is a toaster that never gets a single furnace in it. `housed`
        // is the in-game task's answer to "is this habitable", and an older jar
        // that has never heard of a yard still answers it via `complete`.
        const housed = components.housed === true ||
            (components.housed == null && components.complete === true);
        const met = !!progress && housed && components.clear === true &&
            components.floor === true && components.walls === true && components.roof === true &&
            components.toastSlots === true && Number(components.toastSlotCount) === 2 &&
            components.walkthrough === true && components.lit === true;
        // undefined on an old jar, which reads as "no yard work known" rather
        // than "the yard is filthy" - she must never be sent to clear a yard the
        // game cannot yet measure.
        const yardClear = components.yardClear !== false;
        const slots = settlement ? settlement.applianceSlots() : [];
        const filled = settlement ? this._filledApplianceKeys(settlement) : new Set();
        return {
            settlement,
            furnaces,
            // the plan's number, the same one _publicHomeProject reports - the
            // settlement's own `furnaceTarget` is a vestigial expansion ratchet
            // and having two answers under one name is a trap
            furnaceTarget: TOASTER_FURNACE_TARGET,
            // how much of the floorplan's gallery is actually standing
            slotTotal: slots.length,
            installed: slots.filter((slot) => filled.has(`${slot.x},${slot.y},${slot.z}`)).length,
            width: settlement?.width || null,
            depth: settlement?.depth || null,
            height: settlement?.height || null,
            // whatever stone the shell actually went up in - the game reports it
            material: progress?.material || 'stone',
            progress,
            percent: Number.isFinite(Number(progress?.percent)) ? Math.round(Number(progress.percent)) : 0,
            phase: progress?.phase || 'not surveyed',
            clear: components.clear === true,
            floor: components.floor === true,
            walls: components.walls === true,
            roof: components.roof === true,
            toastSlots: components.toastSlots === true && Number(components.toastSlotCount) === 2,
            walkthrough: components.walkthrough === true,
            lit: components.lit === true,
            yardClear,
            yardRemaining: Number.isFinite(Number(components.yardRemaining))
                ? Number(components.yardRemaining) : null,
            met
        };
    }

    // the build phase is a snake_case identifier the pipeline passes around, and
    // SHE QUOTES THE PIPELINE - "gathering_stone" came out of her mouth on stream
    // more than once. machine-facing consumers keep the identifier; anything she
    // reads aloud gets english.
    _buildPhaseLabel(phase) {
        const raw = String(phase || '').trim();
        if (!raw) return '';
        const known = {
            walking_to_quarry: 'walking back to the mine',
            gathering_stone: 'out getting stone',
            crafting_side_torches: 'making torches',
            clearing_the_yard: 'clearing the yard',
            surveying: 'sizing the place up',
            core_program_complete: 'done',
            not_surveyed: 'not surveyed yet',
            blocked_baritone_cannot_build: 'the site is refusing to be built on'
        };
        if (known[raw]) return known[raw];
        const waiting = raw.match(/^waiting_for_(.+)$/);
        if (waiting) return `waiting on a ${waiting[1].replace(/_/g, ' ')}`;
        return raw.replace(/_/g, ' ');
    }

    homeSpecLine() {
        const s = this.homeSpec();
        if (!s.settlement) return 'no toaster homestead has been claimed yet';
        const size = `${s.width}x${s.depth}x${s.height}`;
        const stone = String(s.material || 'stone').replace(/_/g, ' ');
        // SHE QUOTES THIS LINE. A yard she is visibly out chopping down has to
        // appear in it, or the readout says "ready" while chat is watching her
        // fell a wood and she has nothing true to say about what she is doing.
        const yard = s.yardClear
            ? `${TOASTER_YARD_MARGIN} clear blocks all round`
            : (Number(s.yardRemaining) > 0
                ? `yard still crowded (${s.yardRemaining} blocks in the way)`
                : 'yard still crowded');
        if (s.met) return `main toaster is ready: ${size} ${stone}, clear, roof + walls + floor, two top slots, walkthrough, wall torches, ${yard}; ${s.installed}/${s.slotTotal} appliance blocks stacked (${s.percent}%)`;
        const missing = [];
        if (!s.clear) missing.push('clear interior');
        if (!s.floor) missing.push('floor');
        if (!s.walls) missing.push('walls');
        if (!s.roof) missing.push('roof');
        if (!s.toastSlots) missing.push('two toast slots');
        if (!s.walkthrough) missing.push('walk-through hole');
        if (!s.lit) missing.push('side torches');
        if (!s.yardClear) missing.push(`${TOASTER_YARD_MARGIN} clear blocks round the walls`);
        return `main toaster ${s.percent}% (${this._buildPhaseLabel(s.phase)}): ${size}, ${s.installed}/${s.slotTotal} appliances in; needs ${missing.join(' + ') || 'a fresh survey'}`;
    }

    _publicHomeProject() {
        const spec = this.homeSpec();
        if (!spec.settlement) return null;
        const smokerCount = this._homeOvens('smoker').length;
        // the program is the map: a finished shell plus every block of it filled.
        const slots = spec.settlement.applianceSlots();
        const filled = this._filledApplianceKeys(spec.settlement);
        const standing = slots.filter((slot) => filled.has(`${slot.x},${slot.y},${slot.z}`));
        const installed = standing.length;
        // counted off the PLAN, not off the oven collection - a campfire on the
        // floor is a unit in her collection but not a block of the toaster
        const inPlan = (kind) => standing.filter((slot) => slot.kind === kind).length;
        const next = this._nextApplianceSlot(spec.settlement);
        const nextAppliance = spec.met ? (next?.kind || null) : null;
        const completedUnits = installed + (spec.met ? 1 : spec.percent / 100) * slots.length * 0.25;
        const totalUnits = slots.length * 1.25;
        return {
            id: spec.settlement.id,
            goal: spec.met
                ? (next ? `stack the next ${next.kind.replace(/_/g, ' ')} at ${next.x},${next.y},${next.z}` : 'maintain the completed main toaster homestead')
                : `build the main toaster shell: ${spec.width}x${spec.depth}x${spec.height}`,
            percent: Math.min(100, Math.round(completedUnits / totalUnits * 100)),
            shellPercent: spec.percent,
            // A house with a job still attached must not report itself idle. Left
            // out, the yard was a thing she was demonstrably doing on stream that
            // her own readout said nothing about - and she speaks from the readout.
            phase: spec.met
                ? (!spec.yardClear ? 'clearing_the_yard'
                    : (nextAppliance ? `waiting_for_${nextAppliance}` : 'core_program_complete'))
                : spec.phase,
            complete: spec.met && installed >= slots.length,
            shellComplete: spec.met,
            furnaceCount: spec.furnaces,
            furnaceTarget: TOASTER_FURNACE_TARGET,
            smokerCount,
            nextAppliance,
            yard: { margin: TOASTER_YARD_MARGIN, clear: spec.yardClear, remaining: spec.yardRemaining },
            program: {
                shell: { complete: spec.met ? 1 : 0, target: 1, fractional: spec.percent / 100 },
                appliances: { complete: installed, target: slots.length },
                furnaces: { complete: inPlan('furnace'), target: TOASTER_FURNACE_TARGET },
                smokers: { complete: inPlan('smoker'), target: TOASTER_SMOKER_TARGET },
                chests: { complete: inPlan('chest'), target: TOASTER_CHEST_TARGET },
                completedUnits, totalUnits
            },
            dimensions: { width: spec.width, depth: spec.depth, height: spec.height },
            blueprint: toasterBlueprint(spec.settlement),
            components: {
                clear: spec.clear, floor: spec.floor, walls: spec.walls, roof: spec.roof,
                toastSlots: spec.toastSlots, walkthrough: spec.walkthrough, sideTorches: spec.lit
            },
            material: spec.material || 'stone',
            // wire key kept as-is (the in-game telemetry still sends it); it now
            // counts shell blocks of ANY accepted stone, not smooth stone alone.
            smoothStoneRemaining: Number(spec.progress?.smoothStoneRemaining) || 0,
            clearRemaining: Number(spec.progress?.clearRemaining) || 0,
            torches: Number(spec.progress?.torches) || 0,
            torchesRequired: Number(spec.progress?.torchesRequired) || 0
        };
    }

    setOutpostHere(name = 'toaster outpost', level = 1) {
        if (!this.gameConnected || this._stateIsStale()) {
            throw new Error('need a live world position to establish a toaster outpost');
        }
        const main = this._ensureMainToaster();
        if (!main) throw new Error('establish the main toaster homestead before adding outposts');
        if (this.memory.listOutposts(this._worldId()).some((entry) => entry.name.toLowerCase() === String(name).trim().toLowerCase())) {
            throw new Error(`a toaster outpost named "${name}" already exists`);
        }
        const position = this._point(this.gameState.position);
        if (!position || !this._dimMatches(main.dimension, this.gameState.dimension)) {
            throw new Error('the outpost must be in the main homestead dimension');
        }
        if (main.distanceTo(position) < OUTPOST_MIN_HOME_DISTANCE) {
            throw new Error(`toaster outposts must be at least ${OUTPOST_MIN_HOME_DISTANCE} blocks from the main homestead`);
        }
        if (this.gameState.underwater === true || OCEAN_BIOME_RE.test(String(this.gameState.biome || ''))) {
            throw new Error('a toaster outpost needs dry land');
        }
        if (this._isClaimedCell(position.x, position.z)) {
            throw new Error('that land has already refused building; choose an unclaimed outpost site');
        }
        const dimensions = toasterOutpostDimensions(level);
        const outpost = fitOutpostBelowHomestead(new ToasterOutpost({
            name, anchor: position, dimension: this.gameState.dimension,
            world: this._worldId(), level, ...dimensions
        }), main);
        // EACH TOASTER'S YARD HAS TO MISS EVERY OTHER TOASTER'S WALLS. Spacing
        // them by their footprints alone left the nearer one's shell standing
        // INSIDE the further one's ten-block yard - and "clear the yard" would
        // then read as "demolish the outpost", one block at a time, forever.
        const overlaps = this.memory.listSettlements(this._worldId()).some((entry) =>
            entry.distanceTo(outpost.anchor) < toasterYardSeparation(entry, outpost));
        if (overlaps) throw new Error('that site overlaps an existing homestead or outpost');
        if (!mainIsBiggest(main, [...this.memory.listOutposts(this._worldId()), outpost])) {
            throw new Error('the main toaster must stay strictly larger than every outpost');
        }
        const saved = this.memory.upsertSettlement(outpost);
        this.memory.setFavorite(saved.name, saved.anchor, saved.dimension, 'smooth-stone toaster outpost', saved.world);
        this.recentEvents.record(`established toaster outpost "${saved.name}"`);
        return saved;
    }

    _findOutpost(name = null) {
        const outposts = this.memory.listOutposts(this._worldId());
        const wanted = String(name || '').trim().toLowerCase();
        if (wanted) return outposts.find((entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted) || null;
        const here = this.gameState.position;
        return outposts.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0] || null;
    }

    // save the spot she's standing on under a name of her choosing
    setFavoriteHere(name, note = null) {
        if (!this.gameConnected || this._stateIsStale()) {
            throw new Error('need a live world position to save a spot - join a world / wait for fresh telemetry');
        }
        const entry = this.memory.setFavorite(name, this.gameState.position, this.gameState.dimension, note, this._worldId());
        if (!entry) throw new Error('that spot name did not stick - give it a real name');
        this.recentEvents.record(`saved a favorite spot: ${entry.name}`);
        this.memory.record('favorite', `named this spot "${entry.name}"`, {
            position: entry.position, dimension: entry.dimension, details: note || null
        });
        return entry;
    }

    // mark a place as HOME.
    // "set home" under a NEW name, or under the name that is ALREADY home, means
    // "here is home now" - that is how she moves house, and she can do it anywhere,
    // any number of times. naming a DIFFERENT saved spot means "that place is home"
    // and must NOT drag the spot to her feet.
    setHome(name = 'home', note = null) {
        const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
        const existing = this.memory.getFavorite(name);
        const currentHome = this.memory.getHome();
        const relocate = !existing || (currentHome && sameName(currentHome.name, name));
        if (relocate && (!this.gameConnected || this._stateIsStale())) {
            throw new Error('need a live world position to set home here - join a world / wait for fresh telemetry');
        }
        const entry = relocate
            ? this.memory.setHome(name, this.gameState.position, this.gameState.dimension, note, this._worldId())
            : this.memory.setHome(name);
        if (!entry) throw new Error('could not set home');
        this.recentEvents.record(`declared "${entry.name}" home`);
        this.memory.record('home', `made "${entry.name}" home`, { position: entry.position, dimension: entry.dimension });
        this._ensureMainToaster();
        return entry;
    }

    // multiplayer chat manners: decide whether an incoming server-chat line
    // reaches her brain. local/singleplayer keeps the old always-surface
    // behavior (minus self-echo, which _handleEvent already drops).
    // everyone she has heard talk on this server, most recent first. a public
    // server is a ROOM, not a DM: without a roster she read every line as if it
    // were spoken to her and answered things like "hi marble" with "i'm not
    // marble but sure".
    knownPlayers(limit = 12) {
        const roster = [...(this._chatRoster || new Map()).entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name]) => name);
        const nearby = Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames : [];
        const seen = new Set();
        const out = [];
        for (const name of [...nearby, ...roster]) {
            const key = String(name || '').trim();
            if (!key || seen.has(key.toLowerCase())) continue;
            if (this.gameUsername && key.toLowerCase() === String(this.gameUsername).toLowerCase()) continue;
            seen.add(key.toLowerCase());
            out.push(key);
            if (out.length >= limit) break;
        }
        return out;
    }

    // is this whole chat line just somebody's username? checked against the live
    // roster only, so ordinary one-word replies - "bread", "lmao", "mine" - still
    // go out, while a leaked addressee never does.
    _bareRosterName(text) {
        const bare = String(text || '').trim().replace(/^[@<]+/, '').replace(/[>,:;!?.\s]+$/, '').trim();
        if (!bare || /\s/.test(bare)) return null;
        let roster = [];
        try { roster = this.knownPlayers(24) || []; } catch { roster = []; }
        return roster.find((name) => String(name).toLowerCase() === bare.toLowerCase()) || null;
    }

    _rememberPlayer(name) {
        const key = String(name || '').trim();
        if (!key) return;
        if (this.gameUsername && key.toLowerCase() === String(this.gameUsername).toLowerCase()) return;
        if (!this._chatRoster) this._chatRoster = new Map();
        if (this._chatRoster.size > 200) {
            const oldest = [...this._chatRoster.entries()].sort((a, b) => a[1] - b[1])[0];
            if (oldest) this._chatRoster.delete(oldest[0]);
        }
        this._chatRoster.set(key, Date.now());
    }

    // the durable half of meeting someone. the roster above is a RAM cache that dies
    // with the process; this is the part that means she still knows them tomorrow.
    _rememberPlayerDurably(kind, name, detail = null) {
        const who = String(name || '').trim();
        if (!who) return null;
        if (this.gameUsername && who.toLowerCase() === String(this.gameUsername).toLowerCase()) return null;
        const world = this._worldId();
        try {
            let out;
            if (kind === 'chat') out = this.memory.recordPlayerChat(who, detail, world);
            else if (kind === 'gift') out = this.memory.recordPlayerGift(who, detail || 'bread', world);
            else if (kind === 'request') out = this.memory.recordPlayerRequest(who, detail?.text, detail?.action, world);
            else out = this.memory.recordPlayerSighting(who, world);
            // talking, asking and receiving bread are the things that make somebody a
            // person she knows rather than a name that walked past.
            this._bridgePlayerToMemory(who, { immediate: kind !== 'sighting' });
            return out;
        } catch { return null; }   // memory is an enhancement, never a reason to stop playing
    }

    // is this line clearly aimed at somebody who is not her? a greeting or a
    // direct address naming another player means she is overhearing, not being
    // spoken to.
    addressedToSomeoneElse(text) {
        const t = String(text || '').toLowerCase();
        if (!t) return null;
        if (CHAT_ADDRESSED_RE.test(t)) return null;   // her name is in it - it IS for her
        for (const name of this.knownPlayers(30)) {
            const n = String(name).toLowerCase();
            if (n.length < 3) continue;
            // "hi marble", "marble:", "@marble", "marble can you..." - the name
            // sitting at either end of the line is the giveaway.
            const at = new RegExp(`(^|\\s|@)${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
            if (at.test(t)) return name;
        }
        return null;
    }

    // is this person mid-conversation with her right now? an exchange is opened
    // when she actually answers somebody (see _openChatExchange) and expires on
    // its own, so a finished conversation stops making the room sound like it's
    // hers.
    _inChatExchange(key) {
        const ex = this._chatExchanges.get(key);
        if (!ex) return null;
        const now = Date.now();
        if (now >= ex.until || now - ex.since > CHAT_EXCHANGE_MAX_MS) {
            this._chatExchanges.delete(key);
            return null;
        }
        return ex;
    }

    // she just said something in game chat. whoever addressed her and is still
    // waiting on an answer is now in an open exchange - their next lines are for
    // her whether or not they say her name again. called at the point the message
    // is genuinely handed to the bridge, never for a refused/paced send.
    _openChatExchange() {
        const now = Date.now();
        this._recentAddressers = this._recentAddressers.filter((a) => now - a.at < CHAT_ADDRESSER_RECENT_MS);
        for (const who of this._recentAddressers.slice(-3)) {
            const prev = this._chatExchanges.get(who.key);
            // extending keeps `since` so the hard ceiling still applies
            this._chatExchanges.set(who.key, {
                until: now + CHAT_EXCHANGE_MS,
                since: prev?.since || now,
                name: who.name,
            });
        }
        this._recentAddressers = [];
        if (this._chatExchanges.size > 24) {
            for (const k of this._chatExchanges.keys()) {
                if (!this._inChatExchange(k)) this._chatExchanges.delete(k);
            }
        }
    }

    shouldSurfaceChat(sender, text) {
        const s = String(sender || '').trim();
        const t = String(text || '').trim();
        if (!s || !t) return { surface: false };
        this._rememberPlayer(s);
        // record WHAT they said, not just that they spoke. gated to real conversation
        // (command noise is filtered on the next line) so the roster stays about people.
        if (!/^[\/!.#@]/.test(t)) this._rememberPlayerDurably('chat', s, t);
        if (this.gameUsername && s.toLowerCase() === String(this.gameUsername).toLowerCase()) return { surface: false };
        if (/^[\/!.#@]/.test(t)) return { surface: false }; // command noise, not conversation
        const now = Date.now();
        const key = s.toLowerCase();
        if (this._chatSenderLastAt.size > 300) this._chatSenderLastAt.clear();
        const senderLast = this._chatSenderLastAt.get(key) || 0;
        if (this.gameState.multiplayer !== true) {
            if (now - senderLast < CHAT_SENDER_GAP_MS) return { surface: false };
            this._chatSenderLastAt.set(key, now);
            return { surface: true, addressed: true, owner: false };
        }
        const ownerName = String(process.env.MINECRAFT_OWNER || '').toLowerCase();
        const owner = !!ownerName && key === ownerName;
        const addressed = CHAT_ADDRESSED_RE.test(t);
        // someone mid-exchange who turns and names ANOTHER player has changed who
        // they are talking to. that still belongs to the overhear branch below.
        const aside = !addressed && !!this.addressedToSomeoneElse(t);
        const exchange = aside ? null : this._inChatExchange(key);
        if (owner || addressed || exchange) {
            // inside a live exchange two quick lines are one thought, not spam
            const gap = (exchange && !addressed && !owner) ? CHAT_EXCHANGE_GAP_MS : CHAT_SENDER_GAP_MS;
            if (now - senderLast < gap) return { surface: false };
            this._chatSenderLastAt.set(key, now);
            // she owes this person an answer; when she gives one the window opens
            // (or extends) so their NEXT line lands too.
            this._recentAddressers = this._recentAddressers
                .filter((a) => a.key !== key && now - a.at < CHAT_ADDRESSER_RECENT_MS);
            this._recentAddressers.push({ key, name: s, at: now });
            return { surface: true, addressed: true, owner, followUp: !!exchange && !addressed && !owner };
        }
        // a line clearly aimed at another player is somebody else's conversation.
        // she used to answer "hi marble" with "i'm not marble but sure" because
        // nothing told her the room has other people in it.
        const toSomeoneElse = this.addressedToSomeoneElse(t);
        if (toSomeoneElse) {
            // greetings/questions pointed at a specific person: stay out of it
            // entirely rather than butting in.
            if (CHAT_GREETING_RE.test(t) || t.length < 40) return { surface: false };
            // longer exchanges can still be overheard, but she is TOLD who it was
            // for so she never answers on their behalf.
            if (now - this._lastAmbientChatAt < CHAT_AMBIENT_GAP_MS) return { surface: false };
            if (Math.random() > CHAT_AMBIENT_SAMPLE) return { surface: false };
            this._lastAmbientChatAt = now;
            this._chatSenderLastAt.set(key, now);
            return { surface: true, addressed: false, owner: false, toSomeoneElse };
        }
        // ambient chatter: join in occasionally like a person, never every line
        if (t.length < 8) return { surface: false };
        if (now - this._lastAmbientChatAt < CHAT_AMBIENT_GAP_MS) return { surface: false };
        if (Math.random() > CHAT_AMBIENT_SAMPLE) return { surface: false };
        this._lastAmbientChatAt = now;
        this._chatSenderLastAt.set(key, now);
        return { surface: true, addressed: false, owner: false };
    }

    // WE are about to kill this goal ourselves. mark its pending entry while the
    // id is still in hand, because altoclef reports a CANCELLED task as a
    // FINISHED one: UserTaskChain.cancel() calls stop() and then onTaskFinish()
    // on the way out, and TaskFinishedEvent carries no success/failure channel at
    // all. so the @stop we are about to send comes straight back as SUCCESS for
    // this very action - a toaster abandoned at 34% was recorded as a completed
    // build, put its arc step on the 6 minute cooldown, and left her standing in
    // an unfinished house with nothing left to do. that was the freeze.
    _markPendingAborted(id, reason) {
        const pending = id ? this.pendingActions.get(id) : null;
        if (pending) pending.abortedByRecovery = reason || 'aborted by recovery';
    }

    _failAllPending(reason) {
        for (const [id, pending] of this.pendingActions) {
            clearTimeout(pending.timer);
            if (!pending.settled) {
                pending.settled = true;
                pending.reject(new Error(reason));
            }
            this.pendingActions.delete(id);
            this._noteTaskEnded(pending.action);
        }
        this.currentAction = null;
        this.currentActionId = null;
        this.currentTask = null;
        this.gameState.currentTask = null;
        this.activeGoal = null;
    }

    _expirePendingAction(id, pending, reason) {
        if (!pending || !this.pendingActions.has(id)) return;
        clearTimeout(pending.timer);
        this.pendingActions.delete(id);
        if (this.currentActionId === id) {
            this.currentAction = null;
            this.currentActionId = null;
            this.currentTask = null;
        }
        if (this.activeGoal?.id === id) this.activeGoal = null;
        this._noteTaskEnded(pending.action);
        if (!NON_TASK_ACTIONS.has(pending.action)) {
            this._noteTaskOutcome();
            try { this.memory.recordFailure(pending.action, pending.params?.target, reason); } catch { /* best-effort */ }
            this._applyMinecraftOutcome(false, pending.action);
            this.emit('actionFailed', {
                id,
                action: pending.action,
                params: pending.params,
                error: reason
            });
        }
        if (!pending.settled) {
            pending.settled = true;
            pending.reject(new Error(reason));
        }
        this.emit('actionTimeout', { id, action: pending.action, params: pending.params, error: reason });
        if (pending.action === 'stop' && this.connected) {
            // We cannot safely assume cancellation when the game never confirms
            // it. Closing the controller link activates the relay and companion
            // control-loss fail-safes, both of which issue their own stop before
            // reconnecting. This converts a lost stop ACK into a bounded recovery
            // instead of an unsupervised AltoClef task continuing behind a blank HUD.
            this._setFault('stop_unconfirmed', reason);
            try {
                if (typeof this.client?.terminate === 'function') this.client.terminate();
                else this.client?.close?.();
            } catch { /* close handler owns cleanup */ }
        }
    }

    // ---- chat command interpretation -------------------------------------

    // turn a natural-language viewer/user message into a minecraft action, or
    // null if it isn't a minecraft command. burnt.js / the daemon can feed chat
    // through this to let viewers re-task the bot mid-stream.
    // `inGameSender` is ONLY passed for lines that arrived over minecraft server
    // chat, where the sender name really is a minecraft username. stream chat
    // never sets it (a twitch handle is not a player), which is why "follow me"
    // used to resolve to nothing at all unless MINECRAFT_OWNER happened to be set.
    interpretChatCommand(text, inGameSender = null) {
        if (!text || typeof text !== 'string') return null;
        const t = text.toLowerCase().trim();
        const speaker = String(inGameSender || '').trim() || process.env.MINECRAFT_OWNER || null;

        // stop / cancel. "stand still" is the single most common cooperation request
        // on a server - someone is trying to hand her items or build around her - and
        // it parsed to nothing at all, so an admin asking twice got silence.
        if (/\b(stop|halt|cancel|quit it|knock it off|abort)\b/.test(t) ||
            /\b(stand|hold|sit|stay)\s+(still|there|put)\b/.test(t) ||
            /\bstop\s+moving\b/.test(t) || /\bdon'?t\s+move\b/.test(t) ||
            /\bwait\s+(there|here|up|a\s+(sec|second|moment|minute))\b/.test(t)) {
            return { action: 'stop' };
        }
        // "turn around", "look at me", "over here" - facing, not travelling
        if (/\b(turn around|look behind|behind you)\b/.test(t)) {
            return { action: 'look', params: { turn: 'around' } };
        }
        if (/\b(look at me|look here|look over here|face me|look up|look down)\b/.test(t)) {
            if (/\blook up\b/.test(t)) return { action: 'look', params: { pitch: -25 } };
            if (/\blook down\b/.test(t)) return { action: 'look', params: { pitch: 35 } };
            return speaker ? { action: 'look', params: { target: speaker } } : null;
        }
        // follow / come here - "me" is whoever actually said it in game
        if (/\b(follow me|come here|come to me|follow us|over here|this way|come with me)\b/.test(t)) {
            return speaker ? { action: 'follow', target: speaker } : null;
        }
        if (/\bfollow\s+(\w+)/.test(t)) {
            const m = t.match(/\bfollow\s+(\w+)/);
            if (m[1] === 'me') {
                return process.env.MINECRAFT_OWNER
                    ? { action: 'follow', target: process.env.MINECRAFT_OWNER }
                    : null;
            }
            return { action: 'follow', target: m[1] };
        }
        // gamer mode - the committed, narrated @gamer speedrun (she calls out each
        // goal). matched before plain speedrun so "gamer mode" routes to the mode.
        if (/\b(gamer mode|gamer time|go gamer|speedrun mode)\b/.test(t)) {
            return { action: 'gamer' };
        }
        // speedrun
        if (/\b(speedrun|marvion|beat the game|kill the dragon|ender dragon)\b/.test(t)) {
            return { action: 'speedrun' };
        }
        // THE OBSESSION, on request. matched before the generic craft/mine rules
        // below so "make bread" doesn't fall through to a raw craft of the word
        // and "get coal" reads as a fuel run rather than plain ore mining.
        if (/\b(bake|make|bread)\b/.test(t) && /\bbread\b/.test(t)) {
            return { action: 'craft', target: 'bread', params: { amount: 3 } };
        }
        // a named oven kind she should go get and install
        const ovenAsk = t.match(/\b(?:make|craft|build|get|place|install|put down|set up)\s+(?:me\s+)?(?:a\s+|an\s+|another\s+|the\s+)?(blast furnace|blast_furnace|soul campfire|soul_campfire|furnace|smoker|campfire)\b/);
        if (ovenAsk) {
            const kind = ovenAsk[1].replace(/\s+/g, '_');
            // carrying one already -> install it; otherwise go get it
            if (!new RegExp(`(^|[^a-z_])${kind}([^a-z_]|$)`).test(this._carrying())) {
                return { action: 'get', target: kind, params: { amount: 1 } };
            }
            const home = this.homeSpec();
            return home.met ? (this._installInSettlement(home.settlement, kind) || { action: 'idle' }) : { action: 'go_home' };
        }
        if (/\b(fuel|coal|charcoal)\b/.test(t) && /\b(get|need|more|restock|mine|grab)\b/.test(t)) {
            return { action: 'get', target: /charcoal/.test(t) ? 'charcoal' : 'coal', params: { amount: FUEL_COMFORT } };
        }
        if (/\b(light (?:it|this|the place) up|torches|light the|need light)\b/.test(t)) {
            return { action: 'get', target: 'torch', params: { amount: 16 } };
        }
        if (/\b(flint and steel|flint_and_steel|start a fire|make fire)\b/.test(t)) {
            return { action: 'get', target: 'flint_and_steel', params: { amount: 1 } };
        }
        // eat / food
        if (/\b(eat|food|hungry|heal up)\b/.test(t)) {
            return { action: 'eat', params: this._eatParams() };
        }
        // explore / wander
        if (/\b(explore|wander|go for a walk|look around|adventure)\b/.test(t)) {
            return { action: 'explore' };
        }
        // combat
        const kill = t.match(/\b(?:fight|attack|kill|slay|punch)\s+(?:that\s+|the\s+|a\s+)?(\w+)/);
        if (kill) {
            return { action: 'attack', target: kill[1] };
        }
        if (/\b(fight|defend yourself|get em)\b/.test(t)) {
            return { action: 'attack', target: 'nearest' };
        }
        // mining - map common resource words to their ore/block
        const oreMap = {
            diamond: 'diamond_ore', diamonds: 'diamond_ore',
            iron: 'iron_ore', gold: 'gold_ore', coal: 'coal_ore',
            emerald: 'emerald_ore', redstone: 'redstone_ore',
            lapis: 'lapis_ore', copper: 'copper_ore', netherite: 'ancient_debris',
            obsidian: 'obsidian', stone: 'stone', wood: 'oak_log', logs: 'oak_log',
            dirt: 'dirt', sand: 'sand'
        };
        const mine = t.match(/\b(?:mine|dig|get me|find|go get)\s+(?:some\s+)?(\w+)/);
        if (mine && oreMap[mine[1]]) {
            return { action: 'mine', target: oreMap[mine[1]] };
        }
        // collect / gather
        const collect = t.match(/\b(?:collect|gather|grab|pick up)\s+(?:some\s+)?(\w+)/);
        if (collect) {
            return { action: 'collect', target: oreMap[collect[1]] || collect[1] };
        }
        // craft
        const craft = t.match(/\b(?:craft|make|build me)\s+(?:a\s+|an\s+|some\s+)?([\w ]+)/);
        if (craft && /\b(pickaxe|sword|axe|shovel|table|furnace|chest|boat|bed|torch)\b/.test(t)) {
            return { action: 'craft', target: craft[1].trim().replace(/\s+/g, '_') };
        }
        // move to coords. two numbers are x and z - the way a destination is
        // actually said out loud - and three are x y z. the y is optional the
        // whole way down: travel walks to the COLUMN and lands on whatever
        // ground is there, so insisting on a height only ever refused people.
        const coords = t.match(TRAVEL_COORD_RE);
        if (coords) {
            const nums = coords.slice(1, 4).filter((n) => n !== undefined).map(Number);
            if (nums.every(Number.isFinite)) {
                const [rawX, rawY, rawZ] = nums.length === 3 ? nums : [nums[0], null, nums[1]];
                const x = Math.round(rawX);
                const z = Math.round(rawZ);
                if (Math.abs(x) <= WORLD_EDGE && Math.abs(z) <= WORLD_EDGE) {
                    const params = { x, z, target: `${x}, ${z}` };
                    if (rawY !== null) params.y = Math.round(rawY);
                    return { action: 'move', params };
                }
            }
        }
        // "put your armor on" / "armor up" / "gear up". a real instruction people give
        // her constantly in game, and it used to fall through to freeform - which meant
        // her brain had to guess the tool call, guessed a target-less equip, and the
        // bridge answered "no built-in task for equip". mapped explicitly so it just
        // happens; _dispatchAction resolves which pieces from her inventory.
        if (/\b(?:armou?r|gear)\s*(?:yourself\s*)?up\b/.test(t)
            || /\b(?:put|throw|get)\s+(?:your|ur|yr|some|that|the)?\s*(?:armou?r|gear)\s+on\b/.test(t)
            || /\b(?:put on|wear|equip)\s+(?:your|ur|yr|some|that|the)?\s*(?:armou?r|gear)\b/.test(t)) {
            return { action: 'equip' };
        }
        if (/\b(?:set up|establish|make|claim|call)\b[^.?!]{0,24}\b(?:toaster\s+)?outpost\b/.test(t)) {
            const named = t.match(/\b(?:called|named)\s+([a-z0-9_' -]{2,40})\s*$/);
            return { action: 'set_outpost', target: named?.[1]?.trim() || 'toaster outpost' };
        }
        const goOutpost = t.match(/\b(?:go|head|walk|travel|return)\s+(?:back\s+)?to\s+(?:the\s+)?(?:toaster\s+)?outpost(?:\s+([a-z0-9_' -]{2,40}))?\s*$/);
        if (goOutpost) return { action: 'go_outpost', target: goOutpost[1]?.trim() || undefined };
        // claiming a home. she should be able to be GIVEN one by the people standing
        // next to her, not only by her own brain - "set your home here", "this is home
        // now", "make this your base". checked before the navigation patterns because
        // "make this home" contains "home" and would otherwise read as "go home".
        if (/\b(?:set|make|call)\b[^.?!]{0,20}\b(?:home|base)\b|\bhome\s+is\s+(?:here|this)\b|\bthis\s+is\s+(?:your|ur|yr)\s+(?:new\s+)?(?:home|base)\b/.test(t)
            && !/\b(?:go|head|come|walk|travel|back)\s+home\b/.test(t)) {
            return { action: 'set_home' };
        }
        // home + saved spots ("go home", "head back to the lava base")
        if (/\b(?:go|head|come|walk|travel)\s+(?:back\s+)?home\b/.test(t)) {
            return { action: 'go_home' };
        }
        const goNamed = t.match(/\b(?:go (?:back )?to|head (?:back )?to|return to)\s+([a-z0-9_' -]{2,40}?)\s*$/);
        if (goNamed) {
            // try the raw phrase first ("the mall" is a legit spot name), then
            // without a leading article
            const phrase = goNamed[1].trim();
            const fav = this.memory.getFavorite(phrase) || this.memory.getFavorite(phrase.replace(/^the\s+/, ''));
            if (fav) return { action: 'move', params: { target: fav.name } };
        }

        return null;
    }

    // does this read as someone asking her to do something? deliberately loose -
    // the cost of a false positive is one extra line in her prompt that she can
    // ignore; the cost of a false negative is a real person being ignored.
    _looksLikeRequest(text) {
        const t = String(text || '').trim();
        if (t.length < 4 || t.length > 200) return false;
        if (REQUEST_SHAPE_RE.test(t)) return true;
        // saying her name in a room full of people is deliberate. anything but a bare
        // greeting is almost always aimed at her and usually wants something.
        return CHAT_ADDRESSED_RE.test(t) && !GREETING_ONLY_RE.test(t);
    }

    recordViewerSuggestion(username, text, { inGame = false } = {}) {
        // only trust the name as a minecraft username when the line came from
        // server chat - a twitch handle is not a player and must never become a
        // follow target.
        let suggestion = this.interpretChatCommand(text, inGame ? username : null);

        // where she LIVES is hers to choose. dropping the parsed verb (rather than the
        // whole line) turns "make this your home" into a freeform ask she hears and
        // answers herself - so a stranger cannot plant her house by typing one line,
        // and the request is not silently swallowed either.
        if (suggestion && ['set_home', 'set_outpost'].includes(suggestion.action)) suggestion = null;

        // "stand still" from someone STANDING NEXT TO HER in the world is the most
        // basic cooperation primitive there is - they are trying to hand her items or
        // build around her - and refusing it is most of why she reads as unable to take
        // direction. an admin asked twice tonight and got silence. stream chat still
        // cannot halt her (a twitch handle is not in the room), but it degrades to a
        // freeform ask she can answer rather than vanishing.
        if (suggestion && suggestion.action === 'stop' && !inGame) suggestion = null;

        // A plain chat request must never turn into an immediate dangerous or
        // disruptive action. Player attacks, giving items away, and chat messages are
        // handled only by an explicit operator/model tool call.
        if (suggestion && ['attack', 'give', 'chat'].includes(suggestion.action)) return null;

        // anything ELSE someone asks her to do still counts as a request, even
        // when it matches no built-in verb. this used to `return null` on an
        // unparsed line, so "come mine with me" or "build me a house" vanished
        // and she never knew she'd been asked. she has the whole tool available
        // and is far better at reading intent than a regex - so surface it and
        // let HER decide whether to do it, adapt it, or say no.
        if (!suggestion && !this._looksLikeRequest(text)) return null;

        const user = String(username || 'chat').trim().slice(0, 32) || 'chat';
        const cooldownKey = user.toLowerCase();
        const now = Date.now();
        const previous = this.viewerSuggestionCooldowns.get(cooldownKey) || 0;
        if (now - previous < VIEWER_SUGGESTION_COOLDOWN_MS) return null;
        if (this.viewerSuggestionCooldowns.size >= 500) {
            const cutoff = now - VIEWER_SUGGESTION_COOLDOWN_MS;
            for (const [key, at] of this.viewerSuggestionCooldowns) {
                if (at < cutoff) this.viewerSuggestionCooldowns.delete(key);
            }
        }
        this.viewerSuggestionCooldowns.set(cooldownKey, now);

        const entry = {
            user,
            text: String(text).trim().slice(0, 180),
            // null action = freeform ask. her brain picks the tool call, or declines.
            action: suggestion?.action || null,
            target: suggestion?.target || suggestion?.params?.target || null,
            params: suggestion?.params || {},
            freeform: !suggestion,
            // whether this came from somebody standing in the world (a real player
            // record) or from stream chat (a handle, not a minecraft person)
            inGame: !!inGame,
            at: now
        };
        this.viewerSuggestions.push(entry);
        if (this.viewerSuggestions.length > MAX_VIEWER_SUGGESTIONS) this.viewerSuggestions.shift();
        // an ask survived only ten minutes in RAM, so "you never did the thing i asked"
        // had no possible answer. only in-game asks become a player record: a twitch
        // handle is not somebody standing in the world.
        if (inGame) this._rememberPlayerDurably('request', user, { text: entry.text, action: entry.action });
        this.emit('viewerSuggestion', entry);
        return entry;
    }

    getViewerSuggestions() {
        const cutoff = Date.now() - (10 * 60 * 1000);
        this.viewerSuggestions = this.viewerSuggestions.filter((entry) => entry.at >= cutoff);
        return this.viewerSuggestions.slice(-4);
    }

    // ---- autonomous behavior --------------------------------------------

    _startAutonomousLoop() {
        if (this.autonomousTimer) return;
        this.autonomousTimer = setInterval(() => this._autonomousTick(), this.config.autonomousTickMs);
        if (this.autonomousTimer.unref) this.autonomousTimer.unref();
    }

    _urgentSafetyBehavior(now = Date.now()) {
        const g = this.gameState;
        const health = Number(g.health);
        const hunger = Number(g.hunger);
        const air = Number(g.air);
        const maxAir = Math.max(1, Number(g.maxAir) || 300);
        const hostiles = Number(g.nearbyHostiles) || 0;
        const hasFood = FOOD_RE.test(this._carrying());

        // AltoClef's survival chain knows how to escape lava/water and handle
        // immediate mobs. What Burnt must do is stop insisting on the old goal
        // long enough for that survival logic to take control.
        if (g.inLava || (g.underwater && Number.isFinite(air) && air / maxAir <= 0.2)) {
            return {
                action: null,
                params: {},
                say: 'dropping the plan. survival first, ambitions later'
            };
        }
        if (Number.isFinite(health) && health > 0 && health <= 8) {
            // WITH FOOD, EAT. this used to return action:null while SAYING "backing off
            // long enough to eat and regenerate" - so she announced a meal, issued
            // nothing, and waited for FoodChain to save her. FoodChain only auto-eats
            // when needsToEat() is true (health <= 10 AND foodLevel <= 19), so on a
            // full stomach at 8hp it never fires: she parked, and _requestSafetyIntervention
            // re-stopped her every 12s forever. found live 2026-08-01 with a diamond
            // pickaxe, food in the bag, 8hp, staring at a crafting table for minutes.
            // ...but only while eating is a thing that actually happens. this
            // branch used to return `eat` on EVERY tick with no gate at all, so
            // when the game answered "nothing edible in the inventory" (it does:
            // the food chain's has-food cache goes stale whenever she is idle)
            // she reissued the same doomed eat forever and the tick returned
            // before anything else could run. that is the freeze, not the eat.
            if (hasFood && this._eatIsWorth(now)) {
                this._lastEatAttemptAt = now;
                return {
                    action: 'eat',
                    params: this._eatParams(),
                    say: 'i am not finishing this job this hurt. eating before anything else'
                };
            }
            // no food on her at all: this is a GATHER (`@food n`), a real task
            // with a real completion - not the instant eat that can fail into a
            // loop. it keeps no gate on purpose. going to look for food while
            // hurt and hungry is always better than standing still, and the
            // ceiling in _autonomousTick is what stops it if it stops working.
            if (!hasFood && Number.isFinite(hunger) && hunger < 19) {
                return {
                    action: 'eat',
                    params: this._eatParams(),
                    say: 'i am not finishing this job this hurt with no food. backing off and finding something edible'
                };
            }
            // NOTHING USEFUL TO ISSUE. this is the only branch that may legitimately
            // do nothing - and it must EXPIRE. a "stand still until things are sane"
            // instruction with no exit condition is indistinguishable from a hang, and
            // standing at 8hp is not safer than getting on with something.
            if (!this._lowHealthParkedAt) this._lowHealthParkedAt = now;
            if (now - this._lowHealthParkedAt > LOW_HEALTH_PARK_MAX_MS) return null;
            return {
                action: null,
                params: {},
                say: hostiles
                    ? 'no food and too hurt for heroics. aborting the job and letting them pass'
                    : 'too hurt to keep forcing this. pausing until the situation is sane'
            };
        }
        // healthy again (or at least off the floor): the park may start over next time
        this._lowHealthParkedAt = 0;
        if (Number.isFinite(hunger) && hunger <= 4) {
            // hasFood used to mean action:null here - she announced a food break
            // and then did NOTHING, over and over, while holding bread.
            //
            // an eat that does not move the hunger bar must NOT be retried every
            // tick: that burned every 25s cycle on a no-op and looked exactly
            // like standing still doing nothing. back off instead, so the rest of
            // the idle brain gets its turn.
            if (!this._eatIsWorth(now)) return null;
            this._lastEatAttemptAt = now;
            return {
                action: 'eat',
                params: this._eatParams(),
                say: hasFood
                    ? 'actual food break before i turn this into a death march'
                    : 'food is now the whole mission. finding some before i starve'
            };
        }
        if (hostiles >= 4 && Number.isFinite(health) && health <= 11) {
            return {
                action: null,
                params: {},
                say: 'that is too many mobs for this health bar. abandoning the goal and surviving the crowd'
            };
        }
        return null;
    }

    // is issuing another `eat` worth the tick? two things make it not: the last
    // one is too recent to have moved the hunger bar yet, or the game has been
    // refusing them outright. the second case matters more than it looks - an
    // eat is the one safety answer that can fail silently and permanently (the
    // in-game food chain reports "nothing edible" from a cache that goes stale
    // while she is idle), and the safety branch that issues it returns before
    // every other behaviour. an eat nobody checks is how she froze.
    _eatIsWorth(now = Date.now()) {
        if (this._eatFailStreak >= EAT_FAIL_STREAK_LIMIT &&
            now - this._lastEatFailureAt < EAT_FAIL_BACKOFF_MS) return false;
        return now - this._lastEatAttemptAt >= EAT_RETRY_GAP_MS;
    }

    // remember whether eating actually works, so _eatIsWorth can stop offering it
    _noteEatOutcome(ok) {
        if (ok) {
            this._eatFailStreak = 0;
            return;
        }
        this._eatFailStreak++;
        this._lastEatFailureAt = Date.now();
        if (this._eatFailStreak === EAT_FAIL_STREAK_LIMIT) {
            this.log('warn', `eating has failed ${this._eatFailStreak}x - treating food as unavailable for ${Math.round(EAT_FAIL_BACKOFF_MS / 60000)}min so it stops eating every tick`);
            this.recentEvents.record('tried to eat and the food never made it to my mouth');
        }
    }

    _requestSafetyIntervention(action, params = {}, say = null) {
        const now = Date.now();
        if (this._safetyIntervention ||
            now - this._lastSafetyInterventionAt < SAFETY_INTERVENTION_COOLDOWN_MS) {
            return false;
        }
        if (action && (this.currentAction === action || this.activeGoal?.action === action)) return false;
        this._lastSafetyInterventionAt = now;
        if (say) this._pushCommentary(say);

        this._safetyIntervention = (async () => {
            const hasPendingTask = [...this.pendingActions.values()]
                .some((pending) => !NON_TASK_ACTIONS.has(pending.action));
            const busy = this.currentAction || this.currentTask || this.activeGoal || hasPendingTask;
            if (busy) {
                try {
                    await this.executeAction('stop', {}, {
                        priority: 'urgent',
                        source: 'safety',
                        timeoutMs: 30000
                    });
                } catch (err) {
                    this.log('warn', `safety stop failed: ${err.message}`);
                    return;
                }
            }
            if (!action || !this.connected || !this.gameConnected || this._stateIsStale()) return;
            await this.executeAction(action, params, {
                priority: 'urgent',
                source: 'safety',
                waitForCompletion: false
            });
        })().catch((err) => {
            this.log('warn', `safety intervention failed: ${err.message}`);
        }).finally(() => {
            this._safetyIntervention = null;
        });
        return true;
    }

    // repeated protection denials mid-goal: claimed land never unclaims itself.
    // stop the goal, avoid re-picking it, and walk 400-900 blocks in a random
    // direction - community-server claims cluster around spawn/towns, so real
    // distance is the only reliable way out.
    _escapeProtectedArea() {
        if (this._escapingProtection) return;
        const now = Date.now();
        if (now - this._lastProtectionEscapeAt < 60000) return;
        this._lastProtectionEscapeAt = now;
        this._escapingProtection = true;
        this._protectionDenials = [];
        const failedAction = this.activeGoal?.action || this.currentAction || null;
        if (failedAction && !NON_TASK_ACTIONS.has(failedAction)) {
            this._avoidAction = failedAction;
            this._avoidUntil = now + LOOP_AVOID_MS * 2;
            try { this.memory.recordFailure(failedAction, this.activeGoal?.params?.target, 'blocked by server protection (claimed land)'); } catch { /* best-effort */ }
        }
        this._pushCommentary("this land is CLAIMED. noted. leaving before i catch a ban for crimes against farmland");
        (async () => {
            try { await this.executeAction('stop', {}, { priority: 'urgent', source: 'protection', timeoutMs: 30000 }); } catch { /* may not be running */ }
            // this relocation is what first walked her into the ocean on a public
            // server - a blind 400-900 block bearing off a coastal claim. keep it
            // to land.
            const p = this.gameState.position || { x: 0, y: 64, z: 0 };
            const spot = this._pickLandingSpot(p, 400, 900);
            if (!spot) {
                // every heading out of here is sea as far as she knows. she has
                // already stopped and blacklisted the goal - that is enough.
                // walking somewhere on faith is what put her in the ocean.
                this.recentEvents.record('claimed land, but no dry way out that i know of - staying put');
                return;
            }
            await this.executeAction('move', { ...spot, target: 'unclaimed land' }, {
                source: 'protection', waitForCompletion: false
            });
        })().catch((err) => this.log('warn', `protection escape failed: ${err.message}`))
            .finally(() => { this._escapingProtection = false; });
    }

    // OVER the sea without being IN it - i.e. parked on a bridge baritone built to
    // avoid swimming. she is dry and on the ground, so every water check said "fine"
    // while she stood in the middle of an ocean doing nothing, and the route never
    // got recorded as wet so the spot picker would happily send her back across it.
    _isOverWater() {
        return this.gameState.overWater === true;
    }

    _isInWater() {
        const g = this.gameState;
        if (g.inWater === true || g.underwater === true) return true;
        // a bridge over the sea is water as far as "get off it" is concerned. it is
        // NOT swimming, so this deliberately sits above the legacy inference below
        // rather than replacing it.
        if (g.overWater === true) return true;
        // compatibility with an older companion that did not yet emit inWater.
        // defaultGameState seeds inWater:false and _applyState only ever assigns,
        // so `== null` was unreachable and this whole watchdog would have gone
        // silently dark against an old jar. treat "never reported" as unknown.
        // ocean biome alone is insufficient (islands share that biome), so also
        // require airborne sea-level movement.
        return this._sawInWaterField !== true &&
            g.onGround === false &&
            Number(g.position?.y) <= 64 &&
            OCEAN_BIOME_RE.test(String(g.biome || ''));
    }

    // --- coarse terrain memory ------------------------------------------------
    // she cannot see the map, so the only honest source of "there is ocean that
    // way" is where she has personally been wet. cells are 64 blocks so the map
    // stays tiny and still resolves a coastline.
    _cellKey(x, z) {
        return `${Math.floor(x / TERRAIN_CELL)},${Math.floor(z / TERRAIN_CELL)}`;
    }

    // the persisted map is pulled in once, lazily: `memory` is swapped out by the
    // test harness after construction, so the constructor is too early to read it.
    _ensureTerrainLoaded() {
        if (this._terrainLoaded) return;
        this._terrainLoaded = true;
        try {
            const saved = this.memory.getTerrain?.() || {};
            for (const [key, value] of Object.entries(saved)) {
                (value === 'wet' ? this._wetCells : this._dryCells).set(key, 0);
            }
        } catch { /* a missing map just means she learns it again */ }
        try {
            for (const key of Object.keys(this.memory.getClaimedAreas?.() || {})) this._claimedCells.add(key);
        } catch { /* best-effort */ }
        // rehydrate where she has already been sent. without this the search history
        // was ram-only: every burnt restart handed her a blank map and she re-checked
        // ground she had already walked, which is what "it doesn't remember where it
        // already looked" actually was.
        try {
            const now = Date.now();
            for (const v of this.memory.getVisitedSpots?.() || []) {
                const at = Number(v?.at) || 0;
                if (now - at > VISITED_SPOT_TTL_MS) continue;
                this._recentDestinations.push({ x: Number(v.x), z: Number(v.z), at });
            }
            while (this._recentDestinations.length > RECENT_DESTINATION_CAP) this._recentDestinations.shift();
        } catch { /* best-effort */ }
    }

    // the server just told her she may not touch this place. remember the GROUND, not
    // the goal: a claim belongs to the location and outlives whatever she was trying
    // to do there, so blacklisting the action alone sends her straight back.
    _recordClaimHere(point) {
        this._ensureTerrainLoaded();
        const p = point || this.gameState.position;
        if (!p || !Number.isFinite(Number(p.x))) return;
        const x = Number(p.x);
        const z = Number(p.z);
        // a claim is a REGION, not the 64-block cell she happened to be standing in.
        // marking one cell meant the next pick 70 blocks away - still deep inside the
        // same player's base - scored as unclaimed, so she walked back in and got
        // refused again. that is the "it checks places that are obviously claimed"
        // complaint: she was re-testing one claim from every direction. mark the
        // footprint so ONE refusal teaches her the whole plot.
        for (let dx = -CLAIM_SPREAD_CELLS; dx <= CLAIM_SPREAD_CELLS; dx++) {
            for (let dz = -CLAIM_SPREAD_CELLS; dz <= CLAIM_SPREAD_CELLS; dz++) {
                const key = this._cellKey(x + dx * TERRAIN_CELL, z + dz * TERRAIN_CELL);
                if (this._claimedCells.has(key)) continue;
                this._claimedCells.add(key);
                try { this.memory.recordClaimedArea(key); } catch { /* best-effort */ }
            }
        }
    }

    _isClaimedCell(x, z) {
        return this._claimedCells.has(this._cellKey(x, z));
    }

    // the middle of the map she can never own. the companion does not report world
    // spawn, and every server where this matters puts spawn on the origin, so 0,0
    // is the default; MINECRAFT_SPAWN_CENTER moves it and MINECRAFT_SPAWN_EXCLUSION=0
    // switches the whole rule off for a server that has no protected middle.
    _spawnRegion() {
        if (this.gameState.multiplayer !== true) return null;
        if (!(SPAWN_EXCLUSION_RADIUS > 0)) return null;
        return { x: SPAWN_EXCLUSION_CENTER.x, z: SPAWN_EXCLUSION_CENTER.z, radius: SPAWN_EXCLUSION_RADIUS };
    }

    // HOW FAR OUT OF THE BOX IS THIS POINT. chebyshev, because the region is a
    // cuboid: leaving it means pushing max(|dx|,|dz|) past the radius, and no
    // amount of diagonal travel does that faster than going straight at a wall.
    // every "am i getting out" question must use THIS and not a radius.
    _spawnDepth(x, z) {
        const region = this._spawnRegion();
        if (!region) return Infinity;
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return Infinity;
        return Math.max(Math.abs(px - region.x), Math.abs(pz - region.z));
    }

    _inSpawnRegion(x, z) {
        const region = this._spawnRegion();
        if (!region) return false;
        return this._spawnDepth(x, z) <= region.radius;
    }

    // is she standing in it RIGHT NOW? a missing position is not a yes - the rest
    // of the tick falls back to a placeholder 0,0,0 that sits dead centre.
    //
    // AND: if her HOME is in there, the rule stands down entirely. someone put it
    // there deliberately and the server evidently allows it, so refusing to work
    // at her own house - or worse, marching her back out every time she arrives -
    // would be this fix picking a fight with a human decision.
    _standingInSpawnRegion() {
        const p = this._point(this.gameState.position);
        if (!p || !this._inSpawnRegion(p.x, p.z)) return false;
        const home = this._home();
        if (home && this._inSpawnRegion(home.position?.x, home.position?.z)) return false;
        return true;
    }

    // where an action's work would actually LAND, or null when it just happens
    // wherever she is standing (a wood run, a stone run, a craft).
    _actionTargetPoint(params) {
        const x = Number(params?.x);
        const z = Number(params?.z);
        if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
        if (params?.settlementId) {
            try {
                const settlement = this.memory.getSettlement(params.settlementId);
                const anchor = settlement?.anchor || settlement?.origin;
                if (anchor && Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.z))) {
                    return { x: Number(anchor.x), z: Number(anchor.z) };
                }
            } catch { /* an unknown id just means "no target", never a crash */ }
        }
        return null;
    }

    // the one rule: get clear of the spawn region before doing anything in it.
    // returns a refusal string (so her brain HEARS why and can say so) or null.
    _spawnRegionRefusal(action, source, params) {
        if (!SPAWN_REGION_GATED_SOURCES.has(source || 'agent')) return null;
        const act = String(action || '').trim().toLowerCase();
        if (!act || SPAWN_REGION_ALLOWED_ACTIONS.has(act) || NON_TASK_ACTIONS.has(act)) return null;
        const region = this._spawnRegion();
        if (!region || !this._standingInSpawnRegion()) return null;
        // WHERE THE WORK LANDS, NOT WHERE HER BODY IS.
        //
        // The rule is about GROUND she is not allowed to touch. Her own house can
        // be a thousand blocks outside the region while she is 108 blocks from
        // spawn walking back to it - and refusing `build_settlement` there is
        // refusing her to build her own home, on land nobody has any objection to,
        // because of where she happened to be standing when she decided to.
        // An action that names ground outside the region is always fine.
        // A stone run names nothing, so it stays gated - that was the whole
        // point, and it is still the thing that was felling the server's trees.
        const target = this._actionTargetPoint(params);
        if (target && !this._inSpawnRegion(target.x, target.z)) return null;
        const p = this._point(this.gameState.position);
        const out = Math.round(this._spawnDepth(p.x, p.z));
        return `not here - everything within ${region.radius} blocks of spawn belongs to the server ` +
            `(she is ${out} out). walk clear of it first, then ${act}`;
    }

    _isRejectedCell(x, z) {
        return this._rejectedCells.has(this._cellKey(x, z));
    }

    /**
     * SHE LOOKED AT THIS GROUND AND SAID NO. Remember that.
     *
     * Nothing did, before: a site turned down for bad footing or no room was
     * forgotten the moment she walked off, and the spot picker - which only ever
     * hard-excluded SERVER-refused land - would happily send her straight back
     * to assess it again. That is the "she keeps going to the same spot" loop,
     * and it is not even a bug in the picker: it had no idea the place had been
     * seen. Terrain does not improve while she is away.
     *
     * Evidence of PEOPLE is stronger than a terrain verdict, so it goes in the
     * claim ledger instead - permanent, persisted, spread over the whole plot,
     * and never waived however desperate the search gets.
     */
    _recordSiteRejection(point, reasons = []) {
        const p = point || this.gameState.position;
        if (!p || !Number.isFinite(Number(p.x))) return;
        if (reasons.some((reason) => /people have built here/.test(String(reason)))) {
            this._recordClaimHere(p);
            return;
        }
        // transient reasons say nothing about the ground - a wandering skeleton
        // or a player walking past must not condemn a good site forever.
        const aboutTheGround = reasons.some((reason) => SITE_GROUND_REASONS.test(String(reason)));
        if (!aboutTheGround) return;
        this._ensureTerrainLoaded();
        const key = this._cellKey(Number(p.x), Number(p.z));
        if (this._rejectedCells.has(key)) return;
        this._rejectedCells.add(key);
        while (this._rejectedCells.size > REJECTED_CELL_CAP) {
            this._rejectedCells.delete(this._rejectedCells.values().next().value);
        }
        this.log('debug', `turned down ground at ${Math.round(p.x)},${Math.round(p.z)}: ${reasons.join(', ')}`);
    }

    // every long-distance destination she commits to, so the spot picker can refuse to
    // send her back where she just came from. this is the anti-ping-pong memory: the
    // scorer REWARDS familiar ground, which means without this the highest-scoring
    // escape from A is always B, and from B is always A, forever.
    _rememberDestination(spot) {
        if (!spot || !Number.isFinite(Number(spot.x))) return;
        // the on-disk history must be in hand before we dedupe against it, or a
        // caller that runs before the first _pickLandingSpot re-adds ground she
        // already walked. cheap: the loader self-guards after the first call.
        this._ensureTerrainLoaded();
        const x = Number(spot.x);
        const z = Number(spot.z);
        const now = Date.now();
        // drop entries that have simply aged out, so the cap is never spent on history
        this._recentDestinations = this._recentDestinations.filter((d) => now - d.at < RECENT_DESTINATION_TTL_MS);
        // REFRESH a place she is revisiting instead of appending a second entry for it.
        // this is load-bearing: a plain ring evicts oldest-first, and during a two-spot
        // bounce the oldest entry IS the spot she must not return to - so it fell out of
        // the ring after a few hops and the ping-pong resumed. one slot per place fixes it.
        for (const d of this._recentDestinations) {
            if (Math.hypot(x - d.x, z - d.z) < RECENT_DESTINATION_RADIUS) {
                d.at = now;
                this._persistVisited(x, z, now);
                return;
            }
        }
        this._recentDestinations.push({ x, z, at: now });
        while (this._recentDestinations.length > RECENT_DESTINATION_CAP) this._recentDestinations.shift();
        this._persistVisited(x, z, now);
    }

    // mirror the search memory to disk. best-effort on purpose: failing to remember
    // is a worse walk, not a broken bot.
    _persistVisited(x, z, at) {
        try { this.memory.recordVisitedSpot?.(x, z, at); } catch { /* best-effort */ }
    }

    _isRecentDestination(x, z, now = Date.now()) {
        for (const d of this._recentDestinations) {
            if (now - d.at > RECENT_DESTINATION_TTL_MS) continue;
            if (Math.hypot(x - d.x, z - d.z) < RECENT_DESTINATION_RADIUS) return true;
        }
        return false;
    }

    // how far a candidate sits from the nearest place she has recently been. used only
    // by the relaxed pass: when her own history has boxed her in, "move anyway" is right
    // but "move straight back to the spot you just left" is the single worst answer, so
    // the fallback maximises distance from history instead of ignoring it.
    _distanceToNearestRecent(x, z, now = Date.now()) {
        let nearest = Infinity;
        for (const d of this._recentDestinations) {
            if (now - d.at > RECENT_DESTINATION_TTL_MS) continue;
            nearest = Math.min(nearest, Math.hypot(x - d.x, z - d.z));
        }
        return nearest;
    }

    _recordTerrainSample(point, wet) {
        this._ensureTerrainLoaded();
        if (!point) return;
        const key = this._cellKey(point.x, point.z);
        const book = wet ? this._wetCells : this._dryCells;
        const other = wet ? this._dryCells : this._wetCells;
        const known = book.has(key);
        book.set(key, Date.now());
        other.delete(key);
        // persist only on a real change - she walks over known ground constantly
        if (!known) {
            try { this.memory.recordTerrainCell(key, wet); } catch { /* best-effort */ }
        }
        if (book.size > TERRAIN_CELL_CAP) {
            // drop the oldest observation; a coastline that moved is not a thing
            const oldest = [...book.entries()].sort((a, b) => a[1] - b[1])[0];
            if (oldest) book.delete(oldest[0]);
        }
    }

    // what sits on the straight line to a candidate point: how much of it is known
    // ocean, and how much is ground she has personally stood on. sampling the ROUTE
    // (not just the endpoint) is the part that matters: baritone will happily swim
    // 600 blocks of sea to reach dry land beyond it.
    _routeTerrain(origin, x, z) {
        const span = Math.hypot(x - origin.x, z - origin.z);
        if (!(span > 0)) return { wet: 0, dry: 1 };
        const steps = Math.min(32, Math.max(2, Math.round(span / TERRAIN_CELL)));
        let wet = 0;
        let dry = 0;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const key = this._cellKey(origin.x + (x - origin.x) * t, origin.z + (z - origin.z) * t);
            if (this._wetCells.has(key)) wet++;
            else if (this._dryCells.has(key)) dry++;
        }
        return { wet: wet / steps, dry: dry / steps };
    }

    _wetnessAlong(origin, x, z) {
        return this._routeTerrain(origin, x, z).wet;
    }

    // "the sea is that way." recorded whenever a swim has to be broken up, so the
    // next idle pick cannot choose the same heading again an hour later.
    // `from` is where she got wet, `toward` is where the water was taking her. a
    // heading needs real separation to mean anything, so a swim that has barely
    // started falls back to the goal she was walking to.
    _rememberDrownedBearing(from, toward) {
        if (!from || !toward) return;
        const dx = Number(toward.x) - Number(from.x);
        const dz = Number(toward.z) - Number(from.z);
        if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
        if (Math.hypot(dx, dz) < 12) return;
        this._drownedBearings.push({ x: from.x, z: from.z, angle: Math.atan2(dz, dx), at: Date.now() });
        while (this._drownedBearings.length > DROWNED_BEARING_CAP) this._drownedBearings.shift();
    }

    _bearingIsDrowned(origin, angle) {
        const now = Date.now();
        this._drownedBearings = this._drownedBearings.filter((b) => now - b.at < DROWNED_BEARING_MS);
        return this._drownedBearings.some((b) => {
            if (Math.hypot(origin.x - b.x, origin.z - b.z) > DROWNED_BEARING_RANGE) return false;
            let diff = Math.abs(angle - b.angle) % (Math.PI * 2);
            if (diff > Math.PI) diff = Math.PI * 2 - diff;
            return diff <= DROWNED_BEARING_ARC;
        });
    }

    // a destination she already knows is water. checked for every goal source,
    // including her own brain and anything a viewer asks for.
    _destinationIsWet(params) {
        this._ensureTerrainLoaded();
        const x = Number(params?.x);
        const z = Number(params?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
        return this._wetCells.has(this._cellKey(x, z));
    }

    // closest cell she has personally stood on. the escape prefers this over any
    // computed bearing: ground she has walked is ground baritone can reach.
    _nearestDryCell(point) {
        let best = null;
        for (const key of this._dryCells.keys()) {
            const [cx, cz] = key.split(',').map(Number);
            const x = cx * TERRAIN_CELL + TERRAIN_CELL / 2;
            const z = cz * TERRAIN_CELL + TERRAIN_CELL / 2;
            const d = Math.hypot(point.x - x, point.z - z);
            if (d < 24 || d > 1500) continue;
            if (!best || d < best.d) best = { x: Math.round(x), z: Math.round(z), d };
        }
        return best;
    }

    // she just climbed out of the sea. the long random wanders stand down for a
    // moment so the very next idle pick can't fling her straight back in.
    _justLeftWater() {
        return this._isInWater() ||
            (this._lastWaterExitAt > 0 && Date.now() - this._lastWaterExitAt < WATER_EXIT_SETTLE_MS);
    }

    // never carry a swimming y (sea level) into a goto - that aims the path at a
    // point floating in the ocean. fall back to the last ground she stood on.
    _safeTravelY(origin) {
        const y = Number(origin?.y);
        const swimming = this._isInWater() || !Number.isFinite(y) || y <= 63;
        if (!swimming) return Math.round(y);
        const dry = Number(this._lastDryPosition?.y);
        return Math.round(Number.isFinite(dry) && dry > 63 ? dry : 68);
    }

    // pick a wander destination that is not across / inside known ocean, and that
    // she can recover from if it turns out to be. three hard rules, no scoring:
    //   1. one known-wet cell anywhere on the line kills the candidate outright
    //   2. a heading that already put her in the sea is dead for the next 45min
    //   3. a route she knows nothing about is clipped to BLIND_WANDER_MAX - only
    //      a corridor she has personally walked earns a long march
    // returns null when nothing survives. every caller treats that as "skip this
    // pick": standing still is strictly better content than swimming.
    // `opts.notInSpawnRegion` refuses ground inside the server's protected middle;
    // `opts.awayFrom` demands each candidate put real distance between her and a
    // point. Both are OPT-IN and only the home-site callers pass them - a flee, a
    // water escape or a viewer's goto must still be free to cross the map's centre.
    _pickLandingSpot(origin, minDist, maxDist, opts = {}) {
        this._ensureTerrainLoaded();
        const p = { x: Number(origin?.x) || 0, z: Number(origin?.z) || 0 };
        const y = this._safeTravelY(origin);
        const lo = Math.max(16, Math.min(Number(minDist) || 0, Number(maxDist) || 0));
        const hi = Math.max(lo, Number(maxDist) || lo);
        // claims are HARD (she is not allowed there) but "I was just there" is SOFT:
        // if honouring it leaves her nowhere to go she should still move rather than
        // stand still, which is the failure this whole fix exists to remove.
        const scan = (strict) => {
            let best = null;
            for (let i = 0; i < LANDING_SPOT_TRIES; i++) {
                const angle = Math.random() * Math.PI * 2;
                if (this._bearingIsDrowned(p, angle)) continue;
                let dist = lo + Math.random() * (hi - lo);
                let x = Math.round(p.x + Math.cos(angle) * dist);
                let z = Math.round(p.z + Math.sin(angle) * dist);
                let route = this._routeTerrain(p, x, z);
                if (dist > BLIND_WANDER_MAX && route.dry < KNOWN_ROUTE_MIN_DRY_FRACTION) {
                    dist = BLIND_WANDER_MAX;
                    x = Math.round(p.x + Math.cos(angle) * dist);
                    z = Math.round(p.z + Math.sin(angle) * dist);
                    route = this._routeTerrain(p, x, z);
                }
                if (route.wet > 0) continue;
                if (this._wetCells.has(this._cellKey(x, z))) continue;
                // land she is not allowed to touch is not a destination, however dry it is
                if (this._isClaimedCell(x, z)) continue;
                // nor is ground she already walked out to and turned down. this is
                // a HARD exclusion in both passes on purpose: the relaxed pass
                // exists to stop her standing still, and re-walking to a site she
                // has already judged is not movement, it is the loop the operator kept
                // watching. terrain does not improve while she is away.
                if (this._isRejectedCell(x, z)) continue;
                if (strict && this._isRecentDestination(x, z)) continue;
                // dry, reachable, and never hers. checked AFTER the blind-route
                // clamp, because clamping is what moves a candidate back inside.
                if (opts.notInSpawnRegion && this._inSpawnRegion(x, z)) continue;
                // SHE IS WALKING OUT OF SOMEWHERE. `outward.depth` is whatever
                // metric the caller has to beat - for the spawn region that is
                // CHEBYSHEV distance, because the region is a cuboid and the
                // distance she must actually cover to leave one is max(|dx|,|dz|).
                // measuring it as a radius (hypot) is why a diagonal hop passed
                // the outward test having gained 70 blocks of the 580 she needed.
                let gain = 0;
                if (opts.outward) {
                    gain = opts.outward.depth(x, z) - opts.outward.here;
                    // and it has to be MOSTLY outward, not technically outward:
                    // a fraction of the hop's own length, so a 200-block walk
                    // cannot bank 60 blocks of progress and call it a march.
                    const need = Math.max(opts.outward.min || 0, (opts.outward.fraction || 0) * dist);
                    if (gain < need) continue;
                }
                let score = route.dry + (this._dryCells.has(this._cellKey(x, z)) ? 0.5 : 0);
                if (opts.outward) {
                    // GAIN DOMINATES, familiarity is only a tiebreak. it was the
                    // other way round (dry+known = 1.5 against gain/600 = 0.33),
                    // so the best-scoring "escape" was reliably a short hop back
                    // onto ground she had already walked. that is not an escape.
                    score = gain + score * 20;
                }
                if (!strict) {
                    // relaxed pass: get as far from her own recent history as the
                    // terrain allows, rather than accepting the first thing going
                    const away = this._distanceToNearestRecent(x, z);
                    score += Number.isFinite(away) ? Math.min(away, 900) / 900 : 1;
                }
                if (!best || score > best.score) best = { x, z, score };
                // the relaxed pass must compare every candidate; stopping at the first
                // good-enough route is what would hand back the spot she just left.
                // an outward march must compare them all too - the first acceptable
                // hop is rarely the longest one, and here length IS the point.
                if (strict && !opts.outward && route.dry >= KNOWN_ROUTE_MIN_DRY_FRACTION) break;
            }
            return best;
        };
        const best = scan(true) || scan(false);
        if (!best) return null;
        // the spot she is walking away from counts as recently-occupied too, or the
        // very first hop back to it is never refused
        if (lo >= LONG_RELOCATION_MIN) this._rememberDestination(p);
        this._rememberDestination(best);
        return { x: best.x, y, z: best.z };
    }

    _resetWaterWatch() {
        this._waterSinceAt = 0;
        this._waterContinuousSince = 0;
        this._waterAnchor = null;
        this._waterEntryPosition = null;
        this._waterTrail = [];
        this._waterEscapeIndex = 0;
        this._waterEscapeInFlight = false;
        this._waterEscapeDest = null;
        this._waterEscapeIssuedAt = 0;
        this._waterEscapeBestDist = Infinity;
        this._waterEscapeProgressAt = 0;
    }

    _observeWaterState(now = Date.now()) {
        const point = this._point(this.gameState.position);
        if (!this._isInWater()) {
            if (point && this.gameState.onGround !== false) {
                this._lastDryPosition = {
                    ...point,
                    dimension: this.gameState.dimension
                };
                this._recordTerrainSample(point, false);
            }
            if (this._waterSinceAt) this._lastWaterExitAt = now;
            this._resetWaterWatch();
            this._lastWaterEscapeAt = 0;
            return;
        }
        if (!point) return;
        this._recordTerrainSample(point, true);
        if (!this._waterSinceAt) {
            this._waterSinceAt = now;
            this._waterContinuousSince = now;
            this._waterAnchor = { x: point.x, z: point.z };
            this._waterEntryPosition = { ...point };
            this._waterTrail = [{ ...point, at: now }];
            return;
        }
        const last = this._waterTrail.at(-1);
        if (!last || Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z) >= 0.5 || now - last.at >= 5000) {
            this._waterTrail.push({ ...point, at: now });
        }
        const cutoff = now - WATER_TRAIL_WINDOW_MS;
        while (this._waterTrail.length > 2 && this._waterTrail[1].at < cutoff) {
            this._waterTrail.shift();
        }
    }

    _waterTrailMetrics(now = Date.now()) {
        const samples = this._waterTrail.filter((sample) => sample.at >= now - WATER_TRAIL_WINDOW_MS);
        if (samples.length < 2) return { durationMs: 0, path: 0, displacement: 0, efficiency: 1 };
        let path = 0;
        for (let i = 1; i < samples.length; i++) {
            path += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
        }
        const first = samples[0];
        const last = samples.at(-1);
        const displacement = Math.hypot(last.x - first.x, last.z - first.z);
        return {
            durationMs: last.at - first.at,
            path,
            displacement,
            efficiency: path > 0 ? displacement / path : 1
        };
    }

    _waterEscapeDestination(point) {
        const dimension = this.gameState.dimension;
        const distanceTo = (target) => target
            ? Math.hypot(point.x - target.x, point.z - target.z)
            : Infinity;
        const knownDry = this._lastDryPosition;
        if (knownDry && this._dimMatches(knownDry.dimension, dimension) &&
            distanceTo(knownDry) >= 8 && distanceTo(knownDry) <= 1500) {
            return { x: knownDry.x, y: knownDry.y, z: knownDry.z, target: 'the last dry ground' };
        }
        const home = this._home();
        if (home && this._dimMatches(home.dimension, dimension) &&
            distanceTo(home.position) >= 8 && distanceTo(home.position) <= 1500) {
            return {
                x: home.position.x,
                y: home.position.y,
                z: home.position.z,
                target: `home (${home.name})`
            };
        }
        // Retrace the observed water leg before guessing. Unlike a random
        // bearing, this cannot point her back across the circle she just swam.
        const entry = this._waterEntryPosition || this._waterTrail[0];
        if (entry && distanceTo(entry) >= 8) {
            return { x: Math.round(entry.x), y: Math.round(entry.y), z: Math.round(entry.z), target: 'the shoreline route' };
        }
        // nearest cell she has actually stood on beats any guess
        const nearestDry = this._nearestDryCell(point);
        if (nearestDry) {
            return { x: nearestDry.x, y: this._safeTravelY(point), z: nearestDry.z, target: 'ground she has stood on' };
        }
        // with no known land, sweep stable sectors instead of choosing random
        // bearings. the golden-angle step avoids repeatedly reversing course.
        const seed = Math.abs((Math.trunc(point.x) * 73856093) ^ (Math.trunc(point.z) * 19349663));
        const baseAngle = (seed % 360) * Math.PI / 180;
        const angle = baseAngle + this._waterEscapeIndex++ * 2.399963229728653;
        const distance = 160;
        return {
            x: Math.round(point.x + Math.cos(angle) * distance),
            y: this._safeTravelY(point),
            z: Math.round(point.z + Math.sin(angle) * distance),
            target: 'a new shoreline sector'
        };
    }

    // Wading an ocean is the most boring possible content, so it is simply not
    // allowed to persist. This applies to every goal source and every mode.
    _waterWatchdog() {
        if (!this._isInWater()) return false;
        const now = Date.now();
        const p = this._point(this.gameState.position);
        if (!p) return false;
        if (!this._waterSinceAt) {
            this._observeWaterState(now);
            return false;
        }
        const wetFor = now - this._waterContinuousSince;
        const metrics = this._waterTrailMetrics(now);
        const orbiting = metrics.durationMs >= WATER_ORBIT_WINDOW_MS &&
            metrics.path >= WATER_ORBIT_MIN_PATH_BLOCKS &&
            metrics.efficiency <= WATER_ORBIT_MAX_EFFICIENCY;
        const wading = wetFor >= WATER_WADE_LIMIT_MS &&
            metrics.displacement < WATER_PROGRESS_BLOCKS;
        const pastCeiling = wetFor >= WATER_TOTAL_LIMIT_MS;
        if (!orbiting && !wading && !pastCeiling) return false;
        if (this._waterEscapeInFlight || now - this._lastWaterEscapeAt < WATER_ESCAPE_COOLDOWN_MS) return false;
        // an escape already under way and still closing on its destination must be
        // left alone. re-issuing stop+move here (the old behavior, every cooldown
        // tick) is what made her float in place: pastCeiling stays true for the
        // whole swim home, so the escape cancelled itself forever and baritone
        // never arrived. only re-issue once it has genuinely stopped making ground.
        if (this._waterEscapeDest) {
            const gap = Math.hypot(p.x - this._waterEscapeDest.x, p.z - this._waterEscapeDest.z);
            if (gap <= this._waterEscapeBestDist - WATER_ESCAPE_PROGRESS_BLOCKS) {
                this._waterEscapeBestDist = gap;
                this._waterEscapeProgressAt = now;
            }
            const stalled = now - (this._waterEscapeProgressAt || this._waterEscapeIssuedAt) >= WATER_ESCAPE_STALL_MS;
            const arrived = gap <= 4;
            // still swimming home: hold the idle brain off, but do not interrupt
            if (!stalled && !arrived) return true;
            // that destination did not get her out - never offer it again
            this._recordTerrainSample(this._waterEscapeDest, true);
        }
        this._lastWaterEscapeAt = now;
        this._waterEscapeInFlight = true;
        const failed = this.activeGoal?.action || this.currentAction;
        // never blacklist the escape's own move: that armed _avoidAction against
        // the one action that gets her out of the sea.
        if (failed && !NON_TASK_ACTIONS.has(failed) && this.activeGoal?.source !== 'water-escape') {
            this._avoidAction = failed;
            this._avoidUntil = now + LOOP_AVOID_MS;
        }
        // remember the DIRECTION, not just the cells she swam. the trail is a thin
        // line through what is usually a very large ocean; the heading covers the
        // rest of it, so no idle pick an hour from now walks the same way again.
        const entryPoint = this._waterEntryPosition || this._waterTrail[0] || p;
        const goalPoint = this.activeGoal?.params;
        this._rememberDrownedBearing(entryPoint, p);
        if (Number.isFinite(Number(goalPoint?.x)) && Number.isFinite(Number(goalPoint?.z))) {
            this._rememberDrownedBearing(entryPoint, goalPoint);
        }
        const reason = orbiting ? 'swimming in circles' : (pastCeiling ? 'open-water time limit' : 'no shoreline progress');
        this.recentEvents.record(`${reason} - breaking for land`);
        this._pushCommentary('i am NOT ocean content. this is a bread stream. land. NOW.');
        const dest = this._waterEscapeDestination(p);
        this._waterEscapeDest = { x: dest.x, z: dest.z };
        this._waterEscapeIssuedAt = now;
        this._waterEscapeProgressAt = now;
        this._waterEscapeBestDist = Math.hypot(p.x - dest.x, p.z - dest.z);
        (async () => {
            try { await this.executeAction('stop', {}, { priority: 'urgent', source: 'water-escape', timeoutMs: 30000 }); } catch { /* may be idle */ }
            await this.executeAction('move', dest, { source: 'water-escape', waitForCompletion: false });
        })()
            .catch((err) => this.log('warn', `water escape failed: ${err.message}`))
            .finally(() => { this._waterEscapeInFlight = false; });
        return true;
    }

    // act on the newest concrete thing a person asked for. returns true if it
    // took the tick. freeform asks (no built-in verb) are NOT executed here -
    // those need her brain to choose an action, and they still reach her prompt.
    _actOnRequest() {
        if (!this.autonomous) return false;
        if (this._requestIntervention) return true;
        const now = Date.now();
        const fresh = (this.viewerSuggestions || [])
            .filter((s) => s.action && !s.freeform && now - s.at <= REQUEST_ACT_WINDOW_MS)
            .filter((s) => s.at > (this._lastHandledRequestAt || 0));
        const req = fresh[fresh.length - 1];
        if (!req) return false;
        // never stomp an explicit operator/llm goal. an idle-brain pick, or an
        // older request, may be replaced - somebody asking for something new
        // should not be refused because somebody asked earlier.
        const active = this.activeGoal;
        if (active && active.source && !['autonomous', 'request'].includes(active.source)) return false;
        // already doing exactly this
        if (active && active.action === req.action &&
            String(active.params?.target || '') === String(req.target || '')) {
            this._lastHandledRequestAt = req.at;
            return false;
        }
        const params = { ...(req.params || {}) };
        if (req.target) params.target = req.target;
        this.recentEvents.record(`${req.user} asked her to ${req.action}${req.target ? ` ${req.target}` : ''}`);
        this._lastHandledRequestAt = req.at;

        // A finite autonomous goal remains in pendingActions until it really
        // finishes. Sending the request directly therefore just hits the busy
        // guard and loses the request after marking it handled. Retask in two
        // phases: stop only work Burnt herself/request automation owns, wait for
        // the stop ack, then dispatch the person's goal.
        const requestIsTask = !NON_TASK_ACTIONS.has(req.action);
        const pendingTask = [...this.pendingActions.values()]
            .find((pending) => !NON_TASK_ACTIONS.has(pending.action));
        const replaceableWork = requestIsTask && !!(
            (active && ['autonomous', 'request'].includes(active.source)) ||
            (!active && pendingTask && ['autonomous', 'request'].includes(pendingTask.source))
        );
        this._requestIntervention = (async () => {
            if (replaceableWork) {
                await this.executeAction('stop', {}, {
                    priority: 'urgent', source: 'request', timeoutMs: 30000
                });
            }
            if (!this.connected || !this.gameConnected || this.manualControl || this._stateIsStale()) return;
            await this.executeAction(req.action, params, {
                priority: 'normal', source: 'request', waitForCompletion: false,
                // carried so that finishing the job closes THEIR request, not just any
                requestedBy: req.inGame ? req.user : null
            });
            this._pushCommentary(`${req.user} asked, so that's what i'm doing now`);
        })().catch((err) => {
            this.log('warn', `viewer request ${req.action} could not start: ${err.message}`);
        }).finally(() => {
            this._requestIntervention = null;
        });
        return true;
    }

    // A JOB ENDED, SO START THE CLOCK ON THE NEXT ONE.
    //
    // The idle menu is deliberately held back for LLM_GOAL_GRACE_MS so her own
    // reasoned choice leads - but it was only ever CHECKED on the 25s
    // autonomous tick, so a 20-second grace really meant 20 to 50 seconds of
    // standing still, decided by where in the tick the task happened to land.
    // On 2026-08-05 that was 35 seconds, and a spider used seven of them.
    //
    // So the grace now ends on its own schedule instead of waiting to be
    // noticed. One timer, replaced each outcome, cleared on shutdown.
    _noteTaskOutcome() {
        this._lastTaskOutcomeAt = Date.now();
        if (this._idleWakeTimer) clearTimeout(this._idleWakeTimer);
        this._idleWakeTimer = setTimeout(() => {
            this._idleWakeTimer = null;
            try { this._autonomousTick(); } catch (err) {
                this.log('warn', `idle wake tick: ${err.message}`);
            }
        }, LLM_GOAL_GRACE_MS + 500);
        if (typeof this._idleWakeTimer.unref === 'function') this._idleWakeTimer.unref();
    }

    _autonomousTick() {
        const now = Date.now();
        // A half-open relay socket otherwise looks connected forever. Closing
        // it triggers the relay's controller-loss fail-safe, which stops active
        // game work and reconnects cleanly.
        if (this.connected && this.lastBridgeMessageAt && now - this.lastBridgeMessageAt > BRIDGE_SILENCE_MS) {
            this._setFault('bridge_silent', `minecraft bridge has been silent for ${Math.round((now - this.lastBridgeMessageAt) / 1000)}s`);
            try {
                if (typeof this.client?.terminate === 'function') this.client.terminate();
                else this.client?.close?.();
            } catch { /* close handler owns cleanup */ }
            return;
        }
        if (this.gameConnected && this.lastGameStateAt && now - this.lastGameStateAt > TELEMETRY_FAULT_MS) {
            this._setFault('telemetry_stale', `minecraft client telemetry is ${Math.round((now - this.lastGameStateAt) / 1000)}s old`);
            try {
                if (typeof this.client?.terminate === 'function') this.client.terminate();
                else this.client?.close?.();
            } catch { /* close handler owns cleanup */ }
            return;
        }
        if (!this.enabled || !this.connected || !this.gameConnected) return;
        if (this.manualControl) return; // the operator has the keyboard (f1)
        if (this._stateIsStale()) return;
        this._observeMinecraftState();
        // runs above every early return below, because the two things it records -
        // "she got home" and "the walk home is closing the gap" - both happen WHILE a
        // goal is live, and every gate under this point exists to skip busy ticks.
        this._trackHomeCampaign();
        if (this._waterWatchdog()) return;
        // Goal recovery protects every Burnt-issued finite task, including
        // operator/LLM actions made while autonomous self-play is off.
        if (this._recoverStalledGoal()) return;
        if (this._recoverLoopingGoal()) return;
        // These are ownership/lifecycle invariants, not autonomous choices.
        // A viewer-issued follow/explore and an unowned in-game task must still
        // be bounded when self-play is disabled.
        if (this._recoverPersistentGoal()) return;
        if (this._recoverOrphanTask()) return;
        if (!this.autonomous) return;
        // SAFETY IS NOT ALLOWED TO OWN THE LOOP FOREVER. this branch returns
        // before every other behaviour, so if the situation it reacts to cannot
        // be fixed by the action it picks, she stands still with the safety goal
        // on screen and nothing ever runs again. that is not a hypothetical: a
        // permanently-failing eat at 8hp froze her solid on 2026-08-01. the
        // individual answers already back off; this is the floor under all of
        // them, including ones that don't exist yet.
        const urgentSafety = this._urgentSafetyBehavior(now);
        if (!urgentSafety) {
            this._urgentSafetySince = 0;
            this._urgentSafetyYieldUntil = 0;
        } else if (now >= this._urgentSafetyYieldUntil) {
            if (!this._urgentSafetySince) this._urgentSafetySince = now;
            if (now - this._urgentSafetySince <= URGENT_SAFETY_MAX_MS) {
                this._requestSafetyIntervention(urgentSafety.action, urgentSafety.params, urgentSafety.say);
                return;
            }
            // the ceiling: it has been reacting to the same danger this whole
            // time and is no safer for it. standing still hurt is not safer
            // than getting on with something.
            const held = Math.round((now - this._urgentSafetySince) / 1000);
            this.log('warn', `safety has owned the loop for ${held}s without fixing anything (${urgentSafety.action || 'stand still'}); yielding so she can do something else`);
            this.recentEvents.record('stopped waiting to feel safe and got on with something');
            this._urgentSafetySince = 0;
            this._urgentSafetyYieldUntil = now + URGENT_SAFETY_YIELD_MS;
        }
        // A REAL PERSON ASKED FOR SOMETHING. this used to go nowhere: suggestions
        // were only ever read into her PROMPT, so unless her brain happened to be
        // mid-reply and chose to act, the idle brain just re-picked its own goal
        // 25s later and steamrolled the request. someone saying "come here" and
        // being ignored is the worst possible look on a public server, so an ask
        // now outranks anything the idle menu picked.
        if (this._actOnRequest()) return;
        // don't stack behaviors on top of an active task or a viewer command
        const hasPendingTask = [...this.pendingActions.values()]
            .some((pending) => !NON_TASK_ACTIONS.has(pending.action));
        // HUD/chat/status responses are concurrent controls, not task owners.
        // Letting a lost cosmetic ACK trip this gate can turn 30 seconds of
        // protocol cleanup into 30 seconds of unexplained idling.
        if (this.currentAction || this.currentTask || hasPendingTask) return;
        // a task just finished/failed: the outcome is already queued to burnt's
        // brain, which usually picks what's next. hold the fixed menu back so her
        // reasoned choice leads; the menu is only the fallback for real idle time.
        if (Date.now() - this._lastTaskOutcomeAt < LLM_GOAL_GRACE_MS) return;
        // GET COMPLETELY CLEAR OF THE SPAWN REGION BEFORE DOING ANYTHING IN IT.
        //
        // Every branch below this line touches the world: prep chops wood and
        // mines stone, the rain pull and the homestead arc quarry, the bread
        // tendency farms, the menu collects, and the last resort does a "small
        // wood run". Refusing to SETTLE at spawn (the home-site rule) left all of
        // that running, so she stood in the server's front garden felling its
        // trees. Until she is out, her own autonomy is MOVEMENT ONLY - and this
        // deliberately RETURNS rather than falling through, because falling
        // through is exactly how the wood run got picked.
        //
        // Safety and anything a real person asked for are both already above.
        if (this._standingInSpawnRegion()) {
            // the escape may hand her to go_home, so the campaign that retires a
            // home she can no longer reach has to keep running - it lives below
            // this gate in the normal flow and would never get a tick otherwise.
            const homeVerdict = this._homeCampaignVerdict();
            if (homeVerdict) this._declareHomeUnreachable(homeVerdict);
            const leave = this._spawnEscapeStep(this._point(this.gameState.position), this._homeRelocation);
            if (leave && this._safeExecute(leave.action, leave.params, leave.say)) {
                this.lastAutonomousAt = Date.now();
            } else if (leave) {
                // refused (usually `move` blacklisted for 2min after a wander abort).
                // bounded and self-clearing, but say so out loud - a quiet return
                // here is the one shape that could read as a freeze.
                this.log('warn', 'in the spawn region and the walk out was refused; waiting rather than working here');
            }
            return;
        }
        // gear up before wandering. the idle menu is pure entertainment picks, so
        // she used to spawn in with nothing, walk into the dark, and get shot by a
        // skeleton with no pickaxe and no food. one prep goal beats one more death.
        const prep = this._survivalPrep();
        if (prep) {
            this._survivalPrepCooldowns.set(prep.key, Date.now());
            if (this._safeExecute(prep.action, prep.params, prep.say)) {
                this.lastAutonomousAt = Date.now();
                return;
            }
        }
        // it's raining on her and she owns a roof. above the homestead arc on
        // purpose: the arc's open-ended errands (site search, stone runs, the
        // frontier) are exactly the outdoor time a person would put off until the
        // weather passed. it holds a 5-minute cooldown, so this is a preference
        // she acts on once and then gets on with her life - not a rule that pins
        // her indoors for the whole storm.
        const shelter = this._rainShelterBehavior();
        if (shelter) {
            if (this._safeExecute(shelter.action, shelter.params, shelter.say)) {
                this.lastAutonomousAt = Date.now();
                return;
            }
            // REFUSED (blacklisted action, busy gate). the pull armed its cooldown
            // on the way out, so charging it for a walk that never started would
            // leave her standing in the rain for five minutes having decided to go
            // inside. give it back - the next tick may well be allowed to move.
            this._homesteadCooldowns.delete('rain_shelter');
        }
        // before the homestead arc gets to send her home AGAIN: has going home
        // stopped working? this is the whole loop-breaker. the arc below re-issues
        // go_home on a 4-minute cooldown forever and has no concept of a route that
        // cannot be walked, so the judgement has to happen above it.
        const verdict = this._homeCampaignVerdict();
        if (verdict) this._declareHomeUnreachable(verdict);
        // No requested goal is active: her standing goal is the homestead. This
        // is deterministic (not a dice-roll menu entry), while safety and every
        // human/LLM task above still preempt it.
        const homestead = this._homesteadBehavior();
        if (homestead) {
            if (this._safeExecute(homestead.action, homestead.params || {}, homestead.say)) {
                this.lastAutonomousAt = Date.now();
                return;
            }
            // REFUSED (blacklisted action, or a home-relocation backoff). the step
            // armed a 4-minute cooldown on its way out, so charging it for work that
            // never happened meant one refusal cost the toaster four minutes AND
            // handed this tick to the wander menu. give the cooldown back: the next
            // tick may well be allowed to build.
            this._releaseHomesteadCooldown();
        }
        // A relocation search may deliberately wait one short cooldown for a fresh
        // site observation. Generic boredom/explore must not carry her hundreds of
        // blocks away while that bounded nearby search is in progress.
        if (this._homeRelocation) return;
        // bread tendency: burnt loves bread. with downtime and wheat on hand she
        // gravitates to baking a loaf (she collects + eats bread). fires ~45% of
        // idle ticks when she has the makings; then the wheat's spent and she moves on.
        // crafting from CARRIED wheat is claim-safe (>=3 in hand, no farm
        // grinding) - on servers she prefers to bake at the homestead, in
        // singleplayer anywhere. hunting wheat lives in the homestead arc.
        if (this._hasWheat() && Math.random() < 0.45 &&
            (this.gameState.multiplayer !== true || this._homeDistance() <= 64)) {
            if (this._safeExecute('craft', { target: 'bread' }, this._breadLine())) {
                this.lastAutonomousAt = Date.now();
                return;
            }
        }
        const behavior = this._pickIdleBehavior();
        if (behavior && this._safeExecute(behavior.action, behavior.params || {}, behavior.say)) {
            this.lastAutonomousAt = Date.now();
            return;
        }
        // NOTHING ABOVE WANTED THE TICK, SO THIS ONE HAS TO.
        //
        // Every branch above can decline: the menu can roll a pick it has no
        // materials for, _safeExecute can refuse a blacklisted action, and the
        // homestead arc goes quiet whenever its one next step is on cooldown or
        // paused. Each of those is individually correct and the sum of them was
        // a bot standing in a field. This used to be reachable ONLY while an
        // action was suppressed for stalling, which is the one case somebody had
        // already been bitten by - the general case just fell off the end of the
        // function and she stood there until the next tick asked again.
        //
        // Standing still is now only ever a DECISION (stop, gamer mode, manual
        // control, a bounded relocation wait) - never the residue of one.
        if (!this._executeLastResort()) {
            this.log('warn', 'idle tick found nothing she is allowed to do - even the fallback was refused');
        }
    }

    // parse the biggest stack count of an item from the compact inventory list
    _inventoryCount(name) {
        const inv = this.gameState.inventory;
        if (!Array.isArray(inv)) return 0;
        let total = 0;
        const want = String(name).toLowerCase();
        for (const it of inv) {
            const s = (typeof it === 'string' ? it : `${it.count ?? it.amount ?? ''} ${it.item ?? it.name ?? ''}`).toLowerCase();
            if (!s.includes(want)) continue;
            const m = s.match(/(\d+)/);
            total += m ? parseInt(m[1], 10) : 1;
        }
        return total;
    }

    _homeDistance() {
        const home = this._home();
        const p = this.gameState.position;
        if (!home || !p || !this._dimMatches(home.dimension, this.gameState.dimension)) return Infinity;
        return Math.hypot(p.x - home.position.x, p.z - home.position.z);
    }

    /** Is there anything over her head right now? */
    _underCover() {
        return this.gameState.skyVisible === false;
    }

    /**
     * Is rain actually landing on HER?
     *
     * The companion answers this properly with isRainingAt (biome, sky and roof
     * aware), but an older deployed jar only sends the global `weather` string -
     * and that string says "rain" in a desert, in a cave, in the nether and
     * under her own roof. So when the good signal is absent, fall back to the
     * string AND the sky check rather than believing the string alone.
     */
    _rainingOnHer() {
        const g = this.gameState;
        if (typeof g.rainingHere === 'boolean') return g.rainingHere;
        const wet = g.weather === 'rain' || g.weather === 'thunder';
        return wet && !this._underCover() && this._dimMatches('overworld', g.dimension);
    }

    /**
     * Get out of the rain.
     *
     * Not a safety rule - rain does not hurt her. It is what a person does, and
     * it gives the weather somewhere to land in her behaviour instead of being
     * one word in a status block she is told not to recite. Returns null when
     * she is already dry, when there is nowhere to be dry, or when she has
     * decided this recently, so it is a pull and never a loop.
     */
    _rainShelterBehavior() {
        if (!this._rainingOnHer()) return null;
        if (this._underCover()) return null;
        const now = Date.now();
        if (now - (this._homesteadCooldowns.get('rain_shelter') || 0) < RAIN_SHELTER_COOLDOWN_MS) return null;
        const home = this._home();
        if (!home || this._homeRelocation) return null;
        const dist = this._homeDistance();
        // already standing on the doorstep: the roof is the fix, not the walk.
        if (!(dist > 12 && dist < RAIN_SHELTER_MAX_DIST)) return null;
        this._homesteadCooldowns.set('rain_shelter', now);
        const thunder = this.gameState.weather === 'thunder';
        return {
            action: 'go_home',
            params: {},
            say: thunder
                ? `it's thundering on me. ${home.name} is ${Math.round(dist)} blocks away and has a roof`
                : `getting rained on. heading back to ${home.name} until it stops`
        };
    }

    // `relax` rises with each failed search attempt. an ideal-site standard that can
    // never be met is worth exactly as much as having no escape hatch at all: on a
    // populated ocean server "no hostiles" and "no players" are close to permanently
    // false, so a strict bar would burn all six attempts, back off fifteen minutes,
    // and drop her straight back into the go-home loop she was escaping.
    // the HARD rules never relax - water, lava, wrong dimension, someone's claim, a
    // fresh protection denial. those are the ones that make a home not a home.
    _homeSiteAssessment(relax = 0) {
        const g = this.gameState;
        const p = this._point(g.position);
        const reasons = [];
        if (!p) reasons.push('no reliable position');
        if (this._dimForMove(g.dimension) !== 'overworld') reasons.push('not in the overworld');
        if (g.onGround === false) reasons.push('not on solid ground');
        if (g.inLava === true) reasons.push('lava');
        if (g.inWater === true || g.underwater === true || g.overWater === true ||
            OCEAN_BIOME_RE.test(String(g.biome || ''))) reasons.push('water');
        const lowY = relax >= 2 ? 40 : 50;
        const highY = relax >= 2 ? 220 : 200;
        if (p && (p.y < lowY || p.y > highY)) reasons.push('awkward elevation');
        if (g.skyVisible === false && relax < 3) reasons.push('no open sky');
        const clearEdge = g.clearEdge == null ? NaN : Number(g.clearEdge);
        // 17 is the 14x9 toaster with elbow room; a cramped-but-dry patch beats
        // a fifth hour of walking at an ocean.
        const wantEdge = relax >= 3 ? 9 : (relax >= 2 ? 12 : (relax >= 1 ? 15 : HOME_SITE_MIN_CLEAR_EDGE));
        if (Number.isFinite(clearEdge) && clearEdge < wantEdge) reasons.push('not enough open room');
        const site = g.homeSite && typeof g.homeSite === 'object' ? g.homeSite : {};
        const wantSupport = relax >= 2 ? 60 : 80;
        const wantSpread = relax >= 2 ? 7 : 4;
        if (Number.isFinite(Number(site.supportPercent)) && Number(site.supportPercent) < wantSupport) reasons.push('uneven footing');
        if (Number.isFinite(Number(site.heightSpread)) && Number(site.heightSpread) > wantSpread) reasons.push('terrain too steep');
        if (Number(site.waterColumns) > 0) reasons.push('water under the footprint');
        // THE YARD SHE WOULD HAVE TO DIG. Ten clear blocks on every wall is a
        // promise kept with a pickaxe, so a site is partly a bill: open ground
        // costs nothing, a copse costs an afternoon of felling, a hillside is a
        // quarry. Reading it BEFORE she commits is the difference between a house
        // and a house with a permanently unfinished job attached to it.
        //
        // Never a reason at full relax. Felling a wood is real work she is
        // capable of, and this must not be the standard that makes a forested
        // continent unsettleable - the yard is a preference, water and claims are
        // the rules.
        const yardFill = Number(site.yardFill);
        const wantYardFill = relax >= 2 ? 2600 : (relax >= 1 ? 1400 : 700);
        if (relax < HOME_SITE_MAX_RELAX && Number.isFinite(yardFill) && yardFill > wantYardFill) {
            reasons.push('the yard here would have to be dug out');
        }
        // hostiles wander past constantly and players walk on; neither says anything
        // permanent about the GROUND. they stop being disqualifying once she has
        // looked at a few patches and found nothing perfect.
        if (Number(g.nearbyHostiles) > 0 && relax < 1) reasons.push('hostiles nearby');
        if (g.multiplayer === true && Number(g.nearbyPlayers) > 0 && relax < 2) reasons.push('other players nearby');
        // SOMEBODY ALREADY LIVES HERE, and this is the one standard that is never
        // relaxed. Until now the ONLY way she learned a place was taken was the
        // server refusing her a block - after she had walked there, settled, and
        // started quarrying someone's wall. On a world with no claim plugin she
        // never learned at all. The companion now reads the actual blocks, so a
        // village or a base is a fact about the ground before she commits to it.
        // She wants elbow room and no neighbours to damage; being desperate for a
        // site is not a reason to move into someone's garden.
        const builtColumns = Number(site.builtColumns);
        const builtNearest = Number(site.builtNearest);
        if (Number.isFinite(builtColumns) && builtColumns > BUILT_GROUND_TOLERANCE) {
            reasons.push(Number.isFinite(builtNearest) && builtNearest >= 0
                ? `people have built here (${builtColumns} spots, nearest ${builtNearest} blocks)`
                : 'people have built here');
        }
        this._ensureTerrainLoaded();
        if (p && this._isClaimedCell(p.x, p.z)) reasons.push('known claim');
        // NEVER RELAXED, like a claim - because it is one, just drawn kilometres
        // wide instead of in 64-block cells. Without this the relocation branch
        // (which forces `farEnough` true) would happily found the toaster on the
        // one piece of ground the server is guaranteed to refuse her.
        if (p && this._standingInSpawnRegion()) reasons.push('inside the server spawn region');
        // ground she has already walked out to and turned down. terrain does not
        // improve while she is away, so re-testing it is the "why does she keep
        // going back to the same spot" loop exactly. Only a maxed-out search may
        // reconsider, and even then never one that people had built on.
        if (p && relax < HOME_SITE_MAX_RELAX && this._isRejectedCell(p.x, p.z)) {
            reasons.push('already turned this ground down');
        }
        this._protectionDenials = this._protectionDenials.filter((at) => Date.now() - at < 60000);
        if (this._protectionDenials.length > 0) reasons.push('recent protection denial');
        // ASSESSMENT IS A PURE READ. It runs every tick on the ground under her
        // feet, so recording a rejection here condemned the spot she was standing
        // on from its first bad reading - including readings that change a moment
        // later (she steps out from under an overhang and the sky comes back).
        // The rejection is recorded where she actually GIVES UP on a site and
        // walks away, which is the only moment that means "I looked, and no".
        return { favorable: reasons.length === 0, reasons, clearEdge: Number.isFinite(clearEdge) ? clearEdge : null };
    }

    /**
     * WALK OUT OF THE SPAWN REGION BEFORE LOOKING AT ANY GROUND.
     *
     * The observed failure: she died, respawned at spawn with her home 4000
     * blocks away, the go-home campaign called that home unreachable, and the
     * nearby-site hunt started - 48-160 blocks a hop, capped 360 blocks from
     * where it began, entirely inside land the server will not let her build on.
     * Six refusals, a fifteen-minute backoff, the go-home failure again, and the
     * same hunt: "heading to a better nearby home site", forever, in a box.
     *
     * So the exit is its own step, and it is a march - an unknown route is still
     * clipped to BLIND_WANDER_MAX, so she crosses the region a hop at a time and
     * each hop only has to earn ground outward.
     */
    _spawnEscapeStep(p, relocation = null) {
        const region = this._spawnRegion();
        // _standingInSpawnRegion, not _inSpawnRegion: it also rejects the missing
        // position the caller papers over with a placeholder 0,0,0 (dead centre of
        // the region - never march away from a guess), and stands the whole rule
        // down when her home is in there on purpose.
        if (!region || !p || !this._standingInSpawnRegion()) return null;
        const now = Date.now();
        // SHE HAS A HOUSE AND IT IS OUTSIDE. Then walking out is not a
        // destination, it is what you do when you haven't got one. Marching her
        // to a random outward point when her own home sits a thousand blocks past
        // the boundary is both slower and stupider than just going there - and it
        // is what the operator was watching. Skipped once the home is under relocation:
        // that means go_home has already been judged unreachable, and the march
        // is exactly the right answer again.
        const home = this._home();
        if (!this._homeRelocation && home && home.position &&
            this._dimMatches(home.dimension, this.gameState.dimension) &&
            !this._inSpawnRegion(home.position.x, home.position.z)) {
            if (now - (this._homesteadCooldowns.get('leave_spawn_region') || 0) < SPAWN_ESCAPE_COOLDOWN_MS) return null;
            this._homesteadCooldowns.set('leave_spawn_region', now);
            return {
                action: 'go_home',
                params: {},
                say: `nothing round spawn is mine to touch. ${home.name} is well outside it, so that's where i'm going`
            };
        }
        if (now - (this._homesteadCooldowns.get('leave_spawn_region') || 0) < SPAWN_ESCAPE_COOLDOWN_MS) return null;
        // the ocean lesson outranks this: a hop out of spawn is not worth a swim
        if (this._justLeftWater()) return null;
        const reach = Math.max(HOME_SEARCH_MIN_DISTANCE + 1, region.radius + SPAWN_ESCAPE_MARGIN);
        const here = this._spawnDepth(p.x, p.z);
        const depth = (x, z) => this._spawnDepth(x, z);
        // A MARCH, IN DESCENDING ORDER OF AMBITION. the first tier is what she
        // should be doing: a hop that spends most of its length going straight at
        // the nearest wall. the tiers below exist because the autonomous tick now
        // RETURNS on this step rather than falling through to work she isn't
        // allowed to do here, so "no good bearing" must never mean "stand in
        // spawn forever" - on a coast every outward line can be sea.
        const tiers = [
            { min: SPAWN_ESCAPE_MIN_GAIN, fraction: 0.55 },   // a real march
            { min: SPAWN_ESCAPE_MIN_GAIN, fraction: 0 },      // an honest step out
            { min: 1, fraction: 0 }                           // anything outward at all
        ];
        let spot = null;
        let outward = true;
        for (const tier of tiers) {
            spot = this._pickLandingSpot(p, HOME_SEARCH_MIN_DISTANCE, reach,
                { outward: { depth, here, ...tier } });
            if (spot) break;
        }
        if (!spot) {
            // nothing outward survives the water rules. keep WALKING (never
            // working) so the next tick rolls its bearings from new ground.
            spot = this._pickLandingSpot(p, HOME_SEARCH_MIN_DISTANCE, Math.min(reach, BLIND_WANDER_MAX));
            outward = false;
        }
        this._homesteadCooldowns.set('leave_spawn_region', now);
        if (!spot) return null;
        if (relocation) {
            // the relocation budget is for LOOKING AT GROUND. crossing a region she
            // was never allowed to build in must not spend it, or the search times
            // out mid-march and hands her straight back into the same box. clearing
            // the origin re-anchors the 360-block search area where the hunt really
            // begins instead of where she happened to respawn.
            relocation.startedAt = now;
            relocation.origin = null;
        }
        const togo = Math.max(0, Math.round(region.radius - here));
        return {
            action: 'move',
            params: { ...spot, target: 'open land past the spawn region' },
            // a sideways re-roll is not progress and must not be narrated as any.
            // she is allowed to sound stuck when she is stuck; she is not allowed
            // to count a lap as ground gained.
            say: outward
                ? `everything within ${region.radius} blocks of spawn is the server's. ${togo} more blocks of other people's ground before i touch anything`
                : `straight out from spawn is water. going sideways to find a line that isn't, still ${togo} blocks of somebody else's land either way`
        };
    }

    _beginNearbyHomeSearch(goal) {
        if (this._homeRelocation) return true;
        if (!this.autonomous || this.manualControl || goal?.source !== 'autonomous') return false;
        if (Date.now() < this._homeRelocationBackoffUntil) return false;
        const home = this._home();
        const where = goal?.params || {};
        if (!home || !this._dimMatches(home.dimension, where.dimension || this.gameState.dimension)) return false;
        if (![where.x, where.z].every(Number.isFinite) ||
            Math.hypot(where.x - home.position.x, where.z - home.position.z) > 3) return false;
        const distance = this._homeDistance();
        if (!Number.isFinite(distance) || distance < HOME_RELOCATION_MIN_DISTANCE) return false;
        this._homeRelocation = {
            from: { ...home, position: { ...home.position } },
            origin: { ...this.gameState.position },
            startedAt: Date.now(), distance, attempts: 0
        };
        this._homesteadCooldowns.delete('venture_out');
        this._homesteadCooldowns.delete('search_nearby_home');
        try {
            this.memory.record('recovery', `started looking for a new home near here after the old route failed`, {
                action: 'move', target: home.name, position: this.gameState.position, dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
        return true;
    }

    // live bookkeeping for the home campaign, run every autonomous tick.
    // arriving is the only thing that proves a home is fine, and it wipes the doubt
    // completely - one bad afternoon must never count against a house she uses daily.
    _trackHomeCampaign() {
        const home = this._home();
        if (!home) return;
        const distance = this._homeDistance();
        if (!Number.isFinite(distance)) return;       // wrong dimension: not evidence of anything
        try {
            if (distance <= HOMESTEAD_NEAR_HOME) {
                if (this.memory.getHomeCampaign(this._worldId(), home.name, HOME_CAMPAIGN_STALE_MS)) {
                    this.memory.clearHomeCampaign();
                    this.log('debug', `arrived at ${home.name}; home route is proven, clearing the unreachable count`);
                }
                return;
            }
            const goal = this.activeGoal;
            const walkingHome = goal && goal.requestedAction === 'go_home';
            if (walkingHome) {
                this.memory.noteHomeProgress(this._worldId(), home.name, distance, HOME_PROGRESS_FRACTION);
            }
        } catch { /* memory is an enhancement, never a reason to stop playing */ }
    }

    // has setting out for home stopped being worth doing? attempts (or a long enough
    // campaign) with no meaningful approach in between. progress rebases the campaign
    // in memory, so reaching this point means she genuinely has not got closer.
    _homeCampaignVerdict() {
        const home = this._home();
        if (!home) return null;
        let campaign = null;
        try {
            campaign = this.memory.getHomeCampaign(this._worldId(), home.name, HOME_CAMPAIGN_STALE_MS);
        } catch { return null; }
        if (!campaign) return null;
        const attempts = Number(campaign.attempts) || 0;
        const elapsed = Date.now() - (Number(campaign.startedAt) || Date.now());
        if (attempts < HOME_UNREACHABLE_ATTEMPTS && elapsed < HOME_UNREACHABLE_CAMPAIGN_MS) return null;
        return { home, attempts, elapsed, bestDistance: Number(campaign.bestDistance) };
    }

    // the give-up. deliberately NOT gated on goal.source or a 1200-block minimum the
    // way the wander-ladder path is: whether she can reach her house has nothing to do
    // with who asked her to walk there, and a home that is unreachable at 400 blocks is
    // exactly as unreachable as one at 2600.
    _declareHomeUnreachable(verdict) {
        if (this._homeRelocation) return true;
        if (!verdict || !this.autonomous || this.manualControl) return false;
        if (Date.now() < this._homeRelocationBackoffUntil) return false;
        const distance = this._homeDistance();
        if (!Number.isFinite(distance) || distance < HOME_UNREACHABLE_MIN_DISTANCE) return false;
        const home = verdict.home;
        const minutes = Math.max(1, Math.round(verdict.elapsed / 60000));
        this._homeRelocation = {
            from: { ...home, position: { ...home.position } },
            origin: { ...this.gameState.position },
            startedAt: Date.now(), distance, attempts: 0, reason: 'campaign'
        };
        this._homesteadCooldowns.delete('venture_out');
        this._homesteadCooldowns.delete('search_nearby_home');
        this._homesteadCooldowns.delete('go_home_for_gallery');
        this._homesteadCooldowns.delete('go_home_for_build');
        try { this.memory.markHomeCampaignDeclared(); } catch { /* best-effort */ }
        try {
            this.memory.recordFailure('go_home', `home (${home.name})`,
                `unreachable: ${verdict.attempts} departures over ${minutes}min never closed the gap`);
            this.memory.record('recovery', 'gave up on an unreachable home and started looking for new ground', {
                action: 'go_home', target: home.name, position: this.gameState.position, dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
        this.log('warn', `home unreachable: ${verdict.attempts} departures over ${minutes}min, still ${Math.round(distance)} blocks out - relocating`);
        this.recentEvents.record(`gave up walking to ${home.name} (${Math.round(distance)} blocks, ${verdict.attempts} tries) and started a new home nearby`);
        this._pushCommentary(`i've set out for ${home.name} ${verdict.attempts} times in ${minutes} minutes and it's still ${Math.round(distance)} blocks away. that route is not happening. new ground, new toaster, starting here.`, 'unreachable');
        this.emit('gameEvent', 'home_unreachable', {
            name: home.name, distance: Math.round(distance), attempts: verdict.attempts, minutes
        });
        return true;
    }

    _claimAutomaticHome(name, note) {
        const p = this._point(this.gameState.position);
        if (!p) return null;
        const old = this._homeRelocation?.from || null;
        if (old && String(old.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()) {
            this.memory.setFavorite(`former ${old.name}`.slice(0, 48), old.position, old.dimension,
                'previous toaster home; its route became unreachable', old.world || this._worldId());
        }
        const entry = this.memory.setHome(name, p, this.gameState.dimension, note, this._worldId());
        if (!entry) return null;
        this._homeRelocation = null;
        this._homeRelocationBackoffUntil = 0;
        this._ensureMainToaster();
        return entry;
    }

    // hand back the cooldown a homestead step armed when the caller then refused to
    // run it. only the key armed by the most recent _homesteadBehavior pass is
    // released, so this can never wipe an unrelated step's genuine cooldown.
    _releaseHomesteadCooldown() {
        if (!this._homesteadArmed) return;
        this._homesteadCooldowns.delete(this._homesteadArmed);
        this._homesteadArmed = null;
    }

    _settlementBuildBehavior(settlement, say = null) {
        if (!settlement) return null;
        if (!this._dimMatches(settlement.dimension, this.gameState.dimension) ||
            settlement.distanceTo(this.gameState.position) > HOMESTEAD_NEAR_HOME) {
            return settlement.role === 'homestead'
                ? { action: 'go_home', params: {}, say: 'going home. the big toaster is the job now' }
                : {
                    action: 'move',
                    params: { ...settlement.anchor, dimension: this._dimForMove(settlement.dimension), target: settlement.name },
                    say: `heading to ${settlement.name} to work on the outpost toaster`
                };
        }
        return {
            action: 'build_settlement',
            params: {
                role: settlement.role,
                settlementId: settlement.id,
                x: settlement.anchor.x, y: settlement.anchor.y, z: settlement.anchor.z,
                width: settlement.width, depth: settlement.depth, height: settlement.height,
                target: settlement.name
            },
            say: say || `building ${settlement.name}: whatever stone i've got, two toast slots, a walk-through, and torches up the walls`
        };
    }

    // Which blocks in the plan are already spoken for.
    //
    // POSITIONS, never a count. The gallery used to be "appliance number N goes
    // in grid cell N", so one lost record shifted every later appliance by a
    // block; the floorplan is a fixed map, so the only honest question is which
    // of its blocks are full. Ovens recorded before this ledger existed still
    // count - the block is occupied whether or not the settlement remembers
    // putting it there.
    _filledApplianceKeys(settlement) {
        const at = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
        const keys = new Set();
        for (const entry of settlement?.appliances || []) {
            if ([entry.x, entry.y, entry.z].every(Number.isFinite)) keys.add(at(entry));
        }
        for (const oven of this.memory.listOvens()) {
            const p = oven.position;
            if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) continue;
            if (!this._dimMatches(oven.dimension, settlement.dimension)) continue;
            if (!settlement.contains(p)) continue;
            keys.add(at(p));
        }
        return keys;
    }

    // The next empty block in the plan, or null once the toaster is furnished.
    // A kind narrows it to that kind's stacks; a kind the map has no square for
    // (campfires, blast furnaces - collection pieces, not toaster parts) gets
    // the first open patch of floor instead of displacing a planned stack.
    _nextApplianceSlot(settlement, kind = null) {
        if (typeof settlement?.applianceSlots !== 'function') return null;
        const all = settlement.applianceSlots();
        const filled = this._filledApplianceKeys(settlement);
        // THE WORLD OUTRANKS THE LEDGER, but only once it has had a look since
        // the last install. A cancelled place still reports finished, so a
        // booked-but-absent appliance would otherwise retire its block from a
        // fixed plan forever; the in-game survey says which slot is REALLY
        // empty and any later booking is dropped. The freshness guard is what
        // stops the opposite error - a survey up to a second stale re-offering
        // the block she just filled.
        const live = this._matchingBuild(settlement);
        const worldNext = Number(live?.nextApplianceIndex);
        const bookedAt = (settlement.appliances || []).reduce((max, e) => Math.max(max, Number(e.at) || 0), 0);
        if (Number.isInteger(worldNext) && Number(live.appliancesRequired) === all.length
            && Number(live.updatedAt) > bookedAt + 2000) {
            // the survey walks the plan in order, so everything before the first
            // empty block is standing and everything from it is not, whatever
            // was booked. -1 means it found none empty: the gallery is finished.
            // ONLY THE PLAN'S OWN BLOCKS are re-judged - the survey says nothing
            // about the open floor, so a campfire or a workbench standing out
            // there keeps its record instead of having its square re-offered.
            const standing = worldNext < 0 ? all.length : worldNext;
            for (const slot of all) filled.delete(`${slot.x},${slot.y},${slot.z}`);
            for (const slot of all.slice(0, standing)) filled.add(`${slot.x},${slot.y},${slot.z}`);
        }
        const free = (slot) => !filled.has(`${slot.x},${slot.y},${slot.z}`);
        const planned = all.filter((slot) => !kind || slot.kind === kind);
        const next = planned.find(free);
        if (next) return next;
        if (!kind || planned.length) return null;
        const spare = toasterOpenFloor(settlement).find(free);
        return spare ? { ...spare, kind, level: 0, unplanned: true } : null;
    }

    _installInSettlement(settlement, kind = null, say = null, resolved = null) {
        const slot = resolved || this._nextApplianceSlot(settlement, kind);
        if (!slot) return null;
        return {
            action: 'install_appliance',
            params: { target: slot.kind, x: slot.x, y: slot.y, z: slot.z, settlementId: settlement.id },
            say: say || this._applianceLine(slot)
        };
    }

    // A stack reads as one object being built, so the line says which course it
    // is on rather than announcing an unrelated appliance three times.
    _applianceLine(slot) {
        const pretty = String(slot.kind).replace(/_/g, ' ');
        if (slot.level === 0 || slot.unplanned) return this._ovenLine(slot.kind, 'place');
        if (slot.level === TOASTER_STACK_HEIGHT - 1) return `${pretty} number three. that stack is finished`;
        return `stacking another ${pretty} on top. they go three high in here`;
    }

    _carriesExact(item) {
        return new RegExp(`(^|[^a-z_])${String(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z_]|$)`).test(this._carrying());
    }

    // the homestead arc is the deterministic idle goal: settle, build the exact
    // toaster shell, then fill its floorplan one block at a time.
    // Viewer/operator/LLM goals still win because this is only called
    // after the task slots are empty.
    _homesteadBehavior() {
        const g = this.gameState;
        const now = Date.now();
        const onCooldown = (key) => now - (this._homesteadCooldowns.get(key) || 0) < HOMESTEAD_STEP_COOLDOWN_MS;
        // the step is armed here but the CALLER may still refuse to run it (a
        // blacklisted action, a home backoff). remember which key this pass armed
        // so a refusal can hand it back - see _releaseHomesteadCooldown.
        this._homesteadArmed = null;
        const arm = (key) => {
            this._homesteadCooldowns.set(key, now);
            this._homesteadArmed = key;
        };
        const home = this._home();
        const p = g.position || { x: 0, y: 64, z: 0 };

        // -- settle: no home yet, or a distant home route was proven unreachable.
        // Relocation searches nearby and keeps the old favorite until a better site
        // is actually verified, so a disconnect cannot erase the last known home.
        const relocation = this._homeRelocation;
        if (!home || relocation) {
            // an exhausted or expired search gives up BEFORE anything is claimed.
            // this check used to sit after the "is this ground good enough" branch,
            // and `relax` climbs with every attempt until it waives the open-sky
            // rule - so a maxed-out search claimed whatever it happened to be
            // standing on and founded the toaster in a hole with no roof line.
            if (relocation) {
                const searchedFor = now - (relocation.startedAt || now);
                if (relocation.attempts >= HOME_SEARCH_MAX_ATTEMPTS || searchedFor >= HOME_RELOCATION_MAX_MS) {
                    this._homeRelocation = null;
                    this._homeRelocationBackoffUntil = now + HOME_RELOCATION_BACKOFF_MS;
                    this.recentEvents.record('kept the old home after the nearby replacement search found no good ground');
                    this._pushCommentary("none of the nearby ground is good enough for the toaster. keeping the old home on the map and dropping this search before it becomes another loop.");
                    return null;
                }
            }
            // SHE IS STANDING IN THE PART OF THE MAP THAT CAN NEVER BE HERS.
            // Assessing ground in here is six guaranteed refusals on a loop, so
            // the walk out comes first and nothing else in this branch runs until
            // she is clear of it. Yielding when there is no dry way out hands the
            // tick to the mood menu - she mines, explores and drifts like a person
            // instead of standing in spawn re-reading the same refused dirt.
            const escape = this._spawnEscapeStep(p, relocation);
            if (escape) return escape;
            if (this._standingInSpawnRegion()) return null;
            const anchor = this._sessionAnchor;
            const anchorDist = anchor ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : 0;
            const farEnough = !!relocation || (g.multiplayer === true
                ? anchorDist >= HOMESTEAD_SETTLE_DIST_MP
                : anchorDist >= HOMESTEAD_SETTLE_DIST_SP);
            // a relocation that has already rejected ground gets progressively less
            // fussy; a first-time settle keeps the full standard. clamped: the ladder
            // in _homeSiteAssessment only defines rungs 0-3, and past that it stops
            // meaning "less fussy" and starts meaning "no standards at all".
            const site = this._homeSiteAssessment(
                relocation ? Math.min(HOME_SITE_MAX_RELAX, relocation.attempts || 0) : 0);
            if (farEnough && site.favorable) {
                const name = relocation?.from?.name || 'the homestead';
                const entry = this._claimAutomaticHome(name,
                    relocation ? 'nearby replacement for an unreachable home; toaster rebuilding' : 'favorable claimed wilderness; ovens pending');
                if (entry) {
                    this.recentEvents.record(`settled: "${entry.name}" is home now (${entry.position.x},${entry.position.z})`);
                    this._pushCommentary(relocation
                        ? "this ground is dry, open, quiet, and reachable. moving home here. the toaster starts again now."
                        : "this is the spot. open sky, room for the toaster, nobody's claims. home.");
                    this.emit('gameEvent', 'homestead_settled', { name: entry.name, position: entry.position });
                    return this._settlementBuildBehavior(this.homeSpec().settlement,
                        'new home claimed. starting the smooth-stone toaster shell before i wander off again');
                }
                return null;
            }
            if (relocation) {
                // (the attempt/time budget is checked at the top of this branch, before
                // any ground can be claimed)
                const lastSearch = this._homesteadCooldowns.get('search_nearby_home') || 0;
                if (now - lastSearch < HOME_SEARCH_STEP_COOLDOWN_MS) return null;
                // the hunt anchors itself where it really begins. it used to anchor
                // where the relocation was declared, which after a march out of the
                // spawn region is a thousand blocks behind her - every candidate
                // then fails the origin-radius test and the search never picks one.
                if (!relocation.origin) relocation.origin = { x: p.x, z: p.z };
                let spot = null;
                for (let i = 0; i < 4 && !spot; i++) {
                    const candidate = this._pickLandingSpot(p, HOME_SEARCH_MIN_DISTANCE, HOME_SEARCH_MAX_DISTANCE,
                        { notInSpawnRegion: true });
                    const origin = relocation.origin || p;
                    if (candidate && Math.hypot(candidate.x - origin.x, candidate.z - origin.z) <= HOME_SEARCH_MAX_ORIGIN_RADIUS) {
                        spot = candidate;
                    }
                }
                // an attempt is a SITE she went and looked at. finding no candidate
                // route is a search failure, not a verdict on the ground - counting it
                // burned all six attempts without her taking a single step whenever she
                // was stranded somewhere the spot picker couldn't see land from.
                if (!spot) {
                    this._homesteadCooldowns.set('search_nearby_home', now);
                    return null;
                }
                relocation.attempts += 1;
                this._homesteadCooldowns.set('search_nearby_home', now);
                // she is walking away from this patch having judged it: remember
                // the verdict so the next candidate is somewhere she has not
                // already stood and said no.
                this._recordSiteRejection(p, site.reasons);
                return {
                    action: 'move',
                    params: { ...spot, target: 'a better nearby home site' },
                    say: `this patch has ${site.reasons.join(', ') || 'bad footing'}. checking better ground nearby, not walking back into that broken route`
                };
            }
            if (onCooldown('venture_out')) return null;
            // she has no home, so this fires constantly - it was the main engine
            // driving her into the ocean over and over on a coastal server.
            if (this._justLeftWater()) return null;
            // GO PROPERLY FAR. these were 500-900 on a server and 150-300 alone,
            // which on an inhabited map is still somebody's back garden - she kept
            // surfacing inside the same settled ring and finding it taken. The
            // BLIND_WANDER_MAX clamp still holds each individual hop to something
            // survivable when the route is unknown, so this reads as "keep going"
            // rather than one reckless leap across an ocean.
            const min = g.multiplayer === true ? VENTURE_MIN_MP : VENTURE_MIN_SP;
            const span = g.multiplayer === true ? VENTURE_SPAN_MP : VENTURE_SPAN_SP;
            const spot = this._pickLandingSpot(p, min, min + span, { notInSpawnRegion: true });
            if (!spot) return null;   // no dry way out - let the mood menu have the tick
            // only the GROUND's fault counts here: `farEnough` being false means
            // she is simply still too close to where she started, which says
            // nothing about this patch and must not condemn it.
            if (!site.favorable) this._recordSiteRejection(p, site.reasons);
            arm('venture_out');
            return {
                action: 'move',
                params: { ...spot, target: 'deeper wilderness' },
                say: 'no home yet. walking out until the world stops belonging to other people'
            };
        }

        // -- construct: exact companion-surveyed shell before furniture.
        const homeDist = this._homeDistance();
        const nb = g.nearby || {};
        const inv = this._carrying();
        const has = (frag) => inv.includes(frag);
        const hasExact = (item) => new RegExp(`(^|[^a-z_])${item}([^a-z_]|$)`).test(inv);
        if (!PICKAXE_TIERS.some((t) => has(`${t}_pickaxe`))) {
            if (!onCooldown('pickaxe')) {
                arm('pickaxe');
                return { action: 'get', params: { target: 'stone_pickaxe', amount: 1 }, say: 'tools first. that much stone needs a pickaxe' };
            }
        }
        const spec = this.homeSpec();
        if (!spec.met) {
            const next = this._settlementBuildBehavior(spec.settlement,
                `main toaster is ${spec.percent}% done. ${this._buildPhaseLabel(spec.phase)}; stone first, appliances after`);
            const key = next?.action === 'build_settlement' ? 'build_main_toaster' : 'go_home_for_build';
            if (next && !onCooldown(key)) {
                arm(key);
                return next;
            }
        }

        // A fresh completed survey is mandatory. If building is cooling down,
        // don't sneak furniture into an unverified shell.
        if (!spec.met) return null;

        if (homeDist > HOMESTEAD_NEAR_HOME && !onCooldown('go_home_for_gallery')) {
            arm('go_home_for_gallery');
            return { action: 'go_home', params: {}, say: 'the shell is ready. going home to fill the middle with furnaces' };
        }

        // A MAINTENANCE LOOK. Re-issuing the build on a finished shell surveys,
        // finds nothing to do and ends - which is exactly the cheap fresh
        // reading the heal in _nextApplianceSlot needs, and it catches creeper
        // damage besides. Attempt-timed, not result-timed: if the reading never
        // arrives this costs one tick every fifteen minutes instead of starving
        // the gallery forever.
        if (Date.now() - Number(this._matchingBuild(spec.settlement)?.updatedAt || 0) > GALLERY_RESURVEY_MS
            && now - (this._lastGalleryResurveyAt || 0) > GALLERY_RESURVEY_MS
            && !onCooldown('gallery_resurvey')) {
            this._lastGalleryResurveyAt = now;
            arm('gallery_resurvey');
            return this._settlementBuildBehavior(spec.settlement,
                'walking the toaster before i add to it. checking nothing got blown up');
        }

        // THE GALLERY IS THE MAP. The floorplan decides what goes in next and
        // where, so this no longer counts furnaces and guesses - it reads the
        // first empty block off the plan and fills it. The wave order means the
        // first three units she ever fits are a chest, a furnace and a smoker,
        // and each column is finished three high before the course above starts.
        const slot = this._nextApplianceSlot(spec.settlement);
        if (slot && !onCooldown(`gallery_${slot.kind}`)) {
            arm(`gallery_${slot.kind}`);
            const pretty = slot.kind.replace(/_/g, ' ');
            // the slot is handed over, never re-derived: the cooldown is already
            // burned by the time this runs, so a second lookup that disagreed
            // would spend four minutes on a null.
            return hasExact(slot.kind)
                ? this._installInSettlement(spec.settlement, null, null, slot)
                : { action: 'get', params: { target: slot.kind, amount: 1 }, say: `getting a ${pretty} for the stack` };
        }

        // THE YARD: ten blocks of air on every wall.
        //
        // Below the gallery on purpose, and interleaved with it rather than ahead
        // of it. The gallery's per-kind cooldowns leave most ticks free, so both
        // still progress - but a yard is the one job whose size the plan cannot
        // know (open ground is already finished, a forest is thousands of blocks),
        // and putting it first would let one treeline starve the furnaces forever.
        if (!spec.yardClear && !onCooldown('clear_yard')) {
            const left = Number(spec.yardRemaining);
            // Did the LAST trip out there actually move anything? A yard that has
            // not shrunk since she last stood in it is one she cannot reach, and
            // the answer to that is an hour off, not another walk.
            const watch = this._yardWatch;
            if (watch && Number.isFinite(left) && Number.isFinite(watch.remaining)
                && left >= watch.remaining && now - watch.at < YARD_STUCK_BACKOFF_MS) {
                return null;
            }
            this._yardWatch = { remaining: Number.isFinite(left) ? left : null, at: now };
            arm('clear_yard');
            return this._settlementBuildBehavior(spec.settlement, left > 0
                ? `${left} blocks of hill and tree still crowding the walls. clearing the yard`
                : 'clearing the ten blocks round the toaster so you can actually see it');
        }

        // Optional domestic fixtures come only after the exact requested house
        // and appliance cycle. They remain preserved by later shell repairs.
        // Chests are NOT here any more - they are three planned stacks in the
        // map, and a loose "put one somewhere" would have landed on a slot.
        const fixtures = [];
        if (nb.craftingTable == null) fixtures.push(hasExact('crafting_table')
            // an exact square of open floor, not "somewhere nearby" - a loose
            // place lands on a planned stack's block and strands that slot.
            ? { key: 'crafting_table_place',
                ...(this._installInSettlement(spec.settlement, 'crafting_table')
                    || { action: 'place', params: { target: 'crafting_table' } }),
                say: 'workbench inside the toaster' }
            : { key: 'crafting_table_get', action: 'get', params: { target: 'crafting_table', amount: 1 }, say: 'getting a workbench for the toaster' });
        // The plan keeps a two-bed nook in the middle, walled in by ovens. The
        // bed task places where she is STANDING, so the only way to honour the
        // map is to go and stand in it first.
        if (nb.bed == null) {
            const nook = toasterBedPositions(spec.settlement)[0];
            const away = nook && Math.hypot(p.x - nook.x, p.z - nook.z) > 3;
            fixtures.push(!has('_bed')
                ? { key: 'bed_get', action: 'get', params: { target: 'bed', amount: 1 }, say: 'getting a bed for the middle of the toaster' }
                : (away
                    ? { key: 'bed_nook', action: 'move', params: { ...nook, target: 'the bed nook' }, say: 'the bed goes dead centre, walled in by ovens' }
                    : { key: 'bed_place', action: 'place', params: { target: 'bed' }, say: 'bed in the nook. the ovens can watch me sleep' }));
        }
        for (const fixture of fixtures) {
            if (onCooldown(fixture.key)) continue;
            arm(fixture.key);
            return fixture;
        }

        // -- live: the bread pipeline + putting the haul away.
        // a stocked pantry, not a zero-check: a bread professional restocks at
        // BREAD_FLOOR, she doesn't wait until she's completely out.
        const wheatCount = this._wheatCount();
        if (this._breadCount() < BREAD_FLOOR && wheatCount < 3 && !onCooldown('wheat_run')) {
            arm('wheat_run');
            const spot = this.memory.nearestWheatSpot(p, g.dimension);
            if (spot && spot.distance > 24) {
                return {
                    action: 'move',
                    params: { x: spot.position.x, y: spot.position.y, z: spot.position.z, target: 'my wheat spot' },
                    say: `bread reserves are a disgrace. hitting the wheat spot ${spot.distance} blocks out`
                };
            }
            // no known field (or standing in one): let altoclef hunt wheat - it
            // replants what it takes, and the protection escape covers claims
            return { action: 'get', params: { target: 'wheat', amount: 6 }, say: 'wheat hunt. the bread must flow' };
        }
        // "the bag is full" is a SLOT question, not a distinct-type question. the
        // old `>= 15 entries` proxy was calibrated against a companion that capped
        // the list at 18 types; now the whole bag is reported, so that proxy would
        // trip on any well-stocked homesteader. use the real free-slot count when
        // the companion sends it, and keep the proxy only for older jars.
        const freeSlots = Number.isFinite(g.inventoryFree) ? g.inventoryFree : null;
        const bagFull = freeSlots !== null
            ? freeSlots <= 4
            : (Array.isArray(g.inventory) ? g.inventory.length : 0) >= 15;
        if (bagFull && nb.chest != null && !onCooldown('deposit')) {
            arm('deposit');
            return { action: 'deposit', params: {}, say: 'offloading the haul into the home chest' };
        }
        return null;
    }

    // sum the stack counts of every inventory line matching a regex. the plain
    // substring _inventoryCount() can't be used for fuel or wheat: 'charcoal'
    // contains 'coal' (double count) and 'wheat_seeds' contains 'wheat' (seeds
    // are not bakeable). word-boundary matching keeps both honest, and also
    // keeps coal_ore / coal_block out of the fuel bin.
    _inventoryCountRe(re) {
        const inv = this.gameState.inventory;
        if (!Array.isArray(inv)) return 0;
        let total = 0;
        for (const it of inv) {
            const s = (typeof it === 'string' ? it : `${it.count ?? it.amount ?? ''} ${it.item ?? it.name ?? ''}`).toLowerCase();
            if (!re.test(s)) continue;
            const m = s.match(/(\d+)/);
            total += m ? parseInt(m[1], 10) : 1;
        }
        return total;
    }

    // how much coal+charcoal she's carrying. the fuel bin is the thing a furnace
    // person actually worries about - an oven with nothing to burn is furniture.
    _fuelCount() {
        return this._inventoryCountRe(FUEL_RE);
    }

    _breadCount() {
        return this._inventoryCount('bread');
    }

    // harvested wheat only - seeds don't bake
    _wheatCount() {
        return this._inventoryCountRe(/\bwheat\b/);
    }

    // the collection's shortfall: which oven kind she'd add next, or null when
    // the family is complete. prereq-gated so she never burns a cooldown asking
    // for a blast furnace with no iron on her.
    _nextOvenWanted() {
        const hay = this._carrying();
        const affordable = (kind) => {
            const prereq = OVEN_PREREQ[kind];
            return !prereq || prereq.test(hay);
        };
        // Plain furnaces and the first smoker are owned by the homestead cycle:
        // it expands and re-surveys before installing them. This secondary drive
        // only adds exact-position specialty appliances to a finished shell.
        for (const kind of ['campfire', 'blast_furnace', 'soul_campfire']) {
            const target = OVEN_TARGETS[kind] || 1;
            if (this._homeOvens(kind).length >= target) continue;
            if (!affordable(kind)) continue;
            return kind;
        }
        return null;
    }

    // THE OBSESSION. furnaces, smokers, bread, fire - the part of her play that
    // never completes. runs after the homestead has a home to keep: fuel bin
    // first (a cold oven is the actual emergency), then the collection grows,
    // then bread stock, then fire on hand, then the lava shrine. one step per
    // call, each on its own cooldown, null when nothing is due.
    _obsessionBehavior() {
        const g = this.gameState;
        const home = this._home();
        if (!home) return null;                    // settle first; the arc owns that phase
        const now = Date.now();
        const onCooldown = (key) => now - (this._obsessionCooldowns.get(key) || 0) < OBSESSION_STEP_COOLDOWN_MS;
        const arm = (key) => this._obsessionCooldowns.set(key, now);
        const hay = this._carrying();
        const nb = g.nearby || {};
        const homeDist = this._homeDistance();
        const atHome = homeDist <= HOMESTEAD_NEAR_HOME;

        // 1. FUEL. below the floor she stops whatever leisure she had planned and
        // restocks: coal if there's ore around or she's underground, charcoal
        // (smelt logs) otherwise - which also means a furnace gets used.
        if (this._fuelCount() < FUEL_FLOOR && !onCooldown('fuel')) {
            arm('fuel');
            this.memory.bumpTally('fuelRuns');
            const oreIsCoal = typeof nb.nearestOre === 'string' && /coal/.test(nb.nearestOre);
            return oreIsCoal || Number(g.position?.y) < 50
                ? { action: 'get', params: { target: 'coal', amount: FUEL_COMFORT }, say: 'fuel bin\'s embarrassing. a cold furnace is a personal failure, getting coal' }
                : { action: 'get', params: { target: 'charcoal', amount: FUEL_COMFORT }, say: 'burning wood down to charcoal. feeding the oven so the oven can feed me' };
        }

        // 2. THE COLLECTION. she keeps adding units - the plain furnace most of
        // all, because that's the toaster. get it, then install it at home so it
        // joins the family with a name.
        const readyHome = this.homeSpec();
        const wanted = readyHome.met ? this._nextOvenWanted() : null;
        if (wanted && !onCooldown(`oven_${wanted}`)) {
            // exact item match: plain 'furnace' is a substring of 'blast_furnace'
            // and 'campfire' of 'soul_campfire', so a substring test would think
            // she's already carrying the unit she still needs.
            const carryingIt = new RegExp(`(^|[^a-z_])${wanted}([^a-z_]|$)`).test(hay);
            if (carryingIt && !atHome) {
                if (!onCooldown('oven_carry_home')) {
                    arm('oven_carry_home');
                    return { action: 'go_home', params: {}, say: `carrying a ${wanted.replace(/_/g, ' ')} home. it doesn't live in a backpack, it lives with the others` };
                }
            } else {
                arm(`oven_${wanted}`);
                return carryingIt
                    ? (this._installInSettlement(readyHome.settlement, wanted)
                        || { action: 'place', params: { target: wanted }, say: this._ovenLine(wanted, 'place') })
                    : { action: 'get', params: { target: wanted, amount: 1 }, say: this._ovenLine(wanted, 'get') };
            }
        }

        // 3. BREAD STOCK. wheat on her -> bake. the homestead arc runs the wheat
        // RUN; this is the part where the wheat becomes bread.
        if (this._breadCount() < BREAD_COMFORT && this._hasWheat() && !onCooldown('bake')) {
            arm('bake');
            return { action: 'craft', params: { target: 'bread', amount: 3 }, say: this._breadLine() };
        }

        // 4. FIRE ON HAND. flint and steel is the whole personality in one item -
        // fire whenever she wants it. then a torch supply so home stays lit.
        if (!/flint_and_steel/.test(hay) && /iron_ingot/.test(hay) && !onCooldown('flint_steel')) {
            arm('flint_steel');
            return { action: 'get', params: { target: 'flint_and_steel', amount: 1 }, say: 'flint and steel. the ability to start a fire whenever i feel like it is a human right' };
        }
        if (this._inventoryCount('torch') < 8 && !onCooldown('torch_stock')) {
            arm('torch_stock');
            return { action: 'get', params: { target: 'torch', amount: 16 }, say: 'restocking torches. every dark corner out here is a personal insult' };
        }

        // 5. THE LAVA SHRINE. lava within the scan and she hasn't marked one yet:
        // save the spot instead of walking into it. she looks at fire, she does
        // not swim in it. bounded per session so it stays a shrine, not a hobby.
        // the companion sends the full identifier ('minecraft:the_nether'), so
        // this has to match on the namespace-stripped name - a bare equality
        // check never fired and bookmarked lava down there, where it's scenery.
        if (nb.lava != null && this._lavaPilgrimages < MAX_LAVA_PILGRIMAGES &&
            !onCooldown('lava_shrine') && !/nether/i.test(String(g.dimension || ''))) {
            arm('lava_shrine');
            const p = g.position;
            if (p) {
                // don't clobber an older lava bookmark with a new one - a fixed
                // name would overwrite last session's spot every time she found
                // fire again. take the first free name instead.
                const name = ['the lava', 'more lava', 'lava, again', 'the other lava']
                    .find((n) => !this.memory.getFavorite(n));
                const entry = name && this.memory.setFavorite(name, p, g.dimension, 'open fire, no oven required');
                if (entry) {
                    this._lavaPilgrimages += 1;    // only a real bookmark spends the visit
                    this.recentEvents.record(`marked a lava spot as "${entry.name}"`);
                    this._pushCommentary('there\'s open lava right there. saving this spot. that\'s just fire that lives outside');
                    return null;                   // a bookmark, not a goal - let the menu play
                }
            }
        }

        // THE BREAD HOARD. past what she needs to eat, she just likes having an
        // absurd amount of bread on her - it is the personality, and it is what makes
        // "here, have a loaf" possible the moment somebody wanders up. LAST on
        // purpose: this is what she does with leftover time, never instead of tools,
        // fire, shelter or anything a person asked for.
        if (this._breadCount() < BREAD_HOARD && this._hasWheat() && !onCooldown('bread_hoard')) {
            arm('bread_hoard');
            return {
                action: 'craft',
                params: { target: 'bread', amount: 3 },
                say: `${this._breadCount()} loaves on me and that is not enough loaves`
            };
        }
        return null;
    }

    // gear ambition: what she does with downtime once she's SAFE, as opposed to
    // survival prep, which is what she does when she isn't. kept out of
    // _survivalPrep on purpose - as a prep gap these never close, so they'd pin
    // the loop and starve every idle behavior behind it. here they just compete
    // for a turn like anything else, on their own cooldowns.
    _gearAmbition() {
        const now = Date.now();
        const onCooldown = (key) => now - (this._obsessionCooldowns.get(key) || 0) < OBSESSION_STEP_COOLDOWN_MS;
        const arm = (key) => this._obsessionCooldowns.set(key, now);
        const hay = this._carrying();
        const mind = this.minecraftState || this.affect.snapshot();

        // the old kit check passed on ANY pickaxe, so a wooden one could carry
        // her all session. no real player stops at stone.
        if (!/(iron|diamond|netherite)_pickaxe/.test(hay) && !onCooldown('iron_pickaxe')) {
            arm('iron_pickaxe');
            return { action: 'craft', params: { target: 'iron_pickaxe' }, say: 'stone tools are a phase and i\'m ready to grow. iron pickaxe' };
        }
        // she was playing every session in her regular clothes. a death (or a bad
        // feeling about the place) is when a person decides to fix that.
        const wearingArmor = Array.isArray(this.gameState.armor) && this.gameState.armor.length > 0;
        if (!wearingArmor && (this.stats.deaths > 0 || mind.security < 60) && !onCooldown('armor')) {
            arm('armor');
            return { action: 'craft', params: { target: 'iron_chestplate' }, say: 'i keep doing this in my normal clothes. getting something between me and the world' };
        }
        return null;
    }

    // flavor for the collection growing. she talks about ovens the way she talks
    // about her toasters, because they are the same thing to her.
    _ovenLine(kind, phase) {
        const pretty = kind.replace(/_/g, ' ');
        if (phase === 'place') {
            const lines = [
                `installing the ${pretty}. it gets a name once it's in`,
                `the ${pretty} goes right there. the family grows`,
                `new unit joining the collection. welcome home, ${pretty}`
            ];
            return this._pickFresh('oven-install', lines);
        }
        const lines = {
            furnace: 'another furnace. i can stop whenever i want, i just don\'t want to',
            blast_furnace: 'a blast furnace. same job, more commitment. i respect that in an appliance',
            smoker: 'a smoker. it\'s a furnace that specialized. good for it',
            campfire: 'need another campfire. open flame is different, it\'s got nothing to prove',
            soul_campfire: 'soul campfire. blue fire. i don\'t make the rules'
        };
        return lines[kind] || `getting a ${pretty}`;
    }

    // mood-weighted idle behavior menu. entertainment over efficiency.
    _pickIdleBehavior() {
        const mind = this.minecraftState || this.affect.snapshot();
        const g = this.gameState;
        const hostiles = Number(g.nearbyHostiles) || 0;
        const risk = Number(mind.riskTolerance) || 45;
        const nearbyOre = g.nearby && typeof g.nearby.nearestOre === 'string'
            ? g.nearby.nearestOre
            : null;

        // the obsession picks up where the homestead checklist stops. provisioning
        // finishes; keeping the fuel bin full, the collection growing, the pantry
        // stocked and the place lit never does. sampled under the homestead so the
        // mood menu and the rest of the game still get their turns.
        if (Math.random() < OBSESSION_BIAS) {
            const obsession = this._obsessionBehavior();
            if (obsession) return obsession;
        }

        // safe and stocked -> upgrade the kit. below the obsession on purpose:
        // she'd rather install a smoker than mine iron, which is the whole point.
        const ambition = this._gearAmbition();
        if (ambition) return ambition;

        // multiplayer caution: players nearby usually means someone's build is
        // nearby - don't idle-MINE around them. sampled drift (never from her
        // own home, hanging out there with visitors is fine), else the menu
        // just avoids block-breaking picks near people.
        const nearPeople = g.multiplayer === true && (g.nearbyPlayers || 0) > 0;
        const unfinishedToaster = this._toasterUnfinished();
        // nobody sets off on a long walk in the rain. these two rolls are the
        // menu's outbound picks (hundreds of blocks each), so while it's actually
        // landing on her they sit the turn out and the indoor/near picks below
        // get it instead. the shelter pull above already had its one go.
        const wet = this._rainingOnHer();
        if (!wet && nearPeople && !unfinishedToaster && this._homeDistance() > 64 && Math.random() < 0.4) {
            const p2 = g.position || { x: 0, y: 64, z: 0 };
            const drift = this._pickLandingSpot(p2, 120, 180);
            if (drift) {
                return {
                    action: 'move',
                    params: { ...drift, target: 'somewhere less crowded' },
                    say: 'people nearby means claims nearby. drifting off before i break something with feelings attached'
                };
            }
        }

        // multiplayer wanderlust: everything near spawn/towns is claimed, so idle
        // time favors real distance - pick a far point and walk until the land
        // stops belonging to people. fires often enough to keep her moving out.
        // ...but a half-built toaster at home outranks the frontier. this roll had no
        // home guard at all, so 40% of every idle tick walked her up to 900 blocks
        // away from a shell she was in the middle of building - the single biggest
        // reason the homestead never got finished. the wanderlust is hers again the
        // moment the shell surveys complete.
        if (!wet && g.multiplayer === true && !unfinishedToaster && g.timeOfDay !== 'night' &&
            !this._justLeftWater() && Math.random() < 0.4) {
            const p = g.position || { x: 0, y: 64, z: 0 };
            const spot = this._pickLandingSpot(p, 300, 900);
            if (spot) {
                const dist = Math.round(Math.hypot(spot.x - p.x, spot.z - p.z));
                return {
                    action: 'move',
                    params: { ...spot, target: 'the frontier' },
                    say: `everything around here is someone's. walking ${dist} blocks until it isn't`
                };
            }
        }

        // home instinct: night, far from home, same dimension -> head back like
        // a person would. bounded range so she doesn't cross the map at 3am, and
        // sampled so it's a pull, not a compulsion.
        const home = this._home();
        if (home && g.timeOfDay === 'night' && this._dimMatches(home.dimension, g.dimension) && !this._homeRelocation) {
            const hd = Math.hypot((g.position?.x ?? 0) - home.position.x, (g.position?.z ?? 0) - home.position.z);
            // the one go_home issuer that had NO cooldown at all: a 0.6 dice roll on
            // every idle tick that got this far, all night. a pull she keeps acting on
            // every forty seconds is not a pull, it's the loop with better narration.
            const lastPull = this._homesteadCooldowns.get('home_instinct') || 0;
            if (hd > 48 && hd < 1200 && Date.now() - lastPull >= HOME_INSTINCT_COOLDOWN_MS && Math.random() < 0.6) {
                this._homesteadCooldowns.set('home_instinct', Date.now());
                return { action: 'go_home', params: {}, say: `night's here and ${home.name} is ${Math.round(hd)} blocks that way. going home` };
            }
        }

        // Strong subjective states get first say. A frightened, exposed player
        // does not roll the same entertainment menu as a secure, confident one;
        // boredom, conversely, creates a real appetite for novelty.
        if (mind.fear >= 72 && hostiles > 0) {
            return risk >= 48
                ? { action: 'defend', params: {}, say: 'okay, enough backing up. clearing the things on me, then reassessing' }
                : null; // stay taskless so AltoClef's survival/avoidance chain owns movement
        }
        if (mind.security <= 28) {
            return this._carrying().includes('_pickaxe')
                ? { action: 'collect', params: { target: 'oak_log', amount: 8 }, say: 'i feel wildly underprepared. small wood run, then we make this place less hostile' }
                : { action: 'collect', params: { target: 'oak_log', amount: 8 }, say: 'i have the security profile of a wet napkin. wood first, then actual tools' };
        }
        if (mind.fun <= 30 && risk >= 45) {
            return nearbyOre
                ? { action: 'mine', params: { target: nearbyOre }, say: `bored enough to chase that ${nearbyOre.replace(/_/g, ' ')}. new problem, let's go` }
                : { action: 'explore', params: {}, say: 'i am bored of this exact patch of dirt. picking a direction and finding a new problem' };
        }
        if (mind.confidence >= 72 && mind.fun >= 62 && nearbyOre) {
            return {
                action: 'mine',
                params: { target: nearbyOre },
                say: `i can handle this. grabbing that ${nearbyOre.replace(/_/g, ' ')} while the run is hot`
            };
        }

        const menus = {
            neutral: [
                { action: 'explore', risk: 52, appeal: 72, say: 'nothing better to do, let\'s go see what\'s out there' },
                { action: 'mine', target: 'stone', risk: 18, appeal: 30, say: 'gonna punch some rocks, brb' },
                { action: 'collect', target: 'oak_log', risk: 14, appeal: 34, say: 'wood run. the eternal wood run' }
            ],
            happy: [
                { action: 'explore', risk: 48, appeal: 76, say: 'the world\'s so pretty today, let\'s wander' },
                { action: 'collect', target: 'oak_log', risk: 14, appeal: 38, say: 'wood run. i have a completely normal amount of plans for this' }
            ],
            angry: [
                { action: 'mine', target: 'stone', risk: 20, appeal: 36, say: 'i\'m gonna take it out on the terrain' },
                { action: 'attack', target: 'nearest', risk: 68, appeal: 66, say: 'anything hostile nearby is having a bad night' }
            ],
            sad: [
                { action: 'mine', target: 'obsidian', risk: 54, appeal: 46, say: 'building a monument to my sorrows' },
                { action: 'explore', risk: 45, appeal: 62, say: 'just gonna walk it off' }
            ],
            excited: [
                { action: 'mine', target: 'diamond_ore', risk: 72, appeal: 88, say: 'diamonds diamonds diamonds let\'s GO' },
                { action: 'explore', risk: 55, appeal: 78, say: 'somewhere out there is loot with my name on it' }
            ],
            scared: [
                { action: 'defend', risk: 62, appeal: 42, say: 'the dark is NOT invited. anything nearby can catch these hands' },
                { action: 'collect', target: 'oak_log', risk: 12, appeal: 32, say: 'staying close and getting enough blocks to feel less exposed' }
            ],
            chaotic: [
                { action: 'mine', target: 'diamond_ore', risk: 80, appeal: 90, say: 'straight down. i know. i KNOW.' },
                { action: 'explore', risk: 62, appeal: 82, say: 'gonna go find something to regret' }
            ]
        };
        let menu = menus[this.mood] || menus.neutral;
        // after a loop break, steer away from the action that just looped so she actually
        // does something different (fall back to the full menu if filtering empties it).
        if (this._avoidAction && Date.now() < (this._avoidUntil || 0)) {
            const filtered = menu.filter((m) => m.action !== this._avoidAction);
            if (filtered.length) menu = filtered;
        }
        // near other players on a server: no block-breaking picks (their builds,
        // their claims) - explore/defend style entries only
        if (nearPeople) {
            const gentle = menu.filter((m) => !['mine', 'collect'].includes(m.action));
            menu = gentle.length ? gentle : [{ action: 'explore', risk: 50, appeal: 60, say: 'wandering. politely. away from everyone\'s stuff' }];
        }
        // Prefer choices whose danger fits her current appetite for risk, while
        // low fun increases the pull of the more entertaining option.
        const weighted = menu.map((entry) => {
            const riskFit = Math.max(0.15, 1 - Math.abs((entry.risk ?? 40) - risk) / 75);
            const funPull = 1 + Math.max(0, (55 - mind.fun) / 70) * ((entry.appeal ?? 50) / 50);
            return { entry, weight: riskFit * funPull };
        });
        const total = weighted.reduce((sum, item) => sum + item.weight, 0);
        let roll = Math.random() * total;
        let pick = weighted[weighted.length - 1].entry;
        for (const item of weighted) {
            roll -= item.weight;
            if (roll <= 0) {
                pick = item.entry;
                break;
            }
        }
        return { action: pick.action, params: pick.target ? { target: pick.target } : {}, say: pick.say };
    }

    // everything she's carrying, lowercased, as one searchable string. mirrors
    // modes.js deriveKit()'s sources so the loop sees the same kit she's told about.
    // how many food items she is actually holding. inventory entries arrive as
    // "N minecraft:bread" strings from the companion.
    _foodOnHand() {
        const g = this.gameState;
        if (!Array.isArray(g.inventory)) return 0;
        let total = 0;
        for (const entry of g.inventory) {
            const text = String(typeof entry === 'string' ? entry : (entry?.item || entry?.name || '')).toLowerCase();
            if (!FOOD_RE.test(text)) continue;
            const count = parseInt(text, 10);
            total += Number.isFinite(count) && count > 0 ? count : 1;
        }
        return total;
    }

    // `eat` maps to altoclef's `@food <n>`, which is NOT "eat something" - it is
    // "END UP HOLDING n units of food", i.e. a full gather/farm/craft project.
    // the flat default of 10 meant she announced "eating" and then vanished into
    // a multi-minute wheat run that looks exactly like doing nothing. ask for a
    // target she can actually satisfy: altoclef's FoodChain auto-eats whenever
    // hunger is low, so when she is already carrying food the honest request is
    // a small one that completes now.
    _foodTarget() {
        const onHand = this._foodOnHand();
        if (onHand >= 1) return Math.min(onHand, EAT_TOPUP_TARGET);
        return EAT_GATHER_TARGET;
    }

    // params for a real eat. `now` routes to the companion's eat_now (which
    // drives altoclef's FoodChain fillup and actually puts food in her mouth);
    // without food it stays a short gather. asking `@food n` while already
    // holding n is what produced "ate" every 25s while she starved.
    _eatParams() {
        const onHand = this._foodOnHand();
        return onHand >= 1
            ? { now: true, hasFood: true, amount: onHand }
            : { amount: EAT_GATHER_TARGET };
    }

    _carrying() {
        const g = this.gameState;
        const names = [];
        const add = (v) => {
            if (!v) return;
            names.push(String(typeof v === 'string' ? v : (v.item || v.name || '')).toLowerCase());
        };
        if (Array.isArray(g.inventory)) g.inventory.forEach(add);
        add(g.selectedItem); add(g.offhandItem);
        if (Array.isArray(g.armor)) g.armor.forEach(add);
        return names.join(' ');
    }

    // the one goal that most needs doing before she goes exploring, or null when
    // she's kitted enough to just play. `craft` maps to altoclef's `@get`, which
    // resolves the whole recipe chain (chop wood -> planks -> sticks -> tool), so
    // a single goal covers the prep.
    // best armour piece she is CARRYING but not WEARING. the companion sends the
    // worn set as gameState.armor, so this compares pocket vs body per slot and
    // only suggests a real upgrade (never a downgrade, never a piece already on).
    _armorToWear() {
        const g = this.gameState;
        const inv = Array.isArray(g.inventory) ? g.inventory : [];
        if (!inv.length) return null;
        const worn = (Array.isArray(g.armor) ? g.armor : []).map((a) => String(a || '').toLowerCase());
        const rank = (name) => {
            const tier = ARMOR_TIERS.findIndex((t) => name.includes(t));
            return tier === -1 ? -1 : ARMOR_TIERS.length - tier;
        };
        let best = null;
        for (const slot of ARMOR_SLOTS) {
            const wornPiece = worn.find((w) => w.includes(slot));
            const wornRank = wornPiece ? rank(wornPiece) : 0;
            for (const raw of inv) {
                const name = String(typeof raw === 'string' ? raw : (raw?.item || raw?.name || '')).toLowerCase();
                if (!name.includes(slot)) continue;
                const r = rank(name);
                if (r <= 0 || r <= wornRank) continue;
                const item = (name.match(/[a-z_]*_?(?:netherite|diamond|iron|chainmail|golden|leather|turtle)[a-z_]*/) || [])[0]
                    || name.replace(/^[0-9\s]+/, '').replace(/^minecraft:/, '');
                const clean = item.replace(/^minecraft:/, '').trim();
                if (!clean) continue;
                if (!best || r > best.rank) best = { slot, item: clean, rank: r };
            }
        }
        return best;
    }

    // EVERY armour upgrade she is carrying, best piece per slot. "put your armor on"
    // means all of it, not the single best piece - _armorToWear() answers a different
    // question (the one next upgrade the idle loop should do) and using it for an
    // explicit instruction left her in one boot.
    _allArmorToWear() {
        const g = this.gameState;
        const inv = Array.isArray(g.inventory) ? g.inventory : [];
        if (!inv.length) return [];
        const worn = (Array.isArray(g.armor) ? g.armor : []).map((a) => String(a || '').toLowerCase());
        const rank = (name) => {
            const tier = ARMOR_TIERS.findIndex((t) => name.includes(t));
            return tier === -1 ? -1 : ARMOR_TIERS.length - tier;
        };
        const picks = [];
        for (const slot of ARMOR_SLOTS) {
            const wornPiece = worn.find((w) => w.includes(slot));
            const wornRank = wornPiece ? rank(wornPiece) : 0;
            let best = null;
            for (const raw of inv) {
                const name = String(typeof raw === 'string' ? raw : (raw?.item || raw?.name || '')).toLowerCase();
                if (!name.includes(slot)) continue;
                const r = rank(name);
                if (r <= 0 || r <= wornRank) continue;
                const item = (name.match(/[a-z_]*_?(?:netherite|diamond|iron|chainmail|golden|leather|turtle)[a-z_]*/) || [])[0]
                    || name.replace(/^[0-9\s]+/, '').replace(/^minecraft:/, '');
                const clean = item.replace(/^minecraft:/, '').trim();
                if (!clean) continue;
                if (!best || r > best.rank) best = { slot, item: clean, rank: r };
            }
            if (best) picks.push(best);
        }
        return picks;
    }

    // why an "armour up" instruction cannot be carried out. the old path answered
    // "altoclef has no built-in task for equip yet", which is not true and told
    // neither her nor the person who asked anything useful. she can only relay a
    // real reason if she is given one.
    _armorRefusalReason() {
        const g = this.gameState;
        const worn = (Array.isArray(g.armor) ? g.armor : []).filter(Boolean);
        if (!Array.isArray(g.inventory) || !g.inventory.length) {
            return 'i cannot see my inventory right now, so i do not know what armour i am carrying';
        }
        if (worn.length >= ARMOR_SLOTS.length) return 'already wearing a full set - nothing in my bag beats it';
        if (worn.length) return 'nothing in my bag is an upgrade on what i already have on';
        return 'i am not carrying any armour to put on';
    }

    _survivalPrep() {
        // an empty inventory array is also what a telemetry gap looks like; only
        // act on a state fresh enough to trust.
        if (this._stateIsStale()) return null;
        const hay = this._carrying();
        const mind = this.minecraftState || this.affect.snapshot();
        const isNight = String(this.gameState.timeOfDay || '').toLowerCase() === 'night';
        const deep = Number.isFinite(Number(this.gameState.position?.y)) && Number(this.gameState.position.y) < 45;
        const candidates = [];
        // A WEAPON COMES FIRST WHEN SOMETHING IS HUNTING HER. she respawns owning
        // nothing, and the list used to open with the pickaxe - so a fresh spawn walked
        // off to mine stone while a zombie ate her, and died holding air. gear order is
        // a comfort question right up until something is actually chasing you.
        if (!/_sword/.test(hay) && Number(this.gameState.nearbyHostiles) > 0) {
            candidates.push({
                key: 'stone_sword',
                action: 'craft',
                params: { target: 'stone_sword' },
                say: 'something is following me and my hands are empty. sword first, everything else after'
            });
        }
        if (!PICKAXE_TIERS.some((t) => hay.includes(`${t}_pickaxe`))) {
            candidates.push({
                key: 'stone_pickaxe',
                action: 'craft',
                params: { target: 'stone_pickaxe' },
                say: 'no pickaxe. i keep starting fights with a mountain using my hands. getting a real one'
            });
        }
        if (!FOOD_RE.test(hay)) {
            // Bread is only a quick food answer when the wheat is already in her
            // pockets. `craft bread` is implemented by AltoClef's recursive `get`;
            // without wheat it silently turns into a crop expedition. On the live
            // server that became `wander for infinity blocks` and Burnt stood still
            // rescanning for 3m38s while claiming to be crafting bread. Let the food
            // task choose an available source instead of hard-locking survival prep
            // to a crop that may not exist anywhere nearby.
            const canBakeNow = this._hasWheat();
            candidates.push({
                key: 'food',
                action: canBakeNow ? 'craft' : 'eat',
                params: canBakeNow ? { target: 'bread' } : { amount: EAT_GATHER_TARGET },
                say: canBakeNow
                    ? 'zero food on me, but i have wheat. making the bread instead of inventing an expedition'
                    : 'zero food and zero wheat. finding something edible instead of pretending to craft bread'
            });
        }
        // WEAR THE ARMOR. altoclef has EquipArmorTask but nothing ever calls it
        // outside the speedrun, so she was carrying plate around in her pockets
        // while skeletons shot her. `equip` maps to @equip -> EquipArmorTask.
        const armorPiece = this._armorToWear();
        if (armorPiece) {
            candidates.push({
                key: `armor:${armorPiece.slot}`,
                action: 'equip',
                params: { target: armorPiece.item },
                say: `i'm carrying ${armorPiece.item.replace(/_/g, ' ')} and wearing nothing. putting it on before something else shoots me`
            });
        }
        if (!/_sword/.test(hay)) {
            candidates.push({
                key: 'stone_sword',
                action: 'craft',
                params: { target: 'stone_sword' },
                say: 'getting a sword before the sun does anything funny'
            });
        }
        if ((isNight || deep || mind.fear >= 55) && !/torch/.test(hay)) {
            candidates.push({
                key: 'torches',
                action: 'craft',
                params: { target: 'torch', amount: 16 },
                say: 'this is exactly how people disappear in caves. making torches before i become a cautionary tale'
            });
        }
        if (mind.security < 48 && !/shield/.test(hay)) {
            candidates.push({
                key: 'shield',
                action: 'craft',
                params: { target: 'shield' },
                say: 'i would feel dramatically better with a shield between me and all of that'
            });
        }
        if (isNight && mind.security < 55 && !/_bed/.test(hay)) {
            candidates.push({
                key: 'bed',
                action: 'craft',
                params: { target: 'bed' },
                say: 'night keeps winning the schedule argument. getting a bed so i can veto it'
            });
        }
        // the tool in her hand is about to snap. the prompt block already tells
        // her this; the loop never acted on it, so she'd keep swinging until it
        // broke mid-cave. replace it before it goes.
        const held = String(this.gameState.selectedItem || '').toLowerCase().replace(/^minecraft:/, '');
        const dur = Number(this.gameState.mainHandDurability);
        const maxDur = Number(this.gameState.mainHandMaxDurability);
        if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(held) && Number.isFinite(dur) && maxDur > 0 && dur / maxDur <= 0.12) {
            candidates.push({
                key: `replace_${held}`,
                action: 'craft',
                params: { target: held },
                say: `my ${held.replace(/_/g, ' ')} is one swing from confetti. making a spare before it happens somewhere stupid`
            });
        }
        // NOTE: gear PROGRESSION (iron upgrade, armor) deliberately does not live
        // here. survival prep is a gap-closing gate - it must go null once she's
        // kitted, or the idle menu behind it (bread, the homestead arc, the
        // obsession) never gets a tick. wanting better gear is downtime, not a
        // gate: see _gearAmbition(), consulted from _pickIdleBehavior.

        const now = Date.now();
        return candidates.find((candidate) =>
            now - (this._survivalPrepCooldowns.get(candidate.key) || 0) >= SURVIVAL_PREP_COOLDOWN_MS) || null;
    }

    // does she have enough wheat (>=3) on hand to bake a loaf of bread?
    _hasWheat() {
        const inv = this.gameState.inventory;
        if (!Array.isArray(inv)) return false;
        for (const it of inv) {
            const s = (typeof it === 'string' ? it : `${it.count ?? it.amount ?? ''} ${it.item ?? it.name ?? ''}`).toLowerCase();
            if (!/\bwheat\b/.test(s) || /seed/.test(s)) continue; // wheat, not wheat_seeds
            const m = s.match(/(\d+)/);
            const n = m ? parseInt(m[1], 10) : 1;
            if (n >= 3) return true;
        }
        return false;
    }

    _breadLine() {
        const lines = [
            'ok downtime means bread time. baking a loaf, don\'t perceive me',
            'i have wheat and a dream and the dream is bread',
            'bread break. it\'s a bread emergency (it is not, i just want bread)',
            'idle hands make bread. pretty sure that\'s the saying',
            'making bread. this is my roman empire. this is who i am',
            'gonna bake real quick. panera could never'
        ];
        return this._pickFresh('bread', lines);
    }

    _recoverPersistentGoal(now = Date.now()) {
        const goal = this.activeGoal;
        if (!goal?.persistent) return false;
        const base = goal.action === 'idle' ? PERSISTENT_IDLE_DWELL_MS : PERSISTENT_DWELL_MS;
        let dwellMs = goal.source === 'autonomous' ? base : base * PERSISTENT_REQUESTED_DWELL_MULT;
        // Being hurt ends a parked goal early no matter who asked for it.
        const hurtRecently = now - (this._lastDamageAt || 0) < PERSISTENT_DANGER_BREAK_MS;
        if (hurtRecently) dwellMs = Math.min(dwellMs, PERSISTENT_DANGER_BREAK_MS);
        if (now - goal.startedAt < dwellMs) return false;

        const description = this._describeTask(goal.action, goal.params);
        const why = hurtRecently ? 'was taking damage while parked' : `hit its ${Math.round(dwellMs / 60000)}min dwell budget`;
        this.log('info', `${goal.source} ${description} ${why}; rotating`);
        try {
            this.memory.record('completed', `${description} (${hurtRecently ? 'broken off - taking hits' : 'dwell budget spent'}, moving on)`, {
                action: goal.action,
                target: goal.params?.target,
                position: this.gameState.position,
                dimension: this.gameState.dimension
            });
        } catch { /* recovery must not be defeated by optional memory */ }
        this._avoidAction = goal.requestedAction || goal.action;
        this._avoidUntil = now + LOOP_AVOID_MS;
        this._applyMinecraftEvent('bored');
        this.activeGoal = null;
        this.currentTask = null;
        this.executeAction('stop', {}, { priority: 'urgent', source: 'dwell-rotation', waitForCompletion: false })
            .catch((err) => this.log('warn', `failed to stop ${description}: ${err.message}`));
        return true;
    }

    _recoverOrphanTask(now = Date.now()) {
        // The task gate refuses to pick anything while currentTask is set. If no
        // action, pending request, or tracked goal owns that string, no watchdog
        // can supervise it and it must be treated as stale state.
        const hasPendingTask = [...this.pendingActions.values()]
            .some((pending) => !NON_TASK_ACTIONS.has(pending.action));
        const orphaned = this.currentTask && !this.activeGoal && !this.currentAction && !hasPendingTask;
        if (!orphaned) {
            this._orphanTaskSince = 0;
            return false;
        }
        if (!this._orphanTaskSince) this._orphanTaskSince = now;
        if (now - this._orphanTaskSince < ORPHAN_TASK_LIMIT_MS) return false;

        this.log('warn', `no goal owns "${this.currentTask}" - clearing it so she can pick something`);
        this.recentEvents.record('shook off a task that had stopped going anywhere');
        this._orphanTaskSince = 0;
        this.currentTask = null;
        this.executeAction('stop', {}, { priority: 'urgent', source: 'orphan-recovery', waitForCompletion: false })
            .catch((err) => this.log('warn', `orphan stop failed: ${err.message}`));
        return true;
    }

    /**
     * The floor of the idle loop: something safe, mechanically different from
     * whatever just declined, and always available. Called whenever a tick would
     * otherwise end with her standing still.
     */
    _executeLastResort() {
        const candidates = Number(this.gameState.nearbyHostiles) > 0
            ? [
                { action: 'defend', params: {}, say: 'that plan wedged. clearing the immediate problem instead' },
                { action: 'explore', params: {}, say: 'that plan wedged. moving on instead of staring at it' }
            ]
            : [
                { action: 'explore', params: {}, say: 'that plan wedged. moving on instead of staring at it' },
                { action: 'collect', params: { target: 'oak_log', amount: 4 }, say: 'that plan wedged. doing a small wood run instead' }
            ];
        for (const candidate of candidates) {
            if (candidate.action === this._avoidAction && Date.now() < (this._avoidUntil || 0)) continue;
            if (this._safeExecute(candidate.action, candidate.params, candidate.say)) {
                this.lastAutonomousAt = Date.now();
                return true;
            }
        }
        return false;
    }

    // fire-and-forget executeAction that never rejects into the tick loop.
    // waitForCompletion:false gives idle goals the same background semantics as
    // llm-issued long goals: resolve at ack, completion tracked via the pending
    // record's long window. with the default 90s wait, any mining trip longer
    // than that orphaned the pending - the real finish was silently dropped (no
    // memory, no narration) and the loop watchdog later invented a phantom
    // failure right after she actually succeeded.
    // source 'request' marks a goal a real person asked for: it gets the longer
    // persistent dwell (so "come here" means she actually STAYS near them rather
    // than wandering off on the idle rotation) and still yields to operator/llm.
    // `say` is her own reason for doing this, already written by survival prep / the
    // idle menu / homestead. it used to be spent on one commentary cue and thrown away;
    // it now rides along to the goal so the in-game hud can show WHY, which is the half
    // the mechanical task chain can never tell you.
    _safeExecute(action, params, say, source = 'autonomous') {
        if (source === 'autonomous' && action === 'go_home' &&
            this._homeDistance() >= HOME_RELOCATION_MIN_DISTANCE &&
            Date.now() < this._homeRelocationBackoffUntil) {
            this.log('debug', 'skipping distant home route during relocation backoff');
            return false;
        }
        if (this._avoidAction === action && Date.now() < (this._avoidUntil || 0)) {
            // ...EXCEPT WALKING OUT OF THE SPAWN REGION. this blacklist exists so
            // she stops re-picking an action that just stalled, but the march
            // picks a fresh destination every time and is the ONLY thing she is
            // allowed to do in here. a mob pinning her mid-hop blacklists `move`
            // for two minutes, and the tick has nothing else to offer, so she
            // stood in the middle getting chased while the one escape she had was
            // switched off. that is the loop the operator watched, not a symptom of it.
            if (!(action === 'move' && this._standingInSpawnRegion())) {
                this.log('debug', `skipping recently stalled autonomous action: ${action}`);
                return false;
            }
            this.log('info', 'walking out of the spawn region overrides the stalled-move backoff');
        }
        if (say) this._pushCommentary(say);
        this.executeAction(action, params, { priority: 'low', source, why: say || null, waitForCompletion: false }).catch((err) => {
            this.log('debug', `autonomous ${action} failed: ${err.message}`);
        });
        return true;
    }

    /**
     * SHE IS NOT FAILING AT JOBS, SHE IS STUCK IN A PLACE.
     *
     * Every recovery in this file abandons a GOAL: the action gets blacklisted,
     * the destination gets remembered, the idle menu picks something else. All of
     * that is right when the job was the problem. None of it can see the case
     * where the GROUND is the problem, and then "try something else" just feeds
     * the next goal into the same wall.
     *
     * Live on 2026-08-05: pinned at (-258,81,1476), a `move` to a site FORTY-EIGHT
     * blocks away, baritone re-deriving the identical "Path goes for
     * 84.8174510345601 blocks" every six seconds and never arriving, then `craft
     * torch` stalling at the same coordinates, then another move. Each individual
     * abort was correct and she never went anywhere for minutes.
     *
     * So count aborts BY PLACE. Several in a row inside a few blocks is not bad
     * luck with tasks, it is terrain she cannot leave by asking politely.
     */
    _noteStallHere() {
        const p = this._point(this.gameState.position);
        if (!p) return;
        const now = Date.now();
        const anchor = this._stallAnchor;
        if (anchor && now - anchor.at < STUCK_WINDOW_MS &&
            Math.hypot(p.x - anchor.x, p.z - anchor.z) <= STUCK_RADIUS) {
            anchor.at = now;
            anchor.count += 1;
        } else {
            this._stallAnchor = { x: p.x, z: p.z, at: now, count: 1 };
        }
        if (this._stallAnchor.count < STUCK_STREAK) return;
        this._stallAnchor = null;
        this._breakOutOfStuckSpot(p);
    }

    /**
     * Get off this square, by the shortest honest means available.
     *
     * Ground she has PERSONALLY STOOD ON first: a cell in her own terrain memory
     * is ground baritone demonstrably walked her across, which is a far better bet
     * than any computed bearing when the computed bearings are what just failed.
     * Then a short hop - short on purpose, because the long ones are the ones that
     * cannot be pathed. Never a full-size venture; this is a door, not a journey.
     */
    _breakOutOfStuckSpot(p) {
        // the ground itself is suspect now, so the site picker must stop offering it
        this._recordSiteRejection(p, ['terrain too steep']);
        this._rememberDestination(p);
        const known = this._nearestDryCell(p);
        const spot = (known && Math.hypot(known.x - p.x, known.z - p.z) <= STUCK_ESCAPE_MAX
            ? { x: known.x, y: this._safeTravelY(p), z: known.z }
            : null)
            || this._pickLandingSpot(p, 12, STUCK_ESCAPE_MAX);
        this.recentEvents.record('got wedged on one spot and had to break out of it');
        try {
            this.memory.record('recovery', 'wedged in one spot - every job failed there', {
                action: 'move', position: p, dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
        if (!spot) {
            // nothing reachable that she knows of. say so rather than pretending -
            // the honest fallback is altoclef's own wander, which at least moves.
            this._pushCommentary("i can't get off this square. every single thing i start dies right here.");
            this._safeExecute('explore', {}, null);
            return;
        }
        // bypass the action backoff: `move` is very likely the thing that just got
        // blacklisted, and it is also the only thing that can help.
        this._avoidAction = null;
        this._avoidUntil = 0;
        this._safeExecute('move', { ...spot, target: 'anywhere but this exact square' },
            "three jobs in a row died on this one spot. it's not the jobs. getting off it.");
    }

    _recoverStalledGoal() {
        const goal = this.activeGoal;
        const now = Date.now();
        let stallMs = goal ? (ACTION_STALL_MS[goal.action] || AUTONOMOUS_STALL_MS) : AUTONOMOUS_STALL_MS;
        // The builder telling us outright that it cannot build this site is a
        // verdict, not a silence, so it does not have to serve out the whole
        // build budget before she is moved onto something else. Previously
        // nothing on this side ever read the string and it only mattered by
        // being stable enough not to fake progress.
        const blocked = goal?.action === 'build_settlement'
            && this.gameState.settlementBuild?.phase === BUILD_BLOCKED_PHASE;
        if (blocked) stallMs = Math.min(stallMs, BUILD_BLOCKED_GRACE_MS);
        if (!goal || !goal.watchdog || now - goal.lastProgressAt < stallMs) return false;
        const description = this._describeTask(goal.action, goal.params);
        const stalledFor = Math.max(1, Math.round((now - goal.lastProgressAt) / 1000));
        const reason = blocked
            ? `baritone refuses to build this site (${stalledFor}s)`
            : `no movement or inventory progress for ${stalledFor}s`;
        this.log('warn', `minecraft goal stalled; stopping ${description} (${reason})`);
        this.memory.recordFailure(goal.action, goal.params?.target, reason);
        this.memory.record('recovery', `abandoned stalled ${description}`, {
            action: goal.action,
            target: goal.params?.target,
            position: this.gameState.position,
            dimension: this.gameState.dimension
        });
        this._markPendingAborted(goal.id, reason);
        this._applyMinecraftEvent('stalled');
        // Do not immediately select the exact same dead action from another idle
        // branch on the next tick. Homestead/prep have their own cooldowns; this
        // closes the generic idle-menu path too.
        this._avoidAction = goal.requestedAction || goal.action;
        this._avoidUntil = now + LOOP_AVOID_MS;
        this.activeGoal = null;
        this.currentTask = `recovering from stalled ${description}`;
        // "trying something else" is only an answer when the JOB was the problem.
        // count the failures that happen on one patch of ground - see _noteStallHere.
        this._noteStallHere();
        this._pushCommentary(`i'm stuck on ${description}. aborting and trying something else.`);
        this.executeAction('stop', {}, { priority: 'urgent', source: 'recovery', waitForCompletion: false }).catch((err) => {
            this.log('warn', `failed to stop stalled goal: ${err.message}`);
        });
        return true;
    }

    // catch loops the stall watchdog misses: she's still moving (so lastProgressAt stays
    // fresh) but going nowhere - orbiting one patch, or grinding a goal that never resolves.
    // break out, remember what to avoid, and voice the change so she stops re-narrating the
    // same scene for ten minutes.
    _recoverLoopingGoal() {
        const goal = this.activeGoal;
        if (!goal || !goal.watchdog) return false;
        const now = Date.now();
        const confinedMs = goal.anchorAt ? now - goal.anchorAt : 0;
        const runningMs = now - goal.startedAt;
        // A stationary miner/crafter can legitimately stay in one small area
        // for a while. Inventory gains are concrete task progress, whereas a
        // pathing orbit produces movement without either relocation or gains.
        const inventoryIsProgressing = now - (goal.lastInventoryProgressAt || 0) < LOOP_CONFINE_MS;
        const confined = confinedMs >= LOOP_CONFINE_MS && !inventoryIsProgressing;
        const tooLong = Number.isFinite(goal.maxRuntimeMs) && runningMs >= goal.maxRuntimeMs;
        if (!confined && !tooLong) return false;
        const description = this._describeTask(goal.action, goal.params);
        const why = confined
            ? `orbiting one ${LOOP_CONFINE_RADIUS}-block patch for ${Math.round(confinedMs / 60000)}min`
            : `stuck on ${description} for ${Math.round(runningMs / 60000)}min with no finish`;
        this.log('warn', `loop detected: ${why}; breaking ${description}`);
        try {
            this.memory.recordFailure(goal.action, goal.params?.target, `looping: ${why}`);
            this.memory.record('recovery', `broke a loop (${why})`, {
                action: goal.action, target: goal.params?.target,
                position: this.gameState.position, dimension: this.gameState.dimension
            });
        } catch { /* memory best-effort */ }
        this._markPendingAborted(goal.id, `looping: ${why}`);
        this._applyMinecraftEvent('looping');
        // don't let the next tick immediately re-pick the action that just looped
        this._avoidAction = goal.requestedAction || goal.action;
        this._avoidUntil = now + LOOP_AVOID_MS;
        this.activeGoal = null;
        this.currentTask = `breaking out of a loop (${description})`;
        this._pushCommentary(this._loopBreakLine(description, confined, Math.round((confined ? confinedMs : runningMs) / 60000)));
        // stop; the next autonomy tick picks something different (looped action filtered out)
        this.executeAction('stop', {}, { priority: 'urgent', source: 'loop-recovery', waitForCompletion: false })
            .catch((err) => this.log('warn', `failed to stop looping goal: ${err.message}`));
        return true;
    }

    _loopBreakLine(description, confined, minutes) {
        const lines = confined ? [
            `okay i've been circling this exact spot for like ${minutes} minutes. i'm calling it, moving on`,
            `${minutes} minutes in the same ten square feet. that's it, new plan, we're leaving`,
            `chat i think i soft-locked myself pacing here. breaking out, going somewhere new`,
            `${minutes} laps of shame is my limit. relocating before i lose it`
        ] : [
            `${minutes} minutes on ${description} and nothing to show for it. abandoning ship`,
            `okay ${description} is a dead end. ${minutes} minutes gone, i'm bailing`,
            `pulling the plug on ${description}, it's going nowhere. onto the next dumb idea`
        ];
        return this._pickFresh('loop-break', lines);
    }

    // ---- reactions / commentary -----------------------------------------

    // pick a line without repeating the one just used for this key. plain
    // Math.random over a pool says the same thing twice constantly, and a
    // one-line pool said it EVERY time - which is exactly how a canned line
    // starts sounding canned.
    _pickFresh(key, lines) {
        if (!Array.isArray(lines) || !lines.length) return null;
        if (lines.length === 1) return lines[0];
        if (!this._lastPicked) this._lastPicked = new Map();
        const previous = this._lastPicked.get(key);
        const fresh = lines.filter((line) => line !== previous);
        const pool = fresh.length ? fresh : lines;
        const choice = pool[Math.floor(Math.random() * pool.length)];
        this._lastPicked.set(key, choice);
        return choice;
    }

    _react(event, data) {
        const now = Date.now();
        const last = this.reactionCooldowns.get(event) || 0;
        if (now - last < (REACTION_COOLDOWN_OVERRIDES[event] || REACTION_COOLDOWN_MS)) return;

        this.reactionCooldowns.set(event, now);
        // NO PRE-WRITTEN REACTION LINES. this used to pick from a canned pool and
        // push it as commentary, which is how the same sentence reached the
        // audience over and over. every event already goes out via
        // emit('gameEvent') above, and burnt.js turns it into a prompt her brain
        // answers - so the reaction is written fresh, by her, every time. what
        // stays here is only the GAMEPLAY response.

        // reactive safety actions (only when autonomous, so we never yank a
        // viewer-issued task out from under them)
        if (this.enabled && this.autonomous && !this.currentAction) {
            if (event === 'creeper_spotted') {
                this._safeExecute('defend', {}, null);
            } else if (event === 'nightfall') {
                // night: go home if there's a home to return to. parking in the
                // open ("idle") just looks afk and builds nothing - without a
                // home she keeps living her arc and only holds position when
                // hostiles are genuinely pressing (altoclef's survival chain
                // covers mobs while she works).
                const home = this._home();
                const homeDist = this._homeDistance();
                // a home she has already given up on is not somewhere to sleep.
                if (home && !this._homeRelocation && homeDist > 24 && homeDist < 1500) {
                    this._safeExecute('go_home', {}, `night's here. heading back to ${home.name}`);
                } else if ((!home || this._homeRelocation) && (this.gameState.nearbyHostiles || 0) >= 2) {
                    this._safeExecute('idle', {}, null);
                }
                // else: fall through - the autonomy tick keeps the homestead arc moving
            } else if (event === 'weather_changed') {
                // the sky just turned over. if it's landing on her and she has a
                // roof, start walking now rather than at the next idle tick -
                // that gap is up to 25 seconds of standing in a downpour. the
                // shelter pull owns the cooldown, so this cannot double-fire with
                // the autonomy tick.
                const shelter = this._rainShelterBehavior();
                if (shelter && !this._safeExecute(shelter.action, shelter.params, shelter.say)) {
                    // refused: hand the cooldown back so the idle tick can retry.
                    this._homesteadCooldowns.delete('rain_shelter');
                }
            }
        }
    }


    // queue burnt-voice commentary. does NOT speak it directly from here - see
    // class note. we emit for subscribers (burnt.js voices idle 'narration' on a
    // rate limit; event 'reaction' lines are already voiced via the gameEvent
    // path, so they stay overlay-only) and mirror to the ui websocket if one exists.
    _pushCommentary(text, kind = 'narration') {
        if (!text) return;
        const entry = { text, at: Date.now(), task: this.currentTask, kind };
        this.commentaryQueue.push(entry);
        if (this.commentaryQueue.length > 50) this.commentaryQueue.shift();
        this.emit('commentary', entry);
        // NOTHING here is spoken verbatim. commentary is an internal CUE that
        // your brain rewrites ("you're playing on your own and thinking: ...")
        // so the words the audience gets are always your character's. it must
        // never be published straight to server chat - that is what made
        // pre-written strings show up in-game word for word. she talks in
        // minecraft through her own `chat` tool action, in her own words.

        // optional best-effort mirror to your own UI / stream overlay. inject it
        // with `new MinecraftTool({ broadcast })` or setBroadcast(fn); leave it
        // unset and this is a no-op. never throws - a broken overlay must not
        // take the bot down.
        try {
            if (typeof this.broadcast === 'function') this.broadcast(entry);
        } catch { /* ignore */ }
    }

    // DELETED: auto-publishing commentary to server chat. it took the internal
    // cue strings and sent them to the server WORD FOR WORD, which is exactly how
    // pre-written lines ended up in front of real players. she still talks in
    // minecraft - through her own `chat` tool action, composed by her brain from
    // what is actually happening (see the multiplayer block in modes.js).

    // drain queued commentary (for a consumer that wants to speak it safely).
    pullCommentary() {
        const out = this.commentaryQueue.slice();
        this.commentaryQueue = [];
        return out;
    }

    // ---- shutdown --------------------------------------------------------

    shutdown() {
        if (this.autonomousTimer) {
            clearInterval(this.autonomousTimer);
            this.autonomousTimer = null;
        }
        if (this._idleWakeTimer) {
            clearTimeout(this._idleWakeTimer);
            this._idleWakeTimer = null;
        }
        this._failAllPending('tool shutting down');
        if (this.client) {
            try { this.client.close(); } catch { /* ignore */ }
            this.client = null;
        }
        if (this.wss) {
            try { this.wss.close(); } catch { /* ignore */ }
            this.wss = null;
        }
        this.connected = false;
        this.gameConnected = false;
        this.companionSocketConnected = false;
        try { this.memory.flush(); } catch { /* memory best-effort */ }
    }
}

// ready-made singleton for the common case of one bot. construct MinecraftTool
// yourself if you need more control (a different memory path, names, hooks).
const minecraftTool = new MinecraftTool();
export default minecraftTool;
export { MinecraftTool };
