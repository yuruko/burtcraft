package adris.altoclef;

import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;

// TODO: Debug library or use Minecraft's built in debugger
public class Debug {

    public static AltoClef jankModInstance;

    public static void logInternal(String message) {
        System.out.println("ALTO CLEF: " + message);
    }

    public static void logInternal(String format, Object... args) {
        logInternal(String.format(format, args));
    }

    private static String getLogPrefix() {
        if (jankModInstance != null) {
            return jankModInstance.getModSettings().getChatLogPrefix();
        }
        return "[Alto Clef] ";
    }

    /**
     * These three all used to write into her in-game CHAT, which is ON STREAM, so
     * every one of them was commented out wholesale - and that silently killed the
     * mod's entire diagnostic surface. 69 logWarning call sites, every logError,
     * and the toaster builder's own "builder is not building (active=.. paused=..)"
     * line all went NOWHERE: not to chat, not to the log, not to a file. Three
     * separate build freezes then had to be diagnosed by reading source and
     * guessing, because the one message that names the cause was a no-op.
     *
     * They go to STDOUT instead: it lands in latest.log where we can read it, and
     * it never appears on stream. Repeats of an identical line are collapsed so a
     * per-tick caller (safe to write while these were no-ops) cannot flood it.
     */
    private static final long REPEAT_SUPPRESS_MS = 5_000L;
    private static final java.util.Map<String, Long> lastPrintedAt = new java.util.LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(java.util.Map.Entry<String, Long> eldest) {
            return size() > 256;
        }
    };

    private static synchronized boolean shouldPrint(String message) {
        long now = System.currentTimeMillis();
        Long previous = lastPrintedAt.get(message);
        if (previous != null && now - previous < REPEAT_SUPPRESS_MS) return false;
        lastPrintedAt.put(message, now);
        return true;
    }

    public static void logMessage(String message, boolean prefix) {
        if (shouldPrint(message)) logInternal(message);
    }

    public static void logMessage(String message) {
        logMessage(message, true);
    }

    public static void logMessage(String format, Object... args) {
        logMessage(String.format(format, args));
    }

    public static void logWarning(String message) {
        if (shouldPrint("WARNING: " + message)) logInternal("WARNING: " + message);
    }

    public static void logWarning(String format, Object... args) {
        logWarning(String.format(format, args));
    }

    public static void logError(String message) {
        if (!shouldPrint("ERROR: " + message)) return;
        System.out.println("ALTO CLEF ERROR: " + message);
        System.out.println("at:");
        System.out.println(getStack(2));
    }

    public static void logError(String format, Object... args) {
        logError(String.format(format, args));
    }

    public static void logStack() {
        logInternal("STACKTRACE: \n" + getStack(2));
    }

    private static String getStack(int toSkip) {
        StringBuilder stacktrace = new StringBuilder();
        for (StackTraceElement ste : Thread.currentThread().getStackTrace()) {
            if (toSkip-- <= 0) {
                stacktrace.append(ste.toString()).append("\n");
            }
        }
        return stacktrace.toString();
    }
}
