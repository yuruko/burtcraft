package adris.altoclef.eventbus.events;

import com.mojang.blaze3d.vertex.PoseStack;

public class ClientRenderEvent {
    public PoseStack stack;
    public float tickDelta;

    public ClientRenderEvent(PoseStack stack, float tickDelta) {
        this.stack = stack;
        this.tickDelta = tickDelta;
    }
}
