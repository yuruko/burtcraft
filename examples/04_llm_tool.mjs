// 04 - the tool your model actually calls
//
// run it:   node examples/04_llm_tool.mjs
//
// exports a tool schema in both common dialects (anthropic and openai) plus one
// dispatcher that turns a validated tool call into a real action and returns a
// short string to hand back as the tool result.
//
// ---------------------------------------------------------------------------
// why one tool with an action enum, and not 37 tools
// ---------------------------------------------------------------------------
// every tool definition is tokens on every single request, forever. 37 separate
// tools is a large permanent tax and it scatters one coherent capability across
// a menu. one tool with an enum keeps the whole body in a couple hundred tokens
// and lets the model see all of its options in one place.
//
// the cost is that you validate the action yourself. that is a fine trade - you
// were going to validate it anyway.
//
// ---------------------------------------------------------------------------
// the nested `params` object is not decoration
// ---------------------------------------------------------------------------
// anthropic tool schemas, when strict validation is on, require EVERY declared
// property to appear in `required`. that makes genuinely optional arguments
// impossible to express at the top level - declare `amount` and the model is
// obliged to send one on every call, including `stop`.
//
// so the top level holds only what is always meaningful:
//
//   action  - required, enum
//   target  - the noun. "" when the action does not take one
//   params  - a free-form object, additionalProperties allowed, {} when empty
//
// every optional argument lives inside params. the model is describing the
// shape of one job, not filling in a form. the same schema is valid for openai,
// which is why the two exports below share their definitions.
//
// ---------------------------------------------------------------------------
// the results you return are prompt material
// ---------------------------------------------------------------------------
// keep them short, factual, and in the second person. "started mining
// diamond_ore" or "refused: busy with mining iron_ore". do not write them as
// dialogue - the moment a tool result contains a finished sentence in your
// character's voice, some percentage of the time the model will simply repeat
// it, and you have shipped a canned line.

import os from 'os';
import path from 'path';
import { MinecraftTool, MinecraftMemory } from '../core/index.js';

// ---------------------------------------------------------------------------
// the 43 actions, grouped by what they are for
// ---------------------------------------------------------------------------
export const MINECRAFT_ACTIONS = [
    // control plane - these never reach the game
    'enable', 'disable', 'status', 'autonomous',

    // resources. `get` is the workhorse: the mod solves prerequisites
    // recursively, so "get diamond_pickaxe" already knows to mine iron first.
    'get', 'mine', 'collect', 'craft',

    // movement and navigation
    'move', 'follow', 'explore', 'idle', 'boat', 'look',

    // combat and survival
    'attack', 'defend', 'hunt', 'eat', 'equip', 'cover_lava',

    // long-form play
    'speedrun', 'gamer', 'gamer_stop', 'stop',

    // storage and giving
    'deposit', 'stash', 'give',

    // reading the world
    'locate', 'inventory', 'coords',

    // talking in game
    'chat',

    // remembered places (these live in local memory, not the game)
    'favorite', 'unfavorite', 'favorites', 'set_home', 'go_home',

    // building
    'place',

    // settlements. the geometry and the build progress are surveyed from real
    // world blocks and kept in local memory, so these resume after a restart
    // instead of starting over.
    'set_outpost', 'outposts', 'go_outpost', 'build_outpost',
    'build_settlement', 'install_appliance'
];

// one line each. this is what the model reads to choose, so it is worth the
// tokens - but only the part that changes the choice.
const ACTION_NOTES = [
    'enable/disable: turn the bot on or off. status: connection + vitals, always safe to call.',
    'autonomous: params.on true/false - lets the bot pick its own goals while idle.',
    'get|mine|collect|craft: target = item or block, params.amount = how many. these all resolve prerequisites for you; prefer get.',
    'move: params.x/y/z, or target = the name of a saved spot. go_home walks to your set home.',
    'follow: target = an exact in-game username. explore: wander. idle: stand by. boat: params.exit true to get out.',
    'look: target = a player to face, or params.turn "around", or params.pitch in degrees.',
    'attack: target = a mob type, "nearest", or a username. defend: clear nearby hostiles. hunt: params.amount meat.',
    'eat: params.now true to eat immediately, otherwise it gathers up to params.amount food.',
    'equip: target = the item. cover_lava: params.method "sand" or blocks. locate: stronghold or desert_temple only.',
    'speedrun / gamer: run the full beat-the-game routine. gamer_stop or stop ends it.',
    'deposit: params.items to stash in a nearby chest. stash: params.start and params.end points. give: target = username, params.item + params.amount.',
    'inventory: target/params.item filters. coords: current position.',
    'chat: target = the message, sent to the minecraft server chat as the bot. compose it yourself, in your own words.',
    'favorite/unfavorite: target = a name for the spot you are standing on. favorites: list them. set_home: mark your base.',
    'place: target = a block you are carrying, put down where you stand.',
    'set_outpost: target = a name for the spot you are standing on, params.level 1 or more. outposts: list them. go_outpost / build_outpost: target = one of those names.',
    'build_settlement: params.role "homestead" or "outpost", plus the dimensions and anchor from getStatus().homeProject. install_appliance: target = the appliance, e.g. an oven.',
    'stop: abandon the current goal. always allowed, even while busy.'
].join(' ');

