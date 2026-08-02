package adris.altoclef.tasks.construction;

import net.minecraft.world.level.block.Block;
import net.minecraft.core.BlockPos;

/**
 * Place any throwaway block at a position
 */
public class PlaceStructureBlockTask extends PlaceBlockTask {
    public PlaceStructureBlockTask(BlockPos target) {
        super(target, new Block[]{}, true, true);
    }
}