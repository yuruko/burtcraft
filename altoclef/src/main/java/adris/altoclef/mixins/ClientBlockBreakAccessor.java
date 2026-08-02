package adris.altoclef.mixins;

import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(MultiPlayerGameMode.class)
public interface ClientBlockBreakAccessor {
    @Accessor("destroyProgress")
    float getCurrentBreakingProgress();
}
