// 01 - hello bot
//
// the smallest thing that is still real: construct the tool, open the socket
// the bridge dials into, wait, print what is actually true, try one action.
//
// run it:   node examples/01_hello_bot.mjs        (ctrl-c to quit)
//
// ---------------------------------------------------------------------------
// READ THIS FIRST: nothing happens until three processes exist
// ---------------------------------------------------------------------------
// the topology is inverted from what most people expect. YOUR node process is
// the websocket SERVER. the bridge is the CLIENT that dials in.
//
//   your vtuber app (this file)
//      MinecraftTool           ws server, port 7431   <- you are here
//         ^
//         | ws (bridge dials in)
//      bridge/minecraft_bot_bridge.js                 <- separate process
//         ^
//         | tcp 7440
//      altoclef external control server (in game)     <- fabric mod, in minecraft
//         ^
//      baritone -> the actual world
//
// that ordering is deliberate: your app is the always-on side, so the bridge
// can reconnect to it every time minecraft relaunches. it also means running
// this file alone is completely valid and completely inert - the server comes
// up, nothing connects, and every action honestly refuses. that is the point of
// this example. if you see "bridge never connected" below, you did it right;
// go start the bridge and minecraft and run it again.
//
// two different booleans, do not conflate them:
//   connected      = the bridge process is on the socket
//   gameConnected  = that bridge also has its in-game companion link AND the
//                    player is actually in a world
// you can be `connected: true, gameConnected: false` for minutes while the game
// loads a world. an app that only checks `connected` will happily narrate
// gameplay that is not happening.

import net from 'net';
import os from 'os';
import path from 'path';
import { MinecraftTool, MinecraftMemory } from '../core/index.js';

// port 7431 is the bridge's default. override with MINECRAFT_BRIDGE_PORT - on
// BOTH sides, or they will not find each other.
const PORT = Number(process.env.MINECRAFT_BRIDGE_PORT || 7431);

// how long to sit here waiting for a bridge before we stop being hopeful
const WAIT_FOR_BRIDGE_MS = 8000;

// set BURTCRAFT_DEMO_MS=12000 to make the example exit on its own instead of
// waiting for ctrl-c. handy in ci, or when you just want to see it run.
const DEMO_MS = Number(process.env.BURTCRAFT_DEMO_MS || 0);

// gameplay memory (places, journal, failure counts) persists to
// ./data/minecraft_memory.json by default. an example should not leave litter
// in your repo, so we point it at a temp file and skip the exit hook. in a real
// app just omit `memory` and let it use the default.
const memory = new MinecraftMemory(
    path.join(os.tmpdir(), 'burtcraft-example-memory.json'),
    { registerExitHook: false }
);

const tool = new MinecraftTool({
    memory,
    // names the bot answers to in multiplayer chat. "hey ada, come here" is for
    // her; "hey marble, come here" is not. see 02_viewer_chat.mjs.
    names: ['ada', 'ada bot'],
    // optional sink for internal commentary cues. these are NOT lines to speak
    // or post - see 05_vtuber_adapter.mjs for what to do with them.
    broadcast: (entry) => console.log(`  [cue/${entry.kind}] ${entry.text}`)
});

// ---------------------------------------------------------------------------
// subscribe BEFORE initialize, or you will miss the connect that happens in the
// same tick as the bridge dialling in
// ---------------------------------------------------------------------------
tool.on('connected', () => {
    console.log('[event] bridge connected to our socket');
});

tool.on('gameConnection', ({ connected, username }) => {
    console.log(`[event] in-game companion ${connected ? 'ready' : 'gone'}${username ? ` (playing as ${username})` : ''}`);
});

tool.on('disconnected', () => {
    console.log('[event] bridge dropped off - any in-flight action just failed');
});

// a fault means the control link is unhealthy (telemetry gone stale, bridge
// silent). treat it as "my hands are not attached right now", never as an
// excuse to keep narrating from the last known state.
tool.on('faultDetected', (fault) => console.log(`[event] fault: ${fault.code} - ${fault.message}`));
tool.on('faultCleared', () => console.log('[event] fault cleared'));

// ---------------------------------------------------------------------------
// look before you bind
//
// if the port is already taken, initialize() does something helpful and
// slightly alarming: it finds the process listening there and, if it is a node
// process, stops it and binds anyway. that is correct after a crash left a
// zombie holding the socket. it is very much not correct when the owner is your
// production bot, quietly working, and you just ran an example.
//
// so: probe first, refuse if busy. one owner per port.
// ---------------------------------------------------------------------------
function portIsFree(port) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port, '127.0.0.1');
    });
}

