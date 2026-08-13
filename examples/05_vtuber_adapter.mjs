// 05 - the adapter you copy into your own vtuber
//
// run it:   node examples/05_vtuber_adapter.mjs
//
// everything before this file was one piece at a time. this is the whole thing
// wired together: events in, prompts out, words spoken by YOUR model, and an
// arbitration scheme so the bot's own autonomy and your model do not fight over
// one body.
//
// it runs standalone by firing synthetic events at a tool that is not connected
// to anything. replace askYourBrain() and say() and it is production code.
//
// ===========================================================================
// THE RULE THIS FILE EXISTS TO TEACH
// ===========================================================================
//
// every string the core produces is an INTERNAL CUE. it is input to your model.
// it is never, under any circumstance, spoken aloud or posted to game chat
// verbatim.
//
// this is not style advice. a pre-written line pool is the single fastest way
// to make an ai vtuber sound like a vending machine, and it fails in a specific
// and humiliating way: the pool is finite, the stream is not, so viewers hear
// the same sentence for the fourth time and the illusion is simply over. worse,
// the failure gets WORSE the more successful you are - the longer someone
// watches, the more repeats they collect.
//
// bigger pools and shuffle-bags do not fix it, they only move the discovery
// later. the fix is structural: nothing pre-written reaches the audience.
//
// so every path in this file has the same shape:
//
//     event -> a cue describing what happened -> askYourBrain(cue) -> say()
//                                                ^^^^^^^^^^^^^^^^^
//                                          the only thing that produces words
//
// the `commentary` event is the sharpest example, and it is a trap if you skim
// the api: entry.text is a readable english sentence, it looks exactly like
// something to speak, and the moment you pipe it to tts you have shipped a line
// pool. it is a cue. it goes in the prompt.
//
// ===========================================================================
// THE SECOND RULE: THE AUTONOMY LOOP IS A PEER, NOT A SUBROUTINE
// ===========================================================================
//
// the core has its own drives. when self-play is on it picks goals; regardless
// of self-play it runs safety reflexes (get out of the lava, stop being pinned
// by mobs, leave claimed land). those are not your model's decisions and they
// do not wait for a completion.
//
// there is exactly ONE bot and it runs ONE goal at a time. so you have two
// agents reaching for one steering wheel, and if you do not arbitrate you get
// the classic bug: your model says "okay, mining now", autonomy re-tasks two
// seconds later, and your vtuber narrates a plan it is not executing.
//
// the fix is boring and it works: tag every executeAction with a `source`, read
// status.activeGoal.source before you take the wheel, and stop the other
// agent's goal explicitly rather than hoping yours lands on top.

import os from 'os';
import path from 'path';
import { MinecraftTool, MinecraftMemory } from '../core/index.js';
import { buildMinecraftContextBlock } from './03_context_block.mjs';

// ===========================================================================
// YOUR MODEL GOES HERE
// ===========================================================================
//
// this stub returns an obvious placeholder so the example runs offline. it is
// NOT a fallback - if your api is down, say nothing, or say one honest line
// about the api being down. never fall back to canned text, because a fallback
// pool is a line pool wearing a hat.
//
// a real implementation looks like:
//
//   import Anthropic from '@anthropic-ai/sdk';
//   const client = new Anthropic();
//   async function askYourBrain(prompt) {
//       const res = await client.messages.create({
//           model: 'claude-sonnet-4-5',
//           max_tokens: 120,
//           system: YOUR_PERSONA_PROMPT,   // who your character is
//           messages: [{ role: 'user', content: prompt }]
//       });
//       return res.content.find((b) => b.type === 'text')?.text?.trim() || '';
//   }
//
// note what is NOT in the prompt: any example of a good answer. give a model
// three sample lines and it will produce variations on those three lines all
// night. give it the situation and let it write.
async function askYourBrain(prompt) {
    const firstLine = String(prompt).split('\n').find((l) => l.startsWith('right now:')) || prompt;
    return `<<your model's line about ${firstLine.replace(/^right now:\s*/, '').slice(0, 60)}>>`;
}

// your tts / stream output
function say(text, { kind }) {
    console.log(`  [speak/${kind}] ${text}`);
}

// ===========================================================================
// the adapter
// ===========================================================================

// how loud is too loud. a minecraft session emits far more than a person can
// listen to; most of it is texture, not news.
//
//   urgent - always speaks. dying, the link breaking, being spoken to.
//   high   - speaks if it has been at least half the gap.
//   normal - speaks on the full gap.
//   low    - only if nothing else wanted the slot. usually never.
const TIER = { urgent: 3, high: 2, normal: 1, low: 0 };

