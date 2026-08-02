package adris.altoclef.tasks.speedrun;

import net.minecraft.core.BlockPos;

public interface IDragonWaiter {
    void setExitPortalTop(BlockPos top);

    void setPerchState(boolean perching);
}
