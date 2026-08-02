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

    public static void logMessage(String message, boolean prefix) {
//        if (Minecraft.getInstance() != null && Minecraft.getInstance().player != null) {
//            if (prefix) {
//                message = "\u00A72\u00A7l\u00A7o" + getLogPrefix() + "\u00A7r" + message;
//            }
//            Minecraft.getInstance().player.sendMessage(Component.literal(message), false);
//            //Minecraft.getInstance().player.sendChatMessage(msg);
//        } else {
//            logInternal(message);
//        }
    }

    public static void logMessage(String message) {
//        logMessage(message, true);
    }

    public static void logMessage(String format, Object... args) {
//        logMessage(String.format(format, args));
    }

    public static void logWarning(String message) {
//        logInternal("WARNING: " + message);
//        if (jankModInstance != null && !jankModInstance.getModSettings().shouldHideAllWarningLogs()) {
//            if (Minecraft.getInstance() != null && Minecraft.getInstance().player != null) {
//                String msg = "\u00A72\u00A7l\u00A7o" + getLogPrefix() + "\u00A7c" + message + "\u00A7r";
//                Minecraft.getInstance().player.sendMessage(Component.literal(msg), false);
//                //Minecraft.getInstance().player.sendChatMessage(msg);
//            }
//        }
    }

    public static void logWarning(String format, Object... args) {
        logWarning(String.format(format, args));
    }

    public static void logError(String message) {
//        String stacktrace = getStack(2);
//        System.err.println(message);
//        System.err.println("at:");
//        System.err.println(stacktrace);
//        if (Minecraft.getInstance() != null && Minecraft.getInstance().player != null) {
//            String msg = "\u00A72\u00A7l\u00A7c" + getLogPrefix() + "[ERROR] " + message + "\nat:\n" + stacktrace + "\u00A7r";
//            Minecraft.getInstance().player.sendMessage(Component.literal(msg), false);
//        }
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
