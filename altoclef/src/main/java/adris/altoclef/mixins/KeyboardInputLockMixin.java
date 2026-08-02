package adris.altoclef.mixins;

import net.minecraft.client.KeyboardHandler;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Keeps the local keyboard out of the game while Burtcraft is installed.
 *
 * AltoClef and Baritone do not use GLFW callbacks to move: they set Minecraft
 * key bindings directly and rotate the player on the client thread. Cancelling
 * physical callbacks here therefore blocks a person without blocking bot tasks.
 */
@Mixin(KeyboardHandler.class)
public final class KeyboardInputLockMixin {
    // 26.1: the glfw callbacks are onKey/onChar no longer - they take event records now.
    @Inject(method = "keyPress", at = @At("HEAD"), cancellable = true)
    private void burtcraft$blockPhysicalKey(long window, int action, KeyEvent event, CallbackInfo ci) {
        if (Minecraft.getInstance().player != null) ci.cancel();
    }

    @Inject(method = "charTyped", at = @At("HEAD"), cancellable = true)
    private void burtcraft$blockPhysicalCharacter(long window, CharacterEvent event, CallbackInfo ci) {
        if (Minecraft.getInstance().player != null) ci.cancel();
    }
}
