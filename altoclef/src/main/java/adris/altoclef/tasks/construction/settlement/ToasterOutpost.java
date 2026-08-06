package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;

import java.util.List;

/** Burnt's smaller remote toaster. */
public final class ToasterOutpost extends Outpost {
    public ToasterOutpost(String name, BlockPos anchor, int width, int depth, int height) {
        super(name, anchor, width, depth, height, Blocks.SMOOTH_STONE);
    }

    @Override
    public String kind() { return "toaster_outpost"; }

    @Override
    public boolean isEntrance(BlockPos pos) { return ToasterGeometry.isEntrance(this, pos); }

    @Override
    public boolean isToastSlot(BlockPos pos) { return ToasterGeometry.isToastSlot(this, pos); }

    @Override
    public List<BlockPos> torchPositions() { return ToasterGeometry.torchPositions(this); }

    @Override
    public Direction torchFacing(BlockPos pos) { return ToasterGeometry.torchFacing(this, pos); }

    @Override
    public List<ToasterGeometry.Slot> applianceSlots() { return ToasterGeometry.applianceSlots(this); }

    @Override
    public List<BlockPos> bedPositions() { return ToasterGeometry.bedPositions(this); }
}
