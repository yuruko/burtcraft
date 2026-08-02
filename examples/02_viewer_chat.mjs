// 02 - chat drives the bot
//
// run it:   node examples/02_viewer_chat.mjs
//
// this file never opens a socket and never needs a game. it feeds a scripted
// list of chat lines through the same three calls a live integration uses, and
// prints what the core decided at each step.
//
// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------
//   inbound line
//     -> shouldSurfaceChat(sender, text)     is this even for me?   (in-game only)
//     -> interpretChatCommand(text, sender)  does it name an action?
//     -> executeAction(...)   OR   recordViewerSuggestion(...)
//
// the split at the bottom is the important part:
//
//   executeAction         = do it now. authority. use this for lines you
//                           actually trust (your operator, an explicit tool
//                           call from your model).
//   recordViewerSuggestion = put it on a short queue that your model sees in
//                           its context. the model can take it, adapt it, or
//                           say no on stream. a stranger typing a sentence is
//                           a request, not a command.
//
// ---------------------------------------------------------------------------
// two chat sources, and the mistake everyone makes
// ---------------------------------------------------------------------------
// minecraft server chat gives you a REAL in-game username. stream chat (twitch,
// youtube, discord) gives you a handle that is not a player and must never be
// used as one. that is why interpretChatCommand takes `inGameSender` as a
// separate argument: pass it for server chat, leave it null for stream chat.
// get this wrong and "follow me" from a twitch viewer turns into the bot
// chasing a player who does not exist.

import os from 'os';
import path from 'path';
import { MinecraftTool, MinecraftMemory } from '../core/index.js';

const memory = new MinecraftMemory(
    path.join(os.tmpdir(), 'burtcraft-example-memory.json'),
    { registerExitHook: false }
);

const tool = new MinecraftTool({
    memory,
    // every name here counts as "someone is talking to me". keep it short and
    // distinctive - a two-letter name will match half the room.
    names: ['ada', 'ada bot']
});

// ---------------------------------------------------------------------------
// pretend we are on a public server. in a real run the in-game companion
// reports all of this; we set it by hand so the multiplayer manners are
// visible without a game attached.
//
// this matters: in SINGLEPLAYER the core surfaces every line (there is nobody
// else to confuse you with). the "is this for me" filtering below only exists
// because a public server is a room, not a dm.
// ---------------------------------------------------------------------------
tool.gameState.multiplayer = true;
tool.gameState.server = 'example.server.net';
tool.gameUsername = 'ada';

// recordViewerSuggestion emits this. wire it to your overlay so people can see
// their request landed even when the bot chooses not to do it.
tool.on('viewerSuggestion', (entry) => {
    console.log(`      [event viewerSuggestion] ${entry.user}: "${entry.text}" -> ${entry.freeform ? 'freeform (your model decides)' : `${entry.action}${entry.target ? ' ' + entry.target : ''}`}`);
});

// ---------------------------------------------------------------------------
// the scripted room. `where: 'game'` = minecraft server chat (sender is a real
// username). `where: 'stream'` = twitch/youtube/etc (sender is a handle).
// ---------------------------------------------------------------------------
const INBOUND = [
    { where: 'game', from: 'marble', text: 'ada can you mine some diamonds',
      why: 'named her + a verb she has a tool for -> a real action' },

    { where: 'game', from: 'shale', text: 'hey marble did you find the village',
      why: 'greeting aimed at another player -> she stays out of it entirely' },

    { where: 'game', from: 'ada', text: 'on my way',
      why: 'her own line coming back from the server -> never react to yourself' },

    { where: 'game', from: 'quinn', text: '/tpa marble',
      why: 'slash/bang/dot prefixes are command noise, not conversation' },

    { where: 'game', from: 'quinn', text: 'ada can you build me a house',
      why: 'named her, but no built-in verb fits -> goes to the queue as freeform' },

    { where: 'stream', from: 'pixelwitch', text: 'go get some iron',
      why: 'stream chat with a clean verb -> a parsed suggestion' },

    { where: 'stream', from: 'gremlin_99', text: 'kill that zombie',
      why: 'parses to attack - and attack is refused from chat on purpose' },

    { where: 'stream', from: 'lurker7', text: 'follow me pls',
      why: '"me" is a twitch handle, not a player -> no target, still a request' }
];

