package adris.altoclef.mixins;

import net.minecraft.client.gui.components.BossHealthOverlay;
import net.minecraft.client.gui.components.LerpingBossEvent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.Map;
import java.util.UUID;

/**
 * THE BOSS BAR IS THE ONE PIECE OF UI THAT MEANS "SOMETHING IS HAPPENING".
 *
 * She could stand in a raid, fight the ender dragon, or watch a wither spawn and
 * have no idea any of it was underway: nothing in the stack read boss events. The
 * bar is also how servers surface EVENTS - a great many plugins drive a custom
 * bossbar for objectives, countdowns and world bosses - so this is the cheapest
 * route to "the server is running something and she can see it".
 *
 * `events` is private with no getter, hence this accessor.
 *
 * ⚠ This is a UI component, but the map is populated straight from
 * ClientboundBossEventPacket in BossHealthOverlay.update() - it is network state
 * that happens to live on a HUD class, not a rendering artefact, and it is correct
 * whether or not anything is drawn.
 */
@Mixin(BossHealthOverlay.class)
public interface BossHealthOverlayAccessor {
    @Accessor("events")
    Map<UUID, LerpingBossEvent> getEvents();
}
