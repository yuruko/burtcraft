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

const SUPPORTED_ACTIONS = new Set([
    'move', 'get', 'mine', 'collect', 'craft', 'follow', 'stop', 'idle',
    'defend', 'attack', 'speedrun', 'eat', 'hunt', 'equip', 'deposit',
    'stash', 'give', 'inventory', 'coords', 'locate', 'cover_lava',
    'explore', 'chat', 'place', 'look', 'boat', 'hud'
]);
// These controls may run alongside a real AltoClef goal. They must never take
// ownership of gameState.currentTask or an instant completion will make a mine,
// follow, or speedrun look idle while it is still running.
// 'hud' is text on a screen, not a goal - if it claimed currentTask, every intent
// update would instantly complete and make a running mine/follow/speedrun read as idle.
const NON_TASK_ACTIONS = new Set(['chat', 'stop', 'inventory', 'coords', 'look', 'boat', 'hud']);
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
            // left link: your controller's ws server (core/minecraft_tool.js). note it is
            // the SERVER and this bridge is the client, so the controller can restart freely.
            controllerWsUrl: config.controllerWsUrl || config.burntWsUrl || process.env.MINECRAFT_BRIDGE_URL || 'ws://localhost:7431',
            // right link: the altoclef external-control companion inside minecraft
            altoclefHost: config.altoclefHost || process.env.ALTOCLEF_HOST || '127.0.0.1',
            altoclefPort: config.altoclefPort || parseInt(process.env.ALTOCLEF_PORT || '7440', 10),
            // default player the bot follows / gives to when none is named
            ownerName: config.ownerName || process.env.MINECRAFT_OWNER || '',
            reconnectDelay: config.reconnectDelay || 5000,
            heartbeatInterval: config.heartbeatInterval || 30000,
            companionStateTimeout: config.companionStateTimeout || 15000,
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
        this.log('info', `connecting to controller ws at ${this.config.controllerWsUrl}...`);
        try {
            this.ws = new WebSocket(this.config.controllerWsUrl);
            this.ws.on('open', () => this._onWsOpen());
            this.ws.on('message', (d) => this._onWsMessage(d));
            this.ws.on('error', (e) => this.log('error', 'controller ws error', e.message));
            this.ws.on('close', () => this._onWsClose());
        } catch (err) {
            this.log('error', 'failed to connect to controller', err.message);
            this._scheduleWsReconnect();
        }
        // bring up the right link in parallel
        if (!this.mc) this._connectAltoclef();
        this._startCompanionWatchdog();
    }

    _onWsOpen() {
        this.connected = true;
        this.lastBurntContactAt = Date.now();
        this.log('info', 'connected to controller ws');
        this.emit('connected');

        this.send({
            type: 'handshake',
            source: 'minecraft_bot',
            version: '2.0.0',
            capabilities: [
                'movement', 'mining', 'collecting', 'crafting', 'combat',
                'inventory', 'follow', 'speedrun', 'exploration', 'chat',
                'look', 'boat', 'world_state_v2', 'action_lifecycle',
                'companion_readiness', 'telemetry_watchdog'
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
        this.log('debug', `controller -> ${msg.type}`, msg);

        switch (msg.type) {
            case 'action': return this._handleAction(msg);
            case 'query': return this._sendState();
            case 'config':
                // burnt toggled enabled/autonomous - purely informational for the
                // bridge; the altoclef bot doesn't need it, but log for visibility
                this.log('info', 'config from controller', { enabled: msg.enabled, autonomous: msg.autonomous });
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
        this._abortActiveWork('controller connection lost', true);
        if (wasConnected) {
            this.log('info', 'disconnected from controller ws');
            this.emit('disconnected');
        }
        this._stopHeartbeat();
        if (!this.stopped) this._scheduleWsReconnect();
    }

    _scheduleWsReconnect() {
        if (this.stopped) return;
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connect(), this.config.reconnectDelay);
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
            return this._respond(actionId, 'error', {
                error: `altoclef has no built-in task for "${action}" yet`
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
            case 'move':
                if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
                    const { x, y, z } = this._worldPoint(p, 'move coordinates');
                    const where = `${x} ${y} ${z}`;
                    return { command: `goto ${where}${dimension ? ' ' + dimension : ''}` };
                }
                // Do not concatenate a free-form target into an AltoClef
                // command. CommandExecutor supports `;` chaining, so only the
                // structured coordinate form may reach the companion.
                if (p.target) throw new Error('move requires numeric x, y, and z parameters');
                return null;

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
            // boat: altoclef crafts one (@get boat) but cannot ride it, so
            // mount/dismount are companion-side. no auto-sailing - baritone has
            // no boat pathing, so she'd just drift.
            case 'boat':
                return { command: p.exit === true ? 'boat_exit' : 'boat_ride' };
            // facing, not travelling: "turn around", "look at me". handled by the
            // companion directly - altoclef has no look command.
            case 'look': {
                if (p.turn === 'around') return { command: 'look_turn 180' };
                if (Number.isFinite(Number(p.pitch))) return { command: `look_pitch ${Math.round(Number(p.pitch))}` };
                const who = String(p.target || '').trim();
                if (!who || !/^[A-Za-z0-9_]{1,16}$/.test(who)) throw new Error('look needs a valid player name');
                return { command: `look_at ${who}` };
            }
            // the in-game intent line. burnt already base64'd the json payload, because
            // AltoClef's CommandExecutor splits on ';' - free-form text can never be
            // concatenated into a command. re-validate the alphabet rather than trust it.
            case 'hud': {
                const payload = String(p.payload || '');
                if (payload && !/^[A-Za-z0-9+/=]{1,4096}$/.test(payload)) {
                    throw new Error('hud payload must be base64');
                }
                return { command: `hud ${payload}` };
            }
            case 'hunt':     return { command: `meat ${amount(p.amount, 5)}` }; // hunt animals for meat
            case 'equip':    return p.target ? { command: `equip ${item(p.target)}` } : null;
            case 'deposit':  return { command: `deposit${itemList ? ' ' + itemList : ''}` };
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
            case 'place':
                return p.target ? { command: `place ${item(p.target)}` } : null;

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
                const message = String(p.target || p.message || '').trim();
                // Player chat only: @/# are reserved for explicit bridge actions
                // such as explore, never a model/viewer command escape hatch.
                if (!message || /^[\/@#]/.test(message) || /[\r\n\u0000]/.test(message)) throw new Error('commands and control characters are not allowed through minecraft chat');
                return { chat: message.slice(0, 240) };
            }

            // altoclef has no generic build task; surfaced as unsupported so burnt
            // can improvise commentary instead of pretending it built something
            case 'build': return null;

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

    _itemList(items) {
        if (!Array.isArray(items) || !items.length) return '';
        const parts = items
            .filter((entry) => entry && typeof entry.item === 'string' && entry.item.trim())
            .slice(0, 16)
            .map((entry) => {
                const count = Number.isInteger(entry.count) && entry.count > 0 ? ` ${entry.count}` : '';
                return `${this._itemName(entry.item)}${count}`;
            });
        return parts.length ? `[${parts.join(', ')}]` : '';
    }

    _isPoint(point) {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
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
                this.log('warn', `controller stopped answering heartbeats for ${Math.round((now - this.lastBurntContactAt) / 1000)}s; dropping the control link`);
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

    bridge.on('connected', () => console.log('✅ bridge <-> controller connected'));
    bridge.on('disconnected', () => console.log('❌ bridge <-> controller disconnected'));
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
