package adris.altoclef.eventbus.events;

import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.core.BlockPos;

public class BlockPlaceEvent {
    public BlockPos blockPos;
    public BlockState blockState;

    public BlockPlaceEvent(BlockPos blockPos, BlockState blockState) {
        this.blockPos = blockPos;
        this.blockState = blockState;
    }
}
