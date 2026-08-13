// core/minecraft_tool.js
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
import { NoticeBoard } from './notice_board.js';
// ⚠ normalizeOreKind is IMPORTED, never re-implemented here. the companion scan
// reports blocks (`deepslate_iron_ore`), her brain says items (`raw_iron`) and
// chat says the metal (`iron`) - one seam, three strings. a second copy of that
// mapping in this file would drift, which is the exact failure it exists to stop.
import {
    MinecraftMemory, OVEN_KINDS, COMFORT_KINDS, FOOD_SPOT_KINDS, ORE_SPOT_KINDS, normalizeOreKind,
    // the order IS the plan, so it is imported rather than restated here - a
    // second copy would be a second answer to "what does she do next".
    SETTLEMENT_UPGRADE_ORDER
} from './minecraft_memory.js';
// LONG-TERM MEMORY IS THE HOST'S. the private tree writes these into a vector
// store; a standalone library has no business owning one. injected through the
// `remember` constructor option / setRemember(), and simply not recorded when
// nothing is wired up. shape: { player(record, worldId), gameplay(text, {tags}) }
import {
    ToasterHomestead, ToasterOutpost, toasterHomesteadDimensions,
    toasterOutpostDimensions, fitOutpostBelowHomestead, mainIsBiggest, toasterBlueprint,
    toasterFixtureTarget, toasterOpenFloor, toasterBedPositions, TOASTER_STACK_HEIGHT,
    TOASTER_YARD_MARGIN, toasterYardSeparation, TOASTER_PLAN_LATEST
} from './settlements.js';
import { MinecraftAffect } from './minecraft_affect.js';
// who her owner is and which server is hers. all config, no hardcoded names -
// see minecraft_identity.js. imported rather than re-derived from env here so
// the alias rule has exactly one implementation.
import { isOwner, ownerName, resolvePlayerName, homeServerFor } from './identity.js';
import { nextMilestones, progressTier, milestoneLabel } from './minecraft_milestones.js';

const DEFAULT_PORT = parseInt(process.env.MINECRAFT_BRIDGE_PORT || '7431', 10);

// how long to wait for the bridge's final response before giving up on an action.
// altoclef tasks can be long-running (mine diamonds), so the bridge is expected
// to send an 'executing' ack promptly and a 'success'/'error' when the task
// actually finishes; the ack resets this timer.
const DEFAULT_ACTION_TIMEOUT = 90000;

// autonomous idle cadence - how often to consider doing something unprompted.
const DEFAULT_AUTONOMOUS_TICK_MS = 25000;

// THE MOAT IS OFF UNTIL SOMEONE ASKS - see _trenchEnabled for the whole rule.
// FALSE unless the box says otherwise, because on-by-default would have every
// house already standing survey as incomplete and start digging unannounced.
const DEFAULT_TRENCH_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MINECRAFT_TRENCH_ENABLED || ''));

// min gap between reactions of the same kind, so chat can't farm spam and a
// stream of damage events doesn't flood commentary.
// ---- tics: the fidgeting -----------------------------------------------------
// A bot that stands perfectly still between actions reads as a bot. Real players
// bunny-hop while thinking, spam sneak at nothing, and flip the camera round to look
// at themselves and throw a punch. These are those.
//
// ⚠ DELIBERATELY LOW. A tic is background texture, and the failure mode is not
// "too subtle" - it is a twitching bot, which is worse than a still one and reads
// as broken rather than alive. At 0.12 with a 15s tick and a 25s floor between
// tics, an idle stretch produces roughly one fidget a minute and a working one
// far fewer. Operator-tunable live via the db key `minecraft_tic_frequency`.
const DEFAULT_TIC_FREQUENCY = (() => {
    const raw = Number(process.env.MINECRAFT_TIC_FREQUENCY);
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.12;
})();
const TIC_TICK_MS = 15000;
// even at frequency 1.0 this keeps fidgeting from becoming a metronome
const TIC_MIN_GAP_MS = 25000;
// WHAT SHE IS DOING SCALES THE ODDS. Standing about is what fidgeting is FOR, so it
// gets the full rate; the others are the "occasionally, while busy" case.
const TIC_CHANCE_IDLE = 1;
const TIC_CHANCE_BUSY = 0.35;      // a job is running, but not a mouse-click one
const TIC_CHANCE_DANGER = 0.5;     // hostiles on her: a panicked crouch spam is peak gamer
// ⚠ NEVER WHILE THE MOUSE IS WORKING. Every one of these swings, places, or aims:
// a tic during one either fights the click or, worse, looks like it caused a miss.
// The client re-checks this itself (`startTic` refuses while `isDestroying()` or
// `isUsingItem()`), because only it knows what is happening THIS tick.
const TIC_CLICK_ACTIONS = new Set([
    'mine', 'collect', 'get', 'craft', 'place', 'place_block', 'build_settlement',
    'build_plan', 'farm', 'install_appliance', 'defense_trench', 'attack', 'defend',
    'hunt', 'eat', 'stock_food', 'equip', 'deposit', 'withdraw', 'peek', 'stash',
    'give', 'speedrun'
]);
// crouch reads best and is safest, so it carries the feature; the hop is idle-only
// (a forced jump mid-path can land her off a ledge) and the flex is the rare treat.
const TIC_KINDS = Object.freeze([
    { kind: 'crouch', weight: 0.5, idleOnly: false },
    { kind: 'flex', weight: 0.3, idleOnly: false },
    { kind: 'jump', weight: 0.2, idleOnly: true }
]);

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
// WHAT A PERSON'S FREEFORM ASK MAY BE TURNED INTO.
// mirrors the filter recordViewerSuggestion already applies to a PARSED
// suggestion, so the two routes into her hands cannot disagree about what a
// stranger is allowed to start. anything refused here still reaches her mouth -
// she can always say what she is not going to do, which is not the same as
// going quiet on someone.
const REQUEST_DECISION_FORBIDDEN = new Set([
    'attack', 'give', 'chat',                           // violence, her things, words she didn't pick
    'set_home', 'set_outpost',                          // where she lives is hers to choose
    'enable', 'disable', 'autonomous', 'gamer', 'hud',  // operator switches, not viewer toys
    'forget_food',                                      // deleting a farm needs the parsed rule's care
    // ⚠ AND DELETING A PLACE IS THE SAME SHAPE. a stranger may send her to one
    // and may name one, but "forget the lava shelf" erases something she has
    // been building up for weeks and a freeform route cannot be trusted to have
    // meant it. the explicit parsed rule below still allows it.
    'forget_place'
]);
// how long her brain gets to choose an action for a freeform ask before the tick
// moves on. deliberately under the request window so a slow answer is dropped
// rather than acted on after the moment has passed.
const REQUEST_DECISION_BUDGET_MS = 8000;
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
    install_appliance: 90000,
    // a procedural house and a wheat plot are laid block by block from one spot,
    // exactly the shape the 45s default reads as a stall. unlike build_settlement
    // there is NO survey to vouch for them, so position and inventory stay the
    // progress signal here - both of which really do move while she builds - and
    // the budget is simply generous.
    build_plan: 6 * 60 * 1000,
    farm: 4 * 60 * 1000
});
// Build phases where the task has handed off to a resource subtask and is
// legitimately away from the site: there movement and inventory ARE the
// progress signal. Every other phase claims she is laying blocks, and only the
// survey can vouch for that.
const BUILD_SUBTASK_PHASES = new Set(['gathering_stone', 'crafting_side_torches', 'walking_to_quarry']);
// WHICH SURVEY FIELDS MEAN "further along", and which way is further. Read by
// _settlementAdvance, which demands a new BEST rather than a new value.
// [field, higherIsBetter]
const SETTLEMENT_PROGRESS_FIELDS = Object.freeze([
    ['percent', true], ['complete', true], ['clear', true], ['floor', true],
    ['walls', true], ['roof', true], ['torches', true], ['lit', true],
    ['housed', true], ['yardClear', true], ['toastSlots', true], ['toastSlotCount', true],
    ['walkthrough', true],
    // outstanding work: fewer is further along
    ['smoothStoneRemaining', false], ['yardRemaining', false], ['clearRemaining', false],
    ['trenchRemaining', false], ['trenchLightsRemaining', false]
]);
// A different site, or the same site re-planned to a different footprint, is NEW
// work - so the bests are reset rather than compared against.
const SETTLEMENT_IDENTITY_KEYS = Object.freeze([
    'kind', 'role', 'x', 'y', 'z', 'width', 'depth', 'height'
]);
// ⚠ OUTSTANDING WORK CAN GROW WITHOUT HER GOING BACKWARDS. The trench opens and
// `trenchRemaining` jumps 0 -> ~1240; a stage upgrade adds a course. Held to a
// strict "must beat the lowest ever seen", such a field is baselined at 0 and can
// then NEVER register progress again - so the longest job in the plan would look
// like a stall for its whole duration, which is precisely what adding the trench
// counters to the survey was meant to prevent.
//
// So a BIG increase rebases the bar (new scope, not a regression) while a small one
// is ignored as the documented place/break/replace jitter. The threshold only has to
// separate "a counter twitched" from "a phase of work opened", and those differ by
// three orders of magnitude, so its exact value is not delicate.
const SETTLEMENT_SCOPE_JUMP = 8;
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
    build_settlement: null,
    // A procedural house is hundreds of blocks with a gather in the middle of
    // it, so fifteen minutes would kill honest work - but it is NOT null like
    // the toaster, because there is no survey watching it. A finite ceiling is
    // the only thing that can end a build_plan that has quietly wedged.
    build_plan: 45 * 60 * 1000
};
const LOOP_AVOID_MS = 2 * 60 * 1000;       // after a break, don't re-pick the same action for this long
// A site the builder has REFUSED OUTRIGHT is not a site that another attempt
// fixes, and re-dispatching one is the outer half of a loop the game side cannot
// see. Live 2026-08-07: the wall-torch rotation could never finish 3 spots, node
// broke the goal for orbiting every ~6min, and her BRAIN re-issued
// "build_settlement home" within two minutes of every single break - an hour of
// it. `_avoidAction` did not cover this: it filters the idle MENU, and these came
// from source 'agent'.
//
// So the verdict gets a cooldown of its own, at the one door both sources go
// through. It is deliberately longer than LOOP_AVOID_MS (the site needs the WORLD
// to change, not a retry) and deliberately not permanent - she mines, creepers
// blow holes, and the thing in the way may simply go.
const BLOCKED_SITE_COOLDOWN_MS = 10 * 60 * 1000;
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

// ---- COMBAT IS NOT A STALL -------------------------------------------------
//
// ⚠ THE WATCHDOGS COULD NOT SEE A FIGHT. AltoClef's TaskRunner picks ONE chain per
// tick by priority, and MobDefenseChain (58-80) outranks UserTaskChain (50) - so
// while something is chewing on her, her actual task is PREEMPTED and makes no
// progress BY DESIGN. Neither `_recoverStalledGoal` nor `_recoverLoopingGoal`
// referenced `nearbyHostiles`, `_lastDamageAt` or `gameState.combat` anywhere, so
// what they saw was a task moving in a small circle gaining nothing - their exact
// definition of a loop. They then aborted the goal AND `_avoidNote`d the verb for
// two minutes. Being attacked while walking somewhere therefore meant the
// destination was forgotten and then suppressed, which is the "she never goes back
// to what she was doing" complaint.
//
// So the watchdog clocks are PAUSED while the defense chain owns the tick. Pausing
// rather than disabling matters: a fight that never ends must still terminate.
const COMBAT_SUSPEND_MAX_MS = 3 * 60 * 1000;   // total credit one goal may earn
const COMBAT_CREDIT_STEP_MAX_MS = 15 * 1000;   // one poll may credit at most this
// ⚠ ONLY FOR A JAR THAT CANNOT TELL. `gameState.combat` is the defense chain's own
// verdict and is sent every poll (mode 'none' when calm), so when it is present it
// is believed in BOTH directions. This inference is the fallback for an older
// companion, and it is deliberately the same evidence `_recoverPinnedByMobs`
// already trusts: something is here, and it is hitting her.
const COMBAT_INFER_MS = 12 * 1000;

// ---- GOING BACK TO WHAT SHE WAS DOING --------------------------------------
// How long an interrupted job is still worth picking back up. Long enough to
// survive a fight and the retreat that follows it, short enough that she never
// resumes an errand whose world has moved on - the retreat alone can put her 260
// blocks away, and "why is she walking back to a place she left ten minutes ago"
// is worse than having forgotten.
const INTERRUPT_RESUME_WINDOW_MS = 5 * 60 * 1000;
// ...and it must be genuinely over, not just quieter: no hostiles, nothing has
// hit her for this long, and she is not still on low health.
const INTERRUPT_CALM_MS = 8 * 1000;
const INTERRUPT_MIN_HEALTH = 8;
// how far a deliberate break-off walks. the SAME numbers the pin recovery retreats
// on, and for the same reason: a few blocks just re-enters the aggro range she was
// trying to leave, so a short hop is a retreat that has to be made twice. the upper
// bound keeps it a disengage rather than an expedition - she is leaving a fight,
// not moving house.
const RETREAT_MIN_DISTANCE = 120;
const RETREAT_MAX_DISTANCE = 260;
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
// AND exempt from the f1 guard below, which is deliberate - when the owner takes the
// keyboard the hud should still be able to say so rather than freeze on a stale line.
// 'set_home' is a memory write, not a goal - and it stays allowed under f1 so the owner can
// walk her somewhere good and say "this is home" while holding the keyboard.
// protect_settlement is here because it starts no in-game task at all - it hands
// the pathfinder a rule and returns. Going through the busy gate would mean the
// house stays mineable for as long as she happens to be mid-job when she joins.
// 'tic' is a one-second cosmetic fidget. It MUST be here: it has to be able to run
// alongside a live mine/follow/build (that is the whole point), and if it owned
// currentTask its instant completion would make a running job read as idle.
// ⚠ `places`, `remember_place` and `forget_place` are pure memory reads/writes -
// they never reach the game, so making them wait on the busy gate would mean she
// cannot say what she knows about somewhere while her hands are doing anything.
// `go_place` is deliberately NOT here: it becomes a real walk.
// ⚠ `gamer`/`gamer_stop` are mode toggles answered host-side (see _dispatchAction).
// they start no goal, so an instant completion must not blank a running one.
const NON_TASK_ACTIONS = new Set(['chat', 'stop', 'status', 'inventory', 'coords', 'enable', 'disable', 'autonomous', 'look', 'boat', 'hud', 'set_home', 'set_outpost', 'outposts', 'forget_food', 'food_spots', 'stores', 'protect_settlement', 'tic', 'places', 'remember_place', 'forget_place', 'favorites', 'gamer', 'gamer_stop']);

// GAME EVENTS THAT BELONG IN THE ROLLING LINE BUT NOT IN THE DURABLE JOURNAL.
//
// these three are continuous combat telemetry: they fire while a fight is
// happening and again the moment the next mob wanders into range. `recentEvents`
// (3 minutes) is exactly the right home for them and already gets them. the
// journal is 240 slots that `context()` reads the tail of as "what i just did",
// and on the live ledger these three had taken 112 of the 160 event rows - so
// her recall of an afternoon of building read as a threat feed, and the ring
// held under five days. everything else still journals: a death, a kill, an
// achievement and a diamond are all things she would bring up tomorrow.
const AMBIENT_JOURNAL_EVENTS = new Set(['damage_taken', 'hostiles_nearby', 'creeper_spotted']);

// the in-game intent line: "<what she's doing>" / "<why>" / "<live altoclef phase>".
// verbs are present-continuous so the hud reads as a sentence about a person rather
// than a command echo ("crafting a stone pickaxe", not "craft stone_pickaxe").
const INTENT_VERBS = {
    craft: 'crafting', get: 'getting', mine: 'mining', collect: 'collecting',
    move: 'heading to', follow: 'following', explore: 'exploring', idle: 'killing time',
    // NOT 'fighting back'. this verb is rendered off the dispatched action alone,
    // with no hostile check anywhere on the path, so a `defend` chosen as a fallback
    // announced "fighting back" while nothing was attacking her - the exact thing
    // the owner reported hearing "for absolutely no reason" (2026-08-08). the verb has to
    // describe the JOB she picked up, not claim a fight is happening to her.
    defend: 'clearing out the hostiles', attack: 'going after', eat: 'eating', hunt: 'hunting',
    stock_food: 'stocking up on food',
    equip: 'gearing up', deposit: 'stashing loot', stash: 'stashing loot',
    place: 'placing', install_appliance: 'installing', build_settlement: 'building',
    place_block: 'placing', build_plan: 'building', farm: 'farming',
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

// ---- flavor lines (host-supplied, none shipped) ---------------------------
// THE LIBRARY SHIPS NO DIALOGUE, which is what the readme has always promised.
// these keys are the places the autonomy loop would like a line if you have one;
// every pool is empty until a host fills it. an unregistered key yields null,
// which _pushCommentary drops, so the action still happens and nothing is said.
//
//   setFlavorLines({ bread: ['...'], scout: ['...'] })
//
// keys: bread, offbread_<kind>, oven-install, oven-<kind>, scout, hold_station,
//       loop-break
const FLAVOR_LINES = new Map();
export function setFlavorLines(lines = {}) {
    for (const [key, pool] of Object.entries(lines)) {
        if (Array.isArray(pool)) FLAVOR_LINES.set(key, pool.filter((l) => typeof l === 'string' && l.trim()));
    }
    return FLAVOR_LINES;
}
export function clearFlavorLines() { FLAVOR_LINES.clear(); }
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
// carrying "the bot name" and went silent on every one after it. these keep an answered
// person addressed while the back-and-forth is genuinely alive.
const CHAT_EXCHANGE_MS = 150000;      // how long an answered person stays "talking to her"
const CHAT_EXCHANGE_MAX_MS = 600000;  // ceiling: a window can be extended, never forever
const CHAT_EXCHANGE_GAP_MS = 2000;    // in-exchange per-sender gap (two quick lines both land)
const CHAT_ADDRESSER_RECENT_MS = 120000; // how recently they must have addressed her to be answered
// ASKING FOR SOMETHING IS NOT AMBIENT CHATTER, AND IT MUST NEVER BE COIN-FLIPPED.
// the ambient lane is correct for a busy server's background talk and completely
// wrong for a request: "make a wheat farm" from somebody standing next to her was
// a 50/50 behind a 75s gap, so the honest answer to "why is she ignoring me" was
// that a die came up short. requests get their own lane with NO sampling.
// they still pay a floor, because REQUEST_SHAPE_RE is deliberately loose (a bare
// "go", "make" or "look" matches) and a public server would otherwise flood her:
// somebody in the room pays only the per-sender gap, somebody typing from across
// the map pays this instead of the ambient 75s.
const CHAT_REQUEST_GAP_MS = 20000;
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
// ⚠ THIS IS NOW THE FALLBACK, NOT THE DECISION. the gesture is chosen by her
// brain (see _maybeGreetArrival -> gameEvent 'bread_opportunity' ->
// actOnBreadOpportunity); this coin flip is what happens when that path is
// unavailable, times out or errors. a failed decision costs the DECISION, never
// the gesture - the same rule the chimera render lives by.
const ARRIVAL_BREAD_SHARE = 0.65;
// what her brain is allowed to answer with. anything else - a sentence, a blank,
// a hallucinated verb - is not a decision and falls back to the coin flip.
const BREAD_DECISIONS = new Set(['ignore', 'talk', 'offer', 'give', 'approach_and_give']);
// how long the tool waits for that answer before deciding for itself. this is a
// SILENCE budget: somebody is standing in front of her, and a bot that stares
// through a person for ten seconds while a model thinks is worse than one that
// just throws the bread.
const BREAD_DECISION_TIMEOUT_MS = 8000;
// approach_and_give walks over first. bounded in both directions: a follow that
// never gets there is stopped, and a person far enough away that this becomes a
// cross-map trek is somebody she throws to from here instead.
const BREAD_APPROACH_MS = 20 * 1000;
const BREAD_APPROACH_MAX_DIST = 64;
// SOMEBODY LOGGED IN. distinct from walking up to her: a join is a whole-server
// event she learns from the tab list, and the person is usually nowhere near her.
// so it is only ever worth WORDS - no bread, no walking over - and it is rarer
// than an arrival, because a server where people cycle in and out all evening
// would otherwise turn her into a doorbell.
const JOIN_GREET_GAP_MS = 4 * 60 * 1000;
const JOIN_GREET_PER_PLAYER_GAP_MS = 45 * 60 * 1000;
const JOIN_GREET_SAMPLE = 0.45;
// a reconnect is not an arrival. someone who dropped and came straight back has
// not "joined"; greeting that is how she ends up welcoming one person four times
// in a night on a server with a flaky node.
const JOIN_RECONNECT_GRACE_MS = 3 * 60 * 1000;
const PERSISTENT_ACTIONS = new Set(['follow', 'idle', 'explore']);

// ---- action params that hold a real minecraft USERNAME ----------------------
// The registry _resolvePlayerParams reads, in the same spirit as SPOKEN_TOOL_ARGS
// in node/chimera.js: one place that says which fields are a person, so the owner
// alias ("the owner" -> his in-game name) is applied there and nowhere else.
//
// ⚠ ADDING A VERB HERE IS A CLAIM THAT THE FIELD CAN ONLY EVER BE A PLAYER.
// `params.target` is the most reused field in this file. `attack` is left out on
// purpose - its target is normally a mob, and quietly turning a name into a punk
// order is not a normalisation. `give` lists both because the bridge reads
// `p.player || p.target`.
const PLAYER_NAME_PARAMS = {
    follow: ['target'],
    give: ['player', 'target'],
    look: ['target']
};

// ---- goals that survive being interrupted -----------------------------------
// A JOB SOMEBODY ASKED FOR IS NOT A ONE-SHOT. See _declareRequestGoal: a request
// used to be dispatched exactly once and then forgotten by every part of this
// file, so any interruption meant a person had to ask again.
//
// ⚠ WHAT BELONGS HERE IS "a finite job that is still worth doing ten minutes
// later". Deliberately excluded: everything in NON_TASK_ACTIONS (chat, status,
// hud - nothing to resume), the PERSISTENT_ACTIONS (follow/idle/explore are
// stances, and resuming a `follow` after the person logged off is a bot walking
// to where somebody used to be), the safety verbs (eat/defend answer a situation
// that has since changed, and resuming a stale panic is how she fights nothing),
// and `stop` - which must never be a thing she goes back to doing.
const RESUMABLE_ACTIONS = new Set([
    'build_settlement', 'build_plan', 'farm', 'defense_trench', 'install_appliance',
    'place_block', 'mine', 'collect', 'get', 'craft', 'move', 'go_home', 'hunt',
    'stock_food', 'deposit', 'withdraw'
]);
// A BUILD IS NOT AN ERRAND, so it does not compete with errands for a slot. The
// short cap is 12 and the long cap 8, and eviction spends finished business
// first - so a settlement filed as `short` would be evicted by an afternoon of
// "get me some wheat" long before it was finished.
const LONG_REQUEST_ACTIONS = new Set([
    'build_settlement', 'build_plan', 'farm', 'defense_trench'
]);
// How many real failures before she stops going back to it. Interruptions do not
// count (see _noteGoalOutcome) - only evidence the job itself is not working.
// "she will not drop it" is a worse look on a public server than "she forgot".
const GOAL_ATTEMPT_LIMIT = 4;
// A resumed goal does not get the very next tick as well: one unreachable job
// would otherwise spin here and starve the homestead arc, the brief and the menu
// that all sit below this rung.
const GOAL_RESUME_COOLDOWN_MS = 90 * 1000;
// Stops the MACHINE issues to fix something. Every one of these is an
// interruption, which is exactly what a resumable goal is meant to survive, so
// none of them may stand a goal down - only a person saying stop does that.
// Named sources are all internal by construction; a human stop usually carries
// no source at all, so the safe default for an unknown one is "they meant it".
// ⚠ THIS LIST BEING INCOMPLETE IS SILENT AND CATASTROPHIC, because the default for
// an unlisted source is "a person meant it" - so a machine stop that forgot to
// register here does not merely fail to be recognised, it ABANDONS EVERY JOB SHE
// HAS. Four were missing, and the worst of them made the whole feature a no-op:
// `_actOnRequest` declares the request's goal and then calls `_startPersonRequest`,
// which stops with source 'request' - destroying the goal a few lines after
// creating it. That is the entire "she forgets and i have to remind her" complaint
// the ledger was written to fix, still live because the fix cancelled itself.
//   'request'      the two-phase re-task's own stop (_startPersonRequest)
//   'preempt'      _preemptIfWarranted -> every LLM re-task, i.e. every few seconds
//   'mode-switch'  leaving minecraft mode (modes.js) - a lifecycle transition
//   'disable'      turning the tool off - "off" is not "forget the toaster"
// tmp/mc_goal_standdown_repro.mjs enumerates every stop source in the tree and
// FAILS on any that is neither listed here nor deliberately declared human, so the
// fifth one cannot be added silently.
//   'retreat'      _runRetreat's own stop - breaking off a FIGHT, never the plan.
//                  ⚠ THIS WAS THE FIFTH, AND IT WAS THE WORST ONE. `retreat` is on
//                  her tool schema and `execute_minecraft` passes no source, so
//                  `_runRetreat` defaulted it to the string 'retreat' - unlisted,
//                  therefore read as a PERSON saying stop, therefore
//                  `_standDownGoals` marked every resumable goal `abandoned`
//                  (terminal - never re-offered). The one verb whose entire meaning
//                  is "this particular fight is not worth it" quietly wiped the
//                  wheat farm somebody asked her for. Breaking off is a statement
//                  about the mob in front of her, not about the afternoon.
const INTERNAL_STOP_SOURCES = new Set([
    'recovery', 'loop-recovery', 'orphan-recovery', 'dwell-rotation', 'unreachable',
    'pinned', 'protection', 'water-escape', 'gamer', 'autonomous', 'safety',
    'request', 'preempt', 'mode-switch', 'disable', 'retreat'
]);
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
// the answer to "do the thing you are already doing". exported because the tool
// layer writes its receipt from the REQUEST, not the outcome, so it has to be
// able to recognise this one and pass it through instead of reporting a fresh
// start that never happened.
export const ALREADY_RUNNING_PREFIX = 'already on it:';
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
// line that is not just a greeting is nearly always an instruction.
// same configured name list as the chat-manners test (buildAddressedRe/setBotNames).
let ADDRESSED_RE = buildAddressedRe((process.env.BOT_NAMES || '').split(','));
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
// EXACTLY what may go in the chest when she offloads a haul - an allow-list, and
// it has to be one for two independent reasons.
//
// ⚠ THE PANTRY USED TO BE A ONE-WAY DOOR. `deposit` with no item list is
// altoclef's "store ALL non-gear items", and for a long time nothing anywhere -
// bridge, companion, or altoclef's command set - took anything back OUT, so every
// loaf she banked was gone and the next tick read an empty pantry and sent her out
// for wheat again. `@withdraw` closed that (WithdrawCommand -> the bridge's
// `withdraw` case -> `_pantryStep`), so the stock IS reachable now.
//
// this allow-list still stands, and not as a leftover: a withdraw is a walk to a
// chest and a screen to open, while food in her bag is free. a 64-loaf stack is
// one slot, so her food still rides with her and the chest still gets the rubble -
// the difference is that banking something is no longer the same as losing it.
//
// ⚠ AND A DENY-LIST CANNOT BE MADE SAFE HERE. naming a list at all opts into
// `ItemList.parseRemainder`, which THROWS "Item not catalogued: x" on the first
// name TaskCatalogue does not know - and TaskCatalogue is a hand-maintained list
// of OBTAINABLE resources, so ordinary bag contents (rooted_dirt, grass_block,
// snowball, mud, azalea, every 1.21.5+ ground-cover item) are simply absent. one
// stack of rooted dirt would fail the WHOLE command, store nothing, leave the bag
// full, and rebuild the identical doomed manifest every five minutes until
// `_avoidAction` blacklisted depositing entirely. an allow-list inverts the
// failure: an unlisted item is KEPT, which costs a slot and never costs the
// command. every name here is asserted against TaskCatalogue.java by
// tmp/mc_food_stock_test.mjs.
//
// deliberately NOT here, and each for a reason: food and wheat (the pantry and
// the bread pipeline's only input), coal (the fuel bin she actively maintains),
// logs/planks (constant build stock), torches, beds, crafting tables, furnaces,
// smokers and chests (the obsession re-buys them on a 5-minute cooldown, and step
// 2 has her CARRY an appliance home to install it - banking it on arrival would
// undo the errand), and tools/armor (a named list also opts out of the java-side
// gear filter in DepositCommand.getAllNonEquippedOrToolItemsAsTarget).
const DEPOSIT_ALLOW = new Set([
    // rubble: the reason the bag filled up in the first place
    'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite',
    'granite', 'tuff', 'dirt', 'gravel', 'sand', 'sandstone', 'netherrack', 'basalt',
    'blackstone', 'flint', 'clay_ball', 'obsidian',
    // mob junk she is never short of
    'rotten_flesh', 'bone', 'string', 'spider_eye', 'gunpowder',
    // valuables that are safe to bank - none of them gate a survival step
    'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz'
]);
// how long to leave survival prep alone after an attempt, so a missing-inventory
// telemetry gap can't turn "craft a pickaxe" into the only thing she ever does.
const SURVIVAL_PREP_COOLDOWN_MS = 4 * 60 * 1000;
// ---- autonomy modes --------------------------------------------------------
// SELF-PLAY USED TO BE A BOOLEAN. on meant "do whatever the idle ladder picks",
// which is the right default and a terrible way to answer "go get materials".
// a mode replaces ONLY the free-time provider: what she does when nothing is
// wrong, nobody has asked for anything, and no task is running.
//
// ⚠ NOTHING ABOVE THE PROVIDER IS EVER MODE-GATED. faults, the stall/loop/pin
// recoveries, urgent safety, a real person's request and the spawn-region rule
// are not preferences - a mode that could switch off eating or defending would
// be a mode that kills her. a mode changes what she does when she is FREE.
export const AUTONOMY_MODES = Object.freeze([
    'auto',              // today's ladder, verbatim
    'gather_materials',  // mine what the build actually needs, bank the rubble
    'gather_food',       // bake, work the remembered fields, hunt, forage
    'scout_area',        // walk unvisited ground and let the observers learn it
    'secure_area'        // hold the homestead: clear hostiles, light it, stay put
]);
const AUTONOMY_MODE_DEFAULT = 'auto';
// same shape and same reason as _homesteadCooldowns: a step that keeps failing
// goes QUIET instead of re-firing every 25s tick. ⚠ and a REFUSED step hands its
// cooldown straight back (see _releaseAutonomyModeCooldown) - charging four
// minutes for work that never left the building is the survival-prep bug.
const AUTONOMY_MODE_STEP_COOLDOWN_MS = 4 * 60 * 1000;
/**
 * How much an idle gather should actually FETCH, on top of what she already holds.
 * See _idleGatherParams - the bridge's floor of 1 made these picks instant no-ops.
 * Deliberately modest: an idle whim is a few minutes of work, not an expedition.
 */
const IDLE_GATHER_BATCH = Object.freeze({
    mine: 16,
    collect: 12,
    get: 12,
    craft: 1,
    default: 8
});
/**
 * Per-TARGET override, because rarity matters more than the verb: "mine 16 stone" is
 * an afternoon's whim, "mine 16 diamond_ore" is an all-night grind that would hold
 * the tick until something killed her. Keyed on the raw target before normalisation.
 */
const IDLE_GATHER_TARGET_BATCH = Object.freeze({
    diamond_ore: 2,
    diamond: 2,
    obsidian: 3,
    ancient_debris: 1,
    emerald_ore: 2,
    gold_ore: 4,
    iron_ore: 6
});
// scouting is a MEDIUM-range walk on purpose. short hops re-survey ground she can
// already see; a full venture (1200+) is a relocation, not a look around.
const SCOUT_MIN_DISTANCE = 160;
const SCOUT_MAX_DISTANCE = 420;
// secure_area: how far off station counts as "not guarding it any more", the
// health at which the answer is food rather than another swing, and the torch
// floor below which lighting the perimeter is a restock instead of a placement.
const SECURE_STATION_RADIUS = 40;
const SECURE_LOW_HEALTH = 12;
const SECURE_TORCH_FLOOR = 4;
// one ore reading per kind per this long. the companion scans every ~2s and a
// vein stays in the scan for the whole time she is standing in it, so without a
// throttle one seam would be written to disk hundreds of times.
const ORE_RECORD_THROTTLE_MS = 30 * 1000;
// how close the nearest-ore reading has to be before it is a PLACE rather than a
// rumour. the scan reports a distance; recording a seam 30 blocks away at HER
// coordinates would put the entry somewhere there is no ore at all.
const ORE_RECORD_MAX_DIST = 12;
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
// the owner's rule, stated plainly: she is NEVER in open water for minutes. half a
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

// ---- what a place is like ---------------------------------------------------
// ⚠ EVERY READING BELOW IS ALREADY ON THE WIRE AND ALREADY PAID FOR. the
// companion runs ~8600 block reads every two seconds on the RENDER thread and
// publishes ~15 fields from them; before this, three had any reader at all -
// the rest were computed, sent, and dropped. so "what does it look like here"
// costs no new scan. it is the same poll, finally being listened to.
const PLACE_OBSERVE_THROTTLE_MS = 20 * 1000;
// the companion's affordance scan reaches 8 blocks, so nothing here may claim
// anything about ground further away than that (see EMPTY_NOTE_RADIUS - the
// same discipline, learned the hard way on food spots).
const PLACE_NEAR_BLOCKS = 8;
// heightSpread is in blocks over a 21x15 grid; _homeSiteAssessment already
// treats >4 as "terrain too steep" for building, so a cliff is well past that.
const PLACE_CLIFF_SPREAD = 12;
const PLACE_STEEP_SPREAD = 6;
const PLACE_FLAT_SPREAD = 2;
const PLACE_FLAT_SUPPORT = 80;               // supportPercent is 0-100, not 0-1
const PLACE_WET_COLUMNS = 20;
const PLACE_UNDERGROUND_Y = 55;
// how far under the surface counts as being INSIDE the world rather than in a
// building. reported by the companion as a heightmap delta, which is honest at
// any elevation - the y-height rule called a mountain cabin at y=54 a cave.
const PLACE_UNDERGROUND_DEPTH = 8;
// vanilla's hostile-spawn threshold. dark in the daytime means something is
// over her, which is worth noticing and is where things come from.
const PLACE_DARK_LIGHT = 7;
const PLACE_HIGH_Y = 110;
const PLACE_HOSTILE_COUNT = 3;
// ⚠ WHAT MAKES SOMEWHERE WORTH A SLOT. she walks constantly, and a recorder
// with only a time throttle files a fresh entry every 48 blocks - nineteen of
// them on one 900-block venture, every one of them nothing, and the cap then
// evicts the ravine she named. flat ground and tree cover are true of most of
// the overworld, so they describe a place without justifying one.
const PLACE_NOTABLE_FEATURES = new Set([
    'lava', 'village', 'built', 'ruin', 'exposed_ore', 'cliff',
    'cave', 'underground', 'herd', 'crops', 'open_water', 'high',
    // real dungeon content. unlike everything above these are IDENTIFICATIONS, not
    // heuristics - the block that produces each occurs in exactly one kind of place.
    'dungeon', 'trial_chamber', 'vault', 'deep_dark'
]);
// biome borders flicker: walking one crosses back and forth every few blocks,
// so this is what makes an arrival ONE moment instead of twenty.
const BIOME_EVENT_GAP_MS = 3 * 60 * 1000;
// the much smaller set worth actually stopping for. `built` and `crops` are
// deliberately absent - a fence post on the horizon is not a discovery, and
// every plains biome has wheat in it somewhere.
// ⚠ a trial chamber and the deep dark belong here more than anything already in
// the set: they are the two places in the game where walking in unprepared is
// genuinely dangerous, and they are exactly what "novel place" is supposed to mean.
// `vault` is deliberately NOT here - it is a fixture INSIDE a chamber, so it would
// fire a second interruption about the same room seconds after the first.
const PLACE_STRIKING_FEATURES = new Set([
    'village', 'lava', 'ruin', 'cliff', 'cave', 'trial_chamber', 'dungeon', 'deep_dark'
]);
const PLACE_EVENT_GAP_MS = 8 * 60 * 1000;
// shorter than the place gap on purpose: a first sighting is already rare by
// construction (a set fires once per kind, ever, per world), so this is only
// here to space out the handful that arrive together - a cave mouth at night,
// or the first hour on a new world. it is not the thing keeping her quiet.
const CREATURE_EVENT_GAP_MS = 3 * 60 * 1000;

// ---- noticings -------------------------------------------------------------
// the thresholds the combination rules read. named rather than inline because
// each one is a judgement about when a fact becomes a scene, and those are the
// numbers an operator or a later pass will actually want to argue with.
const NOTICE_AT_MY_BACK_DIST = 6;    // close enough that not seeing it matters
const NOTICE_LOW_HEALTH = 8;         // four hearts: the "this could actually go wrong" line
const NOTICE_LOW_HUNGER = 6;         // where sprinting stops and regen dies
const NOTICE_OUTNUMBERED = 4;        // a crowd rather than a fight
const NOTICE_FAR_FROM_HOME = 220;    // beyond a comfortable sprint back to a bed
const NOTICE_OFFER_MAX = 3;          // a shortlist to choose from, not a briefing
// wider than the companion's 48-block built-ground scan, so a house sitting at
// the edge of the survey still claims the built columns the survey reported.
const OWN_BUILD_RADIUS = 96;
// sensitivity maps onto BOTH the salience floor and the gap between offers -
// see _noticeFloor/_noticeGapMs. at sensitivity 0 only a genuine emergency
// clears the floor and she is offered one at most every 6 minutes; at 1 she is
// offered the mildest thing on the board every 45s.
const NOTICE_FLOOR_MIN = 0.15;
const NOTICE_FLOOR_MAX = 0.7;
const NOTICE_GAP_MIN_MS = 45 * 1000;
const NOTICE_GAP_MAX_MS = 6 * 60 * 1000;
// ⚠ DEFAULT ON, unlike the trench. this one only ever changes what she may
// SAY - it breaks no ground, and off by default would mean the feature only
// exists for whoever reads the config docs. the conservative choice is made in
// the SENSITIVITY instead, which starts low.
const DEFAULT_NOTICE_ENABLED = true;
const DEFAULT_NOTICE_SENSITIVITY = 0.35;

// ---- curiosity --------------------------------------------------------------
// ⚠ THE DESTINATION SCORE HAS AN ANTI-EXPLORATION BIAS BUILT INTO IT, and it is
// there on purpose: `route.dry` is the fraction of the route she has personally
// stood on, so a fully-known corridor scores 1.0 and genuinely new country
// scores 0. that is correct for staying out of the sea and it means that, left
// alone, the longer she plays the more she re-treads her own paths.
//
// so curiosity is a NUDGE, deliberately bounded BELOW the dry-route term: it
// breaks ties and tips near-ties toward somewhere new, and it can never
// out-argue water avoidance, a claim, or a rejected site. the homestead is
// chosen a whole rung above this in _autonomousTick and never competes here.
const CURIOSITY_UNKNOWN_WEIGHT = 0.35;
const CURIOSITY_PLACE_WEIGHT = 0.4;
// how close a candidate has to land to pull toward a remembered place
const CURIOSITY_PLACE_RADIUS = 160;
// somewhere she looked at this morning is not somewhere she is missing
const CURIOSITY_PLACE_STALE_MS = 6 * 60 * 60 * 1000;
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
// build_plan, place_block and farm join them for the same reason: PlaceBlockTask
// and the tilling loop each own a finite TimeoutWanderTask, so short wanders
// there are the job, not a wedge.
// ⚠ `speedrun` is exempt for a DIFFERENT reason than the rest of this list, and
// it is the reason the rule needs one at all. The others shimmy in place; the
// speedrun is not one goal, it is a macro standing in for a whole session of
// them - get wood, find a village, trade, hunt blazes - and EACH subtask owns
// its own finite TimeoutWanderTask. Three short wanders in 75 seconds is what a
// healthy speedrun looks like from out here, so the storm rule read a working
// run as a wedge and gave up on it: observed live, 91 seconds after a viewer
// asked for one, `unreachable: speedrun - altoclef has re-wandered 3x in 75s at
// 5 blocks`. The macro never gets anywhere in the sense this rule means, because
// arriving is not what it is for.
//
// This costs no liveness cover. ACTION_STALL_MS.speedrun (90s of no position
// AND no inventory movement) is already documented as "its only external
// liveness bound when an internal task silently wedges" - a genuinely stuck
// speedrun still dies there, and a wandering one is by definition moving.
const WANDER_STORM_EXEMPT = new Set([
    'build_settlement', 'install_appliance', 'place', 'craft',
    'build_plan', 'place_block', 'farm', 'speedrun'
]);
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
// the owner, chat and the safety chain are all still free to ask for anything.
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

// ─── THE ARMORY ───────────────────────────────────────────────────────────────
// what she does with a FINISHED house. the homestead arc provisions the building
// and then returns null forever; the obsession keeps the fuel/bread/light topped
// up. neither of them ever made a second pickaxe, and nothing anywhere put a tool
// in a chest - so every time one broke she stopped and mined the iron again.
//
// this drive is the answer to "the base is up, now what": kit herself out, then
// keep SPARES on the shelf so future-her doesn't have to go back down the hole.
const ARMORY_STEP_COOLDOWN_MS = 5 * 60 * 1000;
// tiers she will actually chase. netherite is deliberately absent: it needs the
// nether, ancient debris and a smithing template, which is an expedition, not
// downtime - and `@get netherite_ingot` would quietly become one mid-stream.
const KIT_TIERS = ['diamond', 'iron'];
// what promotes her to the diamond kit. the proof is the PICKAXE, not a diamond
// count: three loose diamonds would set every one of the six kit slots wanting a
// diamond version at once, which is a twenty-diamond grind dressed up as a
// preference. one diamond pickaxe means she already got there.
const KIT_TIER_PROMOTE_RE = /(diamond|netherite)_pickaxe/;
// how many diamonds in the pantry before she'll try for the pickaxe itself.
const DIAMOND_PICKAXE_COST = 3;
// THE RESERVE - what the chest should hold, and what she keeps on her body while
// stocking it. `keep` is the load-bearing half of every row.
//
// ⚠⚠ THE ONE INVARIANT: SHE MAY ONLY EVER BANK THE SURPLUS ABOVE `keep`. the
// reserve is measured as carried+stored, so without this a chest deposit of her
// ONLY pickaxe satisfies "stored >= reserve", empties her hands, and the next
// tick re-crafts one to satisfy `keep` - deposit, recraft, deposit, forever, with
// a chest full of pickaxes and a girl holding none. `keep` is what makes the two
// numbers describe different objects instead of the same one twice.
// ⚠ ONLY THE TWO THAT MATTER TRACK THE TIER. a spare of everything at whatever
// she is currently wearing sounds tidier and is a trap: promoting her to diamond
// would set six rows wanting diamond versions at once, and `@get diamond_shovel 2`
// is a real mining expedition for a backup shovel. the pickaxe is the one that
// actually breaks and the sword is the one whose absence gets her killed; the rest
// of the shelf stays IRON, which is also what a person does - the old kit becomes
// the spares drawer when the new one arrives.
const ARMORY_RESERVE = [
    { item: '{tier}_pickaxe', keep: 1, reserve: 2, why: 'the one that always breaks first' },
    { item: '{tier}_sword', keep: 1, reserve: 1, why: null },
    { item: 'iron_axe', keep: 1, reserve: 1, why: null },
    { item: 'iron_shovel', keep: 1, reserve: 1, why: null },
    { item: 'iron_chestplate', keep: 0, reserve: 1, why: 'a spare shirt' },
    { item: 'torch', keep: 16, reserve: 64, why: null },
    { item: 'iron_ingot', keep: 0, reserve: 24, why: 'so the next repair is a craft, not an expedition' }
];
// the sundries that are not a tier: cheap, iron, and each one closes a real hole.
// the bucket is not decoration - MLGBucketFallChain clutches a fall with it.
const ARMORY_SUNDRIES = [
    // ⚠ `\bbucket\b` does NOT match `water_bucket` - `_` is a word character, so
    // there is no boundary - and a water bucket is the ONE the row exists for
    // (MLGBucketFallChain clutches a fall with it). carrying a full bucket, she
    // crafted a second empty one out of three more iron.
    { item: 'bucket', have: /bucket/, say: 'a bucket. water beats gravity and gravity has beaten me twice' },
    { item: 'shield', have: /shield/, say: 'getting a shield. i am tired of arguing with skeletons on their terms' }
];
// how many armory rows may ride in one deposit. the bridge caps an item list at
// 16; this is well under it and keeps one trip legible on stream.
const ARMORY_DEPOSIT_MAX = 6;
// how far she'll walk to cash the reserve in when a tool is about to break.
// deliberately far short of PANTRY_TRIP_MAX (256): restocking bread is worth a
// long walk home, a pickaxe with four swings left in it is not.
const RESERVE_SHOP_RADIUS = 64;

// ─── DOWNTIME ─────────────────────────────────────────────────────────────────
// the house is built, the shelf is stocked, nobody has asked for anything. what a
// person does with THAT is not "walk 900 blocks in a straight line", which is
// what the wanderlust roll below used to be her only answer.
const LEISURE_STEP_COOLDOWN_MS = 8 * 60 * 1000;
// sampled so the mood menu still breathes - same reason the homestead arc is
// sampled at 0.75. leisure that always wins is just a differently-shaped chore.
const LEISURE_SAMPLE = 0.5;
// THE TRIMMINGS, cheapest first, which is also roughly the order a person gets
// round to them. she is an appliance animist with a house made of toaster - the
// furniture that is not an oven is still furniture with a JOB, and standing it in
// her own yard is the most in-character way she has of saying she lives there.
//
// ⚠ each `needs` is a prereq on what she is CARRYING, checked the way OVEN_PREREQ
// is, and it is load-bearing: `@place_at` runs AcquireAndPlaceBlockTask, so an
// unaffordable ornament is not a refusal - it is a silent mining expedition for
// an enchanting table, mid-stream, captioned "putting a shelf up".
const COMFORT_WISHLIST = [
    { kind: 'lantern', needs: /iron_(ingot|nugget)/, say: 'putting a lantern up outside. a torch is a solution, a lantern is a decision' },
    { kind: 'composter', needs: /planks|_log\b/, say: 'a composter. i want somewhere official to put the disappointing vegetables' },
    { kind: 'glass_pane', needs: /\b(sand|glass)\b/, say: 'glass out front. i want to be able to see weather without being in it' },
    { kind: 'loom', needs: /\bstring\b/, say: 'a loom, because at some point i am going to want a flag and i refuse to be caught unprepared' },
    { kind: 'grindstone', needs: /planks|_log\b/, say: 'grindstone. it makes a horrible noise and it lives outside now' },
    { kind: 'cartography_table', needs: /\bpaper\b|sugar_cane/, say: 'cartography table. i am not lost, i just want the option to be smug about it' },
    { kind: 'bookshelf', needs: /\bbook\b/, say: 'a bookshelf. i am not going to read them. it is about the silhouette' },
    { kind: 'lectern', needs: /\b(book|bookshelf)\b/, say: 'a lectern. every yard needs one thing you could deliver a speech from' },
    // ⚠ THE TWO EXPENSIVE ONES NEED A COUNT, NOT AN EXISTENCE TEST. `needs` is a
    // regex over what she carries, which is fine for a loom (2 string) and a lie
    // for these: an anvil is 3 iron BLOCKS + 4 ingots and an enchanting table is 4
    // obsidian + 2 DIAMONDS + a book. matching one obsidian sends
    // AcquireAndPlaceBlockTask off on the diamond expedition this field exists to
    // prevent - the exact example written into the warning above.
    { kind: 'anvil', needs: /iron_block/, count: { iron_block: 3 }, say: 'an anvil. thirty one iron, makes one noise, and i want it' },
    { kind: 'enchanting_table', needs: /obsidian/, count: { obsidian: 4, diamond: 2 }, say: 'enchanting table out front. i cannot use it yet. it is aspirational furniture' }
];
// how far apart the porch ornaments stand, and how far the row sits inside the
// yard's outer edge. ONE block inside, because the perimeter torches stand on the
// yard bounds exactly and a lantern on a torch square is a fight over one block.
const COMFORT_SPACING = 2;
const COMFORT_YARD_INSET = 1;
// ─── PEOPLE ───────────────────────────────────────────────────────────────────
// how long she holds somebody's eye, in seconds, and how often she may re-aim at
// the same person. the gap is what stops a fast exchange becoming a look per line
// (a command per line at the companion, and a head that never settles).
const GAZE_HOLD_S = 2.5;
const GAZE_GAP_MS = 6000;
// a person this close is in her space - the distance at which not reacting reads
// as a bot rather than as being busy.
const PERSON_CLOSE = 6;
// hostiles on somebody within the companion's own threat radius. she can SEE this
// (the sweep counts mobs around each player), so "he's got two on him" is a fact
// rather than a guess.
const PERSON_HELP_THREATS = 1;
// how long after somebody walks up it still counts as "they just turned up" for
// the noticings board. an arrival is an instant, and every board rule is
// note-or-clear on every 2s frame, so it needs a window wide enough to survive
// until the next offer opening and short enough that it is still true when she
// says it. see _peopleArrivedAt.
const ARRIVAL_NOTICE_MS = 25 * 1000;
// she is not the emergency services. one rescue per person per this long, so a
// player farming mobs next to her doesn't own her whole session.
const HELP_GAP_MS = 90 * 1000;
const HELP_PER_PERSON_GAP_MS = 5 * 60 * 1000;
// a pilgrimage is rare on purpose: it is a walk to a place she likes for no
// reason, and a frequent one is just the wanderlust with a nicer caption.
const PILGRIMAGE_COOLDOWN_MS = 25 * 60 * 1000;
const PILGRIMAGE_MIN_DIST = 40;                    // next door is not a pilgrimage
const PILGRIMAGE_MAX_DIST = 600;                   // and neither is an expedition
// ---- EXPEDITIONS: the trip that survives the hop ---------------------------
//
// THE MEASURED PROBLEM. On the live save she had walked 9 cells, furthest 630
// blocks from home, mean 337 - while her own favourites from an earlier era sit
// 2789-4613 blocks out. Nothing was broken; the ceiling was structural. Every
// travel decision in this file is a SINGLE HOP with no memory of why, and two
// mechanisms then close the loop:
//   1. `_pickLandingSpot` clamps any hop over BLIND_WANDER_MAX (200) into ground
//      whose known-dry route fraction is under 0.5 - which is every route into
//      new territory, by definition. So the "300-900 block frontier" roll only
//      ever reaches 900 on ground she has ALREADY walked.
//   2. `home_instinct` pulls her back each night from up to 1200 blocks out.
// Hop out 200, get pulled home, repeat. That is the 630-block bubble exactly.
//
// The fix is NOT a bigger clamp - 200 blocks into unknown terrain is a survivable
// step and a 900-block blind leap across an ocean is the ocean incident again. The
// fix is a COMMITMENT that outlives one hop, so distance can accumulate: 200 x 14
// legs is 2800 blocks, walked one survivable step at a time.
const EXPEDITION_COOLDOWN_MS = 90 * 60 * 1000;     // an adventure, not a commute
const EXPEDITION_LEG_COOLDOWN_MS = 45 * 1000;      // pace the legs; the walk takes real time
// how far out a trip means to get. deliberately far beyond anything the old idle
// menu could reach, because "novel place" and "somewhere near home" are different
// requests and only one of them was ever satisfiable.
const EXPEDITION_MIN_DIST = 1500;
const EXPEDITION_SPAN = 2500;                      // so 1500-4000 blocks out
// she is allowed to be a long way from home for a long time, but not forever: a
// trip with no ceiling is indistinguishable from being lost.
const EXPEDITION_MAX_MS = 3 * 60 * 60 * 1000;
// how close to target counts as "made it". the last few blocks of a 3000-block
// walk are not worth a stall - and `furthest` is a high-water mark, so demanding
// exactness is how a trip never ends.
const EXPEDITION_ARRIVE_FRACTION = 0.9;
// a leg has to actually earn its distance or the trip is a wander with a name on
// it. same shape as the spawn-region march, which learned this the hard way.
const EXPEDITION_LEG_GAIN_FRACTION = 0.5;
// she does not set out on an empty stomach with a wooden pickaxe.
const EXPEDITION_MIN_FOOD = 6;
// standing at a spot she likes, doing nothing, on purpose.
const LINGER_COOLDOWN_MS = 30 * 60 * 1000;
const LINGER_RADIUS = 8;                           // "at" the spot, not "near" it
const LINGER_CHANCE = 0.35;
// HOW MUCH "GO AND MINE SOME" MEANS.
//
// ⚠ `@get <item> <n>` is a HOLD TARGET, never a batch (the documented bread
// treadmill, one mechanism over): ResourceTask.isFinished is `held >= n`, so
// asking for a number she already holds finishes before the task even STARTS -
// it reports success, nothing happens, and the tell in the game log is a task
// that took ~0.03s with no `Task START:` line under it.
//
// every gathering dispatch that named no amount was therefore floored to 1 by
// the bridge, which is the one number she is almost always already holding.
// observed live: `mine and collect: [[coal] x 1]` succeeding instantly every
// six seconds for eleven minutes while she stood still, and the whole mood menu
// ("gonna punch some rocks" -> stone -> cobblestone, of which she had 63) dead
// the same way. so an absent amount resolves to held + this, which is real work
// by construction whatever she happens to be carrying.
const GATHER_BATCH = 8;
// mirrors the bridge's `_itemName` ore->product map (minecraft_bot_bridge.js).
// only the aliases matter here: the held count has to be measured against the
// item the COMMAND will name, or the amount is computed off the wrong stack.
// ⚠ keep in step with the bridge; an entry missing here is not a crash, it is a
// dispatch sized off the wrong item, so `_resolveGatherAmount` is written to
// stay real work even when the lookup misses.
const GATHER_ALIASES = {
    diamond_ore: 'diamond', diamonds: 'diamond',
    coal_ore: 'coal',
    iron_ore: 'iron_ingot', raw_iron: 'iron_ingot', iron: 'iron_ingot',
    gold_ore: 'gold_ingot', raw_gold: 'gold_ingot', gold: 'gold_ingot',
    emerald_ore: 'emerald',
    redstone_ore: 'redstone',
    lapis_ore: 'lapis_lazuli', lapis: 'lapis_lazuli',
    copper_ore: 'copper_ingot', raw_copper: 'copper_ingot',
    ancient_debris: 'netherite_scrap',
    stone: 'cobblestone',
    wood: 'oak_log', logs: 'oak_log', log: 'oak_log'
};
// the actions whose amount is a stock level she gathers UP TO. `craft` is
// deliberately absent: "make me a bed" when she owns a bed is legitimately
// already done, and an increment there would have her craft one every tick.
const GATHER_ACTIONS = new Set(['get', 'mine', 'collect']);
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
// ⚠ WHAT SHE WILL HAND OVER WHEN ASKED, AND NOTHING ELSE.
//
// `give` is blocked from both request lanes on purpose - "give me your diamonds"
// from a stranger must never work, and that guard stays. this is the narrow
// opening: cheap, replaceable things she can restock in one trip, with a floor
// under each so being generous can never leave her without one herself.
//
// the floors are the point. `keep` is what she will not go below, so the last
// loaf, the working pickaxe and the torch that gets her out of the cave are all
// unreachable however nicely somebody asks.
//
// ⚠⚠ DECLARED HERE, BELOW BREAD_KEEP_BACK, AND THAT IS LOAD-BEARING. this is a
// module-scope object literal, so it is evaluated at import: written above its
// own dependency it is a TDZ ReferenceError that takes the whole tool - and
// every reply path that imports it - down on load. (it was, once. the import
// threw "Cannot access 'BREAD_KEEP_BACK' before initialization".)
const GIFT_ALLOW = {
    bread: { keep: BREAD_KEEP_BACK, max: 4 },
    torch: { keep: 8, max: 16 },
    cooked_beef: { keep: 2, max: 4 },
    oak_log: { keep: 0, max: 16 },
    cobblestone: { keep: 0, max: 32 },
    coal: { keep: 4, max: 8 },
    iron_ingot: { keep: 4, max: 4 },
    stone_pickaxe: { keep: 1, max: 1 },
    iron_pickaxe: { keep: 1, max: 1 },
    stone_sword: { keep: 1, max: 1 },
    iron_sword: { keep: 1, max: 1 }
};
// THE BAKE IS A TARGET, NOT A BATCH. `craft bread` becomes altoclef's
// `@get bread <n>`, and ResourceTask.isFinished is "am I HOLDING n" - so the
// number is the stock level she ends up at, and asking for a number she already
// has is a no-op that reports success. every bread step used to pass a flat 3
// (and the idle tendency passed nothing at all, which the bridge floors to 1),
// so she baked to exactly three loaves and no threshold above that was reachable:
// BREAD_COMFORT and BREAD_HOARD were decorative, and BREAD_FLOOR=4 sat ABOVE the
// ceiling, so "bread is low" was permanently true and the wheat run re-armed
// forever. that is the "one loaf at a time, always going out for more" loop.
const WHEAT_PER_LOAF = 3;
// how much wheat one restock trip asks for. the run is a target too, so this is
// the size of the pantry she walks home with - enough to actually fill the
// comfort shelf in one trip instead of two loaves' worth. capped because a wheat
// target she cannot meet nearby is a farm grind, not a stock-up.
// ⚠ this has to sit BELOW the shelf's own demand or it is decorative: the run
// asks for (BREAD_COMFORT - bread) * WHEAT_PER_LOAF, which maxes at 24, so a cap
// of 32 could never bind on any input. 24 is the whole shelf from empty.
const WHEAT_RUN_CAP = BREAD_COMFORT * WHEAT_PER_LOAF;
// RANGED KIT. a skeleton answered at twenty blocks is not a fight; a creeper shot
// before it arrives never gets to do the one thing it does. both numbers below are
// HOLD TARGETS for the same reason every other number on this page is - `craft
// arrow 32` becomes `@get arrow 32`, which finishes the moment she is HOLDING 32.
// ⚠ THE FLOOR MUST SIT BELOW THE TARGET or the restock can never reach its own
// trigger and re-arms forever: that is precisely the BREAD_FLOOR-above-the-3-loaf-
// ceiling bug that made "bread is low" permanently true. 8 < 32, so a run ends.
const ARROW_FLOOR = 8;
const ARROW_TARGET = 32;
// one flint + one stick + one feather yields four arrows. sticks come from any
// wood and altoclef will make them, so the scarce PAIR is what actually bounds a
// batch - see the arrow candidate in _survivalPrep, which refuses to ask for more
// than the materials pay for.
const ARROWS_PER_CRAFT = 4;
// three string is the bow recipe (the three sticks are free by comparison).
const BOW_STRING_COST = 3;
// what the companion's nearby-block scan says about each thing she can eat off the
// ground. `ripe` is the field that matters and the one an older jar does not send;
// its ABSENCE means "this build cannot tell", which is not the same as zero and must
// never be read as one - see _observeFoodSpots.
const FOOD_SPOT_SOURCES = [
    { kind: 'wheat', dist: 'wheat', count: 'wheatCount', ripe: 'wheatRipe' },
    { kind: 'carrot', dist: 'carrot', count: 'carrotCount', ripe: 'carrotRipe' },
    { kind: 'potato', dist: 'potato', count: 'potatoCount', ripe: 'potatoRipe' },
    { kind: 'beetroot', dist: 'beetroot', count: 'beetrootCount', ripe: 'beetrootRipe' },
    { kind: 'berries', dist: 'berries', count: 'berriesCount', ripe: 'berriesRipe' }
];
// one spot per kind per half-minute. the write is cheap but it is also a disk save,
// and a field does not become more real by being logged sixty times a minute.
const FOOD_RECORD_THROTTLE_MS = 30000;
// how many animals make a place a PASTURE rather than one pig passing through.
// the companion counts them in a 64-block cube, which in a plains biome is almost
// always non-zero - so this is a real herd, not livestock existing.
const HERD_IS_A_SPOT = 5;
// pastures are logged far more rarely than fields: she walks past animals
// constantly, and each 30s of travel is a NEW location, so the crop throttle would
// turn the whole ledger into herds.
const HERD_RECORD_THROTTLE_MS = 6 * 60 * 1000;
// how far "forget the spot i'm standing in" reaches. matches the memory layer's
// merge radius on purpose: a delete that reached further than a record could merge
// took out neighbouring spots she never meant to touch.
const FOOD_SPOT_FORGET_RADIUS = 24;
// THE NON-BREAD PANTRY. bread only exists where wheat does, and altoclef's own
// auto-forage is switched off in the fork (Settings.foodUnitsToCollect = 0), so
// with no wheat around her ONLY food path was the survival-prep emergency, which
// asks for a food score of 3 - less than a single loaf. that tops her up to one
// item, stops, and sends her back out the moment she eats it: the same
// go-out-for-food treadmill as the bread bug, just on a different crop.
//
// `@food <n>` (CollectFoodTask) is the real stock-up primitive - it hunts, smelts
// raw meat and turns any wheat or hay it finds into bread - and nothing has ever
// called it with a number worth the walk.
//
// ⚠ BOTH HALVES OF THE TRIP MUST BE IN THE SAME UNIT, and the unit is altoclef's:
// `CollectFoodTask.isFinished` is `calculateInventoryFoodScore() >= n`, i.e.
// NUTRITION x COUNT, not a number of items. shipped first with an item-count
// trigger against a score target, which has a reachable fixed point: cooked beef
// is 8 nutrition, so FIVE steaks are 40 score (the target, already met) and five
// items (under a six-item trigger). the step would then be permanently due and
// permanently instant - she announces the forage every five minutes, `@food 40`
// returns success immediately, nothing happens, and the tick is stolen from the
// steps below it. scoring both sides kills the fixed point by construction.
const FOOD_RESERVE_UNITS = 40;
// nutrition per item, for the same score altoclef computes. only needs the foods
// she realistically carries; anything unlisted falls back to a deliberately LOW
// guess, so an unknown food can never inflate the score and suppress a real
// forage. (bread 5, cooked beef/porkchop 8, golden apple 4 - vanilla values.)
const FOOD_NUTRITION = {
    bread: 5, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6,
    cooked_salmon: 6, cooked_cod: 5, cooked_rabbit: 5, baked_potato: 5,
    golden_apple: 4, enchanted_golden_apple: 4, apple: 4, carrot: 3, potato: 1,
    beetroot: 1, melon_slice: 2, sweet_berries: 2, glow_berries: 2, dried_kelp: 1,
    beef: 3, porkchop: 3, mutton: 2, chicken: 2, salmon: 2, cod: 2, rabbit: 3,
    rabbit_stew: 10, beetroot_soup: 6, mushroom_stew: 6, suspicious_stew: 6,
    pumpkin_pie: 8, honey_bottle: 6, golden_carrot: 6, poisonous_potato: 2
};
const FOOD_NUTRITION_FALLBACK = 2;
// ---- the pantry ------------------------------------------------------------
// WHAT SHE OWNS vs WHAT SHE IS CARRYING. every food and material decision in
// this file used to read her pockets alone, so five hundred loaves in a chest at
// home were invisible: "bread is low" was permanently true and she farmed, baked
// and foraged for what she already had. that is the reported bug.
//
// ⚠ THESE ARE STILL TWO QUESTIONS AND MUST NOT COLLAPSE INTO ONE SUM.
//   - the loaf she hands somebody who walks up (BREAD_KEEP_BACK) is CARRIED. add
//     storage there and she walks around empty-handed "giving" bread she left at
//     home.
//   - the reason not to grow another field (BREAD_COMFORT / BREAD_HOARD) is
//     CARRIED + STORED. that is the fix.
//   - what she can eat RIGHT NOW is carried. a chest is not food.
//
// ⚠ AND A STALE READING MAY NEVER TALK HER OUT OF RESTOCKING. anyone on a server
// can empty a chest, so a reading only suppresses work while it is fresh; past
// that she goes and LOOKS (peek) rather than assuming either way.
const PANTRY_FRESH_MS = 30 * 60 * 1000;
// close enough to shop at. the companion's `@withdraw` takes from the nearest
// container it knows holds the item, so dispatching one while she is nowhere
// near a stocked chest is a walk she never asked for wearing a withdraw's name.
const PANTRY_NEAR_RADIUS = 32;
// how far she will walk to her own shelf instead of gathering. a pantry across
// the world is not a pantry, it is a story about one - past this she does the
// honest thing and goes and gets the stuff.
const PANTRY_TRIP_MAX = 256;
// Specialty targets. Plain furnaces and the first smoker are managed by the
// deterministic floorplan gallery instead of this secondary collection.
const OVEN_TARGETS = { furnace: 3, smoker: 2, campfire: 2, blast_furnace: 1, soul_campfire: 1 };
// HOW MANY OF EACH APPLIANCE THE FLOORPLAN HOLDS used to live here as four
// module constants read off the 'homestead' ROLE. They are gone on purpose: two
// plans now live at once, and a role cannot tell them apart. A v2 (layered)
// house has a different gallery from a v1 and holds no smokers at all, so a
// constant computed at import time is the wrong number for half the houses in
// the world - and a target that can never be met is a step that never finishes.
// Ask the settlement instead: see _fixtureTarget().
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
// The same hour, for the same reason, one ring further out. The trench is dug
// through whatever the ground happens to be, so a column inside bedrock, under a
// neighbour's claim or below an unloaded chunk is a block she will never break -
// and the moat is the LONGEST job on the plan, so left to the 4-minute upgrade
// cooldown it is an entire stream of walking out to swing at the same corner.
const TRENCH_STUCK_BACKOFF_MS = 60 * 60 * 1000;
const OUTPOST_MIN_HOME_DISTANCE = 180;

// ---- WHERE A NEW BUILDING IS ALLOWED TO STAND ------------------------------
//
// `toasterYardSeparation(a, b)` is the GEOMETRIC floor: the distance at which
// two yards - and the trenches dug outside them - stop reaching each other's
// walls. 45 blocks for two v2 toasters, 38 for two v1s. Standing exactly there
// is legal and still reads as one crowded compound, so this is the elbow room
// on top of the geometry: far enough that each build is visibly its own place,
// near enough to walk between without an expedition.
//
// ⚠ THIS IS A FLOOR, NEVER A REPLACEMENT. Always
// `max(toasterYardSeparation(a, b), SETTLEMENT_MIN_SEPARATION)` - a plan bigger
// than anything shipping today must still get its own yard, and a constant
// cannot know that.
const SETTLEMENT_MIN_SEPARATION = 64;
// How far out a taken site will look for clear ground before giving up, and how
// many bearings it tries at each ring. 12 bearings is one every 30 degrees -
// enough that a house wedged against a cliff still finds the open side.
const SITE_SEARCH_MAX_PUSH = 320;
const SITE_SEARCH_BEARINGS = 12;
const SITE_SEARCH_RING_STEP = 24;

// ---- the procedural houses -------------------------------------------------
//
// THE TOASTER IS NOT THE ONLY HOUSE SHE IS ALLOWED TO BUILD. The in-game
// blueprint registry (Blueprints.java) ships five ordinary plans, and any of
// them is a real home - `build_plan <id> <x> <y> <z>`, no footprint on the wire
// because the plan owns its own size.
//
// ⚠ `shellBlocks` IS A NODE-SIDE AFFORDABILITY ESTIMATE, NOTHING ELSE. It is
// floor + walls + roof less a doorway, derived from the spec's dimensions, and
// it exists so "can she pay for this tonight" is a number rather than a vibe.
// It is deliberately NOT sent anywhere and never compared against the game: the
// java map is the truth about what gets placed, and a second copy of the real
// geometry here is the drift the floorplan already taught us about once.
//
// `serves` is what the plan can be a HOME for, which is not always the java
// spec's own kind - a simple_shelter is registered as a "shelter" and is still
// somewhere she lives.
const PROCEDURAL_PLANS = Object.freeze({
    simple_shelter:   { serves: 'homestead', label: 'simple shelter',   shellBlocks: 96,  material: 'any' },
    wood_house:       { serves: 'homestead', label: 'wood house',       shellBlocks: 208, material: 'wood' },
    fancy_wood_house: { serves: 'homestead', label: 'fancy wood house', shellBlocks: 392, material: 'wood' },
    stone_outpost:    { serves: 'outpost',   label: 'stone outpost',    shellBlocks: 148, material: 'stone' },
    wood_outpost:     { serves: 'outpost',   label: 'wood outpost',     shellBlocks: 148, material: 'wood' }
});
// HOW MUCH GROUND A PROCEDURAL HOUSE TAKES UP, for the one question that needs
// it: "would putting this here land on something she already built".
//
// ⚠ DELIBERATELY AN UPPER BOUND, NOT A TABLE. The rule above holds - the java
// map is the truth and a second copy of it here is drift waiting to happen - so
// this is the widest any shipping plan is (fancy_wood_house, 13x9), used for
// every one of them. A plan added or grown in java can only ever make this
// answer more cautious; it can never make it wrong. Spacing a 5x5 shelter as if
// it were 13 wide costs a few blocks of lawn and buys immunity from that drift.
const PROCEDURAL_PLAN_MAX_FOOTPRINT = 13;
// the toaster is the sixth option and the only one that is not a build_plan id,
// so it needs a name the ledger can hold alongside the others.
const TOASTER_PLAN_ID = 'toaster';
// ToasterTier.java: 1126 shell blocks. Quoted here for the same reason the plan
// costs are - so the choice can weigh "a night's work" against "a project".
const TOASTER_SHELL_BLOCKS = 1126;
// what counts as being able to pay for the toaster out of her own pockets. she
// never carries 1126 of anything, and the build gathers as it goes, so this is
// "she is a stone person with a stone person's stock", not the real bill.
const TOASTER_STONE_READY = 256;
// what her bag counts as building stock, per material family. cobblestone,
// stone, deepslate and the smooth/brick rungs are all shell material; logs and
// planks are the wood plans' material.
const STOCK_STONE_RE = /\b(cobblestone|cobbled_deepslate|stone|smooth_stone|stone_bricks|deepslate|andesite|diorite|granite)\b/;
const STOCK_WOOD_RE = /\b([a-z]+_(log|planks|wood)|planks|logs)\b/;

// ---- settlement upgrades ---------------------------------------------------
//
// The ledger (minecraft_memory setSettlementUpgrade/nextPlannedUpgrade) has
// existed with nothing executing it. These are the numbers that make executing
// it safe.
//
// ⚠ `attempts` IS A CONSECUTIVE-FAILURE COUNT, not a dispatch count. A perimeter
// of torches is a dozen successful dispatches; counting those against the
// abandon limit would retire the upgrade in the middle of doing it correctly. So
// every dispatch stamps `lastAttemptAt` and bumps `attempts`, and every SUCCESS
// resets `attempts` to zero.
const UPGRADE_MAX_ATTEMPTS = 5;
// exponential, from four minutes, capped at an hour. an upgrade that keeps
// failing must go quiet rather than re-firing on every idle tick - the same rule
// the homestead steps and the autonomy briefs already follow.
const UPGRADE_RETRY_BACKOFF_MS = 4 * 60 * 1000;
const UPGRADE_RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000;
// ⚠ THE LEDGER HAS THREE STATES AND NONE OF THEM IS "GAVE UP" (planned /
// building / done). So an abandoned upgrade is parked in `done` with a note
// saying so. It has to be terminal: leaving it `planned` means
// nextPlannedUpgrade hands back the identical doomed step forever, which is the
// loop this backoff exists to prevent.
const UPGRADE_ABANDONED_NOTE = 'gave up on it';
// upgrades get a MUCH shorter gap than the 4-minute homestead steps, because a
// perimeter is a dozen torches and one every four minutes is an hour of stream
// spent lighting a lawn. ⚠ it is charged in the step's `commit`, i.e. only when
// the dispatch really went out - so a refused step costs neither the gap nor an
// attempt, and there is nothing to hand back.
const UPGRADE_STEP_COOLDOWN_MS = 60 * 1000;
// an upgrade left in `building` with nothing in flight is a dispatch whose
// terminal never arrived. put it back rather than letting it wedge the plan.
const UPGRADE_STALE_BUILDING_MS = 10 * 60 * 1000;
// how far apart the yard's ground torches stand. must match
// Settlement.PERIMETER_LIGHT_SPACING in the java twin - and where the survey
// publishes `yardLightSpacing` that number WINS, so the one value both sides
// depend on is read from the world rather than duplicated on faith.
const PERIMETER_LIGHT_SPACING = 10;
// one dispatch per idle tick places one torch, so a ring has to be bounded or a
// big yard becomes the only thing she ever does. 48 covers the homestead's yard
// (14x9 house + 10 all round = 34x29, so 4x4 stops) many times over.
const PERIMETER_TORCH_CAP = 48;
// how many torches she has to be carrying before lighting a perimeter is a
// placement rather than a shopping trip.
const PERIMETER_TORCH_FLOOR = 4;
// how far past the yard the quarry mouth sits, and how wide the yard is. BOTH
// mirror Settlement.java (QUARRY_OFFSET = 6, YARD_MARGIN = 10) because the mouth
// java walks to and the mouth node remembers have to be the same block - a
// quarry ledger pointing at a different hole from the one the stone run digs is
// two holes.
const QUARRY_OFFSET = 6;
const SETTLEMENT_YARD_MARGIN = TOASTER_YARD_MARGIN;
// how deep one lighting pass takes the shaft, and how far apart the lights go.
// upgrade_quarry lights what is already dug; it does not dig.
const QUARRY_TORCH_SPACING = 4;
const QUARRY_TORCH_CAP = 12;
// SHELL_IRON RE-OPENS THE ENTIRE SHELL. 1126 blocks of iron is 9 ingots each, so
// this is not a renovation she drifts into - it is what the house becomes if she
// ever genuinely arrives. The java side only climbs to the iron rung when she is
// holding MATERIAL_SWITCH_STOCK (64) of the better block, so that is the floor
// for even PLANNING it, and it is checked against iron blocks, not ingots.
const SHELL_IRON_RICH_BLOCKS = 64;
// ⚠ THE SAME LIST THE BRIDGE ENFORCES, restated so a refusal is a sentence
// instead of a translate error. It must never grow into building material:
// place_block writes NOTHING to the appliance ledger, which is exactly why
// torches go through it - and equally why a wall must not.
// the two fences are the trench's causeway furniture - the gate on the outer lip
// of the one crossing, the fence closing the lip either side of it - and they are
// fittings at an exact coordinate, not a wall she can raise anywhere.
// ⚠⚠ AND THE TRIMMINGS, WHICH IS THE HALF THAT WAS MISSED ONCE ALREADY. this
// list and the bridge's are TWO COPIES OF ONE RULE, and node runs first: adding
// the ornaments to the bridge alone left `_comfortStep` dispatching a composter
// that `_canonicalWorldBuildParams` threw on before it ever reached the wire.
// nothing was placed, so nothing was recorded, so the wishlist offered the same
// composter every eight minutes forever - voicing a fault on stream each time.
// `tmp/mc_armory_test.mjs` now drives the WHOLE node path for every ornament, not
// just the bridge translator, because a bridge-only test passed that bug.
const PLACEABLE_BLOCKS = new Set([
    'torch', 'wall_torch', 'soul_torch', 'lantern',
    'ladder', 'cobblestone', 'dirt', 'oak_planks',
    'oak_fence', 'oak_fence_gate',
    ...COMFORT_KINDS
]);
// where the chosen house is written down. ⚠ THE PLAN ID RIDES IN SQUARE BRACKETS
// AT THE END OF THE GOAL TEXT and that is the entire storage format - read with
// an anchored regex and validated against the plan table before it is believed.
const BLUEPRINT_GOAL_KIND = 'blueprint';
const BLUEPRINT_GOAL_RE = /\[([a-z0-9_]+)\]$/;
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
        // the ranked readout (nearest-first, with distance, direction and
        // whether it has decided about her) and the wider set of kinds the
        // bestiary counts. both default empty so an older companion that sends
        // neither reads as "this jar cannot tell" and nothing downstream
        // invents a creature or a first sighting out of it.
        nearbyCreatures: [],
        nearbyCreatureTypes: [],
        // THE DEFENSE CHAIN'S COMMITTED ANSWER about whatever is hitting her -
        // dodge, fight or run - plus whether it is a bow fight, whether her gear is
        // still in the bag, and whether the fight would go her way if it weren't.
        //
        // ⚠ null DEFAULT, AND null MEANS "THIS JAR CANNOT TELL", never "she is not
        // fighting". an older companion sends no `combat` at all, and the whole
        // point of defaulting rather than fabricating a `mode: 'none'` is that a
        // false calm is the one failure that reads worst: she narrates a quiet
        // evening with a creeper on her. same rule as nearbyCreatures above and
        // `<crop>Ripe` in the food scan - absent is a gap in the telemetry, not a
        // fact about the world.
        combat: null,
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
        nearbyPlayerNames: [],
        // WHO IS ON THE SERVER, as against who is standing next to her. server chat
        // is global, so this - not nearbyPlayers - is the count of people who can
        // read what she says. see chatRoom().
        onlinePlayers: 0,
        onlinePlayerNames: []
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
        // without this the whole point of the trip is invisible to her: a real
        // stock-up recorded no accomplishment and no recent event, so her context
        // never learned she had done it and she could talk about being out of food
        // while carrying a full pantry.
        case 'stock_food': return 'stocked up on food';
        case 'equip': return t ? `equipped ${t}` : 'geared up';
        case 'deposit': case 'stash': return 'stored items';
        // the point of the trip is that she DIDN'T go and make more, so say which
        // thing she picked up off her own shelf - "took items" would leave her
        // context unable to tell a shopping trip from a mining one.
        case 'withdraw': return t ? `took ${t.replace(/_/g, ' ')} back out of her own chest` : 'took stuff back out of a chest';
        case 'peek': return 'looked in a chest to see what was actually in it';
        case 'speedrun': return 'made speedrun progress';
        case 'explore': return 'explored around';
        case 'give': return t ? `handed over ${t}` : 'gave items';
        case 'locate': return t ? `found the ${t}` : 'located a structure';
        case 'place': return t ? `placed ${t.replace(/_/g, ' ')} at the spot` : 'placed a block';
        case 'install_appliance': return t ? `installed ${t.replace(/_/g, ' ')} in its slot in the toaster` : 'installed an appliance';
        case 'build_settlement': return `finished the ${String(params.role || 'toaster').replace(/_/g, ' ')}`;
        case 'build_plan': return `finished building the ${String(params.blueprint || 'house').replace(/_/g, ' ')}`;
        case 'place_block': return t ? `put a ${t.replace(/_/g, ' ')} up at the spot` : 'placed a block';
        case 'farm': return String(params.mode || params.target) === 'expand' ? 'widened the wheat field' : 'made a wheat field';
        case 'build': return 'built something';
        default: return null; // status/coords/inventory/idle/stop/etc - not accomplishments
    }
}

/**
 * A REFUSAL IS NOT A FAULT, and she was reporting every one of them as one.
 *
 * `executeAction`'s catch emits `actionFailed` for anything that isn't literally
 * "task stopped", and burnt.js turns that into "[minecraft fault] ... my own controls
 * refused it ... the owner is watching the stream to find out when i am broken". That
 * fired for the spawn-region rule, the blocked-site cooldown, F1 manual control,
 * stale telemetry, the busy gate and her own repeated-failure backoff - i.e. every
 * time one of her rules WORKED. the owner presses F1 to play beside her and she announces
 * to chat that she is broken.
 *
 * These carry a flag so the voice can tell "i decided not to" from "something is
 * broken". They are still emitted, still logged, still stream events - a refusal is
 * worth saying out loud, just not as a malfunction.
 */
function policyRefusal(message) {
    const err = new Error(message);
    err._policy = true;
    return err;
}

class MinecraftTool extends EventEmitter {
    constructor({ memory = null, registerMemoryExitHook = true,
        names = null, broadcast = null, remember = null } = {}) {
        super();

        // the names YOUR vtuber answers to (see buildAddressedRe / setBotNames).
        if (names) setBotNames(names);
        // optional sink for internal commentary cues, mirrored to your UI.
        this.broadcast = broadcast;
        // optional long-term-memory sink. this library has no database of its
        // own; if your brain keeps one, pass { player, gameplay } callbacks and
        // the milestones worth recalling tomorrow get handed over.
        this.remember = remember;

        this.config = {
            port: DEFAULT_PORT,
            actionTimeout: DEFAULT_ACTION_TIMEOUT,
            autonomousTickMs: DEFAULT_AUTONOMOUS_TICK_MS,
            debug: false,
            // the moat, off until asked for - see _trenchEnabled. fed by the db key
            // `minecraft_trench_enabled` through initialize({ trenchEnabled }).
            trenchEnabled: DEFAULT_TRENCH_ENABLED,
            // how twitchy she is (0..1). LOW on purpose - see DEFAULT_TIC_FREQUENCY.
            // fed by the db key `minecraft_tic_frequency` through initialize().
            ticFrequency: DEFAULT_TIC_FREQUENCY,
            // whether she is offered the noticings shortlist at all, and how
            // readily. db keys `minecraft_notice_enabled` /
            // `minecraft_notice_sensitivity` through initialize().
            noticeEnabled: DEFAULT_NOTICE_ENABLED,
            noticeSensitivity: DEFAULT_NOTICE_SENSITIVITY
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
        // the shortlist of things she has clocked and not yet said anything
        // about. recentEvents is HISTORY (what happened); this is CANDIDATES
        // (what is worth a reaction right now, ranked) - see notice_board.js.
        this.noticeBoard = new NoticeBoard();
        this._lastNoticeOfferAt = 0;
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
        this._lastRequestChatAt = 0;      // the request lane's own floor (see CHAT_REQUEST_GAP_MS)
        this._requestDecisionInFlight = null;  // the freeform ask her brain is choosing an action for
        this._requestDecisionTimer = null;
        this._chatSendTimes = [];
        // last time a move was refused for having nowhere to go (see the rejection
        // site) - a second one in quick succession gets a different answer
        this._lastNowhereMoveAt = 0;
        // the build site the game side refused outright, and until when. See
        // BLOCKED_SITE_COOLDOWN_MS and _blockedSiteRefusal.
        this._blockedSiteUntil = 0;
        this._blockedSiteKey = null;
        this._blockedSiteWhy = '';
        // open exchanges: who she is currently in a back-and-forth with, so their
        // follow-ups reach her without her name in them (see CHAT_EXCHANGE_MS)
        this._chatExchanges = new Map();  // senderKey -> { until, since, name }
        this._recentAddressers = [];      // who addressed her lately, awaiting her reply
        // "just standing there" guards: when she last took a hit, and how long a
        // task has been running with no burnt-side goal behind it
        this._lastDamageAt = 0;
        this._damageEpisodeAt = 0;   // when the CURRENT bout of taking hits began
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
        // the one job danger took off her, kept so she can go back to it - see
        // _noteTaskInterrupted. one frame, deliberately not a stack.
        this._interrupted = null;

        // f1 manual control: the human owns keyboard/mouse; bot goals blocked
        this.manualControl = false;
        // WHAT SHE DOES WITH FREE TIME. 'auto' is the old ladder, verbatim; the
        // other modes replace only the idle provider (see _autonomyModeBehavior).
        this.autonomyMode = AUTONOMY_MODE_DEFAULT;
        this._autonomyModeCooldowns = new Map();
        this._autonomyModeArmed = null;   // released when the caller refuses the step
        this._lastOreRecordAt = {};       // kind -> when, so one seam isn't written per packet
        // an arrival waiting on her brain to say what the gesture is. holds the
        // opportunity facts + the fallback timer that fires if nothing answers.
        this._breadOpportunity = null;
        // WHICH HOUSE SHE DECIDED TO BUILD, as a ram fallback for the ledger.
        // the durable copy lives in the goals ledger (see _settlementPlan); this
        // only covers the case where the write failed, because a chooser that
        // re-decides mid-build on a changed inventory is a half-built house
        // abandoned for a different one.
        this._settlementPlanCache = new Map();
        // perimeter torch spots she has either lit or given up on, per settlement.
        // ⚠ RAM ONLY, and that is a considered trade: the toaster's yard is
        // answered by the in-game survey (`yardLit`), and for a procedural house
        // a restart just re-walks the ring, fails on the spots already burning,
        // and retires the upgrade - on a yard that is in fact lit, which costs
        // nothing. filing them as appliances instead would make the toaster's
        // gallery permanently unfinished, which costs everything.
        this._perimeterDone = new Map();
        // per-upgrade pacing, charged only when a dispatch really went out
        this._upgradeCooldowns = new Map();
        // homestead drive state
        this._homesteadCooldowns = new Map();
        this._homesteadArmed = null;      // cooldown armed by the last pass, released if refused
        // the long goal behind the arc, declared/closed once a session so the
        // ledger isn't rewritten to disk on every 25s tick
        this._homesteadGoalDeclared = false;
        this._homesteadGoalClosed = false;
        this._lastSettlementProgressSignature = '';
        this._sessionAnchor = null;
        this._homeRelocation = null;
        this._homeRelocationBackoffUntil = 0;
        this._lastWheatRecordAt = 0;
        // the obsession (ovens / bread / fire): its own cooldown map so a stalled
        // homestead step can't starve the drive that never finishes, and vice versa
        this._obsessionCooldowns = new Map();
        // downtime (ornaments / pilgrimage / lingering) keeps its own map for the
        // same reason: it is the lowest-ranked thing she does on purpose, and
        // sharing a map with the armory would let one stalled gear step take the
        // whole of her leisure with it.
        this._leisureCooldowns = new Map();
        // which key each drive armed on its most recent pass, so a refusal by the
        // tick can hand exactly that one back - see _releaseIdleDriveCooldowns.
        this._armoryArmed = null;
        this._leisureArmed = null;
        // ⚠ THE OBSESSION NEEDED ONE TOO, and was the last drive without it. its
        // step 1 is FUEL - "a cold oven is the actual emergency" - and a refused
        // step was charging the full 5-minute OBSESSION_STEP_COOLDOWN_MS for work
        // that never left the building, over a backoff that clears in two. same
        // shape as the survival-prep bug that charged its cooldown on a refusal.
        this._obsessionArmed = null;
        // when she last turned to look at each person, so a fast conversation is
        // one gesture and not one per line
        this._gazeAt = new Map();
        // who she has already clocked standing near her this session, so "somebody
        // new is here" fires on arrival rather than every two seconds
        this._peopleSeen = new Map();
        // WHEN each person arrived, kept for ARRIVAL_NOTICE_MS so the noticings
        // board has a CONDITION to test rather than a single-frame event.
        // ⚠ this exists because the board rule cannot ask _peopleSeen itself:
        // _observePeople runs first on every frame and marks everybody seen, so a
        // "not in _peopleSeen" test is unconditionally empty by the time
        // _noticeCombinations reads it - the someone_walked_up noticing had never
        // once fired. And it has to be a window, not a flag: every board rule is
        // note-or-clear on every frame, so a one-frame truth would be cleared
        // before it could ever be offered.
        this._peopleArrivedAt = new Map();
        // when she last handed each person something, per-person so one generous
        // moment can't be farmed
        this._giftsAt = new Map();
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
        // ⚠ THE BACKOFF USED TO BE ONE SLOT (`_avoidAction` + `_avoidUntil`), written
        // by SEVEN independent watchdogs. Each write erased the last, so the second
        // recovery to fire silently un-suppressed whatever the first had suppressed -
        // the more that went wrong, the less the guard remembered - and an A -> B -> A
        // alternation could never be suppressed at all, because blacklisting B freed A
        // and vice versa. It is now one entry per action, each with its own deadline.
        // See _avoidNote / _isAvoided.
        this._avoid = new Map();       // action -> { until, target }
        this._lastProtectionEscapeAt = 0;
        this._escapingProtection = false;

        this.autonomousTimer = null;
        this.lastAutonomousAt = 0;
        // the fidget scheduler - its own timer, because the autonomous tick returns
        // early on every busy state and a tic must be able to fire mid-job. See _ticStep.
        this.ticTimer = null;
        this._lastTicAt = 0;
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
            // EADDRINUSE = a previous burnt / stale tool / test stand-in is still
            // squatting our port. latest instance wins: stop the old node process
            // holding it and bind again, so a restart never needs manual cleanup.
            if ((err?.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err?.message))) && !opts._portReclaimed) {
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
            this._rearmStructureProtection();
            return;
        }
        if (!nowInWorld && wasInWorld) this._standDownSession();
    }

    /**
     * TELL THE GAME WHICH BUILDINGS ARE HERS, EVERY TIME SHE JOINS A WORLD.
     *
     * In-game, a settlement only becomes un-mineable when a build task registers
     * it - and a FINISHED house is never built again. So the one building she is
     * most likely to walk into, the completed homestead, was the one the game had
     * never been told to protect, and pathing straight through its wall was just
     * the shortest route home.
     *
     * Node owns the settlement list (it survives restarts; the game's does not),
     * so node is what re-states it. Fire-and-forget: this is a hint to the
     * pathfinder, and a world that refuses it simply prices walls the old way.
     */
    _rearmStructureProtection() {
        let settlements = [];
        try { settlements = this.memory.listSettlements(this._worldId()) || []; } catch { return; }
        if (!settlements.length) return;
        // a beat after joining: the companion is up, but the client may still be
        // loading chunks, and there is nothing urgent about a pathing hint.
        setTimeout(() => {
            if (!this.connected || !this.gameConnected) return;
            for (const settlement of settlements) {
                const role = settlement.role === 'outpost' ? 'outpost' : 'homestead';
                this.executeAction('protect_settlement', {
                    role,
                    x: settlement.anchor.x, y: settlement.anchor.y, z: settlement.anchor.z,
                    width: settlement.width, depth: settlement.depth, height: settlement.height,
                    settlementId: settlement.id
                }, {
                    source: 'system', priority: 'low', waitForCompletion: false,
                    why: `keep ${settlement.name} un-mineable`
                }).catch(() => { /* best-effort: an old jar has no such command */ });
            }
        }, 4000);
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
            // ⚠ THIS is how a fruitless crop run actually ends - it stalls and the
            // watchdog stops it, and the game then reports the cancelled task as a
            // SUCCESS. hanging the food-spot witness off the error branch alone left
            // it unreachable on the one path that matters.
            this._noteFoodRunFailed(pending);
            // ...and the identical trap on the ore ledger: a stalled mine is
            // stopped by the watchdog and comes back here reporting SUCCESS.
            this._noteOreRunFailed(pending);
            // ...and on the upgrade ledger. a watchdog stop IS evidence the step
            // is not working, so it counts against the abandon budget.
            this._noteUpgradeOutcome(pending, false);
            // ...and the same for a requested job: our own stop is evidence the
            // step is not working, so it spends one of the four attempts.
            this._noteGoalOutcome(pending, false);
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
                // an upgrade dispatch really landed, and a procedural house that
                // reports finished IS finished - there is no survey to ask, so
                // this terminal success is the only witness that house has.
                this._noteUpgradeOutcome(pending, true);
                this._noteBuildPlanFinished(pending);
                // the job somebody asked for is done, so stop going back to it.
                this._noteGoalOutcome(pending, true);
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
            const stopMessage = /^task stopped$/i.test((error.message || '').trim());
            // ⚠⚠ "task stopped" DOES NOT MEAN SOMEBODY CHANGED HER MIND. the bridge
            // answers EVERY inflight action with exactly this string the moment a
            // stop is translated - synchronously, before `@stop` even reaches the
            // game - and our own watchdogs stop a wedged goal by calling
            // executeAction('stop'). so a stall abort, a loop abort and an
            // unreachable-target abort all arrive here indistinguishable from a
            // re-task, and the guard below then skipped ALL accounting for them.
            //
            // that silently disabled three separate give-up budgets: a goal's four
            // attempts, an upgrade's abandon count, and the food/ore emptiness
            // witnesses. `attempts` never moved, so GOAL_ATTEMPT_LIMIT was
            // unreachable and _resumeGoalStep re-dispatched a doomed job every 90s
            // for the rest of the session - the exact "goes back to it forever"
            // failure the goal ledger was built to prevent.
            //
            // OUR OWN STOP IS EVIDENCE. the sibling branch above (success +
            // abortedByRecovery) already says so in as many words; it just could
            // never run, because the bridge gets here first.
            const wasStopped = stopMessage && !pending.abortedByRecovery;
            if (!NON_TASK_ACTIONS.has(pending.action)) {
                this._noteTaskOutcome();
                if (!wasStopped) {
                    this.memory.recordFailure(pending.action, pending.params?.target, error.message);
                    this._noteFoodRunFailed(pending);
                    this._noteOreRunFailed(pending);
                    // ⚠ inside the !wasStopped guard on purpose: a preempted
                    // upgrade is somebody changing her plans, not a step failing,
                    // and burning an attempt for it would retire a working job
                    // after five re-tasks.
                    this._noteUpgradeOutcome(pending, false);
                    // ⚠ inside !wasStopped for exactly the same reason, and it
                    // matters more here: being interrupted is the ONE case the
                    // resumable goal exists to survive. counting it would let
                    // four re-tasks abandon a job nobody ever said to drop.
                    this._noteGoalOutcome(pending, false);
                }
            }
            if (this.activeGoal?.id === msg.action_id) this.activeGoal = null;
            // ⚠ THE EMIT STAYS ON `stopMessage`, NOT `wasStopped`. the two questions
            // are different: "should this spend an attempt" (yes, our own abort is
            // evidence) and "should this be narrated as a failure" (no - the
            // watchdog that issued the stop has already put the words in her mouth,
            // and actionFailed here would make her voice the same abort twice).
            if (stopMessage) {
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
        // THE REAL ADVANCEMENT TREE, at last.
        //
        // The companion sends the completed set ONCE per world (`advancementsAll`)
        // and only newly-finished ids after that (`advancementsNew`). Both funnel into
        // the same recorder, which is idempotent per (world, id) - so the initial bulk
        // load records everything she has ever done here WITHOUT announcing a hundred
        // "first time!" moments, because after the first sync they are no longer first.
        //
        // ⚠ THE BULK LOAD MUST NOT SHOUT. `_recordProgression` fires `first_time` on a
        // genuinely new id, and the very first sync on an established world is ~40 ids
        // at once. `silent` suppresses the event for that one case only; the ledger is
        // written identically either way, so the NEXT real advancement still lands.
        if (Array.isArray(partial.advancementsAll)) {
            this._ingestAdvancements(partial.advancementsAll, { silent: true });
        }
        if (Array.isArray(partial.advancementsNew)) {
            this._ingestAdvancements(partial.advancementsNew, { silent: false });
        }
        if (partial.currentTask !== undefined) this.currentTask = partial.currentTask;
        // WHAT SHE DECIDED ABOUT THE THING HITTING HER, present-only.
        //
        // the Object.assign above already copies it when the frame carries it; this
        // is spelled out because the contract it protects is silent in both
        // directions. the companion sends `combat` on EVERY poll while it can tell
        // (mode 'none' when nothing is happening), exactly like nearbyCreatures -
        // which is what stops the merge above pinning a stale answer forever, the
        // despawned-creeper-still-four-blocks-behind-her bug. so a frame with no
        // `combat` at all is an OLDER JAR, and holding null for it is right: she
        // degrades to the behaviour she had before this field existed.
        //
        // ⚠ what must never happen is the inverse - manufacturing a calm reading
        // for a build that cannot tell. so nothing here ever writes a default, and
        // a malformed payload becomes null (unknown) rather than a trusted object.
        if (partial.combat !== undefined) {
            const combat = partial.combat;
            this.gameState.combat = (combat && typeof combat === 'object' && !Array.isArray(combat))
                ? combat
                : null;
        }
        // WHO IS HOLDING THE TICK, and is her actual job merely waiting its turn.
        //
        // ⚠ THE SAME PRESENT-ONLY RULE AS `combat` ABOVE, AND FOR A SHARPER REASON:
        // the merge is a sticky accumulator, so a `preempted: true` that simply
        // stopped being sent would latch forever - and this field SUPPRESSES the
        // stall and loop watchdogs. A stale true would mean nothing could ever end
        // a wedged task again. Absent is "this jar cannot tell" (null), never false.
        if (partial.preempted !== undefined) {
            this.gameState.preempted = typeof partial.preempted === 'boolean' ? partial.preempted : null;
        }
        if (partial.chain !== undefined) {
            this.gameState.chain = typeof partial.chain === 'string' ? partial.chain : null;
        }
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
        // food memory: walking past a field records it, and standing in a bare one
        // FORGETS it. see _observeFoodSpots.
        //
        // ⚠ FRESH OBSERVATIONS ONLY. the bridge heartbeats its last snapshot every
        // 30s and never clears it when the game closes, so a replayed frame would
        // keep voting - and a final frame taken just after she harvested says
        // "nothing ripe here" forever, which would delete the field minutes after
        // minecraft was shut down.
        if (realPos && freshObservation && !this._stateIsStale()) {
            this._observeFoodSpots(pos);
            // same freshness rule, same reason: a replayed heartbeat frame must
            // never write a seam she is no longer standing in.
            this._observeOreSpots(pos);
            // ...and the same rule again for WHERE SHE IS. a replayed frame
            // would keep re-describing somewhere she left twenty minutes ago,
            // and a stale biome reading would fire an arrival she never made.
            this._observePlace(pos);
        }
        // ⚠ NOT position-gated, unlike the two above. a container reading names
        // its OWN block, so it is true wherever her body is - and it must still
        // record on the tick she opened a chest from a spot the state has not
        // caught up with. it IS freshness-gated for the usual reason: a replayed
        // heartbeat would keep re-dating a reading she has not taken.
        if (freshObservation && !this._stateIsStale()) this._observeContainers(partial);
        // WHAT IS STANDING AROUND HER. ⚠ freshness-gated for the sharpest version
        // of the usual reason: the bridge replays its last snapshot every 30s, and
        // a replayed frame would announce her first enderman over and over off one
        // sighting - the bestiary would be right and her mouth would be a loop.
        if (freshObservation && !this._stateIsStale()) this._observeCreatures();
        // ...and the same freshness rule for people: a replayed heartbeat frame
        // would announce the same arrival forever off one sighting, and would keep
        // somebody who logged off half an hour ago standing beside her.
        if (freshObservation && !this._stateIsStale()) this._observePeople();
        // ...and dungeon content, freshness-gated for the same reason: a replayed
        // frame must never announce a trial chamber she walked out of ten minutes ago.
        if (freshObservation && !this._stateIsStale()) this._observeDungeonContent();
        // ⚠ COMBINATIONS RUN EVERY FRESH FRAME, the OFFER does not. the rules
        // are note-or-clear, so they have to see every frame or a danger that
        // resolved stays on the board; _noticeTick has its own gap and is what
        // keeps that from becoming a commentary track.
        if (freshObservation && !this._stateIsStale()) {
            this._noticeCombinations();
            this._noticeTick();
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
    // ---- where the food is ---------------------------------------------------
    // WHAT SHE CAN GO AND EAT, kept honest in both directions.
    //
    // this used to be one line that recorded a wheat spot whenever the companion
    // said the word `wheat`, and nothing anywhere ever removed one. two things made
    // that a loop she could not leave:
    //   1. the block id `wheat` covers age 0-7, and altoclef will not break a crop
    //      short of max age - so a field she had just harvested and replanted still
    //      read as food, forever.
    //   2. walking past a spot REFRESHED its timestamp, so the only eviction there
    //      was (oldest-first, on overflow) actively protected the dead field.
    // so: record what is genuinely harvestable, and when she is standing in a
    // remembered spot that has nothing ripe in it, say so out loud to the memory.
    _observeFoodSpots(pos) {
        const nb = this.gameState.nearby;
        if (!nb || typeof nb !== 'object') return;
        const dim = this.gameState.dimension;
        const now = Date.now();
        for (const src of FOOD_SPOT_SOURCES) {
            if (nb[src.dist] == null) {
                // out of scan range entirely. NOT evidence of anything - she cannot
                // see a field from four hundred blocks away, and treating silence as
                // "it's gone" would delete every spot she owns the moment she left.
                continue;
            }
            const ripe = Number.isFinite(nb[src.ripe]) ? nb[src.ripe] : null;
            const count = Number.isFinite(nb[src.count]) ? nb[src.count] : 0;
            if (ripe === 0) {
                // she is in it and there is nothing to take. an older companion jar
                // sends no `ripe` at all, and that stays null here - never zero -
                // so an old jar keeps the old behaviour instead of forgetting
                // every field it cannot measure.
                try {
                    const verdict = this.memory.noteFoodSpotEmpty(pos, dim, src.kind);
                    if (verdict === 'forgotten') {
                        this.recentEvents.record(`gave up on that ${src.kind} spot - nothing there three visits running`);
                    }
                } catch { /* best-effort */ }
                continue;
            }
            if (ripe === null && count <= 0) continue;
            if (now - (this._lastFoodRecordAt?.[src.kind] || 0) <= FOOD_RECORD_THROTTLE_MS) continue;
            if (!this._lastFoodRecordAt) this._lastFoodRecordAt = {};
            this._lastFoodRecordAt[src.kind] = now;
            try {
                this.memory.recordFoodSpot(src.kind, pos, dim, { count, ripe, world: this._worldId() });
            } catch { /* best-effort */ }
        }
        // a HERD, not one lost pig: a couple of animals wander through anywhere,
        // but a pasture is somewhere worth walking back to when the fields are bare.
        //
        // ⚠ AND A PASTURE IS SPENT BY VISITING IT - she goes there to kill the cows.
        // so it needs the same emptying as a field, or it becomes exactly the bug
        // this whole change exists to fix, on the one kind she consumes on arrival.
        const herd = Number.isFinite(this.gameState.foodAnimals) ? this.gameState.foodAnimals : null;
        if (herd === null) return;
        if (herd === 0) {
            try {
                const verdict = this.memory.noteFoodSpotEmpty(pos, dim, 'animals');
                if (verdict === 'forgotten') this.recentEvents.record('that pasture is empty now. nothing left to bother');
            } catch { /* best-effort */ }
            return;
        }
        // deliberately RARER than the crop throttle: animals are everywhere in a
        // plains biome, and one entry per half-minute of walking would fill the
        // whole ledger with pastures.
        if (herd < HERD_IS_A_SPOT) return;
        if (now - (this._lastFoodRecordAt?.animals || 0) <= HERD_RECORD_THROTTLE_MS) return;
        if (!this._lastFoodRecordAt) this._lastFoodRecordAt = {};
        this._lastFoodRecordAt.animals = now;
        try {
            this.memory.recordFoodSpot('animals', pos, dim, { count: herd, ripe: herd, world: this._worldId() });
        } catch { /* best-effort */ }
    }

    // ---- where the ore is ----------------------------------------------------
    // WHAT SHE HAS PERSONALLY SEEN IN THE GROUND. exactly the same shape as the
    // food ledger and for the same reason: without it, "go mine iron" is always a
    // blind expedition, and the seam she walked past an hour ago is gone forever.
    //
    // ⚠ ONLY WHAT SHE IS STANDING IN. the scan reports a nearest-ore DISTANCE, and
    // an entry is written at HER coordinates - so a reading from 30 blocks away
    // records a seam where there is no ore at all, and (the merge radius being 10)
    // it can never fold into the real one either. a rumour is not a place.
    _observeOreSpots(pos) {
        const nb = this.gameState.nearby;
        if (!nb || typeof nb !== 'object') return;
        const raw = typeof nb.nearestOre === 'string' ? nb.nearestOre : null;
        if (!raw) return;
        const dist = Number(nb.nearestOreDist);
        if (!Number.isFinite(dist) || dist > ORE_RECORD_MAX_DIST) return;
        const kind = normalizeOreKind(raw);
        if (!kind) return;
        const now = Date.now();
        // one write per kind per half-minute. the scan runs every ~2s and a vein
        // stays in it for as long as she stands there, so an unthrottled recorder
        // would write the same seam to disk hundreds of times per visit.
        if (now - (this._lastOreRecordAt[kind] || 0) <= ORE_RECORD_THROTTLE_MS) return;
        this._lastOreRecordAt[kind] = now;
        // the scan's per-kind tally is keyed by BLOCK id, so several keys
        // (`iron_ore`, `deepslate_iron_ore`) can be the same seam - normalize
        // before summing or a deepslate vein reads as zero.
        let count = 0;
        if (nb.ores && typeof nb.ores === 'object') {
            for (const [k, v] of Object.entries(nb.ores)) {
                if (normalizeOreKind(k) === kind) count += Number(v) || 0;
            }
        }
        try {
            this.memory.recordOreSpot?.(kind, pos, this.gameState.dimension, { count, world: this._worldId() });
        } catch { /* best-effort */ }
    }

    // ---- what this place is actually like ------------------------------------
    // the readings that make somewhere describable. ⚠ NONE OF THIS IS THE BIOME
    // NAME: the server dresses vanilla biomes through a datapack, so the id
    // stays `minecraft:forest` while the place looks nothing like a forest.
    // what she can honestly say about somewhere comes from the ground and the
    // blocks, not the label - the label is only good for "have i been somewhere
    // like this before".
    _describeHere() {
        const g = this.gameState;
        const nb = (g.nearby && typeof g.nearby === 'object') ? g.nearby : {};
        const site = (g.homeSite && typeof g.homeSite === 'object') ? g.homeSite : {};
        const features = [];
        // ⚠ absent is NOT zero. the scan omits a distance entirely when the
        // thing is out of range, and reading that as "it is right here" is the
        // present-is-not-available bug in its other direction.
        const within = (v, max) => v != null && Number.isFinite(Number(v)) && Number(v) <= max;

        if (within(nb.lava, PLACE_NEAR_BLOCKS)) features.push('lava');
        if (within(nb.water, PLACE_NEAR_BLOCKS) || g.overWater === true) features.push('open_water');
        if (within(nb.logs, PLACE_NEAR_BLOCKS)) features.push('trees');
        if (nb.nearestOre && within(nb.nearestOreDist, PLACE_NEAR_BLOCKS)) features.push('exposed_ore');
        if (Number(g.foodAnimals) >= HERD_IS_A_SPOT) features.push('herd');
        if (FOOD_SPOT_SOURCES.some((s) => nb[s.dist] != null)) features.push('crops');

        // the shape of the ground. supportPercent is 0-100 and heightSpread is
        // in blocks - both already computed AND CACHED companion-side for the
        // build-site check (SITE_CACHE_MS), so reading them adds no scan at all.
        const spread = Number(site.heightSpread);
        const support = Number(site.supportPercent);
        let shape = null;
        if (Number.isFinite(spread)) {
            if (spread >= PLACE_CLIFF_SPREAD) { features.push('cliff'); shape = 'cliff'; }
            else if (spread >= PLACE_STEEP_SPREAD) { features.push('steep'); shape = 'steep'; }
            else if (spread <= PLACE_FLAT_SPREAD &&
                (!Number.isFinite(support) || support >= PLACE_FLAT_SUPPORT)) { features.push('flat'); shape = 'flat'; }
            else shape = 'rolling';
        }
        if (Number(site.waterColumns) > PLACE_WET_COLUMNS) features.push('wet_ground');
        // ⚠ THE SURVEY THAT FINDS THIS ALREADY RUNS, and node used it for exactly
        // one thing: deciding not to live here. so the position of every village
        // she has ever walked through was computed, classified, and thrown away.
        if (Number(site.builtColumns) > BUILT_GROUND_TOLERANCE) features.push('built');
        // reported by the companion only on a jar that knows how to count
        // villagers. absent means "this jar cannot tell", never "no village".
        if (Number(g.villagers) > 0) features.push('village');
        // ⚠ 'ruin' HAD A GATE AND NO PRODUCER. it is listed in
        // PLACE_NOTABLE_FEATURES *and* in the narrower PLACE_STRIKING_FEATURES -
        // i.e. somebody judged it one of the handful of things worth
        // interrupting her for - and nothing in this file has ever pushed it,
        // so the branch has been unreachable for as long as it has existed.
        //
        // somebody built here and nobody is home. that is what a desert temple,
        // a ruined portal, an abandoned village and a stranger's dead base all
        // look like from the surface, and the survey that answers it already
        // ran. ⚠ conservative on purpose: calling her own house an ancient
        // mystery on stream is a far worse failure than missing a real ruin,
        // so anything she might own, and anywhere someone is standing, is out.
        if (Number(site.builtColumns) > BUILT_GROUND_TOLERANCE
            && !(Number(g.villagers) > 0)
            && !(Number(g.nearbyPlayers) > 0)
            && !this._nearOwnBuild(g.position)) {
            features.push('ruin');
        }

        // REAL DUNGEON CONTENT, straight off the block scan. Each of these blocks
        // occurs in exactly one kind of place, so there is no heuristic here and no
        // false-positive risk of the `ruin` sort - a trial spawner IS a trial chamber.
        // Before the companion learned to report them she could stand in the middle
        // of a chamber and have nothing to say about it at all.
        // (`nb` is already bound above in this function - reuse it.)
        if (Number(nb.trialSpawnerCount) > 0 || nb.trialSpawner != null) features.push('trial_chamber');
        else if (nb.spawner != null) features.push('dungeon');
        if (nb.vault != null) features.push('vault');
        if (nb.sculkShrieker != null) features.push('deep_dark');

        // ⚠ skyVisible is FALSE for a cave, for a dark corner of her own house,
        // and for standing under a tree - three completely different places, and
        // on its own it cannot tell them apart. depth and light are what
        // separate them. both are absent on an older companion jar, in which
        // case this degrades to the y-height guess it used before rather than
        // asserting something it cannot know.
        const y = Number(g.position?.y);
        const depth = Number(g.depthBelowSurface);
        const light = Number(g.lightLevel);
        const deep = Number.isFinite(depth)
            ? depth >= PLACE_UNDERGROUND_DEPTH
            : (Number.isFinite(y) && y < PLACE_UNDERGROUND_Y);
        if (g.skyVisible === false) {
            features.push(deep ? 'underground' : 'sheltered');
            // a hole she is inside, as opposed to a room she built
            if (deep && Number.isFinite(light) && light <= PLACE_DARK_LIGHT) features.push('cave');
        } else if (Number.isFinite(y) && y >= PLACE_HIGH_Y) {
            features.push('high');
        }
        // dark enough for things to spawn in, in the daytime - so it is the
        // place that is dark, not the hour.
        if (Number.isFinite(light) && light <= PLACE_DARK_LIGHT && g.timeOfDay !== 'night') {
            features.push('dark');
        }
        if (Number(g.nearbyHostiles) >= PLACE_HOSTILE_COUNT) features.push('hostile');

        const biome = String(g.biome || '').replace(/^minecraft:/, '').toLowerCase() || null;
        return { biome, shape, features };
    }

    // ⚠ NOT EVERY PATCH OF GRASS - see PLACE_NOTABLE_FEATURES. somewhere earns a
    // slot when something is actually true of it, or when she has never been
    // anywhere like it before. everything else is ground she walked over.
    _observePlace(pos) {
        const now = Date.now();
        if (now - (this._lastPlaceObserveAt || 0) < PLACE_OBSERVE_THROTTLE_MS) return;
        this._lastPlaceObserveAt = now;
        const world = this._worldId();
        const { biome, shape, features } = this._describeHere();

        // ⚠ the biome moment does NOT depend on the place being worth recording.
        // walking out of plains into a mesa is the moment a person looks up,
        // whether or not the mesa has anything in it worth a map pin.
        let firstEver = false;
        if (biome) {
            try { firstEver = this.memory.noteBiome(biome, world); } catch { /* best-effort */ }
            this._noteBiomeChange(biome, firstEver);
        }

        if (!features.some((f) => PLACE_NOTABLE_FEATURES.has(f)) && !firstEver) return;
        let entry = null;
        try {
            entry = this.memory.recordPlace(pos, this.gameState.dimension, { world, biome, features, shape });
        } catch { /* best-effort */ }

        // ⚠ ONLY A GENUINELY NEW PLACE, and only the handful of things a person
        // would actually stop for. `visits === 1` is what makes it a discovery
        // rather than a lap - re-walking her own valley must never re-announce
        // it, which is the shape travelogue narration takes.
        if (!entry || entry.visits !== 1) return;
        const striking = features.filter((f) => PLACE_STRIKING_FEATURES.has(f));
        if (!striking.length) return;
        const now2 = Date.now();
        if (now2 - (this._lastPlaceEventAt || 0) < PLACE_EVENT_GAP_MS) return;
        this._lastPlaceEventAt = now2;
        this.emit('gameEvent', 'place_discovered', {
            features: striking,
            biome: biome ? biome.replace(/_/g, ' ') : null,
            shape,
            // she is looking at it, so she needs to know where "it" is if she
            // wants to say anything about coming back.
            position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
        });
    }

    // is this built ground plausibly HERS? deliberately generous, and it
    // answers TRUE when it cannot tell: a false positive on 'ruin' puts her on
    // stream calling her own homestead an abandoned mystery, which is worse
    // than staying quiet about a real one. the radius is wider than the
    // companion's own 48-block built scan so a house at the edge of the survey
    // still claims the ground the survey found.
    _nearOwnBuild(point) {
        const p = this._point(point);
        if (!p) return true;
        const world = this._worldId();
        const here = this.gameState.dimension;
        try {
            const home = this.memory.getHome(world);
            if (home?.position && this._dimMatches(home.dimension, here)
                && Math.hypot(p.x - home.position.x, p.z - home.position.z) <= OWN_BUILD_RADIUS) return true;
        } catch { /* no home is not evidence either way */ }
        try {
            for (const s of this.memory.listSettlements(world) || []) {
                if (!s || !this._dimMatches(s.dimension, here)) continue;
                if (s.distanceTo(p) <= OWN_BUILD_RADIUS) return true;
            }
        } catch { /* an unreadable registry must not invent a ruin */ return true; }
        return false;
    }

    // COMBINATIONS - the scenes that are more than the sum of their facts.
    //
    // every one of these is already knowable from state she has; none of them
    // was ever ASKED. "3 hostiles" and "health 6" are two numbers in a status
    // block and she reads past both; "two of them on me and i'm at three
    // hearts" is a situation with a shape. this is the cheapest interesting
    // thing in the whole system: no scan, no llm, no new telemetry, just
    // noticing that two true things together mean something neither means
    // alone.
    //
    // ⚠ EVERY RULE MUST CLEAR ITSELF. a noticing that is only ever raised and
    // never withdrawn has her reacting to a creeper that wandered off half a
    // minute ago, which reads worse than never having noticed it at all. so
    // each branch is note-or-clear, never note-or-nothing.
    /**
     * SHE IS STANDING IN REAL DUNGEON CONTENT.
     *
     * Fires once per (world, kind) via the conquest ledger's idempotence, so the
     * fiftieth trial chamber does not read as the first. `_describeHere` already
     * turns these into place features; this is the part that makes them PROGRESSION -
     * "i have finally found one" is a different sentence from "there is one here".
     */
    _observeDungeonContent() {
        const nb = this.gameState.nearby || {};
        const found = [];
        if (Number(nb.trialSpawnerCount) > 0 || nb.trialSpawner != null) found.push(['burtcraft:trial_chamber_found', 'found a trial chamber']);
        else if (nb.spawner != null) found.push(['burtcraft:dungeon_found', 'found a mob spawner dungeon']);
        if (nb.sculkShrieker != null) found.push(['burtcraft:deep_dark_found', 'stood in the deep dark']);
        // ⚠ an ominous vault implies an ordinary one has been seen, but do NOT infer
        // `under_lock_and_key` from proximity: standing next to a vault is not opening
        // it, and that advancement arrives on its own from the real tree.
        for (const [id, label] of found) {
            let result = null;
            try {
                result = this.memory.recordConquest(id, {
                    world: this._worldId(), kind: 'structure', label,
                    position: this.gameState.position, dimension: this.gameState.dimension
                });
            } catch { continue; }
            if (!result?.first) continue;
            this.recentEvents.record(label);
            this.emit('gameEvent', 'first_time', {
                id, kind: 'structure', label,
                total: this.memory.conquestCount(this._worldId())
            });
        }
    }

    _noticeCombinations() {
        const board = this.noticeBoard;
        const g = this.gameState;
        const creatures = Array.isArray(g.nearbyCreatures) ? g.nearbyCreatures : [];
        const hostiles = Number(g.nearbyHostiles) || 0;
        const health = Number.isFinite(Number(g.health)) ? Number(g.health) : 20;
        const hunger = Number.isFinite(Number(g.hunger)) ? Number(g.hunger) : 20;
        const night = /night|midnight|dusk/i.test(String(g.timeOfDay || ''));
        const set = (kind, on, line, salience, tags) =>
            (on ? board.note(kind, line, salience, { tags }) : board.clear(kind));

        // something is at her back. the one thing she cannot see for herself,
        // and the reason the direction data exists at all.
        const behind = creatures.find((c) => c && c.hostile && c.dir === 'behind'
            && Number.isFinite(c.dist) && c.dist <= NOTICE_AT_MY_BACK_DIST);
        set('hostile_behind', !!behind,
            behind ? `a ${String(behind.type || 'mob').replace(/_/g, ' ')} is ${behind.dist} blocks BEHIND me and i cannot see it` : '',
            0.85, ['danger']);

        // cornered: not the count, not the health - the two together.
        set('cornered', hostiles >= 2 && health <= NOTICE_LOW_HEALTH,
            `${hostiles} of them on me and i am down to ${health} of 20 health`, 0.95, ['danger']);

        // outnumbered even at full health is its own scene.
        set('outnumbered', hostiles >= NOTICE_OUTNUMBERED && health > NOTICE_LOW_HEALTH,
            `${hostiles} hostiles around me at once`, 0.75, ['danger']);

        // a boss is a scene on its own terms, whatever else is true.
        const boss = creatures.find((c) => c && c.boss);
        set('boss_here', !!boss,
            boss ? `there is a ${String(boss.type || 'thing').replace(/_/g, ' ')} ${boss.dist} blocks from me` : '',
            1, ['danger', 'rare']);

        // somebody's tame animal is standing in a fight it did not choose.
        const pet = creatures.find((c) => c && c.tame);
        set('pet_in_danger', !!pet && hostiles > 0,
            pet ? `a tame ${String(pet.type || 'animal').replace(/_/g, ' ')} is next to me with ${hostiles} hostile${hostiles === 1 ? '' : 's'} around` : '',
            0.7, ['character']);

        // a mob with a NAME on it. somebody made that on purpose and it wandered
        // into her day.
        const named = creatures.find((c) => c && c.name);
        set('named_creature', !!named,
            named ? `there is a ${String(named.type || 'animal').replace(/_/g, ' ')} here with a name tag on it: "${String(named.name).slice(0, 32)}"` : '',
            0.65, ['character']);

        // hungry AND hunted. either alone is routine; together she cannot fight
        // her way out and cannot walk away either.
        set('starving_and_hunted', hunger <= NOTICE_LOW_HUNGER && hostiles > 0,
            `hunger down to ${hunger} with ${hostiles} hostile${hostiles === 1 ? '' : 's'} on me`, 0.8, ['danger']);

        // ─── PEOPLE ───────────────────────────────────────────────────────────
        // ⚠ every rule below is skipped entirely when the jar cannot report
        // people, rather than evaluated against an empty list. absent is "i
        // cannot tell", and treating it as "nobody is here" would have her
        // confidently ignoring a person stood in front of her.
        if (this._peopleKnown()) {
            const people = this._peopleAround();

            // SOMEBODY IS STANDING THERE LOOKING AT HER. the single most human
            // thing in the list and the one she was completely blind to - the old
            // telemetry could say "1 players" and nothing else, so a person could
            // stand in her face indefinitely and she had no perception of it.
            const watcher = people.find((p) => p.watching && (p.distance ?? 99) <= PERSON_CLOSE * 2);
            set('player_watching', !!watcher,
                watcher ? `${watcher.display || watcher.name} is stood ${Math.round(watcher.distance)} blocks ${watcher.dir === 'ahead' ? 'in front of me' : `to my ${watcher.dir}`}, looking right at me` : '',
                0.8, ['character', 'social']);

            // SOMEBODY IS IN TROUBLE. she can see mobs on them - a real "help me"
            // that nobody had to type. outranks being watched: a person under
            // attack is a thing to DO, not a thing to notice.
            const inTrouble = people.find((p) => p.threats >= PERSON_HELP_THREATS || p.onFire);
            set('player_in_trouble', !!inTrouble,
                inTrouble
                    ? `${inTrouble.display || inTrouble.name} is ${inTrouble.onFire ? 'on fire' : `getting jumped by ${inTrouble.threats} of them`} ${Math.round(inTrouble.distance)} blocks away`
                    : '',
                0.9, ['social', 'help']);

            // SOMEBODY WALKED UP. deliberately not the arrival greeter's job -
            // that one is bread-shaped and busy-gated, so being mid-task meant a
            // person could arrive and produce nothing at all.
            // ⚠ asks _peopleArrivedAt, NOT _peopleSeen. _observePeople runs earlier
            // in this same frame and marks every visible person seen, so the
            // obvious "not in _peopleSeen" test was empty on every single frame and
            // this noticing had never fired once since it was written.
            const arrivedCutoff = Date.now() - ARRIVAL_NOTICE_MS;
            const arrivals = people.filter((p) => (this._peopleArrivedAt.get(p.key) || 0) >= arrivedCutoff);
            set('someone_walked_up', arrivals.length > 0,
                arrivals.length
                    ? `${arrivals.map((p) => p.display || p.name).slice(0, 2).join(' and ')} just turned up ${Math.round(arrivals[0].distance)} blocks off`
                    : '',
                0.7, ['social']);
        }

        // out after dark with nowhere to be. the classic minecraft predicament,
        // and she had no way to notice she was in it.
        let farFromHome = false;
        try {
            // ⚠ world-scoped, like every other getHome call site: a bed on
            // another server is not shelter from what is standing here.
            const home = this.memory.getHome(this._worldId());
            const pos = g.position;
            farFromHome = !home || !pos || !this._dimMatches(home.dimension, g.dimension)
                || Math.hypot(pos.x - home.position.x, pos.z - home.position.z) > NOTICE_FAR_FROM_HOME;
        } catch { /* best-effort - unknown home reads as far */ farFromHome = true; }
        set('dark_and_out', night && farFromHome && hostiles > 0,
            `it is dark, i am a long way from anywhere of mine, and there are ${hostiles} of them out here`,
            0.7, ['danger']);

        // ─── BEAUTY & TIME ────────────────────────────────────────────────────
        // these exist to mark moments, not to create anxiety. they are the lowest
        // salience in the file and that is the point: if something else is more
        // urgent, that's right - but the moment should be clocked, offered, and
        // rejected rather than invisible.
        //
        // ⚠⚠ "LOW" HAS A FLOOR, AND ALL THREE OF THESE USED TO BE UNDER IT.
        // notice_board.top() drops anything below `minWeight`, which is
        // _noticeFloor() = 0.7 - 0.55*sensitivity; at the shipped default of 0.35
        // that is 0.5075. weight only ever DECAYS from salience, so a salience
        // below the floor can never be offered at any age. these were 0.35 / 0.25 /
        // 0.3 - so all three were unreachable in the default configuration, and
        // starry_night in particular had now shipped dead TWICE: once as a
        // contradictory boolean (see below), and then, once that was fixed, as a
        // number the arithmetic layer underneath it threw away anyway.
        // They now clear the floor while staying well under the danger rules
        // (0.7-0.9), which is what "she notices it unless something matters more"
        // actually requires. Any new salience must clear _noticeFloor() at the
        // DEFAULT sensitivity or it is decoration.

        // ⚠ EVERY STRING HERE IS ONE THE COMPANION ACTUALLY SENDS. the phase
        // names are set in ExternalControlServer's skyColorPhase ladder and
        // nowhere else; a rename on that side with no rename here is a branch
        // that silently stops firing, which is the failure this whole block was
        // already bitten by once. absent (an older jar, or the nether/end, which
        // send no phase at all) means "cannot tell" and every branch below is
        // simply skipped - never guessed at.
        const skyPhase = String(g.skyColorPhase || '');
        const secsToSunset = Number.isFinite(g.secondsUntilSunset) ? g.secondsUntilSunset : null;

        // golden hour: the last minute of full daylight, when the sun is low
        // enough to turn everything orange. she has to be able to SEE it - the
        // same light through a cave roof is just a number.
        const inGoldenHour = (skyPhase === 'golden_hour' || skyPhase === 'sunset')
            && g.skyVisible === true;
        set('golden_hour', inGoldenHour,
            inGoldenHour ? `the sun is low enough that everything has gone orange and long-shadowed` : '',
            0.55, ['beauty', 'moment']);

        // starry night: dark sky, no rain, and she can see it. this is peace,
        // not danger.
        // ⚠ THIS SHIPPED DEAD. the first version read `night && ... && !night`
        // (via the `night` const at the top of this function, which is true for
        // exactly the timeOfDay this branch requires), so the condition was a
        // contradiction and the noticing could never once fire. same shape as
        // the 'ruin' feature that sat in two gate sets for months with nothing
        // producing it. the gate is the SKY, not the clock: hostiles are what
        // makes the dark a problem, and being hunted is not stargazing.
        const starryNight = night && g.skyVisible === true
            && g.weather === 'clear' && hostiles === 0 && Number.isFinite(g.moonPhase);
        set('starry_night', starryNight,
            starryNight ? `nothing around me and the sky is clear - the whole dark ceiling is full of stars` : '',
            0.52, ['beauty', 'peace']);

        // first light. the other end of the same day, and the one she is most
        // likely to have EARNED - it means she was out all night.
        const isSunrise = (skyPhase === 'sunrise' || skyPhase === 'predawn') && g.skyVisible === true;
        set('first_light', isSunrise,
            isSunrise ? `the horizon is going pale - the night is finally breaking` : '',
            0.55, ['beauty', 'moment']);
    }

    /**
     * WHO IS AROUND, AND WHAT THAT MEANS SHE SHOULD DO.
     *
     * Three jobs, and they are deliberately different in kind:
     *   - the ROSTER (`_peopleSeen`) is bookkeeping, so "somebody walked up" fires
     *     on arrival rather than every two seconds forever.
     *   - the GAZE is punctuation: somebody comes and stands in her space, she
     *     looks at them. no words, no gate, no llm - the smallest possible
     *     acknowledgement that a person exists, which is the thing whose absence
     *     reads as a bot.
     *   - HELP is an action she takes without being asked, and it is the only one
     *     of the three that can cost her anything, so it is the only one with a
     *     rate limit worth arguing about.
     */
    _observePeople() {
        if (!this._peopleKnown()) return;
        const now = Date.now();
        const people = this._peopleAround();
        const here = new Set(people.map((p) => p.key));

        // forget anybody who left, so coming back later is an arrival again
        for (const key of [...this._peopleSeen.keys()]) {
            if (!here.has(key)) { this._peopleSeen.delete(key); this._peopleArrivedAt.delete(key); }
        }

        for (const person of people) {
            const known = this._peopleSeen.has(person.key);
            this._peopleSeen.set(person.key, now);
            // stamp the arrival for the noticings board, which runs after this and
            // therefore can never work it out for itself. see _peopleArrivedAt.
            if (!known) this._peopleArrivedAt.set(person.key, now);
            if (!known) {
                // the ledger learns about them whether or not she reacts - the
                // same discipline the chat path uses, where the roster is written
                // before any gate.
                try { this._rememberPlayerDurably('sighting', person.name); } catch { /* flavor */ }
                // SHE LOOKS UP WHEN SOMEBODY ARRIVES. only for someone who came
                // properly close: turning to stare at a dot on the horizon is not
                // a greeting, it is unsettling.
                if ((person.distance ?? 99) <= PERSON_CLOSE * 2) {
                    this._lookAtPerson(person.name, { reason: 'arrival' });
                }
            }
            // ...and she keeps looking at whoever is looking at her. rate-limited
            // per person by _lookAtPerson, so this is a glance, not a stare-off.
            if (person.watching && (person.distance ?? 99) <= PERSON_CLOSE) {
                this._lookAtPerson(person.name, { reason: 'watched' });
            }
        }

        this._maybeHelpPerson(people);
    }

    /**
     * SOMEBODY NEARBY IS GETTING HURT AND SHE CAN SEE IT.
     *
     * `defend` is `@hero` - kill the hostiles that are here - which is precisely
     * the right help and costs her nothing she wasn't already carrying. No LLM in
     * the path: a person with two zombies on them has about four seconds, and a
     * round trip to decide whether to care spends most of it.
     *
     * ⚠ SHE MUST NOT RESCUE HERSELF INTO A GRAVE. the whole thing stands down when
     * she is in worse shape than the person she'd be helping - heroism that ends
     * with her dead on stream helps nobody, and the defense chain is already
     * fighting for her own life at that point.
     */
    _maybeHelpPerson(people) {
        if (!this.enabled || !this.autonomous || this.manualControl) return false;
        if (this.gameState.multiplayer !== true) return false;
        const now = Date.now();
        if (now - (this._lastHelpAt || 0) < HELP_GAP_MS) return false;
        // her own survival outranks somebody else's. `_urgentSafetyBehavior` owns
        // this range and would be preempting her anyway.
        const health = Number(this.gameState.health);
        if (Number.isFinite(health) && health <= 10) return false;
        // ⚠ never yank her out of somebody's REQUESTED job to do unrequested
        // help. a person who asked for a wheat farm outranks a person who did not
        // ask for anything - and `defend` would replace the task outright.
        if (this.activeGoal && this.activeGoal.source !== 'autonomous') return false;

        const victim = people
            .filter((p) => (p.distance ?? 99) <= PERSON_CLOSE * 3)
            .filter((p) => p.threats >= PERSON_HELP_THREATS)
            .filter((p) => now - (this._helpAt?.get?.(p.key) || 0) >= HELP_PER_PERSON_GAP_MS)
            .sort((a, b) => b.threats - a.threats)[0];
        if (!victim) return false;

        if (!this._helpAt) this._helpAt = new Map();
        this._helpAt.set(victim.key, now);
        this._lastHelpAt = now;
        this._lookAtPerson(victim.name, { reason: 'helping' });
        // she does NOT write the line - the event goes out and her brain says
        // whatever it wants about it, per the no-canned-responses rule.
        this.emit('gameEvent', 'helping_player', {
            player: victim.display || victim.name,
            threats: victim.threats,
            onFire: victim.onFire,
            distance: Math.round(victim.distance ?? 0)
        });
        // ⚠ `_safeExecute(action, params, say, source)` takes a bare STRING here,
        // unlike `executeAction`, whose fourth argument is an opts OBJECT. passing
        // `{source:'social'}` was silently accepted and rode all the way into the
        // goal record as an object, where every `source === 'autonomous'` test in
        // the file compares against it and gets a nonsense answer.
        this._safeExecute('defend', {}, null, 'social');
        // ...and it goes in the durable record, not just the moment.
        //
        // ⚠ `notePlayer` was a WRITER NOBODY CALLED sitting next to a LIVE READER -
        // `playersContext` renders `notes[last]` straight into her prompt, so she had
        // a per-person memory field it was structurally impossible to fill (live save:
        // 16 people, 348 chats, 0 notes). This is the `visited`/`claims` bug in the
        // opposite direction: there, a written ledger was never restored; here, a read
        // ledger was never written. Diff writers against readers BOTH ways.
        //
        // Deduped by exact text inside `notePlayer` and capped at 3, so a phrase that
        // recurs stays ONE note - which is what makes "i've pulled mobs off them"
        // durable rather than a rolling log that evicts everything else.
        this._notePlayer(victim.name, 'i have pulled mobs off them');
        return true;
    }

    /**
     * The one durable-note writer. Wrapped rather than called raw so every caller
     * gets the same self-exclusion and world scoping the rest of the player path has,
     * and so a memory that predates `notePlayer` cannot throw on the reflex path.
     */
    _notePlayer(name, note) {
        const who = String(name || '').trim();
        if (!who || !note) return null;
        if (this.gameUsername && who.toLowerCase() === String(this.gameUsername).toLowerCase()) return null;
        try { return this.memory.notePlayer?.(who, note, this._worldId()) || null; } catch { return null; }
    }

    /**
     * CAN SHE HAND THIS OVER, AND HOW MANY?
     *
     * Returns 0 for anything not on the allow-list, and for anything that would
     * take her below its floor. The two are different refusals and both matter:
     * the first is "that is not mine to give", the second is "that one is mine".
     */
    /**
     * What somebody actually meant by "a loaf" / "some cobble" / "a pick".
     *
     * Deliberately small: GIFT_ALLOW is the real gate, so an unrecognised noun
     * costs nothing (it yields no item, the rule falls through, and the ask
     * becomes a freeform one she answers in words). This exists only so the
     * everyday words for the handful of things she WILL hand over resolve to
     * their item ids.
     */
    _giftItemName(raw) {
        const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/s$/, '');
        if (!s) return null;
        const alias = {
            loaf: 'bread', brea: 'bread', food: 'bread',
            torche: 'torch', light: 'torch',
            wood: 'oak_log', log: 'oak_log', plank: 'oak_log',
            cobble: 'cobblestone', stone: 'cobblestone', rock: 'cobblestone',
            steak: 'cooked_beef', beef: 'cooked_beef', meat: 'cooked_beef',
            iron: 'iron_ingot', ingot: 'iron_ingot',
            pick: 'stone_pickaxe', pickaxe: 'stone_pickaxe',
            sword: 'stone_sword', blade: 'stone_sword'
        };
        const name = alias[s] || s;
        // ⚠ the allow-list is consulted by KEY here, not by spare count - "is this
        // a thing she gives at all" is a different question from "has she got one
        // to spare", and conflating them would turn "no, that's mine" into
        // "i don't know what that is".
        return Object.prototype.hasOwnProperty.call(GIFT_ALLOW, name) ? name : null;
    }

    _giftableAmount(item, asked = 1) {
        const rule = GIFT_ALLOW[String(item || '').toLowerCase()];
        if (!rule) return 0;
        const carried = this._itemExact(item);
        const spare = carried - rule.keep;
        if (spare <= 0) return 0;
        return Math.max(0, Math.min(spare, rule.max, Math.max(1, Math.round(asked))));
    }

    // hand her the shortlist. ⚠ THIS DOES NOT SPEND THE NOTICINGS - burnt.js
    // owns the speech gate and may still refuse, so it calls acceptNoticings()
    // back once it has actually committed. offering and spending being the same
    // act is how a perception gets eaten by a gate that then says no.
    _noticeTick() {
        if (!this.config.noticeEnabled) return;
        if (!this.enabled || !this.gameConnected || this.manualControl) return;
        if (this._stateIsStale()) return;
        const now = Date.now();
        if (now - (this._lastNoticeOfferAt || 0) < this._noticeGapMs()) return;
        const items = this.noticeBoard.top(NOTICE_OFFER_MAX, { now, minWeight: this._noticeFloor() });
        if (!items.length) return;
        this._lastNoticeOfferAt = now;
        this.emit('gameEvent', 'noticings', {
            items: items.map((n) => ({ kind: n.kind, line: n.line, tags: n.tags })),
            busy: !!(this.currentAction || this.activeGoal),
            task: this.currentTask || null
        });
    }

    // burnt.js committed to a turn about these, so they leave the board.
    // anything it did not take stays and can win a later opening.
    acceptNoticings(kinds = []) {
        const taken = [];
        for (const k of kinds) if (this.noticeBoard.clear(k)) taken.push(k);
        return { accepted: taken };
    }

    // sensitivity is ONE operator knob driving both halves, because they only
    // make sense together: a low floor with a long gap just delays the same
    // noise, and a high floor with a short gap is silent either way. 0 is as
    // quiet as it goes without switching off, 1 is as talkative as it gets.
    _noticeFloor() {
        const s = Math.min(1, Math.max(0, Number(this.config.noticeSensitivity) || 0));
        return NOTICE_FLOOR_MAX - (NOTICE_FLOOR_MAX - NOTICE_FLOOR_MIN) * s;
    }

    _noticeGapMs() {
        const s = Math.min(1, Math.max(0, Number(this.config.noticeSensitivity) || 0));
        return Math.round(NOTICE_GAP_MAX_MS - (NOTICE_GAP_MAX_MS - NOTICE_GAP_MIN_MS) * s);
    }

    // THE BESTIARY, and the one interrupt it earns. everything else she knows
    // about a mob is transient - a count in her prompt, a threat gate, the
    // defense chain - and none of it survives a restart, so without this the
    // four hundredth enderman and the first one look identical to her.
    //
    // the split here is deliberate: DANGER is continuous and lives in the
    // context block (distance, direction, whether it has decided about her), so
    // she reacts to it on her own turns. NOVELTY is an interrupt, and it is rare
    // by construction - a set cannot fire twice for the same kind.
    _observeCreatures() {
        const types = this.gameState.nearbyCreatureTypes;
        // ⚠ ABSENT IS "THIS JAR CANNOT TELL", NEVER "nothing is around". an older
        // companion sends neither field and must degrade to the old behaviour
        // rather than teaching the bestiary that the world is empty.
        if (!Array.isArray(types) || !types.length) return;
        const world = this._worldId();
        // unconditional, like the biome moment: a kind she has stood near counts
        // towards what she has met whether or not it is worth a word.
        let fresh = [];
        try { fresh = this.memory.noteCreatures(types, world); } catch { /* best-effort */ }
        if (!fresh.length) return;
        // only the ones the companion judged worth remarking on - it owns that
        // verdict so there is no second mundane-list here to drift against.
        const creatures = Array.isArray(this.gameState.nearbyCreatures) ? this.gameState.nearbyCreatures : [];
        const notable = new Map();
        for (const c of creatures) {
            if (c && c.notable && c.type && !notable.has(c.type)) notable.set(c.type, c);
        }
        // ⚠ ONE PER POLL, hardest on the case that motivates the cap: a brand new
        // world's first night puts several firsts in the bubble at once, and
        // three "i have never seen one of those" in six seconds is worth less
        // than one. the rest stay recorded and simply do not get announced.
        const pick = fresh.map((t) => notable.get(t)).find(Boolean);
        if (!pick) return;
        const now = Date.now();
        if (now - (this._lastCreatureEventAt || 0) < CREATURE_EVENT_GAP_MS) return;
        this._lastCreatureEventAt = now;
        const label = String(pick.type || '').replace(/_/g, ' ');
        this.recentEvents.record(`saw my first ${label} on this world`);
        this.emit('gameEvent', 'creature_spotted', {
            type: label,
            dist: Number.isFinite(pick.dist) ? pick.dist : null,
            dir: pick.dir || null,
            vert: pick.vert || null,
            hostile: pick.hostile === true,
            aggro: pick.aggro === true,
            baby: pick.baby === true,
            tame: pick.tame === true,
            name: pick.name || null,
            // the number that makes a first landing: how much of the bestiary
            // this one completes, the same way biome count does for country.
            kinds: (() => {
                try { return this.memory.creatureCount(world); } catch { return 0; }
            })()
        });
    }

    // she has crossed into somewhere that looks different. ⚠ THE FIRST READING
    // OF A SESSION IS NOT A CHANGE - she did not walk anywhere, the telemetry
    // just started, and announcing "i've arrived in plains" on every connect is
    // the kind of thing that makes her read as a bot.
    _noteBiomeChange(biome, firstEver) {
        const previous = this._lastBiome || null;
        if (previous === biome) return;
        this._lastBiome = biome;
        if (!previous) return;
        const now = Date.now();
        if (now - (this._lastBiomeEventAt || 0) < BIOME_EVENT_GAP_MS) return;
        this._lastBiomeEventAt = now;
        const pretty = biome.replace(/_/g, ' ');
        this.recentEvents.record(firstEver ? `first time in ${pretty}` : `walked into ${pretty}`);
        this.emit('gameEvent', 'biome_changed', {
            biome: pretty,
            previous: previous.replace(/_/g, ' '),
            first: !!firstEver,
            // how much of this world she has actually walked. gives "eleventh
            // biome on this server" its meaning without her inventing a number.
            seen: (() => { try { return this.memory.biomeCount(this._worldId()); } catch { return 0; } })()
        });
    }

    // ---- what is in her chests ----------------------------------------------
    // THE PANTRY LEDGER'S ONE WRITER. the companion publishes a container the
    // moment it reads one (opening it, or a `peek`), and every entry names its
    // own block, so this is a straight record - no merge radius, no strike-by-id,
    // none of the machinery a field needs.
    //
    // ⚠ ABSENCE MEANS "THIS BUILD CANNOT TELL ME", NEVER "THE CHESTS ARE EMPTY".
    // on an older companion jar `containers` never arrives at all, and reading
    // that as an empty pantry would be strictly worse than today: she would have
    // a confident wrong answer instead of no answer. `_containersKnown()` is the
    // one gate every consumer asks first, and with it false every decision below
    // falls back to exactly the carried-only behaviour that shipped before this.
    // (the same trap this file already documents for `<crop>Ripe`.)
    _observeContainers(partial) {
        // the FIELD arriving is what proves the jar can answer, so read it off the
        // packet, not off the merged gameState - a heartbeat that merely carried
        // the previous snapshot forward would otherwise look like a capable jar.
        if (partial?.containers === undefined) return;
        this._sawContainersField = true;
        const list = Array.isArray(partial.containers) ? partial.containers : [];
        if (!list.length) return;
        const world = this._worldId();
        // a chest at one of her own buildings outranks one she opened in a ravine
        // when the ledger has to drop something. resolved once per packet, and
        // per-CONTAINER rather than per-body: the tag describes where the block
        // stands, not where she was standing when she read it.
        let settlements = [];
        try { settlements = this.memory.listSettlements(world) || []; } catch { /* none yet */ }
        const settlementFor = (x, z) => settlements.find((s) => s?.anchor &&
            Math.hypot(s.anchor.x - x, s.anchor.z - z) <= TOASTER_NEAR_RADIUS)?.id || null;
        for (const raw of list.slice(0, 32)) {
            if (!raw || typeof raw !== 'object') continue;
            try {
                this.memory.recordContainer?.({
                    ...raw, world,
                    settlementId: raw.settlementId || settlementFor(Number(raw.x), Number(raw.z))
                });
            } catch { /* best-effort */ }
        }
    }

    // can this companion answer "what is in my chests" at all? everything that
    // reads the pantry asks this first, and a false means the old behaviour.
    _containersKnown() {
        return this._sawContainersField === true;
    }

    // the pantry query every decision uses: how many of this item she owns and is
    // NOT carrying, near enough to be worth walking to, and read recently enough
    // to still be a fact rather than a memory.
    //
    // ⚠ 0 IS ALSO WHAT AN UNREADABLE JAR RETURNS, on purpose. a caller may only
    // ever use this to talk her out of work, never into skipping food she needs -
    // so "i cannot tell" and "there is none" both have to mean "carry on as
    // before".
    _storedCount(item, { radius = PANTRY_TRIP_MAX, maxAgeMs = PANTRY_FRESH_MS } = {}) {
        if (!this._containersKnown()) return 0;
        const p = this._point(this.gameState.position);
        try {
            return this.memory.storedCount?.(item, {
                world: this._worldId(),
                dimension: this.gameState.dimension,
                near: p, radius: p ? radius : null, maxAgeMs
            }) || 0;
        } catch { return 0; }
    }

    // carried + stored. THE PANTRY NUMBER, and the only one that may answer "do i
    // need to go and make more of this".
    _pantryCount(item, opts = {}) {
        return this._inventoryCount(item) + this._storedCount(item, opts);
    }

    // bread is counted with a word boundary everywhere else in this file's food
    // maths, so keep the two halves consistent rather than mixing a substring
    // count with an exact ledger key.
    _pantryBread(opts = {}) {
        return this._breadCount() + this._storedCount('bread', opts);
    }

    // GO AND GET IT OUT OF THE CHEST INSTEAD OF MAKING MORE OF IT.
    //
    // returns a step descriptor the caller hands to _safeExecute, or null when
    // there is no honest shopping trip to make. three answers, in order:
    //   - a fresh, stocked pantry within arm's reach -> withdraw
    //   - the same, but a walk away -> move to it first (the shape _foodRunStep
    //     already uses for a remembered field)
    //   - a pantry she has not looked in for a while and is standing next to ->
    //     PEEK, because "my reading went stale" is a reason to look, not a reason
    //     to farm. this is what keeps the ledger true without a poller.
    // null for everything else, and null means the caller does its normal job.
    //
    // ⚠⚠ THE FRESHNESS GATE ON THE WITHDRAW BRANCH IS A HANG GUARD, NOT A TIDINESS
    // RULE. `PickupFromContainerTask.isFinished` is a count check with NO give-up:
    // ask for more than the chest actually holds and she empties it and then loops
    // on "SHOULD NOT HAPPEN! No valid items detected." forever. java clamps the
    // request to its own cache, which closes this for a reading taken just now -
    // but a STALE cache walks straight into it, because somebody may have emptied
    // the chest since she last looked. so a withdraw may only ever be sized from a
    // reading inside PANTRY_FRESH_MS, and an expired one becomes a `peek` (which
    // refreshes the number) rather than a guess. everywhere else acting on stale
    // stock merely wastes a trip; here it freezes her.
    //
    // ⚠ `want` IS AN INCREMENT - HOW MANY MORE SHE SHOULD END UP WITH - not a hold
    // target and not a total. the companion dispatches `held + take` itself, so
    // pre-adding her carried count here would double it. (every caller passes a
    // shortfall, e.g. BREAD_COMFORT - carried, which is already the increment.)
    _pantryStep(item, want, { say = null, radius = PANTRY_TRIP_MAX } = {}) {
        if (!this._containersKnown()) return null;
        const p = this._point(this.gameState.position);
        if (!p) return null;
        const need = Math.max(1, Math.round(want));
        const world = this._worldId();
        const dimension = this.gameState.dimension;
        const label = String(item).replace(/_/g, ' ');
        let shelf = null;
        try {
            shelf = this.memory.nearestContainerWith?.(item, p, {
                world, dimension, radius, maxAgeMs: PANTRY_FRESH_MS
            });
        } catch { return null; }
        const onShelf = Number(shelf?.items?.[item]) || 0;
        if (shelf && onShelf >= need) {
            if (shelf.distance > PANTRY_NEAR_RADIUS) {
                return {
                    action: 'move',
                    params: { x: shelf.x, y: shelf.y, z: shelf.z, target: 'my own chest' },
                    say: say || `i already have ${onShelf} ${label} in a chest ${shelf.distance} blocks away. going to go and take my own stuff`
                };
            }
            return {
                action: 'withdraw',
                // ⚠ clamped to the reading, belt and braces with java's own clamp:
                // asking for more than the chest holds is the no-give-up loop
                // described above. `shelf` came back from a maxAgeMs-filtered
                // query, so this number is fresh by construction.
                params: { target: item, amount: Math.min(need, onShelf), x: shelf.x, y: shelf.y, z: shelf.z },
                say: say || `there is ${onShelf} ${label} in that chest. taking ${Math.min(need, onShelf)} instead of making more like an idiot`
            };
        }
        // nothing fresh says she has it. is there a chest right here whose reading
        // has simply expired? then LOOK - a stale belief is not evidence either way,
        // and the whole point is that she stops guessing about her own shelves.
        return this._stalePantryPeek(`i cannot remember what is actually in this chest. looking before i go and make more ${label}`);
    }

    // LOOK IN THE CHEST SHE IS STANDING NEXT TO, because the reading expired.
    //
    // lifted out of `_pantryStep` so the armory can ask the same question from the
    // other side: `_pantryStep` peeks when it cannot find stock it wants to TAKE,
    // the reserve peeks before deciding whether to make MORE. same evidence
    // problem, same answer, and one implementation means the freshness rule cannot
    // drift between the two. oldest reading first - the one most likely to be wrong.
    _stalePantryPeek(say = null) {
        if (!this._containersKnown()) return null;
        const p = this._point(this.gameState.position);
        if (!p) return null;
        let stale = null;
        try {
            stale = this.memory.listContainers?.({
                world: this._worldId(), dimension: this.gameState.dimension,
                near: p, radius: PANTRY_NEAR_RADIUS
            })
                ?.filter((c) => Date.now() - (c.readAt || 0) > PANTRY_FRESH_MS)
                ?.sort((a, b) => (a.readAt || 0) - (b.readAt || 0))?.[0] || null;
        } catch { stale = null; }
        if (!stale) return null;
        return {
            action: 'peek',
            params: { x: stale.x, y: stale.y, z: stale.z, target: 'chest' },
            say: say || 'i cannot remember what is actually in this chest. having a look'
        };
    }

    // everything edible she owns and is not carrying, in altoclef's own unit
    // (nutrition x count - see FOOD_RESERVE_UNITS), so a stocked pantry can be
    // compared with a forage target without either side changing units.
    // ⚠ unknown items score the same deliberately LOW fallback as `_foodScore`,
    // so a chest full of cobblestone can never read as a full larder.
    _storedFoodTotals() {
        if (!this._containersKnown()) return {};
        const p = this._point(this.gameState.position);
        try {
            const totals = this.memory.storedTotals?.({
                world: this._worldId(), dimension: this.gameState.dimension,
                near: p, radius: p ? PANTRY_TRIP_MAX : null, maxAgeMs: PANTRY_FRESH_MS
            }) || {};
            const food = {};
            for (const [name, count] of Object.entries(totals)) {
                if (FOOD_NUTRITION[name] === undefined) continue;
                food[name] = count;
            }
            return food;
        } catch { return {}; }
    }

    _storedFoodScore() {
        let total = 0;
        for (const [name, count] of Object.entries(this._storedFoodTotals())) {
            total += (FOOD_NUTRITION[name] ?? FOOD_NUTRITION_FALLBACK) * count;
        }
        return total;
    }

    // TAKE FOOD OUT OF HER OWN CHEST instead of going out for more. picks the
    // densest thing on the shelf (fewest inventory slots for the same score) and
    // asks for exactly enough to close the gap, then hands the trip to
    // `_pantryStep` so the walk/withdraw/peek decision stays in one place.
    _pantryFoodStep() {
        const stored = this._storedFoodTotals();
        const best = Object.entries(stored)
            .filter(([, count]) => count > 0)
            .sort((a, b) => (FOOD_NUTRITION[b[0]] ?? 0) - (FOOD_NUTRITION[a[0]] ?? 0))[0];
        if (!best) return null;
        const [item] = best;
        const per = FOOD_NUTRITION[item] ?? FOOD_NUTRITION_FALLBACK;
        const gap = Math.max(0, FOOD_RESERVE_UNITS - this._foodScore());
        if (!gap) return null;
        return this._pantryStep(item, Math.ceil(gap / per), {
            say: `the pantry is not embarrassing, it is just not in my pockets. going to go and get my own ${item.replace(/_/g, ' ')}`
        });
    }

    // the tag an ore run carries so its failure lands on the seam it was FOR.
    // ⚠ THE SPOT'S ID, NEVER ITS COORDINATES - `recordOreSpot` MOVES `position`
    // onto a bigger reading of the same seam, so a coordinate tag issued before
    // that merge matches nothing afterwards and the strike vanishes in silence.
    // this is the food ledger's documented bug, on a different ledger.
    _oreSpotTag(spot) {
        return spot?.id ? { _oreSpot: spot.id } : {};
    }

    // SHE WENT TO THE SEAM AND CAME BACK WITH NOTHING.
    //
    // ⚠ it must hang off EVERY terminal path, not just the error branch: a stalled
    // mine ends via the watchdog, and altoclef reports a CANCELLED task as
    // `success`, so an error-only witness is unreachable on the one path that
    // actually happens. wired into _handleResponse's abortedByRecovery branch, its
    // failure branch, and _expirePendingAction.
    //
    // a failed WALK says nothing about what is in the ground - the pathing
    // recoveries own reachability - so only a dig that came back empty may strike.
    _noteOreRunFailed(pending) {
        if (!['get', 'collect', 'mine'].includes(pending?.action)) return;
        const tag = pending?.params?._oreSpot;
        if (!tag) return;
        try {
            const spot = this.memory.getOreSpotById?.(tag);
            const label = ORE_SPOT_KINDS[spot?.kind]?.label || spot?.kind || 'ore';
            const verdict = this.memory.noteOreSpotEmptyById?.(tag);
            if (verdict === 'forgotten') {
                this.recentEvents.record(`crossed that ${label} seam off - kept going back to nothing`);
            }
        } catch { /* best-effort */ }
    }

    // THE SECOND WITNESS, and the one that works on the jar she is running RIGHT
    // NOW. the ripeness reading above is the honest fix, but it needs a rebuilt
    // companion - and an older jar sends no ripeness at all, so nothing would ever
    // mark a field bare and the loop would survive the fix until the next deploy.
    //
    // a crop run that FAILED while she was standing in a remembered spot is the
    // same fact arriving by a different road: she went, she asked for the crop,
    // she came back with nothing. good enough to start the regrow clock, and it
    // needs no new telemetry whatsoever.
    // ⚠ IT STRIKES THE SPOT SHE WAS SENT TO, NOT THE GROUND SHE HAPPENS TO BE ON.
    //
    // asking "is there a remembered spot near me?" here was wrong in both
    // directions and the miss was fatal. too tight, and the fix didn't fire: a
    // stalled run is aborted anywhere inside LOOP_CONFINE_RADIUS (24), while
    // "nothing here" from the block scan is only a claim about 9 - so ~86% of that
    // disc missed and she went straight back to the same field. too loose, and any
    // `get wheat` that ended badly near her homestead - one a viewer asked for, one
    // a creeper interrupted - was counted as evidence against her own field.
    //
    // the run itself knows. `_foodRunStep` tags what it dispatched, so a strike can
    // only ever land on the exact spot the trip was for. an untagged run (a blind
    // hunt, someone else's request) is evidence about nothing and says nothing.
    _noteFoodRunFailed(pending) {
        // a failed WALK is about reachability, not emptiness - the pathing
        // recoveries own that. only a harvest that came back with nothing is
        // evidence about what is growing there.
        if (!['get', 'collect', 'hunt'].includes(pending?.action)) return;
        const tag = pending?.params?._foodSpot;
        if (!tag) return;
        try {
            const spot = this.memory.getFoodSpotById(tag);
            const kind = spot?.kind || 'food';
            const verdict = this.memory.noteFoodSpotEmptyById(tag);
            if (verdict === 'forgotten') {
                this.recentEvents.record(`crossed that ${kind} spot off - three trips, nothing to show`);
            }
        } catch { /* best-effort */ }
    }

    // the tag a food run carries so its failure can be attributed to the spot it was
    // FOR. ⚠ THE SPOT'S ID, NEVER ITS COORDINATES: `recordFoodSpot` moves `position`
    // when it sees a bigger part of the same field, so a coordinate tag issued
    // before such a merge silently matched nothing afterwards - the quiet version of
    // the exact loop this exists to close. a flat string, so it survives every place
    // params get stringified and is inert to the bridge (which only reads named
    // fields) and to _describeTask (which only reads `target`).
    _foodSpotTag(spot) {
        return spot?.id ? { _foodSpot: spot.id } : {};
    }

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
        // THE RATE LIMIT IS SPENT BY ASKING, NOT BY THE ANSWER. state arrives
        // every ~2s, so if an "ignore" left the slot open she would re-ask about
        // the same person twelve times a minute until somebody said yes.
        this._lastArrivalAt = now;
        this._rememberPlayerDurably('sighting', who);
        this._offerBreadOpportunity(who, nearby, this._breadCount(), now);
        return true;
    }

    /**
     * ASK HER WHAT THIS IS.
     *
     * The gesture used to be a coin flip in this file, which made "does this
     * person get bread" a property of Math.random rather than of who they are.
     * She knows things the dice do not: whether they have been here for days,
     * whether they ever said anything to her, whether she already owes them
     * something, whether she is halfway through a wall.
     *
     * So the tool states the OPPORTUNITY and her brain returns one of five
     * verbs. ⚠ WHAT SHE SAYS IS STILL NEVER DECIDED HERE - the gesture goes out
     * as an event and the words are written by her, exactly as before.
     */
    _offerBreadOpportunity(who, nearby, loaves, now = Date.now()) {
        // one at a time. a second arrival while the first is still waiting would
        // race two gestures at one person.
        if (this._breadOpportunity) this._closeBreadOpportunity();
        const opp = { player: who, nearby: [...nearby], loaves, at: now, decided: false, timer: null };
        this._breadOpportunity = opp;
        // ⚠ THE FALLBACK IS A TIMER, NOT AN ERROR HANDLER. the decision may never
        // come back AT ALL - burnt.js only listens in minecraft mode, the handler
        // can throw, the api can hang - and from in here every one of those looks
        // identical: silence. so the coin flip is already scheduled before anyone
        // is asked, and a real answer merely gets in first. a failed decision
        // costs the DECISION, never the gesture.
        opp.timer = setTimeout(() => {
            if (this._breadOpportunity !== opp || opp.decided) return;
            this.log('debug', `no bread decision for ${who} in time - falling back to the coin flip`);
            try { this.actOnBreadOpportunity(who, null); } catch (err) {
                this.log('warn', `bread fallback failed: ${err.message}`);
            }
        }, BREAD_DECISION_TIMEOUT_MS);
        if (typeof opp.timer.unref === 'function') opp.timer.unref();
        this.emit('gameEvent', 'bread_opportunity', this._breadOpportunityFacts(who, nearby, loaves));
        return true;
    }

    // everything she could reasonably weigh, and nothing she cannot know.
    _breadOpportunityFacts(who, nearby, loaves) {
        let known = null;
        try {
            const p = this.memory.getPlayer?.(who);
            if (p) {
                const open = (p.requests || []).filter((r) => !r.done).slice(-1)[0];
                known = {
                    name: p.name || who,
                    knownForDays: Math.max(0, Math.round((Date.now() - (p.firstMet || Date.now())) / 86400000)),
                    lastSeenMinsAgo: Math.max(0, Math.round((Date.now() - (p.lastSeen || Date.now())) / 60000)),
                    chats: p.chats || 0,
                    loavesGiven: p.gifts || 0,
                    lastSaid: p.lastSaid || null,
                    stillWants: open?.text || null
                };
            }
        } catch { /* a stranger is a perfectly good answer */ }
        const homeDist = this._homeDistance();
        return {
            player: who,
            loaves,
            keepBack: BREAD_KEEP_BACK,
            // she will hand bread out down to the carry reserve and never past it.
            // giving away her last loaf is generosity that ends with her starving.
            canSpare: loaves > BREAD_KEEP_BACK,
            known,
            // ⚠ THERE IS NO PER-PLAYER DISTANCE IN THE TELEMETRY. the companion
            // sends a NAME LIST off a ~32-block sweep, so the only honest thing to
            // say is that they are inside it. inventing a number here would be a
            // fact she cannot have.
            proximity: 'inside the ~32-block nearby sweep - close enough to see her',
            playersNearby: Number(this.gameState.nearbyPlayers) || nearby.length,
            alsoNearby: nearby.filter((n) => n !== who).slice(0, 4),
            busy: !!(this.currentAction || this.activeGoal || this.pendingActions?.size),
            task: this.currentTask || null,
            homeName: this._home()?.name || null,
            homeDistance: Number.isFinite(homeDist) ? Math.round(homeDist) : null,
            atHome: Number.isFinite(homeDist) && homeDist <= HOMESTEAD_NEAR_HOME,
            options: [...BREAD_DECISIONS]
        };
    }

    _closeBreadOpportunity() {
        const opp = this._breadOpportunity;
        if (!opp) return null;
        if (opp.timer) clearTimeout(opp.timer);
        opp.decided = true;
        this._breadOpportunity = null;
        return opp;
    }

    // TODAY'S BEHAVIOUR, KEPT VERBATIM as the floor under the decision. with bread
    // to spare she usually makes it about bread; otherwise she just talks, and
    // offering rather than throwing keeps her from being a vending machine.
    _coinFlipBreadGesture(loaves = this._breadCount()) {
        if (loaves > BREAD_KEEP_BACK && Math.random() < ARRIVAL_BREAD_SHARE) {
            return Math.random() < 0.6 ? 'give' : 'offer';
        }
        return 'talk';
    }

    /**
     * HER ANSWER, ACTED ON.
     *
     * `decision` is one of BREAD_DECISIONS, or `{decision, reason}`. Anything
     * else - a sentence, a blank, a hallucinated verb, a null from a dead api -
     * is not a decision and falls back to the coin flip. A `give` she cannot
     * afford becomes a `talk`, because the carry reserve is not negotiable.
     */
    actOnBreadOpportunity(player, decision = null) {
        const who = String(player || '').trim();
        const opp = this._breadOpportunity;
        // an answer about a DIFFERENT arrival, or one that turned up after the
        // fallback already fired, is not an answer to anything.
        if (!opp || opp.decided) return { acted: false, reason: 'that bread moment has already passed' };
        if (who && opp.player.toLowerCase() !== who.toLowerCase()) {
            return { acted: false, reason: `she is not looking at ${who} right now` };
        }
        this._closeBreadOpportunity();
        const target = opp.player;

        const raw = typeof decision === 'string'
            ? decision
            : String(decision?.decision ?? decision?.gesture ?? '');
        const want = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
        const understood = BREAD_DECISIONS.has(want);
        let gesture = understood ? want : this._coinFlipBreadGesture(opp.loaves);
        // the reserve overrules her: she hands out bread down to BREAD_KEEP_BACK
        // and never past it, whoever asked and however much she likes them.
        const loaves = this._breadCount();
        if ((gesture === 'give' || gesture === 'approach_and_give' || gesture === 'offer') && loaves <= BREAD_KEEP_BACK) {
            gesture = 'talk';
        }
        if (!understood) this.log('debug', `bread decision for ${target} was not one of the five - coin flip picked ${gesture}`);

        if (gesture === 'ignore') {
            // a real answer, and the quietest one. no gesture, no event, no words:
            // most people who wander past a person get nothing, and that is normal.
            this.recentEvents.record(`${target} walked up and she let it pass`);
            return { acted: true, gesture, decided: understood };
        }

        let approached = false;
        if (gesture === 'approach_and_give') {
            approached = this._approachAndGive(target, opp);
            gesture = 'give';   // for the words: what lands is a handoff either way
        } else if (gesture === 'give') {
            // a real throw - the loaf leaves her inventory and lands at their feet
            this._safeExecute('give', { player: target, item: 'bread', amount: 1 }, null);
        }
        if (gesture === 'give') this._rememberPlayerDurably('gift', target, 'bread');
        this.recentEvents.record(`${target} walked up${gesture === 'give' ? ' and got a loaf' : ''}`);
        // ⚠ THE WORDS ARE STILL NOT DECIDED HERE. this is the same event the coin
        // flip used to emit; her brain writes the line off it, or writes nothing.
        this.emit('gameEvent', 'player_approached', {
            player: target,
            gesture,
            loaves: opp.loaves,
            approached,
            decided: understood,
            reason: (typeof decision === 'object' && decision?.reason)
                ? String(decision.reason).slice(0, 160) : null,
            alsoNearby: opp.nearby.filter((n) => n !== target).slice(0, 4)
        });
        return { acted: true, gesture, approached, decided: understood };
    }

    /**
     * WALK OVER, THEN HAND IT TO THEM.
     *
     * `follow` is the only "get to that person" the game offers - a player has
     * no coordinate she can walk to - so the approach is a bounded follow and
     * then the real `@give`. Both bounds matter: a timeout, because a follow
     * that cannot reach them never fails on its own, and a displacement cap,
     * because a follow chasing somebody who is sprinting away turns a handoff
     * into a cross-map trek.
     *
     * ⚠ dispatched through _safeExecute so the stalled-action backoff, the
     * by-place stuck streak and the failure blacklist all supervise it.
     */
    _approachAndGive(who, opp) {
        const from = this._point(this.gameState.position);
        const walking = this._safeExecute('follow', { target: who }, null);
        if (!walking) {
            // the walk was refused (blacklisted after a stall, or the busy gate).
            // that costs the WALK, not the loaf - throw it from where she stands.
            this.log('debug', `could not walk over to ${who}; throwing the loaf from here`);
            this._safeExecute('give', { player: who, item: 'bread', amount: 1 }, null);
            return false;
        }
        const timer = setTimeout(() => {
            (async () => {
                // ⚠ NEVER INTERRUPT LIVE WORK. twenty seconds is long enough for a
                // viewer request or her own brain to have taken the task slot, and
                // stopping THAT to hand out bread is precisely what every guard in
                // _maybeGreetArrival exists to prevent.
                const ours = !this.activeGoal
                    || (this.activeGoal.action === 'follow' && this.activeGoal.source === 'autonomous');
                if (!ours) {
                    this.log('debug', `something else took the task slot mid-approach; ${who} does not get chased`);
                    return;
                }
                const here = this._point(this.gameState.position);
                const travelled = (from && here) ? Math.hypot(here.x - from.x, here.z - from.z) : 0;
                const stillHere = (Array.isArray(this.gameState.nearbyPlayerNames)
                    ? this.gameState.nearbyPlayerNames : [])
                    .some((n) => String(n).toLowerCase() === who.toLowerCase());
                try {
                    // stop the follow before the give: altoclef owns ONE task
                    // runner, so without this the give silently replaces the walk
                    // and the "came over to you" half never visibly happens.
                    await this.executeAction('stop', {}, { priority: 'urgent', source: 'autonomous', timeoutMs: 30000 });
                } catch { /* may already be idle */ }
                if (travelled > BREAD_APPROACH_MAX_DIST || !stillHere) {
                    // they walked off, or this became a trek. she is not chasing a
                    // stranger across the map with a loaf.
                    this.log('info', `${who} moved on mid-handoff (${Math.round(travelled)} blocks walked); dropping the approach`);
                    this.recentEvents.record(`tried to hand ${who} a loaf and they wandered off`);
                    return;
                }
                try {
                    await this.executeAction('give', { player: who, item: 'bread', amount: 1 },
                        { priority: 'low', source: 'autonomous', waitForCompletion: false });
                } catch (err) {
                    this.log('warn', `bread handoff to ${who} failed: ${err.message}`);
                }
            })().catch((err) => this.log('warn', `bread approach failed: ${err.message}`));
        }, BREAD_APPROACH_MS);
        if (typeof timer.unref === 'function') timer.unref();
        if (opp) opp.approachTimer = timer;
        return true;
    }

    /**
     * SOMEBODY LOGGED IN.
     *
     * Driven by the companion's tab-list diff, not by the join MESSAGE. The
     * message is a system line shaped exactly like plugin chat, so it used to
     * arrive as a person saying the words "joined the game" and she answered it as
     * a sentence - live, she replied to a leave notice with "left the game.
     * dramatic exit for someone who wasn't even holding a torch". Reading the
     * roster instead means no format guessing and it works on a server whose join
     * line is in another language.
     *
     * Words only. A join says nothing about where they are - usually spawn,
     * usually hundreds of blocks away - so there is nothing to walk to and nothing
     * to hand over, and unlike an arrival this never touches her hands. It is
     * sampled and double-throttled for the obvious reason: a server where people
     * cycle all evening would turn her into a doorbell.
     *
     * WHAT SHE SAYS IS NOT DECIDED HERE. The event carries who and what she is
     * doing; her brain writes the line, or writes nothing (see the
     * no-canned-responses rule).
     */
    _maybeGreetJoin(player, online, now = Date.now()) {
        const who = String(player || '').trim();
        if (!who || !/^[A-Za-z0-9_]{1,16}$/.test(who)) return false;
        if (!this.enabled || this.manualControl) return false;
        if (who.toLowerCase() === String(this.gameUsername || '').toLowerCase()) return false;

        if (!this._joinSeen) this._joinSeen = new Map();
        const lastLeft = this._leftAt?.get(who) || 0;
        // straight back after a drop is a reconnect, not an arrival
        const reconnect = lastLeft && now - lastLeft < JOIN_RECONNECT_GRACE_MS;
        const lastGreet = this._joinSeen.get(who) || 0;
        // remember the sighting whatever happens next, so a skipped greeting still
        // counts as having seen them arrive
        this._joinSeen.set(who, now);
        if (this._joinSeen.size > 64) {
            for (const [k, at] of this._joinSeen) {
                if (now - at > JOIN_GREET_PER_PLAYER_GAP_MS * 2) this._joinSeen.delete(k);
            }
        }
        this._rememberPlayerDurably('sighting', who);

        if (reconnect) return false;
        if (now - lastGreet < JOIN_GREET_PER_PLAYER_GAP_MS) return false;
        if (now - (this._lastJoinGreetAt || 0) < JOIN_GREET_GAP_MS) return false;
        // never drop what she is doing to say hello - same rule as an arrival
        if (this.currentAction || this.activeGoal || this.pendingActions?.size) return false;
        if (Math.random() > JOIN_GREET_SAMPLE) return false;

        this._lastJoinGreetAt = now;
        this.recentEvents.record(`${who} joined the server`);
        this.emit('gameEvent', 'player_joined', {
            player: who,
            online: Number(online) || 0,
            // whether they have ever spoken to her before is the difference between
            // "hello stranger" and picking a thread back up
            known: (() => { try { return this.knownPlayers(30).includes(who); } catch { return false; } })(),
            task: String(this.currentTask || this.activeGoal?.action || this.botTask || '').slice(0, 120)
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
        // THE ROOM IS THE SERVER, NOT THE RENDER DISTANCE.
        //
        // this counted `nearbyPlayers` - a 32-block entity sweep - to decide
        // whether anyone was listening. but server chat is GLOBAL: everyone
        // logged in reads what she types. and her own homestead drive deliberately
        // settles her 450+ blocks from anybody, so the number was reliably zero
        // exactly where she spends her time. the room read as empty, "dead" won,
        // and the one path that makes her volunteer what she's doing was switched
        // off for the whole session.
        //
        // nearby still matters, but for PROXIMITY things (walking up, handing over
        // bread) - not for "is there anyone to talk to".
        const nearby = Number(g.nearbyPlayers) || 0;
        const online = Number.isFinite(g.onlinePlayers) ? Number(g.onlinePlayers) : nearby;
        const people = Math.max(nearby, online);
        if (g.multiplayer !== true) return { level: 'solo', lines: 0, quietForMs: Infinity, people, nearby, online };
        this._roomChatAt = this._roomChatAt.filter((t) => now - t <= ROOM_CHAT_WINDOW_MS * 6);
        const lines = this._roomChatAt.filter((t) => now - t <= ROOM_CHAT_WINDOW_MS).length;
        const last = this._roomChatAt[this._roomChatAt.length - 1] || 0;
        const quietForMs = last ? now - last : Infinity;
        let level = 'quiet';
        if (lines >= ROOM_BUSY_LINES || quietForMs <= ROOM_BUSY_RECENT_MS) level = 'busy';
        else if (quietForMs >= ROOM_DEAD_MS && people <= 0) level = 'dead';
        return { level, lines, quietForMs, people, nearby, online };
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
        // ⚠ EVERY DROP ON THIS PATH LOGS, AND LOGS THROUGH console.log, NOT
        // debugLog. a whole session went by with her mute in a room of people and
        // the logs could not say whether a single line had even reached her - the
        // queue's own skip reasons all run through debugLog, which is a no-op
        // unless BURTCRAFT_DEBUG=true, so "no evidence" and "never happened" were
        // indistinguishable. a path that can silently swallow a person's sentence
        // has to be able to say so.
        if (event === 'chat') {
            console.log(`[mc-chat] in <${data.sender}> ${String(data.text || '').slice(0, 120)}`);
        }
        if (event === 'chat' && this.gameUsername &&
            String(data.sender || '').toLowerCase() === String(this.gameUsername).toLowerCase()) {
            console.log('[mc-chat] dropped: her own line coming back');
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
            if (text && this._recentChatText(text)) {
                console.log('[mc-chat] dropped: same text already seen (multi-path dedup)');
                return;
            }
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
                // ⚠ WHEN THIS BOUT OF BEING SHOT AT BEGAN, not merely the last hit.
                // _recoverPersistentGoal needs "how long has she been under fire", and
                // a single stamp can only answer "was she hit recently".
                {
                    const hitAt = Date.now();
                    if (hitAt - (this._lastDamageAt || 0) > PERSISTENT_DANGER_BREAK_MS) this._damageEpisodeAt = hitAt;
                    this._lastDamageAt = hitAt;
                }
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
            case 'player_joined':
                if (Number.isFinite(data.online)) this.gameState.onlinePlayers = data.online;
                // _maybeGreetJoin decides whether this is worth her mouth, and
                // re-emits its OWN player_joined when it is. this raw one from the
                // companion carries no judgement and never reaches her brain: the
                // burnt.js cue listens for the one below, not this one.
                this._maybeGreetJoin(data.player, data.online);
                return;
            case 'player_left':
                if (Number.isFinite(data.online)) this.gameState.onlinePlayers = data.online;
                // remembered ONLY so a reconnect can be told apart from an arrival.
                // she does not get a cue for somebody leaving - that was the old
                // accidental behaviour (a leave line parsed as chat) and it made her
                // narrate the server's own connection log back at it.
                if (!this._leftAt) this._leftAt = new Map();
                if (data.player) this._leftAt.set(String(data.player), Date.now());
                if (this._leftAt.size > 64) {
                    const cutoff = Date.now() - JOIN_RECONNECT_GRACE_MS * 4;
                    for (const [k, at] of this._leftAt) if (at < cutoff) this._leftAt.delete(k);
                }
                return;
            case 'low_hunger':
                if (typeof data.hunger === 'number') this.gameState.hunger = data.hunger;
                break;
            case 'manual_control':
                this.manualControl = data.on === true;
                this.recentEvents.record(this.manualControl
                    ? 'the owner took the keyboard (f1) - hands off the controls'
                    : 'got the controls back from the owner');
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
        this._recordWithdrawal(action, params || {});
        this._recordComfortPlaced(action, params || {});
        this._recordGearBanked(action, params || {});
    }

    // SHE PUT SOMETHING UP BECAUSE SHE LIVES HERE.
    //
    // nothing in the game scans a lantern, so this ledger is the only record the
    // ornament exists - which makes this the only thing stopping the wishlist
    // handing her the same lantern every eight minutes forever.
    //
    // ⚠ THE SAME CANCELLATION GUARD THE OVEN LEDGER LEARNED: UserTaskChain.cancel
    // runs the same onFinish path as a real completion, so an F1 takeover mid-place
    // arrives here as a SUCCESS. an invented oven is expensive (it regrows the
    // shell); an invented lantern is cheap, but it is still a thing she will talk
    // about on stream that is not there.
    _recordComfortPlaced(action, params) {
        if (action !== 'place_block' && action !== 'place') return;
        const kind = String(params.target || params.block || '').toLowerCase().replace(/^minecraft:/, '');
        if (!COMFORT_KINDS.includes(kind)) return;
        if (this.manualControl || this._stopInFlight) {
            this.log('debug', `not recording ${kind} - the place was cancelled, not completed`);
            return;
        }
        try {
            const at = [params.x, params.y, params.z].every(Number.isFinite)
                ? { x: params.x, y: params.y, z: params.z }
                : this.gameState.position;
            // ⚠⚠ THE WRITER AND THE READER MUST NAME THE SAME SETTLEMENT.
            // `_comfortStep` asks `listComforts({settlementId})` to decide what is
            // already up, so an ornament filed under a DIFFERENT id (or null) is
            // invisible to it - and an invisible ornament is offered again on the
            // next tick, forever. the step knows exactly which house it is
            // decorating, so it says so on the params and this trusts that first;
            // the position lookup is only the fallback for a hand-placed one.
            const settlementId = params.settlementId ||
                this.memory.listSettlements(this._worldId()).find((entry) => entry.contains(at, 24))?.id ||
                null;
            const recorded = this.memory.recordComfort(kind, at, this.gameState.dimension, { settlementId });
            if (recorded?.isNew) {
                const total = this.memory.getTally().comfortsPlaced;
                this.recentEvents.record(`put up a ${kind.replace(/_/g, ' ')} at home`);
                this._pushCommentary(`${kind.replace(/_/g, ' ')} is up. ${total} bits of the place that are mine now`);
            }
        } catch (err) {
            this.log('warn', `comfort ledger: ${err.message}`);
        }
    }

    // she put spares on the shelf. counted only when the deposit really finished,
    // and only for a trip the ARMORY sized - the bag-full declutter banks rubble
    // and is a different sentence entirely.
    _recordGearBanked(action, params) {
        if (action !== 'deposit' || !params._armory || !Array.isArray(params.items)) return;
        const total = params.items.reduce((sum, e) => sum + (Number(e?.count) || 0), 0);
        if (!total) return;
        try { this.memory.bumpTally('gearBanked', total); } catch { /* flavor only */ }
    }

    // SHE TOOK IT OUT, SO IT IS NOT IN THERE ANY MORE.
    //
    // the ledger is a belief and a completed withdraw is the one moment she KNOWS
    // it changed. spending it here rather than waiting for the companion to
    // re-publish means a build that does NOT re-publish after a withdraw cannot
    // leave her believing in loaves that are now in her pockets - which would
    // read as a permanently stocked pantry and stop her restocking for good.
    // deliberately does not touch `readAt`: taking bread out is not looking in.
    _recordWithdrawal(action, params) {
        if (action !== 'withdraw') return;
        const item = String(params.item || params.target || '').trim();
        if (!item || ![params.x, params.y, params.z].every(Number.isFinite)) return;
        try {
            const key = this.memory._containerKey?.(this.gameState.dimension, params.x, params.y, params.z);
            if (key) this.memory.noteContainerTaken?.(key, item, Number(params.amount) || 1);
        } catch { /* best-effort */ }
    }

    // the obsession's ledger. a placed oven joins the named collection (units
    // with names, not a block count), and a baked loaf goes on the lifetime
    // tally. both are
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
    //
    // ⚠ TWO DESTINATIONS, TWO LIFETIMES, AND THEY ARE NOT THE SAME AUDIENCE.
    // `recentEvents` is the 3-minute rolling "recently:" line - ambient combat
    // telemetry is exactly what it was built for. `memory.record('event', ...)` is
    // the 240-slot DURABLE journal, and `context()` shows her the last six rows of
    // it as "what i just did". sending everything to both filled the journal with
    // combat noise: on the live ledger 160 of 240 rows were events, 112 of those
    // three ambient kinds repeating ("1 hostiles nearby" x42, "dodged a creeper"
    // x31, "took damage" x23), so her own recall of the afternoon read as a
    // threat feed and the ring held under five days. `isJournalNoise` already
    // exists for this and only ever looked at `kind === 'completed'`, one kind
    // over from where the noise actually was.
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
            // ⚠ WITHOUT A CASE HERE IT FALLS TO `default: return`, which skips the
            // recent line, the journal AND _rememberMilestone at the bottom of this
            // method - so the one pickup actually worth remembering would have been
            // the only kind that reached none of them.
            case 'rare_find': label = data.name ? `found ${data.name}` : 'found something rare'; break;
            case 'nightfall': label = 'night fell'; break;
            case 'dimension_changed': label = data.dimension ? `entered ${data.dimension}` : 'changed dimension'; break;
            case 'weather_changed': label = data.weather ? `weather changed to ${data.weather}` : 'weather changed'; break;
            case 'hostiles_nearby': label = data.count ? `${data.count} hostiles nearby` : 'hostiles nearby'; break;
            case 'task_finished':
                // the command-completion path already logged this goal; only record
                // altoclef's own task-finished if it wasn't just captured
                if (Date.now() - this._lastCompletionAt > 3000) {
                    const t = String(data.task || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                    // ⚠ THE STRING "null", NOT THE VALUE. every cancel path in
                    // UserTaskChain used to publish a null task (stop() cleared it
                    // before onTaskFinish read it), the companion serialized that
                    // with String.valueOf, and `'null' || ''` is truthy - so 38 rows
                    // of the live journal are literally labelled "null". the java is
                    // fixed at the source; this stays as the guard, because a
                    // stringified empty is worth nothing to her either way.
                    if (t && t !== 'null' && t !== 'undefined') label = t;
                }
                break;
            default: return; // block_broken etc are too frequent to log
        }
        if (label) {
            this.recentEvents.record(label);
            // the rolling line takes everything; the durable journal takes what she
            // would still want to have done tomorrow. see the note on this method.
            if (!AMBIENT_JOURNAL_EVENTS.has(event)) {
                this.memory.record('event', label, {
                    position: data.position || this.gameState.position,
                    dimension: this.gameState.dimension,
                    details: data.name || data.item || data.type || data.task
                });
            }
        }
        if (event === 'death' || event === 'respawn' || event === 'achievement' ||
            event === 'diamond_found' || event === 'rare_find') {
            this.memory.recordLandmark(label || event, {
                position: data.position || this.gameState.position,
                dimension: this.gameState.dimension,
                world: this._worldId()
            });
        }
        this._recordProgression(event, data);
        this._rememberMilestone(event, data, label);
    }

    /**
     * Fold a batch of real advancement ids into the conquest ledger.
     *
     * `silent` is for the once-per-world bulk sync: the ledger is written exactly the
     * same, but no `first_time` event goes out, because forty simultaneous "i have
     * never done this before!" moments on login is not a feature.
     */
    _ingestAdvancements(ids, { silent = false } = {}) {
        const world = this._worldId();
        let added = 0;
        for (const raw of ids) {
            const id = String(raw || '').trim();
            if (!id || !id.includes(':')) continue;
            let result = null;
            try {
                // `milestoneLabel` renders a catalogue entry's own wording, and for an
                // id the catalogue has never heard of falls back to the readable tail
                // of the path. Vanilla ships far more advancements than the ~60 worth
                // chasing, and "i got a thing" is worse than a slightly clumsy name.
                result = this.memory.recordConquest(id, {
                    world, kind: 'advancement', label: milestoneLabel(id)
                });
            } catch { continue; }
            if (!result?.first) continue;
            added += 1;
            if (silent) continue;
            this.emit('gameEvent', 'first_time', {
                id, kind: 'advancement', label: result.entry.label,
                total: this.memory.conquestCount(world)
            });
        }
        if (added && silent) {
            this.log('info', `synced ${added} advancements from the game`);
        }
        return added;
    }

    /**
     * DID SHE JUST BEAT SOMETHING?
     *
     * Turns the events that already fire into durable, deduped conquests, so
     * "have i done the nether yet" becomes answerable instead of guessed at.
     *
     * ⚠ ONLY THE FIRST TIME IS NEWS. `recordConquest` is idempotent per (world, id)
     * and hands back `first`, which is what gates the event. Without that she
     * announces her first ever dragon every time she walks past the egg.
     *
     * ⚠ The advancement NAME arrives as the rendered display string ("Stone Age"),
     * because today's only source is a regex over chat. The catalogue is keyed on
     * vanilla IDS, so a display name cannot match it and is stored under a
     * `burtcraft:named/` key instead of being force-fitted onto a guess. When the java
     * side starts reading the real advancement tree it will send proper ids, they
     * will match the catalogue directly, and these named entries simply stop being
     * created - no migration, no double-counting, because the ids differ.
     */
    _recordProgression(event, data = {}) {
        let id = null, kind = 'milestone', label = null;
        if (event === 'achievement') {
            const raw = String(data.id || data.advancement || '').trim();
            const name = String(data.name || '').trim();
            if (raw && raw.includes(':')) { id = raw; label = name || null; }
            else if (name) { id = `burtcraft:named/${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`; label = name; }
            kind = 'advancement';
        } else if (event === 'entity_killed' && data.player !== true) {
            // bosses only. an ordinary zombie is not a conquest and filing it as one
            // would bury the dragon under four thousand of them.
            const type = String(data.type || data.name || '').toLowerCase().replace(/^minecraft:/, '');
            if (type === 'ender_dragon') { id = 'minecraft:end/kill_dragon'; kind = 'boss'; label = 'killed the ender dragon'; }
            else if (type === 'wither') { id = 'burtcraft:wither_killed'; kind = 'boss'; label = 'killed the wither'; }
            else if (type === 'elder_guardian') { id = 'burtcraft:elder_guardian_killed'; kind = 'boss'; label = 'killed an elder guardian'; }
            else if (type === 'warden') { id = 'burtcraft:warden_killed'; kind = 'boss'; label = 'killed a warden'; }
        }
        if (!id) return null;
        let result = null;
        try {
            result = this.memory.recordConquest(id, {
                world: this._worldId(), label, kind,
                position: data.position || this.gameState.position,
                dimension: this.gameState.dimension
            });
        } catch { return null; }
        if (result?.first) {
            this.emit('gameEvent', 'first_time', {
                id, kind, label: result.entry.label,
                total: this.memory.conquestCount(this._worldId())
            });
        }
        return result;
    }

    // the handful of game events worth carrying between sessions. everything else she
    // does is already visible as live state; these are the ones a person would still
    // be telling you about tomorrow, so they go to the semantic memory where her chat
    // brain can retrieve them long after the journal ring has rolled over.
    _rememberMilestone(event, data = {}, label = null) {
        const p = this.gameState.position;
        const where = p && [p.x, p.z].every(Number.isFinite)
            ? ` at ${Math.round(p.x)},${Math.round(p.z)}` : '';
        const dim = this.gameState.dimension && this.gameState.dimension !== 'overworld'
            ? ` in the ${String(this.gameState.dimension).replace(/_/g, ' ')}` : '';
        const server = this.gameState.multiplayer === true && this.gameState.server
            ? ` on ${this.gameState.server}` : '';
        let line = null;
        if (event === 'death') {
            // ⚠ `label` IS THE STRING "died", so the old fallback chain
            // (`data.cause || data.killer || label`) wrote "burnt died in minecraft to
            // died" into semantic memory whenever the companion sent no cause - which
            // was ALWAYS, because the death event was an empty object. Asked how she
            // died, that sentence is what came back, and a player killing her was
            // indistinguishable from falling in lava.
            //
            // The companion now sends the real death-screen sentence, so prefer it
            // outright: "Burnt was shot by Skeleton" needs no reassembly. Then the
            // killer (a name is more use than a damage-type id), then the type, and
            // only then a shrug - never the word "died" as its own cause.
            if (data.message) {
                line = `in minecraft: ${String(data.message)}${where}${dim}${server}`;
            } else {
                const cause = data.killer || data.killerType || data.cause || 'something';
                line = `${this.gameUsername || 'the bot'} died in minecraft to ${cause}${where}${dim}${server}`;
            }
        } else if (event === 'diamond_found') {
            line = `${this.gameUsername || 'the bot'} found diamonds in minecraft${where}${dim}${server}`;
        } else if (event === 'achievement') {
            line = `${this.gameUsername || 'the bot'} unlocked "${data.name || data.achievement || label}" in minecraft${server}`;
        } else if (event === 'rare_find') {
            line = `${this.gameUsername || 'the bot'} found ${data.name || data.item} in minecraft${where}${dim}${server}`;
        } else if (event === 'entity_killed' && data.player === true) {
            // killing a MOB is routine; killing a person on a public server is a
            // thing she will still be hearing about tomorrow.
            line = `${this.gameUsername || 'the bot'} killed ${data.name || 'another player'} in minecraft${where}${server}`;
        }
        if (!line) return;
        if (typeof this.remember?.gameplay !== 'function') return;
        try {
            this.remember.gameplay(line, {
                tags: [event, String(data.killer || data.killerType || data.cause || data.item || '')].filter(Boolean)
            });
        } catch { /* a host's store must never break the run */ }
    }

    // people are upserted, so this can run often - but a row rewrite per sighting is
    // pointless churn. anything SIGNIFICANT (they spoke, asked, or got bread) writes
    // immediately; a bare walk-past waits out the throttle.
    _bridgePlayerToRag(name, { immediate = false } = {}) {
        const who = String(name || '').trim();
        if (!who) return;
        if (!this._ragPlayerAt) this._ragPlayerAt = new Map();
        const key = who.toLowerCase();
        const now = Date.now();
        if (!immediate && now - (this._ragPlayerAt.get(key) || 0) < PLAYER_RAG_THROTTLE_MS) return;
        this._ragPlayerAt.set(key, now);
        if (this._ragPlayerAt.size > 128) {
            for (const [k, at] of this._ragPlayerAt) {
                if (now - at > PLAYER_RAG_THROTTLE_MS * 4) this._ragPlayerAt.delete(k);
            }
        }
        try {
            const player = this.memory.getPlayer(who);
            if (player && typeof this.remember?.player === 'function') this.remember.player(player, this._worldId());
        } catch { /* enhancement only */ }
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

    // WHAT SHE SPENDS FREE TIME ON. an unknown mode resolves to 'auto' rather
    // than being stored - a typo that persists is a bot whose idle provider
    // silently returns null forever, which looks exactly like a freeze.
    // returns the RESOLVED mode so the caller can report what actually happened.
    setAutonomyMode(mode) {
        const want = String(mode || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        const next = AUTONOMY_MODES.includes(want) ? want : AUTONOMY_MODE_DEFAULT;
        const changed = next !== this.autonomyMode;
        this.autonomyMode = next;
        if (changed) {
            // a new brief means the old brief's steps are not on cooldown any more
            this._autonomyModeCooldowns.clear();
            this._autonomyModeArmed = null;
            this._declareModeGoal(next);
            this.log('info', `autonomy mode -> ${next}`);
            this.recentEvents.record(`switched her own idle plan to ${this._autonomyModeLabel(next)}`);
        }
        return this.autonomyMode;
    }

    _autonomyModeLabel(mode = this.autonomyMode) {
        return ({
            auto: 'whatever she feels like',
            gather_materials: 'stocking up on materials',
            gather_food: 'working the food supply',
            scout_area: 'scouting the area',
            secure_area: 'holding the homestead down'
        })[mode] || 'whatever she feels like';
    }

    // ---- the goal ledger -------------------------------------------------
    // SHORT = the objective she is on right now (the autonomy mode's brief).
    // LONG  = what she is building toward across sessions - the thing that made
    // the owner say she starts the same afternoon over and over.
    //
    // ⚠ EVERY CALL IS GUARDED. the ledger lives in minecraft_memory.js; a save
    // or a module that predates it must cost her the memory of what she was
    // working on, never the ability to play. `typeof` rather than a try/catch
    // because an absent method is a normal state here, not an error.
    _goals() {
        const m = this.memory;
        return (m && typeof m.addGoal === 'function' && typeof m.listGoals === 'function') ? m : null;
    }

    /**
     * THE TASK CHAIN: why -> goal -> step -> what the game is actually doing.
     *
     * Every layer of this already existed and none of them were assembled, so
     * "what is she doing" had no answer anywhere - not for the owner, not for the HUD,
     * not in her own prompt. The ledger knew the GOAL, activeGoal knew the STEP and
     * carried a `why` that was captured at dispatch and then read by nothing, and
     * the companion knew the GAME TRUTH. The prompt got `currently: defend` and a
     * raw altoclef string.
     *
     * The reconciliation is the point. node's belief and the game's reality drift
     * apart constantly - _expirePendingAction clears the node record without ever
     * telling the game to stop, so she reads "idle" while altoclef is still running
     * an orphan task. Saying so out loud is what turns "i have no idea what she's
     * doing" into a diagnosis.
     */
    _objectiveChain() {
        const step = this.activeGoal;
        const botTask = this._cleanPhase(this.gameState?.botTask);
        const botAction = this._cleanPhase(this.gameState?.botAction);

        let goal = null;
        try {
            const mem = this._goals();
            goal = mem?.activeGoal?.('long') || mem?.activeGoal?.() || null;
        } catch { goal = null; }

        const why = step?.why
            || (step?.source ? INTENT_SOURCE_WHY[step.source] : null)
            || null;

        // node says nothing is running, the game says something is. that gap IS the
        // finding - never paper over it by preferring one side.
        const nodeIdle = !this.currentAction && !this.activeGoal;
        const orphaned = nodeIdle && !!botTask;

        return {
            goal: goal ? { text: goal.text, scope: goal.scope, attempts: goal.attempts || 0 } : null,
            step: step ? {
                action: step.requestedAction || step.action,
                target: step.params?.target || null,
                source: step.source,
                runningForMs: Date.now() - step.startedAt,
                lastProgressAgeMs: Date.now() - step.lastProgressAt
            } : null,
            why,
            botTask,
            botAction,
            orphaned,
            // one line, already formatted, for a hud / log / ui that just wants text.
            line: this._objectiveLine({ goal, step, why, botTask, botAction, orphaned })
        };
    }

    _objectiveLine({ goal, step, why, botTask, botAction, orphaned }) {
        const parts = [];
        if (goal?.text) parts.push(`goal: ${goal.text}`);
        if (step) {
            const what = `${step.requestedAction || step.action}${step.params?.target ? ` ${step.params.target}` : ''}`;
            const secs = Math.round((Date.now() - step.startedAt) / 1000);
            parts.push(`doing: ${what} (${secs}s)`);
        } else if (!orphaned) {
            parts.push('doing: nothing yet - picking something');
        }
        if (why) parts.push(`because: ${why}`);
        if (botTask) parts.push(`game: ${botTask}${botAction && botAction !== botTask ? ` / ${botAction}` : ''}`);
        if (orphaned) parts.push('⚠ i have no job queued but the game is still running one - that is a leftover task, not a plan');
        return parts.join(' | ');
    }

    _goalIsLive(goal) {
        return !!goal && goal.state !== 'done' && goal.state !== 'abandoned';
    }

    // the mode's brief, as a goal she can talk about. the PREVIOUS brief is closed
    // on the way in - leaving it open is how "right now:" ends up listing four
    // contradictory jobs she is definitely not all doing.
    _declareModeGoal(mode) {
        const mem = this._goals();
        if (!mem) return null;
        try {
            for (const g of mem.listGoals({ scope: 'short' })) {
                if (g.kind !== 'autonomy_mode' || !this._goalIsLive(g)) continue;
                if (g.targetId === mode) continue;
                mem.abandonGoal(g.id, 'changed what i was doing');
            }
            // "do whatever i feel like" is a stance, not an objective. giving it a
            // goal line means the ledger always claims she is on a job.
            if (mode === 'auto') return null;
            const text = ({
                gather_materials: 'stock up on the materials the build actually needs',
                gather_food: 'get the pantry properly stocked',
                scout_area: 'learn the ground around here',
                secure_area: 'keep the homestead safe and lit'
            })[mode];
            if (!text) return null;
            const goal = mem.addGoal({ scope: 'short', text, kind: 'autonomy_mode', targetId: mode });
            if (goal) mem.updateGoal(goal.id, { state: 'active' });
            return goal;
        } catch { return null; }
    }

    // a step actually went out under the current brief. records WHAT she did on
    // the goal so the context line is "getting cobblestone" rather than a title.
    _noteModeGoalStep(step) {
        const mem = this._goals();
        if (!mem || !step || typeof mem.activeGoal !== 'function') return;
        try {
            const goal = mem.activeGoal('short');
            if (!goal || goal.kind !== 'autonomy_mode') return;
            mem.updateGoal(goal.id, {
                progressNote: this._describeTask(step.action, step.params || {}),
                attempt: true
            });
        } catch { /* the ledger is a nicety, never a gate */ }
    }

    /**
     * SOMEBODY ASKED FOR A JOB, SO IT BECOMES A JOB - not a single dispatch.
     *
     * `_actOnRequest` stamps `_lastHandledRequestAt` and sends the action ONCE.
     * Everything after that is out of its hands: a creeper, a stall recovery, a
     * protection denial or simply the next person talking ends the action, and
     * the request has already been marked handled, so nothing ever tries again.
     * The idle menu then picks its own thing 25 seconds later and the job is
     * gone. That is the whole "she forgets and i have to remind her" complaint -
     * she was never remembering in the first place.
     *
     * Writing it into the goal ledger gives the tick something to resume. The
     * ledger already persisted across restarts and deduped; it simply had no
     * relationship with what she does next.
     */
    _declareRequestGoal(req, params) {
        const mem = this._goals();
        if (!mem || !req?.action) return null;
        if (!RESUMABLE_ACTIONS.has(req.action)) return null;
        try {
            const what = this._describeTask(req.action, params || {});
            const goal = mem.addGoal({
                // A BUILD IS NOT AN ERRAND. a settlement or a farm survives being
                // interrupted a dozen times and is still the right thing to go
                // back to; "come here" is over in a minute and stops meaning
                // anything an hour later. the caps are separate (12/8) so a busy
                // afternoon of errands cannot evict the house she is building.
                scope: LONG_REQUEST_ACTIONS.has(req.action) ? 'long' : 'short',
                text: what,
                kind: `request_${req.action}`,
                targetId: params?.target ? String(params.target) : null,
                resume: { action: req.action, params: params || {} }
            });
            if (goal) mem.updateGoal(goal.id, { state: 'active', progressNote: `${req.user} asked` });
            return goal;
        } catch { return null; }
    }

    /**
     * THE RUNG THAT WAS MISSING. Goals were written in six places and read in
     * exactly one - `_goalLines()`, which feeds her PROMPT. Nothing anywhere
     * consulted a goal to decide what to actually do, so the ledger was a
     * narration feed wearing the word "goal": she could describe the wheat farm
     * beautifully and would never once walk back to it.
     *
     * ⚠ WHERE THIS SITS IS THE DESIGN. Above the homestead arc, the mode brief
     * and the idle menu - the comment below this call has always claimed a
     * requested goal outranks the homestead, and now something makes that true.
     * Below faults, recovery, urgent safety, `_actOnRequest` and the
     * spawn-region gate, because those are not preferences and a half-finished
     * farm is no reason to stand in lava or ignore the person talking to her.
     *
     * ⚠ Dispatched by the caller through `_safeExecute`, like every other step,
     * so the stalled-action backoff, the by-place stuck streak and the
     * repeated-failure blacklist all supervise it. A resume that bypassed those
     * would be a loop no watchdog in this file could stop - and "go back to it
     * forever" is a worse failure than forgetting.
     */
    _resumeGoalStep() {
        const mem = this._goals();
        if (!mem || typeof mem.resumableGoals !== 'function') return null;
        let candidates;
        try { candidates = mem.resumableGoals() || []; } catch { return null; }
        const now = Date.now();
        for (const goal of candidates) {
            // GIVING UP HAS TO BE POSSIBLE, or "she forgets" is replaced by "she
            // will not drop it", which is worse on a public server. The count
            // only rises on real evidence - see _noteGoalOutcome: an interruption
            // is not a failed attempt.
            if ((goal.attempts || 0) >= GOAL_ATTEMPT_LIMIT) {
                try {
                    mem.abandonGoal(goal.id, 'could not make it work');
                    this.recentEvents.record(`gave up on ${goal.text}`);
                    this._pushCommentary(`i keep failing at ${goal.text}, so i'm leaving it`);
                } catch { /* the ledger is a nicety, never a gate */ }
                continue;
            }
            // and a goal that just had a go does not get the very next tick too:
            // that turns one unreachable job into a spin that starves everything
            // below this rung.
            if (now - (goal.lastRunAt || 0) < GOAL_RESUME_COOLDOWN_MS) continue;
            const action = goal.resume?.action;
            if (!action || !RESUMABLE_ACTIONS.has(action)) continue;
            return {
                action,
                // ⚠ TAG THE DISPATCH WITH THE GOAL ID. Matching a finished action
                // back to its goal by VERB cannot work: _dispatchAction rewrites
                // go_home/go_outpost to `move` and build_outpost to
                // `build_settlement`, so a `go_home` goal never recognised its own
                // completion - it was never closed, never spent an attempt, and
                // re-resumed every 90s forever. The upgrade ledger (`_upgrade`) and
                // the food ledger (`_foodSpot`) both already carry an id for exactly
                // this reason; this was the one ledger still matching on the verb.
                params: { ...(goal.resume.params || {}), _goal: goal.id },
                say: (goal.attempts || 0) > 0
                    ? `right - back to ${goal.text}`
                    : null,
                commit: () => {
                    try {
                        // ⚠ DISPATCHING IS NOT AN ATTEMPT. this used to charge one
                        // here AND another in `_noteGoalOutcome`'s failure branch,
                        // which broke the three-outcome rule twice over:
                        //   - GOAL_ATTEMPT_LIMIT (4) was really 2, because every
                        //     real failure cost two.
                        //   - an INTERRUPTION - the case the whole feature exists
                        //     for - spent one, because the charge landed at dispatch
                        //     and `_noteGoalOutcome` is (correctly) skipped for a
                        //     `task stopped`. four re-tasks abandoned a good farm.
                        // `lastRunAt` is what paces the retry (GOAL_RESUME_COOLDOWN_MS);
                        // `attempts` counts only goes that actually FAILED.
                        mem.updateGoal(goal.id, {
                            state: 'active', lastRunAt: Date.now(),
                            progressNote: 'picking it back up'
                        });
                    } catch { /* best-effort */ }
                }
            };
        }
        return null;
    }

    /**
     * Did the job she was asked to do actually get done?
     *
     * ⚠ THE THREE OUTCOMES ARE NOT TWO. Success closes the goal. A real failure
     * or a watchdog abort spends an attempt - a stop we issued IS evidence the
     * step is not working. But a deliberate INTERRUPTION (`task stopped`: a
     * re-task, a chat command, a dwell rotation) is neither: it is exactly the
     * case this whole feature exists for, so it must leave the goal open and
     * unpunished or five re-tasks would abandon a perfectly good farm. Same
     * discipline as _noteUpgradeOutcome, which learned this the same way.
     */
    _noteGoalOutcome(pending, ok) {
        const mem = this._goals();
        if (!mem || !pending?.action) return;
        // ⚠ IDENTITY IS THE TAG, THEN THE ERRAND - NEVER THE BARE `action`.
        //
        // A resumed step carries `_goal`, so it matches its own goal exactly.
        // An UNTAGGED dispatch still has to match, because _actOnRequest files the
        // goal and then sends the action itself, and that first send really is the
        // same job. Two rules make that comparison honest:
        //
        // 1. the verb is `requestedAction` - the one she was ASKED for. _dispatchAction
        //    rewrites go_home/go_outpost to `move` and build_outpost to
        //    `build_settlement`, so comparing `action` meant a `go_home` goal could
        //    never recognise its own completion: never closed, never spent an
        //    attempt, re-resumed every 90s forever. _trackActiveGoal already keeps
        //    `requestedAction` for exactly this reason ("so a dead home route is
        //    actually suppressed as a home route"); this was the ledger that forgot.
        //
        // 2. THE GOAL'S SPECIFICATION IS THE FILTER, and only what it actually pins.
        //    `go_home` names no coordinates and the dispatch resolves them off the
        //    home record, so requiring them to agree would reject every real match.
        //    But a goal that DID name a place has to be held to it - `move` and the
        //    build verbs name a place rather than a thing, so `target` alone does not
        //    identify them, and without this any stray walk closes "go to the village".
        const tag = String(pending.params?._goal || '');
        const asked = String(pending.requestedAction || pending.action || '').toLowerCase();
        const sameErrand = (g) => {
            if (String(g.resume?.action || '').toLowerCase() !== asked) return false;
            const wantTarget = String(g.resume?.params?.target ?? '');
            if (wantTarget && wantTarget !== String(pending.params?.target ?? '')) return false;
            const wx = Number(g.resume?.params?.x);
            const wz = Number(g.resume?.params?.z);
            if (Number.isFinite(wx) && Number.isFinite(wz)) {
                const gx = Number(pending.params?.x);
                const gz = Number(pending.params?.z);
                if (!Number.isFinite(gx) || !Number.isFinite(gz)) return false;
                if (Math.round(wx) !== Math.round(gx) || Math.round(wz) !== Math.round(gz)) return false;
            }
            return true;
        };
        try {
            for (const g of mem.resumableGoals()) {
                if (tag ? g.id !== tag : !sameErrand(g)) continue;
                if (ok) {
                    mem.completeGoal(g.id);
                    this.recentEvents.record(`finished ${g.text}`);
                } else {
                    mem.updateGoal(g.id, { state: 'open', attempt: true, progressNote: 'that go did not work' });
                }
                return;
            }
        } catch { /* best-effort */ }
    }

    /**
     * Somebody said stop. Everything she was going to go back to is off.
     *
     * Only RESUMABLE goals are stood down - the ones that would have made her
     * walk off and do it again. A long goal with no resume payload ("get the
     * homestead standing") is a thing she is working toward, not an instruction
     * currently being carried out, and wiping those would make "stop" quietly
     * mean "forget everything you were ever building".
     */
    _standDownGoals(reason) {
        const mem = this._goals();
        if (!mem || typeof mem.resumableGoals !== 'function') return 0;
        let stood = 0;
        try {
            for (const g of mem.resumableGoals()) {
                mem.abandonGoal(g.id, reason);
                stood++;
            }
        } catch { /* the ledger is a nicety, never a gate */ }
        if (stood) this.recentEvents.record(`dropped ${stood} job${stood === 1 ? '' : 's'} she was going to go back to`);
        return stood;
    }

    /**
     * The deliberate way to give her a job, as opposed to inferring one from a
     * parsed chat command.
     *
     * "your goal today is a wheat farm and then a proper house" is two long
     * goals and no action; `_declareRequestGoal` cannot file that, because it
     * only ever sees things that already parsed into an action. This is the door
     * for her own brain and for an operator.
     *
     * ⚠ `action` is OPTIONAL and that distinction is the whole point. With one,
     * the goal is RESUMABLE - the idle tick can carry it out. Without one it is
     * still a real goal she keeps, shows in her prompt and can talk about; it
     * just needs her to decide the steps. A goal that cannot be dispatched is
     * worth keeping. A goal that silently never happens is what we started with.
     */
    manageGoal({ op = 'list', text = '', scope = 'short', action = null, target = null, id = null } = {}) {
        const mem = this._goals();
        if (!mem) return { ok: false, error: 'goal memory is unavailable' };
        const verb = String(op || 'list').toLowerCase();
        const live = () => mem.listGoals().filter((g) => this._goalIsLive(g));
        const find = () => {
            const key = String(id || text || '').toLowerCase().trim();
            if (!key) return null;
            return live().find((g) => g.id === key)
                || live().find((g) => String(g.text || '').toLowerCase().includes(key))
                || null;
        };
        try {
            if (verb === 'add') {
                const body = String(text || '').trim();
                if (!body) return { ok: false, error: 'a goal needs saying out loud' };
                const wants = action && RESUMABLE_ACTIONS.has(String(action).toLowerCase())
                    ? { action: String(action).toLowerCase(), params: target ? { target: String(target) } : {} }
                    : null;
                const goal = mem.addGoal({
                    scope: scope === 'long' ? 'long' : 'short',
                    text: body,
                    kind: 'declared',
                    targetId: target ? String(target) : null,
                    resume: wants
                });
                if (!goal) return { ok: false, error: 'that goal would not stick' };
                this.recentEvents.record(`took on a new goal: ${goal.text}`);
                return { ok: true, goal, resumable: !!goal.resume };
            }
            if (verb === 'done' || verb === 'complete') {
                const goal = find();
                if (!goal) return { ok: false, error: 'no live goal matches that' };
                mem.completeGoal(goal.id);
                this.recentEvents.record(`finished ${goal.text}`);
                return { ok: true, goal };
            }
            if (verb === 'drop' || verb === 'abandon' || verb === 'forget') {
                const goal = find();
                if (!goal) return { ok: false, error: 'no live goal matches that' };
                mem.abandonGoal(goal.id, 'dropped it');
                return { ok: true, goal };
            }
            return {
                ok: true,
                goals: live().map((g) => ({
                    id: g.id, scope: g.scope, text: g.text, state: g.state,
                    attempts: g.attempts || 0, resumable: !!g.resume
                }))
            };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    _declareLongGoal(text, kind, targetId = null) {
        const mem = this._goals();
        if (!mem) return null;
        try { return mem.addGoal({ scope: 'long', text, kind, targetId }); } catch { return null; }
    }

    _finishLongGoal(kind, targetId = null) {
        const mem = this._goals();
        if (!mem) return false;
        try {
            let closed = false;
            for (const g of mem.listGoals({ scope: 'long' })) {
                if (g.kind !== kind || !this._goalIsLive(g)) continue;
                if (targetId && g.targetId && g.targetId !== targetId) continue;
                mem.completeGoal(g.id);
                closed = true;
            }
            return closed;
        } catch { return false; }
    }

    // what she is working toward, for status + the prompt block. an empty ledger
    // contributes nothing rather than an empty heading.
    _goalLines(max = 4) {
        const mem = this._goals();
        if (!mem || typeof mem.goalsContext !== 'function') return [];
        try { return mem.goalsContext(max) || []; } catch { return []; }
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
            // what self-play is FOR right now. 'auto' is the old ladder; the rest
            // replace only the free-time provider (see _autonomyModeBehavior).
            autonomyMode: this.autonomyMode,
            autonomyModeLabel: this._autonomyModeLabel(),
            autonomyModes: [...AUTONOMY_MODES],
            // what she is working toward, short and long. surfaced here so the
            // prompt block can render it - a ledger she can never talk about is
            // a ledger that may as well not exist.
            goals: this._goalLines(4),
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
            // the assembled task chain - goal -> step -> why -> game truth. see
            // _objectiveChain: every piece of this existed and nothing joined them up.
            objective: this._objectiveChain(),
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
            // ⚠ NOT A BARE context(). the goal/ore/quarry/upgrade ledgers are only
            // populated when it is told where she is standing - called bare, every
            // one of those keys is absent and she can never mention the seam she
            // found or the hole she has been digging.
            memory: this.memory.context(6, {
                position: this.gameState.position,
                dimension: this.gameState.dimension,
                world: this._worldId()
            }),
            // multiplayer truth (companion-reported) + her saved places
            manualControl: this.manualControl,
            multiplayer: this.gameState.multiplayer === true,
            server: this.gameState.server || null,
            // WHOSE SERVER IS THIS. null unless the box she is actually connected
            // to is the one configured as hers - asked against the companion's
            // reported ip, never against connect-mode intent, so she can never
            // call somebody else's server her own.
            homeServer: homeServerFor(this.gameState.server),
            // the human who owns her, by the name the game knows him by. null
            // when nobody is configured.
            owner: ownerName(),
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
            // WHAT SHE DECIDED ABOUT THE THING ATTACKING HER. lifted to the top
            // level beside deathSpot because this is what the daemon and the ui
            // mirror; the prompt block reads it off gameState. null on a jar that
            // cannot tell, so every consumer falls back to the behaviour it had
            // before rather than reading a live fight as a quiet evening.
            combat: this.gameState.combat || null,
            // THE TRIP SHE IS ON, if any. ⚠ a ledger nothing READS is this file's
            // most-repeated bug (goals: written in six places, read in one; visited
            // and claims: written for weeks, read nowhere). An expedition she cannot
            // talk about is a girl walking 3000 blocks for no stated reason, which on
            // stream is indistinguishable from a pathing fault.
            expedition: (() => {
                try {
                    const x = this.memory.getExpedition?.(this._worldId());
                    if (!x) return null;
                    const p = this._point(this.gameState.position);
                    const out = p ? Math.round(Math.hypot(p.x - x.origin.x, p.z - x.origin.z)) : null;
                    return {
                        out, furthest: x.furthest, target: x.targetDist, legs: x.legs,
                        reason: x.reason, status: x.status,
                        minutes: Math.round((Date.now() - (x.startedAt || Date.now())) / 60000),
                        discoveries: (x.discoveries || []).slice(-4)
                    };
                } catch { return null; }
            })(),
            // WHAT SHE HAS BEATEN AND WHAT IS LEFT. Both halves matter: the first is
            // hers to be proud of, the second is the only thing that gives a survival
            // player a reason to leave the house.
            progression: (() => {
                try {
                    const world = this._worldId();
                    const has = (id) => this.memory.hasConquered(id, world);
                    const done = this.memory.listConquests(world);
                    return {
                        tier: progressTier(has),
                        count: done.length,
                        recent: done.slice(0, 5).map((c) => c.label),
                        next: nextMilestones(has, { tier: progressTier(has), max: 4 })
                            .map((m) => ({ id: m.id, label: m.label, notable: !!m.notable }))
                    };
                } catch { return null; }
            })(),
            knownPlayers: this.knownPlayers(12),
            // WHO IS LOGGED IN, straight off the tab list. Distinct from `people`
            // (who she KNOWS) and from nearbyPeople (who is in the room): somebody
            // online across the map is a person she can go and find, or ask for
            // something, or wonder about - and until now she could not name one.
            // ⚠ null, not [], when the companion did not send it: an older jar
            // cannot tell, which must never render as an empty server.
            online: Array.isArray(this.gameState.onlinePlayerNames)
                ? this.onlineNames().filter((n) => !this.gameUsername
                    || String(n).toLowerCase() !== String(this.gameUsername).toLowerCase())
                : null,
            onlineCount: Number.isFinite(Number(this.gameState.onlinePlayers))
                ? Number(this.gameState.onlinePlayers) : null,
            // knownPlayers above is a RAM roster of who has spoken recently. this is the
            // durable half: people she actually knows, with what they said, what they
            // asked for, and whether she ever did it - across restarts.
            people: this.memory.playersContext(
                Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames : [],
                6, this._worldId()
            ),
            chatRoom: this.chatRoom(),
            wheatSpots: this.memory.foodSpotsContext(this.gameState.position, 3, this.gameState.dimension),
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
            },
            // THE TRIMMINGS AND THE SHELF, as things she can actually speak from.
            //
            // ⚠ a ledger nothing READS is this codebase's most-repeated bug - the
            // goals ledger was written in six places and read in one, `visited` and
            // `claims` were written for weeks and read nowhere. the comforts ledger
            // is the only record a lantern exists, so if it never reaches her
            // prompt she puts one up and then has nothing to say about it ever
            // again, which for a girl who names her appliances is the whole point
            // missed. counts, not a list to recite.
            // ⚠ OPTIONAL-CHAINED, EVERY ONE. `getStatus` has an explicit contract
            // that it renders against a PARTIAL memory - a mock, or a ledger
            // written before a method existed - and it is on the status poll, so a
            // TypeError here does not lose a decoration, it takes out the whole
            // readout her prompt is built from. shipped unguarded and
            // mc_autonomy_modes_test's "a memory with no ledger" case caught it.
            home: {
                trimmings: this.memory.comfortsContext?.(this.gameState.position, this.gameState.dimension) || [],
                trimmingsPlaced: this.memory.getTally?.()?.comfortsPlaced || 0,
                kitTier: this._kitTier(),
                spareGearBanked: this.memory.getTally?.()?.gearBanked || 0
            },
            // WHAT IS ON THE SHELF, not just in her pockets.
            //
            // every count above is CARRIED, which is the right question for "can i
            // hand this person a loaf" and the wrong one for "do i need to bake".
            // without this she stands in front of a chest holding five hundred
            // loaves and tells the room she is running low, because the only bread
            // she could see was the bread in her hands.
            //
            // `known: false` means the companion cannot answer (an older jar sends
            // no container data at all) - it does NOT mean the chests are empty,
            // and nothing downstream may read it that way.
            pantry: this._pantrySummary(),
            homes: this._homesSummary()
        };
    }

    /** her stores, as something she can speak from. */
    _pantrySummary() {
        const mem = this.memory;
        const known = typeof this._containersKnown === 'function' ? this._containersKnown() : false;
        const summary = { known, containers: [], bread: null, wheat: null };
        if (!known) return summary;
        try {
            if (typeof mem.storesContext === 'function') {
                summary.containers = mem.storesContext(this.gameState.position, 6) || [];
            }
            if (typeof this._pantryBread === 'function') summary.bread = this._pantryBread();
            if (typeof this._storedCount === 'function') summary.wheat = this._storedCount('wheat');
        } catch { /* a shelf she cannot read is not a shelf she can lie about */ }
        return summary;
    }

    /**
     * every place she has lived, and which one is THE one.
     *
     * `main` used to be whichever homestead a survey packet touched last, so she
     * could not hold a stable answer to where she lives. it is a real designation
     * now, and this is what lets her say so.
     */
    _homesSummary() {
        const mem = this.memory;
        try {
            const all = mem.listSettlements(this._worldId());
            const main = typeof mem.getMainSettlement === 'function'
                ? mem.getMainSettlement(this._worldId())
                : null;
            return {
                count: all.length,
                mainId: main?.id || null,
                mainName: main?.name || null,
                list: all.map((entry) => ({
                    id: entry.id, name: entry.name, kind: entry.kind, role: entry.role,
                    isMain: !!main && entry.id === main.id,
                    distance: Math.round(entry.distanceTo(this.gameState.position)),
                    complete: entry.progress?.complete === true
                }))
            };
        } catch {
            return { count: 0, mainId: null, mainName: null, list: [] };
        }
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
            // ...and breaking off a fight is a control verb too: it is composed of
            // two things she can already do rather than anything new on the wire,
            // so like `stop` it never reaches _dispatchAction as itself. see
            // _runRetreat for why it must always end somewhere.
            if (act === 'retreat') return await this._runRetreat(opts);
            if (act && !NON_TASK_ACTIONS.has(act) && this._stopInFlight) {
                await this._stopInFlight;
            }
            // an install with no square named resolves one from the floorplan
            // BEFORE the spawn gate, so the gate judges the ground the block
            // actually lands on rather than where her body happens to be.
            if (act === 'install_appliance') params = this._resolveApplianceParams(params);
            // ...and for the same reason, a house whose position comes off the
            // settlement record resolves BEFORE the gate too. Her home can be
            // three thousand blocks outside the spawn region while she is a
            // hundred blocks from spawn walking back to it, and the gate has to
            // judge the ground the blocks land on, not where her body is.
            if (act === 'build_plan') params = this._canonicalWorldBuildParams(act, params);
            // ...and a gathering order that named no amount resolves one, for the
            // same reason both of the above resolve here: this is the single door
            // every action goes through, so her brain's tool calls, a viewer's
            // parsed chat command and the idle menu all get it. Fixing the ten
            // call sites instead would have left the eleventh, and the tool schema
            // lets her brain omit the field regardless.
            if (GATHER_ACTIONS.has(act) && params && params.amount == null && params.target != null) {
                params = { ...params, amount: this._resolveGatherAmount(params.target) };
            }
            // ...and EAT MEANS EAT, for the same one-door reason.
            //
            // ⚠ THE BRIDGE ONLY TAKES A BITE ON `now`/`hasFood`. everything else
            // becomes `@food <n>`, which is a HOLD TARGET like every other altoclef
            // resource ask - so with food already in the bag it is the documented
            // ~0.03s no-op that reports SUCCESS while she chews nothing, and with an
            // empty bag it is a multi-minute forage announced as "eating", which is
            // the freeze this whole distinction exists to prevent (see `stock_food`,
            // which is that gather under an honest name).
            //
            // ⚠⚠ AND THOSE TWO FIELDS ARE NOT IN THE TOOL SCHEMA. `params` is
            // `additionalProperties: false`, so her BRAIN could not express them at
            // all: `_eatParams()` is called from the idle menu, the survival rung and
            // the chat parser, and every llm-issued `eat` therefore fell straight
            // through to the gather. She has no way to say "eat, now" - the one verb
            // whose whole point is that it is immediate.
            //
            // resolved from what she is actually holding, because that is a question
            // about the world and not about the caller. a caller that already decided
            // (the autonomy paths, which call `_eatParams` themselves) is left alone,
            // and an explicit `amount` still wins - hence the caller-last spread.
            if (act === 'eat' && params && params.now === undefined && params.hasFood === undefined) {
                params = { ...this._eatParams(), ...params };
            }
            // ...and a player named by the name the ROOM uses for him resolves to
            // the name the GAME will accept, for the same "one door" reason.
            //
            // ⚠ ONLY THE SLOTS THAT ARE DEFINITIONALLY A USERNAME. `params.target`
            // is the most overloaded field in this file - it carries items, blocks,
            // place names, spoken words - and rewriting it generically would let an
            // alias eat an item name. these three are the ones the bridge validates
            // with /^[A-Za-z0-9_]{1,16}$/ and hands straight to @follow / @give /
            // @look_at. `attack` is deliberately NOT here: its target is usually a
            // mob, and turning a name into a punk order is not a normalisation.
            params = this._resolvePlayerParams(act, params);
            // ...and A DEPOSIT WITH NO MANIFEST IS THE DESTRUCTIVE FORM OF THE VERB.
            //
            // ⚠ bare `@deposit` is altoclef's "store ALL non-gear items": her bread, her
            // wheat, her torches, and the furnace she is carrying home to install. That
            // is why `execute_minecraft` fills a manifest in when her brain omits one -
            // but that guard lives in tools.js, and tools.js is NOT the only way in. A
            // person saying "put your stuff away" goes chat -> _actOnRequest ->
            // _startPersonRequest -> executeAction, which skips it entirely and reaches
            // the bridge as a bare deposit. It is also in RESUMABLE_ACTIONS, so it comes
            // back. Exactly the two-enforcement-points shape place_block was fixed for,
            // pointing the other way - so the guard belongs on the door, not the caller.
            //
            // An empty manifest means NO TRIP, never a fallthrough to the bare command.
            if (act === 'deposit' && !Array.isArray(params.items)) {
                const haul = this._depositManifest();
                if (!haul.length) {
                    throw policyRefusal('nothing worth banking - the only things in her bag are food, tools, fuel or fixtures she needs');
                }
                params = { ...params, items: haul };
            }
            // BEFORE ANYTHING ELSE: is she standing in the server's spawn region?
            // Then nothing she picked for herself may touch the world here. This
            // sits at the top of the ONE door every action goes through, so it
            // holds for her brain's tool calls as well as the idle menu - the
            // menu-level gate alone left "collect oak_log" a live option.
            const refusal = this._spawnRegionRefusal(act, opts.source, params);
            if (refusal) {
                this.log('info', `refused ${act} inside the spawn region`);
                throw policyRefusal(refusal);
            }
            // ...and the same for a site the builder has already refused outright.
            const blockedRefusal = this._blockedSiteRefusal(act, opts.source, params);
            if (blockedRefusal) {
                this.log('info', `refused ${act} - site is on the blocked cooldown`);
                throw policyRefusal(blockedRefusal);
            }
            // ...and BEFORE the preempt, because the commonest "change of mind" is
            // not one: it is the same errand asked for twice. See
            // _duplicateOfLiveWork - this is what stopped her cancelling her own
            // walk every 1.5 seconds and standing still while permanently busy.
            const duplicate = this._duplicateOfLiveWork(act, params);
            if (duplicate) return duplicate;
            const preemption = this._preemptIfWarranted(action, params, opts);
            if (preemption) await preemption;
            return await this._dispatchAction(action, params, opts);
        } catch (err) {
            // SURFACE EVERY FAILURE, not just the ones the game reports back.
            // failures raised HERE - "minecraft is busy with X", a missing required
            // param, no armour to put on, an unsupported action - rejected straight
            // out of _dispatchAction and never emitted actionFailed, so they only
            // ever reached a console.error. the owner could not tell a broken bot from an
            // idle one. the companion-reported path already emits (and marks the
            // error), so this only covers the gap and never double-reports.
            if (err && !err._reported) {
                err._reported = true;
                const stopped = /^task stopped$/i.test(String(err.message || '').trim());
                if (!stopped) {
                    this.emit('actionFailed', {
                        id: null, action, params, error: err.message || 'action failed', local: true,
                        // ⚠ "one of my rules said no" is not "i am broken" - see
                        // policyRefusal. Without this the fault voice announced a
                        // malfunction every time F1 was pressed or she declined to
                        // chop down the server's front garden.
                        policy: !!err._policy
                    });
                }
            }
            throw err;
        }
    }

    _runStopTransition(opts = {}) {
        if (this._stopInFlight) {
            // ⚠ COALESCING THE STOP MUST NOT SWALLOW WHAT IT MEANT. Returning the
            // in-flight promise discards `opts`, so a person saying "stop" while a
            // stall recovery was still settling never reached the stand-down in
            // _dispatchAction - the task halted and she walked back to the job 90
            // seconds later, which is the one behaviour worse than forgetting.
            // The stop itself is already happening; only the INTENT needs carrying.
            if (!INTERNAL_STOP_SOURCES.has(String(opts.source || ''))) {
                this._standDownGoals(`told to stop by ${opts.source || 'the owner'}`);
            }
            return this._stopInFlight;
        }
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

    // BREAK OFF AND GET CLEAR - her brain's own "this one is not worth it".
    //
    // the combat verbs she had were attack / defend / hunt / eat, and every one of
    // them commits her HARDER to the thing hitting her. there was no way for her to
    // decide a fight was a bad idea, which meant the only thing that could ever call
    // one off was a watchdog after it had already gone wrong.
    //
    // ⚠ IT IS A COMPOSITE OF TWO VERBS SHE ALREADY HAS - stop, then a real walk to a
    // real place - and BOTH HALVES ARE LOAD-BEARING. a retreat that only stopped
    // would be `idle` wearing a braver word, and the tool schema records in a comment
    // what that costs: chosen mid-hunt at 12/20 health, nine minutes and twenty
    // seconds facing nothing. standing still while something chews on her is the
    // worst available version of it. so this ALWAYS ends in a destination, which puts
    // it under the same stall, loop and dwell watchdogs as any other walk - it is
    // bounded, it terminates, and it can never become a way to do nothing.
    //
    // ⚠ THE MOVEMENT IS DELIBERATELY NOT MICROMANAGED. altoclef's defense chain owns
    // the actual disengage (it is already running, it knows where the mobs are); this
    // just stops insisting on the old goal and gives her feet somewhere to be, which
    // is the same division of labour _urgentSafetyBehavior describes when it returns
    // `action: null` for lava - "drop the plan, survival first".
    //
    // ⚠ AND IT REACHES THE GAME AS stop + move, so the bridge needs no `retreat` of
    // its own. same decomposition _recoverPinnedByMobs already uses.
    async _runRetreat(opts = {}) {
        const p = this._point(this.gameState.position) || { x: 0, y: 64, z: 0 };
        const source = opts.source || 'retreat';
        // drop what she was committed to FIRST, or the walk merely queues behind the
        // job that was getting her hit. coalesces with an in-flight stop by itself.
        try {
            await this.executeAction('stop', {}, { priority: 'urgent', source, timeoutMs: 30000 });
        } catch { /* may not have been running - that is not a failed retreat */ }
        // real distance, not a short hop: a few blocks just re-enters the same mobs'
        // aggro range (the pinned-recovery lesson), and _pickLandingSpot is what keeps
        // the bearing on land rather than into the sea.
        //
        // prefer OUTWARD while she is inside the spawn region, exactly as the pin
        // recovery does - a panic must not quietly undo the walk out.
        const region = this._standingInSpawnRegion() ? this._spawnRegion() : null;
        const spot = (region && this._pickLandingSpot(p, RETREAT_MIN_DISTANCE, RETREAT_MAX_DISTANCE, {
            outward: { depth: (x, z) => this._spawnDepth(x, z), here: this._spawnDepth(p.x, p.z), min: 1 }
        })) || this._pickLandingSpot(p, RETREAT_MIN_DISTANCE, RETREAT_MAX_DISTANCE);
        if (!spot) {
            // she has at least stopped, and walking somewhere on faith is what put her
            // in the ocean. report what actually happened rather than a clean retreat.
            this.recentEvents.record('broke off a fight, but there was no dry way out that i knew of');
            return {
                action: 'retreat',
                status: 'stopped',
                moved: false,
                detail: 'broke off, but every way out of here is water as far as i know - holding where i am'
            };
        }
        this.recentEvents.record('broke off a fight and got clear');
        await this.executeAction('move', { ...spot, target: 'somewhere that is not this fight' }, {
            source, waitForCompletion: false
        });
        return {
            action: 'retreat',
            status: 'retreating',
            moved: true,
            x: spot.x,
            z: spot.z,
            detail: `broke off and heading for ${spot.x}, ${spot.z}`
        };
    }

    // Two requests are THE SAME ERRAND when the verb and the thing or the place it
    // names match. `amount` is deliberately NOT part of it: a gather amount is a
    // stock level to end up holding, not a batch, so "get 3 cobblestone" arriving
    // while "get 8 cobblestone" runs is one trip that is already underway.
    _requestSignature(action, params = {}) {
        const act = String(action || '').trim().toLowerCase();
        const p = params && typeof params === 'object' ? params : {};
        const target = String(p.target ?? '').trim().toLowerCase();
        // move and the build verbs name a place rather than a thing, and a re-ask
        // that rounds to the same block is the same walk.
        const x = Number(p.x);
        const z = Number(p.z);
        const where = Number.isFinite(x) && Number.isFinite(z)
            ? `${Math.round(x)},${Math.round(z)}`
            : '';
        return `${act}|${target}|${where}`;
    }

    // Non-null when `action` re-requests work that is ALREADY RUNNING, in which
    // case the honest answer is to say so and leave the task alone.
    //
    // Her brain gets a fresh turn every few seconds and will cheerfully re-issue
    // the errand it is already on. `agent` is an unconditional preempting source,
    // so every one of those repeats used to cancel the walk that was underway and
    // start an identical one from scratch. live 2026-08-08 15:29:16-19: "get
    // stone_pickaxe" restarted every ~1.5s, three paths computed and thrown away
    // (23.0 blocks, then 18.1), "User task FINISHED. Took 1.468 seconds" twice in
    // a row - she was busy the entire time and got nowhere. Nothing was wrong
    // with the task, only with re-requesting it.
    //
    // Reported as SUCCESS rather than "minecraft is busy": a repeat is not a
    // failure, and an error here invites exactly the retry that caused the loop.
    // Safety actions are exempt - `eat` skips the busy gate on purpose, and a
    // second bite when she is starving must never be swallowed as a duplicate.
    _duplicateOfLiveWork(action, params = {}) {
        const act = String(action || '').trim().toLowerCase();
        if (!act || NON_TASK_ACTIONS.has(act) || SAFETY_ACTIONS.has(act)) return null;
        const wanted = this._requestSignature(act, params);
        // ⚠ COMPARE ASKED AGAINST ASKED. This runs before _dispatchAction rewrites
        // go_home/go_outpost to `move` (and overwrites params.target with the saved
        // place name and its coordinates), so comparing against the RUNNING form
        // meant the dedupe guard was blind to precisely the verbs that get rewritten.
        const live = [
            ...[...this.pendingActions.values()]
                .filter((pending) => !NON_TASK_ACTIONS.has(pending.action))
                .map((pending) => ({
                    action: pending.requestedAction || pending.action,
                    params: pending.requestedParams || pending.params
                })),
            ...(this.activeGoal
                ? [{
                    action: this.activeGoal.requestedAction || this.activeGoal.action,
                    params: this.activeGoal.requestedParams || this.activeGoal.params
                }]
                : [])
        ];
        if (!live.some((item) => this._requestSignature(item.action, item.params) === wanted)) return null;
        const described = this._describeTask(act, params);
        this.log('info', `already ${described} - letting it finish rather than restarting it`);
        return `${ALREADY_RUNNING_PREFIX} ${described}. it's still going, so it doesn't need starting again`;
    }

    _preemptIfWarranted(action, params = {}, opts = {}) {
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
            // ...and the same for the PARAMS, for the same reason one layer up.
            // `_duplicateOfLiveWork` runs before any of this rewriting and compares
            // what was ASKED against what is RUNNING - but the running record only
            // kept the rewritten form, so a re-asked `go_home` ("go_home||") was
            // compared against a live "move|home (the homestead)|500,500" and never
            // matched. `agent` is an unconditional preempting source, so every miss
            // became a cancel-and-restart: her brain says "head home" each turn, the
            // walk is stopped and re-pathed each turn, and she stands still while
            // permanently busy. Exactly the documented 1.5s restart loop, for every
            // verb the dedupe guard could not see.
            const requestedParams = params;
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
            // forgetting a food spot is a memory write too, and it lands here for
            // the same reason set_home does: a person in chat saying "there's no
            // wheat there" is routed through executeAction by _actOnRequest, and
            // an action the bridge has never heard of comes back as a failure
            // rather than doing the one harmless thing it was asked to do.
            if (action === 'forget_food') {
                const kind = String(params.target || params.kind || '').trim().toLowerCase();
                const here = this.gameState.position;
                let removed = 0;
                // ⚠ THE REPORT CHECK IS FIRST, so "this is only a claim" is structural
                // rather than a property of whichever branch happened to run. it used
                // to sit inside the here-branch, so a caller passing report:true WITH
                // a kind fell through to the delete - the one thing report means not
                // to do.
                if (params.report) {
                    if (!here || ![here.x, here.y, here.z].every(Number.isFinite)) {
                        reject(new Error('no position to report a food spot at'));
                        return;
                    }
                    const verdict = this.memory.noteFoodSpotEmpty(
                        here, this.gameState.dimension,
                        FOOD_SPOT_KINDS[kind] ? kind : null,
                        undefined, { reported: true }
                    );
                    resolve({ status: 'success', result: { reported: verdict || 'nothing here to mark' } });
                    return;
                }
                if (kind && kind !== 'here' && kind !== 'all') {
                    // scoped to where she IS - "forget the wheat" is about this
                    // server and this dimension, not every field she has ever seen.
                    removed = this.memory.removeFoodSpots({
                        kind, dimension: this.gameState.dimension, world: this._worldId()
                    });
                } else if (kind === 'all') {
                    removed = this.memory.removeFoodSpots({ all: true });
                } else if (here && [here.x, here.y, here.z].every(Number.isFinite)) {
                    removed = this.memory.removeFoodSpots({
                        near: here, dimension: this.gameState.dimension,
                        world: this._worldId(), radius: FOOD_SPOT_FORGET_RADIUS
                    });
                } else {
                    reject(new Error('no position to forget a food spot at'));
                    return;
                }
                if (removed) this.recentEvents.record(`forgot ${removed} food spot${removed === 1 ? '' : 's'} that turned out to be wrong`);
                resolve({ status: 'success', result: { forgotten: removed } });
                return;
            }
            if (action === 'food_spots') {
                resolve({
                    status: 'success',
                    result: this.memory.foodSpotsContext(this.gameState.position, 12, this.gameState.dimension)
                });
                return;
            }
            // ⚠ GAMER MODE IS A HOST-SIDE ACTIVITY, NOT A WIRE VERB, and the chat
            // route had no way to know that. `interpretChatCommand` parses "gamer
            // mode" into action 'gamer', recordViewerSuggestion does not filter it,
            // and _actOnRequest auto-executes it - straight past tools.js, which is
            // the only place that ever handled it. The bridge's SUPPORTED_ACTIONS
            // has no 'gamer', so every viewer who asked for it got a hard
            // "unsupported minecraft action" and a spoken fault, repeatable at the
            // per-user cooldown. Handling it here puts it behind the one door every
            // caller comes through, and gets the real thing (idle self-play
            // disarmed, phases narrated) instead of a bare `@gamer`.
            if (action === 'gamer' || action === 'gamer_stop') {
                const starting = action === 'gamer';
                Promise.resolve(starting ? this.startGamerMode() : this.stopGamerMode())
                    .then((r) => resolve({ status: 'success', result: r ?? { gamerMode: starting } }))
                    .catch((err) => resolve({ status: 'error', error: { message: err.message } }));
                return;
            }
            // the pantry readout. a memory read like food_spots, so it lands here
            // where every caller reaches it - her brain, a chat request, the tick.
            // ⚠ `known` rides along because an empty list means "she has not
            // looked", never "the chests are empty".
            if (action === 'stores') {
                resolve({
                    status: 'success',
                    result: {
                        known: this._containersKnown(),
                        stores: this.memory.storesContext(
                            this.gameState.position, 12, this.gameState.dimension, this._worldId()
                        )
                    }
                });
                return;
            }
            // ---- the spots she has named as favourites --------------------
            // ⚠ THE ONE MEMORY READ THAT NEVER GOT ITS NODE-SIDE HOME. `favorites`
            // lives only in tools.js, so every other route - a person asking in
            // game, the request-decision menu in burnt.js, the tick - fell through
            // to _dispatchAction and hit the bridge, which does not support it:
            // "unsupported minecraft action". Its three siblings (places, stores,
            // food_spots) all land here for exactly the reason stated below, and it
            // was simply left out of the set. Answering from memory also means she
            // can still say where she likes while the game is down.
            if (action === 'favorites') {
                resolve({
                    status: 'success',
                    // ⚠ the third argument is MAX, not a world id - this formatter has
                    // no world parameter, unlike placesContext/storesContext. Passing a
                    // world string here silently becomes a nonsense slice count.
                    result: this.memory.favoritesContext(
                        this.gameState.position, this.gameState.dimension, 24
                    )
                });
                return;
            }
            // ---- places she knows by sight -------------------------------
            // a memory read, like food_spots, so it lands here where EVERY
            // caller reaches it: her own brain, a viewer's chat line, the tick.
            if (action === 'places') {
                resolve({
                    status: 'success',
                    result: this.memory.placesContext(
                        this.gameState.position, 12, this.gameState.dimension, this._worldId()
                    )
                });
                return;
            }
            // naming the ground she is standing on. ⚠ this RECORDS rather than
            // merely renames, because the interesting case is somewhere the
            // observer skipped - flat ground she has a reason to care about is
            // exactly what a name is for.
            if (action === 'remember_place') {
                const pos = this.gameState.position;
                if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) {
                    reject(new Error('no reliable position to remember'));
                    return;
                }
                const described = this._describeHere();
                const asked = Array.isArray(params.features)
                    ? params.features
                    : String(params.features || '').split(/[,;]/).filter(Boolean);
                const entry = this.memory.recordPlace(pos, this.gameState.dimension, {
                    world: this._worldId(),
                    biome: described.biome,
                    shape: described.shape,
                    // what she SAYS about it joins what is actually there, so a
                    // place named for one thing keeps the rest of its description
                    features: [...described.features, ...asked],
                    name: params.name || params.target || null,
                    note: params.note || null,
                    source: params.source === 'told' ? 'told' : 'named'
                });
                if (!entry) { reject(new Error('could not remember this place')); return; }
                this.recentEvents.record(`named this place${entry.name ? ` "${entry.name}"` : ''}`);
                resolve({ status: 'success', result: { id: entry.id, name: entry.name, features: entry.features } });
                return;
            }
            // ⚠ FORGETTING IS DELIBERATELY NARROW AND EXPLICIT. chat-parsed
            // suggestions are AUTO-EXECUTED, and the food ledger already learned
            // what a loose delete verb costs - one viewer asking for a loaf
            // nearly wiped every field on every server.
            if (action === 'forget_place') {
                const found = this.memory.findPlace(params.target || params.name || '', {
                    world: this._worldId(), dimension: this.gameState.dimension
                });
                if (!found) { reject(new Error('no place by that name')); return; }
                const removed = this.memory.forgetPlace(found.id);
                if (removed) this.recentEvents.record(`forgot ${this.memory.placeLabel(found) || 'a place'}`);
                resolve({ status: 'success', result: { forgotten: removed, name: found.name || null } });
                return;
            }
            // walking back to somewhere she knows, by the word she knows it by.
            // rewritten into a `move`, exactly like go_outpost/go_home, so the
            // whole travel apparatus (water refusal, stall recovery, the spawn
            // gate) governs it without knowing places exist.
            if (action === 'go_place') {
                const found = this.memory.findPlace(params.target || params.name || '', {
                    world: this._worldId(), dimension: this.gameState.dimension
                });
                if (!found) { reject(new Error('no place by that name')); return; }
                const label = this.memory.placeLabel(found) || 'somewhere i know';
                action = 'move';
                params = {
                    ...params, x: found.position.x, y: found.position.y, z: found.position.z,
                    dimension: this._dimForMove(found.dimension), target: label
                };
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
            // THE THREE NEW WORLD VERBS. Every one of them fails burnt-side with a
            // sentence she can act on rather than reaching the bridge and coming
            // back as a translate error - the same lesson `move` with nowhere to go
            // and `install_appliance` with no square both had to learn.
            if (action === 'build_plan' || action === 'farm' || action === 'place_block') {
                try {
                    params = this._canonicalWorldBuildParams(action, params);
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
            // watched her post a bare username eight times in six minutes while
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
                reject(policyRefusal('manual control is on (f1) - the owner has the keyboard right now'));
                return;
            }

            if (!this.connected) {
                reject(new Error('minecraft bot not connected'));
                return;
            }

            if (!SAFETY_ACTIONS.has(action) && this._stateIsStale()) {
                reject(policyRefusal('minecraft telemetry is stale; wait for a fresh world-state update before sending a new goal'));
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
                reject(policyRefusal(`minecraft is busy with ${this.currentTask || this.currentAction || 'another task'}`));
                return;
            }

            const target = params.target || '';
            if (isTaskAction && !SAFETY_ACTIONS.has(action) &&
                this.memory.failureCount(action, target, LOOP_FAILURE_WINDOW_MS) >= LOOP_FAILURE_LIMIT) {
                reject(policyRefusal(`goal "${this._describeTask(action, params)}" is paused after repeated failures; inspect the fresh state and choose a different recovery step`));
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
                requestedParams,
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
                // LOOK AT THE PERSON SHE IS TALKING TO. this is the exact moment a
                // line is really handed to the bridge, so a gaze fired here can
                // never be a gesture for a sentence that got refused by the pacing
                // above. `addressee` is a separate field from `message` on purpose:
                // `target` is her WORDS (see the bare-username bug above), so it
                // could never have carried who she was saying them to.
                if (params.addressee) this._lookAtPerson(params.addressee, { reason: 'answering' });
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
                // ⚠ AND STOP HAS TO MEAN STOP. a resumable goal that survived an
                // explicit stop would walk straight back to the job 90 seconds
                // after being told to pack it in - which is the one behaviour
                // worse than forgetting, and unarguable on a public server.
                //
                // ...but ONLY when a person said it. every recovery, rotation,
                // protection abort and safety escape in this file stops her too,
                // and those are interruptions - precisely what the goal exists to
                // survive. they are named (source), a person's stop generally is
                // not, so the machine sources are the list and anything else
                // counts as somebody meaning it.
                if (!INTERNAL_STOP_SOURCES.has(String(opts.source || ''))) {
                    this._standDownGoals(`told to stop by ${opts.source || 'the owner'}`);
                }
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
            // the params as ASKED, so the duplicate gate can compare a re-ask
            // against this goal without the rewriting getting in the way
            requestedParams: pending.requestedParams || pending.params || {},
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
            lastSettlementSignature: this._settlementProgressSignature(this.gameState.settlementBuild),
            // per-field bests for _settlementAdvance. Left EMPTY on purpose: the
            // first survey of this goal seeds the baselines and does not count as
            // progress, so a wedged build cannot claim credit for the reading it
            // was already sitting on when the goal started.
            settlementIdentity: null,
            settlementBest: {}
        };
        // ONE GREPPABLE LINE PER PLAN CHANGE. "i have no idea what she's doing" was
        // partly that nothing ever wrote down what she decided or why - the reason
        // lived in a `say` string that went to commentary and nowhere else, so the
        // log recorded a stream of altoclef task churn with no intent attached to it.
        this._logObjective('plan');
        return this.activeGoal;
    }

    /**
     * Write the task chain to the log when it materially changes. Deduped on the
     * rendered line so a re-dispatch of the same step stays quiet.
     */
    _logObjective(reason) {
        try {
            const line = this._objectiveChain()?.line;
            if (!line || line === this._lastObjectiveLine) return;
            this._lastObjectiveLine = line;
            this.log('info', `[objective/${reason}] ${line}`);
        } catch { /* a readout must never be able to break the dispatch it describes */ }
    }

    /**
     * IS ALTOCLEF'S DEFENSE CHAIN HOLDING THE TICK RIGHT NOW?
     *
     * ⚠ THE JAR'S VERDICT WINS IN BOTH DIRECTIONS. `gameState.combat` comes from
     * MobDefenseChain itself on every poll and says `mode: 'none'` when nothing is
     * happening, so a present-but-calm reading means the user task really is getting
     * the tick and the watchdogs must run normally. Inferring combat from "a hostile
     * is nearby" would suspend them whenever she mines within sight of a zombie,
     * which is most of the game underground.
     *
     * A frame with NO `combat` key at all is an older companion, not a calm one -
     * see _applyState, which holds null rather than manufacturing a reading. Only
     * then do we fall back to evidence.
     */
    _inCombat(now = Date.now()) {
        const c = this.gameState.combat;
        if (c && typeof c === 'object') {
            const mode = String(c.mode || '').toLowerCase();
            return !!mode && mode !== 'none';
        }
        return Number(this.gameState.nearbyHostiles) > 0 &&
            now - (this._lastDamageAt || 0) < COMBAT_INFER_MS;
    }

    /**
     * SHE WAS IN THE MIDDLE OF SOMETHING AND DANGER TOOK IT OFF HER.
     *
     * ⚠ THIS IS THE HALF THE CLOCKS CANNOT FIX. Pausing the watchdogs stops a fight
     * being MISREAD as a failing task, but the pin recovery is a real, deliberate
     * abort: 45s held in one place while being hit means the job genuinely has to
     * stop, and it then walks her 120-260 blocks away. What was missing is that
     * nothing remembered what she had been doing, so "deal with the threat" was
     * always "deal with the threat and forget the errand".
     *
     * One frame, not a stack: the interesting case is the job she was on, and a
     * deep stack of half-finished intentions is how a bot ends up doing something
     * from four minutes ago for no visible reason.
     */
    _noteTaskInterrupted(goal, why) {
        if (!goal || !goal.action) return;
        const act = goal.requestedAction || goal.action;
        // a control verb is not an errand, and a stance she chose for herself
        // (idle/explore) is re-picked by the menu anyway.
        //
        // ⚠ `follow` IS THE EXCEPTION, and it is the case that prompted this. It is
        // excluded from RESUMABLE_ACTIONS for a good reason - that ledger can re-offer
        // a job TEN MINUTES later, and "resuming a follow after the person logged off
        // is a bot walking to where somebody used to be". This frame is a different
        // instrument: five minutes, and it checks the person is still standing there
        // before it moves. Being shot at once while escorting somebody must not mean
        // they have to ask again.
        if (NON_TASK_ACTIONS.has(act)) return;
        if (PERSISTENT_ACTIONS.has(act) && act !== 'follow') return;
        this._interrupted = {
            action: goal.requestedAction || goal.action,
            params: { ...(goal.params || {}) },
            why: why || 'something interrupted it',
            at: Date.now(),
            source: goal.source || 'autonomous',
            resumed: 0
        };
        this.log('info', `holding on to "${this._describeTask(this._interrupted.action, this._interrupted.params)}" to pick back up (${why})`);
    }

    /**
     * ...AND PICKING IT BACK UP ONCE THE DANGER IS ACTUALLY GONE.
     *
     * Sits high in the tick - above the homestead arc and the idle menu - because
     * going back to the thing she was already doing outranks choosing something new.
     * It deliberately does NOT run while she is still preempted, still being shot at,
     * or hurt: resuming into the fight she just left is the treadmill this codebase
     * has fixed twice under other names.
     */
    _resumeInterruptedStep() {
        const frame = this._interrupted;
        if (!frame) return null;
        const now = Date.now();
        if (now - frame.at > INTERRUPT_RESUME_WINDOW_MS) {
            this.log('info', `letting go of "${frame.action}" - too long ago to just pick back up`);
            this._interrupted = null;
            return null;
        }
        // the danger has to be over, not merely quieter
        if (this._taskPreempted(now)) return null;
        if (Number(this.gameState.nearbyHostiles) > 0) return null;
        if (now - (this._lastDamageAt || 0) < INTERRUPT_CALM_MS) return null;
        const health = Number(this.gameState.health);
        if (Number.isFinite(health) && health <= INTERRUPT_MIN_HEALTH) return null;
        // ⚠ AND IF IT WAS A PERSON, THEY HAVE TO STILL BE HERE. This is the exact
        // objection that keeps `follow` out of RESUMABLE_ACTIONS, answered rather
        // than ignored: walking back to where somebody used to be is worse than
        // having forgotten them. An empty roster means the jar cannot tell, so it
        // declines rather than guessing.
        if (frame.action === 'follow') {
            const who = String(frame.params?.target || '').toLowerCase();
            const here = (Array.isArray(this.gameState.nearbyPlayerNames)
                ? this.gameState.nearbyPlayerNames : []).map((n) => String(n).toLowerCase());
            if (!who || !here.includes(who)) {
                this._interrupted = null;
                return null;
            }
        }
        // ⚠ ONE GO. If it gets interrupted again the ordinary machinery (the stuck
        // streak, the destination memory, the blacklist) owns it from there - a frame
        // that re-armed itself would be a way to walk into the same mob forever.
        this._interrupted = null;
        // the pin recovery blacklisted the verb on its way out. That suppression was
        // about being pinned, not about the errand, and this is the one deliberate
        // exception to it - see _safeExecute's spawn-march exemption for the pattern.
        this._clearAvoid(frame.action);
        return {
            action: frame.action,
            params: { ...frame.params },
            say: `right - back to ${this._describeTask(frame.action, frame.params)}`
        };
    }

    /**
     * IS HER ACTUAL JOB WAITING FOR ANOTHER CHAIN TO FINISH?
     *
     * This is the question the watchdogs need answered, and the companion answers it
     * directly: `preempted` is `userChain.isActive() && current != userChain`, i.e.
     * she has a real job and something else is holding the tick.
     *
     * ⚠ WIDER THAN COMBAT, ON PURPOSE. Eating (FoodChain), an MLG bucket clutch and
     * the death screen preempt a task exactly as a fight does, and a job is no more
     * at fault for those. Anything that legitimately owns the tick should stop the
     * clock on the job it interrupted.
     *
     * ⚠ AND `combat.mode` IS NOT A SUBSTITUTE. It is a latch on MobDefenseChain that
     * can still read FIGHT/FLEE after the chain has lost the tick, so it answers
     * "what did she decide about that mob", not "is her job actually stopped".
     * It stays as the fallback for a jar too old to send `preempted`.
     */
    _taskPreempted(now = Date.now()) {
        const flag = this.gameState.preempted;
        if (typeof flag === 'boolean') return flag;
        return this._inCombat(now);
    }

    /**
     * PAUSE THE WATCHDOG CLOCKS FOR AS LONG AS THE FIGHT OWNS HER.
     *
     * Pushes the three PURE watchdog clocks forward by the elapsed time so a
     * preempted task does not age towards an abort it did not earn. Deliberately
     * NOT `startedAt`, which is narration ("running 4 min") and the persistent
     * dwell - that one is corrected explicitly, in the one arm that budgets on it.
     *
     * ⚠ BOUNDED. Credit is capped per goal (COMBAT_SUSPEND_MAX_MS) so an endless
     * fight cannot make a task immortal - past the ceiling the clocks run again and
     * the ordinary recoveries take her out of it. Capped per step too, so a poll
     * gap (a reconnect, a paused client) cannot hand over a huge credit at once.
     */
    _creditCombatSuspension(now) {
        const goal = this.activeGoal;
        const last = this._combatCreditAt || 0;
        this._combatCreditAt = now;
        if (!goal) return false;
        if (!this._taskPreempted(now)) return false;
        const elapsed = last ? Math.min(now - last, COMBAT_CREDIT_STEP_MAX_MS) : 0;
        if (elapsed <= 0) return true;
        const spent = goal.combatSuspendedMs || 0;
        const credit = Math.min(elapsed, Math.max(0, COMBAT_SUSPEND_MAX_MS - spent));
        if (credit <= 0) return true;              // ceiling reached: let them run
        goal.combatSuspendedMs = spent + credit;
        goal.lastProgressAt += credit;
        goal.lastInventoryProgressAt += credit;
        if (goal.anchorAt) goal.anchorAt += credit;
        return true;
    }

    _observeGoalProgress(partial = {}) {
        if (!this.activeGoal) return;
        const now = Date.now();
        // BEFORE anything is judged: a preempted task is not a stalling one.
        this._creditCombatSuspension(now);
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
                // ⚠ THE REVISIT CHECK MUST NOT BE GATED ON STANDING STILL, and it
                // costs the stall watchdog nothing to un-gate it: when `moved` is
                // true the movement vote above has ALREADY set `progressed`, and in
                // the surveyOnly case the inventory never votes at all. So `!moved`
                // only ever affected `lastInventoryProgressAt` - whose single reader
                // is _recoverLoopingGoal's confinement arm, the one watchdog whose
                // whole job is movement WITHOUT progress. During an orbit she is
                // moving by definition, so the guard forced `revisited` false, one
                // hotbar shuffle per five minutes kept `inventoryIsProgressing`
                // permanently true, and the orbit arm was permanently disarmed.
                // Returning to a state she has already been in is churn whether she
                // is walking or standing.
                const revisited = history.includes(inventorySignature);
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
            // ⚠ A NEW BEST, NOT A NEW VALUE - see _settlementAdvance. For
            // build_settlement the survey is the ONLY progress signal (surveyOnly
            // above ignores position and inventory), the stall budget is six
            // minutes and GOAL_MAX_RUNTIME_MS is null, so a survey that merely
            // CHANGES made a wedged build immortal: nothing else could ever end it.
            if (this._settlementAdvance(partial.settlementBuild)) {
                progressed = true;
                // The site really advanced, so whatever the builder refused may be
                // gone. Gated on a genuine advance for the same reason: this clears
                // a TEN MINUTE cooldown, and clearing it on any twitch of any
                // counter (including one going backwards, i.e. a creeper hole) let
                // the guard disarm itself about two seconds after it was armed.
                this._clearBlockedSite();
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
        this._avoidNote(goal.requestedAction || goal.action, LOOP_AVOID_MS, goal.params?.target);
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
        // the REQUESTED verb, not the rewritten one. `go_home` is flattened to
        // `move` before the pending record exists, so blacklisting `action` here
        // suppressed every walk she has (frontier, crowd drift, bed nook, spawn
        // march) while leaving the doomed `go_home` free to be re-issued.
        const failed = this.activeGoal?.requestedAction || this.activeGoal?.action || this.currentAction || null;
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
        // ⚠ THIS MOMENT WAS MUTE BOTH WAYS. the gameEvent above has no handler
        // anywhere, and the _pushCommentary two lines up is tagged 'pinned',
        // which the only commentary consumer drops outright (`kind !==
        // 'narration'` -> return). so being stuck in one spot getting chewed on
        // - as dramatic as this game gets - reached her mouth by no route at
        // all. the board is where it belongs: it competes instead of racing.
        this.noticeBoard.note('pinned',
            `i have been stuck in the same few blocks for ${heldSec} seconds with ${g.nearbyHostiles || 'some'} of them chewing on me`,
            0.9, { tags: ['danger'] });

        if (failed && !NON_TASK_ACTIONS.has(failed)) {
            this._avoidNote(failed, LOOP_AVOID_MS, g.pinnedTarget ?? this.activeGoal?.params?.target);
        }
        // ⚠ REMEMBER THE ERRAND BEFORE THROWING IT AWAY. Everything above is about the
        // MOB - stop, blacklist the verb, walk 120-260 blocks out - and all of it is
        // right. What was missing is that the job itself then existed nowhere: unless a
        // person happened to have asked for it (the only path that files a resumable
        // goal), being jumped on the way somewhere meant the destination was forgotten
        // AND suppressed. She deals with the threat, then comes back to it.
        this._noteTaskInterrupted(this.activeGoal, `mobs had me pinned for ${heldSec}s`);
        this.activeGoal = null;
        this.currentTask = 'getting out of a spot that was killing me';
        // evidence only: this path runs its own stop-and-retreat below, and a
        // concurrent break-out would just cancel it.
        this._noteStallHere({ breakOut: false });
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
        if (g.multiplayer === true && g.server) return String(g.server).slice(0, 80);
        // ⚠ A SINGLEPLAYER SAVE NOW NAMES ITSELF. this used to return null for
        // every singleplayer world, which means they all shared ONE identity and
        // one map - two saves overwrote each other's coastline, claims, home and
        // landmarks at matching coordinates. prefixed so a save called
        // "my-server.example" can never collide with the server of that name.
        // an older jar sends no saveName and still gets null ("do not filter"),
        // which is the previous behaviour rather than a new wrong answer.
        if (g.multiplayer !== true && g.saveName) return `sp:${String(g.saveName).slice(0, 76)}`;
        return null;
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

    /**
     * Did the build actually get FURTHER, or did a counter merely move?
     *
     * The java side learned this exact lesson already ("`noteProgress` forgave the
     * builder whenever the tally merely CHANGED... it now needs a new BEST") and the
     * node side then re-implemented the original bug: any change in any direction in
     * a 24-field JSON blob counted as progress. The documented builder oscillation -
     * place, break-for-path, pick up, place back - moves a counter +-1 every cycle,
     * so the wedge fed the very watchdog meant to catch it. `_waterWatchdog` is the
     * one place in this file that already gets this right; this is the same rule.
     *
     * Per FIELD bests, not one scalar, because the fields have wildly different
     * scales and - critically - a counter can APPEAR mid-build (the trench opens and
     * `trenchRemaining` jumps 0 -> 1240). A single summed score would read that as a
     * catastrophic regression and then refuse to see progress for 1240 blocks of
     * real work. A field seen for the first time just sets its baseline: not
     * progress, but not a stall either. The first move in the right direction is.
     *
     * `phase` is deliberately NOT consulted - the phase string is the oscillator.
     */
    _settlementAdvance(progress) {
        if (!progress || typeof progress !== 'object' || !this.activeGoal) return false;
        const num = (v) => {
            if (typeof v === 'boolean') return v ? 1 : 0;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        // A DIFFERENT SITE OR A DIFFERENT PLAN IS NEW WORK, not progress on the old
        // one, so the bests are thrown away rather than compared against.
        const identity = SETTLEMENT_IDENTITY_KEYS.map((k) => String(progress[k] ?? '')).join('|');
        const known = this.activeGoal.settlementIdentity !== null;
        // A DIFFERENT site, or the same site re-planned to a different footprint, is
        // genuinely new work rather than progress on the old one - so the bars are
        // thrown away and it counts once, or a re-plan would read as a stall. The
        // FIRST survey of a goal is not that: it is just the opening reading, and
        // crediting it would hand a build that started already wedged a free vote.
        const replanned = known && identity !== this.activeGoal.settlementIdentity;
        if (!known || replanned) {
            this.activeGoal.settlementIdentity = identity;
            this.activeGoal.settlementBest = {};
        }
        const best = this.activeGoal.settlementBest || (this.activeGoal.settlementBest = {});
        let advanced = false;
        for (const [field, higherIsBetter] of SETTLEMENT_PROGRESS_FIELDS) {
            const value = num(progress[field]);
            if (value === null) continue;
            const prior = best[field];
            if (prior === undefined) { best[field] = value; continue; }   // baseline only
            if (higherIsBetter ? value > prior : value < prior) {
                best[field] = value;
                advanced = true;
            } else if (!higherIsBetter && value - prior >= SETTLEMENT_SCOPE_JUMP) {
                // a whole phase of work just opened (see SETTLEMENT_SCOPE_JUMP).
                // Rebase the bar so the digging that follows can be seen, but do NOT
                // credit the discovery itself as progress.
                best[field] = value;
            }
        }
        return replanned || advanced;
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
            // and for exactly the same reason, digging the moat IS the work while
            // it is being dug. A four-deep ring two blocks wide is roughly 1250
            // breaks, so a signature blind to them condemns the longest job in the
            // whole plan - the survey would report the identical finished house
            // for six minutes while she is visibly stood in a hole.
            'trenchRemaining', 'trenchLightsRemaining',
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
            // ⚠ WHICH PLAN THIS HOUSE IS BUILT TO HAS TO GO ON THE WIRE. the relay
            // resolves the footprint for the version it is told and defaults to
            // the LATEST when told nothing - so a legacy v1 asking to resume its
            // own 14x9x8 would come back as the layered 13x21x11 at the same
            // anchor. that is building the big toaster on top of the house she
            // already lives in, which is exactly what was ruled out.
            planVersion: settlement.planVersion,
            // ⚠ AND SO DOES WHETHER THIS HOUSE GETS A MOAT. The java Settlement
            // carries `trenchEnabled` as its single gate - off, it has no trench
            // geometry, no schematic opinion below its own floor and no placement
            // veto - and the flag is rebuilt from the wire on every build. So a
            // build that forgets to say so is a build that fills the ditch back in.
            trench: this._trenchEnabled(params),
            target: settlement.name
        };
    }

    /**
     * IS SHE DIGGING A MOAT ROUND THIS ONE? Default NO, and that is load-bearing.
     *
     * A trench is roughly 1250 block breaks. On by default it would have every
     * homestead already standing read as incomplete at the next survey and start
     * digging unannounced, which is the same rule Settlement.trenchEnabled states
     * on the java side.
     *
     * Two ways to yes: the operator flag, or a caller that explicitly asked - the
     * `defense_trench` upgrade step and any chat/LLM request that carries
     * `trench: true`. Nothing else may turn it on by accident, so the check is for
     * a literal `true` rather than anything truthy.
     *
     * ⚠ THE FLAG LIVES ON `this.config`, the same door `port`/`actionTimeout`/
     * `debug` come through, because this module deliberately holds no db handle -
     * `_canonicalSettlementBuildParams` runs inside executeAction's synchronous
     * promise executor and could not await a config read anyway. The db key
     * `minecraft_trench_enabled` reaches it through `initialize({ trenchEnabled })`,
     * which node/modes.js reads when it arms minecraft mode.
     *
     * ⚠ THE ENV VAR IS AN OVERRIDE, so it is checked here rather than only as the
     * seed for `config.trenchEnabled` - otherwise the first mode switch would
     * quietly overwrite it with whatever the db happened to say, which on a box
     * with no ui is "nothing", and the operator's own switch would do nothing.
     */
    _trenchEnabled(params = {}) {
        if (params.trench === true) return true;
        if (DEFAULT_TRENCH_ENABLED) return true;
        return this.config.trenchEnabled === true;
    }

    /**
     * NORMALIZE build_plan / farm / place_block BEFORE THEY LEAVE THE HOUSE.
     *
     * Three separate reasons this cannot be left to the bridge:
     *
     *  - build_plan takes a blueprint id and nothing else identifies the job. An
     *    id the registry has never heard of translates fine and dies in-game, so
     *    it is checked here against the same table the chooser picks from.
     *  - farm reads its coordinates as a SET. AltoClef falls back to "where she
     *    stands" unless all three arrive, so an x/z with no y is not half a
     *    position, it is a DIFFERENT FIELD somewhere else. Fill the y in from
     *    where she actually is, or drop the pair and mean it.
     *  - place_block is allow-listed to lighting and shoring. The list is
     *    restated here so a refusal is a sentence rather than a bridge throw, and
     *    it is deliberately the same list: this verb must never become a way to
     *    build, because that is what build_plan and build_settlement are for.
     */
    _canonicalWorldBuildParams(action, params = {}) {
        const p = { ...params };
        const here = this._point(this.gameState.position);
        if (action === 'build_plan') {
            const id = String(p.blueprint || p.target || '').trim().toLowerCase().replace(/[ -]+/g, '_');
            if (!PROCEDURAL_PLANS[id]) {
                throw new Error(`"${id || 'that'}" is not a house i know how to build. the plans are ${Object.keys(PROCEDURAL_PLANS).join(', ')}`);
            }
            // WHERE THE HOUSE GOES, in the order that respects a decision already
            // made: the settlement she named, then the one she lives in, then the
            // ground under her feet. never a guess with a hole in it.
            let at = [p.x, p.y, p.z].every(Number.isFinite)
                ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null;
            // SOMEBODY ASKING HER TO HER FACE MEANS HERE, NOT HOME. without this the
            // home fallback below wins, so "build me a house" from a person standing
            // next to her 3000 blocks out sends her home to build it somewhere they
            // will never see - which reads as ignoring them just as much as silence.
            // opt-in, so her own brain's calls keep the settled home-first order.
            if (!at && p.here && here) at = { ...here };
            if (!at && p.settlementId) {
                const settlement = this.memory.getSettlement(p.settlementId);
                if (settlement?.anchor) at = { ...settlement.anchor };
            }
            if (!at) {
                const home = this._home();
                if (home?.position) at = { ...home.position };
            }
            if (!at) at = here;
            if (!at) {
                throw new Error('i have no idea where to put a house - give me x, y and z, or set_home somewhere first');
            }
            // ⚠ EVERY ROUTE ABOVE AIMS AT GROUND SHE IS PROBABLY STANDING ON OR
            // LIVING IN. `here` is her feet, the home fallback is the toaster's own
            // anchor, and a settlementId is a house that exists by definition - so
            // the DEFAULTS were the bug: "build a shelter" with no coordinates put a
            // 5x5 hut at the middle of the homestead floor (observed live, origin
            // 497,67,3376 inside a house spanning x[492..505] z[3374..3382]).
            //
            // Moving it is right even when the coordinates were explicit: nobody
            // asking for a house means "inside the one that is already there". She
            // always says where it went, so a surprise is impossible.
            const site = this._clearBuildSite(at, { kind: 'procedural' });
            if (!site) {
                throw new Error(`everything within ${SITE_SEARCH_MAX_PUSH} blocks of there is either my own build or ground i can't use - move me somewhere else and ask again`);
            }
            if (site.moved) {
                const why = `not building the ${PROCEDURAL_PLANS[id].label} on top of ${site.blocked.name} - moved it ${site.pushed} blocks out to ${site.x},${site.z}`;
                this._lastBuildSiteMove = {
                    at: Date.now(), blueprint: id, pushed: site.pushed,
                    blocked: site.blocked.name, from: site.from, to: { x: site.x, z: site.z }
                };
                try { this.recentEvents.record(why); } catch { /* narration is never a gate */ }
                this.log('info', `build_plan: ${why}`);
            }
            at = { x: site.x, y: site.y, z: site.z };
            const resolved = { ...p, blueprint: id, target: PROCEDURAL_PLANS[id].label, x: at.x, y: at.y, z: at.z };
            delete resolved.here;   // an intent flag, not something the bridge should see
            return resolved;
        }
        if (action === 'farm') {
            const asked = String(p.mode || p.target || 'create').trim().toLowerCase();
            const mode = asked === 'expand' ? 'expand' : 'create';
            if (asked !== 'create' && asked !== 'expand') {
                throw new Error(`farm is "create" for new ground or "expand" for the field i'm standing in - "${asked}" is neither`);
            }
            const radius = Number.isFinite(Number(p.radius))
                ? Math.min(8, Math.max(2, Math.round(Number(p.radius)))) : 4;
            const out = { ...p, mode, target: mode, radius };
            const hasX = Number.isFinite(Number(p.x));
            const hasY = Number.isFinite(Number(p.y));
            const hasZ = Number.isFinite(Number(p.z));
            if (hasX && hasZ && !hasY && here) out.y = here.y;
            else if (hasX && hasZ && hasY) { out.x = Math.round(p.x); out.y = Math.round(p.y); out.z = Math.round(p.z); }
            else if (!(hasX && hasZ)) { delete out.x; delete out.y; delete out.z; }
            else { delete out.x; delete out.y; delete out.z; }   // a column with no ground under it means HERE, said plainly
            return out;
        }
        // place_block
        const block = String(p.block || p.target || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[ -]+/g, '_');
        if (!PLACEABLE_BLOCKS.has(block)) {
            throw new Error(`place_block carries lights and shoring, not building material - "${block || 'nothing'}" is not one of ${[...PLACEABLE_BLOCKS].join(', ')}`);
        }
        if (![p.x, p.y, p.z].every(Number.isFinite)) {
            throw new Error(`putting a ${block.replace(/_/g, ' ')} somewhere exact needs x, y and z - for "just put one down near me" use place instead`);
        }
        return { ...p, block, target: block, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
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
        const existing = this.memory.getMainSettlement?.(this._worldId());
        const sameAnchor = existing && this._dimMatches(existing.dimension, home.dimension) &&
            Math.hypot(existing.anchor.x - home.position.x, existing.anchor.z - home.position.z) <= 3;
        // WHICH PLAN THIS HOUSE IS BUILT TO, and the same rule as the appliance
        // ledger one line below: state that belongs to the OLD house does not
        // follow her to a new anchor.
        //
        // this record is rebuilt from `...existing.toJSON()`, which carries the
        // saved planVersion, and the constructor honours it. so without this a
        // brand new home site inherited v1 forever and the layered toaster - the
        // whole point of v2, correct on the java side - was simply unreachable.
        // staying at the same anchor MUST keep the version the standing house was
        // built to, or she starts converting a house she already lives in.
        const planVersion = sameAnchor ? existing?.planVersion : TOASTER_PLAN_LATEST;
        const furnaces = this._homeFurnaceCount();
        const furnaceTarget = Math.min(this._fixtureTarget(existing, 'furnace'), Math.max(1, furnaces + 1));
        // the footprint follows the version, or a v1 house gets measured against a
        // 13x21 shell it does not have.
        const dimensions = toasterHomesteadDimensions(planVersion);
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
        // ⚠ A MOVE USED TO DELETE THE HOUSE SHE MOVED OUT OF. `existing.toJSON()`
        // carries `id`, and upsertSettlement matches on id first, so re-pointing
        // home at new ground REWROTE the old record's anchor in place - the old
        // building stayed standing in the world and vanished from the ledger, so
        // nothing could check against it, protect it from her pickaxe, or stop her
        // founding the next one on top of it. Her `former home` favourite at
        // -2287,3254 is one of these; there is no settlement record for it.
        //
        // Only a GENUINE move mints a new record. A nudge of a few blocks is the
        // same house re-anchored, and keeping a ghost of it would be worse than
        // the bug: the ghost sits inside the new house's separation and would
        // refuse the ground she is standing on forever.
        const movedAway = !!existing && (
            !this._dimMatches(existing.dimension, home.dimension) ||
            existing.distanceTo(home.position) >= this._settlementSeparation(existing, dimensions));
        const carried = existing ? existing.toJSON() : {};
        if (movedAway) {
            delete carried.id;          // a new house gets a new record
            delete carried.createdAt;   // ...and its own age, or the id embeds the old one
            this.log('info', `home moved ${Math.round(existing.distanceTo(home.position))} blocks - keeping "${existing.name}" on the map as a separate build`);
        }
        const settlement = new ToasterHomestead({
            ...carried,
            name: home.name || 'the homestead',
            anchor: home.position,
            dimension: home.dimension,
            world: home.world || this._worldId(),
            furnaceTarget,
            planVersion,
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

    /**
     * HOW FAR APART TWO OF HER BUILDINGS HAVE TO STAND.
     *
     * One rule, one place. `toasterYardSeparation` answers the geometric half -
     * neither yard nor trench reaching the other's walls - and the floor adds the
     * elbow room that makes two buildings read as two buildings.
     */
    _settlementSeparation(a, b) {
        return Math.max(toasterYardSeparation(a, b), SETTLEMENT_MIN_SEPARATION);
    }

    /**
     * A STAND-IN FOR THE THING SHE IS ABOUT TO BUILD, so the separation rule has
     * two footprints to measure. Only `width`/`depth` are ever read.
     */
    _candidateFootprint(kind = 'homestead') {
        if (kind === 'outpost') return toasterOutpostDimensions();
        if (kind === 'procedural') {
            return { width: PROCEDURAL_PLAN_MAX_FOOTPRINT, depth: PROCEDURAL_PLAN_MAX_FOOTPRINT };
        }
        return toasterHomesteadDimensions(TOASTER_PLAN_LATEST);
    }

    /**
     * WHICH BUILDING OF HER OWN A PROPOSED SITE WOULD LAND ON, or null.
     *
     * ⚠ THIS IS THE CHECK THAT DID NOT EXIST. `setOutpostHere` had it and nothing
     * else did, so a homestead, a relocation and every `build_plan` could be
     * founded on top of a house she was already living in - observed live: a 5x5
     * shelter resolved to the home anchor and started going up inside the
     * 14x9 toaster standing there.
     *
     * ⚠ AND IT IS NOT THE SAME QUESTION AS THE COMPANION'S BLOCK SCAN.
     * `builtColumns` reads the ground and cannot say WHOSE it is - it misses
     * cobblestone entirely (the first rung of the material ladder, i.e. every
     * house on its first night) and cannot be taught to see it without calling
     * natural cobble a village. The registry knows the difference because she
     * wrote it down.
     */
    _conflictingSettlement(point, { kind = 'homestead', ignoreId = null, dimension = null } = {}) {
        const p = this._point(point);
        if (!p) return null;
        const candidate = this._candidateFootprint(kind);
        const want = dimension == null ? this.gameState.dimension : dimension;
        let worst = null;
        let list = [];
        try { list = this.memory.listSettlements(this._worldId()) || []; } catch { return null; }
        for (const entry of list) {
            if (!entry || (ignoreId && entry.id === ignoreId)) continue;
            // a house in the nether is not in the way of a house in the overworld
            if (want != null && !this._dimMatches(entry.dimension, want)) continue;
            const need = this._settlementSeparation(entry, candidate);
            const distance = entry.distanceTo(p);
            if (distance >= need) continue;
            // the tightest squeeze is the one worth naming, not the first found
            const squeeze = need - distance;
            if (!worst || squeeze > worst.squeeze) {
                worst = { settlement: entry, name: entry.name, distance, need, squeeze };
            }
        }
        return worst;
    }

    /**
     * EVERY BUILDING OF HERS AS A CIRCLE TO STAY OUT OF, for `_pickLandingSpot`.
     *
     * Each carries its own radius rather than one shared number, because the
     * separation a v2 toaster needs and the one an outpost needs are different
     * and using the larger for both would quietly make good ground unsettleable.
     */
    _settlementKeepouts(kind = 'homestead', { dimension = null } = {}) {
        const candidate = this._candidateFootprint(kind);
        const want = dimension == null ? this.gameState.dimension : dimension;
        let list = [];
        try { list = this.memory.listSettlements(this._worldId()) || []; } catch { return []; }
        return list
            .filter((entry) => entry && (want == null || this._dimMatches(entry.dimension, want)))
            .map((entry) => ({
                x: entry.anchor.x, z: entry.anchor.z,
                min: this._settlementSeparation(entry, candidate)
            }));
    }

    /**
     * THINK ABOUT WHERE THE HOUSE GOES BEFORE BUILDING IT.
     *
     * Given the spot that was asked for, hand back one that is actually free:
     * the requested point when it is already clear, otherwise the best ground on
     * a widening ring around it. Returns null only when nothing within
     * SITE_SEARCH_MAX_PUSH works, which the caller must treat as "do not build".
     *
     * ⚠ IT SEARCHES OUTWARD FROM WHAT WAS ASKED FOR, not from her feet. "Build a
     * house at the homestead" means she wanted it NEAR the homestead; the answer
     * is the nearest clear ground to there, not a site chosen on the other side
     * of the map because that is where she happened to be standing.
     */
    _clearBuildSite(requested, { kind = 'homestead', ignoreId = null, dimension = null } = {}) {
        const asked = this._point(requested);
        if (!asked) return null;
        const opts = { kind, ignoreId, dimension };
        const blocked = this._conflictingSettlement(asked, opts);
        if (!blocked) return { ...asked, moved: false, from: asked, blocked: null, pushed: 0 };
        this._ensureTerrainLoaded();
        // start the search at the distance that would actually clear the thing in
        // the way - rings inside it are known-bad before they are tested.
        const first = Math.ceil(blocked.need);
        let best = null;
        for (let push = first; push <= first + SITE_SEARCH_MAX_PUSH; push += SITE_SEARCH_RING_STEP) {
            for (let i = 0; i < SITE_SEARCH_BEARINGS; i++) {
                // offset each ring by half a step so successive rings do not all
                // test the same twelve bearings out from the same centre
                const angle = (i / SITE_SEARCH_BEARINGS) * Math.PI * 2 +
                    (push / SITE_SEARCH_RING_STEP) * (Math.PI / SITE_SEARCH_BEARINGS);
                const x = Math.round(asked.x + Math.cos(angle) * push);
                const z = Math.round(asked.z + Math.sin(angle) * push);
                if (this._conflictingSettlement({ x, y: asked.y, z }, opts)) continue;
                // the same ground rules every other destination obeys
                if (this._isClaimedCell(x, z)) continue;
                if (this._isRejectedCell(x, z)) continue;
                if (this._cellState(x, z) === 'wet') continue;
                if (this._inSpawnRegion(x, z)) continue;
                // prefer dry, prefer known, prefer close - in that order, and
                // closeness last so "clear" never loses to "convenient".
                const route = this._routeTerrain(asked, x, z);
                if (route.wet > 0) continue;
                const score = route.dry * 4 +
                    (this._cellState(x, z) === 'dry' ? 2 : 0) +
                    (1 - push / (first + SITE_SEARCH_MAX_PUSH));
                if (!best || score > best.score) best = { x, z, score, push };
            }
            // a whole ring of clear ground is enough; widening further only moves
            // her away from what she asked for.
            if (best) break;
        }
        if (!best) return null;
        return {
            x: best.x, y: asked.y, z: best.z,
            moved: true, from: asked, blocked, pushed: Math.round(best.push)
        };
    }

    /**
     * HOW MANY OF THIS FIXTURE **THIS HOUSE'S OWN PLAN** HOLDS.
     *
     * ⚠ NOT A ROLE CONSTANT. `toasterFixtureTarget(role, kind)` reads the v1
     * ascii map, so a v2 (layered) house was being measured against v1's
     * numbers - and the layered plan contains NO SMOKER SQUARES AT ALL: in that
     * plan `S` is an intentional opening (the toast slots), not a smoker. Any
     * step gated on smokers reaching a v1 target inside a v2 house has a
     * completion condition that can never be true, which is the "restock
     * threshold the restock itself can never reach" shape documented twice
     * elsewhere in this file.
     *
     * `applianceSlots()` IS the plan, whichever version the record carries, and
     * it already enumerates every course of every stack. The role constant
     * survives only as the answer when there is no settlement to ask.
     */
    _fixtureTarget(settlement, kind) {
        try {
            if (typeof settlement?.applianceSlots === 'function') {
                return settlement.applianceSlots().filter((slot) => slot.kind === kind).length;
            }
        } catch { /* a malformed record falls back to the plan constant */ }
        return toasterFixtureTarget(settlement?.role || 'homestead', kind);
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
            // THIS HOUSE'S plan's number, the same one _publicHomeProject
            // reports - the settlement's own `furnaceTarget` is a vestigial
            // expansion ratchet and having two answers under one name is a trap.
            // read off the settlement rather than the role, because v1 and v2
            // hold different fixtures (v2 holds no smokers at all).
            furnaceTarget: this._fixtureTarget(settlement, 'furnace'),
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
        // WHICH HOUSE THIS IS. Everything else in this readout is toaster-shaped
        // (the gallery, the yard, the toast slots), so a procedural house has to
        // say so or she narrates a program her house was never built to.
        const planId = this._settlementPlan(spec.settlement)?.plan || TOASTER_PLAN_ID;
        const planLabel = planId === TOASTER_PLAN_ID
            ? 'toaster' : (PROCEDURAL_PLANS[planId]?.label || planId.replace(/_/g, ' '));
        const next = this._nextApplianceSlot(spec.settlement);
        const nextAppliance = spec.met ? (next?.kind || null) : null;
        const completedUnits = installed + (spec.met ? 1 : spec.percent / 100) * slots.length * 0.25;
        const totalUnits = slots.length * 1.25;
        return {
            id: spec.settlement.id,
            plan: planId,
            planLabel,
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
            // ⚠ TARGETS COME FROM THIS HOUSE'S PLAN, not from a role constant.
            // the layered (v2) toaster has NO SMOKER SQUARES AT ALL - there `S`
            // is an intentional opening, the toast slots - so measuring a v2
            // house against v1's twelve smokers is a target that can never be
            // met, and anything gated on it never finishes.
            furnaceTarget: this._fixtureTarget(spec.settlement, 'furnace'),
            smokerCount,
            nextAppliance,
            yard: { margin: TOASTER_YARD_MARGIN, clear: spec.yardClear, remaining: spec.yardRemaining },
            program: {
                shell: { complete: spec.met ? 1 : 0, target: 1, fractional: spec.percent / 100 },
                appliances: { complete: installed, target: slots.length },
                furnaces: { complete: inPlan('furnace'), target: this._fixtureTarget(spec.settlement, 'furnace') },
                smokers: { complete: inPlan('smoker'), target: this._fixtureTarget(spec.settlement, 'smoker') },
                chests: { complete: inPlan('chest'), target: this._fixtureTarget(spec.settlement, 'chest') },
                craftingTables: { complete: inPlan('crafting_table'), target: this._fixtureTarget(spec.settlement, 'crafting_table') },
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
        // routed through the shared rule so an outpost and a homestead cannot
        // disagree about how far apart two of her buildings stand.
        const overlaps = this.memory.listSettlements(this._worldId()).some((entry) =>
            entry.distanceTo(outpost.anchor) < this._settlementSeparation(entry, outpost));
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
    /**
     * WHO IS ON THIS SERVER, by the name the room uses for them.
     *
     * ⚠ `onlinePlayerNames` was computed and sent EVERY POLL and read in exactly one
     * place - a field initializer. She had the whole tab list twice a second and could
     * not name one person on it. It goes AFTER nearby (somebody in the room outranks a
     * name in a list) and BEFORE the chat roster, because the chat roster is a RAM cache
     * of who has spoken and happily offers people who logged off an hour ago.
     *
     * ⚠ ABSENT MEANS "THIS JAR CANNOT TELL", NEVER "NOBODY IS ONLINE" - an older
     * companion sends no such key and must degrade to the old two sources, not to an
     * empty server.
     */
    onlineNames() {
        return Array.isArray(this.gameState.onlinePlayerNames) ? this.gameState.onlinePlayerNames : [];
    }

    knownPlayers(limit = 12) {
        const roster = [...(this._chatRoster || new Map()).entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name]) => name);
        const nearby = Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames : [];
        const online = this.onlineNames();
        const seen = new Set();
        const out = [];
        for (const name of [...nearby, ...online, ...roster]) {
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
            this._bridgePlayerToRag(who, { immediate: kind !== 'sighting' });
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

    // is this person standing in the world with her right now? somebody in the
    // room who asks for something is talking to HER, whether or not they used her
    // name - which is why the request lane lets them skip the flood floor.
    // the companion reports this list, so it is the world's answer and not a guess.
    _isNearbyPlayer(key) {
        const k = String(key || '').toLowerCase();
        if (!k) return false;
        const nearby = Array.isArray(this.gameState.nearbyPlayerNames) ? this.gameState.nearbyPlayerNames : [];
        // ⚠ MATCH EITHER NAME. `nearbyPlayerNames` carries the GAME PROFILE name
        // while chat carries the RENDERED one, and a rank plugin makes those two
        // different strings for the same human - so this compare silently failed
        // for exactly the people whose server decorates names, and a person stood
        // beside her paid the distant-stranger request floor. `nearbyPeople`
        // carries both, so ask it as well.
        if (nearby.some((n) => String(n || '').toLowerCase() === k)) return true;
        return this._peopleAround().some((p) => p.key === k || p.displayKey === k);
    }

    /**
     * WHO IS ACTUALLY STANDING AROUND HER, with distance and bearing.
     *
     * ⚠ AN ABSENT `nearbyPeople` MEANS "THIS JAR CANNOT TELL", NEVER "NOBODY IS
     * HERE". an older companion sends no such field, and reading that as an empty
     * room would make every player-shaped perception below silently false rather
     * than absent - she would confidently ignore people. `_peopleKnown()` is the
     * capability question and every consumer asks it first, the same discipline
     * `_containersKnown()` established for the pantry.
     */
    _peopleKnown() {
        return Array.isArray(this.gameState.nearbyPeople);
    }

    _peopleAround() {
        const raw = this.gameState.nearbyPeople;
        if (!Array.isArray(raw)) return [];
        const me = String(this.gameState.username || '').toLowerCase();
        return raw
            .map((p) => {
                const name = String(p?.name || p?.display || '').trim();
                if (!name) return null;
                return {
                    name,
                    display: String(p?.display || p?.name || '').trim(),
                    key: name.toLowerCase(),
                    displayKey: String(p?.display || '').toLowerCase(),
                    distance: Number.isFinite(Number(p?.dist)) ? Number(p.dist) : null,
                    dir: p?.dir || null,
                    vert: p?.vert || null,
                    watching: p?.watching === true,
                    sneaking: p?.sneaking === true,
                    onFire: p?.onFire === true,
                    hurt: p?.hurt === true,
                    threats: Number(p?.threats) || 0,
                    holding: p?.holding || null
                };
            })
            .filter((p) => p && p.key !== me);
    }

    /** the nearest person, or null - the one a bare "look at them" means. */
    _nearestPerson() {
        return this._peopleAround()
            .slice()
            .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))[0] || null;
    }

    _findPerson(who) {
        const k = String(who || '').toLowerCase();
        if (!k) return null;
        return this._peopleAround().find((p) => p.key === k || p.displayKey === k) || null;
    }

    /**
     * TURN AND LOOK AT SOMEBODY.
     *
     * The single most-requested piece of body language and the cheapest: the
     * companion holds the rotation for a couple of seconds, standing down while
     * Baritone is steering, so this is safe to fire mid-anything.
     *
     * ⚠ BEST-EFFORT, ALWAYS. a gaze is punctuation on something else she is
     * doing - answering, being spoken to, noticing an arrival - and it must never
     * be able to fail that something. every path here swallows: not in the world,
     * they walked off, telemetry stale, the action refused. she just doesn't turn.
     *
     * ⚠ RATE-LIMITED PER PERSON, because the alternative is a look fired on every
     * line of a fast conversation, which is a command per line at the companion
     * and a head that never settles.
     */
    _lookAtPerson(who, { reason = null, hold = GAZE_HOLD_S } = {}) {
        try {
            const person = this._findPerson(who);
            // ⚠ only look at somebody who is REALLY THERE. `look_at` errors on a
            // name it cannot see, and firing one at a viewer typing from twitch
            // would be a guaranteed error every single message.
            if (!person) return false;
            const now = Date.now();
            if (now - (this._gazeAt.get(person.key) || 0) < GAZE_GAP_MS) return false;
            this._gazeAt.set(person.key, now);
            // fire and forget - `look` is a NON_TASK_ACTION so it never owns the
            // action slot and cannot displace what she is doing.
            this.executeAction('look', { target: person.name, hold }, { source: 'social' })
                .catch((err) => this.log('debug', `look at ${person.name} (${reason || 'social'}) declined: ${err.message}`));
            return true;
        } catch (err) {
            this.log('debug', `look at ${who} failed: ${err.message}`);
            return false;
        }
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

    // ⚠ EVERY DECLINE CARRIES A REASON. this function has a dozen ways to say no
    // and used to say all of them as a bare `{surface:false}`, so a line that
    // never reached her was indistinguishable from one that never arrived. the
    // reason is for the log only - callers read `.surface`/`.addressed`/`.request`
    // exactly as before.
    shouldSurfaceChat(sender, text) {
        const no = (reason) => {
            console.log(`[mc-chat] not surfaced (${reason}) <${sender}> ${String(text || '').slice(0, 80)}`);
            return { surface: false, reason };
        };
        const s = String(sender || '').trim();
        const t = String(text || '').trim();
        if (!s || !t) return no('empty sender or text');
        this._rememberPlayer(s);
        // record WHAT they said, not just that they spoke. gated to real conversation
        // (command noise is filtered on the next line) so the roster stays about people.
        if (!/^[\/!.#@]/.test(t)) this._rememberPlayerDurably('chat', s, t);
        if (this.gameUsername && s.toLowerCase() === String(this.gameUsername).toLowerCase()) return no('her own username');
        if (/^[\/!.#@]/.test(t)) return no('command noise, not conversation');
        const now = Date.now();
        const key = s.toLowerCase();
        // SHE LOOKS OVER WHEN SOMEBODY SAYS HER NAME.
        //
        // ⚠ ABOVE EVERY RATE LIMIT BELOW, ON PURPOSE. those gates decide whether a
        // line is worth ANSWERING, which is a different question from whether it
        // was aimed at her - and looking up at somebody who said your name and
        // then not replying is a thing people do constantly. gating the glance on
        // the reply gate would mean the second line of a fast conversation gets no
        // acknowledgement at all.
        //
        // `_lookAtPerson` no-ops for anybody who is not physically in the world
        // with her, so a twitch viewer typing her name never fires one.
        if (CHAT_ADDRESSED_RE.test(t) || this._inChatExchange(key)) {
            this._lookAtPerson(s, { reason: 'spoken to' });
        }
        if (this._chatSenderLastAt.size > 300) this._chatSenderLastAt.clear();
        const senderLast = this._chatSenderLastAt.get(key) || 0;
        if (this.gameState.multiplayer !== true) {
            if (now - senderLast < CHAT_SENDER_GAP_MS) return no('singleplayer per-sender gap');
            this._chatSenderLastAt.set(key, now);
            return { surface: true, addressed: true, owner: false };
        }
        // ⚠ ASK `isOwner`, NOT `key === MINECRAFT_OWNER`. the same human answers
        // to more than one name - "the owner" on stream, "owner_ingame" in game - and a
        // server that decorates names, or a second account, would otherwise
        // read as a stranger to the one person whose lines always matter.
        const owner = isOwner(key);
        const addressed = CHAT_ADDRESSED_RE.test(t);
        // someone mid-exchange who turns and names ANOTHER player has changed who
        // they are talking to. that still belongs to the overhear branch below.
        const aside = !addressed && !!this.addressedToSomeoneElse(t);
        const exchange = aside ? null : this._inChatExchange(key);
        if (owner || addressed || exchange) {
            // inside a live exchange two quick lines are one thought, not spam
            const gap = (exchange && !addressed && !owner) ? CHAT_EXCHANGE_GAP_MS : CHAT_SENDER_GAP_MS;
            if (now - senderLast < gap) return no('addressed/owner, but inside the per-sender gap');
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
            if (CHAT_GREETING_RE.test(t) || t.length < 40) return no('short line aimed at another player');
            // longer exchanges can still be overheard, but she is TOLD who it was
            // for so she never answers on their behalf.
            if (now - this._lastAmbientChatAt < CHAT_AMBIENT_GAP_MS) return no('overheard: ambient gap');
            if (Math.random() > CHAT_AMBIENT_SAMPLE) return no('overheard: ambient sample');
            this._lastAmbientChatAt = now;
            this._chatSenderLastAt.set(key, now);
            return { surface: true, addressed: false, owner: false, toSomeoneElse };
        }
        // ANYONE MAY ASK HER FOR SOMETHING - they do not have to say her name, and
        // it must not come down to a coin flip. this lane is the difference between
        // a bot that only answers to an incantation and a person in the world.
        // it stays BELOW the toSomeoneElse branch above on purpose: "marble can you
        // build me a farm" is still marble's job, not hers.
        if (this._looksLikeRequest(t)) {
            if (now - senderLast < CHAT_SENDER_GAP_MS) return no('request, but inside the per-sender gap');
            // standing in the room with her = talking to her. anyone further off
            // pays the request floor so a chatty server cannot flood her brain.
            if (!this._isNearbyPlayer(key)) {
                if (now - this._lastRequestChatAt < CHAT_REQUEST_GAP_MS) return no('request from a distant player, inside the request gap');
                this._lastRequestChatAt = now;
            }
            this._chatSenderLastAt.set(key, now);
            // `request` - NOT `addressed`. she was asked, but they did not name her,
            // so the prompt must not tell her they were waiting on her personally.
            return { surface: true, addressed: false, owner: false, request: true };
        }
        // ambient chatter: join in occasionally like a person, never every line
        if (t.length < 8) return no('ambient chatter, too short');
        if (now - this._lastAmbientChatAt < CHAT_AMBIENT_GAP_MS) return no('ambient gap');
        if (Math.random() > CHAT_AMBIENT_SAMPLE) return no('ambient sample');
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
        // ⚠ OUTSIDE the NON_TASK_ACTIONS guard, because `eat` is a SAFETY action and
        // never inside it. an ack that never came is the same evidence as an eat
        // that failed, and without this the EAT_FAIL_STREAK backoff - the guard put
        // in after the 2026-08-01 eat freeze - could never arm on the timeout path,
        // which is the path a wedged client actually takes.
        if (pending.action === 'eat') this._noteEatOutcome(false);
        if (!NON_TASK_ACTIONS.has(pending.action)) {
            this._noteTaskOutcome();
            try { this.memory.recordFailure(pending.action, pending.params?.target, reason); } catch { /* best-effort */ }
            // a crop run that timed out is the same evidence as one that failed:
            // she went, she asked, she came back with nothing. so is a dig.
            this._noteFoodRunFailed(pending);
            this._noteOreRunFailed(pending);
            this._noteUpgradeOutcome(pending, false);
            // ⚠ THE GOAL LEDGER IS A TERMINAL PATH TOO, and it was the one ledger
            // this path forgot. a timeout is not an interruption - nobody changed
            // her mind, the companion simply never answered - so it is exactly the
            // evidence GOAL_ATTEMPT_LIMIT is counting. without it a goal dispatched
            // while the client thread is wedged never spends an attempt and
            // _resumeGoalStep re-dispatches it on every 90s window forever.
            this._noteGoalOutcome(pending, false);
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
        // ⚠ RESOLVE THE SENDER TOO, not just the fallback. stream chat labels
        // her owner `the owner` while the game only knows `owner_ingame`, so a "follow
        // me" typed into the stream used to hand the game a username that has
        // never existed. an unrecognised name passes through untouched.
        const speaker = resolvePlayerName(String(inGameSender || '').trim() || ownerName() || '') || null;

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
                return ownerName() ? { action: 'follow', target: ownerName() } : null;
            }
            // "follow the owner" names a real person by the name the room uses for
            // him; the game needs the username. anyone else is passed through.
            return { action: 'follow', target: resolvePlayerName(m[1]) };
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
        // "there's nothing there" - somebody can see the field is dead before her
        // own three-strike counter gets there. BEFORE the bread rule, which owns
        // the word wheat and would read "the wheat spot is empty" as a bake order.
        //
        // ⚠ THIS IS AUTO-EXECUTED (_actOnRequest runs a parsed suggestion with no
        // confirmation), so it has to be narrow enough that an ordinary sentence
        // cannot trigger it. two things it must never eat:
        //   - "drop me some wheat" / "clear the food chest": in minecraft `drop`
        //     means GIVE ME AN ITEM, and it was reading as a delete.
        //   - a question about a harvest ("did you get that wheat harvested?").
        // and it never deletes by KIND from chat - the widest a viewer can go is
        // the field she is standing in.
        const noun = /\b(wheat|fields?|farms?|crops?|berry|berries)\b/;
        // "my farm is dead" is somebody else's farm. ⚠ ONLY first-person-plural and
        // singular: on her own stream "her field" almost always means BURNT's field,
        // so excluding his|her|their threw away the most natural way to tell her.
        const theirs = /\b(my|our)\s+\w*\s*(wheat|fields?|farms?|crops?)\b/;
        // ONE adjective list for both copula shapes - they were written separately
        // and had already drifted ("the field's depleted" was silently rejected).
        const gone = '(empty|depleted|dead|bare|barren|picked clean)';
        const bare = new RegExp(`\\b(is|are|was|were|looks?|r)\\s+${gone}\\b`).test(t)
            || new RegExp(`['’]s\\s+${gone}\\b`).test(t)
            || /\bnothing (there|here|left)\b/.test(t)
            || /\bno (wheat|crops?|food)\s+(there|here)\b/.test(t);
        if (!/\?\s*$/.test(t) && !theirs.test(t) && bare && (noun.test(t) || /\bnothing (there|here)\b/.test(t))) {
            // A REPORT, NOT A DELETE - it starts the regrow clock exactly like her
            // own eyes would. a viewer who is wrong costs her 20 minutes; a viewer
            // who is wrong under a delete costs her the field.
            // scoped to the crop they actually named where they named one, so
            // "the wheat is gone" cannot also clock a berry patch three blocks away.
            const kind = /\bberr/.test(t) ? 'berries' : (/\bwheat\b/.test(t) ? 'wheat' : null);
            return { action: 'forget_food', params: { report: true, kind } };
        }
        // the explicit forget DELETES, so it has to be a real instruction. ⚠ ANCHORED
        // AT THE START: `(^|\b)` anchors nothing - `\b` is true at the front of every
        // word - so "dont forget the wheat field is where the chest is" parsed as an
        // imperative and deleted the field on a line that means the opposite.
        if (/\b(don'?t|do not|never|didn'?t|dont)\s+forget\b/.test(t)) return null;
        if (/^\s*(pls\s+|please\s+)*(forget|delete)\s+(that|the|this|ur|your|my)?\s*\w*\s*(wheat|food|berry|crop)?\s*(spot|field|farm|patch)\b/.test(t)) {
            return { action: 'forget_food', params: {} };
        }
        // "stock up on food" - the forage trip, not a bite. FIRST, because the
        // bread rule below owns the verb `get` and would take "go get some food"
        // as a bake order in a biome that may not have a stalk of wheat in it.
        // an explicit "stock up on bread" still means bread, so the bread noun
        // wins the line back.
        // ⚠ the verb is `stock up`/`stockpile` ONLY. a bare `stock` also matches the
        // NOUN PHRASE "in stock", so "got any food in stock?" - a question about her
        // bag - became a multi-minute forage trip.
        if (/\b(stock up|stockpile)\b/.test(t) && /\b(food|supplies|pantry)\b/.test(t) && !/\bbread\b/.test(t)) {
            return { action: 'stock_food', params: { amount: FOOD_RESERVE_UNITS } };
        }
        // A FARM, WHICH SHE HAS BEEN ABLE TO BUILD ALL ALONG AND COULD NOT BE ASKED FOR.
        // `farm` is a first-class action with a whole java task behind it, and there was
        // no route to it from a person's mouth - so "make a wheat farm", asked four times
        // in one night, parsed to nothing, fell through to freeform, and died. it sits
        // BELOW the forget_food report rule (which owns "the farm is dead") and above the
        // generic craft/collect rules, which would otherwise eat the noun.
        // ⚠ this AUTO-EXECUTES, so a question is never an order and somebody else's farm
        // is never hers to dig - both guards mirror the forget_food rule above.
        if (!/\?\s*$/.test(t) && !theirs.test(t)
            && /\b(farm|field|crops?|plantation)\b/.test(t)
            && !/\b(?:go|head|walk|travel|return|back)\s+(?:back\s+)?to\b/.test(t)) {
            // "make it bigger" is a different job from "make one" - expand works the
            // ground she is standing on, create breaks new ground.
            if (/\b(expand|extend|widen|enlarge|bigger|grow|more)\b/.test(t)) {
                return { action: 'farm', params: { mode: 'expand' } };
            }
            if (/\b(make|build|start|plant|set up|dig|create|need|want)\b/.test(t)) {
                return { action: 'farm', params: { mode: 'create' } };
            }
        }
        // A HOUSE, same story: five procedural blueprints wired end to end and no way to
        // ask for one. the toaster stays out of this deliberately - it is a project she
        // chooses, not something a passer-by can start for her.
        // ⚠ THE POSSESSIVE GUARD HAS TO COVER THE WHOLE NOUN SET, not just `house`.
        // it read `(my|your|...)\s+house`, so "make this your BASE" - which is the
        // set_home rule's own phrasing - matched `base` + `make` and was answered by
        // dropping a wood_house where she stood. same hole for "your outpost",
        // "their shack". a possessive means the building is somebody's already,
        // which is the one thing that is never a request to build one.
        if (!/\?\s*$/.test(t)
            && !/\b(?:my|your|their|his|her)\s+(house|shelter|hut|cabin|shack|base|roof|outpost)\b/.test(t)
            && /\b(house|shelter|hut|cabin|shack|base|roof|outpost)\b/.test(t)
            && /\b(make|build|put up|construct|need|want)\b/.test(t)
            // CLAIMING a spot is not BUILDING on it. these phrasings belong to the
            // set_home / set_outpost rules further down, which deliberately refuse to
            // let a passer-by plant her home for her. taking them here would silently
            // convert "call this the outpost" into a construction job.
            && !/\b(?:set up|establish|claim|call)\b/.test(t)
            && !/\b(?:set|call)\b[^.?!]{0,20}\b(?:home|base)\b/.test(t)) {
            const blueprint = /\bfancy\b/.test(t) ? 'fancy_wood_house'
                : (/\b(shelter|hut|shack|quick|small|simple)\b/.test(t) ? 'simple_shelter'
                    : (/\boutpost\b/.test(t)
                        ? (/\bwood(en)?\b/.test(t) ? 'wood_outpost' : 'stone_outpost')
                        : (/\bstone\b/.test(t) ? 'stone_outpost' : 'wood_house')));
            return { action: 'build_plan', params: { blueprint, here: true } };
        }
        // THE OBSESSION, on request. matched before the generic craft/mine rules
        // below so "make bread" doesn't fall through to a raw craft of the word
        // and "get coal" reads as a fuel run rather than plain ore mining.
        // the verb is tested SEPARATELY from the noun on purpose. listing `bread`
        // inside the verb alternation made the conjunction collapse to "does this
        // line say bread", so on a toast-themed stream "burnt your bread is burnt
        // lol" preempted whatever she was building and started a bake.
        // `stock up` is in the VERB half so "stock up on bread" bakes rather than
        // falling through to nothing. it must never move to the noun half - that is
        // the alternation collapse described above.
        // ---- somebody asking her for something -------------------------------
        // ⚠ ABOVE THE BREAD RULE, because "bring me some bread" means hand one
        // over, not go and bake three. she has a loaf on her; the neighbourly
        // answer is to give it to them, and baking is what she does when she has
        // none to give (the allow-list returns 0 spare and this falls through).
        //
        // this is the ONLY route to `give`. the freeform lane still forbids it -
        // see REQUEST_DECISION_FORBIDDEN - because the care lives in this rule and
        // in GIFT_ALLOW, and a route that skipped both would be a stranger talking
        // her out of her pickaxe.
        // ⚠ THE `false &&` THAT USED TO BE HERE SWITCHED THIS RULE OFF. `&&` binds
        // tighter than `||`, so `false && A || B || C` is `B || C` - the PRIMARY
        // shape ("give me a loaf", "spare a torch") was dead while the two indirect
        // ones still worked, and the comment above calls this the only route to
        // `give`. a debugging leftover that quietly narrowed a reviewed safety path.
        const giftAsk = t.match(
            /\b(?:give|hand|pass|drop|spare|lend|chuck|toss)\s+(?:me|us)\s+(?:a|an|some|any|the|one|\d+)?\s*([a-z][a-z _]{1,28}?)\s*$/)
            || t.match(/\b(?:can|could|may)\s+(?:i|we)\s+(?:have|get|nab|grab)\s+(?:a|an|some|any|the|one|\d+)?\s*([a-z][a-z _]{1,28}?)\s*$/)
            || t.match(/\b(?:got|have|u got|you got)\s+(?:any|a|an|some)\s+(?:spare\s+)?([a-z][a-z _]{1,28}?)\s*\??\s*$/);
        if (giftAsk) {
            const countMatch = t.match(/\b(\d{1,2})\s+[a-z]/);
            const item = this._giftItemName(giftAsk[1]);
            if (item) {
                return {
                    action: 'give',
                    params: { item, amount: countMatch ? parseInt(countMatch[1], 10) : 1 }
                };
            }
        }
        if (/\b(bake|make|craft|cook|get|bring|stock up)\b/.test(t) && /\bbread\b/.test(t)) {
            // ON TOP of what she is already carrying. the amount is a hold-target,
            // so a flat 3 was silently "do nothing" for anyone who asked while she
            // had three loaves on her - the request completed instantly and she
            // never baked. somebody asked for bread, so bread has to happen; unlike
            // the idle steps this one may go and find the wheat, because a person
            // is waiting on it and the goal is on screen the whole time.
            //
            // ⚠ but CAPPED, because "on top of" plus the 32-loaf hoard means a
            // request while she is stocked would ask for 35 loaves = 105 wheat,
            // and `@get bread n` short of wheat is the documented "wander for
            // infinity blocks" freeze. three more loaves is what the ask means.
            return {
                action: 'craft',
                target: 'bread',
                params: { amount: Math.min(this._breadCount() + 3, BREAD_COMFORT + 3) }
            };
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
        // ---- places she knows by sight ----------------------------------
        // ⚠ A CAPABILITY WITH NO CHAT ROUTE IS INVISIBLE to everyone who is not
        // reading the source. `farm` had a java task, a bridge case and three
        // action whitelists and still could not be asked for, because nobody had
        // written the regex - so the most-requested thing was unreachable.
        //
        // naming the ground she is on. checked before the navigation rules
        // because "call this place the mall" would otherwise read as a walk.
        const nameHere = t.match(/\b(?:remember|save|mark|call|name)\s+(?:this|here|it)\s*(?:place|spot|area)?\s*(?:as|,)?\s+([a-z0-9_' -]{2,40}?)\s*$/);
        if (nameHere && !/\bforget\b/.test(t)) {
            return { action: 'remember_place', params: { name: nameHere[1].trim() } };
        }
        // a bare "remember this spot" with no name is still worth doing: what is
        // actually here is what makes it findable, and she can name it later.
        if (/\b(?:remember|save|mark)\s+(?:this|here)\b/.test(t) && !/\bforget\b/.test(t)) {
            return { action: 'remember_place', params: {} };
        }
        // "what's around here", "what do you know about this place"
        if (/\bwhat(?:'s|s| is| do you know about)?\b[^.?!]{0,24}\b(?:around here|round here|nearby|near here|this place|this area)\b/.test(t) ||
            /\b(?:been|seen)\s+(?:anywhere|any\s?places?)\s+(?:around|near|like)\b/.test(t)) {
            return { action: 'places' };
        }
        // ⚠ DELETING IS ^-ANCHORED, exactly like the food rule above and for the
        // reason that one learned the hard way: `\b` is true at the front of
        // every word, so an unanchored rule fired on "dont forget the lava shelf
        // is where the chest is" - a line meaning the opposite - and deleted it.
        // "forget it" must never delete either: that is somebody saying never mind.
        //
        // the anchor is the guard doing the work (verified by reverting it); the
        // negation and food clauses below are REDUNDANCY, kept because the cost
        // of one wrong delete here is a place she has been building up for weeks
        // and the cost of a redundant test is nothing.
        const forgetPlace = t.match(/^[,\s]*forget\s+(?:about\s+)?(?:the\s+)?([a-z0-9_' -]{3,40}?)\s*$/);
        if (forgetPlace && !/\b(?:dont|don'?t|do not|never)\s+forget\b/.test(t) &&
            !/\b(?:food|farm|wheat|crop|field)\b/.test(t) &&
            !/^(?:it|that|this|everything|all of it|about it)$/.test(forgetPlace[1].trim())) {
            return { action: 'forget_place', params: { target: forgetPlace[1].trim() } };
        }
        // "find a village", "take me to the ravine". ⚠ only when she ACTUALLY
        // KNOWS one - the honest answer to "find X" when she has never seen an X
        // is a walk, and pretending otherwise sends her to coordinates she made
        // up. falling through to the explore rule is the right failure.
        const findFeature = t.match(/\b(?:find|look for|go find|take me to)\s+(?:a|an|the)?\s*([a-z0-9_' -]{3,40}?)\s*$/);
        if (findFeature) {
            const want = findFeature[1].trim();
            if (this.memory.findPlace?.(want, { world: this._worldId(), dimension: this.gameState.dimension })) {
                return { action: 'go_place', params: { target: want } };
            }
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
            // ...then somewhere she merely KNOWS. a favorite is a spot she
            // deliberately saved; a place is anywhere she has been and can
            // describe, which is a far bigger map and usually the one a person
            // is pointing at when they say "go back to the badlands".
            if (this.memory.findPlace?.(phrase, { world: this._worldId(), dimension: this.gameState.dimension })) {
                return { action: 'go_place', params: { target: phrase } };
            }
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
        return ADDRESSED_RE.test(t) && !GREETING_ONLY_RE.test(t);
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
        // disruptive action. Player attacks and chat messages are handled only by
        // an explicit operator/model tool call.
        if (suggestion && ['attack', 'chat'].includes(suggestion.action)) return null;

        // GIVING IS THE ONE THAT GOT A NARROW DOOR RATHER THAN STAYING SHUT.
        //
        // "give me your diamonds" from a stranger must never work and still does
        // not: `_giftableAmount` answers 0 for anything off GIFT_ALLOW and 0 for
        // anything that would take her below that item's floor, so her working
        // pickaxe, her last loaf and every valuable are unreachable however the
        // sentence is phrased. what IS reachable is a spare loaf, a handful of
        // torches, some cobble - the things a person actually asks a neighbour
        // for, which she can restock in one trip.
        //
        // ⚠ IN-GAME ONLY, AND ONLY FOR SOMEBODY IN THE ROOM. a twitch handle is
        // not a body the `@give` walk can reach, and `give` errors on a name it
        // cannot see - so an out-of-game ask degrades to a freeform request she
        // can answer with words instead of a guaranteed error.
        if (suggestion && suggestion.action === 'give') {
            const item = String(suggestion.params?.item || suggestion.params?.what || '').toLowerCase();
            const asked = Number(suggestion.params?.amount) || 1;
            const spare = this._giftableAmount(item, asked);
            const now = Date.now();
            const lastGift = this._giftsAt.get(String(username || '').toLowerCase()) || 0;
            if (!inGame || !this._isNearbyPlayer(username) || !spare
                || now - lastGift < HELP_PER_PERSON_GAP_MS) {
                // not a refusal she has to explain here - it becomes a freeform
                // ask below, so SHE gets to answer the person in her own words.
                suggestion = null;
            } else {
                this._giftsAt.set(String(username || '').toLowerCase(), now);
                suggestion = {
                    ...suggestion,
                    params: { ...suggestion.params, player: username, item, amount: spare }
                };
            }
        }

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
        // ⚠ ITS OWN TIMER, NOT A RUNG IN THE AUTONOMOUS TICK. That tick returns early on
        // every busy state by design - which is most of a session - so a fidget hung off
        // it would only ever fire when she had nothing to do, i.e. exactly never during
        // the stretches worth watching. Tics are cosmetic and must be able to run
        // ALONGSIDE work, which is also why the action is in NON_TASK_ACTIONS.
        if (!this.ticTimer) {
            this.ticTimer = setInterval(() => this._ticStep(), TIC_TICK_MS);
            if (this.ticTimer.unref) this.ticTimer.unref();
        }
    }

    /**
     * THE FIDGETING. One roll every TIC_TICK_MS; see DEFAULT_TIC_FREQUENCY for why the
     * default is low.
     *
     * The odds are scaled by what she is doing rather than gated by it: standing about
     * is what fidgeting is for, a non-click job gets a third of the rate, and hostiles
     * on her get half (a panicked crouch spam is the most human thing in the game). A
     * mouse-click job gets nothing at all.
     *
     * Everything here is a PREFERENCE. The client refuses on its own account too -
     * mid-swing, a screen open, not on the ground - because only it knows what is true
     * this tick, and a refusal is silent by design: a declined fidget is not a fault and
     * must never reach her mouth.
     */
    _ticStep() {
        try {
            const freq = Math.min(1, Math.max(0, Number(this.config.ticFrequency) || 0));
            if (!freq) return;                                   // switched off
            if (!this.enabled || !this.connected || !this.gameConnected) return;
            if (this.manualControl) return;                       // the owner has the keyboard
            if (this._stateIsStale()) return;                     // don't fidget blind
            const now = Date.now();
            if (now - (this._lastTicAt || 0) < TIC_MIN_GAP_MS) return;

            // what is she in the middle of? the REQUESTED verb, so a rewritten go_home
            // is judged as the walk it is rather than as a bare move.
            const live = this.activeGoal?.requestedAction || this.activeGoal?.action
                || this.currentAction || null;
            if (live && TIC_CLICK_ACTIONS.has(live)) return;
            // ...and the game's own opinion, which catches work she did not start (a
            // defense chain swinging, a survival reflex) and any verb this list has
            // never heard of.
            const botAction = String(this.gameState.botAction || this.gameState.botTask || '').toLowerCase();
            if (/\b(mine|mining|break|dig|place|placing|build|craft|smelt|attack|fight|eat)/.test(botAction)) return;

            const danger = Number(this.gameState.nearbyHostiles) > 0;
            const idle = !live && !this.currentTask;
            const chance = danger ? TIC_CHANCE_DANGER : (idle ? TIC_CHANCE_IDLE : TIC_CHANCE_BUSY);
            if (Math.random() > freq * chance) return;

            // a hop is idle-only: a forced jump mid-path can put her off a ledge or
            // wreck a parkour move baritone had planned.
            const pool = TIC_KINDS.filter((t) => idle || !t.idleOnly);
            if (!pool.length) return;
            const total = pool.reduce((sum, t) => sum + t.weight, 0);
            let roll = Math.random() * total;
            const pick = pool.find((t) => (roll -= t.weight) <= 0) || pool[0];

            this._lastTicAt = now;
            // ⚠ NOT _safeExecute: that is for WORK, and it would file the fidget against
            // the stalled-action backoff and the stuck-streak counter - so a run of tics
            // could blacklist a verb, or a genuinely wedged spot could be blamed on them.
            // Fire and forget, and swallow everything: a refused fidget is a non-event.
            this.executeAction('tic', { kind: pick.kind }, {
                priority: 'low', source: 'tic', waitForCompletion: false
            }).catch(() => { /* cosmetic: never surfaces, never retried */ });
        } catch { /* a fidget must never be able to break the loop it rides on */ }
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
        // requested verb, not the rewritten one - see _recoverPinnedByMobs
        const failedAction = this.activeGoal?.requestedAction || this.activeGoal?.action || this.currentAction || null;
        if (failedAction && !NON_TASK_ACTIONS.has(failedAction)) {
            this._avoidNote(failedAction, LOOP_AVOID_MS * 2, this.activeGoal?.params?.target);
            try { this.memory.recordFailure(failedAction, this.activeGoal?.params?.target, 'blocked by server protection (claimed land)'); } catch { /* best-effort */ }
        }
        this._pushCommentary("this land is CLAIMED. noted. leaving before i catch a ban for crimes against farmland");
        (async () => {
            try { await this.executeAction('stop', {}, { priority: 'urgent', source: 'protection', timeoutMs: 30000 }); } catch { /* may not be running */ }
            // this relocation is what first walked her into the ocean on that server -
            // a blind 400-900 block bearing off a coastal claim. keep it to land.
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
    // ⚠ THE CELL MAP IS SCOPED TO A WORLD AND A DIMENSION, and it was not.
    // keys used to be bare `cx,cz`, so cell 7,-13 was ONE entry shared by every
    // server she has ever joined and by every dimension in each - and the nether
    // is 8:1, so the overworld coast and the nether ceiling overwrote each
    // other's readings. "there is ocean that way" was being answered from a
    // different planet. every other spatial ledger in memory carries `world`;
    // these two are keyed strings, so the scope has to live in the key.
    _cellScope() {
        return `${this._worldId() || 'local'}|${this._dimForMove(this.gameState.dimension)}`;
    }

    _cellKey(x, z) {
        return `${this._cellScope()}|${Math.floor(x / TERRAIN_CELL)},${Math.floor(z / TERRAIN_CELL)}`;
    }

    // the pre-scoping key shape. entries written before this change carry no
    // world and no dimension, so they are read as "true anywhere" - exactly the
    // `world: null` convention every other ledger here already uses for legacy
    // rows. without this the change would silently throw away her whole
    // coastline and, far worse, every claim she has ever been refused on: claims
    // deliberately never expire, because forgetting one walks her straight back
    // into the denial that taught it.
    _legacyCellKey(x, z) {
        return `${Math.floor(x / TERRAIN_CELL)},${Math.floor(z / TERRAIN_CELL)}`;
    }

    // scoped reading first, legacy reading as the fallback. writes are always
    // scoped, so legacy rows are read-only history that fades as she re-walks.
    // ⚠ HYDRATE FIRST. these read the in-ram maps, which are filled lazily -
    // and a reader that runs before the first write sees an EMPTY map and
    // cheerfully answers "nothing known here" for ground she has walked for
    // weeks. the latch makes this a boolean check after the first call.
    _cellIn(book, x, z) {
        this._ensureTerrainLoaded();
        return book.has(this._cellKey(x, z)) || book.has(this._legacyCellKey(x, z));
    }

    // 'wet' | 'dry' | null for a cell. ⚠ THE SCOPED READING WINS OUTRIGHT: a
    // legacy row is only consulted when this world has nothing to say about the
    // cell at all. checking both books at once would let an unscoped `dry` from
    // another server contradict water she has personally swum in here, and the
    // stale answer would never age out - legacy rows are never rewritten.
    _cellState(x, z) {
        this._ensureTerrainLoaded();
        const key = this._cellKey(x, z);
        if (this._wetCells.has(key)) return 'wet';
        if (this._dryCells.has(key)) return 'dry';
        const legacy = this._legacyCellKey(x, z);
        if (this._wetCells.has(legacy)) return 'wet';
        if (this._dryCells.has(legacy)) return 'dry';
        return null;
    }

    // pull the cell coordinates back out of either key shape. ⚠ the scoped key
    // contains a server address, which may itself contain anything - so the
    // coordinates are taken from the LAST segment, never by splitting on ','
    // across the whole string (that read `that server...|overworld|7` as a number
    // and returned NaN, which silently emptied every dry-cell search).
    _cellCoords(key) {
        const tail = String(key).slice(String(key).lastIndexOf('|') + 1);
        const [cx, cz] = tail.split(',').map(Number);
        return Number.isFinite(cx) && Number.isFinite(cz) ? { cx, cz } : null;
    }

    // is this key readable from where she is standing? scoped keys must match
    // the current world+dimension; a legacy key has no scope and counts anywhere.
    _cellKeyInScope(key) {
        const s = String(key);
        const cut = s.lastIndexOf('|');
        return cut < 0 ? true : s.slice(0, cut) === this._cellScope();
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
            // ⚠ scoped to THIS world. unscoped, "i already looked there" was
            // answered out of every server she has ever joined, so ground she
            // has never seen here read as already-checked.
            const seen = this.memory.getVisitedSpots?.({
                world: this._worldId(), dimension: this.gameState.dimension
            }) || [];
            for (const v of seen) {
                const at = Number(v?.at) || 0;
                if (now - at > VISITED_SPOT_TTL_MS) continue;
                this._recentDestinations.push({
                    x: Number(v.x), z: Number(v.z), at,
                    dim: this._dimForMove(v.dimension || this.gameState.dimension)
                });
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
                const cx = x + dx * TERRAIN_CELL;
                const cz = z + dz * TERRAIN_CELL;
                // already known, under either key shape - a legacy claim still
                // counts, so re-walking old ground does not re-write the plot.
                if (this._cellIn(this._claimedCells, cx, cz)) continue;
                const key = this._cellKey(cx, cz);
                this._claimedCells.add(key);
                try { this.memory.recordClaimedArea(key); } catch { /* best-effort */ }
            }
        }
    }

    _isClaimedCell(x, z) {
        return this._cellIn(this._claimedCells, x, z);
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
    /**
     * Which build site a set of params names. Her brain usually names none - it
     * asks to "build home" and the step resolves the rest - so an unnamed request
     * has to count as the site she is living at, which is the one that gets
     * re-dispatched. Failing open there would leave the guard permanently unarmed.
     */
    _siteKey(params = {}) {
        const id = params?.settlementId || params?.id || null;
        if (id) return `id:${id}`;
        const x = Number(params?.x), z = Number(params?.z);
        if (Number.isFinite(x) && Number.isFinite(z)) return `at:${Math.round(x)},${Math.round(z)}`;
        return '*';
    }

    _armBlockedSite(params, why) {
        this._blockedSiteKey = this._siteKey(params);
        this._blockedSiteUntil = Date.now() + BLOCKED_SITE_COOLDOWN_MS;
        this._blockedSiteWhy = why;
        this.log('warn', `build site ${this._blockedSiteKey} refused; not re-dispatching for `
            + `${Math.round(BLOCKED_SITE_COOLDOWN_MS / 60000)}min (${why})`);
    }

    /** Real progress means the world moved - whatever was in the way may not be. */
    _clearBlockedSite() {
        if (!this._blockedSiteUntil) return;
        this._blockedSiteUntil = 0;
        this._blockedSiteKey = null;
        this._blockedSiteWhy = '';
    }

    /**
     * Refuse to start a build the game side has already refused.
     *
     * Same shape and the same stand-downs as the spawn-region gate: only her own
     * choices are bound. the owner, chat, the operator and recovery may ask for it at
     * any time, because a person asking is new information and the whole point of
     * the cooldown is that SHE has none.
     */
    _blockedSiteRefusal(action, source, params) {
        if (!SPAWN_REGION_GATED_SOURCES.has(source || 'agent')) return null;
        const act = String(action || '').trim().toLowerCase();
        if (act !== 'build_settlement' && act !== 'build_plan') return null;
        if (!this._blockedSiteUntil || Date.now() >= this._blockedSiteUntil) {
            this._clearBlockedSite();
            return null;
        }
        const want = this._siteKey(params);
        // '*' on either side is "the site she lives at" - see _siteKey.
        if (this._blockedSiteKey !== '*' && want !== '*' && want !== this._blockedSiteKey) return null;
        const mins = Math.max(1, Math.round((this._blockedSiteUntil - Date.now()) / 60000));
        return `${this._blockedSiteWhy} - starting it again changes nothing. `
            + `something has to move first; try again in ${mins}min or do something else`;
    }

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
        const dim = this._dimForMove(this.gameState.dimension);
        for (const d of this._recentDestinations) {
            // the nether is 8:1, so the same x,z is a completely different place
            // one dimension over - merging across them refreshed a spot she was
            // nowhere near and protected it from eviction.
            if (d.dim && d.dim !== dim) continue;
            if (Math.hypot(x - d.x, z - d.z) < RECENT_DESTINATION_RADIUS) {
                d.at = now;
                this._persistVisited(x, z, now);
                return;
            }
        }
        this._recentDestinations.push({ x, z, at: now, dim });
        while (this._recentDestinations.length > RECENT_DESTINATION_CAP) this._recentDestinations.shift();
        this._persistVisited(x, z, now);
    }

    // mirror the search memory to disk. best-effort on purpose: failing to remember
    // is a worse walk, not a broken bot.
    _persistVisited(x, z, at) {
        try {
            this.memory.recordVisitedSpot?.(x, z, at, {
                world: this._worldId(), dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
    }

    _isRecentDestination(x, z, now = Date.now()) {
        const dim = this._dimForMove(this.gameState.dimension);
        for (const d of this._recentDestinations) {
            if (now - d.at > RECENT_DESTINATION_TTL_MS) continue;
            if (d.dim && d.dim !== dim) continue;
            if (Math.hypot(x - d.x, z - d.z) < RECENT_DESTINATION_RADIUS) return true;
        }
        return false;
    }

    // how far a candidate sits from the nearest place she has recently been. used only
    // by the relaxed pass: when her own history has boxed her in, "move anyway" is right
    // but "move straight back to the spot you just left" is the single worst answer, so
    // the fallback maximises distance from history instead of ignoring it.
    _distanceToNearestRecent(x, z, now = Date.now()) {
        const dim = this._dimForMove(this.gameState.dimension);
        let nearest = Infinity;
        for (const d of this._recentDestinations) {
            if (now - d.at > RECENT_DESTINATION_TTL_MS) continue;
            if (d.dim && d.dim !== dim) continue;
            nearest = Math.min(nearest, Math.hypot(x - d.x, z - d.z));
        }
        return nearest;
    }

    _recordTerrainSample(point, wet) {
        this._ensureTerrainLoaded();
        if (!point) return;
        const key = this._cellKey(point.x, point.z);
        const legacy = this._legacyCellKey(point.x, point.z);
        const book = wet ? this._wetCells : this._dryCells;
        const other = wet ? this._dryCells : this._wetCells;
        const known = book.has(key);
        book.set(key, Date.now());
        other.delete(key);
        // a first-hand reading here also retires the unscoped guess that was
        // standing in for it, or `_cellState` would keep offering the old
        // world's answer for a cell she has now actually stood in.
        other.delete(legacy);
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
            const state = this._cellState(origin.x + (x - origin.x) * t, origin.z + (z - origin.z) * t);
            if (state === 'wet') wet++;
            else if (state === 'dry') dry++;
        }
        return { wet: wet / steps, dry: dry / steps };
    }

    _wetnessAlong(origin, x, z) {
        return this._routeTerrain(origin, x, z).wet;
    }

    // is anywhere she REMEMBERS near this candidate, and has she been away from
    // it long enough to want to see it again? returns 0..1 by how much the place
    // is worth - a named one pulls hardest, then one with things in it.
    _placePullAt(x, z, now = Date.now()) {
        let places;
        try { places = this.memory.getPlaces?.() || []; } catch { return 0; }
        if (!places.length) return 0;
        const dim = this._dimForMove(this.gameState.dimension);
        const world = this._worldId();
        let best = 0;
        for (const p of places) {
            if (!p || !p.position) continue;
            if (this._dimForMove(p.dimension) !== dim) continue;
            // somewhere on another server is not somewhere she can walk to
            if (world && p.world && p.world !== world) continue;
            if (Math.hypot(p.position.x - x, p.position.z - z) > CURIOSITY_PLACE_RADIUS) continue;
            // she was just there. missing a place takes time.
            if (now - (p.lastSeenAt || 0) < CURIOSITY_PLACE_STALE_MS) continue;
            const worth = p.name ? 1 : Math.min(1, (p.features || []).length / 3);
            if (worth > best) best = worth;
        }
        return best;
    }

    // what this candidate is worth going to FOR ITS OWN SAKE. bounded on
    // purpose - see the constants. `weight` lets a caller whose whole job is
    // finding new ground (the scout) lean on it harder than an idle drift does.
    _curiosityBonus(x, z, route, weight = 1) {
        if (!(weight > 0)) return 0;
        // she knows nothing about any of it: that IS unexplored, and the base
        // score gives it exactly zero by construction.
        const unknown = 1 - Math.min(1, (route.dry || 0) + (route.wet || 0));
        const pull = this._placePullAt(x, z);
        return (unknown * CURIOSITY_UNKNOWN_WEIGHT + pull * CURIOSITY_PLACE_WEIGHT) * weight;
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
        return this._cellState(x, z) === 'wet';
    }

    // closest cell she has personally stood on. the escape prefers this over any
    // computed bearing: ground she has walked is ground baritone can reach.
    _nearestDryCell(point) {
        let best = null;
        for (const key of this._dryCells.keys()) {
            // ground on another server is not ground she can walk to, and a
            // nether cell is not an overworld one.
            if (!this._cellKeyInScope(key)) continue;
            const cell = this._cellCoords(key);
            if (!cell) continue;
            const { cx, cz } = cell;
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
                if (this._cellState(x, z) === 'wet') continue;
                // land she is not allowed to touch is not a destination, however dry it is
                if (this._isClaimedCell(x, z)) continue;
                // nor is ground she already walked out to and turned down. this is
                // a HARD exclusion in both passes on purpose: the relaxed pass
                // exists to stop her standing still, and re-walking to a site she
                // has already judged is not movement, it is the loop the owner kept
                // watching. terrain does not improve while she is away.
                if (this._isRejectedCell(x, z)) continue;
                if (strict && this._isRecentDestination(x, z)) continue;
                // dry, reachable, and never hers. checked AFTER the blind-route
                // clamp, because clamping is what moves a candidate back inside.
                if (opts.notInSpawnRegion && this._inSpawnRegion(x, z)) continue;
                // GROUND SHE HAS ALREADY BUILT ON. Documented in this function's
                // own comment since it was written and never implemented, which is
                // why a relocation could walk her out to a spot inside her own
                // yard and call it a find. Each entry carries its OWN minimum
                // because a toaster's yard and a shelter's are different sizes.
                if (Array.isArray(opts.awayFrom) &&
                    opts.awayFrom.some((keep) => Math.hypot(x - keep.x, z - keep.z) < keep.min)) continue;
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
                let score = route.dry + (this._cellState(x, z) === 'dry' ? 0.5 : 0);
                // ⚠ NOT DURING AN OUTWARD MARCH. `outward` is the spawn-region
                // escape and the relocation walk - those are safety moves with
                // one job, and a pull toward something interesting on the way is
                // exactly how she used to orbit the thing she was leaving.
                //
                // ...UNLESS THE CALLER ASKS, which only an expedition does. The
                // orbiting that rule exists to stop cannot happen here: `gain >= need`
                // above is a HARD filter applied BEFORE any scoring, so curiosity can
                // only choose between candidates that have each already earned their
                // distance. It changes WHICH far spot she walks to, never whether the
                // spot is far. Neither existing `outward` caller passes `curiosity`,
                // so this branch is unreachable for the two safety marches.
                if (!opts.outward || opts.curiosity) {
                    score += this._curiosityBonus(x, z, route, opts.curiosity);
                }
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
        // requested verb, not the rewritten one - see _recoverPinnedByMobs
        const failed = this.activeGoal?.requestedAction || this.activeGoal?.action || this.currentAction;
        // never blacklist the escape's own move: that armed _avoidAction against
        // the one action that gets her out of the sea.
        if (failed && !NON_TASK_ACTIONS.has(failed) && this.activeGoal?.source !== 'water-escape') {
            this._avoidNote(failed, LOOP_AVOID_MS, this.activeGoal?.params?.target);
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
    // took the tick.
    //
    // ⚠ A FREEFORM ASK IS STILL AN ASK. this used to filter freeform out entirely
    // and leave it to her chat brain to notice - which meant every request nobody
    // had written a regex for was, in practice, ignored. live on 2026-08-07:
    // "build a wheat farm" asked four times in one night, parsed to nothing each
    // time, never acted on once, while "burnt go home" (which had a verb) worked
    // instantly. a regex list can never cover the way people actually talk, so the
    // freeform lane below hands the line to her brain and dispatches what it picks.
    // parsed still WINS when present: it is instant, deterministic and free.
    _actOnRequest() {
        if (!this.autonomous) return false;
        if (this._requestIntervention) return true;
        const now = Date.now();
        const unhandled = (this.viewerSuggestions || [])
            .filter((s) => now - s.at <= REQUEST_ACT_WINDOW_MS)
            .filter((s) => s.at > (this._lastHandledRequestAt || 0));
        const fresh = unhandled.filter((s) => s.action && !s.freeform);
        const req = fresh[fresh.length - 1];
        if (!req) {
            // nothing with a built-in verb. hand the newest freeform ask to her brain.
            const open = unhandled.filter((s) => s.freeform);
            return this._askBrainForRequest(open[open.length - 1]);
        }
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
        // ...and it becomes a JOB, not just this dispatch. `_lastHandledRequestAt`
        // above means this request can never be picked up here again, and
        // REQUEST_ACT_WINDOW_MS retires it after 90s regardless, so without a
        // goal the only record that anyone wanted this is the action currently
        // in flight - and that action ends the first time a creeper turns up.
        this._declareRequestGoal(req, params);

        this._startPersonRequest(req, params);
        return true;
    }

    // THE TWO-PHASE RETASK, shared by both routes into her hands (a parsed verb and
    // her brain's answer to a freeform ask) so they cannot drift apart.
    //
    // A finite autonomous goal remains in pendingActions until it really finishes.
    // Sending the request directly therefore just hits the busy guard and loses the
    // request after marking it handled. Retask in two phases: stop only work Burnt
    // herself/request automation owns, wait for the stop ack, then dispatch.
    _startPersonRequest(req, params) {
        const active = this.activeGoal;
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
            // ⚠⚠ A PERSON'S STOP IS NOT A MACHINE STOP. `'request'` is in
            // INTERNAL_STOP_SOURCES - rightly, because the CLEARING stop above is
            // this file's own doing - but the REQUESTED action is dispatched with
            // the same source, so when the thing a person asked for IS `stop`,
            // their intent was laundered into an interruption: `_dispatchAction`
            // skipped `_standDownGoals`, and 90 seconds later she walked straight
            // back to the job. That is the behaviour the stand-down calls "worse
            // than forgetting, and unarguable on a public server".
            //
            // naming the requester also makes the journal line read properly
            // ("told to stop by marble"). guarded so a player called `safety`
            // cannot dress their own stop up as a machine one.
            const source = req.action === 'stop' && !INTERNAL_STOP_SOURCES.has(String(req.user || ''))
                ? (req.user || 'person')
                : 'request';
            await this.executeAction(req.action, params, {
                priority: 'normal', source, waitForCompletion: false,
                // carried so that finishing the job closes THEIR request, not just any
                requestedBy: req.inGame ? req.user : null
            });
            this._pushCommentary(`${req.user} asked, so that's what i'm doing now`);
        })().catch((err) => {
            this.log('warn', `viewer request ${req.action} could not start: ${err.message}`);
        }).finally(() => {
            this._requestIntervention = null;
        });
    }

    // SOMEBODY ASKED FOR SOMETHING NO REGEX COVERS. hand the line to her brain and
    // let it choose the tool call - she reads intent far better than a verb list.
    // emits `request_opportunity`; burnt.js answers with actOnRequestDecision().
    // returns true when it takes the tick, so the idle menu doesn't start something
    // else in the gap while she is deciding.
    //
    // ⚠ marks the ask handled BEFORE asking. a decision that never comes back must
    // cost the decision, never a re-ask loop: without this the same line re-fires on
    // every 25s tick until the 90s window retires it, i.e. three llm calls and
    // possibly three dispatches for one sentence.
    _askBrainForRequest(req) {
        if (!req || !req.freeform) return false;
        if (this._requestDecisionInFlight) return true;
        if (!this.connected || !this.gameConnected || this.manualControl || this._stateIsStale()) return false;
        // never stomp an explicit operator/llm goal - same rule the parsed lane has.
        const active = this.activeGoal;
        if (active && active.source && !['autonomous', 'request'].includes(active.source)) return false;
        this._lastHandledRequestAt = req.at;
        this._requestDecisionInFlight = req;
        // the tool never writes her words and never calls an llm itself; it states
        // the facts and burnt.js owns the round-trip (same shape as bread_opportunity).
        this.emit('gameEvent', 'request_opportunity', {
            player: req.user,
            said: req.text,
            inGame: !!req.inGame,
            busy: !!(this.currentAction || this.activeGoal || this.pendingActions?.size),
            task: this.currentTask || this.currentAction || null,
            carrying: this._carrying(),
            position: this._point(this.gameState.position),
            nearby: Array.isArray(this.gameState.nearbyPlayerNames)
                ? this.gameState.nearbyPlayerNames.slice(0, 6) : [],
            budgetMs: REQUEST_DECISION_BUDGET_MS
        });
        // silence is a supported outcome: if nothing answers, the flag clears and the
        // next tick goes back to her own work rather than hanging on a dead key.
        clearTimeout(this._requestDecisionTimer);
        this._requestDecisionTimer = setTimeout(() => {
            if (this._requestDecisionInFlight === req) {
                this.log('info', `no decision came back for ${req.user}'s ask - letting it go`);
                this._requestDecisionInFlight = null;
            }
        }, REQUEST_DECISION_BUDGET_MS + 2000);
        return true;
    }

    // her brain's answer to a freeform ask. `decline` is a first-class outcome -
    // she is allowed to say no, and saying no is not the same as going quiet.
    actOnRequestDecision(decision = {}) {
        const req = this._requestDecisionInFlight;
        this._requestDecisionInFlight = null;
        clearTimeout(this._requestDecisionTimer);
        if (!req) return { acted: false, reason: 'too late - the ask had already been let go' };
        const action = String(decision.action || '').trim().toLowerCase();
        if (!action || action === 'decline' || action === 'none') {
            this.recentEvents.record(`${req.user} asked for something and she said no`);
            return { acted: false, reason: 'declined' };
        }
        if (REQUEST_DECISION_FORBIDDEN.has(action)) {
            this.log('warn', `refusing "${action}" from a chat request - not something a person may start`);
            return { acted: false, reason: `${action} is not something a chat request may start` };
        }
        if (this._requestIntervention) return { acted: false, reason: 'already retasking' };
        const params = (decision.params && typeof decision.params === 'object' && !Array.isArray(decision.params))
            ? { ...decision.params } : {};
        const job = { ...req, action, target: params.target || null, params, freeform: false };
        this.recentEvents.record(`${req.user} asked her to ${action}${params.target ? ` ${params.target}` : ''}`);
        // a freeform ask becomes a real JOB too, or the first creeper ends it and
        // the person has to ask again - which is the bug this whole path exists for.
        this._declareRequestGoal(job, params);
        this._startPersonRequest(job, params);
        return { acted: true, action };
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
        if (this.manualControl) return; // the owner has the keyboard (f1)
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
        // SHE WAS DOING SOMETHING BEFORE THE FIGHT. GO BACK TO IT.
        //
        // Above the spawn gate and everything under it, because picking the errand she
        // was already on back up is not a new choice - it is the same one, continued -
        // and it must outrank the homestead arc and the mood menu inventing something
        // else. Below safety and anything a person just asked for, which are the two
        // things that legitimately replace it. `_resumeInterruptedStep` returns null
        // unless the danger is genuinely over, so this rung is silent in a fight.
        const carryOn = this._resumeInterruptedStep();
        if (carryOn && this._safeExecute(carryOn.action, carryOn.params || {}, carryOn.say)) {
            this.lastAutonomousAt = Date.now();
            return;
        }
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
            } else {
                // no step at all: the 10s pacing cooldown, standing in water, or no
                // outward bearing that isn't sea. ALWAYS SAY SO - a silent return on
                // a branch that also refuses every other kind of work is the exact
                // shape that reads as a freeze on stream.
                this.log('info', 'in the spawn region with no step out available this tick; not working here');
            }
            return;
        }
        // gear up before wandering. the idle menu is pure entertainment picks, so
        // she used to spawn in with nothing, walk into the dark, and get shot by a
        // skeleton with no pickaxe and no food. one prep goal beats one more death.
        const prep = this._survivalPrep();
        if (prep) {
            // charge the 4-minute cooldown only for prep that actually WENT OUT.
            // a blacklisted `craft` (20s stall limit, so this is routine) used to
            // spend one prep key per tick doing nothing, and by the time the
            // blacklist lifted she had no sword, no pickaxe and no food queued for
            // another four minutes. the rain pull and the homestead arc below both
            // hand their cooldown back the same way.
            if (this._safeExecute(prep.action, prep.params, prep.say)) {
                this._survivalPrepCooldowns.set(prep.key, Date.now());
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
        // SHE WAS IN THE MIDDLE OF SOMETHING. Everything above this line is an
        // interruption by design - danger, a fault, a person talking, getting out
        // of spawn - and each one ends the action she was running. Before this
        // rung existed, that was the end of the job full stop: the ledger kept a
        // sentence about the wheat farm for her to say, and the tick went back to
        // the homestead arc or rolled the menu. Going back to unfinished work is
        // now a step like any other, and it outranks both.
        const resume = this._resumeGoalStep();
        if (resume) {
            if (this._safeExecute(resume.action, resume.params || {}, resume.say)) {
                // booked only once the step really went out - same arm/commit
                // discipline as the homestead arc below, so a refused resume does
                // not spend an attempt or start its cooldown.
                if (typeof resume.commit === 'function') {
                    try { resume.commit(); } catch (err) { this.log('debug', `goal resume commit failed: ${err.message}`); }
                }
                this.lastAutonomousAt = Date.now();
                return;
            }
            // refused (blacklisted action, stuck-streak backoff). nothing was
            // charged, so the next tick may well be allowed to carry on with it.
        }
        // SHE IS ON A TRIP. Placed here on purpose, and the position IS the design:
        //
        //  - BELOW everything above it, so a fault, a mob, a person talking, or
        //    unfinished work somebody asked for all still win. An expedition is what
        //    she does with her own time, never a reason to ignore a person.
        //  - ABOVE the homestead arc, and that is the whole point. The arc has 61
        //    appliances left to install and will have work forever, so anything
        //    ranked under it never runs. Ranking the trip below the house is exactly
        //    how she became a builder who never leaves the garden.
        //
        // Once a trip is live this owns the tick until it finishes or aborts - that
        // persistence is the feature. The gate on STARTING one is where the
        // restraint lives, not here.
        const trip = this._expeditionStep();
        if (trip) {
            if (this._safeExecute(trip.action, trip.params || {}, trip.say)) {
                if (typeof trip.commit === 'function') {
                    try { trip.commit(); } catch (err) { this.log('debug', `expedition commit failed: ${err.message}`); }
                }
                this.lastAutonomousAt = Date.now();
                return;
            }
            // refused. nothing charged - same arm/commit discipline as the rungs
            // either side, so a blocked leg does not burn the leg cooldown and
            // strand her halfway out.
        }
        // No requested goal is active: her standing goal is the homestead. This
        // is deterministic (not a dice-roll menu entry), while safety and every
        // human/LLM task above still preempt it.
        //
        // ...unless the current brief is something else. the arc runs in 'auto'
        // (her default way of living) and while gathering materials (that is what
        // the materials are FOR); under scouting, food and guard duty it stands
        // down, or "scout the area" is just a label on watching her lay stone.
        const homestead = this._homesteadRunsInMode() ? this._homesteadBehavior() : null;
        if (homestead) {
            if (this._safeExecute(homestead.action, homestead.params || {}, homestead.say)) {
                // THE STEP REALLY WENT OUT. a step that books state on the way
                // past (the upgrade ledger, its own pacing) hands that booking
                // over here rather than doing it while it was still a proposal -
                // same discipline as arm/release, minus the release.
                if (typeof homestead.commit === 'function') {
                    try { homestead.commit(); } catch (err) { this.log('debug', `homestead commit failed: ${err.message}`); }
                }
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
        //
        // SUPPRESS THE LONG PICKS, NOT THE FLOOR. this was a bare `return`, which
        // also skipped _executeLastResort() - the branch whose whole job is that
        // standing still is only ever a decision. a relocation that finds no
        // candidate returns null every 45s and can run for HOME_RELOCATION_MAX_MS
        // (20 min), so the one state most likely to strand her was the one state
        // with no floor under it.
        if (this._homeRelocation) {
            if (this._executeLastResort({ local: true })) this.lastAutonomousAt = Date.now();
            return;
        }
        // bread tendency: burnt loves bread. with downtime and wheat on hand she
        // gravitates to baking, and she bakes the WHOLE bag of wheat off in one
        // order - this used to pass no amount at all, which the bridge floors to
        // `@get bread 1`, i.e. "end up holding one loaf". that is a no-op the
        // moment she is carrying a single loaf, which she almost always is, so the
        // tendency spent its turn every time and produced nothing.
        // crafting from CARRIED wheat is claim-safe (>=3 in hand, no farm
        // grinding) - on servers she prefers to bake at the homestead, in
        // singleplayer anywhere. hunting wheat lives in the homestead arc.
        // ...and it is a FOOD behaviour, so it sits out the briefs that are not
        // about food for the same reason the homestead arc does. gather_food runs
        // its own, better-ordered bake below.
        const tendencyBake = this._breadTendencyRunsInMode() ? this._bakeTarget(BREAD_HOARD) : 0;
        if (tendencyBake && Math.random() < 0.45 &&
            (this.gameState.multiplayer !== true || this._homeDistance() <= 64)) {
            if (this._safeExecute('craft', { target: 'bread', amount: tendencyBake }, this._breadLine())) {
                this.lastAutonomousAt = Date.now();
                return;
            }
        }
        // THE BRIEF. self-play is not a boolean any more: 'auto' is the old menu
        // below, verbatim, and every other mode answers this one question - what
        // does she do with time that is genuinely hers - before the menu is asked.
        //
        // ⚠ dispatched through _safeExecute like everything else, so the stalled-
        // action backoff, the by-place stuck streak and the repeated-failure
        // blacklist all supervise it. a step that bypassed this would be a step no
        // watchdog in the file can stop.
        const modeStep = this._autonomyModeBehavior();
        if (modeStep) {
            if (this._safeExecute(modeStep.action, modeStep.params || {}, modeStep.say)) {
                // the step went out, so its cooldown is EARNED and the armed
                // marker has done its job. clearing it here keeps the marker
                // meaning exactly one thing - "a step is waiting on the caller's
                // yes or no" - so a later release can never hand back a cooldown
                // that was legitimately charged several ticks ago.
                this._autonomyModeArmed = null;
                this._noteModeGoalStep(modeStep);
                this.lastAutonomousAt = Date.now();
                return;
            }
            // REFUSED. the step armed a 4-minute cooldown on the way out; charging
            // it for work that never started would silence the brief for four
            // minutes over a backoff that clears in two.
            this._releaseAutonomyModeCooldown();
        }
        // null from a brief is a real answer, not a failure: it falls through here
        // so a mode that has run dry leaves her playing rather than standing in a
        // field being correctly on-message.
        const behavior = this._pickIdleBehavior();
        // ⚠ A DELIBERATE `action: null` IS A DECISION, AND THE FLOOR MUST NOT OVERRULE
        // IT. the menu returns this when standing down IS the right play - frightened,
        // outmatched, letting altoclef's defense chain own her feet. it is a truthy
        // object precisely so it can be told apart from "nothing wanted the tick",
        // which is what `_executeLastResort` exists for. same contract the urgent
        // safety path already uses one screen up.
        if (behavior && behavior.action === null) {
            this._armoryArmed = null;
            this._leisureArmed = null;
            this._obsessionArmed = null;
            this.lastAutonomousAt = Date.now();
            if (behavior.say) this.log('info', `standing down this tick: ${behavior.say}`);
            return;
        }
        if (behavior && this._safeExecute(behavior.action, behavior.params || {}, behavior.say)) {
            // it really went out, so the cooldown it armed is EARNED. clearing the
            // markers keeps them meaning exactly one thing - "a step is waiting on
            // this caller's yes or no" - so a later release can never hand back a
            // cooldown that was legitimately charged several ticks ago.
            this._armoryArmed = null;
            this._leisureArmed = null;
            this._obsessionArmed = null;
            this.lastAutonomousAt = Date.now();
            return;
        }
        // REFUSED (or the menu picked something with no drive behind it). the
        // armory and leisure arm on the way out like the homestead arc does, so
        // give the cooldown back rather than silencing the drive for five minutes
        // over a backoff that clears in two.
        this._releaseIdleDriveCooldowns();
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

    /**
     * "GO AND MINE SOME" IS AN INCREMENT, AND @get IS A HOLD TARGET.
     *
     * Those are different sentences, and the bridge's `amount ?? 1` silently
     * translated one into the other: a dispatch that named no amount asked her
     * to end up holding ONE, which is satisfied before she takes a step for
     * almost anything worth mining. It is not a stall - the task genuinely
     * finishes, reports success, and the node side dutifully asks again on the
     * next cooldown, forever.
     *
     * So an absent amount is resolved HERE, against the live inventory, into
     * held + GATHER_BATCH. An explicitly-passed amount is never touched: those
     * callers (`_materialWants`, `_bakeTarget`, a viewer naming a number) mean
     * the stock level and are right to.
     *
     * ⚠ FAIL TOWARDS WORK, NEVER TOWARDS A NO-OP. If the inventory has not
     * arrived yet, or the alias lookup misses, the fallback is a plain batch -
     * which may over-ask, and over-asking costs a longer trip while under-asking
     * costs the entire feature.
     */
    _resolveGatherAmount(target) {
        const raw = String(target || '').toLowerCase().replace(/^minecraft:/, '').trim();
        if (!raw) return GATHER_BATCH;
        const item = GATHER_ALIASES[raw] || raw;
        // word boundaries, for the reason _inventoryCountRe exists: plain
        // substring counting reads 'charcoal' as coal and 'coal_ore' as coal,
        // and both would size this dispatch off a stack she cannot spend.
        let held = 0;
        try {
            held = this._inventoryCountRe(new RegExp(`\\b${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
        } catch { held = 0; }
        if (!Number.isFinite(held) || held < 0) held = 0;
        // _amount() upstream rejects anything over 2304; stay clear of it.
        return Math.min(2304, held + GATHER_BATCH);
    }

    /**
     * A NAME THE ROOM USES -> A NAME THE GAME ACCEPTS.
     *
     * Her owner is `the owner` everywhere else in burnt and `owner_ingame` in game, so
     * "follow the owner" / "give the owner some bread" reached the bridge as a username
     * that has never existed on any server - which fails the bridge's
     * /^[A-Za-z0-9_]{1,16}$/ check or, worse, passes it and asks altoclef to
     * follow nobody.
     *
     * ⚠ PER-ACTION, NEVER GENERIC. `params.target` also carries items, blocks,
     * place names and her own spoken words depending on the verb; a blanket
     * rewrite would let an alias swallow one of those. Only the slots the
     * bridge feeds to @follow / @give / @look_at are touched.
     *
     * ⚠ Returns the SAME object when nothing changed. This runs on every action
     * dispatch, and a fresh copy each time would defeat the identity checks
     * downstream that ask whether params were rewritten at all.
     */
    _resolvePlayerParams(action, params) {
        if (!params || typeof params !== 'object') return params;
        const slots = PLAYER_NAME_PARAMS[String(action || '').toLowerCase()];
        if (!slots) return params;
        let out = params;
        for (const slot of slots) {
            const raw = out[slot];
            if (typeof raw !== 'string' || !raw.trim()) continue;
            const resolved = resolvePlayerName(raw);
            if (resolved === raw) continue;
            if (out === params) out = { ...params };
            out[slot] = resolved;
            this.log('debug', `resolved ${action} ${slot} "${raw}" -> "${resolved}" (owner alias)`);
        }
        return out;
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
        // SHE ALREADY BUILT HERE, and unlike the block scan above this one knows
        // whose house it is. NEVER RELAXED, for the same reason a claim is not:
        // no amount of failing to find better ground makes founding a second
        // toaster inside the first one a good outcome. It is the standard the
        // block scan was standing in for and could never actually meet - a
        // cobblestone house is invisible to `isPlacedByPeople`, and cobblestone
        // is what every one of hers is made of on its first night.
        const mine = p ? this._conflictingSettlement(p, { dimension: g.dimension }) : null;
        if (mine) {
            reasons.push(`i already built ${mine.name} here (${Math.round(mine.distance)} blocks away, needs ${mine.need})`);
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
        // is what the owner was watching. Skipped once the home is under relocation:
        // that means go_home has already been judged unreachable, and the march
        // is exactly the right answer again.
        const home = this._home();
        // ...but only if the walk home is actually going to be ISSUED. _safeExecute
        // refuses go_home while it is blacklisted (any watchdog, 2min) or during the
        // relocation backoff (15min), and this branch returns BEFORE the march tiers -
        // so a single stalled walk home used to mean every tick for the next two
        // minutes returned go_home, had it refused, and moved her nowhere, in the one
        // place she is not allowed to stand. walking out is always still available.
        const homeWalkable = !this._homeRelocation && home && home.position &&
            this._dimMatches(home.dimension, this.gameState.dimension) &&
            !this._inSpawnRegion(home.position.x, home.position.z) &&
            !this._isAvoided('go_home') &&
            !(this._homeDistance() >= HOME_RELOCATION_MIN_DISTANCE && now < this._homeRelocationBackoffUntil);
        if (homeWalkable) {
            if (now - (this._homesteadCooldowns.get('leave_spawn_region') || 0) < SPAWN_ESCAPE_COOLDOWN_MS) return null;
            this._homesteadCooldowns.set('leave_spawn_region', now);
            return {
                action: 'go_home',
                params: {},
                say: `nothing round spawn is mine to touch. ${home.name} is well outside it, so that's where i'm going`
            };
        }
        if (now - (this._homesteadCooldowns.get('leave_spawn_region') || 0) < SPAWN_ESCAPE_COOLDOWN_MS) return null;
        // THE OCEAN LESSON IS ENFORCED PER-CANDIDATE, NOT BY STANDING STILL.
        // this used to bail on _justLeftWater(), which stays true for five minutes
        // after touching water - and `overWater` fires for a river crossing, a
        // pier, or a baritone bridge. so one stream inside the region parked her
        // for five minutes, and because the tick RETURNS on this step and a null
        // step logs nothing, it was five minutes of motionless bot with no line in
        // the log explaining it. _pickLandingSpot already refuses wet routes, wet
        // endpoints and drowned bearings, so the blanket lockout only ever removed
        // the one movement she is permitted here. still stand down while she is
        // actually IN the water - the water watchdog owns that case.
        if (this._isInWater()) return null;
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
        // same dead end as `pinned`: no handler for the event, and the
        // commentary above is tagged 'unreachable', which the consumer drops.
        // giving up on her own house after N failed departures is a decision
        // with a feeling attached and she had no way to voice it.
        this.noticeBoard.note('home_unreachable',
            `i have set out for ${home.name} ${verdict.attempts} times in ${minutes} minutes and it is still ${Math.round(distance)} blocks away - i am giving up on that route and starting somewhere new`,
            0.7, { tags: ['problem'] });
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

    // the same hand-back for the two idle-menu drives. `_pickIdleBehavior` returns
    // a proposal and the TICK decides whether it runs, so a refusal here is just as
    // possible as it is for the homestead arc - and charging five minutes for work
    // that never started is how a drive goes quiet over a backoff that clears in
    // two. only the key armed by the most recent pass is released.
    _releaseIdleDriveCooldowns() {
        if (this._armoryArmed) {
            this._obsessionCooldowns.delete(this._armoryArmed);
            this._armoryArmed = null;
        }
        if (this._leisureArmed) {
            this._leisureCooldowns.delete(this._leisureArmed);
            this._leisureArmed = null;
        }
        if (this._obsessionArmed) {
            this._obsessionCooldowns.delete(this._obsessionArmed);
            this._obsessionArmed = null;
        }
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

    // ---- which house she is building ---------------------------------------
    //
    // "the bot can choose to make a toaster homestead or a regular homestead, and
    // either works as home. same for outposts."
    //
    // ⚠ THE DECISION IS PERSISTED AND READ BACK BEFORE IT IS EVER RE-TAKEN. Its
    // inputs are her inventory and how established she is, both of which move
    // constantly, so a chooser consulted every tick would swap plans halfway
    // through a wall - the "abandons a half-built house to go build something
    // else" failure, one level up from upgrades.
    //
    // It lives in the GOALS ledger because that is the one durable, per-target,
    // queryable store this file is allowed to write, and because a chosen house
    // genuinely IS a long goal - it shows up in her own goal list as a sentence
    // she can talk about. The Settlement class cannot hold it: every record is
    // round-tripped through settlementFromJSON, which silently drops any field
    // that class does not know about.

    _settlementPlanFromGoal(goal) {
        const id = BLUEPRINT_GOAL_RE.exec(String(goal?.text || ''))?.[1] || null;
        // an id nothing can execute is treated as NO RECORD, never stored as one -
        // the same rule setSettlementUpgrade applies to unknown upgrade ids, and
        // for the same reason: a plan step that silently never runs.
        return (id === TOASTER_PLAN_ID || PROCEDURAL_PLANS[id]) ? id : null;
    }

    /** The house this settlement was decided to be, or null if it never was. */
    _settlementPlan(settlement) {
        const sid = settlement?.id || null;
        if (!sid) return null;
        const mem = this._goals();
        if (mem) {
            try {
                for (const goal of mem.listGoals({ scope: 'long' })) {
                    if (goal.kind !== BLUEPRINT_GOAL_KIND || goal.targetId !== sid) continue;
                    const plan = this._settlementPlanFromGoal(goal);
                    if (plan) return { plan, goal };
                }
            } catch { /* the ledger is a record, never a gate */ }
        }
        const cached = this._settlementPlanCache.get(sid);
        return cached ? { plan: cached, goal: null } : null;
    }

    /** How much shell material of each family she can actually lay hands on. */
    _buildingStock() {
        return {
            stone: this._inventoryCountRe(STOCK_STONE_RE),
            wood: this._inventoryCountRe(STOCK_WOOD_RE)
        };
    }

    /**
     * How many houses on this world are actually standing.
     *
     * ⚠ MUST NOT ASK THE CHOOSER ANYTHING - the chooser reads this, so a survey
     * or a closed blueprint goal are the only two witnesses allowed here.
     */
    _establishedHomes() {
        let count = 0;
        try {
            for (const settlement of this.memory.listSettlements(this._worldId())) {
                const progress = settlement.progress || {};
                const surveyed = progress.housed === true || progress.complete === true;
                const declared = this._settlementPlan(settlement)?.goal?.state === 'done';
                if (surveyed || declared) count++;
            }
        } catch { /* an unreadable ledger just means "no houses yet" */ }
        return count;
    }

    /**
     * WHICH HOUSE, decided from things anyone watching could name.
     *
     * Deterministic on purpose - no dice anywhere - so the same pockets and the
     * same map always give the same answer and a test can hold it still.
     *
     * The toaster is 1126 shell blocks and a night is ten minutes long, so it is
     * the PROJECT, never the starter home: she gets it once she already has a
     * roof, or once she is carrying a stone-person's stock of stone. Before that
     * the question is the honest one - what is the best house she can pay for
     * tonight, in the material she is actually holding.
     */
    _chooseSettlementBlueprint(role = 'homestead', { rehoming = null } = {}) {
        const serves = role === 'outpost' ? 'outpost' : 'homestead';
        const { stone, wood } = this._buildingStock();
        const established = this._establishedHomes();
        // ties go to stone: it is the toaster's material and the one she mines
        // anyway, so an empty bag reads as "stone person" rather than a coin.
        const material = stone >= wood ? 'stone' : 'wood';
        const stock = Math.max(stone, wood);
        // ⚠ A RELOCATION IS NOT NIGHT ONE. She is MOVING a house she already had,
        // usually with an empty bag because the walk there is what failed - and
        // an empty bag is exactly what would otherwise demote her to a 5x5 hut
        // after living in a toaster. (A relocation keeps the same settlement id,
        // so a house that HAS a recorded plan simply inherits it and never
        // reaches this function at all.)
        //
        // ⚠ PASSED IN by the settle branch, not read off `this`: claiming the new
        // ground CLEARS `_homeRelocation` a line before the plan is chosen, so
        // reading it here always saw null on the one path that needed it.
        const moving = rehoming === null ? !!this._homeRelocation : !!rehoming;
        const inputs = { stone, wood, established, material, stock, rehoming: moving };
        if (established >= 1 || moving || stone >= TOASTER_STONE_READY) {
            return {
                plan: TOASTER_PLAN_ID,
                label: 'toaster',
                why: (established >= 1 || moving)
                    ? 'i have had a roof before, so this one is the real toaster'
                    : `carrying ${stone} stone, which is toaster money`,
                ...inputs
            };
        }
        const candidates = Object.entries(PROCEDURAL_PLANS)
            .filter(([, plan]) => plan.serves === serves)
            .filter(([, plan]) => plan.material === 'any' || plan.material === material);
        // the biggest one her pockets cover, then - if none do - the cheapest
        // that exists at all, because a night outside is worse than a small house.
        const affordable = candidates
            .filter(([, plan]) => plan.shellBlocks <= stock)
            .sort((a, b) => b[1].shellBlocks - a[1].shellBlocks)[0];
        const cheapest = candidates.sort((a, b) => a[1].shellBlocks - b[1].shellBlocks)[0]
            || ['simple_shelter', PROCEDURAL_PLANS.simple_shelter];
        const [id, plan] = affordable || cheapest;
        return {
            plan: id,
            label: plan.label,
            why: affordable
                ? `${stock} ${material} in the bag pays for the ${plan.label}`
                : `not enough ${material} for anything better, so the ${plan.label} goes up tonight`,
            ...inputs
        };
    }

    /** Decide once, write it down, and read it back forever after. */
    _ensureSettlementPlan(settlement, opts = {}) {
        const existing = this._settlementPlan(settlement);
        if (existing) return existing;
        const sid = settlement?.id;
        if (!sid) return null;
        const decision = this._chooseSettlementBlueprint(settlement.role, opts);
        // the ram copy first, so a failed disk write still cannot make her
        // re-decide on the next tick with a different bag.
        this._settlementPlanCache.set(sid, decision.plan);
        const goal = this._declareLongGoal(
            `${decision.why} [${decision.plan}]`, BLUEPRINT_GOAL_KIND, sid);
        this.recentEvents.record(`decided the ${decision.label} is what goes up here`);
        return { plan: decision.plan, goal: goal || null, decision };
    }

    /**
     * IS THE HOUSE ACTUALLY UP? Two plans, two witnesses, and neither can answer
     * for the other.
     */
    _settlementBaseComplete(settlement, spec = null) {
        const chosen = this._settlementPlan(settlement);
        // ⚠ NO RECORD MEANS TOASTER, never "incomplete". Every house that
        // predates the chooser is a toaster, and answering false for them would
        // make the whole arc past the build - gallery, yard, fixtures, upgrades -
        // unreachable for the one house she actually lives in.
        if (!chosen || chosen.plan === TOASTER_PLAN_ID) {
            // the in-game survey is the only honest answer for a toaster, and it
            // is self-healing: a creeper takes a wall out and this goes false.
            const reading = spec || this.homeSpec();
            return reading?.met === true;
        }
        // ⚠ A PROCEDURAL HOUSE HAS NO SURVEY. Nothing in the game reports on one,
        // so gating anything on a toaster-shaped `met` would be a completion
        // condition that can never become true - the failure this file documents
        // for restock thresholds and smoker targets. The witness is the
        // build_plan action's own terminal success, which closes this goal.
        return chosen.goal?.state === 'done';
    }

    /**
     * The build step for whichever house this settlement is.
     *
     * Reuses _settlementBuildBehavior for the "am i near enough to work on it"
     * half, so the travel rule has exactly one copy, and only swaps the verb.
     */
    _settlementBuildStep(settlement, planId, say = null) {
        const step = this._settlementBuildBehavior(settlement, say);
        if (!step || step.action !== 'build_settlement') return step;
        if (!planId || planId === TOASTER_PLAN_ID) return step;
        const plan = PROCEDURAL_PLANS[planId];
        if (!plan) return step;
        return {
            action: 'build_plan',
            params: {
                blueprint: planId, settlementId: settlement.id,
                x: settlement.anchor.x, y: settlement.anchor.y, z: settlement.anchor.z
            },
            // ⚠ NO width/depth/height. build_plan carries no footprint on purpose -
            // the plan owns its size, and a caller that can name one is a caller
            // that can disagree with it.
            say: say || `putting the ${plan.label} up. not the toaster - that one is a project, this one is a roof`
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

    // ONLY THE AUTONOMY KNEW WHERE THE BLOCKS GO. `install_appliance` is on her
    // tool schema, so her brain calls it the moment she decides to put the chest
    // in - and with no x/y/z the bridge threw "appliance position must be finite
    // numbers" and the step died on the spot (live, 2026-08-05: two refusals in a
    // row, then "the chest can wait until tomorrow"). the floorplan already knows
    // which square is next; asking it here means every caller gets the same answer
    // the homestead arc would have given, and a genuine "nowhere to put it" comes
    // back as a sentence she can act on instead of a translate error.
    _resolveApplianceParams(params = {}) {
        const p = { ...params };
        if ([p.x, p.y, p.z].every(Number.isFinite)) return p;
        const world = this._worldId();
        const settlement = (p.settlementId ? this.memory.getSettlement(p.settlementId) : null)
            || this.memory.listSettlements(world).find((s) => s.contains(this.gameState.position, 6))
            || this.memory.getMainSettlement?.(world)
            || null;
        if (!settlement) {
            throw new Error('no toaster to install it in yet - build_settlement first, or give exact coordinates');
        }
        const kind = String(p.target || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_') || null;
        const slot = this._nextApplianceSlot(settlement, kind);
        if (!slot) {
            throw new Error(kind
                ? `every ${kind.replace(/_/g, ' ')} square in the floorplan is already filled`
                : 'the floorplan is fully furnished - nothing left to install');
        }
        return { ...p, target: slot.kind, x: slot.x, y: slot.y, z: slot.z, settlementId: settlement.id };
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

    // ---- settlement upgrades: something that finally executes the ledger -----
    //
    // setSettlementUpgrade/nextPlannedUpgrade have existed with NOTHING driving
    // them, which is a plan that stores perfectly, reads back perfectly, and
    // never happens. This is the driver.
    //
    // Three rules it must not break, all of them written elsewhere in this file
    // in blood:
    //   - NOT ONE BLOCK OF UPGRADE BEFORE THE HOUSE IS UP, or she wanders off a
    //     half-built wall to go build a porch.
    //   - every dispatch goes out through _safeExecute like everything else, so
    //     the stall backoff, the by-place stuck streak and the failure blacklist
    //     all supervise it. a step that dispatched itself would be a step no
    //     watchdog in this file can stop.
    //   - a step that keeps failing goes QUIET and then gets abandoned. `attempts`
    //     is a CONSECUTIVE-FAILURE count: it is bumped on terminal failure only
    //     and reset by any success, because a perimeter is a dozen successful
    //     dispatches and counting those would retire the job mid-way through
    //     doing it correctly.

    // ⚠ the record's footprint is always the TOASTER floorplan's, even for a
    // house built to a procedural plan - the Settlement class is frozen and has
    // nowhere to hold a different size. That is fine for everything here, which
    // only wants ground CLEAR OF the building: the toaster is the largest plan,
    // so a mouth and a light ring derived from it sit outside a smaller house
    // rather than inside it. It would NOT be fine for anything that had to touch
    // the building's own blocks.
    _settlementBounds(settlement) {
        const minX = settlement.anchor.x - Math.floor(settlement.width / 2);
        const minZ = settlement.anchor.z - Math.floor(settlement.depth / 2);
        return {
            minX, maxX: minX + settlement.width - 1,
            minZ, maxZ: minZ + settlement.depth - 1,
            floorY: settlement.anchor.y - 1
        };
    }

    /**
     * THE QUARRY MOUTH. Derived, never stored - exactly the way the java twin
     * derives it (Settlement.quarryMouth = anchor.x, floorY, yardMaxZ + 6), so
     * the hole she walks to and the hole burnt remembers are the same hole. Two
     * copies of that arithmetic disagreeing is two holes.
     */
    _quarryMouth(settlement) {
        const b = this._settlementBounds(settlement);
        return { x: settlement.anchor.x, y: b.floorY, z: b.maxZ + SETTLEMENT_YARD_MARGIN + QUARRY_OFFSET };
    }

    /** The wheat plot: the same offset as the quarry, on the opposite side. */
    _farmPlotPoint(settlement) {
        const b = this._settlementBounds(settlement);
        return { x: settlement.anchor.x, y: b.floorY, z: b.minZ - SETTLEMENT_YARD_MARGIN - QUARRY_OFFSET };
    }

    // Evenly spaced stops across a span, both ends included, no gap wider than
    // the spacing. Mirrors Settlement.lightStops - rounding UP the step count and
    // distributing, because stepping from one edge and stopping short leaves a
    // whole unlit strip on the far side.
    _lightStops(min, max, spacing) {
        const span = max - min;
        if (span <= 0) return [min];
        const steps = Math.max(1, Math.ceil(span / spacing));
        const stops = [];
        for (let i = 0; i <= steps; i++) stops.push(min + Math.round((span * i) / steps));
        return stops;
    }

    /**
     * WHERE THE YARD GETS ITS TORCHES.
     *
     * ⚠ the SPACING is read off the live survey (`yardLightSpacing`) whenever the
     * game publishes it, and only falls back to the constant otherwise. That one
     * number is the only thing both sides have to agree on, so it is taken from
     * the world rather than duplicated on faith.
     *
     * Torches stand a block above the floor course, which is the one height in a
     * cleared yard guaranteed to be air with ground under it - which is also why
     * this work comes after the yard is clear. Lighting a forest is placing
     * torches on leaves.
     */
    _perimeterTorchRing(settlement, margin, live = null) {
        const b = this._settlementBounds(settlement);
        const spacing = Math.max(2, Number(live?.yardLightSpacing) || PERIMETER_LIGHT_SPACING);
        const y = b.floorY + 1;
        const ring = [];
        for (const x of this._lightStops(b.minX - margin, b.maxX + margin, spacing)) {
            for (const z of this._lightStops(b.minZ - margin, b.maxZ + margin, spacing)) {
                // the house has its own torches inside and its walls are not ground
                if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) continue;
                ring.push({ x, y, z });
                if (ring.length >= PERIMETER_TORCH_CAP) return ring;
            }
        }
        return ring;
    }

    /** Torch columns down a shaft she has actually dug, deepest last. */
    _quarryTorchSpots(quarry) {
        const spots = [];
        const dug = Math.max(0, Number(quarry.depth) || 0);
        for (let i = 0; i * QUARRY_TORCH_SPACING <= dug && spots.length < QUARRY_TORCH_CAP; i++) {
            spots.push({ x: quarry.mouth.x, y: quarry.mouth.y - i * QUARRY_TORCH_SPACING, z: quarry.mouth.z });
        }
        return spots;
    }

    _pointKey(p) {
        return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
    }

    _perimeterSeen(settlementId) {
        let seen = this._perimeterDone.get(settlementId);
        if (!seen) { seen = new Set(); this._perimeterDone.set(settlementId, seen); }
        return seen;
    }

    /** done AND actually achieved - an abandoned upgrade is parked in `done` too. */
    _upgradeAchieved(record) {
        return record?.state === 'done' && record.note !== UPGRADE_ABANDONED_NOTE;
    }

    _retireUpgrade(settlementId, upgradeId, note) {
        this.memory.setSettlementUpgrade(settlementId, upgradeId, { state: 'done', note });
        this.log('info', `upgrade ${upgradeId} on ${settlementId}: ${note}`);
    }

    _upgradeBackoff(attempts) {
        if (attempts <= 0) return 0;
        return Math.min(UPGRADE_RETRY_BACKOFF_MAX_MS, UPGRADE_RETRY_BACKOFF_MS * 2 ** (attempts - 1));
    }

    _upgradeTag(settlementId, upgradeId) {
        return { _upgrade: `${settlementId}|${upgradeId}` };
    }

    /**
     * What this house should still have doing, seeded once and only ever added
     * to. Nothing here plans an upgrade the executor cannot carry out - an id
     * with no step is a plan entry that silently never runs, which is the exact
     * shape setSettlementUpgrade rejects unknown ids to avoid.
     */
    _planSettlementUpgrades(settlement) {
        const sid = settlement?.id;
        if (!sid) return;
        const book = this.memory.getSettlementUpgrades(sid);
        const plan = (uid) => { if (!book[uid]) this.memory.setSettlementUpgrade(sid, uid, { state: 'planned' }); };
        plan('torch_perimeter');
        if (settlement.role !== 'outpost') {
            plan('wheat_farm');
            plan('quarry');
        }
        if (this._upgradeAchieved(book.torch_perimeter)) plan('expand_torch_perimeter');
        if (this._upgradeAchieved(book.quarry)) plan('upgrade_quarry');
        // ⚠ SHELL_IRON RE-OPENS THE ENTIRE SHELL AS OUTSTANDING WORK - 1126 blocks
        // at nine ingots each. It is not planned until she is ALREADY holding the
        // stock the java material ladder needs to climb to that rung, so it can
        // never be something she drifts into having a good afternoon.
        const toaster = this._settlementPlan(settlement)?.plan === TOASTER_PLAN_ID;
        if (toaster && this._inventoryCountRe(/\biron_block\b/) >= SHELL_IRON_RICH_BLOCKS) plan('shell_iron');
        // ⚠ THE MOAT IS ONLY EVER PLANNED WHEN SOMEBODY ASKED FOR ONE - the
        // operator flag here, or an explicit setSettlementUpgrade from a chat or
        // llm request. 1250 block breaks self-scheduled is a stream of digging
        // nobody chose, and the java side gates on the same flag from the wire.
        if (toaster && this._trenchEnabled()) plan('defense_trench');
    }

    /**
     * A dispatch whose terminal never came back leaves its upgrade parked in
     * `building`, where nextPlannedUpgrade will never offer it and nothing else
     * for this house can start either. Put it back.
     */
    _reclaimStalledUpgrades(settlementId) {
        const book = this.memory.getSettlementUpgrades(settlementId);
        const live = [...this.pendingActions.values()]
            .some((pending) => String(pending.params?._upgrade || '').startsWith(`${settlementId}|`));
        if (live) return;
        const now = Date.now();
        for (const uid of SETTLEMENT_UPGRADE_ORDER) {
            const record = book[uid];
            if (record?.state !== 'building') continue;
            if (now - (Number(record.at) || 0) < UPGRADE_STALE_BUILDING_MS) continue;
            this.memory.setSettlementUpgrade(settlementId, uid, { state: 'planned' });
            this.log('warn', `upgrade ${uid} was left mid-flight with nothing running; putting it back on the plan`);
        }
    }

    /**
     * The next upgrade step for this house, or null.
     *
     * ⚠ RETURNS A STEP WITH A `commit` CALLBACK rather than writing the ledger
     * here. The caller may still refuse to run it (a blacklisted action, the busy
     * gate), and charging a gap and an attempt for work that never left the
     * building is the survival-prep bug this file documents twice.
     */
    _settlementUpgradeStep(settlement, spec = null) {
        const sid = settlement?.id;
        if (!sid) return null;
        // NOT ONE BLOCK UNTIL THE HOUSE ITSELF IS UP.
        if (!this._settlementBaseComplete(settlement, spec)) return null;
        this._planSettlementUpgrades(settlement);
        this._reclaimStalledUpgrades(sid);
        const book = this.memory.getSettlementUpgrades(sid);
        // one job at a time: an upgrade already in flight is CONTINUED, never
        // left half-done while she starts the next thing on the list.
        const uid = SETTLEMENT_UPGRADE_ORDER.find((id) => book[id]?.state === 'building')
            || this.memory.nextPlannedUpgrade(sid);
        if (!uid) return null;
        const now = Date.now();
        if (now - (this._upgradeCooldowns.get(`${sid}|${uid}`) || 0) < UPGRADE_STEP_COOLDOWN_MS) return null;
        const record = book[uid] || {};
        const attempts = Number(record.attempts) || 0;
        if (attempts >= UPGRADE_MAX_ATTEMPTS) {
            this._retireUpgrade(sid, uid, UPGRADE_ABANDONED_NOTE);
            return null;
        }
        if (record.lastAttemptAt && now - record.lastAttemptAt < this._upgradeBackoff(attempts)) return null;
        let step = null;
        try {
            step = this._upgradeStepFor(settlement, uid, spec);
        } catch (err) {
            // a step builder that throws costs its own turn, never the tick
            this.log('warn', `upgrade ${uid} step failed to build: ${err.message}`);
            return null;
        }
        if (!step) return null;                       // nothing to do this tick
        if (step.done) {
            this.memory.setSettlementUpgrade(sid, uid, { state: 'done', note: step.note || null, attempts: 0 });
            this.recentEvents.record(`finished ${uid.replace(/_/g, ' ')} at ${settlement.name}`);
            this._closeUpgradeGoal(uid, settlement);
            return null;
        }
        if (step.retire) {
            this._retireUpgrade(sid, uid, step.note || UPGRADE_ABANDONED_NOTE);
            // a retired upgrade is not coming back, so its standing goal must not
            // outlive it either - see _closeUpgradeGoal.
            this._closeUpgradeGoal(uid, settlement);
            return null;
        }
        return {
            action: step.action,
            params: { ...(step.params || {}), ...this._upgradeTag(sid, uid) },
            say: step.say || null,
            commit: () => {
                this._upgradeCooldowns.set(`${sid}|${uid}`, Date.now());
                this.memory.setSettlementUpgrade(sid, uid, { state: 'building' });
            }
        };
    }

    /**
     * CLOSE THE STANDING GOAL AN UPGRADE DECLARED.
     *
     * ⚠ THE QUARRY GOAL COULD NEVER BE CLOSED BY ANYTHING. `_declareLongGoal(...,
     * 'quarry', ...)` fires from two places and `_finishLongGoal` was only ever
     * called for the blueprint and the homestead - so "dig the quarry out properly"
     * sat in her prompt forever, however deep the hole got, and held one of the
     * eight long slots for good. With MAX_QUARRIES 8 that alone can fill the whole
     * long scope, and a full long scope is what starts evicting the blueprint goal
     * that records which house a settlement actually is.
     *
     * Keyed off the upgrade reaching a terminal state, which is the world's own
     * answer rather than a second opinion kept by burnt.
     */
    _closeUpgradeGoal(uid, settlement) {
        const quarry = uid === 'quarry' || uid === 'upgrade_quarry'
            ? this.memory.quarryForSettlement(settlement.id)
            : null;
        if (quarry) this._finishLongGoal('quarry', quarry.id);
    }

    /** Travel half only - null once she is close enough to work on the place. */
    _settlementTravelStep(settlement, say = null) {
        const step = this._settlementBuildBehavior(settlement, say);
        return step && step.action !== 'build_settlement' ? { ...step, say: say || step.say } : null;
    }

    _upgradeStepFor(settlement, uid, spec = null) {
        switch (uid) {
            case 'torch_perimeter':
            case 'expand_torch_perimeter':
                return this._perimeterLightStep(settlement, uid, spec);
            case 'wheat_farm':   return this._wheatFarmUpgradeStep(settlement);
            case 'quarry':       return this._quarryUpgradeStep(settlement);
            case 'upgrade_quarry': return this._quarryLightStep(settlement);
            case 'shell_iron':   return this._shellIronStep(settlement, spec);
            case 'defense_trench': return this._defenseTrenchStep(settlement, spec);
            // an id with no step here is retired rather than left planned: a plan
            // entry nothing can execute blocks every entry behind it forever.
            default: return { retire: true, note: 'nothing here can do that one' };
        }
    }

    _perimeterLightStep(settlement, uid, spec = null) {
        const live = this._matchingBuild(settlement);
        // THE WORLD OUTRANKS ANYTHING BURNT COUNTED. For a toaster the survey
        // really walks the yard and reports `yardLit`, so when it says the lights
        // are in, they are in - no ledger of ours gets a vote.
        if (uid === 'torch_perimeter' && live?.yardLit === true) return { done: true };
        const margin = uid === 'expand_torch_perimeter'
            ? SETTLEMENT_YARD_MARGIN * 2 : SETTLEMENT_YARD_MARGIN;
        const ring = this._perimeterTorchRing(settlement, margin, live);
        const seen = this._perimeterSeen(settlement.id);
        const next = ring.find((spot) => !seen.has(`${uid}|${this._pointKey(spot)}`));
        if (!next) return { done: true };
        if (this._inventoryCount('torch') < PERIMETER_TORCH_FLOOR) {
            return {
                action: 'get', params: { target: 'torch', amount: 16 },
                say: 'a dark yard is a mob farm with a view. getting torches for it'
            };
        }
        const travel = this._settlementTravelStep(settlement, 'going back to light the yard properly');
        if (travel) return travel;
        return {
            action: 'place_block',
            // ⚠ place_block, NEVER install_appliance. An appliance is a PLANNED
            // fixture that gets written to the settlement's ledger and counted
            // against appliancesRequired - filing yard torches there would make
            // the gallery permanently unfinished and have the survey demanding a
            // furnace in the middle of a lawn.
            params: { block: 'torch', x: next.x, y: next.y, z: next.z },
            say: uid === 'expand_torch_perimeter'
                ? 'pushing the light further out. nothing gets to spawn where i can see it'
                : 'torch on the perimeter. i cleared ten blocks round this house, i am not donating them to skeletons'
        };
    }

    _wheatFarmUpgradeStep(settlement) {
        const plot = this._farmPlotPoint(settlement);
        const travel = this._settlementTravelStep(settlement, 'heading back to break ground for the field');
        if (travel) return travel;
        return {
            action: 'farm',
            params: { mode: 'create', x: plot.x, y: plot.y, z: plot.z, radius: 4 },
            say: 'putting a wheat field in beside the house. bread is not a hobby, it is infrastructure'
        };
    }

    /**
     * THE QUARRY. A place, not a feature flag: one fixed mouth she walks back to,
     * so "nearest stone" is measured from inside the same hole every restock and
     * it deepens into a mine instead of a ring of scrapes round the house.
     *
     * The record is written on the FIRST pass so gather_materials' quarry route
     * can find it immediately; the upgrade then completes when she has actually
     * dug there, not merely when the ledger has a row in it.
     */
    _quarryUpgradeStep(settlement) {
        const mouth = this._quarryMouth(settlement);
        const world = this._worldId();
        let quarry = this.memory.quarryForSettlement(settlement.id);
        if (!quarry) {
            const made = this.memory.recordQuarry({
                settlementId: settlement.id, mouth, dimension: settlement.dimension,
                world, name: 'the quarry'
            });
            quarry = made?.entry || null;
            if (made?.isNew) {
                this._declareLongGoal('dig the quarry out properly', 'quarry', quarry.id);
                this.recentEvents.record('opened the quarry behind the house');
            }
        }
        if (!quarry) return { retire: true, note: 'could not put a quarry there' };
        const p = this._point(this.gameState.position);
        const away = p ? Math.hypot(p.x - quarry.mouth.x, p.z - quarry.mouth.z) : Infinity;
        if (away > 24) {
            return {
                action: 'move',
                params: { x: quarry.mouth.x, y: quarry.mouth.y, z: quarry.mouth.z, target: quarry.name },
                say: 'the hole goes behind the house, past the yard. one hole, dug properly, forever'
            };
        }
        return {
            action: 'get', params: { target: 'cobblestone', amount: 64 },
            say: 'breaking the quarry open. every wall i ever build comes out of this hole now'
        };
    }

    /**
     * Light what has actually been dug. ⚠ The depth is burnt's own running
     * ESTIMATE (each dig at the mouth deepens it), not telemetry - the game
     * reports no shaft depth. So a spot below the real floor is a place_block
     * that fails, which bumps the consecutive-failure count, and five of those
     * retire the upgrade. That is the intended outcome: she lit what existed and
     * stopped, rather than clicking at bedrock forever.
     */
    _quarryLightStep(settlement) {
        const quarry = this.memory.quarryForSettlement(settlement.id);
        if (!quarry) return { retire: true, note: 'no quarry here to light' };
        const spots = this._quarryTorchSpots(quarry);
        const lit = new Set((quarry.torches || []).map((t) => this._pointKey(t)));
        const next = spots.find((spot) => !lit.has(this._pointKey(spot)));
        if (!next) {
            this.memory.updateQuarry(quarry.id, { level: (Number(quarry.level) || 1) + 1 });
            return { done: true };
        }
        if (this._inventoryCount('torch') < PERIMETER_TORCH_FLOOR) {
            return {
                action: 'get', params: { target: 'torch', amount: 16 },
                say: 'my own mine is pitch black and full of things. torches first'
            };
        }
        return {
            action: 'place_block',
            params: { block: 'torch', x: next.x, y: next.y, z: next.z },
            say: 'lighting the shaft on the way down. a lit mine is a mine, an unlit one is a spawner'
        };
    }

    /**
     * IRON. The top rung of the java material ladder and the one that re-opens
     * every block of the shell, so it stays gated on her genuinely holding the
     * stock rather than on her feeling wealthy.
     */
    _shellIronStep(settlement, spec = null) {
        const reading = spec || this.homeSpec();
        if (String(reading?.material || '') === 'iron_block') return { done: true };
        const blocks = this._inventoryCountRe(/\biron_block\b/);
        if (blocks < SHELL_IRON_RICH_BLOCKS) {
            return {
                action: 'get', params: { target: 'iron_block', amount: SHELL_IRON_RICH_BLOCKS },
                say: `${blocks} iron blocks. the house becomes iron at ${SHELL_IRON_RICH_BLOCKS} and not one before`
            };
        }
        // the java builder picks the material off what she is carrying, so
        // re-issuing the build IS the upgrade - it re-surveys every block of the
        // shell against the better one.
        return this._settlementBuildStep(settlement, TOASTER_PLAN_ID,
            'the whole shell goes iron. i said if i ever actually arrived, and i have');
    }

    /**
     * THE MOAT. Four deep and two wide, dug outside the lit yard, with one
     * causeway on the +Z face and a fence gate on its outer lip.
     *
     * The dig itself belongs to the java build task - the schematic already knows
     * every column of the ring - so this step is `build_settlement` again with the
     * trench turned on, exactly like _shellIronStep re-issues the build to climb
     * the material ladder. There is no per-block dispatch here on purpose: 1250
     * breaks handed out one at a time over a 4-minute upgrade cooldown is not a
     * moat, it is a hobby.
     *
     * ⚠ THE WORLD SAYS WHEN IT IS FINISHED, never a ledger of ours - and it says
     * so with `trenchDone`, not with the counters. See the note at the check.
     */
    _defenseTrenchStep(settlement, spec = null) {
        const live = this._matchingBuild(settlement);
        const left = Number(live?.trenchRemaining);
        // ⚠ DONE IS `trenchDone`, NOT "both counters are zero". A survey taken
        // while the trench was switched off publishes trenchRemaining 0 and
        // trenchLightsRemaining 0 - which is indistinguishable from a finished
        // ring by the counters alone, so reading them would retire this upgrade
        // on its first tick having dug precisely nothing. `trench` says the
        // settlement was asked for one; `trenchDone` says it has one, and it is
        // the only field that also knows whether the gate is hung.
        if (live?.trench === true && live?.trenchDone === true) return { done: true };
        const travel = this._settlementTravelStep(settlement, 'heading back to dig the moat out');
        if (travel) return travel;
        // Did the LAST trip out there actually move anything? A ring that has not
        // shrunk since she last stood in it is one she cannot finish - a column in
        // bedrock, under someone's claim, in a chunk that will not load - and the
        // answer to that is an hour off, not another four-minute swing at it.
        // Same shape as the yard's watch, and for the same reason.
        const now = Date.now();
        const watch = this._trenchWatch;
        if (watch && Number.isFinite(left) && Number.isFinite(watch.remaining)
            && left >= watch.remaining && now - watch.at < TRENCH_STUCK_BACKOFF_MS) {
            return null;
        }
        this._trenchWatch = { remaining: Number.isFinite(left) ? left : null, at: now };
        const step = this._settlementBuildStep(settlement, TOASTER_PLAN_ID, Number.isFinite(left) && left > 0
            ? `${left} blocks of ditch left. nothing walks in here that did not use the bridge`
            : 'digging the moat. four deep, because three is a step and four is a decision');
        // ⚠ THE FLAG HAS TO RIDE ON THIS DISPATCH. The java Settlement rebuilds
        // `trenchEnabled` off the wire every build, so a build_settlement without
        // it is a build that fills the ditch back in - and the canonicalizer only
        // volunteers the operator flag, which is off by default.
        return step && step.action === 'build_settlement'
            ? { ...step, params: { ...step.params, trench: true } }
            : step;
    }

    /**
     * THE ONLY WITNESS A PROCEDURAL HOUSE HAS.
     *
     * A toaster is watched by the in-game survey every couple of seconds. A
     * build_plan house is watched by nothing at all, so if this terminal success
     * did not close the blueprint goal, `_settlementBaseComplete` could never
     * become true for it - upgrades would never start, and she would re-issue the
     * same finished build forever. That is this file's recurring "completion
     * condition that can never be met", and it is one line away at all times.
     */
    _noteBuildPlanFinished(pending) {
        if (pending?.action !== 'build_plan') return;
        const sid = String(pending.params?.settlementId || '');
        if (!sid) return;
        if (this._finishLongGoal(BLUEPRINT_GOAL_KIND, sid)) {
            this.recentEvents.record(`finished the ${String(pending.params?.blueprint || 'house').replace(/_/g, ' ')}`);
        }
        // ⚠ NO protect_settlement here, deliberately. The bridge resolves that
        // command's box from the TOASTER floorplan, so arming it round a
        // procedural house would guard the wrong blocks - and a protection box
        // that disagrees with the building is worse than none at all.
    }

    /**
     * A dispatch that carried an upgrade tag came back. ⚠ WIRED INTO EVERY
     * TERMINAL PATH, not just the error branch: a stalled job is stopped by the
     * watchdog and altoclef reports a CANCELLED task as `success`, and a job that
     * never acks ends in _expirePendingAction. An outcome hook on one of the
     * three is unreachable on the two that actually happen.
     */
    _noteUpgradeOutcome(pending, ok) {
        const tag = String(pending?.params?._upgrade || '');
        const cut = tag.indexOf('|');
        if (cut <= 0) return;
        const sid = tag.slice(0, cut);
        const uid = tag.slice(cut + 1);
        const params = pending.params || {};
        if (!ok) {
            // a consecutive failure: bump it, stamp it, and put the job back on
            // the plan so the backoff - not a wedged `building` row - decides
            // when she tries again.
            this.memory.setSettlementUpgrade(sid, uid, { state: 'planned', attempt: true });
            // A TORCH SPOT SHE COULD NOT FILL IS SKIPPED, NOT RE-PICKED. Nearest-
            // wins would hand her the identical impossible block every time the
            // latch expired - the documented hand-build failure, one ledger over.
            // The commonest cause is benign: a torch is already burning there.
            if ((uid === 'torch_perimeter' || uid === 'expand_torch_perimeter') &&
                [params.x, params.y, params.z].every(Number.isFinite)) {
                this._perimeterSeen(sid).add(`${uid}|${this._pointKey(params)}`);
            }
            return;
        }
        // SUCCESS CLEARS THE FAILURE COUNT. attempts means "in a row".
        this.memory.setSettlementUpgrade(sid, uid, { attempts: 0 });
        const settlement = this.memory.getSettlement(sid);
        switch (uid) {
            case 'torch_perimeter':
            case 'expand_torch_perimeter':
                if ([params.x, params.y, params.z].every(Number.isFinite)) {
                    this._perimeterSeen(sid).add(`${uid}|${this._pointKey(params)}`);
                }
                break;
            case 'wheat_farm': {
                if (pending.action !== 'farm') break;
                // THE FIELD HAS TO ENTER THE FOOD LEDGER OR THE FOOD RUN WILL
                // NEVER COME BACK TO IT. Recorded and then immediately clocked as
                // not-yet-ready: she has just tilled and planted it, so it is a
                // real field that is genuinely bare, and the regrow clock is
                // exactly the right way to say that. `reported` so it cannot
                // spend a strike against a field she made herself.
                const dim = settlement?.dimension || this.gameState.dimension;
                const plot = [params.x, params.y, params.z].every(Number.isFinite)
                    ? { x: params.x, y: params.y, z: params.z }
                    : (settlement ? this._farmPlotPoint(settlement) : null);
                if (plot) {
                    try {
                        this.memory.recordFoodSpot('wheat', plot, dim, { count: 9, ripe: false, world: this._worldId() });
                        this.memory.noteFoodSpotEmpty(plot, dim, 'wheat', undefined, { reported: true });
                    } catch { /* the ledger is an enhancement, never a gate */ }
                }
                this.memory.setSettlementUpgrade(sid, uid, { state: 'done' });
                this.recentEvents.record('put a wheat field in beside the house');
                break;
            }
            case 'quarry': {
                const quarry = this.memory.quarryForSettlement(sid);
                if (!quarry) break;
                // ARRIVING IS NOT DIGGING. only the dig closes it, or the walk
                // there would report a finished quarry with no hole in it.
                if (pending.action !== 'get') break;
                this.memory.updateQuarry(quarry.id, {
                    lastWorkedAt: true,
                    depth: (Number(quarry.depth) || 0) + QUARRY_TORCH_SPACING
                });
                this.memory.setSettlementUpgrade(sid, uid, { state: 'done' });
                this.recentEvents.record('the quarry is open behind the house');
                break;
            }
            case 'upgrade_quarry': {
                const quarry = this.memory.quarryForSettlement(sid);
                if (quarry && [params.x, params.y, params.z].every(Number.isFinite)) {
                    this.memory.recordQuarryTorch(quarry.id, { x: params.x, y: params.y, z: params.z });
                }
                break;
            }
            default:
                break;
        }
    }

    // the homestead arc is the deterministic idle goal: settle, build the exact
    // toaster shell, then fill its floorplan one block at a time.
    // Viewer/operator/LLM goals still win because this is only called
    // after the task slots are empty.
    _homesteadBehavior() {
        const g = this.gameState;
        // ⚠ THE ARC STANDS DOWN WHILE SHE IS AWAY ON A TRIP.
        //
        // `_expeditionStep` outranks this rung, but it returns null whenever a leg is
        // on cooldown or no dry ground lies further out - and the tick then falls
        // straight through to here. Every step in this arc is bound to the house
        // (install an appliance, restock at the quarry, deposit in the home chest),
        // so from 2000 blocks out they all resolve to some flavour of "walk home".
        // That would undo a trip a few ticks after it started, and the fault would
        // look like the expedition simply not working rather than this arc quietly
        // outvoting it. Nobody walks two thousand blocks and then nips back to fit a
        // furnace.
        if (this._onExpedition()) return null;
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
                    // SHE PICKS THE HOUSE THE MOMENT SHE PICKS THE GROUND, and
                    // the pick is written down before a single block goes in -
                    // the inputs are her pockets, which change constantly, so a
                    // decision re-taken later is a half-built house abandoned.
                    const claimed = this.homeSpec().settlement;
                    // ⚠ `relocation` is the local captured at the top of this pass -
                    // _claimAutomaticHome has already cleared this._homeRelocation
                    // by now, and "am i moving house" is the input that stops a
                    // rebuild with an empty bag reading as night one.
                    const chosen = this._ensureSettlementPlan(claimed, { rehoming: !!relocation });
                    return this._settlementBuildStep(claimed, chosen?.plan,
                        chosen?.plan && chosen.plan !== TOASTER_PLAN_ID
                            ? `new home claimed. ${PROCEDURAL_PLANS[chosen.plan]?.label || 'house'} goes up before i wander off again`
                            : 'new home claimed. starting the smooth-stone toaster shell before i wander off again');
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
                // never propose ground she has already built on - cheaper and far
                // less confusing than walking her out to it and refusing it there,
                // which spends one of six attempts to learn what the ledger knew.
                const keepClear = this._settlementKeepouts();
                for (let i = 0; i < 4 && !spot; i++) {
                    const candidate = this._pickLandingSpot(p, HOME_SEARCH_MIN_DISTANCE, HOME_SEARCH_MAX_DISTANCE,
                        { notInSpawnRegion: true, awayFrom: keepClear });
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
                // ⚠ AN ATTEMPT IS SPENT WHEN SHE ACTUALLY GOES, NOT WHEN A STEP IS
                // OFFERED. both of these used to be written straight here - the counter
                // and the cooldown - so a `move` the caller then REFUSED (the verb is
                // blacklisted for LOOP_AVOID_MS after any stall, which is routine) cost
                // one of six attempts and armed a 45s cooldown with her standing
                // perfectly still. Three refusals and the search gives up having never
                // walked anywhere. The comment ten lines up fixes exactly this for the
                // no-candidate case, in these words - "burned all six attempts without
                // her taking a single step" - and this was the other half of it.
                //
                // `arm()` makes the cooldown releasable by _releaseHomesteadCooldown,
                // and the counter rides the `commit` callback the caller already runs
                // only on a step that really went out.
                arm('search_nearby_home');
                // she is walking away from this patch having judged it: remember
                // the verdict so the next candidate is somewhere she has not
                // already stood and said no. this one is NOT deferred - it is a verdict
                // on ground she is standing on and has assessed, true whether or not
                // the walk away from it is allowed to start.
                this._recordSiteRejection(p, site.reasons);
                return {
                    commit: () => { relocation.attempts += 1; },
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
        // WHICH HOUSE IS THIS?
        //
        // ⚠ READ ONLY - THE CHOICE IS MADE WHERE THE GROUND IS CLAIMED, and only
        // there. This branch also runs for a home she did not pick: an existing
        // save, an operator standing somewhere and saying set_home, a house she
        // has lived in for weeks. For every one of those the answer is the
        // toaster, because it already is - deciding again here would be reading
        // her pockets and converting a house she is standing inside.
        const chosen = this._settlementPlan(spec.settlement);
        const planId = chosen?.plan || TOASTER_PLAN_ID;
        const toaster = planId === TOASTER_PLAN_ID;
        const planLabel = toaster ? 'toaster' : (PROCEDURAL_PLANS[planId]?.label || 'house');
        // ⚠ `spec.met` IS THE TOASTER SURVEY AND ONLY THE TOASTER SURVEY. For a
        // procedural house it can never become true, so every gate below reads
        // the plan-aware answer instead - otherwise the whole arc past the build
        // is unreachable for four of the five houses she can put up.
        const baseUp = this._settlementBaseComplete(spec.settlement, spec);
        // THE LONG GOAL BEHIND EVERY STEP THE ARC TAKES. session-flagged rather
        // than re-declared each tick: addGoal dedupes, but it also SAVES, and a
        // disk write every 25 seconds to restate a fact she already knows is not
        // a memory, it is churn.
        if (!baseUp && !this._homesteadGoalDeclared) {
            this._homesteadGoalDeclared = true;
            this._declareLongGoal(`get the homestead ${planLabel} standing`, 'homestead', spec.settlement?.id || null);
        } else if (baseUp && !this._homesteadGoalClosed) {
            this._homesteadGoalClosed = true;
            this._finishLongGoal('homestead', spec.settlement?.id || null);
        }
        if (!baseUp) {
            const next = this._settlementBuildStep(spec.settlement, planId, toaster
                ? `main toaster is ${spec.percent}% done. ${this._buildPhaseLabel(spec.phase)}; stone first, appliances after`
                : `getting the ${planLabel} up. a roof tonight beats a monument next week`);
            const key = (next?.action === 'build_settlement' || next?.action === 'build_plan')
                ? 'build_main_toaster' : 'go_home_for_build';
            if (next && !onCooldown(key)) {
                arm(key);
                return next;
            }
        }

        // A fresh completed survey is mandatory. If building is cooling down,
        // don't sneak furniture into an unverified shell.
        if (!baseUp) return null;

        // EVERYTHING FROM HERE TO THE FIXTURES READS THE TOASTER'S FLOORPLAN -
        // the gallery, the surveyed yard, the bed nook. A procedural house has
        // none of it (its java plan builds its own bench, bed, chests and
        // furnaces as build stages), so it skips straight to the upgrades below
        // rather than being measured against a map it was never built to.
        if (toaster && homeDist > HOMESTEAD_NEAR_HOME && !onCooldown('go_home_for_gallery')) {
            arm('go_home_for_gallery');
            return { action: 'go_home', params: {}, say: 'the shell is ready. going home to fill the middle with furnaces' };
        }

        // A MAINTENANCE LOOK. Re-issuing the build on a finished shell surveys,
        // finds nothing to do and ends - which is exactly the cheap fresh
        // reading the heal in _nextApplianceSlot needs, and it catches creeper
        // damage besides. Attempt-timed, not result-timed: if the reading never
        // arrives this costs one tick every fifteen minutes instead of starving
        // the gallery forever.
        if (toaster
            && Date.now() - Number(this._matchingBuild(spec.settlement)?.updatedAt || 0) > GALLERY_RESURVEY_MS
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
        const slot = toaster ? this._nextApplianceSlot(spec.settlement) : null;
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
        if (toaster && !spec.yardClear && !onCooldown('clear_yard')) {
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
        if (toaster && nb.craftingTable == null) fixtures.push(hasExact('crafting_table')
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
        if (toaster && nb.bed == null) {
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

        // -- upgrade: what the house still wants doing.
        //
        // BELOW THE BASE BUILD AND EVERYTHING THE PLAN ITSELF ASKS FOR, above the
        // pantry and the idle menu. The ordering is the whole safety property: an
        // upgrade that could start before the shell was finished is a half-built
        // wall abandoned to go and light a lawn.
        //
        // ⚠ carries its own `commit`, charged only when the caller really
        // dispatches, so a refused step costs neither its gap nor an attempt.
        const upgrade = this._settlementUpgradeStep(spec.settlement, spec);
        if (upgrade) return upgrade;

        // -- live: the bread pipeline + putting the haul away.
        // a stocked pantry, not a zero-check: a bread professional restocks at
        // BREAD_FLOOR, she doesn't wait until she's completely out.
        const wheatCount = this._wheatCount();
        if (this._breadCount() < BREAD_FLOOR && wheatCount < 3 && !onCooldown('wheat_run')) {
            arm('wheat_run');
            // ⚠ SHOP BEFORE YOU FARM. this trigger is about the loaves in her
            // POCKETS, which is right - but the old answer to an empty pocket was
            // always a field. with a stocked chest nearby the honest answer is to
            // go and take her own bread; growing more of what she owns is the
            // reported bug in one line.
            const shelf = this._pantryStep('bread', Math.max(1, BREAD_COMFORT - this._breadCount()));
            return shelf || this._foodRunStep(p, g.dimension);
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
        // an EXPLICIT manifest, never a bare deposit: the bare one banks her bread
        // too and nothing in the stack can take it back out. no bankable haul ->
        // no trip, rather than a trip that empties the pantry.
        const haul = bagFull && nb.chest != null ? this._depositManifest() : [];
        if (haul.length && !onCooldown('deposit')) {
            arm('deposit');
            return { action: 'deposit', params: { items: haul }, say: 'offloading the haul into the home chest. the bread stays on me' };
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

    // the stock level to ask `craft bread` for: bake the whole pantry up to `cap`
    // in ONE order instead of a loaf at a time.
    //
    // ⚠ BOUNDED BY THE WHEAT SHE IS ACTUALLY HOLDING, and that bound is the whole
    // reason this is a function. `@get bread n` is recursive - if she is short of
    // wheat it silently becomes a crop expedition, which is the documented live
    // failure where she claimed to be crafting bread and stood in a field
    // rescanning for 3m38s. so the order may only ever be for loaves she can bake
    // from her own pockets: what she has, plus what her wheat pays for. gathering
    // the wheat is the wheat run's job, above, where it is a goal she can see.
    //
    // returns 0 when there is nothing to gain, so a caller can tell "already
    // stocked" apart from a real order rather than issuing a no-op that reports
    // success the instant it starts.
    //
    // NOT gated on owning a crafting table, deliberately, though bread is a 3-wide
    // recipe and `@get bread n` without one recurses planks -> logs -> a tree run.
    // that is the same hidden-expedition class as the wheat, and it was judged
    // acceptable where the wheat was not: trees are everywhere (the wheat freeze
    // happened because a field genuinely was not), she needs a table for
    // everything else anyway, and the homestead arc places one as a fixture. a
    // gate here would also read `nb.craftingTable`, which is absent on older
    // companion jars - so it would silently stop her baking at all rather than
    // stop her wandering.
    // ⚠ `pantry` IS WHY THE REPORTED BUG HAPPENED. every cap here (COMFORT, HOARD)
    // is a question about SUPPLY - "do i need to make more bread" - and it was
    // being answered from her pockets, so five hundred loaves in a chest at home
    // counted for nothing and the answer was always yes.
    //
    // ⚠ but the WHEAT bound stays carried-only and must never be relaxed by
    // stored wheat: `@get bread n` is recursive, so an order she cannot fill from
    // her own pockets silently becomes a crop expedition - the documented 3m38s
    // freeze. wheat in a chest is wheat she has to withdraw FIRST, in its own
    // visible trip, exactly like wheat in a field.
    //
    // ⚠ and `pantry:false` is for SURVIVAL callers only. a chest is not food: when
    // she is carrying nothing to eat, a full pantry three hundred blocks away is
    // not a reason to skip the bake she can do right now out of her own wheat.
    _bakeTarget(cap, { pantry = true } = {}) {
        const have = this._breadCount();
        if (pantry && this._pantryBread() >= cap) return 0;
        const affordable = have + Math.floor(this._wheatCount() / WHEAT_PER_LOAF);
        const target = Math.min(cap, affordable);
        return target > have ? target : 0;
    }

    // ONE RESTOCK TRIP, and the whole point is that it has more than one answer.
    //
    // the old version had exactly two moves: walk to the nearest remembered wheat
    // spot, or ask altoclef to find wheat. with the remembered spot harvested and
    // no other field around, both of those are the same nothing - which is the
    // "keeps going to a wheat spot that's depleted" report. the routes below are in
    // order of what she'd actually rather be doing, and every one of them is a place
    // she has personally seen food, or a hunt that needs no place at all.
    _foodRunStep(p, dimension) {
        // 1. wheat first: it is bread, and bread is the personality. only a spot
        //    that is READY - nearestFoodSpot skips anything inside its regrow
        //    window, which is what stops the walk to the empty field.
        const world = this._worldId();
        let wheatSpot = this.memory.nearestFoodSpot(p, dimension, { kinds: ['wheat'], world });
        // ⚠ ON THE DEPLOYED JAR A SPOT'S RIPENESS IS UNKNOWABLE (`ripe == null`), so
        // the picker cannot tell a standing field from a stubble one and route 1
        // wins every time - which made the "wheat hunts keep failing" bail below
        // unreachable whenever any spot existed at all. if the blind runs are
        // failing AND she cannot see ripeness, stop trusting the ledger and take
        // one of the other routes instead.
        if (wheatSpot && wheatSpot.ripe == null && this.memory.failureCount('get', 'wheat', 20 * 60 * 1000) >= 2) {
            wheatSpot = null;
        }
        if (wheatSpot && wheatSpot.distance > 24) {
            return {
                action: 'move',
                params: {
                    x: wheatSpot.position.x, y: wheatSpot.position.y, z: wheatSpot.position.z,
                    target: 'my wheat spot', ...this._foodSpotTag(wheatSpot)
                },
                say: `bread reserves are a disgrace. hitting the wheat spot ${wheatSpot.distance} blocks out`
            };
        }
        // standing in a ready field: take it.
        if (wheatSpot) {
            return {
                action: 'get',
                params: { target: 'wheat', amount: this._wheatRunTarget(), ...this._foodSpotTag(wheatSpot) },
                say: 'wheat hunt. the bread must flow'
            };
        }
        // 2. no wheat she can reach. the other things she has SEEN and can eat -
        //    carrots, potatoes, beetroot, berries, a pasture with cows in it.
        //    nearest wins; they are all food and none of them is bread.
        const other = this.memory.nearestFoodSpot(p, dimension, {
            kinds: ['carrot', 'potato', 'beetroot', 'berries', 'animals'], world
        });
        if (other && other.distance > 24) {
            return {
                action: 'move',
                params: {
                    x: other.position.x, y: other.position.y, z: other.position.z,
                    target: `the ${other.kind} spot`, ...this._foodSpotTag(other)
                },
                say: this._offBreadLine(other)
            };
        }
        if (other) {
            const resource = FOOD_SPOT_KINDS[other.kind]?.get;
            return resource
                ? {
                    action: 'get',
                    params: { target: resource, amount: EAT_GATHER_TARGET, ...this._foodSpotTag(other) },
                    say: `no wheat, so ${FOOD_SPOT_KINDS[other.kind].label} it is`
                }
                : {
                    action: 'hunt',
                    params: { ...this._foodSpotTag(other) },
                    say: 'the field situation is dire. going after something that moves'
                };
        }
        // 3. nowhere known. one blind wheat hunt is still worth trying - altoclef
        //    prefers hay bales and replants what it takes - but only if it has not
        //    just failed, because a `get wheat` with no wheat in the world is the
        //    documented multi-minute stand-around that looks exactly like nothing.
        if (this.memory.failureCount('get', 'wheat', 20 * 60 * 1000) < 2) {
            return { action: 'get', params: { target: 'wheat', amount: this._wheatRunTarget() }, say: 'wheat hunt. the bread must flow' };
        }
        // 4. the wheat hunt itself keeps coming back empty. stop asking the world
        //    for a crop it does not have and go and get meat, which exists anywhere
        //    there are animals and needs no field at all.
        return { action: 'hunt', params: {}, say: 'no wheat anywhere. fine. hunting. i am a bread girl in a meat world' };
    }

    // 'offbread_<kind>' if the host registered one, else nothing said.
    _offBreadLine(spot) {
        return this._pickFresh(`offbread_${spot.kind}`, FLAVOR_LINES.get(`offbread_${spot.kind}`));
    }

    // how much wheat one restock trip asks for: enough to fill the comfort shelf
    // from where the pantry actually is. a hold-target like everything else, so
    // the wheat already on her counts toward it.
    //
    // the old flat 6 is two loaves' worth at 3 wheat each, so a trip could never
    // fund the shelf no matter how well it went, and the next tick sent her
    // straight back out - the visible half of "she keeps going out for food".
    // capped: a wheat target she cannot meet nearby is a farm grind, not a stock-up.
    _wheatRunTarget() {
        const shortfall = Math.max(BREAD_COMFORT - this._breadCount(), 1);
        return Math.min(WHEAT_RUN_CAP, shortfall * WHEAT_PER_LOAF);
    }

    // the haul, as an explicit list the chest is allowed to have: everything she
    // is carrying that isn't food, a tool, or armor. naming the list is what keeps
    // the pantry out of it - a bare `deposit` is "store ALL non-gear items" and
    // takes the bread with the cobblestone.
    //
    // returns [] when there is nothing bankable, and the caller MUST treat that as
    // "don't deposit" rather than falling through to a bare deposit, because a
    // bare deposit is exactly the behaviour this exists to prevent.
    _depositManifest() {
        const inv = this.gameState.inventory;
        if (!Array.isArray(inv)) return [];
        const out = [];
        for (const entry of inv) {
            const raw = typeof entry === 'string'
                ? entry
                : `${entry?.count ?? entry?.amount ?? ''} ${entry?.item ?? entry?.name ?? ''}`;
            const text = String(raw).toLowerCase();
            const name = (text.match(/([a-z_][a-z0-9_]*)\s*$/) || [])[1];
            if (!name || !DEPOSIT_ALLOW.has(name)) continue;
            // a leading count is the companion's format (`count + " " + id`); no
            // digits at all means a bare id, which is one item, not sixty-four.
            const m = text.match(/^\s*(\d+)\s/);
            out.push({ item: name, count: m ? parseInt(m[1], 10) : 1 });
            if (out.length >= 16) break;   // the bridge's item-list cap
        }
        return out;
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
        const arm = (key) => { this._obsessionArmed = key; this._obsessionCooldowns.set(key, now); };
        const hay = this._carrying();
        const nb = g.nearby || {};
        const homeDist = this._homeDistance();
        const atHome = homeDist <= HOMESTEAD_NEAR_HOME;

        // 1. FUEL. below the floor she stops whatever leisure she had planned and
        // restocks: coal if there's ore around or she's underground, charcoal
        // (smelt logs) otherwise - which also means a furnace gets used.
        if (this._fuelCount() < FUEL_FLOOR && !onCooldown('fuel')) {
            arm('fuel');
            // the same rule the bread pipeline learned: a chest with coal in it is
            // a shorter trip than a mine, and going and mining what she already
            // owns is the whole complaint. checked BEFORE the tally, because
            // taking coal off her own shelf is not a fuel run.
            const shelf = this._pantryStep('coal', Math.max(1, FUEL_COMFORT - this._fuelCount()));
            if (shelf) return shelf;
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
        const bakeTo = this._breadCount() < BREAD_COMFORT ? this._bakeTarget(BREAD_COMFORT) : 0;
        if (this._breadCount() < BREAD_COMFORT && !onCooldown('bake')) {
            // shelf first, oven second. `_bakeTarget` already returns 0 when the
            // pantry is stocked (that is the fix for the reported bug), so without
            // this the stocked case would fall past the bread pipeline entirely
            // and she would never actually go and pick her own loaves up.
            const shelf = this._pantryStep('bread', BREAD_COMFORT - this._breadCount());
            if (shelf) { arm('bake'); return shelf; }
            if (bakeTo) {
                arm('bake');
                return { action: 'craft', params: { target: 'bread', amount: bakeTo }, say: this._breadLine() };
            }
        }
        // 3b. THE PANTRY WHERE THERE IS NO WHEAT. baking is the preferred answer and
        // it got first refusal above; this is the fallback for a biome with no wheat
        // in it, where the bread pipeline has nothing to work with and her only other
        // food path is the survival emergency asking for less than one loaf.
        // deliberately NOT the `eat` action - that one skips the busy gate.
        // scored, not counted - see FOOD_RESERVE_UNITS. an item-count trigger
        // against a score target has a fixed point (five steaks = 40 score and 5
        // items) where this is permanently due and permanently instant.
        if (!bakeTo && this._foodScore() < FOOD_RESERVE_UNITS && !onCooldown('food_reserve')) {
            // ⚠ THE PANTRY IS THE FIRST PLACE TO LOOK, and this step's own line
            // said "the pantry is embarrassing" while never once checking it. a
            // forage trip to replace food she is standing on top of is the
            // reported bug wearing a different hat.
            const shelf = this._pantryFoodStep();
            if (shelf) { arm('food_reserve'); return shelf; }
            arm('food_reserve');
            return {
                action: 'stock_food',
                params: { amount: FOOD_RESERVE_UNITS },
                say: 'no wheat out here and the pantry is embarrassing. going to go and find enough food to stop thinking about it'
            };
        }

        // 4. FIRE ON HAND. flint and steel is the whole personality in one item -
        // fire whenever she wants it. then a torch supply so home stays lit.
        if (!/flint_and_steel/.test(hay) && /iron_ingot/.test(hay) && !onCooldown('flint_steel')) {
            arm('flint_steel');
            return { action: 'get', params: { target: 'flint_and_steel', amount: 1 }, say: 'flint and steel. the ability to start a fire whenever i feel like it is a human right' };
        }
        if (this._inventoryCount('torch') < 8 && !onCooldown('torch_stock')) {
            arm('torch_stock');
            const shelf = this._pantryStep('torch', 16 - this._inventoryCount('torch'));
            if (shelf) return shelf;
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
        const hoardTo = this._breadCount() < BREAD_HOARD ? this._bakeTarget(BREAD_HOARD) : 0;
        if (this._breadCount() < BREAD_HOARD && !onCooldown('bread_hoard')) {
            // ⚠ THE HOARD IS THE ONE PLACE THE FIX COULD HAVE BACKFIRED. the hoard
            // is a CARRY ambition ("i want an absurd amount of bread ON me"), and
            // making it pantry-aware without this shelf trip would have stopped
            // her baking AND left her carrying two loaves - a stocked chest and an
            // empty pocket, which is worse than the bug. so: take her own bread
            // out first, and only bake when there is none to take.
            const shelf = this._pantryStep('bread', BREAD_HOARD - this._breadCount(), {
                say: `there is bread of mine sat in a chest doing nothing. that is MY bread. collecting it`
            });
            if (shelf) { arm('bread_hoard'); return shelf; }
            if (hoardTo) {
                arm('bread_hoard');
                return {
                    action: 'craft',
                    params: { target: 'bread', amount: hoardTo },
                    say: `${this._breadCount()} loaves on me and that is not enough loaves`
                };
            }
        }
        return null;
    }

    // an exact-item inventory count. `\b` is doing real work in both directions
    // here: `torch` must not count `soul_torch` (the `_` before it is a word
    // character, so there is no boundary and the match correctly fails), and
    // `iron_pickaxe` must not be found inside a namespaced `minecraft:iron_pickaxe`
    // by accident of substring - it is found by the boundary after the colon.
    _itemExact(item) {
        // ⚠ AN EMPTY NAME BUILDS `\b\b`, WHICH MATCHES EVERY LINE IN THE BAG. that
        // reads as "she is carrying eighty of it" for an item that does not exist,
        // and on a reserve row it would compute a surplus out of cobblestone and
        // try to bank it. no caller passes an empty name today; this is the sort of
        // landmine that goes off when one does.
        const name = String(item ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!name) return 0;
        return this._inventoryCountRe(new RegExp(`\\b${name}\\b`));
    }

    // WHICH KIT SHE IS BUILDING TOWARD. see KIT_TIER_PROMOTE_RE: the proof of the
    // diamond tier is that she already holds a diamond pickaxe, never a diamond
    // count - otherwise three loose diamonds set six kit slots wanting diamond
    // versions at once and downtime becomes a twenty-diamond grind.
    // ⚠ WHAT SHE IS CARRYING, NEVER THE SHELF. the shelf reading is taken from
    // wherever her body happens to be (`_storedCount` measures `near` her, radius
    // PANTRY_TRIP_MAX), so folding it in made the tier FLICKER with distance:
    // diamond at home, iron three hundred blocks out. the reserve rows are named
    // `{tier}_pickaxe`, so a flickering tier accumulates `carried`/`stored` against
    // two different item names and neither one ever converges.
    _kitTier() {
        return KIT_TIER_PROMOTE_RE.test(this._carrying()) ? KIT_TIERS[0] : KIT_TIERS[1];
    }

    // stored totals without ever throwing - the ledger is optional everywhere it
    // is read, and a jar that cannot answer must read as "cannot tell", not "empty".
    _storedTotalsSafe() {
        if (!this._containersKnown()) return {};
        const p = this._point(this.gameState.position);
        try {
            return this.memory.storedTotals?.({
                world: this._worldId(), dimension: this.gameState.dimension,
                near: p, radius: p ? PANTRY_TRIP_MAX : null, maxAgeMs: PANTRY_FRESH_MS
            }) || {};
        } catch { return {}; }
    }

    // THE ARMORY. what she does with a house that is finished.
    //
    // the first two rungs are the old `_gearAmbition` verbatim - get out of stone
    // tools, get something between her and the world - because those are gaps and
    // gaps come first. everything below them only unlocks once the base is
    // ESTABLISHED (`homeSpec().met`, the same in-game survey the appliance gallery
    // trusts), because a spare pickaxe on a shelf presupposes a shelf.
    //
    // one step per call, each on its own cooldown, null when nothing is due - the
    // obsession's shape, for the same reason: a step that fails goes quiet instead
    // of pinning the loop.
    _armoryStep() {
        const now = Date.now();
        const onCooldown = (key) => now - (this._obsessionCooldowns.get(key) || 0) < ARMORY_STEP_COOLDOWN_MS;
        // ⚠ ARM AND RELEASE, the discipline this file documents twice (see
        // `_releaseHomesteadCooldown` / `_releaseAutonomyModeCooldown`). the drive
        // this replaced armed on the way out and had NO release, so one refusal by
        // `_safeExecute` - a blacklisted verb, a stuck-streak backoff - cost the
        // step its whole five minutes for work that never started.
        const arm = (key) => { this._armoryArmed = key; this._obsessionCooldowns.set(key, now); };
        // an empty inventory array is also what a telemetry gap looks like, and
        // this whole drive is inventory arithmetic: during a gap `_carrying()` is
        // '' and every `_itemExact` is 0, so rung 1 fires and the reserve computes
        // a full re-stock of everything. `_survivalPrep` opens with the same guard
        // and says the same thing.
        if (this._stateIsStale()) return null;
        const hay = this._carrying();
        const mind = this.minecraftState || this.affect.snapshot();

        // 1. THE WORKING PICKAXE. the old kit check passed on ANY pickaxe, so a
        // wooden one could carry her all session. no real player stops at stone.
        if (!/(iron|diamond|netherite)_pickaxe/.test(hay) && !onCooldown('iron_pickaxe')) {
            arm('iron_pickaxe');
            // ...but check the shelf first now that there IS a shelf. going down a
            // hole for iron she has already mined and put away is the whole
            // complaint this drive exists to answer.
            const shelf = this._pantryStep('iron_pickaxe', 1, {
                say: 'there is a pickaxe of mine sat in a chest. that is what the chest is FOR'
            });
            if (shelf) return shelf;
            return { action: 'craft', params: { target: 'iron_pickaxe' }, say: 'stone tools are a phase and i\'m ready to grow. iron pickaxe' };
        }
        // 2. SOMETHING BETWEEN HER AND THE WORLD. she was playing every session in
        // her regular clothes. a death (or a bad feeling about the place) is when a
        // person decides to fix that - and so is BEING HUNTED. something already in
        // the room with her, or the dark it hunts in, is that same realisation
        // arriving before the death instead of after it, and armour that only ever
        // gets made once she has died in her shirt is armour bought a session late.
        //
        // the original two conditions are kept exactly as they were: this only
        // widens WHEN she reaches the same conclusion, it never narrows it.
        const wearingArmor = Array.isArray(this.gameState.armor) && this.gameState.armor.length > 0;
        // the same night test the noticings board uses, rather than the stricter
        // `=== 'night'` in _survivalPrep - dusk is when this decision wants making,
        // not the moment it is already too late.
        const hunted = Number(this.gameState.nearbyHostiles) > 0 ||
            /night|midnight|dusk/i.test(String(this.gameState.timeOfDay || ''));
        if (!wearingArmor && (this.stats.deaths > 0 || mind.security < 60 || hunted) && !onCooldown('armor')) {
            arm('armor');
            const shelf = this._pantryStep('iron_chestplate', 1, {
                say: 'i own a chestplate and it is in a box. putting it on me instead of in storage'
            });
            if (shelf) return shelf;
            return { action: 'craft', params: { target: 'iron_chestplate' }, say: 'i keep doing this in my normal clothes. getting something between me and the world' };
        }

        // EVERYTHING BELOW HERE NEEDS A FINISHED HOUSE. `met` is the in-game
        // survey's own verdict on habitability - the same one the gallery waits
        // for - so this reads "her basic base is established" off the world rather
        // than off a flag burnt keeps about herself.
        const spec = this.homeSpec();
        if (!spec?.met) return null;
        const tier = this._kitTier();

        // 3. THE TIER CLIMB. one rung, and only when the diamonds are already
        // hers: `@get diamond_pickaxe` with an empty pantry is a mining expedition
        // wearing the word "craft".
        // ⚠ `_pantryCount` COUNTS SUBSTRINGS - the documented charcoal trap. a
        // diamond helmet, boots and sword score three "diamonds" with not one raw
        // diamond in the bag, which cleared the cost and turned this rung into
        // exactly the mining expedition its own comment says it prevents.
        // `_itemExact` is the tool for it; `_storedCount` is already exact.
        const diamonds = this._itemExact('diamond') + this._storedCount('diamond');
        if (tier === 'iron' && !onCooldown('tier_climb') && diamonds >= DIAMOND_PICKAXE_COST) {
            arm('tier_climb');
            // and shop the shelf first like every rung around it - altoclef cannot
            // see her chest, so diamonds she owns and is not carrying would send
            // her down a hole for diamonds she already has.
            const shelf = this._pantryStep('diamond', DIAMOND_PICKAXE_COST - this._itemExact('diamond'));
            if (shelf) return shelf;
            return {
                action: 'craft', params: { target: 'diamond_pickaxe' },
                say: 'i have been sitting on diamonds like they are decorative. diamond pickaxe. today is the day'
            };
        }

        // 4. THE SUNDRIES. cheap, iron, each one closes a hole she has actually
        // fallen through.
        for (const s of ARMORY_SUNDRIES) {
            if (s.have.test(hay) || onCooldown(`sundry_${s.item}`)) continue;
            arm(`sundry_${s.item}`);
            const shelf = this._pantryStep(s.item, 1);
            return shelf || { action: 'craft', params: { target: s.item }, say: s.say };
        }

        // 5. THE RESERVE - the point of the whole drive. spares on the shelf so the
        // next broken pickaxe is a walk to a chest and not a trip down a hole.
        return this._reserveStep(tier);
    }

    // ONE ROW OF THE RESERVE, or null when the shelf is stocked.
    //
    // two halves, and they are gated differently on purpose:
    //   - MAKING more can happen anywhere, and is skipped the moment she already
    //     carries the hold target. `@get <item> <n>` is a hold target, so asking
    //     for a number she already holds is the documented ~0.03s no-op that
    //     reports success and does nothing - a treadmill, not a step.
    //   - BANKING the surplus needs a chest in front of her AND a reading that has
    //     not expired, because `stored` is the number that decides whether she
    //     makes more, and a stale zero is how a chest fills up with pickaxes.
    _reserveStep(tier) {
        if (!this._containersKnown()) return null;
        // ⚠⚠ THE RESERVE IS A QUESTION ABOUT THE SHELF, AND `_storedCount` ANSWERS
        // IT FROM WHEREVER HER BODY IS (`near` her, radius PANTRY_TRIP_MAX). that
        // is the right question for `_pantryStep` ("is this worth walking to") and
        // the wrong one here: three hundred blocks out, every row reads `stored: 0`
        // and she orders a full re-stock of gear already sitting in her own chest -
        // which is verbatim the complaint this drive was built to end. an
        // OUT-OF-RANGE zero is indistinguishable from an empty shelf, and unlike
        // the STALE zero above it cannot be fixed by looking.
        //
        // so stocking is something she does WHILE HOME. that also puts the spares
        // where `_survivalPrep` can shop them (RESERVE_SHOP_RADIUS is 64, so a
        // spare banked in a random chest 300 blocks out is unreachable when a
        // pickaxe breaks - which would make the whole feature decorative).
        if (!this._dimMatches(this._home()?.dimension, this.gameState.dimension)) return null;
        if (this._homeDistance() > HOMESTEAD_NEAR_HOME) return null;
        const now = Date.now();
        const onCooldown = (key) => now - (this._obsessionCooldowns.get(key) || 0) < ARMORY_STEP_COOLDOWN_MS;
        const arm = (key) => { this._armoryArmed = key; this._obsessionCooldowns.set(key, now); };
        const nb = this.gameState.nearby || {};
        const bank = [];
        let make = null;

        for (const row of ARMORY_RESERVE) {
            const item = row.item.replace('{tier}', tier);
            const carried = this._itemExact(item);
            const stored = this._storedCount(item);
            const short = row.reserve - stored;
            if (short <= 0) continue;                       // shelf is stocked for this row

            // ⚠ THE INVARIANT: only what she holds ABOVE `keep` may be banked.
            // without it, banking her only pickaxe satisfies the reserve, empties
            // her hands, and the next tick re-makes one to satisfy `keep`.
            const surplus = Math.min(carried - row.keep, short);
            if (surplus > 0) {
                if (bank.length < ARMORY_DEPOSIT_MAX) bank.push({ item, count: surplus, why: row.why });
                continue;
            }
            // nothing to bank for this row: make some. hold target = what stays on
            // her plus what the shelf is short.
            //
            // ⚠ THE PROPERTY THAT MATTERS IS `target > carried`, because `@get` is
            // a hold target and asking for a number she already holds is the
            // documented ~0.03s success that moves nothing. reaching this branch
            // means `carried <= row.keep` (else there was a surplus to bank), and
            // `short > 0` (else we continued), so the arithmetic below already
            // guarantees it - the explicit test on the next line is a restatement,
            // kept because it is the one line that says the property out loud and
            // this is exactly the sort of arithmetic that gets adjusted later.
            const target = row.keep + short;
            if (!make && carried < target && !onCooldown(`reserve_${item}`)) {
                make = { item, target, row };
            }
        }

        // BANK FIRST. the surplus is already in her hands, so it is the cheaper
        // move and it is the one that actually stocks the shelf.
        if (bank.length && !onCooldown('reserve_bank')) {
            // a chest she cannot see is a chest `@deposit` will PLACE for her,
            // wherever she happens to be standing - a spare pickaxe in a box in a
            // field is not a reserve, it is litter.
            if (nb.chest == null) {
                // she is already within HOMESTEAD_NEAR_HOME (the gate at the top),
                // but the companion's affordance scan is only 8 blocks - so "no
                // chest" here means "not at the door yet", and walking to it is the
                // answer. the old condition was `homeDistance > NEAR_HOME`, which
                // this gate has since made unreachable.
                if (!onCooldown('reserve_home')) {
                    arm('reserve_home');
                    return {
                        action: 'go_home', params: {},
                        say: 'pockets full of spares and nowhere to put them. going in to the chests'
                    };
                }
                return make ? this._reserveMakeStep(make, arm) : null;
            }
            // ⚠ act on a reading that has not expired, or a stale zero has her
            // banking a third pickaxe onto two she has already forgotten about.
            const peek = this._stalePantryPeek('checking what is actually on the shelf before i add to it');
            if (peek) { arm('reserve_bank'); return peek; }
            arm('reserve_bank');
            const first = bank[0];
            const why = first.why ? ` - ${first.why}` : '';
            return {
                action: 'deposit',
                // `_armory` tags the trip so the banked-gear tally counts spares
                // and not the rubble the bag-full declutter shifts.
                params: { items: bank.map(({ item, count }) => ({ item, count })), _armory: true },
                say: `putting spares away. ${first.count} ${first.item.replace(/_/g, ' ')} on the shelf for future me${why}`
            };
        }
        return make ? this._reserveMakeStep(make, arm) : null;
    }

    // WHERE AN ORNAMENT STANDS. a row down the +X side of the yard, one block
    // inside its outer edge and on odd offsets from minZ.
    //
    // both of those dodge the perimeter torch grid rather than trusting luck:
    // `_perimeterLightStep` steps a 10-block grid from `min - margin`, so the
    // stops land on even multiples out of that corner and an odd offset never
    // coincides. a collision would not wedge her (AcquireAndPlace would break the
    // torch and the light rotation would re-place it) but it is churn on stream
    // for no reason.
    //
    // derived, never stored - the same rule `quarryMouth` follows, so there is no
    // second copy of the geometry to drift.
    _comfortSpot(settlement, index) {
        const b = this._settlementBounds(settlement);
        if (!b) return null;
        const slots = Math.max(0, Math.floor((b.maxZ - b.minZ - 1) / COMFORT_SPACING) + 1);
        if (!(index >= 0) || index >= slots) return null;      // the porch is full
        return {
            x: b.maxX + SETTLEMENT_YARD_MARGIN - COMFORT_YARD_INSET,
            y: b.floorY + 1,
            z: b.minZ + 1 + index * COMFORT_SPACING
        };
    }

    // DOWNTIME. the house is up, the shelf is stocked, nobody has asked for
    // anything. everything above this rung is provisioning of one kind or another
    // and each one correctly goes quiet when it is done - and the sum of them
    // going quiet was a bot whose only remaining idea was to walk 900 blocks in a
    // straight line.
    //
    // deliberately the LOWEST-ranked thing she does on purpose: it must never
    // outrank the house, the shelf, food, fire, or a person asking for something.
    _leisureStep() {
        const spec = this.homeSpec();
        if (!spec?.met) return null;                           // downtime presupposes a home
        // pottering about is a fair-weather activity. `_rainingOnHer()` and not a
        // bare `rainingHere`, because an older jar does not send that field and
        // `undefined !== true` would read a thunderstorm as a nice afternoon - the
        // helper falls back to weather + cover + dimension, which is what every
        // other rain-aware branch in this file already asks.
        if (this._rainingOnHer()) return null;
        const now = Date.now();
        const onCooldown = (key, ms = LEISURE_STEP_COOLDOWN_MS) =>
            now - (this._leisureCooldowns.get(key) || 0) < ms;
        const arm = (key) => { this._leisureArmed = key; this._leisureCooldowns.set(key, now); };
        return this._comfortStep(spec, onCooldown, arm)
            || this._lingerStep(onCooldown, arm)
            || this._pilgrimageStep(onCooldown, arm);
    }

    // MAKING THE PLACE HERS. one ornament at a time, cheapest first, each one
    // standing at its own spot in the yard.
    _comfortStep(spec, onCooldown, arm) {
        const settlement = spec.settlement;
        if (!settlement || onCooldown('comfort')) return null;
        // the ornaments stand ON the yard, so let the yard be a yard first. an
        // older jar answers `undefined` here, which reads as "no yard work known"
        // rather than "the yard is filthy" - the same reading homeSpec takes.
        if (spec.yardClear === false) return null;
        // ⚠ THE COORDINATES ARE THE HOMESTEAD'S, SO HER BODY HAS TO BE THERE TOO.
        // `homeSpec().met` is purely the settlement survey - it says nothing about
        // where she is standing. without this she issues `@place_at 15 65 -9
        // composter` from the nether. `_obsessionBehavior` gets this right for
        // appliances (it walks home first) and this is the same question.
        if (!this._dimMatches(settlement.dimension, this.gameState.dimension)) return null;
        if (this._homeDistance() > HOMESTEAD_NEAR_HOME) return null;
        const placed = this.memory.listComforts({ settlementId: settlement.id });
        // ⚠ THE FIRST FREE SPOT, never `placed.length`. an ornament kind that also
        // lives in PLACEABLE_BLOCKS (the lantern) can be placed by a viewer or by
        // her own brain and filed here too - and a count-as-index then SKIPS a
        // slot, which with exactly as many slots as wishlist entries makes the last
        // ornament permanently unreachable.
        const taken = new Set(placed.map((c) => `${c.position.x},${c.position.z}`));
        let spot = null;
        for (let i = 0; ; i++) {
            const candidate = this._comfortSpot(settlement, i);
            if (!candidate) break;                              // the porch is full, and that is an ending
            if (!taken.has(`${candidate.x},${candidate.z}`)) { spot = candidate; break; }
        }
        if (!spot) return null;
        const hay = this._carrying();
        const have = new Set(placed.map((c) => c.kind));
        const affordable = (c) => c.needs.test(hay) &&
            Object.entries(c.count || {}).every(([item, n]) => this._itemExact(item) >= n);
        const want = COMFORT_WISHLIST.find((c) => !have.has(c.kind) && affordable(c));
        if (!want) return null;
        arm('comfort');
        return {
            action: 'place_block',
            // `settlementId` rides along so the completion files it under the same
            // house this step read from - see _recordComfortPlaced. the bridge
            // ignores params it does not know, exactly as it does for the
            // appliance gallery.
            params: { target: want.kind, x: spot.x, y: spot.y, z: spot.z, settlementId: settlement.id },
            say: want.say
        };
    }

    /**
     * GOING SOMEWHERE PROPERLY FAR, AND STAYING GONE.
     *
     * Returns a step when she is on (or should start) an expedition, else null.
     *
     * The trip is a persisted commitment (`memory.expedition`), so it survives a
     * creeper, a re-task, a death and a burnt restart. Each tick contributes ONE
     * outward leg; distance accumulates across legs rather than within a hop, which
     * is what lets her reach 3000 blocks without a single unsurvivable blind march.
     *
     * ⚠ THE LEG IS AN ORDINARY `move` THROUGH `_safeExecute`, deliberately. It gets
     * the same stall backoff, per-place stuck streak and repeated-failure blacklist
     * as everything else - an expedition that can wedge forever is worse than one
     * that never starts, and this file's whole history is recoveries for exactly that.
     */
    _expeditionStep() {
        const g = this.gameState;
        if (!g || this._stateIsStale()) return null;
        const p = this._point(g.position);
        if (!p) return null;
        const world = this._worldId();
        let trip = null;
        try { trip = this.memory.getExpedition?.(world) || null; } catch { return null; }

        if (trip) return this._continueExpedition(trip, p, g);
        return this._maybeStartExpedition(p, g, world);
    }

    /** the restraint lives here: most ticks must decline, or a trip is a treadmill. */
    _maybeStartExpedition(p, g, world) {
        const onCooldown = (key, ms) => Date.now() - (this._homesteadCooldowns.get(key) || 0) < ms;
        if (onCooldown('expedition', EXPEDITION_COOLDOWN_MS)) return null;
        // she leaves from somewhere, not from nowhere: a homeless burnt already has
        // `venture_out`, which is the same instinct pointed at finding a home.
        const home = this._home();
        if (!home) return null;
        // and she does not walk out on a house with no roof on it.
        if (this._toasterUnfinished()) return null;
        // setting off at night, in the rain, or soaking wet is how a trip becomes a
        // death. the daylight check also means viewers see her leave.
        if (g.timeOfDay === 'night') return null;
        // ⚠ `_rainingOnHer()`, the real method. An earlier draft guessed `_isRaining?.()`,
        // which does not exist - the optional chain evaluated to undefined and the
        // whole rain gate quietly became the weather-string fallback. The companion's
        // `rainingHere` is the only signal that knows the difference between weather
        // and weather landing on HER.
        if (this._rainingOnHer()) return null;
        if (this._justLeftWater()) return null;
        // KIT. an expedition on an empty stomach with a wooden pickaxe is a
        // suicide note, and she would simply die 2000 blocks from her bed.
        if (!PICKAXE_TIERS.some((t) => this._carrying().includes(`${t}_pickaxe`))) return null;
        if (this._foodScore?.() < EXPEDITION_MIN_FOOD) return null;
        const health = Number(g.health);
        if (Number.isFinite(health) && health < 16) return null;
        // a whim, not a schedule. with the 90-minute cooldown above this makes a
        // trip something that happens now and then rather than every time she is idle.
        if (Math.random() >= 0.35) return null;

        const targetDist = EXPEDITION_MIN_DIST + Math.round(Math.random() * EXPEDITION_SPAN);
        // aim at ground she has never seen. the bearing is a STARTING intent only -
        // legs are re-picked each time against real terrain, so an ocean in the way
        // bends the route instead of ending the trip.
        const bearing = this._noveltyBearing(p);
        let started = null;
        try {
            started = this.memory.startExpedition({
                origin: p, bearing, targetDist, world, dimension: g.dimension,
                reason: this._expeditionReason(p)
            });
        } catch { return null; }
        if (!started) return null;
        this._homesteadCooldowns.set('expedition', Date.now());
        this.emit('gameEvent', 'expedition_started', {
            targetDist, reason: started.reason, from: `${p.x},${p.z}`
        });
        this.recentEvents.record(`set out on a ${targetDist}-block trip away from home`);
        // she writes no words here - the event goes out and her brain says whatever
        // it wants about leaving. the `say` is the internal cue only.
        return this._expeditionLeg(started, p, g)
            || { action: 'move', params: { ...p, target: 'the way out' }, say: 'setting off' };
    }

    /** already out. walk another leg, or decide the trip is done. */
    _continueExpedition(trip, p, g) {
        const out = Math.hypot(p.x - trip.origin.x, p.z - trip.origin.z);
        const age = Date.now() - (trip.startedAt || 0);
        // ARRIVED, or been out long enough. `furthest` is the high-water mark, so a
        // detour on the last leg cannot un-arrive her.
        const arrived = Math.max(out, trip.furthest) >= trip.targetDist * EXPEDITION_ARRIVE_FRACTION;
        if (arrived || age > EXPEDITION_MAX_MS) {
            return this._finishExpedition(trip, p, arrived ? 'arrived' : 'out of time');
        }
        // ABORT: hurt, starving, or benighted far from anywhere. the survival rungs
        // above this one own the actual response; the trip just stops asking for legs.
        const health = Number(g.health);
        if ((Number.isFinite(health) && health <= 8) || this._foodScore?.() <= 0) {
            return this._finishExpedition(trip, p, 'ran out of road');
        }
        const onCooldown = (key, ms) => Date.now() - (this._homesteadCooldowns.get(key) || 0) < ms;
        if (onCooldown('expedition_leg', EXPEDITION_LEG_COOLDOWN_MS)) return null;
        return this._expeditionLeg(trip, p, g);
    }

    /**
     * ONE outward hop.
     *
     * `outward` makes distance-from-origin a HARD filter (a candidate that does not
     * gain its share is discarded before scoring), and `curiosity` then chooses among
     * the survivors - so she walks toward interesting ground without ever trading
     * away the distance. The per-hop BLIND_WANDER_MAX clamp still applies inside
     * `_pickLandingSpot`; that is deliberate and is what keeps each step survivable.
     */
    _expeditionLeg(trip, p, g) {
        const here = Math.hypot(p.x - trip.origin.x, p.z - trip.origin.z);
        const remaining = Math.max(0, trip.targetDist - Math.max(here, trip.furthest));
        const reach = Math.max(120, Math.min(remaining, BLIND_WANDER_MAX * 2));
        const spot = this._pickLandingSpot(p, Math.min(120, reach), reach, {
            curiosity: 2,
            outward: {
                depth: (x, z) => Math.hypot(x - trip.origin.x, z - trip.origin.z),
                here,
                fraction: EXPEDITION_LEG_GAIN_FRACTION,
                min: 40
            }
        });
        // no dry way further out. NOT a failure and NOT the end of the trip - the
        // tick simply passes to the rungs below and she tries again later, which is
        // how a coastline gets walked around instead of swum.
        if (!spot) return null;
        const gained = Math.round(Math.hypot(spot.x - trip.origin.x, spot.z - trip.origin.z));
        return {
            action: 'move',
            params: { ...spot, target: 'further out' },
            say: `${gained} blocks out and still going`,
            commit: () => {
                this._homesteadCooldowns.set('expedition_leg', Date.now());
                try { this.memory.noteExpeditionLeg(gained); } catch { /* best-effort */ }
            }
        };
    }

    /** the trip is over. bank what she found, then let the ladder resume normal life. */
    _finishExpedition(trip, p, why) {
        let record = null;
        try { record = this.memory.endExpedition(); } catch { /* best-effort */ }
        const far = Math.round(record?.furthest ?? 0);
        this.emit('gameEvent', 'expedition_ended', {
            why, furthest: far, legs: record?.legs ?? 0,
            discoveries: (record?.discoveries || []).slice(0, 6)
        });
        this.recentEvents.record(`got ${far} blocks from home and turned back (${why})`);
        // ⚠ `record(kind, label, opts)`, NOT a single object. The first version of
        // this called `memory.recordJournal?.({...})` - a method that does not exist -
        // and the optional chain made it a SILENT no-op that syntax-checked, ran
        // clean, and journalled nothing. Optional chaining on a collaborator you have
        // not verified is how a dead call survives review.
        try {
            this.memory.record('event', `expedition: ${far} blocks out, ${why}`, {
                position: p, dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
        // she is a long way from home and the trip is done. heading back is a
        // decision, not an accident - and it re-arms the ordinary home instinct.
        return { action: 'go_home', params: {}, say: `far enough. heading back` };
    }

    /**
     * WHICH WAY IS NEW?
     *
     * Samples bearings and prefers the one crossing fewest cells she has already
     * walked. Cheap and honest: `terrain` is the only record of where she has
     * actually been, and "away from my own footprints" is what novelty means for a
     * girl whose whole map is 630 blocks wide.
     */
    _noveltyBearing(p) {
        let best = null;
        for (let i = 0; i < 16; i++) {
            const angle = (Math.PI * 2 * i) / 16;
            if (this._bearingIsDrowned?.(p, angle)) continue;
            let known = 0;
            for (let d = 200; d <= 1200; d += 200) {
                const x = Math.round(p.x + Math.cos(angle) * d);
                const z = Math.round(p.z + Math.sin(angle) * d);
                if (this._cellState?.(x, z)) known += 1;
            }
            const score = -known + Math.random() * 0.5;
            if (!best || score > best.score) best = { angle, score };
        }
        return best ? best.angle : Math.random() * Math.PI * 2;
    }

    /** why she is going, in her own terms - for the event, not for her mouth. */
    _expeditionReason(p) {
        try {
            const seen = this.memory.biomeCount?.(this._worldId()) ?? 0;
            if (seen > 0 && seen < 8) return 'barely seen any of this world';
        } catch { /* best-effort */ }
        const far = Math.round(this._homeDistance?.() ?? 0);
        return far < 700 ? 'never been further than the next hill' : 'wants somewhere new';
    }

    // STANDING AT A SPOT SHE LIKES, DOING NOTHING, ON PURPOSE.
    //
    // the one genuinely passive beat in the whole file. rare, short, and only ever
    // when she is ALREADY there - it is never a reason to travel, because "go
    // somewhere in order to stand still" is how a bot invents a way to be stuck.
    _lingerStep(onCooldown, arm) {
        if (onCooldown('linger', LINGER_COOLDOWN_MS)) return null;
        if (Math.random() >= LINGER_CHANCE) return null;
        const p = this._point(this.gameState.position);
        if (!p) return null;
        const home = this._home();
        // ⚠ a favorite is meaningless without the world it is in - every other
        // spatial ledger here is world-scoped and says why. unscoped, a spot saved
        // on server A is a valid pilgrimage target on server B: 300 blocks to
        // somebody else's dirt, narrated as 'going back to the lava'.
        const world = this._worldId();
        const here = this.memory.listFavorites()
            .filter((f) => f.name !== home?.name && this._dimMatches(f.dimension, this.gameState.dimension)
                && (!f.world || !world || f.world === world))
            .map((f) => ({ f, d: Math.hypot(f.position.x - p.x, f.position.z - p.z) }))
            .filter((e) => e.d <= LINGER_RADIUS)
            .sort((a, b) => a.d - b.d)[0];
        if (!here) return null;
        arm('linger');
        return {
            action: 'idle',
            params: {},
            say: `standing at ${here.f.name} for a bit. not doing anything. that is the whole activity`
        };
    }

    // A WALK TO A PLACE SHE LIKES FOR NO REASON.
    //
    // ⚠ rare BY CONSTRUCTION (a 25-minute cooldown), because the difference
    // between a pilgrimage and the wanderlust roll below it is entirely the
    // caption. bounded at both ends: next door is not a pilgrimage and neither is
    // an expedition.
    _pilgrimageStep(onCooldown, arm) {
        if (onCooldown('pilgrimage', PILGRIMAGE_COOLDOWN_MS)) return null;
        const p = this._point(this.gameState.position);
        if (!p) return null;
        const home = this._home();
        const world = this._worldId();
        const options = this.memory.listFavorites()
            .filter((f) => f.name !== home?.name && this._dimMatches(f.dimension, this.gameState.dimension)
                && (!f.world || !world || f.world === world))
            .map((f) => ({ f, d: Math.round(Math.hypot(f.position.x - p.x, f.position.z - p.z)) }))
            .filter((e) => e.d >= PILGRIMAGE_MIN_DIST && e.d <= PILGRIMAGE_MAX_DIST);
        if (!options.length) return null;
        const pick = options[Math.floor(Math.random() * options.length)];
        arm('pilgrimage');
        const note = pick.f.note ? ` - ${pick.f.note}` : '';
        return {
            action: 'move',
            params: { x: pick.f.position.x, y: pick.f.position.y, z: pick.f.position.z, target: pick.f.name },
            say: `going back to ${pick.f.name}${note}. no reason. ${pick.d} blocks of no reason`
        };
    }

    _reserveMakeStep({ item, target, row }, arm) {
        arm(`reserve_${item}`);
        const label = item.replace(/_/g, ' ');
        // her own shelf is not a supplier here - the shortfall was measured
        // against it - so this one really is "go and make/find some".
        const why = row.why ? `. ${row.why}` : '';
        return {
            action: 'craft',
            params: { target: item, amount: target },
            say: `making a spare ${label}${why}`
        };
    }

    // flavor for the collection growing. she talks about ovens the way she talks
    // about her toasters, because they are the same thing to her.
    // 'oven-install' for the placement beat, 'oven-<kind>' for wanting one.
    _ovenLine(kind, phase) {
        if (phase === 'place') return this._pickFresh('oven-install', FLAVOR_LINES.get('oven-install'));
        return this._pickFresh(`oven-${kind}`, FLAVOR_LINES.get(`oven-${kind}`));
    }

    // ---- autonomy modes: the free-time provider --------------------------
    //
    // THIS REPLACES _pickIdleBehavior AND NOTHING ABOVE IT. by the time control
    // reaches here, every fault, the stall/loop/pin/orphan recoveries, urgent
    // safety, a real person's request, the busy gate and the spawn-region rule
    // have each had their say and declined - so a mode can only ever change what
    // she does with time that was genuinely hers. a mode is a preference about
    // work, never a switch on eating, fighting back, or obeying somebody.
    //
    // returns a step descriptor {action, params, say} or NULL, and null is a REAL
    // answer: it falls through to the ordinary idle menu, so a brief that has run
    // dry (every step on cooldown, nothing remembered, nothing to mine) leaves her
    // playing rather than standing in a field being correctly on-message.
    _autonomyModeBehavior() {
        const mode = this.autonomyMode;
        if (!mode || mode === AUTONOMY_MODE_DEFAULT) return null;
        this._autonomyModeArmed = null;
        const now = Date.now();
        // keys are namespaced by mode: switching brief and switching back should
        // not find every step of the new one already spent.
        const slot = (k) => `${mode}:${k}`;
        const onCooldown = (k) => now - (this._autonomyModeCooldowns.get(slot(k)) || 0) < AUTONOMY_MODE_STEP_COOLDOWN_MS;
        // ⚠ the step is armed HERE and the CALLER may still refuse to run it (a
        // blacklisted action, the busy gate). _releaseAutonomyModeCooldown hands it
        // straight back - charging four minutes for work that never left the
        // building is the survival-prep bug this file already documents twice.
        const arm = (k) => {
            this._autonomyModeCooldowns.set(slot(k), now);
            this._autonomyModeArmed = slot(k);
        };
        const p = this._point(this.gameState.position);
        if (!p) return null;   // no idea where she is: not a moment for a plan
        let step = null;
        try {
            step = ({
                gather_materials: () => this._gatherMaterialsStep(p, onCooldown, arm),
                gather_food: () => this._gatherFoodStep(p, onCooldown, arm),
                scout_area: () => this._scoutAreaStep(p, onCooldown, arm),
                secure_area: () => this._secureAreaStep(p, onCooldown, arm)
            })[mode]?.() || null;
        } catch (err) {
            // a provider that throws must cost its own turn, never the tick. the
            // idle menu below is a complete answer on its own.
            this.log('warn', `${mode} step failed to build: ${err.message}`);
            return null;
        }
        if (!step) this._autonomyModeArmed = null;
        return step;
    }

    _releaseAutonomyModeCooldown() {
        if (!this._autonomyModeArmed) return;
        this._autonomyModeCooldowns.delete(this._autonomyModeArmed);
        this._autonomyModeArmed = null;
    }

    // does the standing homestead project still run under this brief? it does in
    // 'auto' (where it IS her default way of living) and while she is gathering
    // materials - that is what the materials are FOR. under scouting, food and
    // guard duty it stands down, or the mode is just a label on the same
    // behaviour and the person who set it watches her build a wall instead.
    _homesteadRunsInMode() {
        return this.autonomyMode === AUTONOMY_MODE_DEFAULT || this.autonomyMode === 'gather_materials';
    }

    // the bread tendency is a food behaviour, so it keeps its turn in 'auto' and
    // in gather_food and sits the other three out for the same reason.
    _breadTendencyRunsInMode() {
        return this.autonomyMode === AUTONOMY_MODE_DEFAULT || this.autonomyMode === 'gather_food';
    }

    // WHAT THE BUILD ACTUALLY NEEDS, in the order she would actually want it.
    // deduped by item: two independent reasons to want coal is still one errand.
    _materialWants() {
        const hay = this._carrying();
        const wants = [];
        const push = (entry) => {
            if (!wants.some((w) => w.item === entry.item)) wants.push(entry);
        };
        let spec = null;
        try { spec = this.homeSpec(); } catch { /* no settlement yet */ }
        const stoneShort = Number(spec?.smoothStoneRemaining) || 0;
        if (stoneShort > 0) {
            // ⚠ a HOLD TARGET, not a batch (see _bakeTarget): the amount is the
            // stock level she ends up carrying, so asking for what she already has
            // is a no-op that reports success.
            push({ item: 'cobblestone', amount: Math.min(64, Math.max(16, stoneShort)), kinds: null,
                why: `the toaster is still ${stoneShort} stone short` });
        }
        if (!/(iron|diamond|netherite)_pickaxe/.test(hay)) {
            push({ item: 'raw_iron', amount: 6, kinds: ['iron'], why: 'still swinging a stone pickaxe like a caveman' });
        }
        if (this._fuelCount() < FUEL_FLOOR) {
            push({ item: 'coal', amount: FUEL_COMFORT, kinds: ['coal'], why: 'a cold furnace is a personal failure' });
        }
        if (this._inventoryCount('torch') < 8) {
            push({ item: 'coal', amount: FUEL_COMFORT, kinds: ['coal'], why: 'nothing to light anything with' });
        }
        // nothing outstanding - and she is still a magpie about the good stuff.
        // ⚠ `ambient` marks a want that is NOT a shortfall: there is no threshold
        // to satisfy, so it is never closed and it is the fallback that keeps her
        // mining when the build needs nothing. the pantry shortcut must skip these
        // or it degenerates into a shuffle - withdraw three diamonds, fill the
        // bag, bank the bag, withdraw them again - since a want with no condition
        // on it is a want a full chest can never answer.
        push({ item: 'diamond', amount: 3, kinds: ['diamond'], why: 'diamonds are diamonds', ambient: true });
        push({ item: 'raw_iron', amount: 16, kinds: ['iron'], why: 'iron is never wasted', ambient: true });
        return wants;
    }

    /**
     * GATHER MATERIALS: bank the rubble, then dig what the build is short of.
     *
     * the order is the point. a bag with four free slots mines for the ground,
     * so the haul goes away first; then the seams she has personally SEEN,
     * because a remembered vein is the whole reason the ore ledger exists; then
     * the thing the house is short of; then the quarry behind it; then, having
     * run out of knowledge, prospecting.
     */
    _gatherMaterialsStep(p, onCooldown, arm) {
        const g = this.gameState;
        const nb = g.nearby || {};
        const dim = g.dimension;
        const world = this._worldId();

        // 1. THE BAG. ⚠ an explicit manifest, NEVER a bare deposit: the bare form
        //    is altoclef's "store ALL non-gear items", it banks her bread, and
        //    nothing in the bridge, the companion or altoclef can take it back
        //    out. no bankable haul means no trip, never a fallthrough.
        const freeSlots = Number.isFinite(g.inventoryFree) ? g.inventoryFree : null;
        const bagFull = freeSlots !== null
            ? freeSlots <= 4
            : (Array.isArray(g.inventory) ? g.inventory.length : 0) >= 15;
        if (bagFull) {
            const haul = this._depositManifest();
            if (haul.length && nb.chest != null && !onCooldown('deposit')) {
                arm('deposit');
                return {
                    action: 'deposit', params: { items: haul },
                    say: 'bag is rubble to the brim. rocks in the chest, bread stays on me'
                };
            }
            // full, nothing in reach to put it in, and a home that has one.
            if (haul.length && this._home() && this._homeDistance() > HOMESTEAD_NEAR_HOME && !onCooldown('haul_home')) {
                arm('haul_home');
                return { action: 'go_home', params: {}, say: 'carrying a quarry in my pockets. taking it to the chest before i can pick anything else up' };
            }
        }

        // 1b. THE SHELF SHE ALREADY FILLED. ⚠ ABOVE EVERY SEAM AND EVERY QUARRY,
        //     because mining a thing she owns a stack of is the whole complaint -
        //     and the deposit step directly above is what PUT it in the chest, so
        //     without this the two halves of the mode work against each other:
        //     bank the coal, walk off, mine more coal, bank that too, forever.
        //     `_pantryStep` owns the walk/withdraw/peek decision and only ever
        //     sizes a withdraw from a fresh reading (that gate is a hang guard -
        //     see its comment). null means "not worth a trip" and the normal
        //     gathering below happens exactly as before.
        for (const want of this._materialWants()) {
            if (want.ambient) continue;   // no threshold to satisfy - see _materialWants
            const key = `shelf_${want.item}`;
            if (onCooldown(key)) continue;
            const shelf = this._pantryStep(want.item, want.amount, {
                say: `there is ${want.item.replace(/_/g, ' ')} of mine in a chest already. ${want.why}, and i am not mining it twice`
            });
            if (!shelf) continue;
            arm(key);
            return shelf;
        }

        // 2. A SEAM SHE HAS ACTUALLY SEEN. ⚠ the dispatch is TAGGED with the
        //    spot's id and struck by id on failure - recordOreSpot MOVES position
        //    onto a bigger reading, so a coordinate strike silently matches
        //    nothing (the documented food-ledger bug, one ledger over).
        for (const want of this._materialWants()) {
            if (!want.kinds?.length) continue;
            const spot = this.memory.nearestOreSpot?.(p, dim, { kinds: want.kinds, world });
            if (!spot) continue;
            const key = `ore_${spot.kind}`;
            if (onCooldown(key)) continue;
            const label = ORE_SPOT_KINDS[spot.kind]?.label || spot.kind;
            const item = ORE_SPOT_KINDS[spot.kind]?.get || want.item;
            arm(key);
            if (spot.distance > 24) {
                return {
                    action: 'move',
                    params: {
                        x: spot.position.x, y: spot.position.y, z: spot.position.z,
                        target: `the ${label} seam`, ...this._oreSpotTag(spot)
                    },
                    say: `${want.why}. there's ${label} ${spot.distance} blocks out and i know exactly where`
                };
            }
            return {
                action: 'get',
                params: { target: item, amount: want.amount, ...this._oreSpotTag(spot) },
                say: `${want.why}. standing on the ${label}, so this is the easy part`
            };
        }

        // 3. WHAT THE HOUSE IS SHORT OF, with no seam remembered for it. stone is
        //    the usual answer here and there is no such thing as a stone "spot".
        //
        //    ⚠ IF SHE OWNS A QUARRY, THE STONE RUN STARTS INSIDE IT. This branch
        //    sits ABOVE the quarry route below and fires precisely when the house
        //    is short of stone - i.e. on every single restock - so a blind `get
        //    cobblestone` here is the fresh-scrape-per-restock behaviour the
        //    quarry exists to end, and the route below would never once be
        //    reached while there was a wall to finish.
        const need = this._materialWants().find((w) => !w.kinds?.length);
        if (need && !onCooldown(`need_${need.item}`)) {
            const hole = this.memory.nearestQuarry?.(p, dim, world);
            if (hole && hole.distance > 24) {
                arm(`need_${need.item}`);
                return {
                    action: 'move',
                    params: { x: hole.mouth.x, y: hole.mouth.y, z: hole.mouth.z, target: hole.name },
                    say: `${need.why}. walking to ${hole.name} first - measured from inside my own hole, "nearest stone" is the bottom of it`
                };
            }
            arm(`need_${need.item}`);
            return {
                action: 'get', params: { target: need.item, amount: need.amount },
                say: hole
                    ? `${need.why}. down the quarry, which gets deeper every time i need a wall`
                    : `${need.why}. going to go and be a rock person about it`
            };
        }

        // 4. THE QUARRY. a fixed mouth is the whole reason the hole deepens into a
        //    mine instead of being a fresh scrape every restock - measured from
        //    inside it, "nearest stone" is the stone at the bottom of her own hole.
        const quarry = this.memory.nearestQuarry?.(p, dim, world);
        if (quarry && !onCooldown('quarry')) {
            arm('quarry');
            this._declareLongGoal('dig the quarry out properly', 'quarry', quarry.id);
            if (quarry.distance > 24) {
                return {
                    action: 'move',
                    params: { x: quarry.mouth.x, y: quarry.mouth.y, z: quarry.mouth.z, target: quarry.name },
                    say: `${quarry.name} is ${quarry.distance} blocks out. mining from inside my own hole instead of scraping a new one`
                };
            }
            return {
                action: 'get', params: { target: 'cobblestone', amount: 64 },
                say: 'down the quarry. this hole gets deeper every time i need a wall'
            };
        }

        // 5. NOTHING REMEMBERED. prospect: the scan's nearest ore if there is one,
        //    otherwise go and look, which is the only honest way to find a seam
        //    she has never seen.
        const scanOre = typeof nb.nearestOre === 'string' ? nb.nearestOre : null;
        if (scanOre && !onCooldown('prospect_here')) {
            arm('prospect_here');
            return {
                action: 'mine', params: { target: scanOre },
                say: `there's ${scanOre.replace(/^minecraft:/, '').replace(/_/g, ' ')} right there. taking it before i go looking for anything else`
            };
        }
        if (!onCooldown('prospect')) {
            arm('prospect');
            return { action: 'explore', params: {}, say: 'nothing in the ground round here that i know about. going prospecting' };
        }
        return null;
    }

    /**
     * GATHER FOOD: bake what she is holding, work the fields she remembers,
     * hunt, then forage. every route below is either a place she has personally
     * seen food or a hunt that needs no place at all.
     */
    _gatherFoodStep(p, onCooldown, arm) {
        // 0. THE PANTRY, FIRST. "gather food" said with five hundred loaves in her
        //    own chest means go and get them, not go and grow more - that is the
        //    reported bug, and this is the mode it is loudest in. ⚠ above the
        //    bake, because `_bakeTarget` now returns 0 when the pantry is stocked;
        //    without a shelf trip here the whole mode would simply go quiet and
        //    she would stand in a field owning food she never collected.
        if (!onCooldown('shelf')) {
            const shelf = this._pantryFoodStep();
            if (shelf) { arm('shelf'); return shelf; }
        }
        // 1. BAKE. ⚠ bounded by the wheat actually in her pockets (_bakeTarget),
        //    because `@get bread n` is recursive and short of wheat it silently
        //    becomes a crop expedition - the documented 3m38s freeze.
        const bakeTo = this._bakeTarget(BREAD_HOARD);
        if (bakeTo && !onCooldown('bake')) {
            arm('bake');
            return { action: 'craft', params: { target: 'bread', amount: bakeTo }, say: this._breadLine() };
        }
        // 2/3. the fields she remembers, then a hunt. _foodRunStep already ranks
        //      ready wheat -> another remembered food spot -> one blind wheat hunt
        //      -> meat, and it TAGS what it dispatched so a failed trip strikes
        //      the exact spot it was for.
        if (!onCooldown('food_run')) {
            const step = this._foodRunStep(p, this.gameState.dimension);
            if (step) {
                arm('food_run');
                return step;
            }
        }
        // 4. FORAGE. ⚠ stock_food, deliberately NOT `eat`: eat lives in
        //    SAFETY_ACTIONS and skips the busy gate, which is right for "she is
        //    starving, interrupt this" and exactly wrong for a downtime trip. its
        //    n is a food SCORE (nutrition x count), so both halves of the gate are
        //    scored - an item-count trigger against a score target has a fixed
        //    point where the step is permanently due and permanently instant.
        // ⚠ AND NOT WHILE THE PANTRY CAN COVER IT. step 0 is the normal door to
        // her own shelf, but it has a cooldown and this does not - "going out to
        // stock up on food" with a fresh reading saying she owns enough to close
        // the gap is the reported bug in its most literal form, so the check is
        // repeated here rather than left to the ordering. a stale or empty ledger
        // scores 0 and this reads exactly as it always did.
        const gap = FOOD_RESERVE_UNITS - this._foodScore();
        if (gap > 0 && this._storedFoodScore() < gap && !onCooldown('forage')) {
            arm('forage');
            return {
                action: 'stock_food', params: { amount: FOOD_RESERVE_UNITS },
                say: 'the pantry is a rumour. going out until it is a fact'
            };
        }
        return null;
    }

    /**
     * SCOUT: walk unvisited ground and let the observers do the learning.
     *
     * she records terrain cells, food spots, ore seams and claims as she passes
     * them, so the whole mode is "put her somewhere new and get out of the way".
     *
     * ⚠ THE DESTINATION COMES FROM _pickLandingSpot AND NOWHERE ELSE. that is the
     * entire anti-ping-pong story: it refuses drowned bearings, claimed cells,
     * ground she has already walked out to and turned down, and (strict pass)
     * anywhere she has recently been - and it REMEMBERS the spot it hands back.
     * rolling a bearing by hand here walks her between the same two clearings
     * until somebody notices.
     */
    _scoutAreaStep(p, onCooldown, arm) {
        if (onCooldown('scout')) return null;
        // she is never ocean content, and the settle window after climbing out
        // exists so the next pick doesn't fling her straight back in.
        if (this._justLeftWater()) return null;
        // ⚠ THE SCOUT LEANS ON CURIOSITY HARDER THAN ANYTHING ELSE DOES, because
        // finding new ground is the entire brief. at the default weight the
        // dry-route term still steers her back down corridors she has already
        // walked, which is a scout that scouts its own footprints.
        const spot = this._pickLandingSpot(p, SCOUT_MIN_DISTANCE, SCOUT_MAX_DISTANCE, { curiosity: 2 });
        if (!spot) return null;   // no dry unvisited bearing - let the menu have it
        arm('scout');
        const dist = Math.round(Math.hypot(spot.x - p.x, spot.z - p.z));
        return {
            action: 'move',
            params: { ...spot, target: 'ground i have not seen' },
            say: this._pickFresh('scout', FLAVOR_LINES.get('scout'))
        };
    }

    /**
     * SECURE: hold the homestead. be on station, clear what is on it, patch
     * herself up, light it, and otherwise STAY PUT - the last one matters,
     * because a guard who wanders off is not guarding anything.
     */
    _secureAreaStep(p, onCooldown, arm) {
        const g = this.gameState;
        const home = this._home();
        const homeDist = this._homeDistance();

        // 1. ON STATION. a relocation search is a bounded hunt for a NEW home, so
        //    marching back to the old one mid-search would undo it.
        if (home && Number.isFinite(homeDist) && homeDist > SECURE_STATION_RADIUS && !this._homeRelocation) {
            if (!onCooldown('station')) {
                arm('station');
                return { action: 'go_home', params: {}, say: `${Math.round(homeDist)} blocks from the place i am supposed to be watching. going back to it` };
            }
        }
        if (!home) {
            // no homestead: the nearest outpost is the thing worth standing on.
            let outpost = null;
            try { outpost = this._nearestSettlement(this.memory.listOutposts(this._worldId()) || []); } catch { /* none yet */ }
            if (outpost && !onCooldown('station')) {
                const dist = outpost.distanceTo?.(g.position);
                if (Number.isFinite(dist) && dist > SECURE_STATION_RADIUS) {
                    arm('station');
                    return {
                        action: 'move',
                        params: { ...outpost.anchor, dimension: this._dimForMove(outpost.dimension), target: outpost.name },
                        say: `nothing here is mine to guard. going to sit on ${outpost.name} instead`
                    };
                }
            }
        }

        // 2. SOMETHING IS ON IT. the urgent-safety branch far above owns actual
        //    emergencies; this is the residue - the mob that is a nuisance rather
        //    than a crisis, and on guard duty a nuisance is still the job.
        const hostiles = Number(g.nearbyHostiles) || 0;
        if (hostiles > 0 && !onCooldown('defend')) {
            arm('defend');
            return {
                action: 'defend', params: {},
                say: hostiles > 2
                    ? `${hostiles} of them on my land. this is what i am here for`
                    : 'something wandered onto my land. removing it'
            };
        }

        // 3. HURT. food first (that is what heals her), then get behind the walls.
        const hp = Number(g.health);
        if (Number.isFinite(hp) && hp <= SECURE_LOW_HEALTH) {
            if (this._foodOnHand() >= 1 && !onCooldown('patch_up')) {
                arm('patch_up');
                return { action: 'eat', params: this._eatParams(), say: 'chewed up. eating before i take another hit out here' };
            }
            if (home && Number.isFinite(homeDist) && homeDist > 8 && !onCooldown('retreat')) {
                arm('retreat');
                return { action: 'go_home', params: {}, say: 'this is going badly. getting behind my own walls' };
            }
        }

        // 4. LIGHT IT. dark ground is where the next hostile spawns, so lighting
        //    the perimeter is the only part of guard duty that is preventative.
        const torches = this._inventoryCount('torch');
        const night = String(g.timeOfDay || '').toLowerCase() === 'night';
        const underground = Number.isFinite(Number(g.position?.y)) && Number(g.position.y) < 45;
        if (night || underground || hostiles > 0) {
            if (torches < SECURE_TORCH_FLOOR) {
                if (!onCooldown('torch_stock')) {
                    arm('torch_stock');
                    return { action: 'get', params: { target: 'torch', amount: 16 }, say: 'no torches and it is dark. that is how the mobs get a foothold' };
                }
            } else if (!onCooldown('light_perimeter')) {
                arm('light_perimeter');
                return { action: 'place', params: { target: 'torch' }, say: 'another torch in the dark bit. nothing spawns in a lit yard' };
            }
        }

        // 5. HOLD STATION. standing still is a DECISION here, not the residue of
        //    one - and it is still bounded: `idle` is a persistent action and
        //    _recoverPersistentGoal rotates her out of it after its dwell.
        if (!onCooldown('hold')) {
            arm('hold');
            return {
                action: 'idle', params: {},
                say: this._pickFresh('hold_station', FLAVOR_LINES.get('hold_station'))
            };
        }
        return null;
    }

    /**
     * IS SHE ON A TRIP RIGHT NOW?
     *
     * Cheap, exception-safe, and asked by every rung that would otherwise pull her
     * home. This is the load-bearing half of the expedition: `_expeditionStep` sits
     * above the idle menu, but a leg that finds no dry way out returns null and the
     * tick FALLS THROUGH to the rungs below - where the night home-instinct would
     * cheerfully walk her the 2400 blocks back and the trip would quietly become the
     * same 630-block orbit it was built to break. A feature that only works while it
     * is returning non-null is not a feature.
     */
    _onExpedition() {
        try { return !!this.memory.getExpedition?.(this._worldId()); } catch { return false; }
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

        // safe and stocked -> upgrade the kit, then stock the shelf with spares.
        // below the obsession on purpose: she'd rather install a smoker than mine
        // iron, which is the whole point of her.
        const ambition = this._armoryStep();
        if (ambition) return ambition;

        // ...and once even the armory has nothing to ask for, the house is
        // finished, the shelf is full and nobody wants anything. THIS is the state
        // that used to have no answer but "walk 900 blocks", so it gets one: make
        // the place hers, go and look at something she likes, or stand still on
        // purpose. sampled so the mood menu below still gets its turns - leisure
        // that always wins is just a differently-shaped chore.
        if (Math.random() < LEISURE_SAMPLE) {
            const leisure = this._leisureStep();
            if (leisure) return leisure;
        }

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
        //
        // ⚠ NOT WHILE SHE IS ON A TRIP. This is the single rung most able to silently
        // cancel an expedition: it fires at night, at any distance under 1200, and an
        // expedition spends most of its length inside that band. A person who has
        // walked two thousand blocks to see something does not turn round at dusk -
        // they put a hole in a hillside and carry on in the morning. The survival
        // rungs above already own actually surviving the night.
        const home = this._home();
        if (home && !this._onExpedition() &&
            g.timeOfDay === 'night' && this._dimMatches(home.dimension, g.dimension) && !this._homeRelocation) {
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
            // ⚠ THE STAND-DOWN MUST SAY SO, NOT JUST RETURN NOTHING. this was a bare
            // `null`, which the caller cannot tell apart from "the menu rolled nothing
            // it had materials for" - so it fell through to `_executeLastResort()`,
            // whose hostiles-present candidate list opens with `defend`. she is
            // frightened, she has judged the fight not worth it, and the floor sent
            // her into melee on the same tick. the exact opposite of this branch.
            //
            // `action: null` is the file's existing word for a deliberate stand-down
            // (see `_urgentSafetyBehavior` and the lava case: "drop the plan,
            // survival first"), and the caller now honours it the same way.
            return risk >= 48
                ? { action: 'defend', params: {}, say: 'okay, enough backing up. clearing the things on me, then reassessing' }
                : { action: null, params: {}, say: 'not taking this one. backing off and letting my feet sort it out' };
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
        {
            // one entry per action now, so a menu pick is judged on its own verb
            // AND its own target - a dead wheat run no longer silences every gather.
            const filtered = menu.filter((m) => !this._isAvoided(m.action, m.target));
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
        return { action: pick.action, params: this._idleGatherParams(pick), say: pick.say };
    }

    /**
     * AN IDLE GATHER HAS TO BE REAL WORK.
     *
     * Menu picks carried only `{target}`, and the bridge floors a missing amount to
     * 1. But `@get <item> <n>` is a HOLD TARGET, not a batch - ResourceTask.isFinished
     * is a plain `>=` count check - so "get 1 oak_log" while holding any oak_log at
     * all finishes instantly and reports SUCCESS. That success fires _noteTaskOutcome,
     * which wakes the tick 6.5s later, which rolls the menu again. Yesterday's log has
     * `mine and collect: [[coal] x 1]` set as a user task TWENTY-FIVE times in a row at
     * 6-7 second intervals: she looked busy, said a line each time, and gathered
     * nothing. It is a large share of "she just runs around with no aim".
     *
     * So the amount is computed from what she is ALREADY holding, the same way
     * _bakeTarget and _wheatRunTarget do. An unmatched name counts 0 and simply asks
     * for the batch, which is never worse than the 1 it replaces.
     */
    _idleGatherParams(pick) {
        if (!pick?.target) return {};
        const batch = IDLE_GATHER_TARGET_BATCH[pick.target]
            ?? IDLE_GATHER_BATCH[pick.action]
            ?? IDLE_GATHER_BATCH.default;
        let held = 0;
        try { held = Number(this._inventoryCount(pick.target)) || 0; } catch { held = 0; }
        return { target: pick.target, amount: held + batch };
    }

    // everything she's carrying, lowercased, as one searchable string. mirrors
    // modes.js deriveKit()'s sources so the loop sees the same kit she's told about.
    // how many food items she is actually holding. inventory entries arrive as
    // "N minecraft:bread" strings from the companion.
    // ⚠ COUNTS STACKS, and it has to read BOTH inventory shapes to do it. this
    // used to build its text from the item NAME alone for an object-shaped entry
    // ({item:'bread', count:16} -> 'bread'), so the parseInt found no digits and a
    // full stack of sixteen loaves scored as one. the companion sends strings today
    // and objects are handled everywhere else in this file, so it read correct
    // right up until the shape changed under it. _inventoryCountRe is the one
    // normalizer that already gets this right - use it rather than keeping a second
    // copy of the parsing that can drift again.
    _foodOnHand() {
        return this._inventoryCountRe(FOOD_RE);
    }

    // every food stack she carries, as {name, count}. FOOD_RE is an unanchored
    // substring match, which is fine for "is there ANY food on me" but wrong the
    // moment a number depends on it: `rabbit` matches rabbit_hide and rabbit_foot,
    // `melon` matches melon_seeds, `carrot` matches carrot_on_a_stick. six rabbit
    // hides would read as a stocked pantry and suppress the forage while she
    // starved - and they are not deposited either, so they sit in the bag holding
    // bagFull true. an explicit non-food exclusion keeps the count honest.
    _foodStacks() {
        const inv = this.gameState.inventory;
        if (!Array.isArray(inv)) return [];
        const out = [];
        for (const entry of inv) {
            const raw = typeof entry === 'string'
                ? entry
                : `${entry?.count ?? entry?.amount ?? ''} ${entry?.item ?? entry?.name ?? ''}`;
            const text = String(raw).toLowerCase();
            const name = (text.match(/([a-z_][a-z0-9_]*)\s*$/) || [])[1];
            if (!name || !FOOD_RE.test(name)) continue;
            if (/_(hide|foot|seeds|on_a_stick|stem|vine|block)$/.test(name)) continue;
            const m = text.match(/^\s*(\d+)\s/);
            out.push({ name, count: m ? parseInt(m[1], 10) : 1 });
        }
        return out;
    }

    // the same number altoclef's CollectFoodTask compares against: nutrition x
    // count, summed. this is what `@food <n>` means, so it is the only honest way
    // to decide whether asking for n is worth a trip.
    _foodScore() {
        let total = 0;
        for (const { name, count } of this._foodStacks()) {
            total += (FOOD_NUTRITION[name] ?? FOOD_NUTRITION_FALLBACK) * count;
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
            // the target is what her own wheat pays for, so it stays a bake and
            // never becomes the expedition described above - but it is the whole
            // bag of wheat, not the flat 1 the bridge floors a missing amount to.
            // she is at ZERO food here; baking one loaf just brings her back in a
            // minute.
            // ⚠ pantry:false - THIS ONE IS SURVIVAL, not supply. she is carrying
            // zero food, and a chest is not food. bread she owns three hundred
            // blocks away must not talk her out of baking the wheat in her hand.
            const canBakeNow = this._bakeTarget(BREAD_COMFORT, { pantry: false });
            candidates.push({
                key: 'food',
                action: canBakeNow ? 'craft' : 'eat',
                params: canBakeNow ? { target: 'bread', amount: canBakeNow } : { amount: EAT_GATHER_TARGET },
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
        // RANGED, and deliberately BELOW the blade and the meal. a bow is a fight
        // she wins better; a sword and something to eat are fights she survives at
        // all, and gear order stops being a comfort question the moment something
        // is chasing her (see the hostiles-first sword at the top of this list).
        //
        // ⚠ `\bbow\b` - via _itemExact - and the boundary earns its place in BOTH
        // directions here: `crossbow` and `bowl` must NOT read as a bow (there is
        // no boundary before `bow` in either, so they correctly fail), while
        // `minecraft:bow` and `1 bow` must (the colon and the space are
        // boundaries). this is the exact mirror of the `\bbucket\b` trap recorded
        // in ARMORY_SUNDRIES, where the boundary WRONGLY excluded `water_bucket` -
        // `_` is a word character - and a plain substring was the right answer.
        // same operator, opposite verdict, because the neighbouring characters
        // differ. a bare /bow/ here would have her skip the bow forever on the
        // strength of a soup bowl.
        const hasBow = this._itemExact('bow') > 0;
        // ⚠ GATED ON THE STRING SHE IS ALREADY HOLDING. `@get bow` is recursive,
        // so short of string this stops being a craft and silently becomes a
        // spider hunt captioned "making a bow" - the `craft bread` with no wheat
        // trap that stood her still for 3m38s. the food candidate above solves the
        // identical problem with `canBakeNow`; this is the same guard.
        if (!hasBow && this._itemExact('string') >= BOW_STRING_COST) {
            candidates.push({
                key: 'bow',
                action: 'craft',
                params: { target: 'bow' },
                say: 'i have string sat doing nothing and skeletons keep opening at range. making a bow so i can answer back'
            });
        }
        // ...and the quiver, bounded the same way and for the same reason. an
        // arrow target she cannot afford is a gravel-and-chicken expedition, not a
        // craft, so the ask is capped at what the flint and feathers actually pay
        // for - the `_bakeTarget` shape ("bounded by carried wheat"), one item
        // along. the `> arrowsHeld` test is what guarantees this is never the
        // documented instant no-op that reports success and does nothing.
        const arrowsHeld = this._itemExact('arrow');
        if (hasBow && arrowsHeld < ARROW_FLOOR) {
            const makeable = Math.min(this._itemExact('flint'), this._itemExact('feather')) * ARROWS_PER_CRAFT;
            const target = Math.min(ARROW_TARGET, arrowsHeld + makeable);
            if (target > arrowsHeld) {
                candidates.push({
                    key: 'arrows',
                    action: 'craft',
                    params: { target: 'arrow', amount: target },
                    say: 'a bow with nothing to put in it is an expensive stick. topping the quiver up'
                });
            }
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
            // ⚠ THE RESERVE'S WHOLE PURPOSE, CASHED IN. this is the exact moment
            // the armory exists for: a tool about to snap used to mean a mining
            // trip, every time, even with three spares of it on her own shelf.
            //
            // the radius is deliberately TIGHTER than the pantry default. a 256-
            // block walk home is the right answer to "restock the bread" and the
            // wrong answer to "this pickaxe dies in four swings" - out at the far
            // end of a cave the honest move is still to make one.
            const shelf = this._pantryStep(held, 1, {
                radius: RESERVE_SHOP_RADIUS,
                say: `my ${held.replace(/_/g, ' ')} is about to go and there is a spare in my own chest. this is why i put it there`
            });
            candidates.push(shelf
                ? { key: `replace_${held}`, ...shelf }
                : {
                    key: `replace_${held}`,
                    action: 'craft',
                    params: { target: held },
                    say: `my ${held.replace(/_/g, ' ')} is one swing from confetti. making a spare before it happens somewhere stupid`
                });
        }
        // NOTE: gear PROGRESSION (iron upgrade, armor, the reserve on the shelf)
        // deliberately does not live here. survival prep is a gap-closing gate - it
        // must go null once she's kitted, or the idle menu behind it (bread, the
        // homestead arc, the obsession) never gets a tick. wanting better gear is
        // downtime, not a gate: see _armoryStep(), consulted from _pickIdleBehavior.

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

    // a host may register 'bread' lines; none ship with the library.
    _breadLine() {
        return this._pickFresh('bread', FLAVOR_LINES.get('bread'));
    }

    _recoverPersistentGoal(now = Date.now()) {
        const goal = this.activeGoal;
        if (!goal?.persistent) return false;
        const base = goal.action === 'idle' ? PERSISTENT_IDLE_DWELL_MS : PERSISTENT_DWELL_MS;
        // THE REQUESTED-DWELL BONUS IS FOR GOALS WHOSE POINT OUTLASTS A ROTATION -
        // "follow me", "go explore that way". Standing still has no such point, so
        // tripling it is how the short leash deliberately put on idle (see
        // PERSISTENT_IDLE_DWELL_MS, "standing still is dead air on stream") was
        // silently handed back: an idle her own brain asked for scored 3min x 3 =
        // NINE MINUTES, and that is exactly what stream got (live 2026-08-08,
        // 15:19:31 -> 15:28:51, 9m19s of "Refreshed inventory..." and nothing
        // else). Whoever asked for it, doing nothing keeps the short leash.
        let dwellMs = (goal.source === 'autonomous' || goal.action === 'idle')
            ? base
            : base * PERSISTENT_REQUESTED_DWELL_MULT;
        // Being hurt ends a parked goal early no matter who asked for it.
        // ⚠ THE DANGER CLOCK RUNS FROM THE DAMAGE, NOT FROM THE GOAL.
        //
        // This read `dwellMs = min(dwellMs, 15s)` and then `now - goal.startedAt <
        // dwellMs`, which measures the WRONG INTERVAL: for any goal older than 15
        // seconds the comparison is already satisfied, so a SINGLE hit rotated it out
        // on the spot. One skeleton arrow ended a follow instantly, blacklisted
        // `follow` for two minutes, and - since follow is deliberately not in
        // RESUMABLE_ACTIONS - the person had to ask again. "Being hurt ends a parked
        // goal early" is meant to catch standing still WHILE being chewed on, so the
        // question is how long she has been under fire, not how old the job is.
        const hurtRecently = now - (this._lastDamageAt || 0) < PERSISTENT_DANGER_BREAK_MS;
        const underFireMs = hurtRecently ? now - (this._damageEpisodeAt || now) : 0;
        // ⚠ AND THE TWO STANCES ARE NOT THE SAME THING. `idle` is a PARK - she is
        // deliberately doing nothing - and standing still while something chews on her
        // is the worst available response, so one hit ends it immediately. `follow` and
        // `explore` are stances she is actively living: she is moving, with somebody or
        // somewhere in mind, and altoclef's defense chain is already swinging back.
        // Ending those on a single arrow is what made an escort last exactly one
        // skeleton. (mc_water_test's "she stops standing still while taking damage"
        // caught this when the distinction was first missed - it is a real rule.)
        const parked = goal.action === 'idle';
        const dangerRotate = hurtRecently && (parked || underFireMs >= PERSISTENT_DANGER_BREAK_MS);
        if (!dangerRotate && now - goal.startedAt < dwellMs) return false;

        const description = this._describeTask(goal.action, goal.params);
        const why = dangerRotate ? 'spent too long parked under fire' : `hit its ${Math.round(dwellMs / 60000)}min dwell budget`;
        this.log('info', `${goal.source} ${description} ${why}; rotating`);
        try {
            this.memory.record('completed', `${description} (${hurtRecently ? 'broken off - taking hits' : 'dwell budget spent'}, moving on)`, {
                action: goal.action,
                target: goal.params?.target,
                position: this.gameState.position,
                dimension: this.gameState.dimension
            });
        } catch { /* recovery must not be defeated by optional memory */ }
        this._avoidNote(goal.requestedAction || goal.action, LOOP_AVOID_MS, goal.params?.target);
        // ⚠ ONLY A ROTATION UNDER FIRE IS AN INTERRUPTION. A goal that simply spent its
        // dwell budget is FINISHED with, and re-offering it would undo the leash that
        // exists because standing still is dead air. Being driven off it is different:
        // she was escorting somebody, something shot at her, and the escort should not
        // end because of that.
        if (dangerRotate) this._noteTaskInterrupted(goal, 'got shot at while doing it');
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
        const unowned = !this.activeGoal && !this.currentAction && !hasPendingTask;
        // ⚠ ASK THE GAME, NOT ONLY OUR OWN BOOKKEEPING.
        //
        // This tested `this.currentTask && ...`, and _expirePendingAction NULLS
        // currentTask on its way out - so the one path that reliably manufactures an
        // orphan was the one path this detector could never see. Node forgot the job,
        // never told AltoClef to drop it, and the game kept running it: `@hero` and
        // `#explore` never finish on their own, so she wandered and fought with node
        // reporting "idle" the whole time. That is the literal shape of "i have no
        // idea what she's doing".
        //
        // botTask is the companion's live root task, so it is evidence about the GAME
        // rather than about us. NON_TASK phases (idle) are not a job worth stopping.
        const gameBusy = !!this._cleanPhase(this.gameState?.botTask)
            && !/^idle\b/i.test(this._cleanPhase(this.gameState.botTask));
        const orphaned = unowned && (!!this.currentTask || gameBusy);
        if (!orphaned) {
            this._orphanTaskSince = 0;
            return false;
        }
        if (!this._orphanTaskSince) this._orphanTaskSince = now;
        if (now - this._orphanTaskSince < ORPHAN_TASK_LIMIT_MS) return false;

        const what = this.currentTask || this._cleanPhase(this.gameState?.botTask);
        this.log('warn', `no goal owns "${what}" - clearing it so she can pick something`);
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
    // `local:true` drops the open-ended picks, for callers that need a floor under
    // her without undoing a bounded search in progress (a relocation hunt is
    // deliberately confined near the old home - an `explore` would carry her out
    // of the box it is searching).
    _executeLastResort({ local = false } = {}) {
        const candidates = Number(this.gameState.nearbyHostiles) > 0
            ? [
                { action: 'defend', params: {}, say: 'that plan wedged. clearing the immediate problem instead' },
                { action: 'explore', params: {}, say: 'that plan wedged. moving on instead of staring at it' }
            ]
            : [
                { action: 'explore', params: {}, say: 'that plan wedged. moving on instead of staring at it' },
                { action: 'collect', params: { target: 'oak_log', amount: 4 }, say: 'that plan wedged. doing a small wood run instead' }
            ];
        for (const candidate of (local ? candidates.filter((c) => c.action !== 'explore') : candidates)) {
            if (this._isAvoided(candidate.action, candidate.params?.target)) continue;
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
        if (this._isAvoided(action, params?.target)) {
            // ...EXCEPT WALKING OUT OF THE SPAWN REGION. this blacklist exists so
            // she stops re-picking an action that just stalled, but the march
            // picks a fresh destination every time and is the ONLY thing she is
            // allowed to do in here. a mob pinning her mid-hop blacklists `move`
            // for two minutes, and the tick has nothing else to offer, so she
            // stood in the middle getting chased while the one escape she had was
            // switched off. that is the loop the owner watched, not a symptom of it.
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
    // returns true when it took over recovery (stopped the runner and issued an
    // escape of its own), so the caller does not fire a second stop that would
    // cancel the hop it just started.
    // `breakOut:false` records the evidence without acting on it - for callers
    // that already run their own stop-and-walk escape (pinned, protection, water),
    // where a second concurrent escape would just cancel the first. the anchor is
    // deliberately LEFT STANDING at threshold in that case, so the next abort here
    // that is allowed to act still finds a full streak waiting for it.
    /**
     * "That just died - don't re-pick it for a bit."
     *
     * One entry per ACTION, each with its own deadline, because seven watchdogs
     * write here and a single slot meant they kept cancelling each other out.
     *
     * The TARGET rides along so the suppression is no wider than the evidence. A
     * failed `get wheat` used to silence every `get` for two minutes - the fuel
     * restock, the torch restock, the appliance buy, the iron grind and every
     * survival-prep gather, all on the strength of one wheat trip. A verb that
     * failed with no target named still suppresses the whole verb, because there
     * is nothing narrower to blame.
     */
    _avoidNote(action, ms = LOOP_AVOID_MS, target = null) {
        const act = String(action || '').trim().toLowerCase();
        if (!act || NON_TASK_ACTIONS.has(act)) return;
        const until = Date.now() + ms;
        const key = String(target ?? '').trim().toLowerCase() || null;
        const existing = this._avoid.get(act);
        // a second failure on a DIFFERENT target widens the suppression back to the
        // whole verb: two targets failing the same way is evidence about the verb.
        const widen = existing && Date.now() < existing.until && existing.target && existing.target !== key;
        this._avoid.set(act, {
            until: Math.max(until, existing && Date.now() < existing.until ? existing.until : 0),
            target: widen ? null : key
        });
    }

    _isAvoided(action, target = null) {
        const act = String(action || '').trim().toLowerCase();
        const entry = act ? this._avoid.get(act) : null;
        if (!entry) return false;
        if (Date.now() >= entry.until) { this._avoid.delete(act); return false; }
        if (!entry.target) return true;                  // the verb itself is suspect
        const want = String(target ?? '').trim().toLowerCase();
        if (!want) return true;                          // unnamed: stay conservative
        return want === entry.target;
    }

    _clearAvoid(action) {
        this._avoid.delete(String(action || '').trim().toLowerCase());
    }

    _noteStallHere({ breakOut = true } = {}) {
        const p = this._point(this.gameState.position);
        if (!p) return false;
        const now = Date.now();
        const anchor = this._stallAnchor;
        if (anchor && now - anchor.at < STUCK_WINDOW_MS &&
            Math.hypot(p.x - anchor.x, p.z - anchor.z) <= STUCK_RADIUS) {
            anchor.at = now;
            anchor.count += 1;
        } else {
            this._stallAnchor = { x: p.x, z: p.z, at: now, count: 1 };
        }
        if (this._stallAnchor.count < STUCK_STREAK) return false;
        if (!breakOut) return false;
        this._stallAnchor = null;
        this._breakOutOfStuckSpot(p);
        return true;
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
        // PICK THE ESCAPE BEFORE CONDEMNING THE GROUND. recording the rejection
        // first marked the whole 64-block cell as bad terrain and remembered `p`
        // as a recent destination (140-block exclusion) - and the escape then
        // searched 12..64 blocks, i.e. entirely inside the two areas it had just
        // ruled out, so the strict pass could never return anything.
        const known = this._nearestDryCell(p);
        const spot = (known && Math.hypot(known.x - p.x, known.z - p.z) <= STUCK_ESCAPE_MAX
            ? { x: known.x, y: this._safeTravelY(p), z: known.z }
            : null)
            || this._pickLandingSpot(p, 12, STUCK_ESCAPE_MAX);
        // and mark the wedge as a WEDGE, not as a terrain verdict she never took:
        // the cause may have been a mob, a fence or an unreachable goto, none of
        // which say anything about the ground. `_recordSiteRejection` is permanent
        // and would condemn 4096m2 - including her own homestead cell if she ever
        // wedges while building there.
        this._rememberDestination(p);
        this.recentEvents.record('got wedged on one spot and had to break out of it');
        try {
            this.memory.record('recovery', 'wedged in one spot - every job failed there', {
                action: 'move', position: p, dimension: this.gameState.dimension
            });
        } catch { /* best-effort */ }
        if (!spot) {
            // nothing reachable that she knows of. say so rather than pretending -
            // the honest fallback is altoclef's own wander, which at least moves.
            // it goes through the same stop as the hop below, because `explore` is
            // a task action and the busy gate refuses it just as readily.
            this._pushCommentary("i can't get off this square. every single thing i start dies right here.");
            (async () => {
                try {
                    await this.executeAction('stop', {}, { priority: 'urgent', source: 'recovery', timeoutMs: 30000 });
                } catch { /* may not be running */ }
                try {
                    await this.executeAction('explore', {}, { priority: 'low', source: 'recovery', waitForCompletion: false });
                } catch (err) {
                    this.log('warn', `break-out explore failed: ${err.message}`);
                }
            })();
            return;
        }
        // STOP FIRST, THEN WALK - the same shape as the pinned/protection/water
        // escapes. this used to be a bare _safeExecute('move'), issued from inside
        // _recoverStalledGoal AFTER it had set `currentTask = recovering from ...`
        // and while the aborted goal's pending record was still live. all three
        // count as a live task, so the busy gate rejected the escape every single
        // time, _safeExecute swallowed the rejection into a debug line, and the
        // whole detector did nothing but wipe the backoff on its way past.
        this._pushCommentary("three jobs in a row died on this one spot. it's not the jobs. getting off it.");
        (async () => {
            try {
                await this.executeAction('stop', {}, { priority: 'urgent', source: 'recovery', timeoutMs: 30000 });
            } catch { /* may not be running */ }
            // ⚠ NO BACKOFF JUGGLING HERE ANY MORE. This used to clear the `move`
            // suppression "for the hop itself" and restore it afterwards - which was
            // dead code with a side effect: the hop goes through `executeAction`, and
            // the suppression is only ever READ by _safeExecute, _pickIdleBehavior,
            // _executeLastResort and _spawnEscapeStep. So clearing it bought this
            // dispatch nothing, while for the duration it un-blacklisted `move` for
            // the idle menu, the last resort and the spawn-region march - and a slow
            // dispatch dropped the backoff permanently, because the restore was
            // conditional on the deadline not having passed.
            try {
                await this.executeAction('move', { ...spot, target: 'anywhere but this exact square' },
                    { priority: 'low', source: 'recovery', waitForCompletion: false });
            } catch (err) {
                this.log('warn', `break-out move failed: ${err.message}`);
            }
        })();
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
        // A REFUSAL IS ABOUT THE SITE, SO IT HAS TO OUTLIVE THE GOAL. Without
        // this the abort below only clears the current attempt and her brain
        // starts the identical one straight back up.
        if (blocked) this._armBlockedSite(goal.params, 'the builder cannot finish this site');
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
        this._avoidNote(goal.requestedAction || goal.action, LOOP_AVOID_MS, goal.params?.target);
        this.activeGoal = null;
        this.currentTask = `recovering from stalled ${description}`;
        // "trying something else" is only an answer when the JOB was the problem.
        // count the failures that happen on one patch of ground - see _noteStallHere.
        // the break-out runs its own stop-then-walk. firing this one too would
        // cancel the escape hop the moment it was issued.
        if (this._noteStallHere()) return true;
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
        // ⚠ THE ONE CLOCK `_creditCombatSuspension` DOES NOT PUSH FORWARD, corrected
        // here instead. `startedAt` is also narration and the persistent dwell, so
        // moving it would make her misreport how long she has been at something; but
        // a runtime BUDGET must not be spent by a fight she was forced into.
        const runningMs = now - goal.startedAt - (goal.combatSuspendedMs || 0);
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
        this._avoidNote(goal.requestedAction || goal.action, LOOP_AVOID_MS, goal.params?.target);
        this.activeGoal = null;
        this.currentTask = `breaking out of a loop (${description})`;
        // an orbit IS a job dying on one patch of ground. the by-place counter only
        // ever heard from the stall watchdog, which cannot fire here by definition -
        // she is moving, so lastProgressAt never ages out. three wander-storms or
        // three orbits at one spot were three correct aborts and no wedge verdict.
        if (this._noteStallHere()) return true;
        this._pushCommentary(this._loopBreakLine(description, confined, Math.round((confined ? confinedMs : runningMs) / 60000)));
        // stop; the next autonomy tick picks something different (looped action filtered out)
        this.executeAction('stop', {}, { priority: 'urgent', source: 'loop-recovery', waitForCompletion: false })
            .catch((err) => this.log('warn', `failed to stop looping goal: ${err.message}`));
        return true;
    }

    // 'loop-break' if the host registered one, else nothing said.
    _loopBreakLine(description, confined, minutes) {
        void description; void confined; void minutes;
        return this._pickFresh('loop-break', FLAVOR_LINES.get('loop-break'));
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
                //
                // ⚠ AND NOT WHILE SHE IS ON A TRIP. this is the SECOND home-pull in the
                // file, and the first one (the idle menu's night instinct) carries a
                // paragraph calling itself "the single rung most able to silently cancel
                // an expedition" - then this one fired on the same trigger with no such
                // guard. an expedition spends most of its length inside 24-1500 blocks,
                // and dusk arrives in the middle of nearly all of them, so the ceiling
                // the expedition work removed was quietly reimposed here. a person who
                // has walked two thousand blocks to see something does not turn round at
                // dusk; the survival rungs already own surviving the night.
                if (home && !this._homeRelocation && !this._onExpedition() &&
                    homeDist > 24 && homeDist < 1500) {
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

        // best-effort mirror to any ui websocket clients (overlay), like the
        // toastlings tool does. never throws.
        try {
            // set with `new MinecraftTool({ broadcast })` or setBroadcast(fn);
            // leave it unset and this is a no-op. never throws - a broken overlay
            // must not take the bot down.
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
        if (this.ticTimer) {
            clearInterval(this.ticTimer);
            this.ticTimer = null;
        }
        if (this.autonomousTimer) {
            clearInterval(this.autonomousTimer);
            this.autonomousTimer = null;
        }
        if (this._idleWakeTimer) {
            clearTimeout(this._idleWakeTimer);
            this._idleWakeTimer = null;
        }
        // an arrival still waiting on a decision has a fallback timer armed; a
        // coin flip that fires into a dead socket is a give that cannot land.
        const pendingBread = this._closeBreadOpportunity();
        if (pendingBread?.approachTimer) clearTimeout(pendingBread.approachTimer);
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
