package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;

/** A secondary settlement; deliberately smaller than its world's homestead. */
public abstract class Outpost extends Settlement {
    protected Outpost(String name, BlockPos anchor, int width, int depth, int height, Block material) {
        super(name, anchor, width, depth, height, material);
    }

    @Override
    public String role() { return "outpost"; }
}
