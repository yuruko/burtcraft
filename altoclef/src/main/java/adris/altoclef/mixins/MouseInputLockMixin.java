package adris.altoclef.mixins;

import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import net.minecraft.client.input.MouseButtonInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Blocks physical mouse buttons, camera movement, and scroll-wheel input in-world. */
@Mixin(MouseHandler.class)
public final class MouseInputLockMixin {
    // 26.1: onMouseButton/onMouseScroll/onCursorPos are onButton/onScroll/onMove,
    // and the button callback carries a MouseButtonInfo record instead of loose ints.
    @Inject(method = "onButton", at = @At("HEAD"), cancellable = true)
    private void burtcraft$blockPhysicalButton(long window, MouseButtonInfo button, int action, CallbackInfo ci) {
        if (Minecraft.getInstance().player != null) ci.cancel();
    }

    @Inject(method = "onScroll", at = @At("HEAD"), cancellable = true)
    private void burtcraft$blockPhysicalScroll(long window, double horizontal, double vertical, CallbackInfo ci) {
        if (Minecraft.getInstance().player != null) ci.cancel();
    }

    @Inject(method = "onMove", at = @At("HEAD"), cancellable = true)
    private void burtcraft$blockPhysicalCamera(long window, double x, double y, CallbackInfo ci) {
        if (Minecraft.getInstance().player != null) ci.cancel();
    }
}
