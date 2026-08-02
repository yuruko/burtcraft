package adris.altoclef.mixins;

import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;

@Mixin(MultiPlayerGameMode.class)
public interface ClientPlayerInteractionAccessor {
    //@Invoker("sendPlayerAction")
    //void doSendPlayerAction(PlayerActionC2SPacket.Action action, BlockPos pos, Direction direction);

}
