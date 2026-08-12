// minecraft_bot_bridge.js
// the relay between burnt and the minecraft bot (altoclef/baritone).
//
// this process sits between two endpoints and translates between them:
//
//   burnt node server                          minecraft (fabric client)
//   +-------------------+   ws :7431    +------------+   tcp :7440  +---------------------+
//   | minecraft_tool.js | <===========> |   BRIDGE   | <==========> | altoclef external   |
//   | (ws SERVER)       |  actions/     | (this file)|  @commands / | control companion   |
//   |                   |  state/events |            |  events      | (ExternalControl-   |
//   +-------------------+               +------------+              |  Server.java)       |
//                                                                   +---------------------+
//
// left link  (ws client -> burnt's minecraftTool server on 7431):
//   receives {type:'action', action, params, id, priority}
//   sends    {type:'response'|'state'|'event'|'heartbeat', ...}
//
// right link (tcp client -> altoclef companion server on 7440):
//   sends    {type:'command', id, command}  (altoclef command WITHOUT the '@')
//            {type:'chat', text}             (raw line, e.g. baritone '#explore')
//   receives {type:'hello'|'ack'|'finished'|'error'|'event'|'state', ...}
//
// IMPORTANT: the old version of this file FAKED command execution with a
// setTimeout + random success. it never touched minecraft. this version is a
// real relay: if the altoclef companion isn't connected, actions fail honestly.
// action completion is driven by the companion's 'finished'/'error' (backed by
// altoclef's TaskFinishedEvent), not a timer.

import WebSocket from 'ws';
import net from 'net';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    toasterHomesteadDimensions, toasterOutpostDimensions
} from '../../../node/tools/minecraft_settlements.js';
// the ornaments she stands in her own yard. IMPORTED, never restated: this list
// and `PLACEABLE_BLOCKS` in minecraft_tool.js are two enforcement points for one
// rule, and hand-copying it is precisely how nine of the ten ornaments ended up
// accepted here and refused there. (module import only - nothing is constructed.)
import { COMFORT_KINDS } from '../../../node/tools/minecraft_memory.js';

const SUPPORTED_ACTIONS = new Set([
    'move', 'get', 'mine', 'collect', 'craft', 'follow', 'stop', 'idle',
    'defend', 'attack', 'speedrun', 'eat', 'hunt', 'equip', 'deposit',
    'stash', 'give', 'inventory', 'coords', 'locate', 'cover_lava', 'stock_food',
    'explore', 'chat', 'place', 'place_block', 'build_settlement', 'build_plan',
    'farm', 'install_appliance', 'withdraw', 'peek',
    'look', 'boat', 'hud', 'protect_settlement', 'tic'
]);
// These controls may run alongside a real AltoClef goal. They must never take
// ownership of gameState.currentTask or an instant completion will make a mine,
// follow, or speedrun look idle while it is still running.
// 'hud' is text on a screen, not a goal - if it claimed currentTask, every intent
// update would instantly complete and make a running mine/follow/speedrun read as idle.
// 'protect_settlement' hands the pathfinder a rule and returns - it starts no
// goal, so it must not own currentTask either.
// 'tic' is a one-second fidget (a crouch spam, a hop, a punch at the camera). It
// starts no goal and moves her nowhere, so like 'hud' it must never own currentTask -
// its instant completion would make a running mine or follow read as idle.
const NON_TASK_ACTIONS = new Set(['chat', 'stop', 'inventory', 'coords', 'look', 'boat', 'hud', 'protect_settlement', 'tic']);
// (the table of legal footprints that used to live here is gone on purpose -
// see the build_settlement case: the relay resolves the size from the floorplan
// now instead of refusing anything that disagrees with a copy of it.)
const MAX_COMPANION_BUFFER_BYTES = 1024 * 1024;
const BRIDGE_LOCK_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tmp', 'minecraft_bot_bridge.lock'
);

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means it exists but we cannot signal it; it is still live.
        return err?.code === 'EPERM';
    }
}

function acquireBridgeLock() {
    let previous = null;
    let unreadableLock = false;
    try {
        fs.mkdirSync(path.dirname(BRIDGE_LOCK_PATH), { recursive: true });
        previous = JSON.parse(fs.readFileSync(BRIDGE_LOCK_PATH, 'utf8'));
        if (previous?.pid !== process.pid && processIsAlive(previous?.pid)) {
            console.log(`[mc-bridge] another relay is already running (pid ${previous.pid}); exiting`);
            return false;
        }
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            unreadableLock = true;
            console.warn(`[mc-bridge] unable to read relay lock: ${err.message}`);
        }
    }
    // Remove only a lock whose recorded owner is actually gone, then create
    // exclusively. The previous read-then-overwrite sequence allowed two relay
    // processes launched together to both "win" the singleton lock.
    if (previous && !processIsAlive(previous.pid)) {
        try { fs.unlinkSync(BRIDGE_LOCK_PATH); } catch (err) {
            if (err?.code !== 'ENOENT') {
                console.error(`[mc-bridge] unable to remove stale relay lock: ${err.message}`);
                return false;
            }
        }
    } else if (unreadableLock) {
        // A newly-created exclusive lock can be observed in the tiny window
        // before its owner writes the JSON. Give fresh files ownership; only
        // recover an unreadable lock that has clearly been abandoned.
        try {
            const ageMs = Date.now() - fs.statSync(BRIDGE_LOCK_PATH).mtimeMs;
            if (ageMs < 10000) {
                console.log('[mc-bridge] relay lock is fresh but not populated yet; another launch is winning');
                return false;
            }
            fs.unlinkSync(BRIDGE_LOCK_PATH);
        } catch (err) {
            if (err?.code !== 'ENOENT') {
                console.error(`[mc-bridge] unable to recover unreadable relay lock: ${err.message}`);
                return false;
            }
        }
    }
    try {
        const fd = fs.openSync(BRIDGE_LOCK_PATH, 'wx');
        try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        } finally {
            fs.closeSync(fd);
        }
        return true;
    } catch (err) {
        if (err?.code === 'EEXIST') {
            console.log('[mc-bridge] another relay acquired the lock first; exiting');
        } else {
            console.error(`[mc-bridge] unable to create relay lock: ${err.message}`);
        }
        return false;
    }
}

function releaseBridgeLock() {
    try {
        const current = JSON.parse(fs.readFileSync(BRIDGE_LOCK_PATH, 'utf8'));
        if (current?.pid === process.pid) fs.unlinkSync(BRIDGE_LOCK_PATH);
    } catch { /* already removed or unavailable */ }
}

