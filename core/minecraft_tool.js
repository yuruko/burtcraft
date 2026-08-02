// node/tools/minecraft_tool.js
// the burnt-side brain for the minecraft (burtcraft) integration.
//
// execute_minecraft() in ../tools.js depends on a singleton `minecraftTool`
// that was referenced but never actually shipped - this is that module.
//
// topology: this module runs a websocket SERVER. the minecraft_bot_bridge.js
// process (which lives next to altoclef/baritone and relays into the game) is
// the CLIENT that connects to it. burnt's node server is always-on, so it's the
// stable endpoint; the bridge reconnects to it whenever minecraft (re)launches.
//
//   burnt.js (tool system)
//      -> minecraftTool  (ws server, THIS file, port 7431)
//         <-> minecraft_bot_bridge.js  (ws client, relays commands)
//             <-> altoclef external command server (in-game)
//                 <-> baritone -> minecraft world
//
// responsibilities kept here (decoupled from altoclef command syntax, which the
// bridge owns):
//   - action dispatch with ack + final-response + timeout
//   - live game-state sync from bridge events/state/heartbeat
//   - autonomous behavior (idle / mood-weighted / reactive safety)
//   - natural-language chat-command interpretation for viewer-driven play
//   - session stats + burnt-voice commentary queue (never touches the tts
//     speech queue directly - see note on commentary below)
//
// import is side-effect free: the server + timers only start on initialize(),
// which execute_minecraft() calls lazily on first use.

