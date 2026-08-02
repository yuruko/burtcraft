package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.ScreenOpenEvent;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.jetbrains.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;


@Mixin(Minecraft.class)
public final class ClientOpenScreenMixin {
    @Inject(
            method = "setScreen",
            at = @At("HEAD")
    )
    private void onScreenOpenBegin(@Nullable Screen screen, CallbackInfo ci) {
        EventBus.publish(new ScreenOpenEvent(screen, true));
    }

    @Inject(
            method = "setScreen",
            at = @At("TAIL")
    )
    private void onScreenOpenEnd(@Nullable Screen screen, CallbackInfo ci) {
        EventBus.publish(new ScreenOpenEvent(screen, false));
    }
}
