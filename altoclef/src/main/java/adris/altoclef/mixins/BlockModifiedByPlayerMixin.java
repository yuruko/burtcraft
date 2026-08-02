package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.BlockBrokenEvent;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Block.class)
public class BlockModifiedByPlayerMixin {

    @Inject(
            method = "playerWillDestroy",
            at = @At("HEAD")
    )
    public void onBlockBroken(Level world, BlockPos pos, BlockState state, Player player, CallbackInfoReturnable<BlockState> ci) {
        if (player.level() == world) {
            BlockBrokenEvent evt = new BlockBrokenEvent();
            evt.blockPos = pos;
            evt.blockState = state;
            evt.player = player;
            EventBus.publish(evt);
        }
    }

    @Inject(
            method = "setPlacedBy",
            at = @At("HEAD")
    )
    public void onBlockPlaced(Level world, BlockPos pos, BlockState state, @Nullable LivingEntity placer, ItemStack itemStack, CallbackInfo ci) {
        // This one is weirdly unreliable.
        //Debug.logInternal("[TEMP] global place");
        //StaticMixinHookups.onBlockPlaced(world, pos, state, placer, itemStack);
    }

}