// which game events matter, and how much. anything not listed is ignored
// outright - block_broken and position_update fire constantly and are state,
// not events worth a sentence.
const EVENT_TIERS = {
    death: 'urgent',
    protection_denied: 'urgent',
    creeper_spotted: 'high',
    diamond_found: 'high',
    achievement: 'high',
    respawn: 'high',
    damage_taken: 'normal',
    hostiles_nearby: 'normal',
    dimension_changed: 'normal',
    nightfall: 'normal',
    low_hunger: 'normal',
    oven_installed: 'normal',
    weather_changed: 'low',
    item_collected: 'low',
    entity_killed: 'low',
    task_finished: 'low',
    room_quiet_moment: 'low'
};

// the core's own goal sources. anything in here means the bot decided for
// itself - safety reflexes, the idle brain, escape routines. treat them as
// another agent's turn, not as noise.
const CORE_SOURCES = new Set([
    'autonomous', 'safety', 'water-escape', 'protection', 'pinned', 'request',
    'gamer', 'recovery', 'loop-recovery', 'dwell-rotation', 'orphan-recovery',
    'hud', 'disable'
]);

export function attachMinecraftToVtuber(tool, options = {}) {
    const {
        brain = askYourBrain,
        speak = say,
        // production: 15000-25000. the demo runs it fast so you can watch the
        // gate work without waiting around.
        minGapMs = 18000,
        sourceTag = 'llm'
    } = options;

    // start the clock at attach time, not at zero. with a zero here the very
    // first event of the session - whatever it happens to be, usually something
    // trivial like picking up a block - gets a free pass through the gate and
    // becomes your opening line.
    let lastSpokeAt = Date.now();
    let inFlight = false;

    // ---------------------------------------------------------------------
    // the one place words are produced
    // ---------------------------------------------------------------------
    async function narrate(cue, { kind, priority = 'normal' } = {}) {
        const tier = TIER[priority] ?? TIER.normal;
        const since = Date.now() - lastSpokeAt;

        // one prompt in flight at a time. two overlapping calls means two
        // voices talking over each other, and the second one is answering a
        // situation that already changed.
        if (inFlight && tier < TIER.urgent) {
            console.log(`  [gate] dropped "${kind}" - already thinking`);
            return;
        }

        const required = tier >= TIER.urgent ? 0
            : tier >= TIER.high ? minGapMs / 2
            : tier >= TIER.normal ? minGapMs
            : minGapMs * 3;

        if (since < required) {
            console.log(`  [gate] dropped "${kind}" (${priority}) - ${Math.round((required - since) / 1000)}s of quiet left to serve`);
            return;
        }

        inFlight = true;
        try {
            // the prompt is: who you are (your persona, in the system prompt),
            // what is true (the context block from 03), what just happened (the
            // cue), and how long to be. nothing else.
            const prompt = [
                buildMinecraftContextBlock(tool.getStatus()),
                '',
                `right now: ${cue}`,
                '',
                'say one or two short lines about this, in your own voice. do not',
                'read out the state above - it is what you know, not what you say.'
            ].join('\n');

            const line = (await brain(prompt) || '').trim();
            if (!line) {
                // an empty answer is a legitimate answer. silence is in character
                // for every character. do not fill it.
                console.log(`  [gate] "${kind}" - your model chose to say nothing`);
                return;
            }
            lastSpokeAt = Date.now();
            speak(line, { kind, priority });
        } catch (err) {
            // your api fell over. say nothing. resist every instinct to add a
            // canned apology line here - that is the pool, re-invented.
            console.log(`  [gate] "${kind}" - brain failed (${err.message}), staying quiet`);
        } finally {
            inFlight = false;
        }
    }

    // ---------------------------------------------------------------------
    // gameEvent - the main feed. signature is (event, data).
    // ---------------------------------------------------------------------
    tool.on('gameEvent', (event, data = {}) => {
        // being talked to in game is its own path: it gets an answer in game,
        // not a narration to the stream.
        if (event === 'chat') {
            handleGameChat(data).catch(() => {});
            return;
        }

        const priority = EVENT_TIERS[event];
        if (!priority) return;   // deliberately ignored

        narrate(describeEvent(event, data), { kind: event, priority });
    });

    // ---------------------------------------------------------------------
    // action outcomes. a completion is worth less than a failure - a failure is
    // a real obstacle, and obstacles are what make a stream watchable.
    // ---------------------------------------------------------------------
    tool.on('actionComplete', ({ action, params }) => {
        narrate(`you finished: ${action}${params?.target ? ` ${params.target}` : ''}`, {
            kind: 'complete', priority: 'low'
        });
    });

    tool.on('actionFailed', ({ action, params, error }) => {
        narrate(`your goal "${action}${params?.target ? ` ${params.target}` : ''}" failed: ${error}`, {
            kind: 'failed', priority: 'high'
        });
    });

    // the goal was cancelled by something else, usually a safety reflex or a
    // stop. do not narrate this as your own decision - it was not.
    tool.on('actionStopped', ({ action }) => {
        console.log(`  [note] "${action}" was stopped by something else - check activeGoal.source before claiming it`);
    });

    // ---------------------------------------------------------------------
    // botTaskPhase - the mod's live task chain changed. this is the single best
    // "what am i actually doing" signal during a long run, because it comes
    // from the thing genuinely doing the work.
    // ---------------------------------------------------------------------
    tool.on('botTaskPhase', ({ phase, previous, gamerMode, what, why }) => {
        const detail = what ? `${what}${why ? ` (${why})` : ''}` : phase;
        narrate(`your task just moved on to: ${detail}${previous ? `, from: ${previous}` : ''}`, {
            kind: 'phase', priority: gamerMode ? 'normal' : 'low'
        });
    });

    // ---------------------------------------------------------------------
    // commentary - READ THE TOP OF THIS FILE. entry.text is a cue.
    //
    // the alternative api is pullCommentary(), which drains the queue instead
    // of streaming it. use that if your loop is a tick rather than a listener.
    // either way, the same rule: it goes in a prompt.
    // ---------------------------------------------------------------------
    tool.on('commentary', (entry) => {
        console.log(`  [cue/${entry.kind}] "${entry.text}"  <- INTERNAL. never spoken as-is.`);
        // 'phase' cues duplicate botTaskPhase above; only narration cues are
        // worth a turn, and even then at low priority.
        if (entry.kind !== 'narration') return;
        narrate(`you are playing on your own and the thought in your head is: ${entry.text}`, {
            kind: 'commentary', priority: 'low'
        });
    });

    // ---------------------------------------------------------------------
    // the world went away mid-goal. this is the one that makes a vtuber look
    // broken if you ignore it: it keeps narrating a session that has ended.
    // ---------------------------------------------------------------------
    tool.on('sessionEnded', ({ strandedTask, username }) => {
        narrate(
            `the world just disconnected${username ? ` (you were playing as ${username})` : ''}` +
            `${strandedTask ? ` in the middle of: ${strandedTask}` : ''}. you are out of the game now.`,
            { kind: 'session-ended', priority: 'urgent' }
        );
    });

    // fault = the control link is unhealthy. your character has hands that
    // stopped answering. that is genuinely interesting; say so.
    tool.on('faultDetected', (fault) => {
        narrate(`your controls just faulted: ${fault.message}. you cannot act until it clears.`, {
            kind: 'fault', priority: 'urgent'
        });
    });
    tool.on('faultCleared', () => {
        narrate('your controls are answering again.', { kind: 'fault-clear', priority: 'high' });
    });

    tool.on('gamerMode', ({ on }) => {
        narrate(on ? 'you just committed to a full speedrun.' : 'the speedrun is over.', {
            kind: 'gamer-mode', priority: 'high'
        });
    });

    // ---------------------------------------------------------------------
    // somebody asked for something. do NOT auto-execute it - put it in front of
    // your model and let it choose, out loud. "no" is a valid stream moment;
    // silently ignoring people is not.
    // ---------------------------------------------------------------------
    tool.on('viewerSuggestion', (entry) => {
        narrate(
            `${entry.user} asked you to: "${entry.text}"` +
            `${entry.freeform ? ' (no built-in action fits - decide with the tools you have)' : ` (that maps to ${entry.action}${entry.target ? ' ' + entry.target : ''})`}` +
            '. you can do it, do your own version, or turn them down.',
            { kind: 'request', priority: 'high' }
        );
    });

    // ---------------------------------------------------------------------
    // in-game chat: answered in game, in your model's words
    // ---------------------------------------------------------------------
    async function handleGameChat(data) {
        const sender = data.sender;
        const text = data.text;

        // same gate as 02. on the real event path the core has already dropped
        // your own echo and de-duplicated multi-path delivery for you.
        const gate = tool.shouldSurfaceChat(sender, text);
        if (!gate.surface) {
            console.log(`  [chat] "${text}" from ${sender} - filtered, not for you`);
            return;
        }

        const aside = gate.toSomeoneElse
            ? ` this was aimed at ${gate.toSomeoneElse}, not you - you are overhearing it.`
            : '';

        const prompt = [
            buildMinecraftContextBlock(tool.getStatus()),
            '',
            `right now: ${sender} said in the server chat: "${text}".${aside}`,
            '',
            'reply in one short line, the way a person types in a game. lowercase',
            'is fine. no slash commands. if there is nothing worth saying, say nothing.'
        ].join('\n');

        const reply = (await brain(prompt) || '').trim();
        if (!reply) {
            console.log('  [chat] your model chose not to reply');
            return;
        }

        console.log(`  [chat] your model composed: ${reply}`);

        // the ONLY way the bot speaks in game. the message is composed by your
        // model, every time. the core paces outgoing chat for you (about one
        // line per 3s, 8 per minute) and will refuse slash commands.
        try {
            await tool.executeAction('chat', { target: reply }, {
                waitForCompletion: false,
                source: sourceTag
            });
            console.log('  [game chat] sent');
        } catch (err) {
            console.log(`  [game chat] not sent: ${err.message}`);
        }
    }

    // ---------------------------------------------------------------------
    // peer arbitration: taking the wheel from the bot's own drives
    // ---------------------------------------------------------------------
    async function takeTheWheel(action, params = {}, { reason = '', force = false } = {}) {
        const status = tool.getStatus() || {};
        const goal = status.activeGoal;

        if (goal) {
            const owner = goal.source || 'unknown';
            const mine = !CORE_SOURCES.has(owner);

            if (mine && !force) {
                // your own goal is already running. issuing a second one is the
                // "she keeps changing her mind mid-sentence" bug.
                console.log(`  [wheel] your own "${goal.action}" is still running (${Math.round(goal.runningForMs / 1000)}s) - not stacking another`);
                return { taken: false, reason: 'already yours' };
            }

            console.log(`  [wheel] "${goal.action}" belongs to ${owner}${mine ? '' : ' (the bot decided that itself)'} - stopping it first`);
            try {
                // explicit stop, then issue. do not "just send the new one" and
                // hope: one goal at a time means the second is refused, not
                // queued, and your model will narrate a plan that never started.
                await tool.executeAction('stop', {}, { priority: 'urgent', source: sourceTag });
            } catch (err) {
                console.log(`  [wheel] stop failed: ${err.message}`);
            }
        }

        try {
            const result = await tool.executeAction(action, params, {
                waitForCompletion: false,
                source: sourceTag
            });
            console.log(`  [wheel] took the wheel: ${action}${params.target ? ' ' + params.target : ''}${reason ? ` (${reason})` : ''}`);
            return { taken: true, result };
        } catch (err) {
            console.log(`  [wheel] could not take the wheel: ${err.message}`);
            return { taken: false, reason: err.message };
        }
    }

    return { narrate, takeTheWheel };
}

