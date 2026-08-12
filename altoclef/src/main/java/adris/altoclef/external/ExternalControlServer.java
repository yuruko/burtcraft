package adris.altoclef.external;

import net.minecraft.client.tutorial.TutorialSteps;
import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.CommandExecutor;
import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.BlockBrokenEvent;
import adris.altoclef.eventbus.events.ChatMessageEvent;
import adris.altoclef.eventbus.events.PlayerCollidedWithEntityEvent;
import adris.altoclef.eventbus.events.TaskFinishedEvent;
import adris.altoclef.tasks.misc.EatNowTask;
import adris.altoclef.tasks.construction.ToasterBuildTask;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterGeometry;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.CameraType;
import net.minecraft.client.InactivityFpsLimit;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.SignBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.TrapDoorBlock;
import net.minecraft.world.level.block.WallBlock;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.AABB;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * external control seam for burnt's minecraft integration.
 *
 * altoclef has no network interface of its own - every command is a chat string
 * fed into {@link AltoClef#getCommandExecutor()}. this companion opens a tiny
 * localhost tcp server (newline-delimited json) that the node bridge
 * (minecraft_bot_bridge.js) connects to, so burnt can drive the bot and read its
 * state from outside the game.
 *
 * it is registered as an ADDITIVE fabric "client" entrypoint (see
 * fabric.mod.json) - it does not modify any existing altoclef class. all
 * game-touching work is marshaled onto the client thread via
 * Minecraft.execute(), which is the only thread safe to run commands /
 * read world state on.
 *
 * protocol (both directions, one json object per line):
 *   bridge -> here:
 *     {"type":"command","id":"<id>","command":"get diamond 3"}  // no leading '@'
 *     {"type":"chat","id":"<id>","text":"#explore"}            // raw line (baritone/chat)
 *     {"type":"ping"}
 *   here -> bridge:
 *     {"type":"hello","username":"Steve"}
 *     {"type":"ack","id":"<id>"}
 *     {"type":"finished","id":"<id>"}                            // command's onFinish
 *     {"type":"error","id":"<id>","error":"..."}                 // command's onError
 *     {"type":"state","gameState":{health,hunger,position,...}}  // ~every 2s
 *     {"type":"event","event":"task_finished"|"chat",...}
 *     {"type":"pong"}
 *
 * bind is localhost-only on purpose - the bot must never be reachable off-box.
 * port: -Daltoclef.control.port, else $ALTOCLEF_CONTROL_PORT, else 7440.
 */
public class ExternalControlServer implements ClientModInitializer {

    private static final int PORT = resolvePort();
    private static final String TAG = "[altoclef-external]";
    // auto third-person while she walks head-down (see autoThirdPersonTick).
    // env override so it can be killed without a rebuild.
    private static final boolean AUTO_THIRD_PERSON =
        !"0".equals(System.getenv("BURTCRAFT_AUTO_THIRD_PERSON"));
    // stop the game throttling itself to 10fps while the bot plays (see keepAwakeTick)
    private static final boolean KEEP_RENDERING =
        !"0".equals(System.getenv("BURTCRAFT_KEEP_RENDERING"));
    // INTENT HUD: burnt's own "here is what i'm about to do, and why" line, drawn
    // top-left. this is NOT altoclef's showTaskChains dump (that stays off - it is
    // a raw task-tree spew and unreadable on stream). the WHY only exists node-side
    // (whose idea the goal was, which survival need triggered it), so node composes
    // the text and pushes it down with the `hud` verb; this side only draws what it
    // is given. env override so it can be killed without a rebuild.
    private static final boolean INTENT_HUD =
        !"0".equals(System.getenv("BURTCRAFT_INTENT_HUD"));
    // a stale intent is worse than none - if burnt goes away the text must not sit
    // on screen forever claiming she is still doing something.
    private static final long INTENT_TTL_MS = 90_000L;
    private static volatile String intentWhat = "";
    private static volatile String intentWhy = "";
    private static volatile String intentPhase = "";
    private static volatile long intentAt = 0L;
    private static volatile int affectFear = -1;
    private static volatile int affectConfidence = -1;
    private static volatile int affectSecurity = -1;
    private static volatile int affectFun = -1;
    private static volatile long affectAt = 0L;

    private static final float LOOK_DOWN_PITCH = 32.0f;   // degrees below horizon
    private static final double MOVING_EPSILON = 0.0016;  // ~0.04 blocks/tick
    private static final int LOOK_DOWN_TICKS = 20;        // ~1s before pulling out
    private static final int LOOK_UP_TICKS = 30;          // ~1.5s before going back

    // MANUAL CONTROL (f1): when on, the human owns keyboard/mouse - the bot's
    // current task is stopped, forced inputs are released, and every external
    // command is refused until it's toggled back. plain chat still works so
    // burnt can keep talking while the operator plays.
    private static volatile boolean manualControl = false;
    private boolean manualKeyWasDown = false; // raw f1 edge detection (client thread only)

    public static boolean isManualControl() {
        return manualControl;
    }

    // the four worn-armor slots, in head-to-toe order (replaces the removed
    // PlayerInventory.armor list)
    private static final EquipmentSlot[] ARMOR_SLOTS = {
        EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET
    };

    // upper bound on the distinct item types reported per state packet. the main
    // inventory is 36 slots, so 36 types is the true maximum and this never
    // actually clips a real bag - it just keeps the packet bounded. it was 18,
    // which silently hid the tail of a loaded inventory from burnt entirely.
    private static final int INV_MAX_TYPES = 36;

    // upper bounds on the container readout (see the `containers` block in
    // pollState). the cache is unbounded and the poll runs every ~2s, so both
    // caps exist to keep the packet small rather than to hide anything -
    // nearest containers and biggest stacks first, which is the order a
    // "what have i got stored" question is actually asking about.
    private static final int CONTAINERS_MAX = 24;
    private static final int CONTAINER_ITEMS_MAX = 24;

    private final Gson gson = new Gson();
    private final Object writeLock = new Object();

    private volatile Socket client;
    private volatile OutputStream out;

    // Suppress duplicate delivery without dropping different players who happen
    // to speak close together.
    private volatile long lastChatEventAt = 0L;
    private volatile String lastChatEventKey = "";
    // recent chat lines by TEXT (see emitChatEvent). a bounded LRU, because the
    // same server message reaches us through several delivery paths and a single
    // last-seen slot cannot collapse a fan-out of three.
    private static final long CHAT_DEDUP_WINDOW_MS = 2500L;
    private static final int CHAT_DEDUP_CACHE = 64;
    private final java.util.LinkedHashMap<String, Long> recentChatText =
            new java.util.LinkedHashMap<>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, Long> eldest) {
                    return size() > CHAT_DEDUP_CACHE;
                }
            };
    // WHAT SHE JUST SAID, so her own line coming back off the server is never
    // heard as somebody talking to her.
    //
    // the only self-check downstream compares the chat sender to the account name
    // this companion reports in `hello` (getGameProfile().name()), while senders
    // are resolved from the line the client RENDERS - on any server that gives her
    // a nick those two strings differ, nothing recognizes her own words, and she
    // answers herself. content cannot be nicked, so match on that instead.
    private static final long CHAT_ECHO_WINDOW_MS = 8000L;
    private final java.util.LinkedHashMap<String, Long> recentSelfChat =
            new java.util.LinkedHashMap<>(8, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, Long> eldest) {
                    return size() > 16;
                }
            };
    private volatile int lastHealth = -1;
    private volatile int lastHunger = -1;
    private volatile boolean wasDead = false;
    private volatile boolean lastWasNight = false;
    // the entity id of the last kill already reported, so one dying mob is one event
    // rather than one per 2-second poll for as long as the corpse is around
    private volatile int lastReportedKillId = Integer.MIN_VALUE;
    // block/pickup events are per-swing and per-item, so they are throttled to a
    // trickle: host-side they only move counters and the rolling `recently:` line,
    // and a mining trip must not drown the eight slots that hold real memories.
    private volatile long lastBlockEventAt = 0L;
    private volatile long lastPickupEventAt = 0L;
    private volatile long lastAchievementAt = 0L;
    private volatile long lastLowHungerEventAt = 0L;
    private volatile long lastCreeperEventAt = 0L;
    private volatile long lastHostileEventAt = 0L;
    private volatile boolean lastHelloReady = false;
    private volatile String lastHelloUsername = "";
    private volatile long lastProtectionEventAt = 0L;
    private volatile String lastInventorySignature = "";
    private volatile String lastDimension = "";
    private volatile String lastWeather = "";
    private volatile int lastNearbyHostiles = 0;
    private volatile int lastDiamondCount = -1;
    /**
     * WHO IS ON THE SERVER, not who is standing next to her.
     *
     * Server chat is global, so everyone logged in can read what she says - but
     * the only roster the companion published was a 32-block entity sweep. Out at
     * a homestead 3000 blocks from spawn that reads zero, and host-side that
     * meant "nobody is listening" for a room that was actually full.
     *
     * Diffing it is also the honest way to hear a join: the join LINE is a system
     * message shaped exactly like plugin chat, so it used to arrive as somebody
     * saying the words "joined the game" and she answered it as a sentence
     * ("left the game. dramatic exit for someone who wasn't even holding a
     * torch", live). The tab list needs no format guessing and works on a server
     * whose join message is in another language.
     */
    private volatile java.util.Set<String> lastOnlineNames = null;

    @Override
    public void onInitializeClient() {
        // subscribe to the static event bus (safe to do at init; events only fire in-game)
        try {
            EventBus.subscribe(TaskFinishedEvent.class, this::onTaskFinished);
            EventBus.subscribe(ChatMessageEvent.class, this::onChatMessage);
            // ⚠ THREE MORE EVENTS BURNT-SIDE ALREADY HANDLED AND NOTHING EMITTED.
            // `block_broken`, `item_collected` and `entity_killed` each have a handler,
            // a stats counter and a `recently:` label in minecraft_tool.js, and were
            // dead code end to end - so "how much have you mined today" and "what did
            // you just pick up" had no answer, and combat was silent.
            //
            // These two only move counters and the rolling recent line (no written cue,
            // deliberately - a line per block would be unbearable), so they are
            // throttled hard at the source rather than shipped per swing.
            EventBus.subscribe(BlockBrokenEvent.class, this::onBlockBroken);
            EventBus.subscribe(PlayerCollidedWithEntityEvent.class, this::onCollidedWithEntity);
        } catch (Throwable t) {
            log("event subscribe failed: " + t);
        }

        // f1 = hand keyboard/mouse between the operator and the bot. polls the
        // RAW glfw key state per tick instead of a KeyMapping: vanilla special-
        // cases f1 (hide gui) before the keybind layer, so a registered binding
        // never sees the press - raw polling always does, menus open or not.
        try {
            net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents.END_CLIENT_TICK.register(mc -> {
                try {
                    boolean down = com.mojang.blaze3d.platform.InputConstants.isKeyDown(
                        mc.getWindow(), org.lwjgl.glfw.GLFW.GLFW_KEY_F1);
                    if (down && !manualKeyWasDown) {
                        // vanilla flips hideGui on f1 only when no screen is open -
                        // undo that flip so the toggle doesn't blank the hotbar
                        if (mc.screen == null) {
                            try { mc.options.hideGui = !mc.options.hideGui; } catch (Throwable ignored) { }
                        }
                        toggleManualControl(mc);
                    }
                    manualKeyWasDown = down;
                    keepAwakeTick(mc);
                    tutorialGuardTick(mc);
                    autoThirdPersonTick(mc);
                    // AFTER the camera tick: a running flex owns the view, and
                    // autoThirdPersonTick respects the lease it borrowed.
                    ticTick(mc);
                    // ...and after the tic, because a flex is a whole-body gesture
                    // that owns the rotation for its duration. holding somebody's
                    // eye is the smaller move and yields to it.
                    gazeTick(mc);
                    // end an expired container showcase even if the task that opened it
                    // never calls closeScreen() again - an open screen blocks movement,
                    // so the linger must always have a floor under it.
                    adris.altoclef.util.helpers.StorageHelper.tickScreenShowcase();
                } catch (Throwable ignored) { }
            });
        } catch (Throwable t) {
            log("manual-control key hook unavailable: " + t);
        }

        // burnt's intent line, top-left. 26.1.2 dropped HudRenderCallback entirely -
        // fabric 0.155's hud api is the new extract-render-state pipeline, so this is a
        // HudElement appended after the whole vanilla hud rather than a render callback.
        try {
            net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry.addLast(
                net.minecraft.resources.Identifier.fromNamespaceAndPath("burtcraft", "intent"),
                (extractor, deltaTracker) -> drawIntent(extractor));
        } catch (Throwable t) {
            log("intent hud unavailable: " + t);
        }

        // surface server protection denials ("You are not allowed to interact
        // with this block!") as events, so burnt can stop grinding claimed land
        // instead of looping on a farm she can't touch. covers system + overlay
        // messages; throttled so a spammy plugin can't flood the bridge.
        try {
            final java.util.regex.Pattern denied = java.util.regex.Pattern.compile(
                "(?i)(not allowed|no permission|don'?t have permission|can'?t (?:build|break|interact|use|open|do that)|cannot (?:build|break|interact|use|open)|is protected|protected (?:area|region|land)|claimed|claim of|belongs to|spawn.?protection)");
            net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
                try {
                    String text = message.getString();
                    if (text == null || text.isEmpty()) return;
                    if (denied.matcher(text).find()) {
                        long now = System.currentTimeMillis();
                        if (now - lastProtectionEventAt < 3000L) return;
                        lastProtectionEventAt = now;
                        JsonObject d = new JsonObject();
                        d.addProperty("text", text.length() > 160 ? text.substring(0, 160) : text);
                        sendEvent("protection_denied", d);
                        return;
                    }
                    // ⚠ ADVANCEMENTS ARRIVE AS A SYSTEM MESSAGE, which is the one hook
                    // that needs no new mixin. `achievement` has a written cue, a
                    // `recently:` label, an affect delta and a RAG milestone write
                    // host-side, and nothing ever emitted it - so every toast on
                    // screen was invisible to her. Matching the rendered sentence
                    // works in singleplayer and on vanilla-ish servers alike.
                    java.util.regex.Matcher adv = ADVANCEMENT_NOTICE.matcher(text);
                    if (adv.find()) {
                        String who = adv.group(1);
                        String name = adv.group(2);
                        String me = mcPlayerName();
                        // somebody ELSE's advancement is not hers to celebrate
                        if (me == null || who == null || who.equalsIgnoreCase(me)) {
                            long nowAdv = System.currentTimeMillis();
                            if (nowAdv - lastAchievementAt > 3000L) {
                                lastAchievementAt = nowAdv;
                                JsonObject d = new JsonObject();
                                d.addProperty("name", name);
                                sendEvent("achievement", d);
                            }
                        }
                        return;
                    }
                    // plugin-formatted chat rides the system channel on most
                    // community servers - recognize it so burnt can hear people
                    tryParseChatLine(text);
                } catch (Throwable ignored) { }
            });
            // unsigned/disguised player chat (offline-mode servers) fires the
            // CHAT event without ever reaching altoclef's signed-chat mixin
            net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents.CHAT.register(
                (message, signedMessage, sender, params, receptionTimestamp) -> {
                    try {
                        emitPlayerChat(message, params, sender);
                    } catch (Throwable ignored) { }
                });
        } catch (Throwable t) {
            log("system-message hook unavailable: " + t);
        }

        Thread server = new Thread(this::runServer, "altoclef-external-control");
        server.setDaemon(true);
        server.start();

        // periodic game-state push (marshaled onto the client thread)
        ScheduledExecutorService poller = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread th = new Thread(r, "altoclef-state-poll");
            th.setDaemon(true);
            return th;
        });
        poller.scheduleAtFixedRate(this::pollState, 2, 2, TimeUnit.SECONDS);

        log("external control ready (will listen on 127.0.0.1:" + PORT + ")");
    }

    // ---- server / client lifecycle --------------------------------------

    private void runServer() {
        while (true) {
            try (ServerSocket ss = new ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"))) {
                log("listening on 127.0.0.1:" + PORT);
                while (true) {
                    Socket s = ss.accept();
                    handleClient(s); // one bridge at a time; blocks until it disconnects
                }
            } catch (IOException e) {
                log("server error: " + e.getMessage() + " (retrying in 5s)");
                sleep(5000);
            }
        }
    }

    private void handleClient(Socket s) {
        closeClient();
        this.client = s;
        boolean issuedControl = false;
        try {
            s.setTcpNoDelay(true);
            this.out = s.getOutputStream();
            log("bridge connected from " + s.getRemoteSocketAddress());
            sendHello();
            // push a full state snapshot right away so Burnt never sees the bot as
            // "connected" with stale telemetry during the up-to-2s gap before the
            // scheduled poll would otherwise fire (goals reject on stale state).
            pollState();
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                issuedControl = handleLine(line.trim()) || issuedControl;
            }
        } catch (IOException e) {
            log("bridge io: " + e.getMessage());
        } finally {
            // Once a connection has issued a command it owns the bot. If that
            // controller disappears, stop on the client thread before accepting
            // another one. Plain port probes (the launcher's double-start check)
            // send no command and therefore do not interrupt a legitimate run.
            if (issuedControl) stopAfterControlLoss();
            if (this.client == s) closeClient();
            log("bridge disconnected");
        }
    }

    private void closeClient() {
        closeClient(null);
    }

    // If expectedOut is supplied, only close the connection that owns that
    // stream. This prevents a late IOException from an old bridge connection
    // from tearing down a newer reconnect.
    private void closeClient(OutputStream expectedOut) {
        Socket s;
        synchronized (writeLock) {
            if (expectedOut != null && this.out != expectedOut) return;
            this.out = null;
            s = this.client;
            this.client = null;
        }
        if (s != null) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    // ---- manual control (f1) ---------------------------------------------

    private void toggleManualControl(Minecraft mc) {
        manualControl = !manualControl;
        LocalPlayer p = mc.player;
        // REFLEXES OFF WITH THE HANDS. "stop" only empties her job queue now -
        // defense, food and the death screen keep their turn while she is merely
        // idle, which is the whole point of that change. But F1 is not idling,
        // it is a handoff: a defense chain still swinging for the mouse while
        // the operator plays is worse than one asleep.
        adris.altoclef.tasksystem.TaskRunner.setReflexesAllowed(!manualControl);
        if (manualControl) {
            // stop whatever the bot is doing and let go of every forced key.
            //
            // ⚠ NAME THE REASON FIRST. The running task's finish callback fires inside
            // this stop, and without a reason it reports plain success - so pressing F1
            // in the middle of "get diamond 3" made her announce that she got the
            // diamonds. See UserTaskChain.cancelWith / sendTaskOutcome.
            try {
                CommandExecutor exec = AltoClef.getCommandExecutor();
                AltoClef mod = exec != null ? exec.getMod() : null;
                if (mod != null) mod.getUserTaskChain().cancelWith(mod, "the operator took the keyboard (f1)");
                else if (exec != null) exec.executeWithPrefix("stop", () -> { }, ex -> { });
            } catch (Throwable ignored) { }
            releaseAllInputs(mc);
            if (p != null) {
                p.sendOverlayMessage(net.minecraft.network.chat.Component.literal(
                    "keyboard/mouse: YOURS - f1 hands it back to the bot"));
            }
            log("manual control ON (f1) - external commands blocked");
        } else {
            if (p != null) {
                p.sendOverlayMessage(net.minecraft.network.chat.Component.literal(
                    "controls handed back to the bot"));
            }
            log("manual control OFF (f1) - bot may act again");
        }
        JsonObject d = new JsonObject();
        d.addProperty("on", manualControl);
        sendEvent("manual_control", d);
    }

    // release every key the bot may be holding down so the handoff is clean
    private void releaseAllInputs(Minecraft mc) {
        try {
            net.minecraft.client.Options o = mc.options;
            net.minecraft.client.KeyMapping[] keys = {
                o.keyUp, o.keyDown, o.keyLeft, o.keyRight, o.keyAttack,
                o.keyUse, o.keyJump, o.keyShift, o.keySprint
            };
            for (net.minecraft.client.KeyMapping k : keys) {
                if (k != null) k.setDown(false);
            }
        } catch (Throwable ignored) { }
    }

    // ---- inbound ---------------------------------------------------------

    private boolean handleLine(String line) {
        if (line.isEmpty()) return false;
        JsonObject msg;
        try {
            msg = JsonParser.parseString(line).getAsJsonObject();
        } catch (Exception e) {
            return false; // ignore malformed lines
        }
        String type = str(msg, "type", "");
        switch (type) {
            case "command":
                runCommand(str(msg, "id", null), str(msg, "command", ""));
                return true;
            case "chat":
                runChat(str(msg, "id", null), str(msg, "text", ""));
                return true;
            case "ping":
                JsonObject pong = new JsonObject();
                pong.addProperty("type", "pong");
                send(pong);
                return false;
            default:
                return false;
        }
    }

    private void stopAfterControlLoss() {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            try {
                CommandExecutor exec = AltoClef.getCommandExecutor();
                AltoClef mod = exec != null ? exec.getMod() : null;
                // ⚠ same as F1: an unexplained cancel reports SUCCESS to whatever is
                // left of the bridge, and if it reconnects before the frame drains she
                // is told the job finished. Losing the controller is not finishing.
                if (mod != null) mod.getUserTaskChain().cancelWith(mod, "the bridge disconnected mid-task");
                else if (exec != null) exec.executeWithPrefix("stop", () -> { }, ex -> { });
            } catch (Throwable t) {
                log("control-loss stop failed: " + t.getMessage());
            }
            releaseAllInputs(mc);
        });
    }

    // run an altoclef @command, tying its onFinish/onError back to the bridge id
    /**
     * FINISHED, OR GAVE UP? The command's own finish callback is the ONLY frame burnt
     * reads for an outcome, and it used to be an unconditional `finished`.
     *
     * `UserTaskChain.onTaskFinish` runs this callback before it publishes
     * `TaskFinishedEvent`, so the abort reason is already on the chain by the time we
     * are called - and the later event carrying that reason is not only unread
     * node-side, it is also dropped as a duplicate by the 3-second completion gate
     * this frame has just armed. So a cyclic task tree, an F1 takeover and a bridge
     * disconnect all reported SUCCESS: she closed the goal, announced the job done,
     * and nothing ever retried it.
     */
    private void sendTaskOutcome(String id) {
        String aborted = null;
        try {
            CommandExecutor exec = AltoClef.getCommandExecutor();
            AltoClef mod = exec != null ? exec.getMod() : null;
            if (mod != null) aborted = mod.getUserTaskChain().getAbortReason();
        } catch (Throwable ignored) {
            // an unreadable reason must not turn a real finish into an error
        }
        if (aborted != null && !aborted.isEmpty()) sendError(id, "aborted: " + aborted);
        else sendFinished(id);
    }

    // ---- keep the game rendering ---------------------------------------------
    // minecraft 1.21.2+ drops to TEN FPS once it decides the player is afk
    // (InactivityFpsLimit.AFK, ~60s with no real keyboard/mouse input). baritone
    // drives the player in code, so no real input ever arrives and the game
    // throttles itself while she is actively playing - that was the "minecraft
    // runs at 10 fps" report. MINIMIZED keeps the power saving that actually
    // makes sense (window minimised) and drops the afk rule.
    // enforced every few seconds because options.txt is rewritten by the game and
    // any in-game menu change would otherwise silently bring the throttle back.
    private static int fpsGuardTicks = 0;

    private static void keepAwakeTick(Minecraft mc) {
        if (!KEEP_RENDERING) return;
        if (++fpsGuardTicks < 100) return;   // ~5s
        fpsGuardTicks = 0;
        try {
            if (mc.options.inactivityFpsLimit().get() != InactivityFpsLimit.MINIMIZED) {
                mc.options.inactivityFpsLimit().set(InactivityFpsLimit.MINIMIZED);
                log("inactivity fps limit was AFK (10fps while the bot plays) - forced to MINIMIZED");
            }
        } catch (Throwable ignored) { }
    }

    // ---- intent hud ----------------------------------------------------------
    // node owns the words. it knows WHY a goal exists (whose idea it was, which
    // survival need triggered it); this side only knows the mechanical task, which
    // is precisely why altoclef's own task-chain dump was unreadable and got turned
    // off. so the text arrives from burnt and this just draws it.
    private static void applyIntent(String payload) {
        try {
            if (payload == null || payload.isEmpty()) {   // empty = clear the hud
                intentWhat = ""; intentWhy = ""; intentPhase = ""; intentAt = 0L;
                affectFear = -1; affectConfidence = -1; affectSecurity = -1; affectFun = -1; affectAt = 0L;
                return;
            }
            String json = new String(java.util.Base64.getDecoder().decode(payload),
                java.nio.charset.StandardCharsets.UTF_8);
            JsonObject o = JsonParser.parseString(json).getAsJsonObject();
            intentWhat = clip(str(o, "what", ""));
            intentWhy = clip(str(o, "why", ""));
            intentPhase = clip(str(o, "phase", ""));
            long now = System.currentTimeMillis();
            intentAt = intentWhat.isEmpty() ? 0L : now;
            affectFear = boundedHundred(o, "fear");
            affectConfidence = boundedHundred(o, "confidence");
            affectSecurity = boundedHundred(o, "security");
            affectFun = boundedHundred(o, "fun");
            affectAt = affectFear < 0 || affectConfidence < 0 || affectSecurity < 0 || affectFun < 0 ? 0L : now;
        } catch (Throwable t) {
            log("bad hud payload: " + t);
        }
    }

    private static String clip(String s) {
        if (s == null) return "";
        String one = s.replace('\n', ' ').replace('\r', ' ').trim();
        return one.length() > 90 ? one.substring(0, 89) + "…" : one;
    }

    private static int boundedHundred(JsonObject o, String name) {
        try {
            return Math.max(0, Math.min(100, o.get(name).getAsInt()));
        } catch (Throwable ignored) {
            return -1;
        }
    }

    // Compact top-left panel: intent, live Minecraft affects, then raw block
    // coordinates on the bottom line. The whole overlay is scaled together so its
    // text and backdrop keep the same proportions without occupying much of the stream.
    private static void drawIntent(net.minecraft.client.gui.GuiGraphicsExtractor g) {
        if (!INTENT_HUD) return;
        try {
            Minecraft mc = Minecraft.getInstance();
            if (mc == null || mc.player == null || mc.level == null) return;
            if (mc.options != null && mc.options.hideGui) return;
            if (mc.font == null) return;

            java.util.List<String> lines = new java.util.ArrayList<>(6);
            java.util.List<Integer> colours = new java.util.ArrayList<>(6);
            if (manualControl) {
                lines.add("manual - you have the keyboard");
                colours.add(0xFFFFC65B);
            } else {
                // a stale line claiming she is mid-task is worse than no line at all
                if (intentAt > 0L && System.currentTimeMillis() - intentAt <= INTENT_TTL_MS) {
                    String what = intentWhat;
                    if (!what.isEmpty()) {
                        lines.add(what);
                        colours.add(0xFFFFFFFF);
                        if (!intentWhy.isEmpty()) { lines.add(intentWhy); colours.add(0xFFCBA6FF); }
                        if (!intentPhase.isEmpty()) { lines.add(intentPhase); colours.add(0xFF9A9A9A); }
                    }
                }
            }

            long now = System.currentTimeMillis();
            if (affectAt > 0L && now - affectAt <= INTENT_TTL_MS) {
                lines.add("fear " + affectFear + "  confidence " + affectConfidence
                        + "  security " + affectSecurity + "  fun " + affectFun);
                colours.add(0xFFCBA6FF);
            }
            net.minecraft.core.BlockPos pos = mc.player.blockPosition();
            lines.add(pos.getX() + " " + pos.getY() + " " + pos.getZ());
            colours.add(0xFFD7E8FF);

            final float scale = 0.75F;
            final int margin = 8, lineHeight = 10, pad = 3;
            g.pose().pushMatrix();
            try {
                g.pose().scale(scale, scale);
                int width = 0;
                for (String s : lines) width = Math.max(width, mc.font.width(s));
                g.fill(margin - pad, margin - pad, margin + width + pad,
                        margin + lines.size() * lineHeight + pad - 1, 0x8C000000);
                for (int i = 0; i < lines.size(); i++) {
                    g.text(mc.font, lines.get(i), margin, margin + i * lineHeight, colours.get(i));
                }
            } finally {
                g.pose().popMatrix();
            }
        } catch (Throwable ignored) { }
    }

    // ---- kill the tutorial hints ---------------------------------------------
    // "Look around" (tutorial.look.title) sat on screen permanently. same root cause
    // as the 10fps AFK throttle: baritone drives the player in CODE, so no real mouse
    // input ever reaches the game, the tutorial never decides she has learned to look
    // around, and the toast never goes away. she is not learning to play minecraft.
    // re-enforced periodically because joining a world / a rewritten options.txt puts
    // the step back. env kill switch, like the rest of the client-side nudges.
    private static final boolean HIDE_TUTORIAL = !"0".equals(System.getenv("BURTCRAFT_HIDE_TUTORIAL"));
    private static int tutorialGuardTicks = 0;

    private static void tutorialGuardTick(Minecraft mc) {
        if (!HIDE_TUTORIAL) return;
        if (++tutorialGuardTicks < 40) return;   // ~2s
        tutorialGuardTicks = 0;
        try {
            if (mc.options.tutorialStep != TutorialSteps.NONE) {
                mc.options.tutorialStep = TutorialSteps.NONE;
                // setStep stops the running step, which is what actually removes the
                // toast already on screen - the option alone only stops the next one.
                mc.getTutorial().setStep(TutorialSteps.NONE);
                log("tutorial hints were on (\"look around\" never clears for a bot) - turned off");
            }
        } catch (Throwable ignored) { }
    }

    // ---- is this crop worth stopping for ------------------------------------
    // CAN SHE TAKE ANYTHING FROM THIS BLOCK RIGHT NOW. AltoClef will not break an
    // immature crop (one seed back for one seed spent), so an unripe field is not
    // food - it is scenery on a timer. host-side that distinction is the whole
    // difference between "my wheat spot" and a place she walks to and stands in.
    //
    // berries are read through the generic age property rather than the bush class,
    // because a class name is a version dependency and a blockstate property is not.
    private static final int BERRIES_PICKABLE_AGE = 2;
    // what counts as walking food. mooshrooms included (they are cows); horses,
    // wolves and cats are not on the menu and never appear here.
    private static final java.util.Set<String> FOOD_ANIMALS = java.util.Set.of(
            "cow", "mooshroom", "pig", "sheep", "chicken", "rabbit");
    // what makes built ground a VILLAGE rather than somebody's base. deliberately
    // narrow: a wandering trader roams the whole world and an iron golem can be
    // player-built, so neither of them is evidence of a village. villagers are.
    private static final java.util.Set<String> VILLAGE_ENTITIES = java.util.Set.of(
            "villager", "villager_v2");

    // THE MUNDANE SET IS AN INVERTED RARITY LIST, AND THAT IS THE WHOLE POINT.
    // A list of "notable" mobs has to be extended every time a new one ships,
    // and the failure mode of forgetting is that the interesting thing is
    // invisible - which is exactly the bug this exists to fix. Naming the
    // handful she genuinely sees every day instead means anything new is
    // notable until it proves boring. Registry paths, never instanceof: the
    // entity classes move between versions and a key does not.
    private static final java.util.Set<String> MUNDANE_CREATURES = java.util.Set.of(
            "zombie", "skeleton", "spider", "creeper", "cow", "pig", "sheep",
            "chicken", "bat", "squid", "rabbit");
    // worth saying out loud on their own, no matter how close or how often.
    private static final java.util.Set<String> BOSS_CREATURES = java.util.Set.of(
            "ender_dragon", "wither", "warden", "elder_guardian");
    private static final int CREATURES_MAX = 6;
    private static final int CREATURE_TYPES_MAX = 16;
    // ⚠ THE NOTABLE VERDICT IS SENT, NOT THE INPUTS TO IT. host-side owns
    // novelty (it owns the bestiary) but must not own a second copy of the
    // mundane set - two lists of mob names in two languages is the floorplan
    // parity problem again, and the drift is silent. Anything that clears the
    // "not something she sees every day" bar is worth host-side asking whether
    // it is also a first.
    private static final int NOTABLE_SCORE = 3;
    // inside this, a hostile is a thing happening to her rather than scenery.
    private static final double DANGER_CLOSE = 8.0;
    // a mob has to be meaningfully off her level before "above/below" earns the
    // words - a skeleton on a ledge is a different problem to one on the floor.
    private static final double ELEVATION_NOTE = 3.0;

    // WHICH WAY, relative to where she is actually looking. "3 hostiles" is a
    // stat readout; "a creeper four blocks behind me" is something happening to
    // a person, and behind is the one she cannot see for herself. This is the
    // yaw that would face the target minus the yaw she has, wrapped to
    // -180..180: negative is her left, positive is her right (facing +Z, east
    // sits on her left hand). Static and dependency-light so the offline probe
    // can call the real thing rather than a copy of it.
    /**
     * Everything the sweep can honestly say about one person standing near her.
     *
     * ⚠ NOTHING HERE IS SERVER STATE. A client mod cannot see another player's
     * health, hunger, inventory or what a mob is targeting - so this reads only
     * synced entity data: position, rotation, pose, the entity flags, the
     * equipped main hand, and the positions of mobs the client already has. Any
     * field that would need the server is deliberately absent rather than
     * guessed, because a number she cannot have is worse than a number she does
     * not report.
     *
     * `threats` is computed against the SAME entity list the sweep already
     * fetched, so counting mobs around each person costs no new query.
     */
    static NearbyPerson describePerson(LocalPlayer me, Player other, float yaw,
                                       java.util.List<net.minecraft.world.entity.Entity> sweep) {
        double dx = other.getX() - me.getX();
        double dz = other.getZ() - me.getZ();
        double dist = me.distanceTo(other);

        // ARE THEY LOOKING AT HER? their look vector against the direction from
        // them to her. this is the whole social signal that was missing - "he is
        // stood there watching me" is a scene and "1 players" is not.
        boolean watching = false;
        if (dist <= WATCHING_MAX_DIST && dist > 0.01) {
            net.minecraft.world.phys.Vec3 look = other.getLookAngle();
            net.minecraft.world.phys.Vec3 toHer = new net.minecraft.world.phys.Vec3(
                    me.getX() - other.getX(),
                    (me.getY() + me.getEyeHeight()) - (other.getY() + other.getEyeHeight()),
                    me.getZ() - other.getZ()).normalize();
            watching = look.dot(toHer) >= WATCHING_DOT;
        }

        // IS SOMETHING ON THEM? a person with two zombies on him is the clearest
        // "help me" in the game and nobody has to type it.
        int threats = 0;
        for (net.minecraft.world.entity.Entity e : sweep) {
            if (!(e instanceof Monster)) continue;
            if (e.distanceTo(other) <= PERSON_THREAT_RADIUS) threats++;
        }

        String holding = "";
        try {
            net.minecraft.world.item.ItemStack held = other.getMainHandItem();
            if (held != null && !held.isEmpty()) {
                holding = BuiltInRegistries.ITEM.getKey(held.getItem()).getPath();
            }
        } catch (Throwable ignored) { }

        String name = "";
        try { name = other.getGameProfile().name(); } catch (Throwable ignored) { }
        String display = "";
        try { display = other.getName().getString(); } catch (Throwable ignored) { }

        return new NearbyPerson(name, display, dist,
                relativeDirection(dx, dz, yaw), other.getY() - me.getY(),
                watching, other.isCrouching(), other.isOnFire(),
                other.hurtTime > 0, threats, holding);
    }

    static String relativeDirection(double dx, double dz, float yaw) {
        double angleTo = Math.toDegrees(Math.atan2(-dx, dz));
        double rel = net.minecraft.util.Mth.wrapDegrees(angleTo - yaw);
        if (Math.abs(rel) <= 45.0) return "ahead";
        if (Math.abs(rel) >= 135.0) return "behind";
        return rel < 0 ? "left" : "right";
    }

    // one creature as the state packet describes it. `id` is carried so two
    // identical mobs at an identical distance stay two mobs through the ranking
    // below; it is not serialized.
    record NearbyCreature(int id, String path, double dist, String dir, double dy,
                          boolean hostile, boolean baby, boolean tame, boolean aggro,
                          String name, int score) { }

    /**
     * A PERSON standing near her, as opposed to a creature.
     *
     * The 32-block sweep has always walked past players and kept nothing but a
     * headcount and a name list - which is why nothing host-side could ever say
     * where somebody was, whether they were watching her, or whether they were in
     * trouble. Every field below comes out of the sweep that was already running.
     *
     * ⚠ TWO NAMES, ON PURPOSE. `name` is the game profile (what
     * `nearbyPlayerNames` has always carried, so nothing downstream shifts under
     * it) and `display` is the rendered one, which is what rank plugins put in
     * CHAT. Burnt matches a speaker against this list, and on a server where
     * those differ she was comparing two different strings for the same human.
     */
    record NearbyPerson(String name, String display, double dist, String dir, double dy,
                        boolean watching, boolean sneaking, boolean onFire, boolean hurt,
                        int threats, String holding) { }

    /** How many people ride in the readout. More than this and it is a crowd, not a scene. */
    static final int PEOPLE_MAX = 6;
    /** Hostiles this close to somebody else are ON them, not merely in the same field. */
    static final double PERSON_THREAT_RADIUS = 8.0;
    /**
     * How square-on somebody has to be for "they are looking at me".
     *
     * The dot product of their unit look vector and the unit vector from them to
     * her. 0.93 is about 21 degrees - narrow enough that walking past while
     * scanning the horizon does not read as eye contact, wide enough that it
     * survives the jitter of a person who is actually looking at you.
     */
    static final double WATCHING_DOT = 0.93;
    /** ...and past this it is not eye contact, it is a coincidence of geometry. */
    static final double WATCHING_MAX_DIST = 16.0;

    // ⚠ THE NEAREST HOSTILE IS NOT NEGOTIABLE. Ranking on notability alone drops
    // a plain zombie in favour of a wandering trader, and the zombie is the one
    // about to hit her - the danger readout would then go quiet exactly when a
    // mundane mob was killing her. So it is seeded first and the interesting
    // ones fill whatever is left, then the whole list is ordered nearest-first
    // because that is the order she would notice them in.
    static java.util.List<NearbyCreature> selectCreatures(java.util.List<NearbyCreature> all, int max) {
        java.util.List<NearbyCreature> picked = new java.util.ArrayList<>();
        if (max <= 0) return picked;
        all.stream().filter(NearbyCreature::hostile)
                .min(java.util.Comparator.comparingDouble(NearbyCreature::dist))
                .ifPresent(picked::add);
        all.stream()
                .sorted(java.util.Comparator.<NearbyCreature>comparingInt(c -> -c.score())
                        .thenComparingDouble(NearbyCreature::dist))
                .forEach(c -> {
                    if (picked.size() < max && !picked.contains(c)) picked.add(c);
                });
        picked.sort(java.util.Comparator.comparingDouble(NearbyCreature::dist));
        return picked;
    }

    // How much this creature is worth her attention, before novelty (which only
    // host-side knows - it owns the bestiary). Ties break on distance at the
    // call site, so this only has to rank kinds against each other.
    static int creatureNotability(String path, boolean named, boolean baby,
                                  boolean tame, boolean hostile, boolean aggro, double dist) {
        int score = 0;
        // ⚠ BIG ENOUGH TO BE ACTUALLY DOMINANT, not merely large. every other
        // term here stacks (not-mundane + named + tame + baby + close + aggro
        // = 15), and at +8 a nametagged baby pet could out-rank a WARDEN and
        // push it out of a six-slot readout. the one mob that must never be
        // crowded out was the one that could be.
        if (BOSS_CREATURES.contains(path)) score += 20;
        if (!MUNDANE_CREATURES.contains(path)) score += 3;
        if (named) score += 4;      // somebody took the trouble to name it
        if (tame) score += 2;
        if (baby) score += 1;
        if (hostile && dist <= DANGER_CLOSE) score += 2;
        // something that has decided about her outranks something that has not,
        // whatever species it is.
        if (aggro) score += 3;
        return score;
    }

    private static boolean isHarvestable(BlockState state) {
        try {
            if (state.getBlock() instanceof CropBlock crop) return crop.isMaxAge(state);
            if (state.is(Blocks.SWEET_BERRY_BUSH)) {
                for (var prop : state.getProperties()) {
                    if (!prop.getName().equals("age")) continue;
                    if (prop instanceof net.minecraft.world.level.block.state.properties.IntegerProperty ip) {
                        return state.getValue(ip) >= BERRIES_PICKABLE_AGE;
                    }
                }
                return false;
            }
        } catch (Throwable ignored) { }
        return false;
    }

    // ---- how big is the room -------------------------------------------------
    // returns the edge length of the largest clear cube she is standing in, measured
    // from her feet upward (the floor is not counted - a room is supposed to have one).
    // expands one shell at a time and stops as soon as a shell is more than a tenth
    // solid, so standing in a tunnel costs a handful of block lookups and only a real
    // hall ever walks the full radius. capped so this can never become a survey.
    private static final int CLEAR_SCAN_MAX_RADIUS = 22;      // edge 45
    private static final double CLEAR_SHELL_SOLID_TOLERANCE = 0.10;

    /**
     * ⚠ CACHED, because the early-out reasons about tunnels and the COMMON CASE is
     * open sky.
     *
     * The shell test stops as soon as a shell is >10% solid, and it samples
     * `dy = 1 .. 2r` - above her head only, the floor excluded by design. So
     * anywhere with open sky (a plain, a desert, her own cleared yard - i.e. exactly
     * the ground she settles on) NO shell is ever solid and it walks all 22 radii:
     * ~76,000 `getBlockState` calls and ~470,000 loop iterations, inside one
     * `mc.execute` frame, every 2 seconds, on the render thread. That is a visible
     * framerate cost on stream.
     *
     * Same cache as `homeSite` right below, for the same reason and with the same
     * shape: a reading is good for SITE_CACHE_MS or until she has moved
     * SITE_CACHE_MOVE blocks. Walking costs what it always did; standing still
     * costs a fifth.
     */
    private static int cachedClearEdge = -1;
    private static BlockPos cachedClearEdgeAt;
    private static long cachedClearEdgeAtMs;

    private static int clearEdge(Minecraft mc) {
        if (mc.player == null || mc.level == null) return 0;
        BlockPos feet = mc.player.blockPosition();
        long now = System.currentTimeMillis();
        if (cachedClearEdge >= 0 && cachedClearEdgeAt != null
            && now - cachedClearEdgeAtMs < SITE_CACHE_MS
            && cachedClearEdgeAt.distSqr(feet) <= (double) SITE_CACHE_MOVE * SITE_CACHE_MOVE) {
            return cachedClearEdge;
        }
        cachedClearEdge = measureClearEdge(mc);
        cachedClearEdgeAt = feet;
        cachedClearEdgeAtMs = now;
        return cachedClearEdge;
    }

    private static int measureClearEdge(Minecraft mc) {
        if (mc.player == null || mc.level == null) return 0;
        BlockPos feet = mc.player.blockPosition();
        int radius = 0;
        for (int r = 1; r <= CLEAR_SCAN_MAX_RADIUS; r++) {
            int checked = 0;
            int solid = 0;
            for (int dx = -r; dx <= r; dx++) {
                for (int dz = -r; dz <= r; dz++) {
                    for (int dy = 1; dy <= 2 * r; dy++) {
                        // shell only: skip anything already counted by a smaller radius
                        if (Math.abs(dx) != r && Math.abs(dz) != r && dy != 2 * r) continue;
                        checked++;
                        BlockPos at = feet.offset(dx, dy, dz);
                        if (!mc.level.getBlockState(at).isAir()) solid++;
                    }
                }
            }
            if (checked == 0) break;
            if ((double) solid / checked > CLEAR_SHELL_SOLID_TOLERANCE) break;
            radius = r;
        }
        return radius <= 0 ? 0 : radius * 2 + 1;
    }

    // ---- auto third-person ---------------------------------------------------
    // baritone aims the camera at its next foothold, so while she walks she stares
    // at the dirt and the stream sees nothing. this ONLY changes the view mode -
    // it never touches pitch/yaw, because the mining camera snap is load-bearing
    // (DestroyBlockTask force-attacks before alignment). looking down while moving
    // pulls the camera out to third person; back up or standing still restores it.
    private static boolean autoThirdPersonActive = false;
    private static int lookDownTicks = 0;
    private static int lookUpTicks = 0;
    // the "human camera": an occasional deliberate drop to third person while walking.
    // env kill switch so it can go without a rebuild.
    private static final boolean VANITY_CAMERA = !"0".equals(System.getenv("BURTCRAFT_VANITY_CAMERA"));
    // was 90s + up to 150s jitter (so 1.5-4min apart) and only ever while walking,
    // which on stream read as "basically always first person". much shorter gap, and
    // it may now fire while she is standing still or working too - see the trigger.
    private static final long VANITY_MIN_GAP_MS = 30_000L;
    private static final long VANITY_GAP_JITTER_MS = 45_000L;
    private static final long VANITY_MIN_HOLD_MS = 8_000L;
    private static final long VANITY_HOLD_JITTER_MS = 14_000L;
    // how often the shot happens even though she is NOT travelling. people flip to
    // third person to look at themselves while idling, not just while walking.
    private static final double VANITY_IDLE_CHANCE = 0.55;
    // front view is the "look at my own face" beat - the one that reads most like a
    // person messing about, so it is worth more than the old 1-in-4.
    private static final double VANITY_FRONT_CHANCE = 0.4;
    private static long nextVanityAt = 0L;
    private static long vanityUntil = 0L;

    // ---- tics ----------------------------------------------------------------
    /**
     * THE FIDGETING. Crouch spam, a hop, and the front-camera air punch.
     *
     * A bot that stands perfectly still between actions reads as a bot. Real players
     * fidget - they bunny-hop while thinking, spam sneak at nothing, and flip the camera
     * round to look at themselves and throw a punch. These are those, and they are
     * PURELY cosmetic: no tic ever presses attack or use, moves her anywhere, or touches
     * pitch/yaw.
     *
     * ⚠ WHO DECIDES vs WHO PERFORMS. The decision (how often, which one, is it safe
     * right now) lives host-side in `_ticStep` - it is the half that knows whether a
     * mouse-click job is running, whether a person is talking, and what the operator set
     * the frequency to, and it is the half a human can tune without a rebuild. This end
     * only PLAYS a named tic over a handful of ticks, and refuses outright if the client
     * is in a state where it would be unsafe or invisible.
     *
     * ⚠ NEVER TOUCHES YAW. `autoThirdPersonTick` above says why: the mining camera snap
     * is load-bearing (DestroyBlockTask force-attacks before alignment). The "look at
     * the camera" beat is done with THIRD_PERSON_FRONT, which turns the CAMERA rather
     * than her head, so it is safe even mid-task and needs nothing restored but the view.
     */
    private static final boolean TICS_ENABLED = !"0".equals(System.getenv("BURTCRAFT_TICS"));
    private static String ticKind = null;
    private static int ticAge = 0;               // ticks since the tic started
    private static int ticLength = 0;
    private static boolean ticTookCamera = false;

    /** true when the tic was accepted; false means the client said no. */
    private static boolean startTic(Minecraft mc, String kind) {
        if (!TICS_ENABLED || kind == null) return false;
        if (ticKind != null) return false;                    // one at a time
        if (manualControl) return false;                      // the operator's hands
        if (mc.player == null || mc.level == null) return false;
        if (mc.screen != null) return false;                  // a chest/craft screen is open
        LocalPlayer p = mc.player;
        // mid-swing or mid-use is exactly when a fidget would break something
        if (p.isUsingItem()) return false;
        if (mc.gameMode != null && mc.gameMode.isDestroying()) return false;
        switch (kind) {
            case "crouch":
                // sneaking only slows her, so this is safe while walking too
                if (!p.onGround() || p.isInWater() || p.isInLava()) return false;
                ticLength = 26;
                break;
            case "jump":
                // ⚠ IDLE-ONLY, deliberately: a forced jump mid-path can land her off a
                // ledge or wreck a parkour move baritone had planned. host-side only
                // offers this one while she is standing still; this is the second lock.
                if (!p.onGround() || p.isInWater() || p.isInLava() || p.isPassenger()) return false;
                if (isMovingNow(p)) return false;
                ticLength = 22;
                break;
            case "flex":
                // camera + arm only. safe anywhere that is not mining or using.
                ticLength = 34;
                ticTookCamera = false;
                if (mc.options.getCameraType() == CameraType.FIRST_PERSON) {
                    mc.options.setCameraType(CameraType.THIRD_PERSON_FRONT);
                    ticTookCamera = true;
                }
                // borrow the vanity camera's lease so it does not fight us for the view
                // while the flex is running (see autoThirdPersonTick).
                vanityUntil = System.currentTimeMillis() + 4000L;
                break;
            default:
                return false;
        }
        ticKind = kind;
        ticAge = 0;
        return true;
    }

    private static boolean isMovingNow(LocalPlayer p) {
        double dx = p.getX() - p.xOld;
        double dz = p.getZ() - p.zOld;
        return (dx * dx + dz * dz) > MOVING_EPSILON;
    }

    private static void ticTick(Minecraft mc) {
        if (ticKind == null) return;
        try {
            // ⚠ ABANDON ON ANY STATE CHANGE THAT MAKES THE TIC WRONG, mid-performance.
            // A fidget that keeps running after the operator takes the keyboard, or once a task
            // starts swinging a pickaxe, is the one way a cosmetic feature becomes a
            // real one.
            if (manualControl || mc.player == null || mc.level == null || mc.screen != null
                || mc.player.isUsingItem()
                || (mc.gameMode != null && mc.gameMode.isDestroying())) {
                endTic(mc);
                return;
            }
            LocalPlayer p = mc.player;
            ticAge++;
            switch (ticKind) {
                case "crouch": {
                    // on/off every 3 ticks: unmistakably a fidget, not a stuck key
                    boolean down = ((ticAge / 3) % 2) == 0;
                    mc.options.keyShift.setDown(down);
                    break;
                }
                case "jump": {
                    // two hops, each one tick of key and a beat of air
                    boolean press = ticAge == 1 || ticAge == 12;
                    mc.options.keyJump.setDown(press);
                    break;
                }
                case "flex": {
                    // three punches at the camera, spaced so they read as separate
                    if (ticAge == 6 || ticAge == 16 || ticAge == 26) {
                        p.swing(net.minecraft.world.InteractionHand.MAIN_HAND);
                    }
                    break;
                }
                default: break;
            }
            if (ticAge >= ticLength) endTic(mc);
        } catch (Throwable ignored) {
            try { endTic(mc); } catch (Throwable ignored2) { }
        }
    }

    /** hand everything back, whatever the tic was and however it ended. */
    private static void endTic(Minecraft mc) {
        String kind = ticKind;
        ticKind = null;
        ticAge = 0;
        ticLength = 0;
        try {
            // ⚠ ALWAYS release, even for a tic that never pressed these: an abandoned
            // crouch would otherwise leave her sneaking for the rest of the session,
            // which looks like a bug and halves her walking speed.
            mc.options.keyShift.setDown(false);
            mc.options.keyJump.setDown(false);
        } catch (Throwable ignored) { }
        if ("flex".equals(kind)) {
            try {
                if (ticTookCamera && mc.options.getCameraType() == CameraType.THIRD_PERSON_FRONT) {
                    mc.options.setCameraType(CameraType.FIRST_PERSON);
                }
            } catch (Throwable ignored) { }
            ticTookCamera = false;
            // give the borrowed lease back, and don't let the vanity camera fire the
            // instant we let go - that would read as one long camera stunt.
            vanityUntil = 0;
            nextVanityAt = System.currentTimeMillis() + VANITY_MIN_GAP_MS;
        }
    }

    // ─── THE GAZE ─────────────────────────────────────────────────────────────
    // who she is currently holding eye contact with, and until when.
    private static String gazeTarget = null;
    private static long gazeUntil = 0L;
    /** Default hold. Long enough to read as "she turned and looked at you", short enough not to be a stare. */
    static final long GAZE_DEFAULT_MS = 2500L;
    /** Ceiling, so a malformed request can never pin her head for the rest of the session. */
    static final long GAZE_MAX_MS = 15000L;
    /** How fast the head comes round, in degrees per tick. Instant snapping reads as a machine. */
    static final float GAZE_TURN_RATE = 22.0f;

    static void startGaze(String who, long holdMs) {
        gazeTarget = who;
        gazeUntil = System.currentTimeMillis() + Math.max(0L, Math.min(GAZE_MAX_MS, holdMs));
    }

    static void endGaze() {
        gazeTarget = null;
        gazeUntil = 0L;
    }

    /**
     * HOLD SOMEBODY'S EYE while she is talking to them.
     *
     * `look_at` used to be a single `setYRot` and nothing else, which is fine for
     * "burnt turn around" and useless for the thing people actually notice: she
     * says a sentence to you and is facing a wall the whole time. One write is
     * gone by the next client tick - AltoClef's own look control, or Baritone's,
     * writes rotation constantly - so a gesture that lasts has to be re-asserted
     * every tick until it expires.
     *
     * ⚠⚠ AND IT MUST NOT FIGHT THE PATHFINDER. Baritone steers by rotation: two
     * writers on `yRot` in the same tick is not a compromise, it is a bot
     * stuttering down a hill on stream while her head snaps back and forth. So
     * the gaze SUSPENDS itself while a path is running rather than contending for
     * the field - the clock keeps ticking, and if she stops moving before it
     * expires the gaze resumes on its own. In practice that produces exactly the
     * right behaviour: standing at her house, somebody talks to her, she turns
     * and looks at them; caught mid-walk, she keeps walking.
     *
     * Turning is RATE-LIMITED for the same reason the tics exist - a head that
     * snaps 180 degrees in one frame reads as a machine, a head that swings round
     * over a few ticks reads as a person hearing their name.
     */
    private static void gazeTick(Minecraft mc) {
        if (gazeTarget == null) return;
        try {
            if (mc.player == null || mc.level == null) { endGaze(); return; }
            // the operator's own view is theirs - the same rule the camera follows
            if (manualControl) { endGaze(); return; }
            if (System.currentTimeMillis() > gazeUntil) { endGaze(); return; }
            // a whole-body gesture outranks holding an eye
            if (ticKind != null) return;
            // ⚠ the pathfinder owns rotation while it is steering. yield, do not
            // contend - and do NOT end the gaze, because she may stop in time.
            if (isPathing()) return;

            LocalPlayer me = mc.player;
            Player who = null;
            for (Player other : mc.level.players()) {
                if (other == me) continue;
                if (matchesPlayerName(other, gazeTarget)) { who = other; break; }
            }
            // they walked off or logged out. that is an ending, not an error.
            if (who == null) { endGaze(); return; }

            double dx = who.getX() - me.getX();
            double dy = (who.getY() + who.getEyeHeight()) - (me.getY() + me.getEyeHeight());
            double dz = who.getZ() - me.getZ();
            double flat = Math.sqrt(dx * dx + dz * dz);
            if (flat < 0.01 && Math.abs(dy) < 0.01) return;
            float wantYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
            float wantPitch = (float) -Math.toDegrees(Math.atan2(dy, flat));

            // shortest way round, capped per tick
            float dYaw = net.minecraft.util.Mth.wrapDegrees(wantYaw - me.getYRot());
            float dPitch = wantPitch - me.getXRot();
            me.setYRot(me.getYRot() + Math.max(-GAZE_TURN_RATE, Math.min(GAZE_TURN_RATE, dYaw)));
            me.setXRot(Math.max(-90f, Math.min(90f,
                    me.getXRot() + Math.max(-GAZE_TURN_RATE, Math.min(GAZE_TURN_RATE, dPitch)))));
        } catch (Throwable ignored) {
            endGaze();
        }
    }

    /**
     * Is Baritone actually steering right now?
     *
     * Reflection-free but defensively wrapped: this runs every tick and a
     * pathfinder that is mid-reload must never be able to take the gaze - or the
     * whole client tick - down with it. An exception reads as "yes, something is
     * driving", which is the safe answer: the gaze stands down rather than
     * fighting something it cannot see.
     */
    private static boolean isPathing() {
        try {
            return baritone.api.BaritoneAPI.getProvider().getPrimaryBaritone()
                    .getPathingBehavior().isPathing();
        } catch (Throwable t) {
            return true;
        }
    }

    /**
     * Match a name against either of the two names a player has.
     *
     * A rank plugin renders `[MVP] Aereon42` where the Mojang account is
     * `ShadowAliceZ`. Burnt learns names from CHAT, which carries the rendered
     * one, so matching only the game profile means she cannot look at exactly the
     * people who just spoke to her.
     */
    static boolean matchesPlayerName(Player other, String wanted) {
        if (wanted == null || wanted.isEmpty()) return false;
        try {
            if (other.getName().getString().equalsIgnoreCase(wanted)) return true;
        } catch (Throwable ignored) { }
        try {
            if (other.getGameProfile().name().equalsIgnoreCase(wanted)) return true;
        } catch (Throwable ignored) { }
        return false;
    }

    private static void autoThirdPersonTick(Minecraft mc) {
        if (!AUTO_THIRD_PERSON) return;
        try {
            if (mc.player == null || mc.level == null) { resetAutoCamera(); return; }
            // the operator's own view is theirs - never yank it around
            if (manualControl) { resetAutoCamera(); return; }

            float pitch = mc.player.getXRot();            // >0 = looking down
            double dx = mc.player.getX() - mc.player.xOld;
            double dz = mc.player.getZ() - mc.player.zOld;
            boolean moving = (dx * dx + dz * dz) > MOVING_EPSILON;
            boolean staringDown = pitch >= LOOK_DOWN_PITCH;

            if (staringDown && moving) { lookDownTicks++; lookUpTicks = 0; }
            else { lookUpTicks++; lookDownTicks = 0; }

            // HUMAN CAMERA. people do not play a whole session locked in first person -
            // they drop to third to look at themselves, check their surroundings, admire
            // a build, then flip back. this is that, on a long random cadence, and only
            // while she is actually travelling: never mid-mine (the camera snap there is
            // load-bearing) and never over the head-down handling below, which owns the
            // "staring at the dirt" case and would otherwise fight this for the camera.
            if (VANITY_CAMERA && !staringDown && !autoThirdPersonActive) {
                if (vanityUntil > 0 && System.currentTimeMillis() > vanityUntil) {
                    if (mc.options.getCameraType() != CameraType.FIRST_PERSON) {
                        mc.options.setCameraType(CameraType.FIRST_PERSON);
                    }
                    vanityUntil = 0;
                    nextVanityAt = System.currentTimeMillis() + VANITY_MIN_GAP_MS
                        + (long) (Math.random() * VANITY_GAP_JITTER_MS);
                } else if (vanityUntil == 0 && System.currentTimeMillis() > nextVanityAt) {
                    // NOT gated on `moving` any more. requiring travel meant the whole
                    // camera only ever existed on long walks - every fight, craft, build
                    // and idle moment stayed locked in first person, which is most of a
                    // session. while she is still it fires on a coin-flip instead, so it
                    // stays a occasional human beat rather than a metronome.
                    boolean take = moving || Math.random() < VANITY_IDLE_CHANCE;
                    if (take && mc.options.getCameraType() == CameraType.FIRST_PERSON) {
                        mc.options.setCameraType(Math.random() < VANITY_FRONT_CHANCE
                            ? CameraType.THIRD_PERSON_FRONT : CameraType.THIRD_PERSON_BACK);
                        vanityUntil = System.currentTimeMillis() + VANITY_MIN_HOLD_MS
                            + (long) (Math.random() * VANITY_HOLD_JITTER_MS);
                    } else if (!take) {
                        // lost the coin flip: wait out another gap rather than re-rolling
                        // every tick, which would make "sometimes" mean "within 50ms".
                        nextVanityAt = System.currentTimeMillis() + VANITY_MIN_GAP_MS
                            + (long) (Math.random() * VANITY_GAP_JITTER_MS);
                    }
                }
            }

            if (!autoThirdPersonActive && lookDownTicks >= LOOK_DOWN_TICKS) {
                // don't fight a view the operator chose themselves
                if (mc.options.getCameraType() == CameraType.FIRST_PERSON) {
                    mc.options.setCameraType(CameraType.THIRD_PERSON_BACK);
                    autoThirdPersonActive = true;
                }
            } else if (autoThirdPersonActive && lookUpTicks >= LOOK_UP_TICKS) {
                if (mc.options.getCameraType() == CameraType.THIRD_PERSON_BACK) {
                    mc.options.setCameraType(CameraType.FIRST_PERSON);
                }
                autoThirdPersonActive = false;
            }
        } catch (Throwable ignored) { }
    }

    /**
     * Is she standing over open water rather than land?
     * <p>
     * True when the column under her feet hits water before it hits anything solid,
     * OR when most of the eight blocks around her feet are water - which is what a
     * one-block bridge across an ocean actually looks like. Deliberately does NOT
     * count a puddle or a shoreline: a single adjacent water block is normal.
     */
    private static boolean isOverWater(Minecraft mc, LocalPlayer p) {
        try {
            if (mc.level == null || p == null) return false;
            BlockPos feet = p.blockPosition();
            // straight down: water before solid ground means she is on something
            // placed over the sea (or on a lily pad / boat-less crossing).
            for (int dy = 1; dy <= 4; dy++) {
                BlockPos below = feet.below(dy);
                if (!mc.level.getFluidState(below).isEmpty()) return true;
                if (!mc.level.getBlockState(below).isAir()) break;   // hit real ground
            }
            int water = 0;
            for (int dx = -1; dx <= 1; dx++) {
                for (int dz = -1; dz <= 1; dz++) {
                    if (dx == 0 && dz == 0) continue;
                    if (!mc.level.getFluidState(feet.offset(dx, -1, dz)).isEmpty()) water++;
                }
            }
            return water >= 5;   // surrounded, not merely beside a pond
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * THE SITE SURVEY IS THE MOST EXPENSIVE THING IN THE POLL, and it was being
     * paid for every two seconds forever.
     *
     * measureHomeSite plus surveyBuiltGround is ~1400 columns and several
     * thousand block reads, and all of it runs inside mc.execute - on the render
     * thread, so the whole bill lands in one frame. That is a hitch every two
     * seconds of stream, and it was being paid hardest in the case where the
     * answer provably had not changed: standing still building a house, which is
     * when she is on camera doing nothing else.
     *
     * The ground does not move. So the reading is kept until either it goes
     * stale or she has actually walked somewhere - eight blocks against a scan
     * that reaches out forty-eight, which cannot change the verdict. Walking
     * costs exactly what it did before; standing still costs a fifth.
     */
    private static final long SITE_CACHE_MS = 10_000L;
    private static final int SITE_CACHE_MOVE = 8;
    private static JsonObject cachedSite;
    private static BlockPos cachedSiteAt;
    private static long cachedSiteAtMs;

    private static JsonObject homeSite(Minecraft mc, LocalPlayer p) {
        BlockPos feet = p.blockPosition();
        long now = System.currentTimeMillis();
        if (cachedSite != null && cachedSiteAt != null
            && now - cachedSiteAtMs < SITE_CACHE_MS
            && cachedSiteAt.distSqr(feet) <= (double) SITE_CACHE_MOVE * SITE_CACHE_MOVE) {
            return cachedSite;
        }
        cachedSite = measureHomeSite(mc, p);
        cachedSiteAt = feet;
        cachedSiteAtMs = now;
        return cachedSite;
    }

    /** Cheap footprint survey for choosing a buildable toaster anchor nearby. */
    private static JsonObject measureHomeSite(Minecraft mc, LocalPlayer p) {
        JsonObject site = new JsonObject();
        BlockPos feet = p.blockPosition();
        int expectedGroundY = feet.getY() - 1;
        int minY = Integer.MAX_VALUE;
        int maxY = Integer.MIN_VALUE;
        int supported = 0;
        int waterColumns = 0;
        int columns = 0;
        // The homestead floorplan is 14x9, so a 21x15 scan reads the footprint
        // plus a working margin while staying wholly inside loaded chunks.
        for (int dx = -10; dx <= 10; dx++) {
            for (int dz = -7; dz <= 7; dz++) {
                int x = feet.getX() + dx;
                int z = feet.getZ() + dz;
                int surfaceY = mc.level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                minY = Math.min(minY, surfaceY);
                maxY = Math.max(maxY, surfaceY);
                if (Math.abs(surfaceY - expectedGroundY) <= 2) supported++;
                if (!mc.level.getFluidState(new BlockPos(x, surfaceY, z)).isEmpty()) waterColumns++;
                columns++;
            }
        }
        site.addProperty("supportPercent", columns == 0 ? 0 : Math.round(100.0 * supported / columns));
        site.addProperty("heightSpread", columns == 0 ? 999 : maxY - minY);
        site.addProperty("waterColumns", waterColumns);
        measureYard(mc, feet, expectedGroundY, site);
        surveyBuiltGround(mc, feet, site);
        return site;
    }

    /**
     * HOW MUCH DIGGING THE YARD WOULD COST HER.
     *
     * A toaster wants ten blocks of air on every wall, and she is the one who
     * has to make that true - so the cheapest possible yard is one that is
     * already clear. Measuring it BEFORE she commits is the difference between
     * settling on a plain and settling halfway up a hill and then spending a
     * stream shifting it one block at a time.
     *
     * One heightmap lookup per column, and MOTION_BLOCKING rather than the
     * NO_LEAVES variant used above: a forest canopy is exactly the kind of yard
     * she would have to fell, so leaves have to count here even though they must
     * not count as "uneven footing".
     */
    private static void measureYard(Minecraft mc, BlockPos feet, int expectedGroundY, JsonObject site) {
        int[] footprint = ToasterGeometry.footprint("homestead");
        int halfX = footprint[0] / 2 + Settlement.YARD_MARGIN;
        int halfZ = footprint[1] / 2 + Settlement.YARD_MARGIN;
        // How far above the floor the yard actually has to be empty. Anything
        // taller than the house is not in her way and is not counted against it.
        final int wallHeight = 7;
        int blocked = 0;
        int fill = 0;
        for (int dx = -halfX; dx <= halfX; dx++) {
            for (int dz = -halfZ; dz <= halfZ; dz++) {
                int surfaceY = mc.level.getHeight(Heightmap.Types.MOTION_BLOCKING,
                    feet.getX() + dx, feet.getZ() + dz) - 1;
                int above = surfaceY - expectedGroundY;
                if (above <= 0) continue;
                blocked++;
                fill += Math.min(above, wallHeight);
            }
        }
        site.addProperty("yardBlockedColumns", blocked);
        site.addProperty("yardFill", fill);
        site.addProperty("yardMargin", Settlement.YARD_MARGIN);
    }

    /** How far out we look for signs of people, and how coarsely. */
    private static final int BUILT_SCAN_RADIUS = 48;
    private static final int BUILT_SCAN_STEP = 3;

    /**
     * HAS ANYONE BUILT HERE.
     *
     * Until now the only way burnt learned a place was taken was the server
     * slapping her hand - a `protection_denied` AFTER she had already walked
     * there and started mining someone's wall. On a world with no claim plugin
     * she never learned at all. So she kept picking ground that was visibly,
     * obviously somebody's base, because nothing in the whole stack ever LOOKED
     * at the blocks.
     *
     * This looks. Coarse on purpose - a 3-block grid over a 48-block radius is
     * ~1000 columns every 2 seconds, and nothing anyone builds is smaller than
     * 3x3. Only the surface band is read (ground-1 to ground+3), so mineshaft
     * rails and stronghold brick far underground do not read as a neighbour.
     *
     * Villages count as people. She should not move in next door to villagers
     * and quarry their houses for cobblestone either.
     */
    private static void surveyBuiltGround(Minecraft mc, BlockPos feet, JsonObject site) {
        int found = 0;
        int nearest = Integer.MAX_VALUE;
        for (int dx = -BUILT_SCAN_RADIUS; dx <= BUILT_SCAN_RADIUS; dx += BUILT_SCAN_STEP) {
            for (int dz = -BUILT_SCAN_RADIUS; dz <= BUILT_SCAN_RADIUS; dz += BUILT_SCAN_STEP) {
                int x = feet.getX() + dx;
                int z = feet.getZ() + dz;
                int surfaceY = mc.level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                for (int y = surfaceY - 1; y <= surfaceY + 3; y++) {
                    if (!isPlacedByPeople(mc.level.getBlockState(new BlockPos(x, y, z)))) continue;
                    found++;
                    int distance = (int) Math.round(Math.sqrt((double) dx * dx + (double) dz * dz));
                    if (distance < nearest) nearest = distance;
                    break;   // one hit per column is enough to call it built-on
                }
            }
        }
        site.addProperty("builtColumns", found);
        site.addProperty("builtNearest", nearest == Integer.MAX_VALUE ? -1 : nearest);
        site.addProperty("builtScanRadius", BUILT_SCAN_RADIUS);
    }

    /**
     * Blocks that do not occur in open terrain by themselves - someone put them
     * there, whether a player or a village.
     *
     * Deliberately conservative about natural look-alikes: plain terracotta is
     * a badlands hillside, deepslate/andesite/tuff are just rock, and a torch
     * underground is a mineshaft - which is why the caller only reads the
     * surface band.
     */
    public static boolean isPlacedByPeople(BlockState state) {
        if (state == null || state.isAir()) return false;
        Block block = state.getBlock();
        if (block == Blocks.CRAFTING_TABLE || block == Blocks.CHEST || block == Blocks.TRAPPED_CHEST
            || block == Blocks.BARREL || block == Blocks.FURNACE || block == Blocks.BLAST_FURNACE
            || block == Blocks.SMOKER || block == Blocks.TORCH || block == Blocks.WALL_TORCH
            || block == Blocks.LANTERN || block == Blocks.BOOKSHELF || block == Blocks.ANVIL
            || block == Blocks.HOPPER || block == Blocks.LADDER || block == Blocks.SCAFFOLDING
            || block == Blocks.FARMLAND || block == Blocks.COMPOSTER || block == Blocks.CAMPFIRE
            || block == Blocks.BRICKS || block == Blocks.GLASS || block == Blocks.GLASS_PANE
            || block == Blocks.IRON_BLOCK || block == Blocks.GOLD_BLOCK || block == Blocks.DIAMOND_BLOCK
            || block == Blocks.BELL || block == Blocks.LECTERN || block == Blocks.CARTOGRAPHY_TABLE
            || block == Blocks.SMITHING_TABLE || block == Blocks.LOOM || block == Blocks.STONECUTTER
            || block == Blocks.GRINDSTONE || block == Blocks.BREWING_STAND || block == Blocks.ENCHANTING_TABLE
            || block == Blocks.SMOOTH_STONE || block == Blocks.STONE_BRICKS || block == Blocks.CHISELED_STONE_BRICKS) {
            return true;
        }
        // SHAPE, then NAME - never tags. Block tags are datapack DATA: they are
        // empty until a world finishes loading them, so a tag-based test reads
        // an entire village as untouched wilderness at exactly the moment she is
        // deciding where to live. Classes and registry names are code and are
        // always there. (Proven, not assumed: every tag check in the first draft
        // of this returned false in tmp/probe/BuiltGroundProbe.)
        if (block instanceof StairBlock || block instanceof SlabBlock
            || block instanceof FenceBlock || block instanceof FenceGateBlock
            || block instanceof DoorBlock || block instanceof TrapDoorBlock
            || block instanceof BedBlock || block instanceof SignBlock
            || block instanceof WallSignBlock || block instanceof BaseRailBlock
            || block instanceof CarpetBlock || block instanceof WallBlock) {
            return true;
        }
        String name;
        try {
            name = BuiltInRegistries.BLOCK.getKey(block).getPath();
        } catch (Throwable ignored) {
            return false;
        }
        // deliberately NOT "_terracotta": that is a badlands hillside, not a house.
        return name.endsWith("_planks") || name.endsWith("_wool") || name.endsWith("_carpet")
            || name.endsWith("_glass") || name.endsWith("_glass_pane") || name.endsWith("_concrete")
            || name.endsWith("_shulker_box") || name.endsWith("_glazed_terracotta")
            || name.endsWith("_bricks") || name.endsWith("_lamp") || name.endsWith("_banner");
    }

    private static void resetAutoCamera() {
        // ⚠ THE GAZE DIES HERE TOO. this runs on f1 and on world loss, and a gaze
        // left armed would keep writing rotation while the operator is trying to
        // play - the same trap the crouch tic left behind when it was not ended.
        endGaze();
        lookDownTicks = 0;
        lookUpTicks = 0;
        // ⚠ A TIC MID-PERFORMANCE HAS TO DIE HERE TOO. This runs on f1 and on world
        // loss, and a crouch tic abandoned with the key held down would leave her
        // sneaking - at half speed, apparently stuck - for the rest of the session.
        if (ticKind != null) {
            try { endTic(Minecraft.getInstance()); } catch (Throwable ignored) { }
        }
        // hand the camera back cleanly: f1 manual control and world loss both land here,
        // and a vanity shot left running would keep the operator in third person.
        if (vanityUntil > 0) {
            try {
                Minecraft mc = Minecraft.getInstance();
                if (mc.options.getCameraType() != CameraType.FIRST_PERSON) {
                    mc.options.setCameraType(CameraType.FIRST_PERSON);
                }
            } catch (Throwable ignored) { }
            vanityUntil = 0;
        }
        if (autoThirdPersonActive) {
            try {
                Minecraft mc = Minecraft.getInstance();
                if (mc.options.getCameraType() == CameraType.THIRD_PERSON_BACK) {
                    mc.options.setCameraType(CameraType.FIRST_PERSON);
                }
            } catch (Throwable ignored) { }
            autoThirdPersonActive = false;
        }
    }

    private void runCommand(String id, String command) {
        if (command == null || command.isEmpty()) {
            sendError(id, "empty command");
            return;
        }
        // INTENT HUD. intercepted before the manual-control guard ON PURPOSE: this is
        // text on a screen, not a bot action, and manual control is exactly the moment
        // you still want to see what she was trying to do. the payload is base64'd json
        // because altoclef's CommandExecutor treats ';' as a command separator - free-form
        // text must NEVER be concatenated into a command string.
        if (command.regionMatches(true, 0, "hud ", 0, 4)) {
            applyIntent(command.substring(4).trim());
            sendAck(id);
            sendFinished(id);
            return;
        }
        // A FIDGET. Cosmetic, a second or two long, starts no task and moves her
        // nowhere - so like the hud it never touches the task system. It DOES sit below
        // nothing and above everything, because the client is the only thing that knows
        // whether a screen is open or a pickaxe is mid-swing right now.
        //
        // Reported as finished either way: a refused fidget is not a fault, and burnt
        // must never narrate one. `startTic` says no far more often than yes.
        if (command.regionMatches(true, 0, "tic", 0, 3)) {
            final String kind = command.length() > 3 ? command.substring(3).trim().toLowerCase() : "";
            Minecraft mc = Minecraft.getInstance();
            sendAck(id);
            mc.execute(() -> {
                try { startTic(mc, kind); } catch (Throwable ignored) { }
            });
            sendFinished(id);
            return;
        }
        // "THIS BUILDING IS MINE - NEVER MINE THROUGH IT."
        //
        // Also intercepted before the manual-control guard, and for the same kind
        // of reason as the hud: this starts no task and moves nothing, it hands
        // the pathfinder a rule. Refusing it while the operator holds the keyboard would
        // mean the house comes back unprotected the moment he hands control back.
        //
        // Node re-sends its whole settlement list on every world join, because the
        // game only ever learns a house exists while it is being BUILT - and a
        // FINISHED house is never built again. That left the completed homestead,
        // the one building she walks to most, as ordinary stone on the shortest
        // path home.
        if (command.regionMatches(true, 0, "protect_settlement ", 0, 19)) {
            sendAck(id);
            try {
                String[] a = command.substring(19).trim().split("\\s+");
                if (a.length < 7) throw new IllegalArgumentException("need role x y z width depth height");
                boolean outpost = "outpost".equalsIgnoreCase(a[0]);
                BlockPos anchor = new BlockPos(Integer.parseInt(a[1]), Integer.parseInt(a[2]), Integer.parseInt(a[3]));
                int w = Integer.parseInt(a[4]), d = Integer.parseInt(a[5]), h = Integer.parseInt(a[6]);
                Settlement s = outpost
                    ? new adris.altoclef.tasks.construction.settlement.ToasterOutpost("protected", anchor, w, d, h)
                    : new adris.altoclef.tasks.construction.settlement.ToasterHomestead("protected", anchor, w, d, h);
                // the world is read lazily inside the predicate, on the pathing
                // thread - do NOT capture a level here, this runs before chunks load.
                s.protectFromMining(() -> Minecraft.getInstance().level);
                log("protecting " + s.protectionId() + " from mining");
                sendFinished(id);
            } catch (Throwable t) {
                sendError(id, "bad protect_settlement: " + t.getMessage());
            }
            return;
        }
        if (manualControl) {
            sendError(id, "manual control is on (f1) - the operator has the keyboard right now");
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            CommandExecutor exec = AltoClef.getCommandExecutor();
            if (exec == null) {
                sendError(id, "altoclef not ready - join a world first");
                return;
            }
            // strip any leading prefix the caller sent; executeWithPrefix re-adds whatever
            // prefix altoclef is actually configured to use (default "@", but the user's
            // config may be "." etc). a hardcoded prefix here silently drops the command
            // in execute() when it doesn't match the configured one.
            String bare = (command.startsWith("@") || command.startsWith(".")) ? command.substring(1) : command;
            // BOAT. altoclef can CRAFT a boat (CollectBoatTask) but neither it nor
            // baritone can ride one - there is no boat movement anywhere in the
            // pathing code. so mounting/dismounting is done here directly.
            // steering is deliberately NOT attempted: baritone cannot path in a
            // boat, so pretending to sail would just strand her.
            if (bare.equalsIgnoreCase("boat_ride") || bare.equalsIgnoreCase("boat_exit")) {
                sendAck(id);
                try {
                    LocalPlayer me = mc.player;
                    if (me == null) { sendError(id, "not in a world"); return; }
                    if (bare.equalsIgnoreCase("boat_exit")) {
                        if (!me.isPassenger()) { sendError(id, "not in anything to get out of"); return; }
                        me.stopRiding();
                        sendFinished(id);
                        return;
                    }
                    if (me.isPassenger()) { sendError(id, "already riding something"); return; }
                    net.minecraft.world.entity.Entity best = null;
                    double bestDist = 6.0 * 6.0;
                    for (net.minecraft.world.entity.Entity e : mc.level.entitiesForRendering()) {
                        if (!(e instanceof net.minecraft.world.entity.vehicle.boat.AbstractBoat)) continue;
                        if (!e.getPassengers().isEmpty()) continue;
                        double d = e.distanceToSqr(me);
                        if (d < bestDist) { bestDist = d; best = e; }
                    }
                    if (best == null) { sendError(id, "no free boat within reach - place one on the water first"); return; }
                    me.startRiding(best);
                    sendFinished(id);
                } catch (Throwable t) {
                    sendError(id, "boat failed: " + t.getMessage());
                }
                return;
            }
            // LOOK / TURN. altoclef has no facing command, and "burnt turn around"
            // or "look at me" is a normal thing for a person to ask. this only
            // sets the player's own rotation - no task, no pathing.
            if (bare.toLowerCase().startsWith("look_")) {
                sendAck(id);
                try {
                    LocalPlayer me = mc.player;
                    if (me == null) { sendError(id, "not in a world"); return; }
                    String[] bits = bare.split("\\s+");
                    String verb = bits[0].toLowerCase();
                    if (verb.equals("look_turn") && bits.length > 1) {
                        me.setYRot(me.getYRot() + Float.parseFloat(bits[1]));
                        sendFinished(id);
                    } else if (verb.equals("look_pitch") && bits.length > 1) {
                        me.setXRot(Math.max(-90f, Math.min(90f, Float.parseFloat(bits[1]))));
                        sendFinished(id);
                    } else if (verb.equals("look_at") && bits.length > 1) {
                        net.minecraft.world.entity.player.Player who = null;
                        for (net.minecraft.world.entity.player.Player p2 : mc.level.players()) {
                            // ⚠ BOTH NAMES. this used to match `getName()` only,
                            // which is the RENDERED name - so on a server with no
                            // rank plugin it worked, and on one with a rank plugin
                            // "look at the person who just spoke" could not find
                            // the person who just spoke.
                            if (p2 != me && matchesPlayerName(p2, bits[1])) { who = p2; break; }
                        }
                        if (who == null) { sendError(id, "can't see " + bits[1] + " from here"); return; }
                        // aim once immediately so the turn starts this tick even if
                        // she is mid-path (where the gaze itself stands down), then
                        // HOLD it - see gazeTick. a single write is gone by the next
                        // tick, which is why "look at me while you talk" never worked.
                        double dx = who.getX() - me.getX();
                        double dy = (who.getY() + who.getEyeHeight()) - (me.getY() + me.getEyeHeight());
                        double dz = who.getZ() - me.getZ();
                        double flat = Math.sqrt(dx * dx + dz * dz);
                        me.setYRot((float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
                        me.setXRot((float) -Math.toDegrees(Math.atan2(dy, flat)));
                        long hold = GAZE_DEFAULT_MS;
                        if (bits.length > 2) {
                            try { hold = (long) (Float.parseFloat(bits[2]) * 1000f); } catch (Throwable ignored) { }
                        }
                        startGaze(bits[1], hold);
                        sendFinished(id);
                    } else if (verb.equals("look_away")) {
                        // let go of somebody's eye on purpose - the end of a
                        // conversation, not an error.
                        endGaze();
                        sendFinished(id);
                    } else {
                        sendError(id, "unknown look command");
                    }
                } catch (Throwable t) {
                    sendError(id, "look failed: " + t.getMessage());
                }
                return;
            }
            // EAT NOW. not an altoclef @command: `@food <n>` only means "end up
            // holding n food", so with bread already in the pack it finishes
            // instantly having eaten nothing - burnt reported "ate" while
            // starving. this drives the FoodChain's own fillup instead, so she
            // actually eats what she is carrying. fails honestly when empty.
            if (bare.equalsIgnoreCase("eat_now")) {
                sendAck(id);
                try {
                    AltoClef mod = exec.getMod();
                    if (mod == null || mod.getFoodChain() == null) {
                        sendError(id, "food chain not ready");
                        return;
                    }
                    if (!mod.getFoodChain().requestEat(mod)) {
                        sendError(id, "nothing edible in the inventory");
                        return;
                    }
                    // THE FLAG IS ONLY READ WHILE THE TASK RUNNER IS ON. the food
                    // chain does its eating inside getPriority(), and the runner
                    // skips every chain while it is disabled - which is exactly
                    // whenever no user task is running. so setting the fillup flag
                    // while burnt was idle ate nothing at all, forever, and the
                    // node side kept reissuing eat into that void until she was a
                    // statue. when she is idle, park a user task whose only job is
                    // to keep the runner awake until the food is down.
                    if (mod.getTaskRunner().isActive()) {
                        sendFinished(id);
                    } else {
                        EatNowTask eat = new EatNowTask();
                        mod.runUserTask(eat, () -> {
                            if (eat.ate()) sendFinished(id);
                            else sendError(id, "could not get the food down - something interrupted the eat");
                        });
                    }
                } catch (Throwable t) {
                    sendError(id, "eat failed: " + t.getMessage());
                }
                return;
            }
            sendAck(id);
            try {
                exec.executeWithPrefix(bare, () -> sendTaskOutcome(id), ex -> sendError(id, ex.getMessage()));
            } catch (Throwable t) {
                sendError(id, "exec failed: " + t.getMessage());
            }
        });
    }

    // send a raw line into the game: '#' -> baritone, '@' -> altoclef, else chat.
    // altoclef/baritone client mixins intercept their own prefixes before the
    // line reaches the server, so nothing leaks to public chat for those.
    private void runChat(String id, String text) {
        if (text == null || text.isEmpty()) {
            sendError(id, "empty chat line");
            return;
        }
        // manual control: plain chat still flows (she can talk while the human
        // plays), but bot-driving lines (@altoclef / #baritone) are refused
        if (manualControl && (text.startsWith("@") || text.startsWith("#"))) {
            sendError(id, "manual control is on (f1) - the operator has the keyboard right now");
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            LocalPlayer p = mc.player;
            if (p == null) {
                sendError(id, "player not ready - join a world first");
                return;
            }
            if (text.startsWith("@")) {
                CommandExecutor exec = AltoClef.getCommandExecutor();
                if (exec == null) {
                    sendError(id, "altoclef not ready");
                    return;
                }
                sendAck(id);
                exec.execute(text, () -> sendTaskOutcome(id), ex -> sendError(id, ex.getMessage()));
                return;
            }
            try {
                sendAck(id);
                // remember her own words BEFORE they go out - the server can echo
                // them back faster than the next line of this method runs
                noteSelfChat(text);
                p.connection.sendChat(text);
                // For normal chat and Baritone # commands this means dispatched,
                // not that an open-ended Baritone goal has completed.
                sendFinished(id);
            } catch (Throwable t) {
                log("chat send failed: " + t.getMessage());
                sendError(id, "chat send failed: " + t.getMessage());
            }
        });
    }

    // ---- outbound: state + events ---------------------------------------

    /**
     * altoclef's Dimension enum -> the vanilla dimension id the node side speaks.
     * the same x/y/z is a different place in each one, so a published container
     * position without this is ambiguous.
     */
    private static String dimensionKey(adris.altoclef.util.Dimension dimension) {
        if (dimension == null) return "minecraft:overworld";
        return switch (dimension) {
            case NETHER -> "minecraft:the_nether";
            case END -> "minecraft:the_end";
            default -> "minecraft:overworld";
        };
    }

    private void pollState() {
        if (this.out == null) return;
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            if (this.out == null) return;
            LocalPlayer p = mc.player;
            if (p == null) {
                resetObservedState();
                sendHelloSnapshot(null, false);
                return;
            }
            try {
                sendHelloSnapshot(p, false);
                JsonObject gs = new JsonObject();
                gs.addProperty("health", Math.round(p.getHealth()));
                gs.addProperty("maxHealth", Math.round(p.getMaxHealth()));
                gs.addProperty("hunger", p.getFoodData().getFoodLevel());

                BlockPos bp = p.blockPosition();
                JsonObject pos = new JsonObject();
                pos.addProperty("x", bp.getX());
                pos.addProperty("y", bp.getY());
                pos.addProperty("z", bp.getZ());
                gs.add("position", pos);

                // 26.1 renamed ResourceKey.location() -> identifier()
                gs.addProperty("dimension", p.level().dimension().identifier().toString());
                // multiplayer truth: which server (if any) this client is on, so
                // burnt's context never has to guess from config intent
                try {
                    net.minecraft.client.multiplayer.ServerData sd = mc.getCurrentServer();
                    boolean multiplayer = sd != null && mc.getSingleplayerServer() == null;
                    gs.addProperty("multiplayer", multiplayer);
                    if (multiplayer && sd.ip != null) gs.addProperty("server", sd.ip);
                    // WHICH SAVE, when there is no server to name. burnt scopes every
                    // spatial memory by world id, and that id was the server address -
                    // so ALL singleplayer worlds shared one identity and one map. two
                    // saves overwrote each other's coastline, claims and landmarks at
                    // matching coordinates. the level name is the only thing that tells
                    // them apart from in here.
                    if (!multiplayer && mc.getSingleplayerServer() != null) {
                        try {
                            String save = mc.getSingleplayerServer().getWorldData().getLevelName();
                            if (save != null && !save.isEmpty()) gs.addProperty("saveName", save);
                        } catch (Throwable ignored) { }
                    }
                } catch (Throwable ignored) { }
                gs.addProperty("onGround", p.onGround());
                gs.addProperty("xpLevel", p.experienceLevel);
                gs.addProperty("selectedItem", p.getMainHandItem().isEmpty() ? "empty" : p.getMainHandItem().getItem().toString());
                gs.addProperty("offhandItem", p.getOffhandItem().isEmpty() ? "empty" : p.getOffhandItem().getItem().toString());
                // remaining durability of the held tool, so burnt knows when a pickaxe is about to break
                ItemStack mainHand = p.getMainHandItem();
                if (!mainHand.isEmpty() && mainHand.isDamageableItem()) {
                    gs.addProperty("mainHandDurability", mainHand.getMaxDamage() - mainHand.getDamageValue());
                    gs.addProperty("mainHandMaxDurability", mainHand.getMaxDamage());
                }
                gs.addProperty("air", p.getAirSupply());
                gs.addProperty("maxAir", p.getMaxAirSupply());
                gs.addProperty("inLava", p.isInLava());
                gs.addProperty("inWater", p.isInWater());
                gs.addProperty("underwater", p.isUnderWater());
                // Home-site selection needs to distinguish an open building site
                // from a cave or overhang. The wider clearEdge survey below answers
                // "is there room?"; this answers "is it actually outdoors?".
                try { gs.addProperty("skyVisible", mc.level.canSeeSky(bp.above())); } catch (Throwable ignored) { }
                // HOW DARK IT IS WHERE SHE IS STANDING, and how far under the surface.
                // two single lookups apiece - nothing next to the ~8600 block reads
                // this poll already does - and between them they separate "in a cave",
                // "in a dark corner of her own house" and "outside at night", which
                // skyVisible alone cannot: it is false for all three.
                try { gs.addProperty("lightLevel", mc.level.getMaxLocalRawBrightness(bp)); } catch (Throwable ignored) { }
                try {
                    int surface = mc.level.getHeightmapPos(
                        net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, bp).getY();
                    gs.addProperty("depthBelowSurface", surface - bp.getY());
                } catch (Throwable ignored) { }
                try { gs.add("homeSite", homeSite(mc, p)); } catch (Throwable ignored) { }
                // OVER water without being IN it. baritone refuses to swim (see the
                // water settings) so when it must cross an ocean it BRIDGES - and a
                // bot standing on a one-block dirt bridge in the middle of the sea is
                // dry, on the ground, and invisible to every water check there is.
                // that is how she ended up parked on a bridge doing nothing with the
                // whole water-escape system asleep. report it so the controller can
                // learn the route is ocean and get her off it.
                gs.addProperty("overWater", isOverWater(mc, p));
                // whether she is ACTUALLY eating right now, and whether altoclef
                // considers her hungry. without these the node side cannot tell a
                // real eat from an `@food` that finished having done nothing.
                try {
                    AltoClef acMod = AltoClef.getCommandExecutor() != null
                        ? AltoClef.getCommandExecutor().getMod() : null;
                    if (acMod != null && acMod.getFoodChain() != null) {
                        gs.addProperty("eating", acMod.getFoodChain().isTryingToEat());
                        gs.addProperty("needsToEat", acMod.getFoodChain().needsToEat());
                        gs.addProperty("hasFood", acMod.getFoodChain().hasFood());
                    }
                } catch (Throwable ignored) { }

                // 1.21.5+ removed PlayerInventory.armor - equipment now lives on the
                // EntityEquipment map, read one armor slot at a time.
                JsonArray armor = new JsonArray();
                for (EquipmentSlot slot : ARMOR_SLOTS) {
                    ItemStack st = p.getItemBySlot(slot);
                    if (st != null && !st.isEmpty()) armor.add(st.getItem().toString());
                }
                gs.add("armor", armor);

                // full inventory summary (counts per item type) so burnt knows what
                // she's carrying / can craft without reading it off-screen. the cap
                // used to be 18, which silently hid the tail of a loaded bag; a 36
                // slot inventory can hold at most 36 distinct types, so INV_MAX_TYPES
                // is a safety bound rather than a real truncation. inventoryTypes is
                // the TRUE distinct count and inventoryFree the empty slot count, so
                // burnt can tell a complete readout from a clipped one and know when
                // she is out of room instead of guessing.
                try {
                    JsonArray items = new JsonArray();
                    java.util.LinkedHashMap<String, Integer> counts = new java.util.LinkedHashMap<>();
                    int diamondCount = 0;
                    int freeSlots = 0;
                    for (ItemStack st : p.getInventory().getNonEquipmentItems()) {
                        if (st == null || st.isEmpty()) { freeSlots++; continue; }
                        counts.merge(st.getItem().toString(), st.getCount(), Integer::sum);
                        if ("minecraft:diamond".equals(BuiltInRegistries.ITEM.getKey(st.getItem()).toString())) {
                            diamondCount += st.getCount();
                        }
                    }
                    int n = 0;
                    for (java.util.Map.Entry<String, Integer> e : counts.entrySet()) {
                        if (n++ >= INV_MAX_TYPES) break;
                        items.add(e.getValue() + " " + e.getKey());
                    }
                    gs.add("inventory", items);
                    gs.addProperty("inventoryTypes", counts.size());
                    gs.addProperty("inventoryFree", freeSlots);
                    String inventorySignature = items.toString();
                    if (!inventorySignature.equals(lastInventorySignature)) {
                        lastInventorySignature = inventorySignature;
                        JsonObject inventoryChange = new JsonObject();
                        inventoryChange.add("inventory", items);
                        sendEvent("inventory_change", inventoryChange);
                    }
                    // Do not announce diamonds already present when joining a
                    // world, but celebrate a real inventory increase afterward.
                    if (lastDiamondCount >= 0 && diamondCount > lastDiamondCount) {
                        JsonObject diamonds = new JsonObject();
                        diamonds.addProperty("amount", diamondCount - lastDiamondCount);
                        diamonds.addProperty("total", diamondCount);
                        diamonds.add("position", pos);
                        sendEvent("diamond_found", diamonds);
                    }
                    lastDiamondCount = diamondCount;
                } catch (Throwable t) { /* inventory optional */ }

                // WHAT IS IN HER CHESTS.
                //
                // altoclef already snapshots a container's entire contents on every
                // client tick its screen is open, and keeps that snapshot after the
                // screen closes - but the tally never left the game. so burnt decided
                // "i need more bread" from her CARRIED inventory alone and farmed
                // forever past 500 loaves sitting in a chest. this publishes the cache
                // she already has.
                //
                // ⚠ AN ABSENT `containers` KEY MEANS "CANNOT TELL", NEVER "NOTHING IS
                // STORED". on any failure below the key is omitted entirely - an empty
                // array is a claim about the world, and a read that just broke is not
                // entitled to make it.
                // ⚠ DOUBLE CHESTS DOUBLE-COUNT. the tracker keys off the single block
                // that was clicked but tallies the whole 54-slot menu onto that one
                // position, so opening the other half later produces a SECOND entry at
                // a different position with identical contents. never sum these blind.
                // ⚠ A SHULKER BOX INSIDE A CHEST is a single `*_shulker_box` item here.
                // its contents are never inspected and are not represented at all.
                // ⚠ THE ENDER CHEST IS DELIBERATELY OMITTED. altoclef's ender cache is
                // one unscoped global - the same contents reachable from every ender
                // chest in the world - so emitting it at a position would be a lie
                // about where those items are.
                // ⚠ getCachedContainers() MUTATES: reading it prunes entries whose
                // block has since been broken. safe here ONLY because pollState runs
                // inside mc.execute(), i.e. the same client thread that writes it.
                try {
                    CommandExecutor storageExec = AltoClef.getCommandExecutor();
                    AltoClef storageMod = storageExec != null ? storageExec.getMod() : null;
                    if (storageMod != null && storageMod.getItemStorage() != null) {
                        adris.altoclef.util.Dimension here = adris.altoclef.util.helpers.WorldHelper.getCurrentDimension();
                        java.util.List<adris.altoclef.trackers.storage.ContainerCache> caches =
                                new java.util.ArrayList<>(storageMod.getItemStorage().getCachedContainers());
                        // nearest first, and this dimension ahead of any other - a
                        // chest 40 blocks away matters more than one in the nether.
                        caches.sort(java.util.Comparator
                                .<adris.altoclef.trackers.storage.ContainerCache>comparingInt(c -> c.getDimension() == here ? 0 : 1)
                                .thenComparingDouble(c -> c.getBlockPos().distToCenterSqr(p.position())));
                        JsonArray containers = new JsonArray();
                        int emitted = 0;
                        for (adris.altoclef.trackers.storage.ContainerCache cache : caches) {
                            if (emitted >= CONTAINERS_MAX) break;
                            if (cache.getContainerType() == adris.altoclef.trackers.storage.ContainerType.ENDER_CHEST) continue;
                            BlockPos cpos = cache.getBlockPos();
                            JsonObject entry = new JsonObject();
                            entry.addProperty("dim", dimensionKey(cache.getDimension()));
                            entry.addProperty("x", cpos.getX());
                            entry.addProperty("y", cpos.getY());
                            entry.addProperty("z", cpos.getZ());
                            // PUBLISH THE TYPE. this cache holds furnaces, brewing
                            // stands, hoppers and dispensers too, and "the chest at X
                            // has 8 coal" when X is really a furnace's fuel slot is a
                            // lie burnt would act on.
                            entry.addProperty("type", cache.getContainerType().name());
                            entry.addProperty("empty", cache.getEmptySlotCount());
                            entry.addProperty("full", cache.isFull());
                            // HOW OLD THESE NUMBERS ARE. a cache is only refreshed
                            // while its screen is open and survives an unloaded chunk,
                            // so this can be hours stale - `@peek x y z` re-reads one.
                            entry.addProperty("at", cache.lastUpdated());
                            java.util.List<java.util.Map.Entry<net.minecraft.world.item.Item, Integer>> tallies =
                                    new java.util.ArrayList<>(cache.getItemCounts().entrySet());
                            // biggest counts first, so a clipped list still answers
                            // "have i got a lot of X stored".
                            tallies.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));
                            JsonObject itemsObj = new JsonObject();
                            int listed = 0;
                            for (java.util.Map.Entry<net.minecraft.world.item.Item, Integer> tally : tallies) {
                                if (listed++ >= CONTAINER_ITEMS_MAX) break;
                                itemsObj.addProperty(BuiltInRegistries.ITEM.getKey(tally.getKey()).toString(), tally.getValue());
                            }
                            entry.add("items", itemsObj);
                            containers.add(entry);
                            emitted++;
                        }
                        gs.add("containers", containers);
                    }
                } catch (Throwable t) { /* container readout is best-effort - omit rather than lie */ }

                // live altoclef task readout - the "what am i actually doing right now".
                // the root task carries the high-level goal + phase (e.g. a @gamer run
                // reads "beating the game.: getting blaze rods"), the deepest task carries
                // the concrete micro-action. always send both (empty when idle) so a
                // finished task self-clears on burnt's side instead of lingering stale.
                try {
                    String botTask = "";
                    String botAction = "";
                    JsonArray botTaskPath = new JsonArray();
                    int depth = 0;
                    adris.altoclef.commandsystem.CommandExecutor exec = AltoClef.getCommandExecutor();
                    AltoClef acMod = exec != null ? exec.getMod() : null;
                    if (acMod != null && acMod.getTaskRunner() != null
                            && acMod.getTaskRunner().getCurrentTaskChain() != null) {
                        java.util.List<adris.altoclef.tasksystem.Task> chain =
                                acMod.getTaskRunner().getCurrentTaskChain().getTasks();
                        if (chain != null && !chain.isEmpty()) {
                            depth = chain.size();
                            botTask = String.valueOf(chain.get(0));
                            botAction = String.valueOf(chain.get(chain.size() - 1));
                            for (adris.altoclef.tasksystem.Task task : chain) {
                                botTaskPath.add(String.valueOf(task));
                            }
                        }
                    }
                    gs.addProperty("botTask", botTask);
                    gs.addProperty("botAction", botAction);
                    gs.add("botTaskPath", botTaskPath);
                    gs.addProperty("botTaskDepth", depth);
                } catch (Throwable t) { /* task readout is best-effort */ }

                if (mc.level != null) {
                    // 26.1 replaced Level.getDayTime() with the data-driven world
                    // clocks. the overworld clock is the day/night cycle and reads
                    // sanely from every dimension, matching the old behavior.
                    long tod = mc.level.getOverworldClockTime() % 24000L;
                    boolean isNight = tod >= 12000L;
                    String dimension = p.level().dimension().identifier().toString();
                    String weather = mc.level.isThundering() ? "thunder" : (mc.level.isRaining() ? "rain" : "clear");
                    gs.addProperty("timeOfDay", isNight ? "night" : "day");
                    gs.addProperty("weather", weather);
                    // GLOBAL weather is not the same as GETTING RAINED ON. A
                    // desert, the nether, a cave and her own finished roof all
                    // report "rain" while she stays perfectly dry, so shelter
                    // behaviour driven off the string alone would march her home
                    // out of a sandstorm-free desert or refuse to let her leave a
                    // house it is not raining on. isRainingAt is biome-, sky- and
                    // heightmap-aware: it answers the question actually being asked.
                    boolean wetHere = false;
                    try { wetHere = mc.level.isRainingAt(bp); } catch (Throwable ignored) { }
                    gs.addProperty("rainingHere", wetHere);

                    // WHAT THE SKY IS DOING. she could tell "day" from "night" and
                    // nothing else, so the two most photogenic minutes of a minecraft
                    // day - the sun going down and coming up - were the same fact as
                    // noon to her. overworld only: the nether has no sky and the end's
                    // is a fixed void, so a day/night phase there would be a lie.
                    if ("minecraft:overworld".equals(dimension)) {
                        // ⚠ THE SAME CLOCK AS `tod` ABOVE. an earlier version read
                        // getGameTime() here, which is total elapsed ticks and is NOT
                        // what /time set moves - so on any world where the time had
                        // ever been set, the moon reported by this line and the sky
                        // reported by the next disagreed about what day it was.
                        long clock = mc.level.getOverworldClockTime();
                        // vanilla: DimensionType.moonPhase(t) = (int)(t / 24000L % 8L),
                        // and index 0 is the FULL moon (the moon texture atlas is
                        // ordered full -> waning -> new -> waxing). node decodes the
                        // index to a name; the number is sent raw so the naming table
                        // has exactly one home.
                        gs.addProperty("moonPhase", (int)((clock / 24000L) % 8L));

                        // how long she has before the light goes. sunset starts at
                        // 12000, a full day is 24000 ticks at 20/s, so a whole day is
                        // 600s of daylight. clamped at 0 once it is already past.
                        gs.addProperty("secondsUntilSunset", Math.max(0L, 12000L - tod) / 20L);

                        // ⚠ THESE BOUNDARIES ARE VANILLA'S, NOT ROUND NUMBERS. the day
                        // starts at sunrise (0), noon is 6000, sunset BEGINS at 12000,
                        // mobs start spawning around 13000, midnight is 18000, and the
                        // sun starts coming back up at 23000. a first pass here spread
                        // the phases evenly across the 24000 and called tod 0-2000
                        // "night" - i.e. it labelled sunrise and the whole first hour
                        // of the morning as darkness, which is when she is most often
                        // outdoors.
                        String skyColorPhase;
                        if (tod < 1000L)            skyColorPhase = "sunrise";
                        else if (tod < 5000L)       skyColorPhase = "morning";
                        else if (tod < 7000L)       skyColorPhase = "midday";
                        else if (tod < 11000L)      skyColorPhase = "afternoon";
                        else if (tod < 12000L)      skyColorPhase = "golden_hour";
                        else if (tod < 13000L)      skyColorPhase = "sunset";
                        else if (tod < 14000L)      skyColorPhase = "dusk";
                        else if (tod < 22000L)      skyColorPhase = "night";
                        else                        skyColorPhase = "predawn";
                        gs.addProperty("skyColorPhase", skyColorPhase);
                    }
                    if (!lastDimension.isEmpty() && !dimension.equals(lastDimension)) {
                        JsonObject changed = new JsonObject();
                        changed.addProperty("dimension", dimension);
                        changed.add("position", pos);
                        sendEvent("dimension_changed", changed);
                    }
                    if (!lastWeather.isEmpty() && !weather.equals(lastWeather)) {
                        JsonObject changed = new JsonObject();
                        changed.addProperty("weather", weather);
                        // the reaction wants to know whether it is landing on HER,
                        // not just whether the sky changed its mind somewhere.
                        changed.addProperty("rainingHere", wetHere);
                        changed.addProperty("skyVisible", mc.level.canSeeSky(bp.above()));
                        sendEvent("weather_changed", changed);
                    }
                    lastDimension = dimension;
                    lastWeather = weather;
                    try {
                        gs.addProperty("biome", mc.level.getBiome(bp).unwrapKey()
                            .map(key -> key.identifier().toString()).orElse("unknown"));
                    } catch (Throwable ignored) { }

                    try {
                        // This runs on Minecraft's client thread. A previous
                        // implementation searched the world three times (16,
                        // 32, and 12 blocks) every telemetry tick. One broad
                        // query plus cheap box checks reports the same facts
                        // without repeated entity-list allocation/scanning.
                        AABB playerBox = p.getBoundingBox();
                        AABB hostileRange = playerBox.inflate(16.0);
                        AABB creeperRange = playerBox.inflate(12.0);
                        java.util.List<net.minecraft.world.entity.Entity> nearby = mc.level.getEntities(p,
                            playerBox.inflate(32.0), entity -> entity.isAlive());
                        int nearbyHostiles = 0;
                        int nearbyPlayers = 0;
                        int foodAnimals = 0;
                        int villagers = 0;
                        boolean creeperNearby = false;
                        java.util.LinkedHashSet<String> uniqueTypes = new java.util.LinkedHashSet<>();
                        java.util.LinkedHashSet<String> playerNames = new java.util.LinkedHashSet<>();
                        // EVERY KIND SHE IS STANDING NEAR, for the bestiary host-side
                        // keeps. Deliberately wider than the ranked list below: the cow
                        // she will never remark on still counts towards "kinds of
                        // creature i have actually met here", the same way a biome she
                        // walks through counts towards country she has stood in.
                        java.util.LinkedHashSet<String> creatureTypes = new java.util.LinkedHashSet<>();
                        java.util.List<NearbyCreature> creatures = new java.util.ArrayList<>();
                        java.util.List<NearbyPerson> people = new java.util.ArrayList<>();
                        float yaw = p.getYRot();
                        for (net.minecraft.world.entity.Entity entity : nearby) {
                            String path = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).getPath();
                            // the ranked readout is about CREATURES. arrows, orbs, boats
                            // and item frames are all "alive" by the filter above and
                            // none of them is somebody she can react to.
                            if (entity instanceof net.minecraft.world.entity.LivingEntity living
                                    && !(entity instanceof Player)) {
                                if (creatureTypes.size() < CREATURE_TYPES_MAX) creatureTypes.add(path);
                                double dist = p.distanceTo(entity);
                                boolean named = entity.hasCustomName();
                                boolean baby = living.isBaby();
                                boolean tame = entity instanceof net.minecraft.world.entity.TamableAnimal pet
                                        && pet.isTame();
                                boolean isHostile = entity instanceof Monster;
                                // IS IT ACTUALLY COMING FOR HER, or is it just in the
                                // room? Different scene, and the count alone cannot
                                // tell them apart. `getTarget()` would be the exact
                                // answer and it is server-side - a client mod never
                                // sees it - but `isAggressive()` rides the synced
                                // entity flags, so it costs a field read and is true
                                // for the case that matters: a provoked enderman is a
                                // moment, an enderman minding its own business is
                                // scenery.
                                boolean aggro = entity instanceof net.minecraft.world.entity.Mob mob
                                        && mob.isAggressive();
                                creatures.add(new NearbyCreature(
                                        entity.getId(), path, dist,
                                        relativeDirection(entity.getX() - p.getX(),
                                                entity.getZ() - p.getZ(), yaw),
                                        entity.getY() - p.getY(), isHostile, baby, tame, aggro,
                                        named ? entity.getCustomName().getString() : "",
                                        creatureNotability(path, named, baby, tame, isHostile, aggro, dist)));
                            }
                            if (entity instanceof Player other) {
                                nearbyPlayers++;
                                if (playerNames.size() < 8) {
                                    try { playerNames.add(other.getGameProfile().name()); } catch (Throwable ignored) { }
                                }
                                // ...and now keep the rest of what the sweep already
                                // knows about them, instead of throwing it away and
                                // reporting "1 players".
                                try { people.add(describePerson(p, other, yaw, nearby)); } catch (Throwable ignored) { }
                            }
                            if (entity instanceof Monster hostile && hostileRange.intersects(hostile.getBoundingBox())) {
                                nearbyHostiles++;
                                if (uniqueTypes.size() < 8) {
                                    uniqueTypes.add(BuiltInRegistries.ENTITY_TYPE.getKey(hostile.getType()).toString());
                                }
                            }
                            if (entity instanceof Creeper && creeperRange.intersects(entity.getBoundingBox())) {
                                creeperNearby = true;
                            }
                            // DINNER. counted by registry name rather than an Animal
                            // instanceof, because the animal classes live in per-type
                            // subpackages that move between versions and a registry key
                            // does not. a pasture is a food source she can walk back to,
                            // which is the point: when the fields are bare she still has
                            // somewhere to go.
                            if (FOOD_ANIMALS.contains(path)) {
                                foodAnimals++;
                            }
                            // A VILLAGE, told apart from a player's base. surveyBuiltGround
                            // can see that somebody built here and cannot say WHO - so
                            // "built ground" covered a village, a spawn town and a
                            // stranger's house identically, and burnt's only use for any
                            // of them was to walk away. villagers are what make it a
                            // village, and that is worth knowing for reasons other than
                            // avoidance. counted by registry key, never instanceof: the
                            // entity classes move between versions and a key does not.
                            // folded into the sweep that already runs - no new scan.
                            if (VILLAGE_ENTITIES.contains(path)) {
                                villagers++;
                            }
                        }
                        // ⚠ THESE TWO ARRAYS ARE SENT ON EVERY POLL EVEN WHEN EMPTY.
                        // The bridge merges gameState with Object.assign, so a field
                        // that simply stops being sent keeps its last value forever -
                        // which for this data means a creeper that despawned three
                        // minutes ago is still reported four blocks behind her.
                        JsonArray creatureArr = new JsonArray();
                        for (NearbyCreature c : selectCreatures(creatures, CREATURES_MAX)) {
                            JsonObject co = new JsonObject();
                            co.addProperty("type", c.path());
                            co.addProperty("dist", Math.round(c.dist() * 10.0) / 10.0);
                            co.addProperty("dir", c.dir());
                            if (Math.abs(c.dy()) >= ELEVATION_NOTE) {
                                co.addProperty("vert", c.dy() > 0 ? "above" : "below");
                            }
                            if (c.score() >= NOTABLE_SCORE) co.addProperty("notable", true);
                            // sent as its own flag rather than left implicit in the
                            // score: host-side wants to treat "a warden is here" as a
                            // scene in its own right, and a threshold on a number that
                            // may be retuned is not a thing to hang that on.
                            if (BOSS_CREATURES.contains(c.path())) co.addProperty("boss", true);
                            if (c.hostile()) co.addProperty("hostile", true);
                            if (c.aggro()) co.addProperty("aggro", true);
                            if (c.baby()) co.addProperty("baby", true);
                            if (c.tame()) co.addProperty("tame", true);
                            if (!c.name().isEmpty()) co.addProperty("name", c.name());
                            creatureArr.add(co);
                        }
                        gs.add("nearbyCreatures", creatureArr);
                        JsonArray creatureTypeArr = new JsonArray();
                        for (String type : creatureTypes) creatureTypeArr.add(type);
                        gs.add("nearbyCreatureTypes", creatureTypeArr);
                        gs.addProperty("nearbyHostiles", nearbyHostiles);
                        gs.addProperty("nearbyPlayers", nearbyPlayers);
                        gs.addProperty("foodAnimals", foodAnimals);
                        gs.addProperty("villagers", villagers);
                        JsonArray playerNameArr = new JsonArray();
                        for (String name : playerNames) playerNameArr.add(name);
                        gs.add("nearbyPlayerNames", playerNameArr);
                        // WHO IS ACTUALLY STANDING THERE, nearest first - the same
                        // shape as nearbyCreatures, for the same reason.
                        //
                        // ⚠ SENT EVERY POLL EVEN WHEN EMPTY. the bridge merges
                        // gameState with Object.assign, so a field that stops being
                        // sent keeps its last value forever: somebody who logged off
                        // three minutes ago would still read as stood beside her.
                        people.sort(java.util.Comparator.comparingDouble(NearbyPerson::dist));
                        JsonArray peopleArr = new JsonArray();
                        for (NearbyPerson person : people) {
                            if (peopleArr.size() >= PEOPLE_MAX) break;
                            JsonObject po = new JsonObject();
                            po.addProperty("name", person.name());
                            if (!person.display().isEmpty() && !person.display().equals(person.name())) {
                                po.addProperty("display", person.display());
                            }
                            po.addProperty("dist", Math.round(person.dist() * 10.0) / 10.0);
                            po.addProperty("dir", person.dir());
                            // same rule the creature readout uses: only report a
                            // height difference big enough to be worth a word.
                            if (Math.abs(person.dy()) >= 3.0) {
                                po.addProperty("vert", person.dy() > 0 ? "above" : "below");
                            }
                            if (person.watching()) po.addProperty("watching", true);
                            if (person.sneaking()) po.addProperty("sneaking", true);
                            if (person.onFire()) po.addProperty("onFire", true);
                            if (person.hurt()) po.addProperty("hurt", true);
                            if (person.threats() > 0) po.addProperty("threats", person.threats());
                            if (!person.holding().isEmpty()) po.addProperty("holding", person.holding());
                            peopleArr.add(po);
                        }
                        gs.add("nearbyPeople", peopleArr);
                        JsonArray hostileTypes = new JsonArray();
                        for (String type : uniqueTypes) hostileTypes.add(type);
                        gs.add("nearbyHostileTypes", hostileTypes);
                        if (nearbyHostiles > 0 && (lastNearbyHostiles == 0 ||
                                System.currentTimeMillis() - lastHostileEventAt > 30000L)) {
                            lastHostileEventAt = System.currentTimeMillis();
                            JsonObject hostileEvent = new JsonObject();
                            hostileEvent.addProperty("count", nearbyHostiles);
                            hostileEvent.add("types", hostileTypes);
                            // WHICH WAY THE NEAREST ONE IS. a count with no bearing
                            // reads the same whether they are thirty blocks off
                            // behind a hill or one step behind her, so the reaction
                            // had nothing to be about. this costs nothing - the sweep
                            // above already measured every one of them.
                            creatures.stream().filter(NearbyCreature::hostile)
                                    .min(java.util.Comparator.comparingDouble(NearbyCreature::dist))
                                    .ifPresent(closest -> {
                                        hostileEvent.addProperty("nearestType", closest.path());
                                        hostileEvent.addProperty("nearestDist",
                                                Math.round(closest.dist() * 10.0) / 10.0);
                                        hostileEvent.addProperty("nearestDir", closest.dir());
                                        if (closest.aggro()) hostileEvent.addProperty("aggro", true);
                                    });
                            sendEvent("hostiles_nearby", hostileEvent);
                        }
                        lastNearbyHostiles = nearbyHostiles;
                        if (creeperNearby && System.currentTimeMillis() - lastCreeperEventAt > 15000L) {
                            lastCreeperEventAt = System.currentTimeMillis();
                            sendEvent("creeper_spotted", new JsonObject());
                        }
                    } catch (Throwable ignored) { }

                    // THE TAB LIST IS THE ROOM. see lastOnlineNames.
                    try {
                        java.util.Set<String> online = onlineNames(mc);
                        gs.addProperty("onlinePlayers", online.size());
                        JsonArray onlineArr = new JsonArray();
                        int listed = 0;
                        for (String name : online) {
                            if (listed++ >= 24) break;
                            onlineArr.add(name);
                        }
                        gs.add("onlinePlayerNames", onlineArr);
                        java.util.Set<String> before = lastOnlineNames;
                        // FIRST SIGHTING IS NOT AN ARRIVAL. the whole server is
                        // "new" on the poll after she logs in, and announcing a
                        // dozen joins she never saw happen is the seeding bug every
                        // watcher in this codebase has had once. seed silently.
                        if (before != null) {
                            for (String name : online) {
                                if (!before.contains(name)) sendPlayerRosterEvent("player_joined", name, online.size());
                            }
                            for (String name : before) {
                                if (!online.contains(name)) sendPlayerRosterEvent("player_left", name, online.size());
                            }
                        }
                        lastOnlineNames = online;
                    } catch (Throwable ignored) { }

                    try {
                        // nearby-resource affordance scan. the poll is ~every 2s (not per-tick),
                        // so a small box is cheap: read-only, reports nearest ores/logs/water/lava
                        // and utility blocks so burnt can command by what's physically around her
                        // ("mine the iron 5m down", "there's a chest right there") instead of
                        // guessing. never touches gameplay.
                        final int R = 8, RY = 5;
                        java.util.LinkedHashMap<String, Integer> oreCounts = new java.util.LinkedHashMap<>();
                        String nearestOre = null;
                        double nearestOreD = Double.MAX_VALUE, logsD = Double.MAX_VALUE, waterD = Double.MAX_VALUE,
                               lavaD = Double.MAX_VALUE, craftD = Double.MAX_VALUE, furnaceD = Double.MAX_VALUE,
                               chestD = Double.MAX_VALUE, bedD = Double.MAX_VALUE,
                               smokerD = Double.MAX_VALUE, campfireD = Double.MAX_VALUE, hayD = Double.MAX_VALUE;
                        // ⚠ RIPE IS A SEPARATE FACT FROM PRESENT, and reporting only the
                        // second is what marched her to a harvested field forever. the block
                        // id `wheat` covers age 0 through 7; AltoClef refuses to break
                        // anything short of max age (CollectCropTask.validCrop), so a field
                        // she just harvested and replanted still read as "wheat here!" while
                        // being worth exactly nothing. count both, send both.
                        // index: 0 wheat, 1 carrots, 2 potatoes, 3 beetroots, 4 berries
                        final String[] cropIds = { "wheat", "carrots", "potatoes", "beetroots", "sweet_berry_bush" };
                        final String[] cropKeys = { "wheat", "carrot", "potato", "beetroot", "berries" };
                        double[] cropD = { Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE };
                        int[] cropCount = new int[cropIds.length];
                        int[] cropRipe = new int[cropIds.length];
                        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
                        int bx = bp.getX(), by = bp.getY(), bz = bp.getZ();
                        for (int dx = -R; dx <= R; dx++) for (int dz = -R; dz <= R; dz++) for (int dy = -RY; dy <= RY; dy++) {
                            m.set(bx + dx, by + dy, bz + dz);
                            var state = mc.level.getBlockState(m);
                            if (state.isAir()) continue;
                            String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath();
                            double d2 = bp.distSqr(m);
                            if (id.endsWith("_ore") || id.equals("ancient_debris")) {
                                oreCounts.merge(id, 1, Integer::sum);
                                if (d2 < nearestOreD) { nearestOreD = d2; nearestOre = id; }
                            } else if (id.endsWith("_log")) { if (d2 < logsD) logsD = d2; }
                            else if (id.equals("water")) { if (d2 < waterD) waterD = d2; }
                            else if (id.equals("lava")) { if (d2 < lavaD) lavaD = d2; }
                            else if (id.equals("crafting_table")) { if (d2 < craftD) craftD = d2; }
                            else if (id.equals("furnace") || id.equals("blast_furnace")) { if (d2 < furnaceD) furnaceD = d2; }
                            else if (id.equals("smoker")) { if (d2 < smokerD) smokerD = d2; }
                            else if (id.equals("campfire") || id.equals("soul_campfire")) { if (d2 < campfireD) campfireD = d2; }
                            // a hay bale is nine wheat that needs no growing at all, and
                            // CollectWheatTask already prefers them - so a haystack is a
                            // bread source worth walking to.
                            else if (id.equals("hay_block")) { if (d2 < hayD) hayD = d2; }
                            else if (id.equals("chest") || id.equals("trapped_chest") || id.equals("barrel") || id.equals("ender_chest")) { if (d2 < chestD) chestD = d2; }
                            else if (id.endsWith("_bed")) { if (d2 < bedD) bedD = d2; }
                            else {
                                for (int ci = 0; ci < cropIds.length; ci++) {
                                    if (!id.equals(cropIds[ci])) continue;
                                    cropCount[ci]++;
                                    if (d2 < cropD[ci]) cropD[ci] = d2;
                                    if (isHarvestable(state)) cropRipe[ci]++;
                                    break;
                                }
                            }
                        }
                        JsonObject nb = new JsonObject();
                        if (nearestOre != null) {
                            nb.addProperty("nearestOre", nearestOre);
                            nb.addProperty("nearestOreDist", (int) Math.round(Math.sqrt(nearestOreD)));
                            JsonObject ores = new JsonObject();
                            int oc = 0;
                            for (java.util.Map.Entry<String, Integer> e : oreCounts.entrySet()) {
                                if (oc++ >= 8) break;
                                ores.addProperty(e.getKey(), e.getValue());
                            }
                            nb.add("ores", ores);
                        }
                        if (logsD < Double.MAX_VALUE) nb.addProperty("logs", (int) Math.round(Math.sqrt(logsD)));
                        if (waterD < Double.MAX_VALUE) nb.addProperty("water", (int) Math.round(Math.sqrt(waterD)));
                        if (lavaD < Double.MAX_VALUE) nb.addProperty("lava", (int) Math.round(Math.sqrt(lavaD)));
                        if (craftD < Double.MAX_VALUE) nb.addProperty("craftingTable", (int) Math.round(Math.sqrt(craftD)));
                        if (furnaceD < Double.MAX_VALUE) nb.addProperty("furnace", (int) Math.round(Math.sqrt(furnaceD)));
                        if (chestD < Double.MAX_VALUE) nb.addProperty("chest", (int) Math.round(Math.sqrt(chestD)));
                        if (bedD < Double.MAX_VALUE) nb.addProperty("bed", (int) Math.round(Math.sqrt(bedD)));
                        if (smokerD < Double.MAX_VALUE) nb.addProperty("smoker", (int) Math.round(Math.sqrt(smokerD)));
                        if (campfireD < Double.MAX_VALUE) nb.addProperty("campfire", (int) Math.round(Math.sqrt(campfireD)));
                        if (hayD < Double.MAX_VALUE) nb.addProperty("hay", (int) Math.round(Math.sqrt(hayD)));
                        for (int ci = 0; ci < cropIds.length; ci++) {
                            if (cropD[ci] == Double.MAX_VALUE) continue;
                            // `wheat`/`wheatCount` keep their old names and meanings so an
                            // older burnt reads this jar unchanged; `<crop>Ripe` is the new
                            // fact, and its ABSENCE means "this jar cannot tell", never zero.
                            nb.addProperty(cropKeys[ci], (int) Math.round(Math.sqrt(cropD[ci])));
                            nb.addProperty(cropKeys[ci] + "Count", cropCount[ci]);
                            nb.addProperty(cropKeys[ci] + "Ripe", cropRipe[ci]);
                        }
                        gs.add("nearby", nb);
                    } catch (Throwable ignored) { }

                    // HOW BIG IS THE ROOM SHE IS STANDING IN.
                    // burnt's home has to be a real space - enough clear ground for the
                    // fixed toaster floorplan. node owns that rule; this just measures.
                    // grows a cube outward from head height and stops at
                    // the first shell that is mostly solid, so a cave or a hillside ends
                    // the scan almost immediately and only a genuine hall costs anything.
                    // the floor is deliberately excluded - a room needs one.
                    try { gs.addProperty("clearEdge", clearEdge(mc)); } catch (Throwable ignored) { }
                    // Exact, component-level toaster construction state. Unlike
                    // clearEdge this distinguishes floor/walls/roof, the two top
                    // slots, walk-through, wall torches, the appliance gallery,
                    // and material shortfall.
                    try {
                        JsonObject toaster = ToasterBuildTask.getLatestTelemetry();
                        if (toaster != null) gs.add("settlementBuild", toaster);
                    } catch (Throwable ignored) { }

                    if (isNight && !lastWasNight) sendEvent("nightfall", new JsonObject());
                    lastWasNight = isNight;
                }

                int health = Math.round(p.getHealth());
                int hunger = p.getFoodData().getFoodLevel();
                if (lastHealth >= 0 && health < lastHealth) {
                    JsonObject damage = new JsonObject();
                    damage.addProperty("health", health);
                    damage.addProperty("amount", lastHealth - health);
                    sendEvent("damage_taken", damage);
                }
                boolean dead = p.isDeadOrDying() || health <= 0;
                if (dead && !wasDead) {
                    // ⚠ THE DEATH EVENT USED TO BE AN EMPTY OBJECT, and host-side
                    // `_rememberMilestone` does `data.cause || data.killer || label`
                    // where label is the string "died" - so semantic memory was being
                    // written the sentence "burnt died in minecraft to died at x,y,z".
                    // Asked how she died, that is what she got back, and being killed
                    // by a player was indistinguishable from falling in lava.
                    //
                    // The damage source is available at exactly this moment and knows
                    // all of it, so nothing has to be inferred or waited for. (The
                    // death SCREEN has the same sentence, but it appears later than
                    // this branch fires, which is why reading it there was the wrong
                    // place to look.)
                    JsonObject death = new JsonObject();
                    death.add("position", pos);
                    try {
                        net.minecraft.world.damagesource.DamageSource src = p.getLastDamageSource();
                        if (src != null) {
                            death.addProperty("cause", src.getMsgId());
                            net.minecraft.world.entity.Entity killer = src.getEntity();
                            if (killer != null) {
                                death.addProperty("killer", killer.getName().getString());
                                death.addProperty("killerType",
                                    BuiltInRegistries.ENTITY_TYPE.getKey(killer.getType()).getPath());
                                death.addProperty("byPlayer", killer instanceof Player);
                            }
                            // the real sentence, the one the death screen shows
                            death.addProperty("message", src.getLocalizedDeathMessage(p).getString());
                        }
                    } catch (Throwable ignored) {
                        // a death with no cause is still a death - never let this
                        // throw and lose the event itself
                    }
                    sendEvent("death", death);
                }
                if (!dead && wasDead) {
                    JsonObject respawn = new JsonObject();
                    respawn.add("position", pos);
                    sendEvent("respawn", respawn);
                }
                if (hunger <= 6 && (lastHunger > 6 || System.currentTimeMillis() - lastLowHungerEventAt > 30000L)) {
                    lastLowHungerEventAt = System.currentTimeMillis();
                    JsonObject lowHunger = new JsonObject();
                    lowHunger.addProperty("hunger", hunger);
                    sendEvent("low_hunger", lowHunger);
                }
                lastHealth = health;
                lastHunger = hunger;
                wasDead = dead;

                // ⚠ COMBAT WAS ENTIRELY MUTE. `entity_killed` has a host-side
                // handler, a stats counter, a `recently:` label, an affect delta, a
                // three-minute reasoning gap AND a written cue - and nothing ever
                // emitted it, so she killed the skeleton chasing her and said nothing,
                // ever. The most-watched thing she does had no voice at all.
                //
                // `getLastHurtMob()` is the mob SHE last hit (vanilla keeps it for 100
                // ticks), so a kill needs no entity scan: watch that one entity and
                // report it once when it goes down. Cheap, and it cannot credit her
                // with a kill she had no hand in.
                try {
                    net.minecraft.world.entity.LivingEntity victim = p.getLastHurtMob();
                    if (victim != null && victim.isDeadOrDying()) {
                        int vid = victim.getId();
                        if (vid != lastReportedKillId) {
                            lastReportedKillId = vid;
                            JsonObject killed = new JsonObject();
                            killed.addProperty("type",
                                BuiltInRegistries.ENTITY_TYPE.getKey(victim.getType()).getPath());
                            killed.addProperty("name", victim.getName().getString());
                            killed.addProperty("hostile", victim instanceof Monster);
                            killed.addProperty("player", victim instanceof Player);
                            sendEvent("entity_killed", killed);
                        }
                    } else if (victim == null) {
                        // the 100-tick memory expired: the next kill is a new one even
                        // if the game reuses that entity id.
                        lastReportedKillId = Integer.MIN_VALUE;
                    }
                } catch (Throwable ignored) { }

                JsonObject env = new JsonObject();
                env.addProperty("type", "state");
                env.add("gameState", gs);
                send(env);
            } catch (Throwable t) {
                // never let a state read crash the client tick
                log("state poll failed: " + t.getMessage());
            }
        });
    }

    private void onTaskFinished(TaskFinishedEvent e) {
        if (this.out == null) return;
        JsonObject d = new JsonObject();
        d.addProperty("duration", e.durationSeconds);
        d.addProperty("task", String.valueOf(e.lastTaskRan));
        // present only when the task was torn down rather than completed, so
        // host-side can tell "done" from "gave up" instead of retrying a job
        // that can never finish.
        if (e.abortReason != null) d.addProperty("abortReason", e.abortReason);
        sendEvent("task_finished", d);
    }

    /**
     * She broke a block. Counter + recent line only, throttled to a trickle.
     *
     * A mining trip is thousands of swings; burnt's `recentEvents` keeps eight slots
     * and they hold things like "finished the wheat field" and "MarDotIO asked me for
     * bread". So this is deliberately stingy - it exists so `blocksMined` is a real
     * number and so "mining stone" appears in the recent line at all, not so every
     * cobblestone gets a mention.
     */
    private void onBlockBroken(BlockBrokenEvent e) {
        try {
            if (e == null || e.blockState == null) return;
            Minecraft mc = Minecraft.getInstance();
            // her swings only - another player breaking a block nearby is not her doing
            if (e.player == null || mc.player == null || e.player != mc.player) return;
            long now = System.currentTimeMillis();
            if (now - lastBlockEventAt < 5000L) return;
            lastBlockEventAt = now;
            JsonObject d = new JsonObject();
            d.addProperty("block", BuiltInRegistries.BLOCK.getKey(e.blockState.getBlock()).getPath());
            if (e.blockPos != null) d.add("position", posJson(e.blockPos));
            sendEvent("block_broken", d);
        } catch (Throwable ignored) { }
    }

    /**
     * She walked into a dropped item, which in vanilla is how a pickup happens.
     *
     * Two events come out of this: a throttled `item_collected` (counter + recent
     * line), and an UNTHROTTLED `rare_find` for the short list of things a streamer
     * actually reacts to. `rare_find` already had a cue and a 60s gap host-side and
     * nothing ever emitted it, so the one moment most worth a reaction - the
     * ancient debris, the totem, the elytra - was the one moment she could not see.
     */
    private void onCollidedWithEntity(PlayerCollidedWithEntityEvent e) {
        try {
            if (e == null || !(e.other instanceof net.minecraft.world.entity.item.ItemEntity item)) return;
            Minecraft mc = Minecraft.getInstance();
            if (e.player == null || mc.player == null || e.player != mc.player) return;
            ItemStack stack = item.getItem();
            if (stack == null || stack.isEmpty()) return;
            String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
            long now = System.currentTimeMillis();
            if (RARE_FINDS.contains(id)) {
                JsonObject rare = new JsonObject();
                rare.addProperty("name", id.replace('_', ' '));
                rare.addProperty("item", id);
                rare.addProperty("count", stack.getCount());
                sendEvent("rare_find", rare);
                return;     // a totem is not a routine pickup; don't also count it as one
            }
            if (now - lastPickupEventAt < 4000L) return;
            lastPickupEventAt = now;
            JsonObject d = new JsonObject();
            d.addProperty("item", id);
            d.addProperty("count", stack.getCount());
            sendEvent("item_collected", d);
        } catch (Throwable ignored) { }
    }

    // "Burnt has made the advancement [Stone Age]" / "...completed the challenge
    // [The End?]" / "...reached the goal [Sky's the Limit]". All three verbs, because
    // vanilla uses a different one per advancement frame.
    private static final java.util.regex.Pattern ADVANCEMENT_NOTICE = java.util.regex.Pattern.compile(
        "^(\\S+) has (?:made the advancement|completed the challenge|reached the goal) \\[(.+)\\]$");

    private static String mcPlayerName() {
        try {
            LocalPlayer p = Minecraft.getInstance().player;
            return p == null ? null : p.getName().getString();
        } catch (Throwable ignored) { return null; }
    }

    private static JsonObject posJson(BlockPos bp) {
        JsonObject pos = new JsonObject();
        pos.addProperty("x", bp.getX());
        pos.addProperty("y", bp.getY());
        pos.addProperty("z", bp.getZ());
        return pos;
    }

    // THINGS WORTH A REACTION. Deliberately short: the value of `rare_find` is that
    // it almost never fires, so it never has to be throttled into meaninglessness.
    // Diamonds are absent on purpose - `diamond_found` already covers the ore, and
    // the pickup would double it.
    private static final java.util.Set<String> RARE_FINDS = java.util.Set.of(
        "ancient_debris", "netherite_scrap", "netherite_ingot", "elytra",
        "totem_of_undying", "enchanted_golden_apple", "nether_star", "dragon_egg",
        "trident", "heart_of_the_sea", "music_disc_pigstep", "budding_amethyst"
    );

    private void onChatMessage(ChatMessageEvent e) {
        try {
            emitPlayerChat(e.contentComponent(), e.bound(), e.senderProfile());
        } catch (Throwable ignored) { }
    }

    // THE NAME A SERVER SHOWS IS NOT THE NAME A SERVER STORES.
    //
    // every rank/nick plugin renders "<(Member) » Aereon42> hi" while the mojang
    // account behind that line is something else entirely - GameProfile.name()
    // returned "ShadowAliceZ", a string not one person in that room has ever
    // seen. reading the speaker off the profile made burnt answer Aereon42 as
    // "shadow" and filed ONE human under TWO names (chat under the account name,
    // the join line under the nick, both of them in her roster at once).
    //
    // so the speaker is resolved from the line the client actually RENDERS -
    // params.decorate() is the exact component minecraft draws on screen - and
    // the account name survives only as the last resort, for vanilla servers
    // that decorate nothing.
    private void emitPlayerChat(net.minecraft.network.chat.Component content,
                                net.minecraft.network.chat.ChatType.Bound params,
                                com.mojang.authlib.GameProfile profile) {
        String body = content == null ? "" : content.getString();
        String who = null;
        if (params != null) {
            try {
                java.util.regex.Matcher m = CHAT_SHAPE.matcher(params.decorate(content).getString());
                if (m.matches()) {
                    who = m.group(1) != null ? m.group(1) : m.group(3);
                    String what = m.group(1) != null ? m.group(2) : m.group(4);
                    if (what != null && !what.isBlank()) body = what.trim();
                }
            } catch (Throwable ignored) { }
            // no decoration template matched: the bound name component is still
            // the display name the server sent for this speaker.
            if (who == null) {
                try { who = lastNameToken(params.name().getString()); } catch (Throwable ignored) { }
            }
        }
        if (who == null && profile != null) who = profile.name();
        if (who != null) emitChatEvent(who, body);
    }

    /**
     * Who the tab list says is on the server, by the name people actually call
     * them.
     *
     * Resolved the same way a chat speaker is (see emitPlayerChat): the RENDERED
     * tab entry first, the mojang account name only as a fallback. Taking the
     * profile name outright is what once filed one human under two names - the
     * account behind "Aereon42" is "ShadowAliceZ" - and a greeting has to use the
     * name the room uses or it reads as talking about a stranger.
     *
     * "Listed" rather than every connection: that is the list a human sees, so a
     * vanished admin does not get greeted into a room that cannot see them.
     */
    private static java.util.Set<String> onlineNames(Minecraft mc) {
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        var connection = mc.getConnection();
        if (connection == null) return names;
        String self = null;
        try { self = mc.getGameProfile() == null ? null : mc.getGameProfile().name(); } catch (Throwable ignored) { }
        for (net.minecraft.client.multiplayer.PlayerInfo info : connection.getListedOnlinePlayers()) {
            String name = null;
            try {
                var shown = info.getTabListDisplayName();
                if (shown != null) name = lastNameToken(shown.getString());
            } catch (Throwable ignored) { }
            if (name == null) {
                try { name = info.getProfile().name(); } catch (Throwable ignored) { }
            }
            if (name == null || name.isBlank()) continue;
            // she is not company for herself
            if (self != null && name.equalsIgnoreCase(self)) continue;
            names.add(name);
        }
        return names;
    }

    private void sendPlayerRosterEvent(String event, String player, int onlineCount) {
        JsonObject d = new JsonObject();
        d.addProperty("player", player);
        d.addProperty("online", onlineCount);
        sendEvent(event, d);
    }

    /**
     * "joined the game" / "left the game" and the shapes other servers use for
     * the same thing.
     *
     * These arrive as SYSTEM messages, and the plugin-chat parser matches them
     * perfectly - "&lt;(AI) » SomePlayer&gt; joined the game" is exactly the shape of
     * somebody called SomePlayer saying the words "joined the game". So burnt heard
     * a sentence and answered it, echoing the server back at itself: "left the
     * game. dramatic exit for someone who wasn't even holding a torch" (live,
     * 2026-08-05). The roster diff above reports arrivals properly; this stops
     * the same fact arriving a second time disguised as conversation.
     *
     * Deliberately narrow. "left" and "joined" start plenty of real sentences -
     * "left the base at 5", "joined the discord" - so the notice has to be the
     * WHOLE message, not a prefix of it. Eating somebody's actual line is a worse
     * failure than letting an unusual server's join format through: the roster
     * diff has already reported the arrival either way, so the cost of a miss here
     * is one duplicated cue, and the cost of a false positive is her going deaf to
     * a person mid-sentence.
     */
    private static final java.util.regex.Pattern CONNECTION_NOTICE = java.util.regex.Pattern.compile(
        "^\\s*(?:has\\s+)?(?:joined|left|disconnected|reconnected|quit)"
            + "(?:\\s+the\\s+(?:game|server|world))?\\s*[.!]?\\s*$",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    // "(Member) » Aereon42" / "[VIP] Bob" -> the username at the end. ranks and
    // separators are decoration; the last bare word is the person.
    private static String lastNameToken(String decorated) {
        if (decorated == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("([A-Za-z0-9_]{3,16})\\s*$").matcher(decorated.trim());
        return m.find() ? m.group(1) : null;
    }

    // one funnel for every chat delivery path (signed player chat via the
    // altoclef mixin, unsigned/disguised chat, and plugin-formatted system
    // messages). dedup keeps overlapping hooks from double-reporting a line.
    private void emitChatEvent(String sender, String text) {
        if (this.out == null) return;
        if (sender == null || text == null || sender.isEmpty() || text.isEmpty()) return;
        // ONE TEXT PER LINE, whichever path delivered it. emitPlayerChat only
        // extracts the message body when the decoration regex matches the rendered
        // line; when it misses it falls back to the WHOLE rendered line, while
        // tryParseChatLine hands the same server message over as just the body.
        // two different strings for one thing said, so an exact-match dedup counts
        // two lines and burnt answers both.
        text = stripOwnDecoration(sender, text);
        // a connection notice is not a sentence somebody said. see CONNECTION_NOTICE.
        if (CONNECTION_NOTICE.matcher(text).matches()) return;
        long now = System.currentTimeMillis();
        String key = chatKey(text);
        // her own line coming back off the server is not somebody talking to her
        synchronized (recentSelfChat) {
            recentSelfChat.values().removeIf(at -> now - at > CHAT_ECHO_WINDOW_MS);
            Long mine = recentSelfChat.get(key);
            if (mine != null && now - mine < CHAT_ECHO_WINDOW_MS) return;
        }
        // Dedup on the TEXT alone, across a ring of recent lines.
        //
        // The old key was sender + text held in ONE slot, and it failed twice
        // over: (1) the sender is precisely what differs between delivery paths -
        // one parses `<(Member) > Name>` out of the raw line, another falls back
        // to the fabric-reported sender - so the same sentence under two names
        // never matched; (2) a single slot cannot collapse a three-way fan-out,
        // because path B overwrites path A's key before A's copy repeats.
        // Observed live: one line delivered 4x under 4 different player names,
        // and Burnt answered all four.
        //
        // Two players typing identical words inside the window is rare enough
        // that dropping one is far cheaper than replying four times.
        synchronized (recentChatText) {
            recentChatText.values().removeIf(at -> now - at > CHAT_DEDUP_WINDOW_MS);
            Long seen = recentChatText.get(key);
            if (seen != null && now - seen < CHAT_DEDUP_WINDOW_MS) {
                recentChatText.put(key, now);
                return;
            }
            recentChatText.put(key, now);
        }
        lastChatEventKey = key;
        lastChatEventAt = now;
        JsonObject d = new JsonObject();
        d.addProperty("sender", sender);
        d.addProperty("text", text);
        sendEvent("chat", d);
    }

    // most community servers (plugin chat formats, offline-mode) deliver chat
    // as SYSTEM text, not signed player chat - recognize the common rendered
    // shapes: "<Name> msg", "Name: msg", "[Rank] Name: msg", "[Rank] Name » msg"
    // real servers decorate the speaker: "<(Member) » Aereon42> hi", "[VIP] Bob: hi",
    // "Bob » hi". the old pattern only accepted a bare "<Name>", so every
    // plugin-formatted line failed to match and fell through to the
    // last-known-sender fallback - which attributed other people's messages to
    // the WRONG player (observed: Aereon42's line arriving as ShadowAliceZ).
    // the name group must sit immediately before '>', so the token captured is
    // the LAST one inside the brackets - which is where the real username sits in
    // every rank format seen. verified against the live server's exact lines.
    private static final java.util.regex.Pattern CHAT_SHAPE = java.util.regex.Pattern.compile(
        "^\\s*(?:\\[[^\\]]{1,24}\\]\\s*)*(?:<[^>]*?([A-Za-z0-9_]{3,16})>\\s*(.{1,256})|([A-Za-z0-9_]{3,16})\\s*[:»>]\\s*(.{1,256}))$");

    // the comparison key for "is this the same thing said": case and run-length of
    // whitespace differ between delivery paths and mean nothing to a reader.
    private static String chatKey(String text) {
        return text == null ? "" : text.replaceAll("\\s+", " ").trim().toLowerCase(java.util.Locale.ROOT);
    }

    // "<[Member] > Bob> hi" -> "hi", but ONLY when the name inside the decoration
    // is the speaker already resolved for this line. somebody typing "Bob: come
    // here" AT Bob is a real sentence and keeps every word of it.
    private static String stripOwnDecoration(String sender, String text) {
        try {
            java.util.regex.Matcher m = CHAT_SHAPE.matcher(text);
            if (!m.matches()) return text;
            String who = m.group(1) != null ? m.group(1) : m.group(3);
            String body = m.group(1) != null ? m.group(2) : m.group(4);
            if (who == null || body == null || body.isBlank()) return text;
            return who.equalsIgnoreCase(sender) ? body.trim() : text;
        } catch (Throwable ignored) {
            return text;
        }
    }

    private void noteSelfChat(String text) {
        String key = chatKey(text);
        if (key.isEmpty()) return;
        long now = System.currentTimeMillis();
        synchronized (recentSelfChat) {
            recentSelfChat.values().removeIf(at -> now - at > CHAT_ECHO_WINDOW_MS);
            recentSelfChat.put(key, now);
        }
    }

    private void tryParseChatLine(String raw) {
        if (raw == null || raw.isEmpty()) return;
        java.util.regex.Matcher m = CHAT_SHAPE.matcher(raw);
        if (!m.matches()) return;
        String sender = m.group(1) != null ? m.group(1) : m.group(3);
        String text = m.group(1) != null ? m.group(2) : m.group(4);
        if (sender != null && text != null) emitChatEvent(sender, text.trim());
    }

    // ---- outbound: framing ----------------------------------------------

    private void sendHello() {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> sendHelloSnapshot(mc.player, true));
    }

    // Must run on Minecraft's client thread.
    private void sendHelloSnapshot(LocalPlayer player, boolean force) {
        String name = "unknown";
        try {
            if (player != null) name = player.getGameProfile().name();
        } catch (Throwable ignored) { }
        boolean ready = player != null && AltoClef.getCommandExecutor() != null;
        if (!force && ready == lastHelloReady && name.equals(lastHelloUsername)) return;
        lastHelloReady = ready;
        lastHelloUsername = name;

        JsonObject o = new JsonObject();
        o.addProperty("type", "hello");
        o.addProperty("username", name);
        o.addProperty("ready", ready);
        send(o);
    }

    private void sendAck(String id) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "ack");
        if (id != null) o.addProperty("id", id);
        send(o);
    }

    private void sendFinished(String id) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "finished");
        if (id != null) o.addProperty("id", id);
        send(o);
    }

    private void sendError(String id, String error) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "error");
        if (id != null) o.addProperty("id", id);
        o.addProperty("error", error == null ? "unknown error" : error);
        send(o);
    }

    private void sendEvent(String event, JsonObject data) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "event");
        o.addProperty("event", event);
        o.add("data", data);
        send(o);
    }

    private void send(JsonObject obj) {
        OutputStream o = this.out;
        if (o == null) return;
        try {
            byte[] bytes = (gson.toJson(obj) + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (writeLock) {
                // A reconnect can replace `out` after the local snapshot was
                // taken. Never write an old event to a disconnected client.
                if (this.out != o) return;
                this.out.write(bytes);
                this.out.flush();
            }
        } catch (IOException e) {
            closeClient(o); // only close the client whose write failed
        }
    }

    // ---- helpers ---------------------------------------------------------

    private static String str(JsonObject o, String key, String def) {
        try {
            return (o.has(key) && !o.get(key).isJsonNull()) ? o.get(key).getAsString() : def;
        } catch (Exception e) {
            return def;
        }
    }

    private void resetObservedState() {
        lastHealth = -1;
        lastHunger = -1;
        wasDead = false;
        lastWasNight = false;
        lastLowHungerEventAt = 0L;
        lastCreeperEventAt = 0L;
        lastHostileEventAt = 0L;
        lastInventorySignature = "";
        lastDimension = "";
        lastWeather = "";
        lastNearbyHostiles = 0;
        lastDiamondCount = -1;
        // null, not empty: an empty set is a room she has SEEN and found empty, so
        // reconnecting into a busy server would report every player as a fresh
        // arrival. null re-seeds silently on the next poll.
        lastOnlineNames = null;
    }

    private static int resolvePort() {
        String p = System.getProperty("altoclef.control.port");
        if (p == null) p = System.getenv("ALTOCLEF_CONTROL_PORT");
        try {
            return (p != null) ? Integer.parseInt(p.trim()) : 7440;
        } catch (Exception e) {
            return 7440;
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static void log(String msg) {
        System.out.println(TAG + " " + msg);
    }
}
