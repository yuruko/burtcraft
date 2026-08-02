package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.InteractWithBlockTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import net.minecraft.world.item.Items;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ClipContext;

/**
 * Removes a liquid source block at a position.
 */
public class ClearLiquidTask extends Task {

    private final BlockPos _liquidPos;

    public ClearLiquidTask(BlockPos liquidPos) {
        this._liquidPos = liquidPos;
    }

    @Override
    protected void onStart(AltoClef mod) {

    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getItemStorage().hasItem(Items.BUCKET)) {
            mod.getBehaviour().setRayTracingFluidHandling(ClipContext.Fluid.SOURCE_ONLY);
            return new InteractWithBlockTask(new ItemTarget(Items.BUCKET, 1), _liquidPos, false);
        }

        return new PlaceStructureBlockTask(_liquidPos);
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {

    }

    @Override
    public boolean isFinished(AltoClef mod) {
        if (mod.getChunkTracker().isChunkLoaded(_liquidPos)) {
            return mod.getWorld().getBlockState(_liquidPos).getFluidState().isEmpty();
        }
        return false;
    }

    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof ClearLiquidTask task) {
            return task._liquidPos.equals(_liquidPos);
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        return "Clear liquid at " + _liquidPos;
    }
}