// turn a game event into a plain factual cue. present tense, second person, no
// adjectives - the adjectives are your model's job.
function describeEvent(event, data = {}) {
    switch (event) {
        case 'death': return `you died${data.cause ? ` to ${data.cause}` : ''}. your things are on the ground where you fell.`;
        case 'respawn': return 'you respawned.';
        case 'damage_taken': return `something hit you - you are on ${data.health ?? '?'} health.`;
        case 'creeper_spotted': return 'a creeper is close enough to matter.';
        case 'diamond_found': return 'you just hit diamonds.';
        case 'entity_killed': return `you killed a ${data.type || 'mob'}.`;
        case 'item_collected': return `you picked up ${data.item || 'something'}.`;
        case 'hostiles_nearby': return `${data.count ?? 'several'} hostile mobs are nearby.`;
        case 'dimension_changed': return `you crossed into the ${String(data.dimension || 'somewhere else').replace(/^minecraft:/, '')}.`;
        case 'weather_changed': return `the weather turned to ${data.weather || 'something else'}.`;
        case 'nightfall': return 'night just fell.';
        case 'low_hunger': return `you are hungry - ${data.hunger ?? 'low'}/20.`;
        case 'achievement': return `you unlocked ${data.name || 'an advancement'}.`;
        case 'oven_installed': return `you placed a ${String(data.kind || 'block').replace(/_/g, ' ')}${data.name ? ` and named it "${data.name}"` : ''}.`;
        case 'protection_denied': return 'the server refused to let you touch that - you are standing on someone\'s claim.';
        case 'task_finished': return `the mod finished: ${data.task || 'a task'}.`;
        case 'room_quiet_moment': return `server chat has been quiet a while and you are in the middle of ${data.task || 'something'}.`;
        default: return `${event.replace(/_/g, ' ')} happened.`;
    }
}

