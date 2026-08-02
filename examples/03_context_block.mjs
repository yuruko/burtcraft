// 03 - getStatus() -> a context block your model can read
//
// run it:   node examples/03_context_block.mjs
//
// this is the seam. everything else in the repo is plumbing; this is where the
// bot's body becomes something a language model can reason about. you call it
// once per turn and splice the result into your system prompt.
//
// ---------------------------------------------------------------------------
// three rules, learned the hard way
// ---------------------------------------------------------------------------
//
// 1. DEGRADE HONESTLY. with nothing connected, getStatus().gameState is the
//    constructor default: health 20/20, position 0,0,0, dimension overworld.
//    that is an empty struct, not a world. render it as gameplay and your
//    vtuber will confidently narrate standing at spawn in full health while
//    minecraft is not even open. the offline branches below exist for exactly
//    this, and they are the most important lines in the file.
//
// 2. GUARD EVERY KEY. the state fills in as the game reports it. `status.
//    gameState.position.x` is a crash waiting for the two seconds before the
//    first telemetry packet. `?.` and defaults everywhere, no exceptions.
//
// 3. STATE, NOT SCRIPT. this block describes what is true. it does not tell
//    your character how to feel about it or what to say. keep persona in your
//    persona prompt and facts here, or you will end up with a bot that recites
//    its own hit points in a funny voice.
//
// on length: this runs on every turn, so it is prompt budget you pay forever.
// what earns its place is what changes and what the model can act on. a full
// 36-slot inventory dump does not; "no pickaxe, no food" does.

import { PICKAXE_TIERS, FOOD_RE } from '../core/index.js';