const TOOL_NAME = 'minecraft';
const TOOL_DESCRIPTION = [
    'Control your Minecraft body. One goal runs at a time - issuing a new goal while',
    'one is running will be refused, so stop first if you mean to change your mind.',
    'Long goals return as soon as the game accepts them, not when they finish.',
    ACTION_NOTES
].join(' ');

// shared property definitions, so the two dialects cannot drift apart
const PROPERTIES = {
    action: {
        type: 'string',
        enum: MINECRAFT_ACTIONS,
        description: 'What to do.'
    },
    target: {
        type: 'string',
        description: 'The noun for this action: an item, block, mob, player, structure, saved-spot name, or (for chat) the message itself. Empty string when the action takes no target.'
    },
    params: {
        type: 'object',
        description: 'Extra arguments for this action - amount, x/y/z, on, now, exit, turn, pitch, item, method, start, end, note, name. Empty object when there are none.',
        additionalProperties: true
    }
};

// ---------------------------------------------------------------------------
// anthropic dialect
// ---------------------------------------------------------------------------
export const anthropicMinecraftTool = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input_schema: {
        type: 'object',
        properties: PROPERTIES,
        // all three, on purpose. see the note at the top of the file: under
        // strict validation anthropic requires every declared property here,
        // which is exactly why the optional arguments live inside `params`.
        required: ['action', 'target', 'params']
    }
};

// ---------------------------------------------------------------------------
// openai dialect - same shape, different envelope
// ---------------------------------------------------------------------------
export const openaiMinecraftTool = {
    type: 'function',
    function: {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: PROPERTIES,
            required: ['action', 'target', 'params'],
            // openai strict mode additionally forbids extra top-level keys.
            // `params` keeps additionalProperties: true so the nested bag still
            // works; if you turn strict on, declare the params you use.
            additionalProperties: false
        },
        strict: false
    }
};

// ---------------------------------------------------------------------------
// the dispatcher
//
// three families of action, and it matters which is which:
//
//   local    - answered from memory or flags, never touches the game
//   memory   - saved places, handled inside executeAction or here
//   game     - relayed to the bridge, may take minutes
//
// if you only forwarded everything to executeAction, `status` and `favorites`
// would fail whenever the game was down - which is precisely when your vtuber
// most needs to be able to say what is going on.
// ---------------------------------------------------------------------------

// goals that can legitimately run for minutes or hours. resolve as soon as the
// game accepts them so your chat loop is never blocked; the tool keeps tracking
// them and emits actionComplete / actionFailed later (see 05).
const BACKGROUND_GOALS = new Set([
    'get', 'move', 'mine', 'collect', 'craft', 'follow', 'idle', 'attack',
    'defend', 'speedrun', 'explore', 'hunt', 'eat', 'equip', 'deposit',
    'stash', 'give', 'locate', 'cover_lava', 'go_home', 'place'
]);