async function main() {
    console.log('=== chat -> bot ===');
    console.log(`bot answers to: ada, ada bot   (playing as "${tool.gameUsername}" on a multiplayer server)`);
    console.log(`MINECRAFT_OWNER env: ${process.env.MINECRAFT_OWNER || '(unset)'}  <- when set, that name always gets through and "me" resolves to it\n`);

    for (const line of INBOUND) {
        console.log(`[${line.where}] ${line.from}: "${line.text}"`);
        console.log(`   note: ${line.why}`);

        if (line.where === 'game') {
            await handleGameChat(line.from, line.text);
        } else {
            await handleStreamChat(line.from, line.text);
        }
        console.log('');
    }

    // this short list is what you splice into your model's context every turn.
    // it self-expires after 10 minutes and keeps only the last few, so it can
    // never grow into a backlog the bot feels obligated to work through.
    const queued = tool.getViewerSuggestions();
    console.log('=== what the model would see in its context ===');
    if (!queued.length) {
        console.log('  (nothing queued)');
    } else {
        for (const s of queued) {
            const mapped = s.freeform ? 'no built-in verb - your model picks the tool call, or declines'
                : `maps to: ${s.action}${s.target ? ' ' + s.target : ''}`;
            console.log(`  ${s.user}: "${s.text}"  [${mapped}]`);
        }
    }
    console.log('\nthese came from real people. the right answer is sometimes no,');
    console.log('said out loud, in your vtuber\'s own words - not silence.');
}

// ---------------------------------------------------------------------------
// server chat: filter first, then interpret
// ---------------------------------------------------------------------------
async function handleGameChat(sender, text) {
    // shouldSurfaceChat answers "should my brain even see this line". it drops
    // your own echo, command noise, lines aimed at other players, and it paces
    // per sender (about 8s) so one person cannot flood you. ambient chatter is
    // sampled rather than always surfaced - so a line with nobody's name in it
    // legitimately gives a different answer on different runs. that is a
    // feature, not flakiness: a bot that replies to every line is a bot.
    const gate = tool.shouldSurfaceChat(sender, text);

    if (!gate.surface) {
        console.log('   -> filtered out. your model never sees this line.');
        return;
    }

    const who = gate.owner ? 'the owner' : gate.addressed ? 'addressed to her' : 'overheard';
    const aside = gate.toSomeoneElse ? ` (this was meant for ${gate.toSomeoneElse} - do not answer on their behalf)` : '';
    console.log(`   -> surfaced (${who})${aside}`);

    // in-game sender IS a minecraft username, so pass it. "follow me" can now
    // resolve to a real player.
    const command = tool.interpretChatCommand(text, sender);

    if (command) {
        console.log(`   -> parsed: ${describe(command)}`);
        // a line from a player standing next to you is still not a blank
        // cheque. this example executes it to show the call; a production app
        // should decide per-sender whether server chat gets authority or only
        // gets to make a suggestion.
        await runIt(command, 'viewer');
    } else {
        console.log('   -> no built-in verb matched');
        record(sender, text, { inGame: true });
    }
}

// ---------------------------------------------------------------------------
// stream chat: no gate (your platform client already did that), never trust the
// name as a player
// ---------------------------------------------------------------------------
async function handleStreamChat(user, text) {
    // inGame: false is the whole point. it stops a twitch handle from becoming
    // a follow/give/look target.
    record(user, text, { inGame: false });
}

function record(user, text, opts) {
    const entry = tool.recordViewerSuggestion(user, text, opts);
    if (!entry) {
        // three different reasons return null, all of them deliberate:
        //  - it parsed to something chat is not allowed to trigger
        //    (stop, attack, give, chat, set_home)
        //  - it does not read like a request at all
        //  - that user is inside their ~10s cooldown
        console.log('   -> not queued (blocked verb, not a request, or user on cooldown)');
        return;
    }
    console.log(`   -> queued as a suggestion${entry.freeform ? ' (freeform)' : ''}`);
}

// ---------------------------------------------------------------------------
// executing. note the source tag.
// ---------------------------------------------------------------------------
async function runIt(command, source) {
    // the params shape: `target` is the noun, everything else rides in params.
    const params = { ...(command.params || {}) };
    if (command.target) params.target = command.target;

    try {
        const result = await tool.executeAction(command.action, params, {
            // long goals should not block your chat loop. false = resolve as
            // soon as the game accepts the job; the tool keeps tracking it and
            // will emit actionComplete/actionFailed later.
            waitForCompletion: false,
            // 'llm' | 'viewer' | 'autonomy' - your tags, applied consistently.
            // the core's own drives tag themselves 'autonomous' plus a family of
            // internal ones ('safety', 'water-escape', 'protection', 'recovery').
            // anything you did not set is the bot acting on its own.
            source
        });
        console.log('   -> executed:', result);
    } catch (err) {
        // refusals are informative, not failures to hide. "busy with X" means
        // something else owns the bot right now - which is exactly the peer
        // arbitration problem 05_vtuber_adapter.mjs deals with.
        console.log(`   -> refused: ${err.message}`);
    }
}

function describe(command) {
    const bits = [command.action];
    if (command.target) bits.push(command.target);
    const params = command.params || {};
    const extra = Object.keys(params).filter((k) => k !== 'target');
    if (extra.length) bits.push(`(${extra.map((k) => `${k}=${params[k]}`).join(', ')})`);
    return bits.join(' ');
}

main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
});
