package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;

/** A world's primary settlement. Controllers must keep it larger than outposts. */
public abstract class Homestead extends Settlement {
    protected Homestead(String name, BlockPos anchor, int width, int depth, int height, Block material) {
        super(name, anchor, width, depth, height, material);
    }

    @Override
    public String role() { return "homestead"; }
}
