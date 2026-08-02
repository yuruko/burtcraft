package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.PlayerCollidedWithEntityEvent;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

@Mixin(Player.class)
public class PlayerCollidesWithEntityMixin {

    // Determines a collision between items/EXP orbs/other objects within "pickup" range.
    @Redirect(
            method = "touch",
            at = @At(value = "INVOKE", target = "Lnet/minecraft/world/entity/Entity;playerTouch(Lnet/minecraft/world/entity/player/Player;)V")
    )
    private void onCollideWithEntity(Entity self, Player player) {
        // TODO: Less hard-coded manual means of enforcing client side access
        if (player instanceof LocalPlayer) {
            EventBus.publish(new PlayerCollidedWithEntityEvent(player, self));
        }
        // Perform the default action.
        // TODO: Figure out a cleaner way. First re-read the mixin intro documentation again.
        self.playerTouch(player);
    }
}