import { WebSocketServer } from 'ws';
import EventEmitter from 'events';
import { RecentEvents } from './recent_events.js';
import { MinecraftMemory, OVEN_KINDS } from './minecraft_memory.js';
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
    hostiles_nearby: 45 * 1000
};
const VIEWER_SUGGESTION_COOLDOWN_MS = 10000;
const MAX_VIEWER_SUGGESTIONS = 12;
const MAX_TELEMETRY_AGE_MS = 15000;
// The relay heartbeats every 30s. If it goes silent for more than two beats,
// treat the socket as half-open and force a reconnect. A world that still
// claims to be ready but has produced no client-thread telemetry for 45s is
// similarly unsafe to control; dropping the relay link makes its fail-safe stop
// the in-game task before it reconnects.
const BRIDGE_SILENCE_MS = 75000;
const TELEMETRY_FAULT_MS = 45000;
const AUTONOMOUS_STALL_MS = 120000;
// loop detection: she can "make progress" (position keeps changing) while going nowhere -
// orbiting one patch, or grinding a goal that never resolves. catch both.
const LOOP_CONFINE_RADIUS = 24;            // blocks (horizontal): orbiting within this = "same spot"
const LOOP_CONFINE_MS = 5 * 60 * 1000;     // confined to that patch this long (while moving) -> loop
const DEFAULT_FINITE_GOAL_MAX_MS = 15 * 60 * 1000;
const GOAL_MAX_RUNTIME_MS = {
    // A full speedrun is intentionally long-lived. Movement/confinement and
    // no-progress checks still apply, but there is no arbitrary wall-clock stop.
    speedrun: null
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
const LLM_GOAL_GRACE_MS = 20000;
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
// AND exempt from the f1 guard below, which is deliberate - when yuru takes the
// keyboard the hud should still be able to say so rather than freeze on a stale line.
// 'set_home' is a memory write, not a goal - and it stays allowed under f1 so yuru can
// walk her somewhere good and say "this is home" while holding the keyboard.
const NON_TASK_ACTIONS = new Set(['chat', 'stop', 'status', 'inventory', 'coords', 'enable', 'disable', 'autonomous', 'look', 'boat', 'hud', 'set_home']);

// the in-game intent line: "<what she's doing>" / "<why>" / "<live altoclef phase>".
// verbs are present-continuous so the hud reads as a sentence about a person rather
// than a command echo ("crafting a stone pickaxe", not "craft stone_pickaxe").
const INTENT_VERBS = {
    craft: 'crafting', get: 'getting', mine: 'mining', collect: 'collecting',
    move: 'heading to', follow: 'following', explore: 'exploring', idle: 'killing time',
    defend: 'fighting back', attack: 'going after', eat: 'eating', hunt: 'hunting',
    equip: 'gearing up', deposit: 'stashing loot', stash: 'stashing loot',
    place: 'placing', speedrun: 'speedrunning', locate: 'searching for',
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
// multiplayer chat manners: what reaches her brain and how fast she may type.
// addressed lines (her name / the owner) always surface (per-sender gap only);
// ambient server chatter is sampled so she joins in occasionally like a person
// instead of replying to every line on a public server.
// the names YOUR vtuber answers to. a server line containing one of these counts
// as addressed to her and always surfaces to your brain (ambient chatter is
// sampled instead). set BOT_NAMES="ada,ada bot" in the env, pass
// `new MinecraftTool({ names: [...] })`, or call setBotNames([...]) at runtime.
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
const CHAT_OUT_MIN_GAP_MS = 3000;
const CHAT_OUT_PER_MIN = 8;
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
const PERSISTENT_ACTIONS = new Set(['follow', 'idle', 'explore']);
// long-lived macro goals that manage their OWN recovery. the @gamer speedrun runs
// for the whole game and legitimately camps one area for a while (farming a blaze
// spawner, digging out a stronghold, boating an ocean), so burnt's external
// stall/loop killer must NOT abort it - the task has its own timeout/wander
// recovery. these stay finite (they do finish), just exempt from the watchdog.
const WATCHDOG_EXEMPT_ACTIONS = new Set(['speedrun']);
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
// shapes that read as "please do something" - imperatives, favours, invitations.
// used only to decide whether an ask reaches her; she still chooses freely.
// how long a person's request stays actionable. long enough that she finishes
// the current 25s tick and still honours it, short enough that she isn't acting
// on something someone said ten minutes ago.
const REQUEST_ACT_WINDOW_MS = 90 * 1000;
const REQUEST_SHAPE_RE =/(\b(can|could|would|will|wanna|want to|plz|pls|please|help|come|bring|make|build|get|find|follow|show|give|let'?s|lets)\b)|(\?\s*$)/i;
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
// yuru's rule, stated plainly: she is NEVER in open water for minutes. half a
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
const RECENT_DESTINATION_CAP = 32;
const RECENT_DESTINATION_TTL_MS = 30 * 60 * 1000;
const RECENT_DESTINATION_RADIUS = 140;        // blocks: wider than a claim, tighter than a venture
// only long relocations record the place she is LEAVING. without that the first hop
// back is never caught (she started at A, so A was never a recorded destination), but
// applying it to short drifts (120-180 blocks) would fight the 140-block radius.
const LONG_RELOCATION_MIN = 300;
const HOMESTEAD_STEP_COOLDOWN_MS = 4 * 60 * 1000;
const HOMESTEAD_BIAS = 0.75;                       // chance the arc outranks the mood menu
const HOMESTEAD_SETTLE_DIST_MP = 450;              // min blocks from session anchor (multiplayer)
const HOMESTEAD_SETTLE_DIST_SP = 120;              // min blocks (singleplayer)
const HOMESTEAD_NEAR_HOME = 32;                    // "at home" radius for placement steps
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
// how many units of each kind the collection wants before she stops adding.
// the plain furnace is the one she hoards - it's the toaster.
const OVEN_TARGETS = { furnace: 3, smoker: 2, campfire: 2, blast_furnace: 1 };
// what she needs before an oven kind is even craftable, so the drive never asks
// for a blast furnace with no iron and burns a cooldown on a doomed goal.
const OVEN_PREREQ = { blast_furnace: /iron_ingot|iron_block/ };
const MAX_LAVA_PILGRIMAGES = 1;                    // per home; a shrine, not a hobby
const SAFETY_INTERVENTION_COOLDOWN_MS = 12 * 1000;
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
        xpLevel: 0,
        selectedItem: 'empty',
        offhandItem: 'empty',
        armor: [],
        air: 300,
        maxAir: 300,
        inLava: false,
        inWater: false,
        underwater: false,
        isInCombat: false,
        currentTask: null,
        // live altoclef task readout from the in-game companion: botTask is the
        // high-level goal + phase ("beating the game.: getting blaze rods"),
        // botAction is the concrete micro-action underneath. empty when idle.
        botTask: '',
        botAction: '',
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
        case 'build': return 'built something';
        default: return null; // status/coords/inventory/idle/stop/etc - not accomplishments
    }
}

class MinecraftTool extends EventEmitter {
    constructor({ memory = null, registerMemoryExitHook = true, names = null, broadcast = null } = {}) {
        super();

        // names she answers to on a public server (see buildAddressedRe above).
        if (names) setBotNames(names);
        // optional sink for internal commentary cues, mirrored to your UI.
        this.broadcast = broadcast;

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
        // "just standing there" guards: when she last took a hit, and how long a
        // task has been running with no burnt-side goal behind it
        this._lastDamageAt = 0;
        this._orphanTaskSince = 0;
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
        this._sessionAnchor = null;
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
        this._recentDestinations = [];       // where she has just been sent (anti-ping-pong)
        // server protection denials ("you are not allowed to interact...") -
        // repeated hits mean claimed land: abort the goal and relocate far
        this._protectionDenials = [];
        this._lastProtectionEscapeAt = 0;
        this._escapingProtection = false;

        this.autonomousTimer = null;
        this.lastAutonomousAt = 0;
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
            // jobs. Persistent behaviours (follow/explore/idle) remain visible
            // in status but are deliberately not auto-stopped by the watchdog.
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
        // ends gamer mode; the run is no longer live to narrate.
        if (pending.action === 'speedrun') {
            this.gamerMode = false;
            this._lastBotTaskPhase = '';
        }

        if (msg.status === 'success') {
            if (msg.result?.persistent) {
                this.emit('actionStarted', { id: msg.action_id, action: pending.action, params: pending.params, result: msg.result });
            } else {
                if (!NON_TASK_ACTIONS.has(pending.action)) this._lastTaskOutcomeAt = Date.now();
                if (!NON_TASK_ACTIONS.has(pending.action)) this._applyMinecraftOutcome(true, pending.action);
                this._recordCompletion(pending.action, pending.params);
                this.memory.record('completed', this._describeTask(pending.action, pending.params || {}), {
                    action: pending.action,
                    target: pending.params?.target,
                    position: this.gameState.position,
                    dimension: this.gameState.dimension
                });
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
                this._lastTaskOutcomeAt = Date.now();
                if (!wasStopped) this.memory.recordFailure(pending.action, pending.params?.target, error.message);
            }
            if (this.activeGoal?.id === msg.action_id) this.activeGoal = null;
            if (wasStopped) {
                // silent event for observers - whoever issued the stop already
                // voiced why, so there is nothing to narrate here.
                this.emit('actionStopped', { id: msg.action_id, action: pending.action, params: pending.params });
            } else {
                if (!NON_TASK_ACTIONS.has(pending.action)) this._applyMinecraftOutcome(false, pending.action);
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
        if (freshObservation && this.enabled && this.connected && this.gameConnected) {
            if (this._recoverPinnedByMobs()) return;
            this._waterWatchdog();
            this._pushIntentHud();
            this._maybeNarrateToRoom();
        }
    }

    // people are standing around a bot that is visibly DOING something and never
    // says a word about it. when the room is populated but chat has gone idle,
    // nudge her brain to volunteer a line in game - a CUE, never a written line,
    // so the words are hers (see the no-canned-responses rule). rare and sampled:
    // company, not a commentary track.
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
                    ? 'yuru took the keyboard (f1) - hands off the controls'
                    : 'got the controls back from yuru');
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
            if (action === 'place' && OVEN_KINDS.includes(target)) {
                // a finished place is a real new unit, so never merge it into a
                // neighbour just because she didn't move between installs
                const recorded = this.memory.recordOven(target, this.gameState.position, this.gameState.dimension, params.name || null, { dedupe: false });
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
        this.send({ type: 'config', enabled: false, autonomous: false });
        this.emit('disabled');
        return this.enabled;
    }

    setAutonomousMode(on) {
        this.autonomous = !!on;
        this.send({ type: 'config', autonomous: this.autonomous });
        this.log('info', `autonomous mode ${this.autonomous ? 'on' : 'off'}`);
        return this.autonomous;
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
    async startGamerMode() {
        if (!this.enabled) this.enable();
        if (this.currentAction === 'speedrun' || this.activeGoal?.action === 'speedrun') {
            this.gamerMode = true;
            return { started: true, alreadyRunning: true, task: 'speedrun (.gamer)' };
        }
        this.gamerMode = true;
        this.setAutonomousMode(false); // the speedrun owns the bot; no idle interference
        this._lastBotTaskPhase = '';
        try {
            const result = await this.executeAction('speedrun', {}, { source: 'gamer', waitForCompletion: false });
            this.emit('gamerMode', { on: true });
            return result;
        } catch (err) {
            // dispatch failed (offline / stale / busy) - don't leave the flag set
            this.gamerMode = false;
            throw err;
        }
    }

    // leave gamer mode: stop the speedrun and clear the flag. autonomous stays
    // off (it was disarmed on entry) - the operator/brain re-arms self-play if
    // they want idle play again.
    stopGamerMode() {
        this.gamerMode = false;
        this._lastBotTaskPhase = '';
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
                confinedMs: this.activeGoal.anchorAt ? Date.now() - this.activeGoal.anchorAt : 0
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
            home: this.memory.getHome()?.name || null,
            deathSpot: this.memory.getDeathSpot(),
            knownPlayers: this.knownPlayers(12),
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
    executeAction(action, params = {}, opts = {}) {
        return new Promise((resolve, reject) => {
            if (typeof action !== 'string' || !action.trim()) {
                reject(new Error('minecraft action must be a non-empty string'));
                return;
            }
            action = action.trim().toLowerCase();
            if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

            // favorite-spot navigation: 'go_home' and 'move' with a saved-spot
            // name both resolve to real coordinates here, so every caller (llm
            // tool, autonomy tick, chat suggestion) can use her remembered places.
            // a place she deliberately SAVED is exempt from the no-water rule
            // below: terrain cells are 64 blocks wide, so one swim past a coastal
            // home is enough to mark the cell she lives in as ocean.
            let savedPlace = false;
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
            if (action === 'go_home') {
                const home = this.memory.getHome(this._worldId());
                if (!home) {
                    reject(new Error('no home set yet - stand somewhere good and use set_home first'));
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

            // open water is not a destination. a goto whose target sits in a cell
            // she has personally been wet in is refused before it ever reaches
            // baritone - whoever asked, her own brain included. the escape swim is
            // the one exemption: that goal exists to get her OUT.
            if (action === 'move' && !savedPlace && opts.source !== 'water-escape' && this._destinationIsWet(params)) {
                reject(new Error('that spot is open water and i have a strict no-swimming policy. pick land'));
                return;
            }

            // outgoing chat pacing: talk like a person, never spam the server.
            // Only a message actually handed to the bridge consumes the budget.
            let chatSendAt = null;
            if (action === 'chat') {
                const nowChat = Date.now();
                this._chatSendTimes = this._chatSendTimes.filter((t) => nowChat - t < 60000);
                const lastSend = this._chatSendTimes[this._chatSendTimes.length - 1] || 0;
                if (this._chatSendTimes.length >= CHAT_OUT_PER_MIN || nowChat - lastSend < CHAT_OUT_MIN_GAP_MS) {
                    reject(new Error('easing off server chat for a few seconds so it doesn\'t read as spam'));
                    return;
                }
                chatSendAt = nowChat;
            }

            // f1 manual control: the human owns the keyboard - bot goals are
            // refused (the companion enforces this too); chat/status still work
            if (this.manualControl && !NON_TASK_ACTIONS.has(action)) {
                reject(new Error('manual control is on (f1) - yuru has the keyboard right now'));
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
            if (isTaskAction && hasPendingTask) {
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
                params,
                waitForCompletion,
                timeoutMs,
                source: opts.source || 'agent',
                why: opts.why || null,
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
            if (chatSendAt !== null) this._chatSendTimes.push(chatSendAt);

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
            params: pending.params || {},
            source: pending.source,
            why: pending.why || null,   // her stated reason, for the in-game hud
            persistent,
            // persistent behaviours (follow/idle/explore) and self-recovering
            // macros (speedrun) are not auto-killed by the stall/loop watchdog.
            watchdog: !persistent && !watchdogExempt,
            maxRuntimeMs: persistent
                ? null
                : (Object.prototype.hasOwnProperty.call(GOAL_MAX_RUNTIME_MS, pending.action)
                    ? GOAL_MAX_RUNTIME_MS[pending.action]
                    : DEFAULT_FINITE_GOAL_MAX_MS),
            startedAt: now,
            lastProgressAt: now,
            lastInventoryProgressAt: now,
            lastPosition: this._point(this.gameState.position),
            lastInventorySignature: this._inventorySignature()
        };
        return this.activeGoal;
    }

    _observeGoalProgress(partial = {}) {
        if (!this.activeGoal) return;
        const now = Date.now();
        let progressed = false;
        const point = this._point(this.gameState.position);
        const previous = this.activeGoal.lastPosition;
        if (point && (!previous || Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) >= 1)) {
            this.activeGoal.lastPosition = point;
            progressed = true;
        }
        // Mining, crafting, and smelting can make real progress without moving
        // a full block. Treat a changed inventory snapshot as progress too, so
        // the stall watchdog does not cancel a productive stationary task.
        if (Object.prototype.hasOwnProperty.call(partial, 'inventory')) {
            const inventorySignature = this._inventorySignature();
            if (inventorySignature !== this.activeGoal.lastInventorySignature) {
                this.activeGoal.lastInventorySignature = inventorySignature;
                this.activeGoal.lastInventoryProgressAt = now;
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
            const spot = this._pickLandingSpot(p, 120, 260);
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

    _intentPayload() {
        const trim = (s, n = 88) => {
            const one = String(s || '').replace(/\s+/g, ' ').trim();
            return one.length > n ? `${one.slice(0, n - 1)}…` : one;
        };
        const what = trim(this._intentWhat());
        if (!what) return { what: '', why: '', phase: '' };
        const goal = this.activeGoal;
        // her own `say` if she had a reason; otherwise who wanted this
        const why = goal ? (goal.why || INTENT_SOURCE_WHY[goal.source] || '') : '';
        const phase = this._cleanPhase(this.gameState.botAction)
            || this._cleanPhase(this.gameState.botTask) || '';
        return { what, why: trim(why), phase: trim(phase) };
    }

    // only ever sent when the line actually changes - the hud is cosmetic and must
    // never become traffic. an empty payload clears it (the companion also expires a
    // stale line on its own, so burnt dying never leaves a lie on screen).
    _pushIntentHud() {
        if (!this.connected || !this.gameConnected) return;
        const now = Date.now();
        if (now - (this._lastIntentPushAt || 0) < INTENT_PUSH_MIN_GAP_MS) return;
        const payload = this._intentPayload();
        const signature = `${payload.what}|${payload.why}|${payload.phase}`;
        if (signature === this._lastIntentSignature) return;
        this._lastIntentSignature = signature;
        this._lastIntentPushAt = now;
        const encoded = payload.what
            ? Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
            : '';
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
    _worldId() {
        const g = this.gameState;
        if (g.multiplayer === true && g.server) return String(g.server).slice(0, 80);
        return g.multiplayer === true ? 'multiplayer' : 'singleplayer';
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

    shouldSurfaceChat(sender, text) {
        const s = String(sender || '').trim();
        const t = String(text || '').trim();
        if (!s || !t) return { surface: false };
        this._rememberPlayer(s);
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
        if (owner || addressed) {
            if (now - senderLast < CHAT_SENDER_GAP_MS) return { surface: false };
            this._chatSenderLastAt.set(key, now);
            return { surface: true, addressed: true, owner };
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

    _failAllPending(reason) {
        for (const [id, pending] of this.pendingActions) {
            clearTimeout(pending.timer);
            if (!pending.settled) {
                pending.settled = true;
                pending.reject(new Error(reason));
            }
            this.pendingActions.delete(id);
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
        if (!NON_TASK_ACTIONS.has(pending.action)) {
            this._lastTaskOutcomeAt = Date.now();
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

        // stop / cancel
        if (/\b(stop|halt|cancel|quit it|knock it off|abort)\b/.test(t)) {
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
            return new RegExp(`(^|[^a-z_])${kind}([^a-z_]|$)`).test(this._carrying())
                ? { action: 'place', target: kind }
                : { action: 'get', target: kind, params: { amount: 1 } };
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
        // move to coords
        const coords = t.match(/\b(?:go to|move to|walk to|head to)\s+(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/);
        if (coords) {
            return { action: 'move', params: { x: +coords[1], y: +coords[2], z: +coords[3] } };
        }
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
        return REQUEST_SHAPE_RE.test(t);
    }

    recordViewerSuggestion(username, text, { inGame = false } = {}) {
        // only trust the name as a minecraft username when the line came from
        // server chat - a twitch handle is not a player and must never become a
        // follow target.
        const suggestion = this.interpretChatCommand(text, inGame ? username : null);

        // A plain chat request must never turn into an immediate dangerous or
        // disruptive action. Stops, player attacks, giving items, and chat
        // messages are handled only by an explicit operator/model tool call.
        // 'set_home' is here for a different reason than the rest: it is not dangerous,
        // it is PERSONAL. where she lives is hers to choose, so a person asking becomes
        // a request she can take or refuse in her own words - never a stranger planting
        // her house somewhere by typing one line.
        if (suggestion && ['stop', 'attack', 'give', 'chat', 'set_home'].includes(suggestion.action)) return null;

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
            at: now
        };
        this.viewerSuggestions.push(entry);
        if (this.viewerSuggestions.length > MAX_VIEWER_SUGGESTIONS) this.viewerSuggestions.shift();
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

    _urgentSafetyBehavior() {
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
            if (!hasFood && Number.isFinite(hunger) && hunger < 19) {
                return {
                    action: 'eat',
                    params: this._eatParams(),
                    say: 'i am not finishing this job this hurt with no food. backing off and finding something edible'
                };
            }
            return {
                action: null,
                params: {},
                say: hasFood
                    ? 'i am not finishing this job this hurt. backing off long enough to eat and regenerate'
                    : hostiles
                    ? 'no food and too hurt for heroics. aborting the job and letting them pass'
                    : 'too hurt to keep forcing this. pausing until the situation is sane'
            };
        }
        if (Number.isFinite(hunger) && hunger <= 4) {
            // hasFood used to mean action:null here - she announced a food break
            // and then did NOTHING, over and over, while holding bread.
            //
            // an eat that does not move the hunger bar must NOT be retried every
            // tick: that burned every 25s cycle on a no-op and looked exactly
            // like standing still doing nothing. back off instead, so the rest of
            // the idle brain gets its turn.
            if (Date.now() - (this._lastEatAttemptAt || 0) < EAT_RETRY_GAP_MS) return null;
            this._lastEatAttemptAt = Date.now();
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
            const busy = this.currentAction || this.currentTask || this.activeGoal || this.pendingActions.size > 0;
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

    _isInWater() {
        const g = this.gameState;
        if (g.inWater === true || g.underwater === true) return true;
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
    }

    // the server just told her she may not touch this place. remember the GROUND, not
    // the goal: a claim belongs to the location and outlives whatever she was trying
    // to do there, so blacklisting the action alone sends her straight back.
    _recordClaimHere(point) {
        this._ensureTerrainLoaded();
        const p = point || this.gameState.position;
        if (!p || !Number.isFinite(Number(p.x))) return;
        const key = this._cellKey(Number(p.x), Number(p.z));
        if (this._claimedCells.has(key)) return;
        this._claimedCells.add(key);
        try { this.memory.recordClaimedArea(key); } catch { /* best-effort */ }
    }

    _isClaimedCell(x, z) {
        return this._claimedCells.has(this._cellKey(x, z));
    }

    // every long-distance destination she commits to, so the spot picker can refuse to
    // send her back where she just came from. this is the anti-ping-pong memory: the
    // scorer REWARDS familiar ground, which means without this the highest-scoring
    // escape from A is always B, and from B is always A, forever.
    _rememberDestination(spot) {
        if (!spot || !Number.isFinite(Number(spot.x))) return;
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
            if (Math.hypot(x - d.x, z - d.z) < RECENT_DESTINATION_RADIUS) { d.at = now; return; }
        }
        this._recentDestinations.push({ x, z, at: now });
        while (this._recentDestinations.length > RECENT_DESTINATION_CAP) this._recentDestinations.shift();
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
    _pickLandingSpot(origin, minDist, maxDist) {
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
                if (strict && this._isRecentDestination(x, z)) continue;
                let score = route.dry + (this._dryCells.has(this._cellKey(x, z)) ? 0.5 : 0);
                if (!strict) {
                    // relaxed pass: get as far from her own recent history as the
                    // terrain allows, rather than accepting the first thing going
                    const away = this._distanceToNearestRecent(x, z);
                    score += Number.isFinite(away) ? Math.min(away, 900) / 900 : 1;
                }
                if (!best || score > best.score) best = { x, z, score };
                // the relaxed pass must compare every candidate; stopping at the first
                // good-enough route is what would hand back the spot she just left
                if (strict && route.dry >= KNOWN_ROUTE_MIN_DRY_FRACTION) break;
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
        const home = this.memory.getHome();
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
                priority: 'normal', source: 'request', waitForCompletion: false
            });
            this._pushCommentary(`${req.user} asked, so that's what i'm doing now`);
        })().catch((err) => {
            this.log('warn', `viewer request ${req.action} could not start: ${err.message}`);
        }).finally(() => {
            this._requestIntervention = null;
        });
        return true;
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
        if (this.manualControl) return; // yuru has the keyboard (f1)
        if (this._stateIsStale()) return;
        this._observeMinecraftState();
        if (this._waterWatchdog()) return;
        // Goal recovery protects every Burnt-issued finite task, including
        // operator/LLM actions made while autonomous self-play is off.
        if (this._recoverStalledGoal()) return;
        if (this._recoverLoopingGoal()) return;
        if (!this.autonomous) return;
        const urgentSafety = this._urgentSafetyBehavior();
        if (urgentSafety) {
            this._requestSafetyIntervention(urgentSafety.action, urgentSafety.params, urgentSafety.say);
            return;
        }
        // persistent behaviors (explore/idle/follow) never finish on their own -
        // without a dwell budget the first autonomous explore (or nightfall idle)
        // parks the loop permanently: currentTask stays set and the gate below
        // returns on every tick until chat re-tasks her.
        //
        // this used to exempt viewer/llm-issued persistent goals entirely, which
        // meant one `idle` from her own brain parked her forever: persistent
        // goals are watchdog-exempt too, so NOTHING could recover it. every
        // persistent goal is now bounded - a hand-issued one just gets a longer
        // leash than one the idle menu picked.
        const dwellGoal = this.activeGoal;
        if (dwellGoal && dwellGoal.persistent) {
            const base = dwellGoal.action === 'idle' ? PERSISTENT_IDLE_DWELL_MS : PERSISTENT_DWELL_MS;
            let dwellMs = dwellGoal.source === 'autonomous' ? base : base * PERSISTENT_REQUESTED_DWELL_MULT;
            // being hurt ends a parked goal early no matter who asked for it.
            // she was found standing in the dark on 11 health taking hits.
            const hurtRecently = Date.now() - (this._lastDamageAt || 0) < PERSISTENT_DANGER_BREAK_MS;
            if (hurtRecently) dwellMs = Math.min(dwellMs, PERSISTENT_DANGER_BREAK_MS);
            if (Date.now() - dwellGoal.startedAt >= dwellMs) {
                const description = this._describeTask(dwellGoal.action, dwellGoal.params);
                const why = hurtRecently ? 'was taking damage while parked' : `hit its ${Math.round(dwellMs / 60000)}min dwell budget`;
                this.log('info', `${dwellGoal.source} ${description} ${why}; rotating`);
                this.memory.record('completed', `${description} (${hurtRecently ? 'broken off - taking hits' : 'dwell budget spent'}, moving on)`, {
                    action: dwellGoal.action,
                    target: dwellGoal.params?.target,
                    position: this.gameState.position,
                    dimension: this.gameState.dimension
                });
                this._avoidAction = dwellGoal.action;
                this._avoidUntil = Date.now() + LOOP_AVOID_MS;
                this._applyMinecraftEvent('bored');
                this.activeGoal = null;
                this.currentTask = null;
                this.executeAction('stop', {}, { priority: 'urgent', source: 'dwell-rotation', waitForCompletion: false })
                    .catch((err) => this.log('warn', `failed to stop ${description}: ${err.message}`));
                return;
            }
        }
        // ORPHAN GUARD. the gate below refuses to pick anything while currentTask
        // is set - so a task nobody owns parks her permanently. that happens for
        // real: altoclef's GetToXZTask only finishes on an EXACT block match and
        // has no failure state at all, so an unreachable goto runs forever
        // without ever finishing or erroring, and the goal that started it is
        // long gone. if nothing burnt-side owns the task, it cannot be supervised
        // by the stall/loop watchdogs either, so cut it loose.
        if (this.currentTask && !this.activeGoal && !this.currentAction && this.pendingActions.size === 0) {
            if (!this._orphanTaskSince) this._orphanTaskSince = Date.now();
            if (Date.now() - this._orphanTaskSince >= ORPHAN_TASK_LIMIT_MS) {
                this.log('warn', `no goal owns "${this.currentTask}" - clearing it so she can pick something`);
                this.recentEvents.record('shook off a task that had stopped going anywhere');
                this._orphanTaskSince = 0;
                this.currentTask = null;
                this.executeAction('stop', {}, { priority: 'urgent', source: 'orphan-recovery', waitForCompletion: false })
                    .catch((err) => this.log('warn', `orphan stop failed: ${err.message}`));
                return;
            }
        } else {
            this._orphanTaskSince = 0;
        }
        // A REAL PERSON ASKED FOR SOMETHING. this used to go nowhere: suggestions
        // were only ever read into her PROMPT, so unless her brain happened to be
        // mid-reply and chose to act, the idle brain just re-picked its own goal
        // 25s later and steamrolled the request. someone saying "come here" and
        // being ignored is the worst possible look on a public server, so an ask
        // now outranks anything the idle menu picked.
        if (this._actOnRequest()) return;
        // don't stack behaviors on top of an active task or a viewer command
        if (this.currentAction || this.currentTask || this.pendingActions.size > 0) return;
        // a task just finished/failed: the outcome is already queued to burnt's
        // brain, which usually picks what's next. hold the fixed menu back so her
        // reasoned choice leads; the menu is only the fallback for real idle time.
        if (Date.now() - this._lastTaskOutcomeAt < LLM_GOAL_GRACE_MS) return;
        // gear up before wandering. the idle menu is pure entertainment picks, so
        // she used to spawn in with nothing, walk into the dark, and get shot by a
        // skeleton with no pickaxe and no food. one prep goal beats one more death.
        const prep = this._survivalPrep();
        if (prep) {
            this.lastAutonomousAt = Date.now();
            this._survivalPrepCooldowns.set(prep.key, Date.now());
            this._safeExecute(prep.action, prep.params, prep.say);
            return;
        }
        // bread tendency: burnt loves bread. with downtime and wheat on hand she
        // gravitates to baking a loaf (she collects + eats bread). fires ~45% of
        // idle ticks when she has the makings; then the wheat's spent and she moves on.
        // crafting from CARRIED wheat is claim-safe (>=3 in hand, no farm
        // grinding) - on servers she prefers to bake at the homestead, in
        // singleplayer anywhere. hunting wheat lives in the homestead arc.
        if (this._hasWheat() && Math.random() < 0.45 &&
            (this.gameState.multiplayer !== true || this._homeDistance() <= 64)) {
            this.lastAutonomousAt = Date.now();
            this._safeExecute('craft', { target: 'bread' }, this._breadLine());
            return;
        }
        const behavior = this._pickIdleBehavior();
        if (!behavior) return;
        this.lastAutonomousAt = Date.now();
        this._safeExecute(behavior.action, behavior.params || {}, behavior.say);
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
        const home = this.memory.getHome();
        const p = this.gameState.position;
        if (!home || !p || !this._dimMatches(home.dimension, this.gameState.dimension)) return Infinity;
        return Math.hypot(p.x - home.position.x, p.z - home.position.z);
    }

    // the homestead arc: settle -> provision -> live. returns an idle behavior
    // or null when the arc has nothing due (mood menu takes over). every step
    // has its own cooldown so a failing step never loops - it goes quiet and
    // the next-priority step (or the menu) gets its turn.
    _homesteadBehavior() {
        const g = this.gameState;
        const now = Date.now();
        const onCooldown = (key) => now - (this._homesteadCooldowns.get(key) || 0) < HOMESTEAD_STEP_COOLDOWN_MS;
        const arm = (key) => this._homesteadCooldowns.set(key, now);
        const home = this.memory.getHome();
        const p = g.position || { x: 0, y: 64, z: 0 };

        // -- settle: no home yet -> push out into the wilderness, then claim a spot
        if (!home) {
            const anchor = this._sessionAnchor;
            const anchorDist = anchor ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : 0;
            const farEnough = g.multiplayer === true
                ? anchorDist >= HOMESTEAD_SETTLE_DIST_MP
                : anchorDist >= HOMESTEAD_SETTLE_DIST_SP;
            const denialFree = this._protectionDenials.length === 0 &&
                now - this._lastProtectionEscapeAt > 10 * 60 * 1000;
            const alone = g.multiplayer !== true || (g.nearbyPlayers || 0) === 0;
            // never settle in open water - home is where the ovens go, and ovens sink
            const dryLand = !OCEAN_BIOME_RE.test(String(g.biome || '')) && g.underwater !== true;
            if (farEnough && denialFree && alone && dryLand) {
                const entry = this.memory.setHome('the homestead', p, g.dimension, 'claimed wilderness, ovens pending');
                if (entry) {
                    this.recentEvents.record(`settled: "${entry.name}" is home now (${entry.position.x},${entry.position.z})`);
                    this._pushCommentary("this is the spot. middle of nowhere, nobody's claims, good bones. home.");
                    this.emit('gameEvent', 'homestead_settled', { name: entry.name, position: entry.position });
                }
                return null; // provisioning starts next tick
            }
            if (onCooldown('venture_out')) return null;
            // she has no home, so this fires constantly - it was the main engine
            // driving her into the ocean over and over on a coastal server.
            if (this._justLeftWater()) return null;
            const min = g.multiplayer === true ? 500 : 150;
            const spot = this._pickLandingSpot(p, min, min + (g.multiplayer === true ? 400 : 150));
            if (!spot) return null;   // no dry way out - let the mood menu have the tick
            arm('venture_out');
            return {
                action: 'move',
                params: { ...spot, target: 'deeper wilderness' },
                say: 'no home yet. walking out until the world stops belonging to other people'
            };
        }

        // -- provision: build the place up, one goal at a time
        const homeDist = this._homeDistance();
        const nb = g.nearby || {};
        const inv = this._carrying();
        const has = (frag) => inv.includes(frag);
        const hasExact = (item) => new RegExp(`(^|[^a-z_])${item}([^a-z_]|$)`).test(inv);
        const steps = [];
        if (!PICKAXE_TIERS.some((t) => has(`${t}_pickaxe`))) {
            steps.push({ key: 'pickaxe', atHome: false, action: 'get', params: { target: 'stone_pickaxe', amount: 1 }, say: 'tools first. a homestead without a pickaxe is a campsite' });
        }
        if (nb.craftingTable == null) {
            steps.push(hasExact('crafting_table')
                ? { key: 'crafting_table_place', atHome: true, action: 'place', params: { target: 'crafting_table' }, say: 'workbench down. the homestead has a shop floor now' }
                : { key: 'crafting_table_get', atHome: true, action: 'get', params: { target: 'crafting_table', amount: 1 }, say: 'workbench for the homestead' });
        }
        if (nb.furnace == null) {
            // If the unit is already in her pack, install it explicitly so the
            // block really exists at home and enters the durable oven ledger.
            // Gathering charcoal alone can use a temporary furnace that AltoClef
            // later picks back up, which is not a homestead installation.
            steps.push(hasExact('furnace')
                ? { key: 'oven_furnace_place', atHome: true, action: 'place', params: { target: 'furnace' }, say: 'first oven going in. this one lives HERE' }
                : { key: 'oven_furnace_get', atHome: true, action: 'get', params: { target: 'furnace', amount: 1 }, say: 'getting the first proper oven for home' });
        }
        if (nb.bed == null) {
            steps.push(has('_bed') || has(' bed')
                ? { key: 'bed_place', atHome: true, action: 'place', params: { target: 'bed' }, say: 'bed down, spawn set. this is real now' }
                : { key: 'bed_get', atHome: false, action: 'get', params: { target: 'bed', amount: 1 }, say: 'a homestead needs a bed. some sheep is about to sponsor me' });
        }
        if (nb.chest == null) {
            steps.push(has('chest')
                ? { key: 'chest_place', atHome: true, action: 'place', params: { target: 'chest' }, say: 'storage installed. the hoard begins' }
                : { key: 'chest_get', atHome: false, action: 'get', params: { target: 'chest', amount: 1 }, say: 'need a chest for the loot' });
        }
        if (nb.smoker == null) {
            steps.push(has('smoker')
                ? { key: 'smoker_place', atHome: true, action: 'place', params: { target: 'smoker' }, say: 'smoker joins the oven family' }
                : { key: 'smoker_get', atHome: false, action: 'get', params: { target: 'smoker', amount: 1 }, say: 'the oven collection grows. smoker next' });
        }
        if (nb.campfire == null) {
            steps.push(has('campfire')
                ? { key: 'campfire_place', atHome: true, action: 'place', params: { target: 'campfire' }, say: 'campfire out front. ambiance is a survival stat' }
                : { key: 'campfire_get', atHome: false, action: 'get', params: { target: 'campfire', amount: 1 }, say: 'every homestead needs a campfire to stare into' });
        }
        if (!has('torch')) {
            steps.push({ key: 'torches', atHome: true, action: 'get', params: { target: 'torch', amount: 8 }, say: 'lighting the yard so nothing explodes me at my own front door' });
        }

        for (const step of steps) {
            if (onCooldown(step.key)) continue;
            if (step.atHome && homeDist > HOMESTEAD_NEAR_HOME) {
                if (onCooldown('go_home_for_step')) return null;
                arm('go_home_for_step');
                return { action: 'go_home', params: {}, say: 'heading home to work on the place' };
            }
            arm(step.key);
            return step;
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
        if ((Array.isArray(g.inventory) ? g.inventory.length : 0) >= 15 && nb.chest != null && !onCooldown('deposit')) {
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
        const tally = this.memory.ovenTally();
        const hay = this._carrying();
        for (const [kind, target] of Object.entries(OVEN_TARGETS)) {
            if ((tally[kind] || 0) >= target) continue;
            const prereq = OVEN_PREREQ[kind];
            if (prereq && !prereq.test(hay)) continue;
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
        const home = this.memory.getHome();
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
        const wanted = this._nextOvenWanted();
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
                    ? { action: 'place', params: { target: wanted }, say: this._ovenLine(wanted, 'place') }
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

        // the homestead arc is her default way of living - it outranks the mood
        // menu most of the time but never a strong feeling (checks above) and
        // never an operator/viewer/llm goal (autonomy only runs when idle).
        if (Math.random() < HOMESTEAD_BIAS) {
            const homestead = this._homesteadBehavior();
            if (homestead) return homestead;
        }

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
        if (nearPeople && this._homeDistance() > 64 && Math.random() < 0.4) {
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
        if (g.multiplayer === true && g.timeOfDay !== 'night' && !this._justLeftWater() && Math.random() < 0.4) {
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
        const home = this.memory.getHome();
        if (home && g.timeOfDay === 'night' && this._dimMatches(home.dimension, g.dimension)) {
            const hd = Math.hypot((g.position?.x ?? 0) - home.position.x, (g.position?.z ?? 0) - home.position.z);
            if (hd > 48 && hd < 1200 && Math.random() < 0.6) {
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

    _survivalPrep() {
        // an empty inventory array is also what a telemetry gap looks like; only
        // act on a state fresh enough to trust.
        if (this._stateIsStale()) return null;
        const hay = this._carrying();
        const mind = this.minecraftState || this.affect.snapshot();
        const isNight = String(this.gameState.timeOfDay || '').toLowerCase() === 'night';
        const deep = Number.isFinite(Number(this.gameState.position?.y)) && Number(this.gameState.position.y) < 45;
        const candidates = [];
        if (!PICKAXE_TIERS.some((t) => hay.includes(`${t}_pickaxe`))) {
            candidates.push({
                key: 'stone_pickaxe',
                action: 'craft',
                params: { target: 'stone_pickaxe' },
                say: 'no pickaxe. i keep starting fights with a mountain using my hands. getting a real one'
            });
        }
        if (!FOOD_RE.test(hay)) {
            candidates.push({
                key: 'food',
                action: 'craft',
                params: { target: 'bread' },
                say: 'zero food on me, which is embarrassing for a bread professional. fixing that first'
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
        if (say) this._pushCommentary(say);
        this.executeAction(action, params, { priority: 'low', source, why: say || null, waitForCompletion: false }).catch((err) => {
            this.log('debug', `autonomous ${action} failed: ${err.message}`);
        });
    }

    _recoverStalledGoal() {
        const goal = this.activeGoal;
        if (!goal || !goal.watchdog || Date.now() - goal.lastProgressAt < AUTONOMOUS_STALL_MS) return false;
        const description = this._describeTask(goal.action, goal.params);
        this.log('warn', `minecraft goal stalled; stopping ${description}`);
        this.memory.recordFailure(goal.action, goal.params?.target, 'no movement or inventory progress for two minutes');
        this.memory.record('recovery', `abandoned stalled ${description}`, {
            action: goal.action,
            target: goal.params?.target,
            position: this.gameState.position,
            dimension: this.gameState.dimension
        });
        this._applyMinecraftEvent('stalled');
        this.activeGoal = null;
        this.currentTask = `recovering from stalled ${description}`;
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
        this._applyMinecraftEvent('looping');
        // don't let the next tick immediately re-pick the action that just looped
        this._avoidAction = goal.action;
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
                const home = this.memory.getHome();
                const homeDist = this._homeDistance();
                if (home && homeDist > 24 && homeDist < 1500) {
                    this._safeExecute('go_home', {}, `night's here. heading back to ${home.name}`);
                } else if (!home && (this.gameState.nearbyHostiles || 0) >= 2) {
                    this._safeExecute('idle', {}, null);
                }
                // else: fall through - the autonomy tick keeps the homestead arc moving
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
        // burnt.js hands to her brain ("you're playing on your own and thinking:
        // ...") so the words the audience gets are always hers. it must never be
        // published straight to server chat - that is what made pre-written
        // strings show up in-game word for word. she talks in minecraft through
        // her own `chat` tool action, in her own words.

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

// singleton - execute_minecraft() imports this exact instance.
const minecraftTool = new MinecraftTool();
export default minecraftTool;
export { MinecraftTool };
