package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.ClientRenderEvent;
import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Gui.class)
public final class ClientUIMixin {
    /**
     * 26.1 replaced Gui#render(DrawContext, float) with the render-state extraction
     * pass, so there is no live DrawContext/PoseStack to hand out any more. the task
     * chain overlay only ever drew in screen space off an identity transform, so we
     * publish a fresh stack - the hud is cosmetic, nothing burnt reads goes through it.
     */
    @Inject(
            method = "extractRenderState",
            at = @At("TAIL")
    )
    private void clientRender(GuiGraphicsExtractor extractor, DeltaTracker deltaTracker, CallbackInfo ci) {
        EventBus.publish(new ClientRenderEvent(new PoseStack(), deltaTracker.getGameTimeDeltaPartialTick(false)));
    }
}