// ===========================================================================
// demo: synthetic events, nothing connected
// ===========================================================================

const memory = new MinecraftMemory(
    path.join(os.tmpdir(), 'burtcraft-example-memory.json'),
    { registerExitHook: false }
);

const tool = new MinecraftTool({ memory, names: ['ada', 'ada bot'] });

// pretend we are in a world, so the context block renders the live branch and
// the chat manners engage. the companion reports all of this for real.
tool.gameUsername = 'ada';
tool.gameState.multiplayer = true;
tool.gameState.server = 'example.server.net';
tool.gameState.position = { x: -812, y: -47, z: 1633 };
tool.gameState.health = 14;
tool.gameState.hunger = 9;
tool.gameState.selectedItem = 'minecraft:iron_pickaxe';
tool.gameState.inventory = ['minecraft:cobblestone', 'minecraft:bread'];

// a fast gate so the demo is watchable. use 15-25s in production.
const adapter = attachMinecraftToVtuber(tool, { minGapMs: 1200 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('=== synthetic session ===');
    console.log('(nothing is connected. every event below is fired by hand.)');
    console.log('(emitting directly also skips the core\'s own de-dup, which the real path does for you.)\n');

    console.log('-- someone talks to you in game --');
    tool.emit('gameEvent', 'chat', { sender: 'marble', text: 'ada what are you digging for down there' });
    await sleep(400);

    console.log('\n-- low-value texture: correctly ignored or gated --');
    tool.emit('gameEvent', 'item_collected', { item: 'redstone' });
    tool.emit('gameEvent', 'block_broken', { block: 'stone' });   // not in EVENT_TIERS at all
    await sleep(300);

    console.log('\n-- the mod moved on to a new phase --');
    tool.emit('botTaskPhase', {
        phase: 'mine diamond ore: digging to y-54', previous: 'collect cobblestone',
        gamerMode: false, what: 'digging down to y-54', why: 'looking for diamonds'
    });
    await sleep(1400);

    console.log('\n-- an internal commentary cue (the trap) --');
    tool.emit('commentary', { text: 'that pickaxe is not going to last another vein', at: Date.now(), task: 'mine diamond_ore', kind: 'narration' });
    await sleep(1400);

    console.log('\n-- a goal failed. obstacles are the good part. --');
    tool.emit('actionFailed', { id: 'demo1', action: 'mine', params: { target: 'diamond_ore' }, error: 'no path to the target' });
    await sleep(1400);

    console.log('\n-- someone in stream chat asks for something --');
    tool.recordViewerSuggestion('pixelwitch', 'can you go find a village', { inGame: false });
    await sleep(1400);

    console.log('\n-- you died. urgent bypasses the gate entirely. --');
    tool.emit('gameEvent', 'death', { cause: 'a creeper', position: { x: -812, y: -47, z: 1633 } });
    await sleep(400);

    console.log('\n-- peer arbitration: the bot is doing its own thing --');
    // this is what a self-play goal looks like from the outside. getStatus()
    // derives activeGoal from exactly these fields.
    tool.activeGoal = {
        id: 'auto1', action: 'explore', params: {}, source: 'autonomous',
        startedAt: Date.now() - 92000, lastProgressAt: Date.now() - 4000, anchorAt: null
    };
    await adapter.takeTheWheel('mine', { target: 'iron_ore', amount: 8 }, { reason: 'chat asked and you agreed' });

    console.log('\n-- and now with a goal that is already yours --');
    tool.activeGoal = {
        id: 'llm1', action: 'mine', params: { target: 'iron_ore' }, source: 'agent',
        startedAt: Date.now() - 15000, lastProgressAt: Date.now() - 1000, anchorAt: null
    };
    await adapter.takeTheWheel('mine', { target: 'gold_ore' }, { reason: 'changed my mind' });

    console.log('\n-- the world went away mid-goal --');
    tool.activeGoal = null;
    tool.emit('sessionEnded', { strandedTask: 'mining iron_ore', username: 'ada' });
    await sleep(400);

    console.log('\n=== done ===');
    console.log('every [speak/...] line came out of askYourBrain(). every [cue/...] line');
    console.log('did not, and never should. that difference is the whole file.');
}

if (process.argv[1] && process.argv[1].endsWith('05_vtuber_adapter.mjs')) {
    main()
        .then(() => tool.shutdown())
        .catch(async (err) => {
            console.error('fatal:', err);
            await tool.shutdown();
            process.exit(1);
        });
}
