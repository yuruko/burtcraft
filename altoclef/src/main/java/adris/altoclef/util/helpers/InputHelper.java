package adris.altoclef.util.helpers;

import net.minecraft.client.Minecraft;
import com.mojang.blaze3d.platform.InputConstants;

public class InputHelper {

    public static boolean isKeyPressed(int code) {
        return InputConstants.isKeyDown(Minecraft.getInstance().getWindow(), code);
    }
}