export async function runMinecraftTool(args = {}, { tool, source = 'llm' } = {}) {
    const action = String(args.action || '').trim().toLowerCase();
    const target = String(args.target ?? '').trim();
    const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
        ? { ...args.params }
        : {};

    if (!MINECRAFT_ACTIONS.includes(action)) {
        return `unknown minecraft action "${action}". valid actions: ${MINECRAFT_ACTIONS.join(', ')}`;
    }

    try {
        // --- local: always answerable ------------------------------------
        if (action === 'status') return describeStatus(tool.getStatus());

        if (action === 'enable') { tool.enable(); return 'minecraft control enabled'; }
        if (action === 'disable') { tool.disable(); return 'minecraft control disabled'; }

        if (action === 'autonomous') {
            const on = typeof params.on === 'boolean' ? params.on : !['off', 'false', 'no'].includes(target.toLowerCase());
            tool.setAutonomousMode(on);
            return on
                ? 'self-play on - you will pick your own goals while idle, and chat can still re-task you'
                : 'self-play off - you only move when told';
        }

        // a disabled bot should say so once, clearly, instead of failing action
        // by action. gamer_stop and stop stay allowed because stopping is safe.
        if (!tool.enabled && !['stop', 'gamer_stop'].includes(action)) {
            return 'minecraft control is disabled - enable it first';
        }

        // --- local: reading state ----------------------------------------
        // the in-game commands for these print only into the minecraft client
        // log, so answering from synced state is both faster and more useful.
        //
        // BUT: gate them on actually being in a world first. with nothing
        // connected the synced state is the constructor default, and "you are
        // at 0, 0, 0 in overworld" is a confident lie your model will happily
        // build a whole bit on top of. the same trap as 03.
        if ((action === 'inventory' || action === 'coords') && !tool.gameConnected) {
            return 'you are not in a world right now, so there is no inventory or position to read';
        }

        if (action === 'inventory') {
            const inv = Array.isArray(tool.gameState.inventory) ? tool.gameState.inventory : [];
            const query = String(params.item || target || '').toLowerCase();
            const items = query ? inv.filter((e) => String(e).toLowerCase().includes(query)) : inv;
            if (!items.length) return query ? `no ${query} in your inventory` : 'inventory is empty or has not synced yet';
            return `inventory${query ? ` matching ${query}` : ''}: ${items.slice(0, 18).join(', ')}`;
        }

        if (action === 'coords') {
            const p = tool.gameState.position || {};
            return `you are at ${p.x ?? '?'}, ${p.y ?? '?'}, ${p.z ?? '?'} in ${tool.gameState.dimension || 'overworld'}`;
        }

        // --- memory: saved places ----------------------------------------
        if (action === 'favorite') {
            const name = target || String(params.name || '');
            if (!name) return 'favorite needs a name for this spot';
            const fav = tool.setFavoriteHere(name, params.note || null);
            return `saved this spot as "${fav.name}" (${fav.position.x},${fav.position.y},${fav.position.z})`;
        }
        if (action === 'unfavorite') {
            const name = target || String(params.name || '');
            if (!name) return 'unfavorite needs the spot name';
            return tool.memory.removeFavorite(name) ? `forgot the spot "${name}"` : `no saved spot named "${name}"`;
        }
        if (action === 'favorites') {
            const spots = tool.memory.favoritesContext(tool.gameState.position, tool.gameState.dimension, 24);
            return spots.length ? `saved spots: ${spots.join(' | ')}` : 'no spots saved yet - stand somewhere worth remembering and use favorite';
        }

        // --- game: the speedrun mode has its own lifecycle ----------------
        if (action === 'gamer') {
            const result = await tool.startGamerMode();
            return result?.alreadyRunning ? 'the speedrun is already running' : 'speedrun mode on - the mod is choosing the route now';
        }
        if (action === 'gamer_stop') {
            await tool.stopGamerMode();
            return 'speedrun mode off';
        }

        // --- game: everything else ---------------------------------------
        // `target` is folded into params because that is what the core reads.
        const actionParams = { ...params };
        if (target) actionParams.target = target;

        const result = await tool.executeAction(action, actionParams, {
            waitForCompletion: !BACKGROUND_GOALS.has(action),
            // the tag that keeps you and the autonomy loop from fighting.
            // see 05_vtuber_adapter.mjs.
            source
        });

        return summarize(action, target, params, result);
    } catch (err) {
        // a refusal is a fact about the world, and usually the most interesting
        // thing that has happened in the last minute. hand it back verbatim.
        return `refused: ${err.message}`;
    }
}