class MinecraftBotBridge extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = {
            // left link: burnt's minecraftTool ws server (fixed - 7425 was a
            // three-way port conflict with chrome-devtools/code_service_v2/livekit)
            burntWsUrl: config.burntWsUrl || process.env.MINECRAFT_BRIDGE_URL || 'ws://localhost:7431',
            // right link: the altoclef external-control companion inside minecraft
            altoclefHost: config.altoclefHost || process.env.ALTOCLEF_HOST || '127.0.0.1',
            altoclefPort: config.altoclefPort || parseInt(process.env.ALTOCLEF_PORT || '7440', 10),
            // default player the bot follows / gives to when none is named
            ownerName: config.ownerName || process.env.MINECRAFT_OWNER || '',
            reconnectDelay: config.reconnectDelay || 5000,
            heartbeatInterval: config.heartbeatInterval || 30000,
            companionStateTimeout: config.companionStateTimeout || 15000,
            // orphan reaper (see _startOrphanWatch). burnt gone this long after having
            // been connected = exit. 0 disables it, for deliberately running the relay
            // standalone.
            orphanExitMs: config.orphanExitMs ?? parseInt(process.env.MINECRAFT_BRIDGE_ORPHAN_MS || '90000', 10),
            // never reached burnt at all - be patient, burnt may still be booting
            orphanStartupMs: config.orphanStartupMs ?? parseInt(process.env.MINECRAFT_BRIDGE_ORPHAN_STARTUP_MS || '600000', 10),
            debug: config.debug ?? true
        };

        // left link state
        this.ws = null;
        this.connected = false;
        this.heartbeatTimer = null;
        this.companionWatchdogTimer = null;
        this.wsReconnectTimer = null;
        this.stopped = false;
        this.lastBurntContactAt = 0;
        // orphan reaper state
        this.everConnected = false;
        this.burntLostAt = 0;
        this.orphanTimer = null;

        // right link state
        this.mc = null;
        this.mcConnected = false;
        this.mcReady = false;
        this.mcBuffer = '';
        this.mcReconnectTimer = null;
        this.mcUsername = null;
        this.lastGameStateAt = 0;

        // action bookkeeping: burnt action id -> { action, sentAt }
        this.inflight = new Map();
        // which action id owns gameState.currentTask. concurrent non-task
        // actions (in-game chat replies) finish instantly and must not blank
        // a running goal's slot when they complete.
        this.currentTaskOwnerId = null;

        this.gameState = {
            health: 20,
            hunger: 20,
            position: { x: 0, y: 0, z: 0 },
            dimension: 'overworld',
            inventory: [],
            nearbyEntities: [],
            isInCombat: false,
            currentTask: null,
            timeOfDay: 'day'
        };
    }

    log(level, message, data = null) {
        if (!this.config.debug && level === 'debug') return;
        const line = `[${new Date().toISOString()}] [mc-bridge] [${level}] ${message}`;
        if (data !== null && data !== undefined) console.log(line, data);
        else console.log(line);
        this.emit('log', { level, message, data });
    }

    // ===================================================================
    // left link: burnt tool ws
    // ===================================================================

    connect() {
        this.stopped = false;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        clearTimeout(this.wsReconnectTimer);
        this.log('info', `connecting to burnt tool ws at ${this.config.burntWsUrl}...`);
        try {
            this.ws = new WebSocket(this.config.burntWsUrl);
            this.ws.on('open', () => this._onWsOpen());
            this.ws.on('message', (d) => this._onWsMessage(d));
            this.ws.on('error', (e) => this.log('error', 'burnt ws error', e.message));
            this.ws.on('close', () => this._onWsClose());
        } catch (err) {
            this.log('error', 'failed to connect to burnt', err.message);
            this._scheduleWsReconnect();
        }
        // bring up the right link in parallel
        if (!this.mc) this._connectAltoclef();
        this._startCompanionWatchdog();
        this._startOrphanWatch();
    }

    _onWsOpen() {
        this.connected = true;
        this.everConnected = true;
        this.burntLostAt = 0;
        this.lastBurntContactAt = Date.now();
        this.log('info', 'connected to burnt tool ws');
        this.emit('connected');

        this.send({
            type: 'handshake',
            source: 'minecraft_bot',
            version: '2.0.0',
            capabilities: [
                'movement', 'mining', 'collecting', 'crafting', 'combat',
                'inventory', 'follow', 'speedrun', 'exploration', 'chat',
                'look', 'boat', 'world_state_v2', 'action_lifecycle',
                'companion_readiness', 'telemetry_watchdog',
                'toaster_settlements_v1', 'settlement_progress'
            ]
        });
        this._startHeartbeat();
        this._sendState();
        this._sendBridgeStatus();
    }

    _onWsMessage(data) {
        this.lastBurntContactAt = Date.now();
        let msg;
        try { msg = JSON.parse(data); } catch { return this.log('error', 'bad ws message'); }
        this.log('debug', `burnt -> ${msg.type}`, msg);

        switch (msg.type) {
            case 'action': return this._handleAction(msg);
            case 'query': return this._sendState();
            case 'config':
                // burnt toggled enabled/autonomous - purely informational for the
                // bridge; the altoclef bot doesn't need it, but log for visibility
                this.log('info', 'config from burnt', { enabled: msg.enabled, autonomous: msg.autonomous });
                return;
            case 'heartbeat_ack':
                return;
            case 'heartbeat':
                return this.send({ type: 'heartbeat_ack', timestamp: Date.now() });
            default:
                this.log('warn', 'unknown ws message type', msg.type);
        }
    }

    _onWsClose() {
        const wasConnected = this.connected;
        this.connected = false;
        this.lastBurntContactAt = 0;
        this.ws = null;
        // The bridge may outlive Burnt (it is deliberately detached), but a
        // task must not outlive the controller that requested it. Otherwise a
        // Burnt restart or a dropped WS link can leave AltoClef mining/fighting
        // unattended, while the freshly started tool has no matching action id
        // or completion callback. Clear stale bookkeeping and ask the companion
        // to halt before reconnecting.
        this._abortActiveWork('burnt control connection lost', true);
        if (wasConnected) {
            this.log('info', 'disconnected from burnt tool ws');
            this.emit('disconnected');
        }
        this._stopHeartbeat();
        if (!this.stopped) this._scheduleWsReconnect();
    }

    _scheduleWsReconnect() {
        if (this.stopped) return;
        if (!this.burntLostAt) this.burntLostAt = Date.now();
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connect(), this.config.reconnectDelay);
    }

    // ORPHAN REAPER. this relay is spawned detached + unref'd "so it outlives burnt",
    // and it reconnects forever - which together mean nothing can ever kill it. burnt's
    // shutdown sweep is real code, but the launcher terminates burnt with
    // `taskkill /F`, and a FORCE kill on windows delivers no signal at all, so the
    // SIGINT/SIGTERM handler that runs the sweep never fires. `/T` cannot reach a
    // deliberately-detached child either. a relay from the previous DAY was still
    // running because of this, and every later burnt "handed off" to it - so bridge
    // code changes silently never took effect.
    //
    // the only property that actually matters is being immune to HOW burnt dies, so
    // the bridge reaps itself: no burnt, no reason to exist.
    _startOrphanWatch() {
        if (this.config.orphanExitMs <= 0) return;   // explicitly disabled
        // ARM ONCE. connect() runs again on every reconnect attempt (every 5s), so
        // clearing and re-creating the interval here meant the 15s tick was reset
        // before it could ever fire - the reaper looked armed and never ran.
        if (this.orphanTimer) return;
        this.orphanTimer = setInterval(() => {
            if (this.stopped || this.connected) return;
            const lostFor = this.burntLostAt ? Date.now() - this.burntLostAt : 0;
            // never reached burnt at all: someone may have started the relay first and
            // burnt is still booting, so be patient. once burnt HAS been seen and then
            // vanished, it is gone - do not sit here for a day pretending otherwise.
            const limit = this.everConnected ? this.config.orphanExitMs : this.config.orphanStartupMs;
            if (lostFor < limit) return;
            this.log('warn', `burnt has been unreachable for ${Math.round(lostFor / 1000)}s - shutting the relay down instead of orphaning it`);
            clearInterval(this.orphanTimer);
            // disconnect() also tells the companion to halt, which is what we want:
            // burnt is gone, so nothing should be left driving the bot unattended.
            Promise.resolve(this.disconnect()).catch(() => { /* exiting anyway */ })
                .finally(() => process.exit(0));
        }, 15000);
        this.orphanTimer.unref?.();
    }

    send(message) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(message)); return true; }
        catch (err) { this.log('error', 'ws send failed', err.message); return false; }
    }

    // ack/terminal responses back to burnt for a given action id
    _respond(id, status, extra = {}) {
        this.send({ type: 'response', action_id: id, status, ...extra });
    }

    // Cancel bridge-owned work when the control plane disappears. `stop` is
    // intentionally sent without an action id: Burnt is offline, so there is
    // no caller to resolve, and the companion's ack/finish can be ignored.
    _abortActiveWork(reason, stopGame = false) {
        const hadActiveWork = this.inflight.size > 0 || !!this.gameState.currentTask;
        this.inflight.clear();
        this.gameState.currentTask = null;
        this.currentTaskOwnerId = null;

        if (stopGame && hadActiveWork && this.mcConnected && this.mcReady) {
            if (!this._sendMc({ type: 'command', command: 'stop' })) {
                this.log('warn', `unable to stop active minecraft work after ${reason}`);
            } else {
                this.log('info', `stopped active minecraft work after ${reason}`);
            }
        }
    }

    _failInflight(reason) {
        for (const [id] of this.inflight) {
            this._respond(id, 'error', { error: reason });
        }
        this.inflight.clear();
        this.gameState.currentTask = null;
        this.currentTaskOwnerId = null;
        this._sendState();
    }

    // ===================================================================
    // action handling: burnt action -> altoclef command
    // ===================================================================

    _handleAction(msg) {
        const action = typeof msg.action === 'string' ? msg.action.trim().toLowerCase() : '';
        const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
        const { id } = msg;
        const actionId = id || `act_${Date.now()}`;

        if (!SUPPORTED_ACTIONS.has(action)) {
            return this._respond(actionId, 'error', { error: `unsupported minecraft action: ${action || 'missing action'}` });
        }

        // translate to an altoclef command string (or a raw chat line, or null)
        let translated;
        try {
            translated = this._translate(action, params);
        } catch (err) {
            return this._respond(actionId, 'error', { error: `translate failed: ${err.message}` });
        }

        if (translated === null) {
            // null means "this action maps to no altoclef command", which is only
            // honestly a missing-feature answer for an action altoclef really cannot
            // do. when the action IS supported, null almost always means the caller
            // left out a required parameter - saying "no built-in task" there sent
            // people looking for a missing feature that exists (see place/equip).
            return this._respond(actionId, 'error', {
                error: SUPPORTED_ACTIONS.has(action)
                    ? `"${action}" is missing something it needs - check its parameters`
                    : `altoclef has no built-in task for "${action}" yet`
            });
        }

        if (!this.mcConnected || !this.mcReady) {
            return this._respond(actionId, 'error', {
                error: this.mcConnected
                    ? 'minecraft companion connected but not ready - join a world first'
                    : 'minecraft bot not connected (altoclef companion offline - is minecraft running with the mod + control server?)'
            });
        }

        // The companion's ack is authoritative: it means Minecraft's client
        // thread accepted the command. Do not report executing before then.
        this.inflight.set(actionId, {
            action,
            params,
            detached: !!translated.detached,
            sentAt: Date.now()
        });

        if (translated.chat) {
            // Raw line (Baritone '#explore' or literal player chat). The
            // companion acknowledges actual client-thread dispatch by id.
            if (!this._sendMc({ type: 'chat', id: actionId, text: translated.chat })) {
                this._respond(actionId, 'error', { error: 'failed to forward action to the minecraft companion' });
                this.inflight.delete(actionId);
                return;
            }
            // chat replies run concurrently with a goal and must not clobber
            // the task slot - 'get diamond' would read as 'chat' then null the
            // moment the line sends, telling burnt she's idle mid-mine
            if (!NON_TASK_ACTIONS.has(action)) {
                this.gameState.currentTask = action;
                this.currentTaskOwnerId = actionId;
            }
            this._sendState();
        } else {
            if (!this._sendMc({ type: 'command', id: actionId, command: translated.command })) {
                this._respond(actionId, 'error', { error: 'failed to forward action to the minecraft companion' });
                this.inflight.delete(actionId);
                return;
            }
            if (!NON_TASK_ACTIONS.has(action)) {
                this.gameState.currentTask = `${action}${params.target ? ' ' + params.target : ''}`;
                this.currentTaskOwnerId = actionId;
            }
            this._sendState();
        }
    }

    // map a burnt action + params to a real altoclef @command (returned WITHOUT
    // the '@'; the companion prefixes it). returns:
    //   { command: 'get diamond 3' }  -> altoclef task
    //   { chat: '#explore' }          -> raw line passthrough (baritone/chat)
    //   null                          -> no real altoclef equivalent
    _translate(action, p = {}) {
        const owner = this.config.ownerName;
        const item = (name) => this._itemName(name);
        const itemList = this._itemList(p.items);
        const dimension = p.dimension ? this._dimensionName(p.dimension) : '';
        const amount = (value, fallback) => this._amount(value, fallback);

        switch (action) {
            case 'move': {
                // ONE SPECIFIC BLOCK, only when a caller says so.
                if (p.precise === true) {
                    const { x, y, z } = this._worldPoint(p, 'move coordinates');
                    return { command: `goto ${x} ${y} ${z}${dimension ? ' ' + dimension : ''}` };
                }
                if (this._isColumn(p)) {
                    const { x, z } = this._worldColumn(p, 'move coordinates');
                    // TWO args, not three. `goto x y z` is GetToBlockTask, which demands
                    // that EXACT block - and when it cannot be reached (she is in a cave
                    // under it, it is inside terrain, it is occupied) AltoClef never
                    // fails, it just falls into an escalating wander-and-retry: 5, 10,
                    // 15, 20, 25, 30 blocks, forever. that out-and-back IS the "looping
                    // between two spots" report. `goto x z` is GetToXZTask - reach the
                    // column at whatever height the ground happens to be - which is what
                    // "go there" has always meant for travel. it also makes the swimming-y
                    // problem structurally impossible instead of merely corrected.
                    //
                    // and because the y is DROPPED here, it was never a required
                    // parameter - it only read as one. `move {x, z}` (what "go to
                    // -777, 7777" means, and what every person who has typed
                    // coordinates at a bot means) fell through this branch and came
                    // back as '"move" is missing something it needs', for want of a
                    // number that would have been thrown away one line later.
                    return { command: `goto ${x} ${z}${dimension ? ' ' + dimension : ''}` };
                }
                // Do not concatenate a free-form target into an AltoClef
                // command. CommandExecutor supports `;` chaining, so only the
                // structured coordinate form may reach the companion.
                if (p.target) throw new Error('move requires numeric x and z parameters (y is optional)');
                return null;
            }

            case 'get':     // the workhorse - altoclef mines/crafts/smelts recursively
            case 'mine':
            case 'collect':
                if (!p.target) return null;
                return { command: `get ${item(p.target)} ${amount(p.amount, 1)}` };

            case 'craft':
                if (!p.target) return null;
                return { command: `get ${item(p.target)} ${amount(p.amount, 1)}` };

            case 'follow': {
                const requested = p.target ? String(p.target).trim() : '';
                const who = requested && !['player', 'nearest', 'me', 'self'].includes(requested.toLowerCase())
                    ? requested
                    : owner;
                if (!who) return null;
                if (!/^[a-zA-Z0-9_]{3,16}$/.test(who)) throw new Error('follow requires a valid Minecraft username');
                // FollowPlayerTask has a real lifecycle callback. Keep it in
                // inflight so losing/reaching the player produces a terminal
                // response and stop can cancel it cleanly; Burnt still returns
                // to conversation at the executing ack.
                return { command: `follow ${who}` };
            }

            case 'stop':
                // Resolve superseded goals immediately. Without this, a stop
                // leaves the old goal waiting for a completion callback that
                // will never arrive and blocks the next viewer suggestion.
                for (const [inflightId] of this.inflight) {
                    this._respond(inflightId, 'error', { error: 'task stopped' });
                    this.inflight.delete(inflightId);
                }
                this.gameState.currentTask = null;
                this.currentTaskOwnerId = null;
                this._sendState();
                return { command: 'stop' };
            case 'idle':   return { command: 'idle', detached: true };
            case 'defend': return { command: 'hero' }; // kill nearby hostiles

            case 'attack': {
                // Stream chat is blocked from ever issuing attack (see
                // recordViewerSuggestion), so a target reaching here is an explicit
                // LLM/operator tool call. A named player routes to @punk; anything
                // else (a mob type, "nearest", no target) clears nearby hostiles.
                if (p.target && this._looksLikePlayer(p.target)) {
                    const who = String(p.target).trim();
                    if (!/^[a-zA-Z0-9_]{3,16}$/.test(who)) throw new Error('attack on a player requires a valid Minecraft username');
                    return { command: `punk ${who}` };
                }
                return { command: 'hero' };
            }

            case 'speedrun': return { command: 'gamer' };   // beat the game
            // `@food <n>` is "END UP HOLDING n food" - a gather/farm project, and
            // a no-op that reports success when she already has n. so an actual
            // eat goes to the companion's eat_now (drives FoodChain's fillup);
            // only a genuinely empty pack falls through to the gather.
            case 'eat':
                return p.now === true || p.hasFood === true
                    ? { command: 'eat_now' }
                    : { command: `food ${amount(p.amount, 3)}` };
            // the SAME `@food <n>` gather, deliberately under a different action
            // name. `eat` is in the tool's SAFETY_ACTIONS, so it skips the busy
            // gate and the stale-state check - which is right for "she is starving,
            // interrupt whatever this is" and exactly wrong for a downtime stock-up
            // that should queue behind real work. it is also what she SAYS: a long
            // forage announced as "eating" is the documented freeze where she went
            // quiet for minutes while claiming to take a bite. n is a food SCORE
            // (nutrition x count), not an item count - bread is 5 a loaf.
            case 'stock_food': return { command: `food ${amount(p.amount, 20)}` };
            // boat: altoclef crafts one (@get boat) but cannot ride it, so
            // mount/dismount are companion-side. no auto-sailing - baritone has
            // no boat pathing, so she'd just drift.
            case 'boat':
                return { command: p.exit === true ? 'boat_exit' : 'boat_ride' };
            // facing, not travelling: "turn around", "look at me". handled by the
            // companion directly - altoclef has no look command.
            case 'look': {
                if (p.away === true) return { command: 'look_away' };
                if (p.turn === 'around') return { command: 'look_turn 180' };
                if (Number.isFinite(Number(p.pitch))) return { command: `look_pitch ${Math.round(Number(p.pitch))}` };
                const who = String(p.target || '').trim();
                if (!who || !/^[A-Za-z0-9_]{1,16}$/.test(who)) throw new Error('look needs a valid player name');
                // HOW LONG SHE HOLDS IT. the companion re-asserts the rotation every
                // tick for this long, because a single write is overwritten by
                // altoclef's own look control before anybody sees it - which is why
                // "look at me while you talk to me" never used to do anything.
                // clamped companion-side too; this is the readable half.
                const hold = Number(p.hold);
                return {
                    command: Number.isFinite(hold) && hold > 0
                        ? `look_at ${who} ${Math.min(15, hold).toFixed(1)}`
                        : `look_at ${who}`
                };
            }
            // the in-game intent line. burnt already base64'd the json payload, because
            // AltoClef's CommandExecutor splits on ';' - free-form text can never be
            // concatenated into a command. re-validate the alphabet rather than trust it.
            // a fidget: crouch spam, a hop, or the front-camera air punch. the KIND is
            // whitelisted here rather than passed through, because everything reaching
            // the companion is a command string and an unvalidated one would be a way
            // to smuggle a second command past this translator.
            case 'tic': {
                const kind = String(p.kind || '').trim().toLowerCase();
                if (!['crouch', 'jump', 'flex'].includes(kind)) {
                    throw new Error(`tic kind must be crouch, jump or flex (got "${kind}")`);
                }
                return { command: `tic ${kind}` };
            }
            case 'hud': {
                const payload = String(p.payload || '');
                if (payload && !/^[A-Za-z0-9+/=]{1,4096}$/.test(payload)) {
                    throw new Error('hud payload must be base64');
                }
                return { command: `hud ${payload}` };
            }
            case 'hunt':     return { command: `meat ${amount(p.amount, 5)}` }; // hunt animals for meat
            // altoclef's @equip takes an ITEM LIST, so "wear all of this" is one
            // command. burnt resolves a bare "put your armor on" into that list from
            // her inventory before it gets here; a single named piece still works.
            case 'equip':
                if (itemList) return { command: `equip ${itemList}` };
                return p.target ? { command: `equip ${item(p.target)}` } : null;
            // raw names: this list is what she is CARRYING, not what she wants.
            case 'deposit': {
                const held = this._itemList(p.items, { raw: true });
                return { command: `deposit${held ? ' ' + held : ''}` };
            }
            // TAKE HER OWN STUFF BACK OUT OF A CHEST. deposit has existed since
            // the beginning and there was NO way back - a one-way door, which is
            // why the pantry could fill up with five hundred loaves she then went
            // out and farmed replacements for.
            //
            // ⚠ RAW NAMES, NEVER THE ORE->PRODUCT ALIAS MAP, for exactly the
            // reason `deposit` uses raw ones: a withdraw names what is ALREADY IN
            // THE CHEST. aliased, "take my raw_iron" asks the companion for
            // `iron_ingot`, an item that is not in there, so nothing comes out and
            // a stocked shelf stays invisible forever.
            //
            // ⚠ AND THE COUNT IS AN INCREMENT - how many MORE she should end up
            // holding - which the companion converts to a hold target itself
            // (held + take). PickupFromContainerTask.isFinished is a `>=` count
            // check, so a raw target she already meets finishes instantly having
            // moved nothing: the hold-target treadmill this stack has been bitten
            // by twice (see the bread pipeline). do not pre-add her carried count.
            case 'withdraw': {
                const what = this._rawItemName(p.item || p.target || '');
                if (!what) throw new Error('withdraw needs to know which item to take out of the chest');
                return { command: `withdraw ${what} ${amount(p.amount, 1)}` };
            }

            // OPEN A CONTAINER JUST TO READ IT. the only way to seed or refresh a
            // pantry entry, and what she does instead of guessing when a reading
            // has expired - which matters beyond tidiness, because sizing a
            // withdraw off a stale reading can ask for more than the chest holds
            // and PickupFromContainerTask has no give-up.
            case 'peek': {
                const at = this._worldPoint(p, 'peek position');
                return { command: `peek ${at.x} ${at.y} ${at.z}` };
            }

            case 'stash': {
                const start = p.start;
                const end = p.end;
                if (!this._isPoint(start) || !this._isPoint(end)) return null;
                const first = this._worldPoint(start, 'stash start');
                const last = this._worldPoint(end, 'stash end');
                const area = `${first.x} ${first.y} ${first.z} ${last.x} ${last.y} ${last.z}`;
                return { command: `stash ${area}${itemList ? ' ' + itemList : ''}` };
            }

            case 'give': {
                const who = p.player || p.target;
                const what = item(p.item || p.what || '');
                const count = amount(p.amount, 1);
                if (who && !/^[a-zA-Z0-9_]{3,16}$/.test(who)) throw new Error('give requires a valid Minecraft username');
                return who && what ? { command: `give ${who} ${what} ${count}` } : null;
            }

            // place a block from the inventory nearby ('bed' also sets spawn) -
            // the homestead loop uses this to install her ovens/chest/bed at home
            // unlike equip ("wear what you have" is answerable from inventory), there is
            // no sane default for WHAT to put down - so say that, instead of returning
            // null and letting the caller report "altoclef has no built-in task for
            // place yet", which is false and told nobody what was actually missing.
            case 'place':
                if (!p.target) throw new Error('place needs to know which block to put down');
                return { command: `place ${item(p.target)}` };

            case 'build_settlement': {
                const role = String(p.role || '').trim().toLowerCase();
                if (!['homestead', 'outpost'].includes(role)) {
                    throw new Error('build_settlement role must be homestead or outpost');
                }
                const at = this._worldPoint(p, 'settlement anchor');
                // THE FLOORPLAN IS THE ONLY LEGAL SHAPE, so this RESOLVES the size
                // instead of validating it.
                //
                // It used to hold a table of the 24 footprints the old expanding
                // shell could take and refuse anything else - a hard gate, in a
                // relay that restarts on its OWN schedule, on a number produced by
                // a different process entirely. The night the plan became fixed
                // that skew cost burnt her whole house: burnt-side sent 14x9x8,
                // this relay was still running the old table, and every attempt
                // died here with "14x9x8 is not a known toaster blueprint" without
                // ever reaching the game, until the goal paused itself. A gate that
                // can disagree with its own caller about a constant is not
                // validation, it is a second source of truth.
                //
                // ...BUT THERE IS MORE THAN ONE HOMESTEAD FOOTPRINT AGAIN, so the
                // PLAN VERSION HAS TO REACH THE WIRE.
                //
                // resolving every homestead to the LATEST floorplan was right while
                // there was only one. now a legacy v1 house asking for its own
                // 14x9x8 came back as the layered 13x21x11 at the same anchor - the
                // relay silently re-pointing a build at a bigger plan centred on the
                // house she already lives in. that is the exact outcome planVersion
                // exists to prevent, and the warning below would have narrated it
                // going wrong ("...the floorplan is 13x21x11 - building that").
                //
                // the resolve-don't-validate rule above still holds: the version
                // picks WHICH floorplan, and that floorplan still owns the size. an
                // absent version means latest, so an older burnt-side that sends no
                // version keeps working.
                const planVersion = Number.isFinite(Number(p.planVersion)) ? Number(p.planVersion) : undefined;
                const plan = role === 'outpost'
                    ? toasterOutpostDimensions()
                    : toasterHomesteadDimensions(planVersion);
                const dims = [plan.width, plan.depth, plan.height];
                const asked = ['width', 'depth', 'height'].map((key) => Number(p[key]));
                if (asked.every(Number.isFinite) && asked.join('x') !== dims.join('x')) {
                    this.log('warn', `build_settlement asked for a ${asked.join('x')} ${role}; `
                        + `the floorplan is ${dims.join('x')} - building that`);
                }
                // THE MOAT, AS AN 8TH ARG THAT IS ALWAYS SENT.
                //
                // ⚠ NEVER OMITTED, not even when off. The java Settlement rebuilds
                // `trenchEnabled` off the wire on every build, and an absent arg is
                // the OLD behaviour rather than "leave it as it was" - so the once
                // burnt-side forgets to say yes is the build that fills the ditch
                // back in. An explicit 0 says "no moat" in the same breath as a 1
                // says "dig one", and there is no third answer to guess at.
                const trench = p.trench === true || p.trench === 1 ? 1 : 0;
                return { command: `toaster_build ${role} ${at.x} ${at.y} ${at.z} ${dims.join(' ')} ${trench}` };
            }

            // "this building is mine, never mine through it". node re-states its
            // whole settlement list every time she joins a world, because the game
            // only learns a house exists while it is being BUILT - and a finished
            // house is never built again. see minecraft_tool _rearmStructureProtection.
            case 'protect_settlement': {
                const role = String(p.role || 'homestead').toLowerCase() === 'outpost' ? 'outpost' : 'homestead';
                const at = this._worldPoint(p, 'settlement anchor');
                if (!at) return null;
                // the footprint is the floorplan's, exactly as build_settlement
                // resolves it - a protected box that disagreed with the built one
                // would guard the wrong blocks.
                const plan = role === 'outpost' ? toasterOutpostDimensions() : toasterHomesteadDimensions();
                // not detached: the companion intercepts this verb and sends its
                // own ack + finished, exactly like `hud`.
                return {
                    command: `protect_settlement ${role} ${at.x} ${at.y} ${at.z} `
                        + `${plan.width} ${plan.depth} ${plan.height}`
                };
            }

            case 'install_appliance': {
                const kind = item(p.target);
                // chest is here because the floorplan stacks three of them by the
                // door - storage is a planned fixture now, not a "put one down
                // somewhere" that used to land on a gallery slot.
                if (!['furnace', 'blast_furnace', 'smoker', 'campfire', 'soul_campfire',
                    'chest', 'crafting_table'].includes(kind)) {
                    throw new Error('install_appliance needs a chest, crafting table, furnace, smoker, blast furnace, or campfire kind');
                }
                const at = this._worldPoint(p, 'appliance position');
                return { command: `place_at ${at.x} ${at.y} ${at.z} ${kind}` };
            }

            // BUILD ONE OF THE PROCEDURAL BLUEPRINTS.
            //
            // No footprint is sent, unlike build_settlement. The plan owns its own
            // size, and a caller that can name a size is a caller that can disagree
            // with the plan - which is how a fixture map ends up addressing blocks
            // outside the house.
            case 'build_plan': {
                const id = String(p.blueprint || p.target || '').trim().toLowerCase().replace(/[ -]+/g, '_');
                if (!/^[a-z0-9_]{1,40}$/.test(id)) throw new Error('build_plan needs a blueprint id');
                const at = this._worldPoint(p, 'build_plan position');
                return { command: `build_plan ${id} ${at.x} ${at.y} ${at.z}` };
            }

            // MAKE A WHEAT FIELD, or grow one that is already there.
            //
            // altoclef reads the coordinates as a SET - it falls back to where she
            // stands unless all three arrive - so this either sends x y z radius or
            // sends neither. Half a position would silently become "here".
            case 'farm': {
                const mode = String(p.mode || p.target || 'create').trim().toLowerCase();
                if (mode !== 'create' && mode !== 'expand') {
                    throw new Error('farm needs create or expand');
                }
                const radius = this._amount(p.radius, 4);
                if (this._isPoint(p)) {
                    const at = this._worldPoint(p, 'farm position');
                    return { command: `farm ${mode} ${at.x} ${at.y} ${at.z} ${radius}` };
                }
                return { command: `farm ${mode}` };
            }

            // A BLOCK AT A COORDINATE, deliberately NOT install_appliance.
            //
            // Lighting a quarry shaft and lighting a yard both need an exact
            // position, and `place` (PlaceBlockNearbyTask) has none. The obvious
            // move is to widen install_appliance's kind list to accept a torch -
            // but an appliance is a PLANNED FIXTURE that gets written to the
            // settlement's appliance ledger and counted against
            // `appliancesRequired`. Filing 40 quarry torches as appliances would
            // make the gallery permanently unfinished, and the survey would go on
            // demanding a furnace in a hole in the ground.
            case 'place_block': {
                const block = item(p.block || p.target);
                // oak_fence/oak_fence_gate are the trench's causeway furniture, not
                // building material: the gate stands on the outer lip of the one
                // crossing so nothing can step onto the bridge, and the fence is
                // what closes off the lip either side of it. Same rule as the
                // torches - a fitting at an exact coordinate that must never be
                // filed as an appliance.
                // THE TRIMMINGS are the third category and they keep the rule
                // rather than bending it: an ornament in the yard is a fitting at
                // an exact coordinate that must never be filed as an appliance,
                // which is precisely what the torches and the causeway gate are.
                // They are still not building material and still never touch the
                // schematic.
                //
                // ⚠ EVERY ORNAMENT is also in `ExternalControlServer.isPlacedByPeople`,
                // which is what the yard clear's "may never clear" predicate reads.
                // One that is NOT on that list is an ornament the yard clear is
                // entitled to smash and the wishlist will put straight back - a
                // loop, not a decoration. That property is asserted over
                // COMFORT_KINDS in tmp/mc_armory_test.mjs.
                //
                // ⚠ it is NOT true of the lighting/shoring half and never was:
                // `soul_torch`, `cobblestone` and `dirt` are absent from that java
                // predicate, so shoring she leaves inside her own yard IS fair game
                // for the yard clear. That is pre-existing and only costs a re-dig;
                // it is written down here so the next person does not read the
                // ornament rule as covering the whole list.
                if (![...COMFORT_KINDS,
                    'torch', 'wall_torch', 'soul_torch', 'lantern',
                    'ladder', 'cobblestone', 'dirt', 'oak_planks',
                    'oak_fence', 'oak_fence_gate'].includes(block)) {
                    throw new Error(`place_block does not carry "${block}" - it is for lighting, shoring and trimmings, not building`);
                }
                const at = this._worldPoint(p, 'place_block position');
                return { command: `place_at ${at.x} ${at.y} ${at.z} ${block}` };
            }

            case 'inventory': return { command: `inventory${p.item || p.target ? ' ' + item(p.item || p.target) : ''}` };
            case 'coords':    return { command: 'coords' };
            case 'locate': {
                if (!p.target) return null;
                const structure = String(p.target).trim().toLowerCase().replace(/[ -]+/g, '_');
                if (!['stronghold', 'desert_temple'].includes(structure)) {
                    throw new Error('locate supports only stronghold or desert_temple');
                }
                return { command: `locate_structure ${structure}` };
            }
            case 'cover_lava':
                return { command: p.method === 'sand' ? 'coverwithsand' : 'coverwithblocks' };

            // no native altoclef task -> baritone / raw passthrough
            case 'explore': return { chat: '#explore', detached: true };
            case 'chat': {
                // the words first, the addressee second. target used to win, so a
                // reply that put the player's name in target and the sentence in
                // message went out as the bare name - a line of pure "MarDotIO".
                const message = String(p.message || p.target || '').trim();
                // Player chat only: @/# are reserved for explicit bridge actions
                // such as explore, never a model/viewer command escape hatch.
                if (!message || /^[\/@#]/.test(message) || /[\r\n\u0000]/.test(message)) throw new Error('commands and control characters are not allowed through minecraft chat');
                return { chat: message.slice(0, 240) };
            }

            default: return null;
        }
    }

    // normalize a burnt target to an altoclef TaskCatalogue item name. mining ore
    // is expressed as getting the resource (@get diamond, not diamond_ore).
    _itemName(name) {
        if (!name) return '';
        let n = String(name).toLowerCase().replace(/^minecraft:/, '').trim();
        if (!/^[a-z0-9_:-]{1,80}$/.test(n)) throw new Error('item names must use a Minecraft item identifier');
        const map = {
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
        return map[n] || n;
    }

    _amount(value, fallback) {
        if (value === undefined || value === null) return fallback;
        if (!Number.isInteger(value) || value < 1 || value > 2304) {
            throw new Error('amount must be an integer from 1 to 2304');
        }
        return value;
    }

    _dimensionName(value) {
        const dimension = String(value).toLowerCase().replace(/^minecraft:/, '').trim();
        if (!['overworld', 'nether', 'end'].includes(dimension)) throw new Error('dimension must be overworld, nether, or end');
        return dimension;
    }

    // `raw` skips the ore->product alias map in _itemName.
    //
    // ⚠ THE ALIASES ARE FOR ASKING, NOT FOR NAMING WHAT SHE HOLDS. the map turns
    // "get me iron" into `iron_ingot` because that is what a person means by a
    // request - correct for get/craft. a DEPOSIT list is the opposite direction:
    // it describes the stack already in her bag, so aliasing it tells altoclef to
    // bank `iron_ingot` when she is carrying `raw_iron`, an item she does not
    // have. the ore then never leaves the bag and the bag stays full forever.
    _itemList(items, { raw = false } = {}) {
        if (!Array.isArray(items) || !items.length) return '';
        const parts = items
            .filter((entry) => entry && typeof entry.item === 'string' && entry.item.trim())
            .slice(0, 16)
            .map((entry) => {
                const count = Number.isInteger(entry.count) && entry.count > 0 ? ` ${entry.count}` : '';
                return `${raw ? this._rawItemName(entry.item) : this._itemName(entry.item)}${count}`;
            });
        return parts.length ? `[${parts.join(', ')}]` : '';
    }

    // same validation as _itemName, none of the renaming.
    _rawItemName(name) {
        if (!name) return '';
        const n = String(name).toLowerCase().replace(/^minecraft:/, '').trim();
        if (!/^[a-z0-9_:-]{1,80}$/.test(n)) throw new Error('item names must use a Minecraft item identifier');
        return n;
    }

    _isPoint(point) {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
    }

    // a destination COLUMN - x and z, no height. travel lands on whatever ground
    // stands at that column, so this is a complete destination, not half of one.
    _isColumn(point) {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.z);
    }

    _worldColumn(point, label = 'coordinates') {
        if (!this._isColumn(point)) throw new Error(`${label} must be finite numbers`);
        const x = Math.round(point.x);
        const z = Math.round(point.z);
        if (Math.abs(x) > 29999984 || Math.abs(z) > 29999984) {
            throw new Error(`${label} are outside the playable world`);
        }
        return { x, z };
    }

    _worldPoint(point, label = 'coordinates') {
        if (!this._isPoint(point)) throw new Error(`${label} must be finite numbers`);
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        const z = Math.round(point.z);
        if (Math.abs(x) > 29999984 || Math.abs(z) > 29999984 || y < -64 || y > 320) {
            throw new Error(`${label} are outside the playable world`);
        }
        return { x, y, z };
    }

    _looksLikePlayer(name) {
        // crude heuristic: real mob type names are lowercase words we know; a
        // player name is anything not in the common-mob set and 3-16 chars.
        const mobs = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
            'witch', 'slime', 'pillager', 'nearest', 'mob', 'hostile', 'phantom',
            'drowned', 'husk', 'blaze', 'ghast', 'piglin', 'hoglin', 'player',
            'me', 'self', 'cow', 'sheep', 'pig', 'chicken', 'horse', 'wolf',
            'cat', 'villager', 'goat', 'rabbit', 'fox', 'bee', 'turtle']);
        const n = String(name).toLowerCase();
        return !mobs.has(n) && /^[a-z0-9_]{3,16}$/i.test(name);
    }

    // ===================================================================
    // right link: altoclef companion tcp
    // ===================================================================

    _connectAltoclef() {
        if (this.mc) { try { this.mc.destroy(); } catch { /* ignore */ } }
        this.log('debug', `connecting to altoclef companion at ${this.config.altoclefHost}:${this.config.altoclefPort}...`);

        const sock = new net.Socket();
        this.mc = sock;

        sock.on('connect', () => {
            this.mcConnected = true;
            this.mcReady = false;
            this.mcBuffer = '';
            this.log('info', 'connected to altoclef companion');
            this.emit('mcConnected');
            this._sendBridgeStatus();
        });
        sock.on('data', (chunk) => this._onMcData(chunk));
        sock.on('error', (err) => {
            // ECONNREFUSED just means minecraft/mod isn't up yet - quiet retry
            this.log('debug', `altoclef socket error: ${err.code || err.message}`);
        });
        sock.on('close', () => {
            const was = this.mcConnected;
            this.mcConnected = false;
            this.mcReady = false;
            this.lastGameStateAt = 0;
            this.mc = null;
            this._sendBridgeStatus();
            if (was) {
                this.log('info', 'altoclef companion disconnected');
                this.emit('mcDisconnected');
                // fail any in-flight actions so burnt doesn't wait forever
                this._failInflight('altoclef companion disconnected mid-task');
            }
            this._scheduleMcReconnect();
        });

        sock.connect(this.config.altoclefPort, this.config.altoclefHost);
    }

    _scheduleMcReconnect() {
        if (this.stopped) return;
        clearTimeout(this.mcReconnectTimer);
        this.mcReconnectTimer = setTimeout(() => this._connectAltoclef(), this.config.reconnectDelay);
    }

    _onMcData(chunk) {
        this.mcBuffer += chunk.toString('utf8');
        if (this.mcBuffer.length > MAX_COMPANION_BUFFER_BYTES) {
            this.log('warn', 'companion sent an oversized unterminated message; reconnecting');
            this.mcBuffer = '';
            try { this.mc?.destroy(); } catch { /* close handler reconnects */ }
            return;
        }
        let idx;
        while ((idx = this.mcBuffer.indexOf('\n')) >= 0) {
            const line = this.mcBuffer.slice(0, idx).trim();
            this.mcBuffer = this.mcBuffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { this.log('warn', 'bad companion line', line.slice(0, 120)); continue; }
            this._onMcMessage(msg);
        }
    }

    _onMcMessage(msg) {
        this.log('debug', `altoclef -> ${msg.type}`, msg);
        switch (msg.type) {
            case 'hello':
                const wasReady = this.mcReady;
                this.mcUsername = msg.username || null;
                this.mcReady = msg.ready !== undefined
                    ? !!msg.ready
                    : !!this.mcUsername && this.mcUsername !== 'unknown';
                if (this.mcReady && !wasReady) this.lastGameStateAt = Date.now();
                const leftWorld = !this.mcReady && wasReady;
                if (leftWorld) this.lastGameStateAt = 0;
                this.log('info', `altoclef companion ${this.mcReady ? 'ready' : 'waiting for world'} (player: ${this.mcUsername || 'unknown'})`);
                this._sendBridgeStatus(); // propagate the in-game username to Burnt
                // Status goes first so Burnt can stand down the whole session
                // once, without narrating every stranded goal as an unrelated
                // task failure. The following errors only clean relay ids.
                if (leftWorld) this._failInflight('minecraft left the world mid-task');
                break;

            case 'ack':
                // Minecraft's client thread accepted the command.
                if (msg.id && this.inflight.has(msg.id)) {
                    const pending = this.inflight.get(msg.id);
                    this._respond(msg.id, 'executing', { message: `starting ${pending.action}...` });
                    if (pending.detached) {
                        this._respond(msg.id, 'success', { result: { started: true, persistent: true } });
                        this.inflight.delete(msg.id);
                    }
                }
                break;

            case 'finished': {
                const id = msg.id;
                if (id && this.inflight.has(id)) {
                    this._respond(id, 'success', { result: msg.result || { success: true } });
                    this.inflight.delete(id);
                    // only the action that owns the task slot may clear it - an
                    // instant chat finishing must not blank a running goal
                    if (this.currentTaskOwnerId === id) {
                        this.gameState.currentTask = null;
                        this.currentTaskOwnerId = null;
                    }
                    this._sendState();
                }
                break;
            }

            case 'error': {
                const id = msg.id;
                if (id && this.inflight.has(id)) {
                    this._respond(id, 'error', { error: msg.error || 'task failed in-game' });
                    this.inflight.delete(id);
                    if (this.currentTaskOwnerId === id) {
                        this.gameState.currentTask = null;
                        this.currentTaskOwnerId = null;
                    }
                    this._sendState();
                }
                break;
            }

            case 'state':
                if (msg.gameState) {
                    Object.assign(this.gameState, msg.gameState);
                    this.lastGameStateAt = Date.now();
                    this.send({
                        type: 'state',
                        gameState: this.gameState,
                        observedAt: this.lastGameStateAt,
                        timestamp: Date.now()
                    });
                }
                break;

            case 'event':
                // forward game events straight to burnt's tool
                this.send({ type: 'event', event: msg.event, data: msg.data || {}, timestamp: Date.now() });
                this._applyEventToState(msg.event, msg.data || {});
                break;

            default:
                this.log('warn', 'unknown companion message', msg.type);
        }
    }

    _applyEventToState(event, data) {
        switch (event) {
            case 'damage_taken': if (typeof data.health === 'number') this.gameState.health = data.health; break;
            case 'death': this.gameState.health = 0; this.gameState.currentTask = null; this.currentTaskOwnerId = null; break;
            case 'respawn': this.gameState.health = 20; break;
            case 'position_update': if (data.position) this.gameState.position = data.position; break;
        }
    }

    _sendMc(obj) {
        if (!this.mcConnected || !this.mc) return false;
        try { this.mc.write(JSON.stringify(obj) + '\n'); return true; }
        catch (err) { this.log('error', 'companion write failed', err.message); return false; }
    }

    // ===================================================================
    // state / heartbeat
    // ===================================================================

    _sendState() {
        this.send({
            type: 'state',
            gameState: this.gameState,
            observedAt: this.lastGameStateAt || null,
            timestamp: Date.now()
        });
    }

    _sendBridgeStatus() {
        this.send({
            type: 'bridge_status',
            altoclefConnected: this.mcConnected && this.mcReady,
            companionSocketConnected: this.mcConnected,
            username: this.mcUsername,
            timestamp: Date.now()
        });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            const contactLimit = Math.max(15000, this.config.heartbeatInterval * 2.5);
            if (this.connected && this.lastBurntContactAt && now - this.lastBurntContactAt > contactLimit) {
                this.log('warn', `burnt stopped answering heartbeats for ${Math.round((now - this.lastBurntContactAt) / 1000)}s; dropping the control link`);
                try { this.ws?.terminate(); } catch { /* close handler stops work */ }
                return;
            }
            this.send({ type: 'heartbeat', timestamp: Date.now(), gameState: this.gameState });
        }, this.config.heartbeatInterval);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    _startCompanionWatchdog() {
        if (this.companionWatchdogTimer) return;
        this.companionWatchdogTimer = setInterval(() => {
            if (!this.mcConnected || !this.mcReady || !this.lastGameStateAt) return;
            const age = Date.now() - this.lastGameStateAt;
            if (age <= this.config.companionStateTimeout) return;
            this.log('warn', `minecraft telemetry stalled for ${Math.round(age / 1000)}s; failing active work and reconnecting the companion`);
            this.mcReady = false;
            this._failInflight('minecraft client telemetry stalled');
            this._sendBridgeStatus();
            try { this.mc?.destroy(); } catch { /* close handler reconnects */ }
        }, Math.min(5000, this.config.companionStateTimeout));
        if (this.companionWatchdogTimer.unref) this.companionWatchdogTimer.unref();
    }

    _stopCompanionWatchdog() {
        if (this.companionWatchdogTimer) {
            clearInterval(this.companionWatchdogTimer);
            this.companionWatchdogTimer = null;
        }
    }

    // ===================================================================
    // shutdown
    // ===================================================================

    async disconnect() {
        this.log('info', 'shutting down bridge...');
        this.stopped = true;
        clearTimeout(this.wsReconnectTimer);
        clearTimeout(this.mcReconnectTimer);
        clearInterval(this.orphanTimer);
        this._stopHeartbeat();
        this._stopCompanionWatchdog();
        // SIGTERM/Ctrl+C must be as safe as a dropped Burnt websocket. Without
        // this, the detached relay could exit while AltoClef kept mining or
        // fighting with no controller left to receive its outcome.
        this._abortActiveWork('bridge shutdown', true);
        if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
        if (this.mc) { try { this.mc.destroy(); } catch { /* ignore */ } this.mc = null; }
        this.connected = false;
        this.mcConnected = false;
        this.mcReady = false;
        this.emit('shutdown');
    }
}

// ---- run as a standalone process ----------------------------------------
// (kept importable too - only self-starts when run directly)
const isMain = (() => {
    try {
        return import.meta.url === `file://${process.argv[1]}` ||
               import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
    } catch { return true; }
})();

if (isMain) {
    if (!acquireBridgeLock()) process.exit(0);
    const bridge = new MinecraftBotBridge({ debug: true });

    bridge.on('connected', () => console.log('✅ bridge <-> burnt connected'));
    bridge.on('disconnected', () => console.log('❌ bridge <-> burnt disconnected'));
    bridge.on('mcConnected', () => console.log('✅ bridge <-> altoclef connected'));
    bridge.on('mcDisconnected', () => console.log('❌ bridge <-> altoclef disconnected'));

    bridge.connect();

    const shutdown = async () => {
        console.log('\n🛑 stopping bridge...');
        await bridge.disconnect();
        releaseBridgeLock();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', releaseBridgeLock);
}

export default MinecraftBotBridge;
