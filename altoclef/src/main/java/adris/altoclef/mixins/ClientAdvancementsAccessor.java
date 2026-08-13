package adris.altoclef.mixins;

import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.client.multiplayer.ClientAdvancements;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.Map;

/**
 * READ WHAT SHE HAS ACTUALLY ACHIEVED.
 *
 * The client already holds the complete, SERVER-AUTHORITATIVE advancement state -
 * every id, every criterion, and whether it is done - pushed on join and updated on
 * every change. Burtcraft's only progression signal was a regex over the chat line
 * "X has made the advancement [Y]", which:
 *   - misses everything she earned before the feature existed,
 *   - misses everything on a server with announcements off (very common),
 *   - yields a DISPLAY NAME ("Stone Age") rather than an id, so it can never be
 *     matched against a catalogue or told apart from another pack's advancement.
 *
 * `progress` is private with no getter, hence this accessor.
 *
 * ⚠ NOT `setListener`. That field is single-slot and the vanilla AdvancementsScreen
 * claims it whenever the player opens the advancements GUI - so installing our own
 * listener would either be silently replaced or would break the screen, depending on
 * who ran last. Reading the map on the existing poll has no such contention.
 */
@Mixin(ClientAdvancements.class)
public interface ClientAdvancementsAccessor {
    @Accessor("progress")
    Map<AdvancementHolder, AdvancementProgress> getProgress();
}
