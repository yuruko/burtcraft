package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.List;

/**
 * Geometry contract shared by buildable homes and outposts.
 *
 * The anchor is the walkable block at the centre of the interior. The outer
 * floor is one block below it. Dimensions always describe the outer prism.
 */
public abstract class Settlement {
    protected final String name;
    protected final BlockPos anchor;
    protected final int width;
    protected final int depth;
    protected final int height;
    protected final Block material;

    protected Settlement(String name, BlockPos anchor, int width, int depth, int height, Block material) {
        if (anchor == null) throw new IllegalArgumentException("settlement anchor is required");
        if (width < 5 || depth < 5 || height < 5 || width > 64 || depth > 64 || height > 64) {
            throw new IllegalArgumentException("settlement dimensions must be between 5 and 64 blocks");
        }
        this.name = name == null || name.isBlank() ? "settlement" : name;
        this.anchor = anchor.immutable();
        this.width = width;
        this.depth = depth;
        this.height = height;
        this.material = material == null ? Blocks.SMOOTH_STONE : material;
    }

    public abstract String kind();
    public abstract String role();

    public String name() { return name; }
    public BlockPos anchor() { return anchor; }
    public int width() { return width; }
    public int depth() { return depth; }
    public int height() { return height; }
    public Block material() { return material; }
    public int minX() { return anchor.getX() - width / 2; }
    public int maxX() { return minX() + width - 1; }
    public int minZ() { return anchor.getZ() - depth / 2; }
    public int maxZ() { return minZ() + depth - 1; }
    public int floorY() { return anchor.getY() - 1; }
    public int roofY() { return floorY() + height - 1; }
    public BlockPos origin() { return new BlockPos(minX(), floorY(), minZ()); }

    public boolean inOuterPrism(BlockPos pos) {
        return pos.getX() >= minX() && pos.getX() <= maxX()
            && pos.getZ() >= minZ() && pos.getZ() <= maxZ()
            && pos.getY() >= floorY() && pos.getY() <= roofY();
    }

    public boolean isFloor(BlockPos pos) {
        return inOuterPrism(pos) && pos.getY() == floorY();
    }

    public boolean isRoof(BlockPos pos) {
        return inOuterPrism(pos) && pos.getY() == roofY();
    }

    public boolean isWall(BlockPos pos) {
        return inOuterPrism(pos) && pos.getY() > floorY() && pos.getY() < roofY()
            && (pos.getX() == minX() || pos.getX() == maxX()
                || pos.getZ() == minZ() || pos.getZ() == maxZ());
    }

    public boolean isInterior(BlockPos pos) {
        return pos.getX() > minX() && pos.getX() < maxX()
            && pos.getZ() > minZ() && pos.getZ() < maxZ()
            && pos.getY() > floorY() && pos.getY() < roofY();
    }

    /** Intentional walk-through opening; subclasses decide its silhouette. */
    public abstract boolean isEntrance(BlockPos pos);

    /** Intentional holes in the top surface. */
    public abstract boolean isToastSlot(BlockPos pos);

    /** Exact side-light positions. */
    public abstract List<BlockPos> torchPositions();

    /**
     * Blocks that are allowed to remain inside while an expansion clears old
     * walls. Appliances and practical furniture survive; stray stone does not.
     */
    public boolean preserveInterior(BlockState state) {
        Block block = state.getBlock();
        return block == Blocks.FURNACE || block == Blocks.BLAST_FURNACE || block == Blocks.SMOKER
            || block == Blocks.CAMPFIRE || block == Blocks.SOUL_CAMPFIRE
            || block == Blocks.CHEST || block == Blocks.TRAPPED_CHEST || block == Blocks.ENDER_CHEST
            || block == Blocks.BARREL || block == Blocks.CRAFTING_TABLE
            || block == Blocks.TORCH || block == Blocks.WALL_TORCH
            || block instanceof BedBlock;
    }

    public BlockState desiredState(BlockPos worldPos, BlockState current) {
        if (!inOuterPrism(worldPos)) return current;
        if (isEntrance(worldPos) || isToastSlot(worldPos)) return Blocks.AIR.defaultBlockState();
        if (isFloor(worldPos) || isRoof(worldPos) || isWall(worldPos)) {
            return material.defaultBlockState();
        }
        if (isInterior(worldPos)) {
            return preserveInterior(current) ? current : Blocks.AIR.defaultBlockState();
        }
        return current;
    }

    public List<BlockPos> appliancePositions(int count) {
        List<BlockPos> positions = new ArrayList<>();
        int columns = Math.max(1, (width - 6) / 2);
        for (int i = 0; i < count; i++) {
            int row = i / columns;
            int column = i % columns;
            int x = minX() + 3 + column * 2;
            int z = Math.min(maxZ() - 2, minZ() + 3 + row * 2);
            positions.add(new BlockPos(x, anchor.getY(), z));
        }
        return positions;
    }

    public BlockPos appliancePosition(int index) {
        return appliancePositions(Math.max(1, index + 1)).get(Math.max(0, index));
    }

    public Direction entranceFacing() { return Direction.NORTH; }
}