// short, factual, second person. never a finished line of dialogue.
function summarize(action, target, params, result) {
    switch (action) {
        case 'get': case 'mine': case 'collect': case 'craft':
            return `started working toward ${params.amount ? `${params.amount} ` : ''}${target || 'that'}`;
        case 'move': return `heading to ${target || `${params.x},${params.y},${params.z}`}`;
        case 'go_home': return 'heading home';
        case 'follow': return `following ${target}`;
        case 'explore': return 'wandering off to look around';
        case 'idle': return 'standing by';
        case 'attack': return `engaging ${target || 'nearby hostiles'}`;
        case 'defend': return 'clearing nearby hostiles';
        case 'hunt': return `hunting for ${params.amount || 5} meat`;
        case 'eat': return params.now ? 'eating now' : `gathering up to ${params.amount || 3} food`;
        case 'equip': return `equipping ${target}`;
        case 'deposit': return 'depositing into the nearby chest';
        case 'stash': return 'stashing between those points';
        case 'give': return `giving ${params.amount || 1} ${params.item || 'item'} to ${target}`;
        case 'locate': return `searching for the nearest ${target}`;
        case 'cover_lava': return 'covering the lava';
        case 'speedrun': return 'speedrun started';
        case 'stop': return 'stopped - nothing is running now';
        case 'chat': return 'said that in the server chat';
        case 'place': return `placed ${target || 'the block'} here`;
        case 'look': return 'turned to look';
        case 'boat': return params.exit ? 'got out of the boat' : 'got into the boat';
        case 'set_home': return `home is now "${result?.result?.home || target || 'home'}"`;
        default: return `did: ${action}`;
    }
}

// the status action is the one your model calls when it is confused about its
// own body. answer it honestly, especially when nothing is connected.
function describeStatus(s) {
    const st = s || {};
    if (st.fault) return `control link fault - ${st.fault.code}: ${st.fault.message}. no goals until it clears.`;
    if (!st.connected) return 'not connected: the bot bridge is not running, so there is no body to move';
    if (!st.gameConnected) {
        return st.companionSocketConnected
            ? 'minecraft is open but you are not in a world yet'
            : 'the bridge is up but minecraft is not running';
    }
    const g = st.gameState || {};
    const pos = g.position ? `${g.position.x},${g.position.y},${g.position.z}` : 'unknown';
    return `in the world as ${st.gameUsername || 'unknown'}, health ${g.health ?? '?'}/20, hunger ${g.hunger ?? '?'}/20, at ${pos}, ${st.currentTask ? `busy: ${st.currentTask}` : 'idle'}${st.autonomous ? ', self-play on' : ''}`;
}

// ---------------------------------------------------------------------------
// demo
// ---------------------------------------------------------------------------

const memory = new MinecraftMemory(
    path.join(os.tmpdir(), 'burtcraft-example-memory.json'),
    { registerExitHook: false }
);
// no initialize() here on purpose - the dispatcher must behave sanely with no
// socket at all, which is exactly what this demo shows.
const tool = new MinecraftTool({ memory, names: ['ada'] });

const DEMO_CALLS = [
    { action: 'status', target: '', params: {} },
    { action: 'enable', target: '', params: {} },
    { action: 'favorites', target: '', params: {} },
    { action: 'coords', target: '', params: {} },
    { action: 'get', target: 'diamond_pickaxe', params: { amount: 1 } },
    { action: 'chat', target: 'hello from the tool layer', params: {} },
    { action: 'teleport', target: 'spawn', params: {} }   // not a real action
];

async function main() {
    console.log('='.repeat(72));
    console.log('anthropic tool definition');
    console.log('='.repeat(72));
    console.log(JSON.stringify(anthropicMinecraftTool, null, 2));

    console.log(`\n${'='.repeat(72)}`);
    console.log('openai tool definition');
    console.log('='.repeat(72));
    console.log(JSON.stringify(openaiMinecraftTool, null, 2));

    console.log(`\n${'='.repeat(72)}`);
    console.log('dispatching, with nothing connected');
    console.log('='.repeat(72));
    for (const call of DEMO_CALLS) {
        const result = await runMinecraftTool(call, { tool, source: 'agent' });
        console.log(`\n  call   : ${JSON.stringify(call)}`);
        console.log(`  result : ${result}`);
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log('every one of those results is a sentence your model can reason about');
    console.log('and none of them is a sentence it should repeat word for word.');
    console.log(`${'='.repeat(72)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('04_llm_tool.mjs')) {
    main().catch((err) => {
        console.error('fatal:', err);
        process.exit(1);
    });
}