async function main() {
    if (!(await portIsFree(PORT))) {
        console.log(`port ${PORT} is already in use - something else owns this bot.`);
        console.log('not starting. if that is a stale process, stop it; if it is your real');
        console.log(`bot, leave it alone and run this on a spare port instead:\n`);
        console.log(`    MINECRAFT_BRIDGE_PORT=7531 node examples/01_hello_bot.mjs\n`);
        console.log('(the bridge needs the same value, or it will keep dialling 7431.)');
        return;
    }

    // starts the ws server and the autonomy timer. idempotent - calling it
    // twice is safe. it does NOT enable the bot; see enable() below.
    await tool.initialize({
        port: PORT,
        actionTimeout: 90000,     // how long to wait for a final response
        autonomousTickMs: 25000,  // how often the idle brain considers acting
        debug: false              // true = very chatty protocol logging
    });
    console.log(`listening for the bridge on ws://127.0.0.1:${PORT}`);
    console.log('(loopback only, on purpose - this is an unauthenticated game-control plane)');

    // two independent gates, both off after construction:
    //   enable()             - the tool will accept actions at all
    //   setAutonomousMode()  - the bot picks its own goals when idle
    // leave autonomy off while you are learning. it competes with your llm for
    // one bot, and that arbitration is the whole subject of 05.
    tool.enable();
    tool.setAutonomousMode(false);
    console.log('tool enabled, autonomy off');

    console.log(`\nwaiting up to ${WAIT_FOR_BRIDGE_MS / 1000}s for a bridge...`);
    const arrived = await waitForBridge(WAIT_FOR_BRIDGE_MS);
    console.log(arrived ? 'bridge is here.' : 'bridge never connected (expected, if you have not started one).');

    printStatus();
    await tryOneAction();

    if (DEMO_MS > 0) {
        console.log(`\nBURTCRAFT_DEMO_MS set - exiting in ${DEMO_MS}ms`);
        setTimeout(() => stop('demo timer'), DEMO_MS);
    } else {
        console.log('\nstill listening. ctrl-c to quit.');
    }
}

// resolve as soon as the bridge shows up, or when the clock runs out. we listen
// for the event AND check the flag, because the bridge may already be connected
// if you called initialize() earlier in your app's life.
function waitForBridge(ms) {
    if (tool.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (value) => {
            clearTimeout(timer);
            tool.off('connected', onConnected);
            resolve(value);
        };
        const onConnected = () => done(true);
        const timer = setTimeout(() => done(false), ms);
        tool.once('connected', onConnected);
    });
}

// getStatus() is your single source of truth about the body. it is a plain
// object, cheap, and safe to call every turn. treat every nested key as
// optional - the shape fills in as the world reports things.
function printStatus() {
    const s = tool.getStatus() || {};
    const g = s.gameState || {};
    const pos = g.position ? `${g.position.x},${g.position.y},${g.position.z}` : 'unknown';

    console.log('\n--- status ---');
    console.log(`  bridge connected : ${s.connected === true}`);
    console.log(`  in a world       : ${s.gameConnected === true}`);
    console.log(`  playing as       : ${s.gameUsername || '(nobody yet)'}`);
    console.log(`  enabled          : ${s.enabled === true}`);
    console.log(`  autonomy         : ${s.autonomous === true}`);
    console.log(`  gamer mode       : ${s.gamerMode === true}`);
    console.log(`  fault            : ${s.fault ? `${s.fault.code}: ${s.fault.message}` : 'none'}`);
    console.log(`  telemetry age    : ${s.stateAgeMs === null || s.stateAgeMs === undefined ? 'never synced' : `${s.stateAgeMs}ms`}`);
    console.log(`  current task     : ${s.currentTask || s.currentAction || 'idle'}`);
    console.log(`  position         : ${pos}`);
    console.log(`  health / hunger  : ${g.health ?? '?'} / ${g.hunger ?? '?'}`);
    console.log(`  recently         : ${s.recent || '(nothing yet)'}`);
    console.log('--------------');

    // the honesty rule, stated once so it lands: with nothing connected the
    // game state is the constructor default. health 20/20 at 0,0,0 is not a
    // fact about a world, it is an empty struct. never feed it to your model as
    // gameplay. 03_context_block.mjs shows how to degrade this honestly.
}

// every action goes through the same call. it resolves when the bot reports the
// job done and rejects with a real reason otherwise - "not connected", "busy
// with X", "telemetry is stale", "manual control is on". those rejections are
// useful narration material; do not swallow them.
async function tryOneAction() {
    console.log('\nsending one action (coords)...');
    try {
        const result = await tool.executeAction('coords', {}, {
            waitForCompletion: true,
            priority: 'normal',
            // ALWAYS tag the source. the autonomy loop and your llm are peers
            // competing for one bot; this is how you tell later who asked.
            source: 'llm'
        });
        console.log('  action result:', result);
    } catch (err) {
        console.log(`  action refused: ${err.message}`);
        console.log('  ^ this is the correct answer with no game attached. it is not an error to hide,');
        console.log('    it is the sentence your vtuber should be able to say out loud.');
    }
}

// clean exit. shutdown() clears the autonomy timer, fails every pending action
// so nothing hangs, closes the socket, and flushes memory.
let stopping = false;
async function stop(why) {
    if (stopping) return;
    stopping = true;
    console.log(`\nshutting down (${why})...`);
    try {
        await tool.shutdown();
    } catch (err) {
        console.log(`  shutdown complained: ${err.message}`);
    }
    console.log('done.');
    process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

main().catch(async (err) => {
    console.error('fatal:', err.message);
    await stop('startup failure');
    process.exit(1);
});
