package adris.altoclef.external;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.CommandExecutor;
import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.ChatMessageEvent;
import adris.altoclef.eventbus.events.TaskFinishedEvent;
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
    private volatile int lastHealth = -1;
    private volatile int lastHunger = -1;
    private volatile boolean wasDead = false;
    private volatile boolean lastWasNight = false;
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

    @Override
    public void onInitializeClient() {
        // subscribe to the static event bus (safe to do at init; events only fire in-game)
        try {
            EventBus.subscribe(TaskFinishedEvent.class, this::onTaskFinished);
            EventBus.subscribe(ChatMessageEvent.class, this::onChatMessage);
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
                    autoThirdPersonTick(mc);
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
                        String raw = message.getString();
                        java.util.regex.Matcher m = CHAT_SHAPE.matcher(raw == null ? "" : raw);
                        if (m.matches()) {
                            String who = m.group(1) != null ? m.group(1) : m.group(3);
                            String what = m.group(1) != null ? m.group(2) : m.group(4);
                            if (who != null && what != null) emitChatEvent(who, what.trim());
                        } else if (sender != null && raw != null && !raw.isEmpty()) {
                            emitChatEvent(sender.name(), raw);
                        }
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
        if (manualControl) {
            // stop whatever the bot is doing and let go of every forced key
            try {
                CommandExecutor exec = AltoClef.getCommandExecutor();
                if (exec != null) exec.executeWithPrefix("stop", () -> { }, ex -> { });
            } catch (Throwable ignored) { }
            releaseAllInputs(mc);
            if (p != null) {
                p.sendOverlayMessage(net.minecraft.network.chat.Component.literal(
                    "keyboard/mouse: YOURS - f1 hands it back to burnt"));
            }
            log("manual control ON (f1) - external commands blocked");
        } else {
            if (p != null) {
                p.sendOverlayMessage(net.minecraft.network.chat.Component.literal(
                    "controls handed back to burnt"));
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
                if (exec != null) exec.executeWithPrefix("stop", () -> { }, ex -> { });
            } catch (Throwable t) {
                log("control-loss stop failed: " + t.getMessage());
            }
            releaseAllInputs(mc);
        });
    }

    // run an altoclef @command, tying its onFinish/onError back to the bridge id
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
                return;
            }
            String json = new String(java.util.Base64.getDecoder().decode(payload),
                java.nio.charset.StandardCharsets.UTF_8);
            JsonObject o = JsonParser.parseString(json).getAsJsonObject();
            intentWhat = clip(str(o, "what", ""));
            intentWhy = clip(str(o, "why", ""));
            intentPhase = clip(str(o, "phase", ""));
            intentAt = intentWhat.isEmpty() ? 0L : System.currentTimeMillis();
        } catch (Throwable t) {
            log("bad hud payload: " + t);
        }
    }

    private static String clip(String s) {
        if (s == null) return "";
        String one = s.replace('\n', ' ').replace('\r', ' ').trim();
        return one.length() > 90 ? one.substring(0, 89) + "…" : one;
    }

    // three lines, top-left: WHAT she is doing (bright), WHY (her colour), and the
    // live altoclef phase (grey) so the machine's real sub-step sits right under her
    // stated intent - the gap between those two is the thing that was impossible to
    // read before. small and cornered, because this lives on stream.
    private static void drawIntent(net.minecraft.client.gui.GuiGraphicsExtractor g) {
        if (!INTENT_HUD) return;
        try {
            Minecraft mc = Minecraft.getInstance();
            if (mc == null || mc.player == null || mc.level == null) return;
            if (mc.options != null && mc.options.hideGui) return;
            if (mc.font == null) return;

            java.util.List<String> lines = new java.util.ArrayList<>(3);
            java.util.List<Integer> colours = new java.util.ArrayList<>(3);
            if (manualControl) {
                lines.add("manual - yuru has the keyboard");
                colours.add(0xFFFFC65B);
            } else {
                // a stale line claiming she is mid-task is worse than no line at all
                if (intentAt <= 0L || System.currentTimeMillis() - intentAt > INTENT_TTL_MS) return;
                String what = intentWhat;
                if (what.isEmpty()) return;
                lines.add(what);
                colours.add(0xFFFFFFFF);
                if (!intentWhy.isEmpty()) { lines.add(intentWhy); colours.add(0xFFCBA6FF); }
                if (!intentPhase.isEmpty()) { lines.add(intentPhase); colours.add(0xFF9A9A9A); }
            }

            final int x = 6, y = 6, lineHeight = 10, pad = 3;
            int width = 0;
            for (String s : lines) width = Math.max(width, mc.font.width(s));
            width = Math.min(width, Math.max(80, g.guiWidth() / 2));
            g.fill(x - pad, y - pad, x + width + pad, y + lines.size() * lineHeight + pad - 1, 0x8C000000);
            for (int i = 0; i < lines.size(); i++) {
                g.text(mc.font, lines.get(i), x, y + i * lineHeight, colours.get(i));
            }
        } catch (Throwable ignored) { }
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

    private static void resetAutoCamera() {
        lookDownTicks = 0;
        lookUpTicks = 0;
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
                            if (p2 != me && p2.getName().getString().equalsIgnoreCase(bits[1])) { who = p2; break; }
                        }
                        if (who == null) { sendError(id, "can't see " + bits[1] + " from here"); return; }
                        double dx = who.getX() - me.getX();
                        double dy = (who.getY() + who.getEyeHeight()) - (me.getY() + me.getEyeHeight());
                        double dz = who.getZ() - me.getZ();
                        double flat = Math.sqrt(dx * dx + dz * dz);
                        me.setYRot((float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
                        me.setXRot((float) -Math.toDegrees(Math.atan2(dy, flat)));
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
                    } else if (!mod.getFoodChain().requestEat()) {
                        sendError(id, "nothing edible in the inventory");
                    } else {
                        sendFinished(id);
                    }
                } catch (Throwable t) {
                    sendError(id, "eat failed: " + t.getMessage());
                }
                return;
            }
            sendAck(id);
            try {
                exec.executeWithPrefix(bare, () -> sendFinished(id), ex -> sendError(id, ex.getMessage()));
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
                exec.execute(text, () -> sendFinished(id), ex -> sendError(id, ex.getMessage()));
                return;
            }
            try {
                sendAck(id);
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

                // compact inventory summary (counts per item type, top ~18) so burnt
                // knows what she's carrying / can craft without reading it off-screen
                try {
                    JsonArray items = new JsonArray();
                    java.util.LinkedHashMap<String, Integer> counts = new java.util.LinkedHashMap<>();
                    int diamondCount = 0;
                    for (ItemStack st : p.getInventory().getNonEquipmentItems()) {
                        if (st == null || st.isEmpty()) continue;
                        counts.merge(st.getItem().toString(), st.getCount(), Integer::sum);
                        if ("minecraft:diamond".equals(BuiltInRegistries.ITEM.getKey(st.getItem()).toString())) {
                            diamondCount += st.getCount();
                        }
                    }
                    int n = 0;
                    for (java.util.Map.Entry<String, Integer> e : counts.entrySet()) {
                        if (n++ >= 18) break;
                        items.add(e.getValue() + " " + e.getKey());
                    }
                    gs.add("inventory", items);
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

                // live altoclef task readout - the "what am i actually doing right now".
                // the root task carries the high-level goal + phase (e.g. a @gamer run
                // reads "beating the game.: getting blaze rods"), the deepest task carries
                // the concrete micro-action. always send both (empty when idle) so a
                // finished task self-clears on burnt's side instead of lingering stale.
                try {
                    String botTask = "";
                    String botAction = "";
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
                        }
                    }
                    gs.addProperty("botTask", botTask);
                    gs.addProperty("botAction", botAction);
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
                    if (!lastDimension.isEmpty() && !dimension.equals(lastDimension)) {
                        JsonObject changed = new JsonObject();
                        changed.addProperty("dimension", dimension);
                        changed.add("position", pos);
                        sendEvent("dimension_changed", changed);
                    }
                    if (!lastWeather.isEmpty() && !weather.equals(lastWeather)) {
                        JsonObject changed = new JsonObject();
                        changed.addProperty("weather", weather);
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
                        boolean creeperNearby = false;
                        java.util.LinkedHashSet<String> uniqueTypes = new java.util.LinkedHashSet<>();
                        java.util.LinkedHashSet<String> playerNames = new java.util.LinkedHashSet<>();
                        for (net.minecraft.world.entity.Entity entity : nearby) {
                            if (entity instanceof Player other) {
                                nearbyPlayers++;
                                if (playerNames.size() < 8) {
                                    try { playerNames.add(other.getGameProfile().name()); } catch (Throwable ignored) { }
                                }
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
                        }
                        gs.addProperty("nearbyHostiles", nearbyHostiles);
                        gs.addProperty("nearbyPlayers", nearbyPlayers);
                        JsonArray playerNameArr = new JsonArray();
                        for (String name : playerNames) playerNameArr.add(name);
                        gs.add("nearbyPlayerNames", playerNameArr);
                        JsonArray hostileTypes = new JsonArray();
                        for (String type : uniqueTypes) hostileTypes.add(type);
                        gs.add("nearbyHostileTypes", hostileTypes);
                        if (nearbyHostiles > 0 && (lastNearbyHostiles == 0 ||
                                System.currentTimeMillis() - lastHostileEventAt > 30000L)) {
                            lastHostileEventAt = System.currentTimeMillis();
                            JsonObject hostileEvent = new JsonObject();
                            hostileEvent.addProperty("count", nearbyHostiles);
                            hostileEvent.add("types", hostileTypes);
                            sendEvent("hostiles_nearby", hostileEvent);
                        }
                        lastNearbyHostiles = nearbyHostiles;
                        if (creeperNearby && System.currentTimeMillis() - lastCreeperEventAt > 15000L) {
                            lastCreeperEventAt = System.currentTimeMillis();
                            sendEvent("creeper_spotted", new JsonObject());
                        }
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
                               smokerD = Double.MAX_VALUE, campfireD = Double.MAX_VALUE, wheatD = Double.MAX_VALUE;
                        int wheatCount = 0;
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
                            else if (id.equals("wheat")) { wheatCount++; if (d2 < wheatD) wheatD = d2; }
                            else if (id.equals("chest") || id.equals("trapped_chest") || id.equals("barrel") || id.equals("ender_chest")) { if (d2 < chestD) chestD = d2; }
                            else if (id.endsWith("_bed")) { if (d2 < bedD) bedD = d2; }
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
                        if (wheatD < Double.MAX_VALUE) {
                            nb.addProperty("wheat", (int) Math.round(Math.sqrt(wheatD)));
                            nb.addProperty("wheatCount", wheatCount);
                        }
                        gs.add("nearby", nb);
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
                if (dead && !wasDead) sendEvent("death", new JsonObject());
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
        sendEvent("task_finished", d);
    }

    private void onChatMessage(ChatMessageEvent e) {
        try {
            emitChatEvent(e.senderName(), e.messageContent());
        } catch (Throwable ignored) { }
    }

    // one funnel for every chat delivery path (signed player chat via the
    // altoclef mixin, unsigned/disguised chat, and plugin-formatted system
    // messages). dedup keeps overlapping hooks from double-reporting a line.
    private void emitChatEvent(String sender, String text) {
        if (this.out == null) return;
        if (sender == null || text == null || sender.isEmpty() || text.isEmpty()) return;
        long now = System.currentTimeMillis();
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
            Long seen = recentChatText.get(text);
            if (seen != null && now - seen < CHAT_DEDUP_WINDOW_MS) {
                recentChatText.put(text, now);
                return;
            }
            recentChatText.put(text, now);
        }
        lastChatEventKey = text;
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
