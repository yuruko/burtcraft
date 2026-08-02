package adris.altoclef.eventbus.events;

import net.minecraft.core.BlockPos;

public class BlockBreakingEvent {
    public BlockPos blockPos;
    public double progress;

    public BlockBreakingEvent(BlockPos blockPos, double progress) {
        this.blockPos = blockPos;
        this.progress = progress;
    }
}
