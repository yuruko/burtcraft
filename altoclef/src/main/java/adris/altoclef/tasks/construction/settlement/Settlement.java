package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

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

    /**
     * Every block that is allowed to become toaster shell, best-looking first.
     *
     * A toaster is a toaster because of its SHAPE. Demanding smooth stone
     * specifically meant two full smelt passes - cobblestone -> stone ->
     * smooth stone - and enough fuel for ~192 blocks before one wall could go
     * up, so a fresh world or a stripped inventory could never afford a
     * toaster at all. Anything she can already dig out of the ground counts
     * now; the ordering only decides which of the stones she is CARRYING she
     * spends first, so she still gets the nice shell when she has one.
     */
    private static final List<Block> SHELL_STONE = List.of(
        Blocks.SMOOTH_STONE, Blocks.STONE, Blocks.STONE_BRICKS,
        Blocks.CHISELED_STONE_BRICKS, Blocks.CRACKED_STONE_BRICKS, Blocks.MOSSY_STONE_BRICKS,
        Blocks.POLISHED_ANDESITE, Blocks.ANDESITE,
        Blocks.POLISHED_DEEPSLATE, Blocks.DEEPSLATE_BRICKS, Blocks.DEEPSLATE_TILES,
        Blocks.DEEPSLATE, Blocks.COBBLED_DEEPSLATE,
        Blocks.COBBLESTONE, Blocks.MOSSY_COBBLESTONE,
        Blocks.POLISHED_DIORITE, Blocks.DIORITE,
        Blocks.POLISHED_GRANITE, Blocks.GRANITE,
        Blocks.POLISHED_TUFF, Blocks.TUFF_BRICKS, Blocks.TUFF,
        Blocks.POLISHED_BLACKSTONE, Blocks.POLISHED_BLACKSTONE_BRICKS, Blocks.BLACKSTONE,
        Blocks.SMOOTH_BASALT, Blocks.POLISHED_BASALT, Blocks.BASALT,
        Blocks.SMOOTH_SANDSTONE, Blocks.CUT_SANDSTONE, Blocks.SANDSTONE,
        Blocks.SMOOTH_RED_SANDSTONE, Blocks.CUT_RED_SANDSTONE, Blocks.RED_SANDSTONE,
        Blocks.END_STONE_BRICKS, Blocks.END_STONE, Blocks.NETHER_BRICKS,
        Blocks.CALCITE, Blocks.DRIPSTONE_BLOCK);

    /** Shell stone in spend-first order. Never empty. */
    public static List<Block> shellStoneByPreference() { return SHELL_STONE; }

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

    /**
     * THE YARD: how much open air the toaster gets on every side of it.
     *
     * A house with a hillside pressed against one wall and a forest against
     * another is not a home, it is a hole with a door. Nothing can be seen of it
     * on stream, mobs drop onto the roof from the high ground, and the walk in
     * and out is a tunnel. Ten blocks is enough that the whole silhouette reads
     * from outside and no mob has a block adjacent to a wall to stand on.
     */
    public static final int YARD_MARGIN = 10;

    public int yardMinX() { return minX() - YARD_MARGIN; }
    public int yardMaxX() { return maxX() + YARD_MARGIN; }
    public int yardMinZ() { return minZ() - YARD_MARGIN; }
    public int yardMaxZ() { return maxZ() + YARD_MARGIN; }

    /** How far past the yard the quarry mouth sits. See {@link #quarryMouth()}. */
    public static final int QUARRY_OFFSET = 6;

    /**
     * THE QUARRY MOUTH. One hole, returned to.
     *
     * A restock asks TaskCatalogue for cobblestone, and MineAndCollectTask walks
     * to the NEAREST stone it is allowed to break - which, measured from the
     * build site, is a fresh patch of ground every single time. Twenty restocks
     * was twenty shallow scrapes in a ring around the house instead of one mine.
     *
     * So the stone run gets a fixed mouth to start from. She walks here first,
     * and because "nearest" is then measured from inside the same hole, the hole
     * deepens. The mineshaft is dug by the ordinary mining task; all this does is
     * stop it wandering off to dig somewhere new.
     *
     * DERIVED, never stored. A remembered position would be a second copy of
     * settlement state to drift out of sync - the floorplan already taught us
     * what duplicated geometry costs - and this way an old save gets its quarry
     * the moment the new jar loads, with no migration.
     *
     * Behind the house (the entrance faces north) and a clear margin outside the
     * yard: the pit is never in the shot of the front door, and the yard-clearing
     * job is never asked to fill it back in.
     */
    public BlockPos quarryMouth() {
        return new BlockPos(anchor().getX(), floorY(), yardMaxZ() + QUARRY_OFFSET);
    }

    /**
     * The band around the shell that must be air, measured out from every wall.
     *
     * Deliberately excludes the floor course: a yard is ground she can stand on,
     * not a moat. It runs up to and including the roof line, so a tree beside
     * the house is felled to the height the house actually occupies rather than
     * left leaning over the roof.
     */
    public boolean inYard(BlockPos pos) {
        if (inOuterPrism(pos)) return false;
        return pos.getX() >= yardMinX() && pos.getX() <= yardMaxX()
            && pos.getZ() >= yardMinZ() && pos.getZ() <= yardMaxZ()
            && pos.getY() > floorY() && pos.getY() <= roofY();
    }

    /**
     * Blocks in the yard that she may never clear, whatever is standing there.
     *
     * Every one of these is a way for "clear the yard" to become a task that can
     * never finish, which on this side of the codebase means she stands in a
     * field swinging at the same block until a watchdog drags her off:
     *
     *   bedrock and friends       - unbreakable, so the swing never lands.
     *   anything holding a fluid  - breaking a water source does not remove the
     *                               water, it re-flows into the hole. This also
     *                               covers waterlogged blocks, which she should
     *                               not be building next to anyway.
     *   blocks people placed      - the yard is ten blocks wide and the site
     *                               rules only promise nobody has built INSIDE
     *                               it. A neighbour's fence post is not hers to
     *                               remove, and quarrying one on a public server
     *                               is how the last claim denial happened.
     *   anything that does not
     *   block movement            - grass, flowers, a snow layer, fire. None of
     *                               them wall a house in, most grow back, and
     *                               snow REFORMS while it is snowing, which is
     *                               the same never-ending swing as bedrock.
     */
    private static final List<Block> YARD_LEAVE_ALONE = List.of(
        Blocks.BEDROCK, Blocks.BARRIER, Blocks.REINFORCED_DEEPSLATE, Blocks.LIGHT,
        Blocks.END_PORTAL, Blocks.END_PORTAL_FRAME, Blocks.END_GATEWAY,
        Blocks.COMMAND_BLOCK, Blocks.CHAIN_COMMAND_BLOCK, Blocks.REPEATING_COMMAND_BLOCK,
        Blocks.STRUCTURE_BLOCK, Blocks.STRUCTURE_VOID, Blocks.JIGSAW, Blocks.MOVING_PISTON,
        // breakable in principle, but only with gear a homesteader has no reason
        // to be carrying - and a yard is never worth a diamond pickaxe's teeth
        Blocks.OBSIDIAN, Blocks.CRYING_OBSIDIAN, Blocks.RESPAWN_ANCHOR, Blocks.ANCIENT_DEBRIS,
        // snow FALLS BACK. In a snowy biome a cleared layer is replaced by the
        // weather, so a yard she keeps sweeping keeps needing sweeping - the
        // tally moves every pass, which means no watchdog anywhere ever calls it
        // a loop. It is a job with no end that looks exactly like progress.
        Blocks.SNOW, Blocks.POWDER_SNOW);

    /** Is this yard block something she should - and can - actually clear? */
    public boolean isYardObstruction(BlockState state) {
        if (state == null || state.isAir()) return false;
        if (!state.getFluidState().isEmpty()) return false;
        if (!state.blocksMotion()) return false;
        if (YARD_LEAVE_ALONE.contains(state.getBlock())) return false;
        // ONE LIST, ONE TRUTH. The site survey already owns "did a person put
        // this here", and a second copy of that judgement here would drift from
        // it - she would refuse a site for a neighbour the yard then bulldozed.
        return !adris.altoclef.external.ExternalControlServer.isPlacedByPeople(state);
    }

    /** Intentional walk-through opening; subclasses decide its silhouette. */
    public abstract boolean isEntrance(BlockPos pos);

    /** Intentional holes in the top surface. */
    public abstract boolean isToastSlot(BlockPos pos);

    /** Exact torch positions - three up every lit wall column. */
    public abstract List<BlockPos> torchPositions();

    /** Which way the torch at this spot must point away from its wall. */
    public abstract Direction torchFacing(BlockPos pos);

    /** Every appliance block in the finished plan, in install order. */
    public abstract List<ToasterGeometry.Slot> applianceSlots();

    /** Where the beds go. Empty when this settlement has no floorplan. */
    public abstract List<BlockPos> bedPositions();

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

    /** Does this block already count as finished shell? */
    public boolean isShellMaterial(BlockState state) {
        if (state == null) return false;
        Block block = state.getBlock();
        return block == material || SHELL_STONE.contains(block);
    }

    public BlockState desiredState(BlockPos worldPos, BlockState current) {
        return desiredState(worldPos, current, List.of());
    }

    /**
     * @param available Baritone's estimate of what is placeable from the
     *                  inventory right now. Empty is legal (Baritone asks with
     *                  an empty list while masking), and then the shell falls
     *                  back to the preferred material.
     */
    public BlockState desiredState(BlockPos worldPos, BlockState current, List<BlockState> available) {
        // The yard is checked FIRST because it is the one region outside the
        // prism the schematic has an opinion about. Everything else outside is
        // none of her business and keeps whatever it is holding.
        if (inYard(worldPos)) {
            return isYardObstruction(current) ? Blocks.AIR.defaultBlockState() : current;
        }
        if (!inOuterPrism(worldPos)) return current;
        if (isEntrance(worldPos) || isToastSlot(worldPos)) return Blocks.AIR.defaultBlockState();
        if (isFloor(worldPos) || isRoof(worldPos) || isWall(worldPos)) {
            return shellState(current, available);
        }
        if (isInterior(worldPos)) {
            return preserveInterior(current) ? current : Blocks.AIR.defaultBlockState();
        }
        return current;
    }

    /**
     * What this shell position should hold.
     *
     * Stone already standing there is LEFT ALONE - that is what stops her
     * tearing a sound cobblestone wall down to re-place it in smooth stone,
     * and it is also why swapping the answer as her inventory changes can
     * never oscillate: once a block is placed it is its own correct answer.
     * Otherwise she spends the best shell stone she is actually carrying, and
     * only names the preferred material when she is carrying no stone at all.
     */
    public BlockState shellState(BlockState current, List<BlockState> available) {
        if (isShellMaterial(current)) return current;
        if (available != null && !available.isEmpty()) {
            for (Block stone : SHELL_STONE) {
                for (BlockState candidate : available) {
                    if (candidate != null && candidate.getBlock() == stone) return candidate;
                }
            }
        }
        return material.defaultBlockState();
    }

    /**
     * The block the index-th appliance goes in, or null once the plan is full.
     *
     * This used to be a grid computed here from minX/minZ and a column count,
     * and it was BOTH dead code and wrong: z was clamped with
     * Math.min(maxZ - 2, ...), which collapsed every row past the last onto one
     * line, so slot 18 was handed the block slot 15 already held. The floorplan
     * replaces it outright - the positions are read off the same map the shell
     * is built from, so a slot cannot land anywhere the house is not.
     */
    public BlockPos appliancePosition(int index) {
        List<ToasterGeometry.Slot> slots = applianceSlots();
        if (slots.isEmpty() || index < 0) return null;
        return slots.get(index % slots.size()).pos;
    }

    public Direction entranceFacing() { return Direction.NORTH; }
}