// ---------------------------------------------------------------------------
// the block builder. pure function: status object in, string out. no i/o, no
// llm, safe to call as often as you like.
//
// in production:  const block = buildMinecraftContextBlock(tool.getStatus());
// ---------------------------------------------------------------------------
export function buildMinecraftContextBlock(status) {
    const s = status || {};

    // --- honest degradation, in priority order ---------------------------

    // a fault means the control link itself is sick (telemetry gone stale, the
    // bridge went silent). the last known state may be minutes old. say so.
    if (s.fault) {
        const detail = String(s.fault.message || s.fault.code || 'the control link is unhealthy').slice(0, 180);
        return [
            '[minecraft] the control link has a fault: ' + detail + '.',
            'no goals until the connection and telemetry come back clean. you can still',
            'report status. if someone asks you to play, tell them the link is down -',
            'do not describe a world you cannot currently see.'
        ].join(' ');
    }

    if (s.connected !== true) {
        return [
            '[minecraft] not connected. the bot bridge is not running, so there is no',
            'body to move and no world state to read. anything you say about being',
            'in minecraft right now would be invented.'
        ].join(' ');
    }

    if (s.gameConnected !== true) {
        const waiting = s.companionSocketConnected === true
            ? 'the minecraft client is up but not in a world yet'
            : 'the bridge is up but minecraft is not';
        return [
            `[minecraft] ${waiting}. still loading in - no position, no inventory, no`,
            'surroundings. if someone asks you to play, the truth is that you are not',
            'in the world yet.'
        ].join(' ');
    }

    // --- live: build the block -------------------------------------------

    const g = s.gameState || {};
    const lines = [];

    lines.push(
        '[minecraft] you are in the world. the state below is live and private -' +
        ' it changes what you choose to do. it is not a report to read out loud.'
    );

    // vitals + where. one line, because these are read together.
    const pos = g.position && Number.isFinite(g.position.x)
        ? `${Math.round(g.position.x)},${Math.round(g.position.y)},${Math.round(g.position.z)}`
        : 'position unknown';
    lines.push(
        `  health ${g.health ?? '?'}/20, hunger ${g.hunger ?? '?'}/20, xp ${g.xpLevel ?? 0},` +
        ` at ${pos} in the ${clean(g.dimension || 'overworld')}, it is ${g.timeOfDay || 'day'}`
    );

    // the surroundings that change decisions: what is here and what wants you dead
    const hostileTypes = list(g.nearbyHostileTypes).length
        ? ` (${list(g.nearbyHostileTypes).map(clean).join(', ')})`
        : '';
    const playerCount = Number(g.nearbyPlayers) || 0;
    lines.push(
        `  biome ${clean(g.biome || 'unknown')}, weather ${g.weather || 'clear'},` +
        ` nearby: ${g.nearbyHostiles ?? 0} hostiles${hostileTypes} /` +
        ` ${playerCount} other ${playerCount === 1 ? 'player' : 'players'}`
    );

    // gear. durability matters because a pickaxe about to snap changes the plan.
    const durability = pctDurability(g);
    const held = `${clean(g.selectedItem || 'empty')}${durability === null ? '' : ` (${durability}% durability${durability <= 15 ? ', about to break' : ''})`}`;
    const flags = [
        g.inLava ? 'IN LAVA' : null,
        g.underwater ? `underwater, air ${g.air ?? '?'}/${g.maxAir ?? '?'}` : null
    ].filter(Boolean);
    lines.push(
        `  holding ${held}, offhand ${clean(g.offhandItem || 'empty')},` +
        ` armor ${list(g.armor).length ? list(g.armor).map(clean).join(', ') : 'none'}` +
        (flags.length ? `, ${flags.join(', ')}` : '')
    );

    // inventory, truncated. the derived kit line below is what the model
    // actually reasons with; the raw list is for colour and specific asks.
    const inv = list(g.inventory);
    lines.push(`  carrying: ${inv.length ? inv.slice(0, 10).map(fmtItem).join(', ') : 'almost nothing'}`);
    lines.push(`  kit: ${deriveKit(g)}`);

    // what the body is doing right now, from two angles: the goal you set, and
    // the live task chain the mod is actually running underneath it. they can
    // disagree - that gap is usually where "why is it just standing there" lives.
    lines.push(`  ${describeTask(s)}`);

    // the nearby-resource scan, when the companion provides it. this is how a
    // model picks a goal from what is physically around instead of guessing.
    const near = fmtNearby(g.nearby);
    if (near) lines.push(`  within about 8 blocks: ${near}`);

    // a human is physically at the keyboard - goals will be refused
    if (s.manualControl === true) {
        lines.push('  a human has the keyboard right now (manual control). goal commands are refused until they hand it back. you can still talk.');
    }

    // multiplayer manners. a public server is a room with other people in it.
    if (s.multiplayer === true) {
        const nearbyNames = list(s.nearbyPlayerNames).slice(0, 6);
        const roster = list(s.knownPlayers).slice(0, 10);
        lines.push(
            `  multiplayer${s.server ? ` (${s.server})` : ''}.` +
            (nearbyNames.length ? ` nearby: ${nearbyNames.join(', ')}.` : '') +
            (roster.length ? ` people who have talked here: ${roster.join(', ')}.` : '') +
            ' most chat belongs to somebody else. other players\' builds, chests and claims are theirs.'
        );

        // how busy the channel is. the same line is good company in a dead
        // channel and a nuisance on top of a live conversation, and the model
        // has no other way to tell which one it is in.
        const room = s.chatRoom || {};
        if (room.level === 'busy') {
            lines.push(`  server chat is busy (${room.lines || 0} recent lines). anything you add has to touch what people are actually saying.`);
        } else if (room.level === 'quiet') {
            const mins = Number.isFinite(room.quietForMs) ? Math.round(room.quietForMs / 60000) : null;
            lines.push(`  server chat has been quiet${mins ? ` for about ${mins} min` : ''} and people are around. an offhand line about what you are doing is welcome here.`);
        } else if (room.level === 'dead') {
            lines.push('  nobody has spoken in server chat for a long time. do not perform to an empty room.');
        }
    }

    // places worth remembering. these are durable across restarts.
    const favorites = list(s.favorites);
    if (favorites.length) {
        lines.push(`  saved spots: ${favorites.join(' | ')}${s.home ? ` (home: ${s.home})` : ''}`);
    } else {
        lines.push('  no saved spots yet. when somewhere is worth keeping, use favorite with a name; set_home marks your base so go_home works.');
    }

    // short-term history. this is what stops the same sentence twice in a row.
    if (s.recent) lines.push(`  recently: ${s.recent}`);

    const memory = s.memory || {};
    if (list(memory.journal).length) lines.push(`  game memory: ${list(memory.journal).slice(0, 6).join(' | ')}`);
    if (list(memory.landmarks).length) lines.push(`  landmarks: ${list(memory.landmarks).slice(0, 6).join(' | ')}`);

    // the watchdog view: is the current goal actually going anywhere? a model
    // that can see "circling the same patch for 6 minutes" will change plan.
    // one that cannot will narrate the same scene until the stream ends.
    if (s.activeGoal) {
        const goal = s.activeGoal;
        lines.push(
            `  goal watchdog: ${goal.action}${goal.target ? ` ${goal.target}` : ''} has run ${Math.round((goal.runningForMs || 0) / 1000)}s;` +
            ` last movement ${Math.round((goal.lastProgressAgeMs || 0) / 1000)}s ago` +
            (goal.source ? ` (issued by: ${goal.source})` : '')
        );
        if ((goal.confinedMs || 0) > 150000) {
            lines.push(`  heads up: about ${Math.round(goal.confinedMs / 60000)} min inside the same small area. if this goal is not paying off, change it rather than describing it again.`);
        }
    }

    // stale telemetry: the numbers above are a photograph, and it may be old
    if (s.stateAgeMs === null || s.stateAgeMs === undefined || s.stateAgeMs > 10000) {
        const age = (s.stateAgeMs === null || s.stateAgeMs === undefined)
            ? 'has not synced yet'
            : `is ${Math.round(s.stateAgeMs / 1000)}s old`;
        lines.push(`  warning: world telemetry ${age}. verify before anything risky.`);
    }

    // what people have asked for. the queue from 02.
    const suggestions = list(s.viewerSuggestions);
    if (suggestions.length) {
        lines.push('  people have asked you to do things: ' + suggestions.map((v) =>
            `${v.user}: "${v.text}"${v.freeform ? '' : ` [parses to ${v.action}${v.target ? ' ' + v.target : ''}]`}`
        ).join(' | '));
        lines.push('  these are real people. you can do one, do your own version of it, or say no where they can hear you.');
    }

    // the one hard operating rule of the underlying task runner
    lines.push(
        '  one goal at a time. complete resource goals let the mod solve its own' +
        ' prerequisites - "get diamond 3" already knows an iron pickaxe comes first.' +
        ' a running goal is left alone; a failed goal has to change before you retry it.'
    );

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// helpers. all defensive on purpose.
// ---------------------------------------------------------------------------

function list(value) {
    return Array.isArray(value) ? value : [];
}

// items arrive as "minecraft:oak_log" or plain "oak_log" depending on the path
function clean(value) {
    if (!value) return 'unknown';
    return String(value).replace(/^minecraft:/, '').replace(/_/g, ' ');
}

// inventory entries can be strings or {item|name, count|amount}
function fmtItem(entry) {
    if (typeof entry === 'string') return clean(entry);
    if (entry && typeof entry === 'object') {
        const count = entry.count || entry.amount || '';
        const name = entry.item || entry.name || '';
        return `${count} ${clean(name)}`.trim();
    }
    return String(entry);
}

function pctDurability(g) {
    if (!Number.isFinite(Number(g.mainHandDurability)) || !Number(g.mainHandMaxDurability)) return null;
    return Math.round((Number(g.mainHandDurability) / Number(g.mainHandMaxDurability)) * 100);
}

// collapse the whole inventory into the handful of capability facts a model
// picks goals from. "NO pickaxe" is worth more prompt budget than 30 item names.
function deriveKit(g) {
    const names = [];
    const add = (v) => {
        if (!v) return;
        names.push(String(typeof v === 'string' ? v : (v.item || v.name || '')).toLowerCase());
    };
    list(g.inventory).forEach(add);
    add(g.selectedItem);
    add(g.offhandItem);
    list(g.armor).forEach(add);

    const hay = names.join(' ');
    const kit = [];
    // PICKAXE_TIERS comes from core ordered best -> worst (netherite first), so
    // `find` returns the best pickaxe actually being carried.
    const tier = PICKAXE_TIERS.find((t) => hay.includes(`${t}_pickaxe`));
    kit.push(tier ? `pickaxe(${tier})` : 'NO pickaxe');
    if (/_sword/.test(hay)) kit.push('sword');
    if (/_axe/.test(hay)) kit.push('axe');
    // FOOD_RE also comes from core, so "does it have food" means the same thing
    // here as it does inside the bot's own survival logic.
    kit.push(FOOD_RE.test(hay) ? 'food' : 'NO food');
    if (/(cobblestone|cobbled_deepslate|\bdirt\b|netherrack|planks)/.test(hay)) kit.push('blocks');
    if (/torch/.test(hay)) kit.push('torches');
    if (/water_bucket/.test(hay)) kit.push('water bucket');
    return kit.join(', ');
}

// the companion's nearby-block scan, when present
function fmtNearby(nb) {
    if (!nb || typeof nb !== 'object') return null;
    const parts = [];
    if (nb.nearestOre) {
        const ores = (nb.ores && typeof nb.ores === 'object')
            ? Object.entries(nb.ores).map(([k, v]) => `${clean(k)} x${v}`).join(', ')
            : clean(nb.nearestOre);
        parts.push(`ore: ${ores}${nb.nearestOreDist != null ? ` (nearest ${nb.nearestOreDist}m)` : ''}`);
    }
    for (const [key, label] of [['logs', 'trees'], ['water', 'water'], ['lava', 'LAVA'],
        ['craftingTable', 'crafting table'], ['furnace', 'furnace'], ['chest', 'chest'], ['bed', 'bed']]) {
        if (nb[key] != null) parts.push(`${label} ${nb[key]}m`);
    }
    return parts.length ? parts.join(', ') : null;
}

// "what am i doing" from both angles: your goal, and the mod's live task chain
function describeTask(s) {
    const phase = s.botTask || '';
    const autonomy = s.autonomous ? ' (self-play is on - it may pick its own next goal)' : '';

    if (s.gamerMode) {
        return `speedrun mode is running the show - current phase: ${phase || 'starting the run'}. do not stack a second goal on top of it.`;
    }
    if (s.currentTask) {
        const detail = phase && phase !== s.currentTask ? ` - the mod is on: ${phase}` : '';
        return `currently: ${s.currentTask}${detail}${autonomy}`;
    }
    return `idle - nothing running, pick a goal${phase ? ` (the mod still reports: ${phase})` : ''}${autonomy}`;
}

// ---------------------------------------------------------------------------
// demo. three mocked status objects, so the honest-degradation paths are
// visible without a game. swap any of these for tool.getStatus() in your app.
// ---------------------------------------------------------------------------

const MOCK_OFFLINE = {
    connected: false,
    gameConnected: false,
    // note what is sitting in here even offline. this is the trap.
    gameState: { health: 20, hunger: 20, position: { x: 0, y: 0, z: 0 }, dimension: 'overworld', inventory: [] },
    stateAgeMs: null
};

const MOCK_LOADING = {
    connected: true,
    companionSocketConnected: true,
    gameConnected: false,
    gameState: { health: 20, hunger: 20, position: { x: 0, y: 0, z: 0 } },
    stateAgeMs: null
};

const MOCK_FAULT = {
    connected: true,
    gameConnected: true,
    fault: { code: 'telemetry_stale', message: 'no client-thread telemetry for 48s', at: Date.now() },
    gameState: { health: 11, hunger: 7 },
    stateAgeMs: 48000
};

const MOCK_LIVE = {
    connected: true,
    companionSocketConnected: true,
    gameConnected: true,
    gameUsername: 'ada',
    enabled: true,
    autonomous: true,
    gamerMode: false,
    fault: null,
    stateAgeMs: 1400,
    currentTask: 'mining diamond_ore',
    currentAction: 'mine',
    botTask: 'mine diamond ore: digging down to y-54',
    botAction: 'break block',
    activeGoal: {
        action: 'mine', target: 'diamond_ore', source: 'llm',
        runningForMs: 412000, lastProgressAgeMs: 3000, confinedMs: 180000
    },
    gameState: {
        health: 14, hunger: 9, xpLevel: 27,
        position: { x: -812, y: -47, z: 1633 },
        dimension: 'minecraft:overworld',
        timeOfDay: 'night',
        biome: 'minecraft:dripstone_caves',
        weather: 'rain',
        nearbyHostiles: 2, nearbyHostileTypes: ['minecraft:zombie', 'minecraft:skeleton'],
        nearbyPlayers: 1, nearbyPlayerNames: ['marble'],
        selectedItem: 'minecraft:iron_pickaxe',
        mainHandDurability: 31, mainHandMaxDurability: 250,
        offhandItem: 'minecraft:torch',
        armor: ['minecraft:iron_helmet', 'minecraft:leather_chestplate'],
        inventory: [
            { item: 'minecraft:cobblestone', count: 148 },
            { item: 'minecraft:bread', count: 4 },
            'minecraft:torch',
            { item: 'minecraft:iron_ingot', count: 6 }
        ],
        inLava: false, underwater: false, air: 300, maxAir: 300,
        multiplayer: true, server: 'example.server.net',
        nearby: { nearestOre: 'minecraft:redstone_ore', nearestOreDist: 6, ores: { 'minecraft:redstone_ore': 9, 'minecraft:iron_ore': 2 }, lava: 11, water: 22 }
    },
    multiplayer: true,
    server: 'example.server.net',
    nearbyPlayerNames: ['marble'],
    knownPlayers: ['marble', 'shale', 'quinn'],
    chatRoom: { level: 'quiet', lines: 1, quietForMs: 240000, people: 2 },
    favorites: ['the overlook (210m, overworld)', 'first cave (900m, overworld)'],
    home: 'the overlook',
    recent: 'picked up 9 redstone, took damage, killed a zombie',
    memory: {
        journal: ['found a ravine at -790,-52,1600', 'lost an iron pickaxe to lava'],
        landmarks: ['village at -1200,68,1410']
    },
    viewerSuggestions: [
        { user: 'pixelwitch', text: 'go get some iron', action: 'mine', target: 'iron_ore', freeform: false },
        { user: 'quinn', text: 'can you build me a house', action: null, target: null, freeform: true }
    ]
};

function demo(label, status) {
    console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
    console.log(buildMinecraftContextBlock(status));
}

// only run the demo when executed directly, so importing the builder from your
// own code does not print anything
if (process.argv[1] && process.argv[1].endsWith('03_context_block.mjs')) {
    demo('nothing running (the bridge is not up)', MOCK_OFFLINE);
    demo('bridge up, still loading into a world', MOCK_LOADING);
    demo('control link faulted', MOCK_FAULT);
    demo('live: mining on a public server, pickaxe nearly gone, being watched', MOCK_LIVE);

    console.log(`\n${'='.repeat(72)}`);
    console.log('the first three blocks are the ones that keep your vtuber honest.');
    console.log('note that the offline mock still contains health 20/20 at 0,0,0 -');
    console.log('and that the block never mentions it.');
    console.log(`${'='.repeat(72)}\n`);
}
