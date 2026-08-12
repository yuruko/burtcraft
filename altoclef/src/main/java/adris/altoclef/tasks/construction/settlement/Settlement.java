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

    /**
     * How far apart the ground torches in the yard stand.
     *
     * A torch is light level 14 and block light drops 1 per block travelled, so a
     * spot goes dark at 14 blocks. On a ten-block grid the worst place to stand -
     * dead centre of four torches - is 5+5 away, which is light 4. That leaves
     * three whole blocks of slack for ground that is not perfectly level, and
     * hostile mobs need light ZERO, not low light. Tighter than this is just more
     * walking; the yard is already the thing being lit, not the horizon.
     */
    public static final int PERIMETER_LIGHT_SPACING = 10;

    /**
     * WHERE THE YARD GETS ITS TORCHES.
     *
     * The floorplan's thirty-six wall torches light the INSIDE of the house, which
     * stops things spawning in her kitchen and does nothing whatsoever about the
     * ten metres of cleared, unlit ground she put around it. That ground is a mob
     * farm with a view: the log has zombies at the wall, a creeper flee-loop, and
     * two villagers killed within a minute of each other, all at the homestead.
     *
     * So the yard is lit on a grid, and the grid is DERIVED from the yard the same
     * way {@link #quarryMouth()} is derived from the anchor - never stored. A
     * remembered list would be a second copy of settlement geometry to drift out
     * of sync with the first, which is the mistake the floorplan already taught us
     * once, and this way an existing homestead gets its lights the moment the new
     * jar loads with nothing to migrate.
     *
     * Torches stand at floorY + 1, on the ground at floorY: the yard-clearing job
     * empties everything ABOVE the floor course, so that is the one height in the
     * yard guaranteed to be air with something underneath it. Which is also why
     * this work comes after the yard is clear - lighting a forest is placing
     * torches on leaves.
     *
     * The house's own footprint is skipped; it has its own torches inside and its
     * walls are not ground.
     */
    public List<BlockPos> perimeterLightPositions() {
        List<BlockPos> spots = new ArrayList<>();
        int y = floorY() + 1;
        for (int x : lightStops(yardMinX(), yardMaxX())) {
            for (int z : lightStops(yardMinZ(), yardMaxZ())) {
                if (x >= minX() && x <= maxX() && z >= minZ() && z <= maxZ()) continue;
                spots.add(new BlockPos(x, y, z));
            }
        }
        return spots;
    }

    /**
     * Evenly spaced stops across a span, both ends included, no gap wider than
     * {@link #PERIMETER_LIGHT_SPACING}.
     *
     * Stepping from one edge and stopping when the next step would overshoot
     * leaves the far edge of the yard - a whole unlit strip on two sides of the
     * house - so the count is rounded UP and the stops distributed across it
     * instead. Rounding each stop to a whole block can shorten one gap by a block;
     * it can never lengthen one past the spacing, which is the only property the
     * lighting depends on.
     */
    private static int[] lightStops(int min, int max) {
        int span = max - min;
        if (span <= 0) return new int[] { min };
        int steps = Math.max(1, (int) Math.ceil((double) span / PERIMETER_LIGHT_SPACING));
        int[] stops = new int[steps + 1];
        for (int i = 0; i <= steps; i++) {
            stops[i] = min + (int) Math.round((double) span * i / steps);
        }
        return stops;
    }

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

    /**
     * THE TRENCH: a dry moat around the whole encampment, outside the lit yard.
     *
     * The yard's torch grid means nothing spawns INSIDE the perimeter any more, so
     * the only creeper left is one that spawned in the dark somewhere else and
     * walked in. Four is the number that stops it: a mob's pathfinder refuses a
     * drop of more than three, so at four she is not a wall it climbs but a route
     * it never considers. Two wide because a mob clears a one-block gap in its
     * stride, and a one-wide trench is a kerb.
     *
     * It sits OUTSIDE the yard rather than at its edge, because
     * {@link #perimeterLightPositions()} puts torches on yardMinX/yardMaxX exactly
     * - a trench there would dig out the lighting that made the yard safe.
     */
    public static final int TRENCH_DEPTH = 4;
    public static final int TRENCH_WIDTH = 2;

    public int trenchMinX() { return yardMinX() - TRENCH_WIDTH; }
    public int trenchMaxX() { return yardMaxX() + TRENCH_WIDTH; }
    public int trenchMinZ() { return yardMinZ() - TRENCH_WIDTH; }
    public int trenchMaxZ() { return yardMaxZ() + TRENCH_WIDTH; }

    /** The solid course under the void - the one row she must NOT dig through. */
    public int trenchFloorY() { return floorY() - TRENCH_DEPTH; }

    /**
     * Is this column part of the ring? The yard and the house are not.
     *
     * The single gate for the whole feature: every other trench predicate runs
     * through here, so a settlement with no trench has no trench geometry, no
     * schematic opinion below its floor, and no placement veto.
     */
    public boolean inTrenchColumn(BlockPos pos) {
        if (!trenchEnabled) return false;
        int x = pos.getX(), z = pos.getZ();
        if (x < trenchMinX() || x > trenchMaxX() || z < trenchMinZ() || z > trenchMaxZ()) return false;
        return x < yardMinX() || x > yardMaxX() || z < yardMinZ() || z > yardMaxZ();
    }

    /**
     * THE CAUSEWAY IS A BRIDGE, NOT A DAM.
     *
     * One crossing, on the +Z face, because that is the way to
     * {@link #quarryMouth()} and every stone restock walks it. One is enough for
     * everything else too: the yard is ten blocks of open ground, so once she is
     * inside the ring she reaches any wall of the house without crossing again.
     *
     * Solid at the floor course ONLY, with the void continuing underneath. A
     * causeway dug down to the trench floor would be a dam, cutting the ring into
     * segments - and then a fall into the far segment is a trap, because the one
     * staircase is on the other side of a four-block wall. Left as a bridge, the
     * trench floor runs unbroken all the way round and she can always walk to the
     * stairs from wherever she fell in.
     */
    public boolean isTrenchCauseway(BlockPos pos) {
        return pos.getY() == floorY()
            && pos.getX() == anchor.getX()
            && pos.getZ() > yardMaxZ() && pos.getZ() <= trenchMaxZ();
    }

    /** Where the fence gate stands: the outer lip, so nothing can step onto the bridge. */
    public BlockPos causewayGate() {
        return new BlockPos(anchor.getX(), floorY() + 1, trenchMaxZ());
    }

    /** First column of the stair run. */
    private int stairX() { return anchor.getX() + 2; }

    /**
     * OFF UNTIL SOMEONE ASKS. A trench is roughly 1250 block breaks, and switching
     * it on by default would have every homestead already standing read as
     * incomplete on the next survey and start digging unannounced.
     */
    private boolean trenchEnabled = false;
    public boolean trenchEnabled() { return trenchEnabled; }
    public void setTrenchEnabled(boolean enabled) { this.trenchEnabled = enabled; }

    /**
     * HOW DEEP SHE IS ALLOWED TO DIG RIGHT NOW - the layer gate, and the reason
     * she can always get back out.
     *
     * Handed the whole four courses at once, the builder works by proximity and
     * will sink one four-deep pit wherever it happens to start. If that pit is not
     * the stair run, she is standing at the bottom of a hole she cannot jump out
     * of and cannot pillar out of, because bridging is vetoed - the trap the veto
     * itself creates. Opening one course at a time keeps the whole ring level, so
     * the stairs are never more than a course deeper than the ground beside them
     * and the way out exists at every moment of the dig.
     *
     * Full depth by default: a settlement nobody is actively building has no
     * reason to describe itself as half-dug.
     */
    private int trenchDepthAllowed = TRENCH_DEPTH;
    public int trenchDepthAllowed() { return trenchDepthAllowed; }
    public void setTrenchDepthAllowed(int courses) {
        this.trenchDepthAllowed = Math.max(0, Math.min(TRENCH_DEPTH, courses));
    }

    /**
     * The top of the solid ground beneath a ring column.
     *
     * Normally the trench floor. In the stair run it climbs a block at a time, so
     * the steps fall out of the same arithmetic that carves the void instead of
     * being a second description of the same geometry.
     *
     * SHE WILL END UP DOWN THERE whether or not she means to: from the lip, the
     * far bottom corner is about six blocks from her eyes and her reach is 4.5, so
     * the bottom course cannot be dug from above. The staircase is not a
     * convenience, it is the only way the job is possible - and the only way out
     * if she falls, since bridging is vetoed and four blocks is too tall to jump.
     */
    public int trenchFinalGroundY(int x, int z) {
        if (z == yardMaxZ() + 1 && x >= stairX() && x < stairX() + TRENCH_DEPTH) {
            return floorY() - 1 - (x - stairX());
        }
        return trenchFloorY();
    }

    /**
     * The finished shape, clamped to whatever course the layer gate has opened.
     *
     * Clamping the STAIRS by the same rule is what keeps them usable mid-dig: at
     * two courses open the run is a single step down to a two-deep floor, at four
     * it is the full flight. The exit is never a thing she finishes later.
     */
    public int trenchGroundY(int x, int z) {
        return Math.max(trenchFinalGroundY(x, z), floorY() - trenchDepthAllowed);
    }

    /** The air she has to carve: everything above this column's floor, up to grade. */
    public boolean inTrenchVoid(BlockPos pos) {
        if (!inTrenchColumn(pos)) return false;
        if (isTrenchCauseway(pos)) return false;
        return pos.getY() > trenchGroundY(pos.getX(), pos.getZ()) && pos.getY() <= floorY();
    }

    /**
     * Where nothing may ever be placed. The void MINUS its bottom course, and the
     * difference is load-bearing in both directions.
     *
     * {@code WorldHelper.canPlace} asks this before every placement, so a veto
     * covering the full depth would refuse her own trench torches - they stand one
     * above each column's floor - and an unlit ring is the one outcome that makes
     * the whole job a net loss.
     *
     * Exempting only that course still closes the crossing: the three above it
     * stay vetoed, so a pillar gets exactly one block tall and stops, and three
     * blocks is too far to jump. Nothing ever asks to fill the course anyway,
     * because the seal beneath it is already solid ground she can walk on.
     */
    public boolean inTrenchNoPlaceZone(BlockPos pos) {
        return inTrenchVoid(pos) && pos.getY() > trenchGroundY(pos.getX(), pos.getZ()) + 1;
    }

    /**
     * Torches on the trench floor, on the same grid rule as the yard.
     *
     * Without these the trench is a four-block-deep unlit ditch ringing the base -
     * which at night is a spawn platform for exactly the creepers it was dug to
     * keep out, only now they are inside the line. Placed one above each column's
     * own floor so a torch in the stair run lands on the step rather than inside
     * the rock holding it up.
     */
    public List<BlockPos> trenchLightPositions() {
        List<BlockPos> spots = new ArrayList<>();
        if (!trenchEnabled) return spots;
        int innerZLow = yardMinZ() - 1, innerZHigh = yardMaxZ() + 1;
        int innerXLow = yardMinX() - 1, innerXHigh = yardMaxX() + 1;
        for (int x : lightStops(trenchMinX(), trenchMaxX())) {
            spots.add(new BlockPos(x, trenchGroundY(x, innerZLow) + 1, innerZLow));
            spots.add(new BlockPos(x, trenchGroundY(x, innerZHigh) + 1, innerZHigh));
        }
        for (int z : lightStops(yardMinZ(), yardMaxZ())) {
            spots.add(new BlockPos(innerXLow, trenchGroundY(innerXLow, z) + 1, z));
            spots.add(new BlockPos(innerXHigh, trenchGroundY(innerXHigh, z) + 1, z));
        }
        return spots;
    }

    /**
     * SHE MUST NEVER BRIDGE HER OWN MOAT.
     *
     * {@code MovementTraverse} prices a gap crossing as walk + place whenever it
     * can find something to place against, so by default a path straight over the
     * trench is simply cheaper than walking round to the gate - and one dirt block
     * turns the whole ring back into open ground. Vetoing placement inside the
     * void puts that route beyond the PATHFINDER rather than beyond the rules:
     * {@code CalculationContext} consults this before a cost is ever assigned, so
     * the bridge is not a thing she declines to do, it is not a thing she can see.
     *
     * Registered through {@code protectStructurePlacement}, NOT {@code
     * avoidBlockPlace}, for the reason spelled out on {@code _structureAvoiders}:
     * the plain avoider lists are snapshotted by BotBehaviour and cleared on every
     * pop, so a veto registered by the build task dies the moment the build ends -
     * which is precisely when a plain {@code @goto} would price the shortcut.
     *
     * The causeway, the steps and the floor seal are all EXEMPT, or the trench
     * could never be finished: every one of them is a block she has to place
     * inside the ring.
     */
    public void protectTrenchFromBridging() {
        baritone.altoclef.AltoClefSettings.getInstance()
            .protectStructurePlacement(protectionId() + "/trench", this::inTrenchNoPlaceZone);
    }

    /**
     * A stable name for this settlement in the protection registry, so resuming
     * a build re-states the same rule instead of stacking another copy of it
     * onto the pathing thread's per-block check.
     */
    public String protectionId() {
        return kind() + "@" + anchor.getX() + "," + anchor.getY() + "," + anchor.getZ();
    }

    /**
     * THE HOUSE IS NOT A SHORTCUT.
     *
     * Baritone prices a wall as ordinary stone, so cutting through the toaster is
     * routinely a couple of blocks cheaper than walking to the door - and she did
     * exactly that, repeatedly, to her own home.
     *
     * The guard for this already existed, but it was registered on a BotBehaviour
     * frame in {@code ToasterBuildTask.onStart} and popped in {@code onStop}. That
     * protects the house only while she is BUILDING it, which is the one time she
     * is not trying to walk past it. Registering here instead
     * ({@link baritone.altoclef.AltoClefSettings#protectStructure}) puts the rule
     * somewhere the behaviour stack cannot wipe, so it holds during `@goto`, a
     * mining trip, a flee, and while nothing is running at all.
     *
     * ONLY FINISHED SHELL IS PROTECTED, which is what keeps the builder working:
     * a shell position holding the WRONG block still gets cleared and re-laid, the
     * interior still gets swept, and the entrance and toast slots still get opened
     * out - none of those hold shell material, so none of them match.
     */
    public void protectFromMining(java.util.function.Supplier<net.minecraft.world.level.BlockGetter> world) {
        baritone.altoclef.AltoClefSettings.getInstance().protectStructure(protectionId(), pos -> {
            // Geometry first: this runs on every candidate block break in the
            // world, and six int comparisons reject everything but this site.
            if (!inOuterPrism(pos)) return false;
            if (!isFloor(pos) && !isRoof(pos) && !isWall(pos)) return false;
            if (isEntrance(pos) || isToastSlot(pos)) return false;
            // Runs on BARITONE'S PATHING THREAD, which outlives the world by a
            // moment while the game is closing - an unguarded world read there
            // threw an NPE straight out of the path finder (2026-08-05 08:37:35).
            // No world means no opinion; protecting nothing is safe when
            // everything is being torn down anyway.
            net.minecraft.world.level.BlockGetter level = world == null ? null : world.get();
            if (level == null) return false;
            return isShellMaterial(level.getBlockState(pos));
        });
    }

    /**
     * HOW MUCH OF THE PLAN IS IN SCOPE RIGHT NOW.
     *
     * {@link ToasterTier} says the tier is read off the world and never stored,
     * and that is the right rule - but {@link #applianceSlots()} is the thing
     * that has to shrink and it has no world handle to read. So the stage lives
     * here as a CACHE, not as memory: ToasterBuildTask recomputes it from the
     * world on every survey (about once a second) and only ever moves it
     * forward within a session. Nothing persists it, so a house she demolished
     * is back at SHELL the moment anyone looks at it.
     *
     * FULL by default, which is exactly today's behaviour for every settlement
     * that is not built from the layered plan: the old extruded geometry has no
     * stages and never reads this.
     */
    private ToasterTier.Stage stage = ToasterTier.Stage.FULL;

    public ToasterTier.Stage stage() { return stage; }

    /** @param stage the stage the world is currently at; null is ignored. */
    public void setStage(ToasterTier.Stage stage) {
        if (stage != null) this.stage = stage;
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

    /**
     * THE SHELL UPGRADE TARGET, or null while she is just building a house.
     *
     * Normally ANY shell stone counts as finished, which is what stops her
     * tearing down a sound cobblestone wall to re-place it in smooth stone. But
     * that same rule makes an upgrade impossible to express: with cobble reading
     * as correct forever, "make the shell iron" is a job with nothing outstanding
     * in it, and she stands in a finished house holding iron blocks.
     *
     * So an upgrade names ONE block, and while it is named only that block is
     * correct. The anti-oscillation guarantee moves rather than disappears: it
     * used to come from "anything stone is its own answer", and now it comes from
     * the target being STICKY - see {@link ToasterTier#buildingMaterial}, which
     * only climbs a rung when she is holding a full stack of the better block, so
     * the answer cannot flicker every time a furnace finishes.
     */
    private Block shellUpgradeTarget = null;

    public Block shellUpgradeTarget() { return shellUpgradeTarget; }

    /** @param target the block the shell must become, or null to accept any shell stone again. */
    public void setShellUpgradeTarget(Block target) {
        this.shellUpgradeTarget = target;
    }

    /** Does this block already count as finished shell? */
    public boolean isShellMaterial(BlockState state) {
        if (state == null) return false;
        Block block = state.getBlock();
        if (shellUpgradeTarget != null) return block == shellUpgradeTarget;
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
        if (inTrenchColumn(worldPos)) return trenchState(worldPos, current, available);
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
     * What the ring should hold, course by course.
     *
     * The void reuses {@link #isYardObstruction} rather than inventing a second
     * rule, which makes the trench literally "yard, below grade" - and inherits
     * the refusals that matter most down here for free. A fluid answers CURRENT,
     * so a spring or an aquifer in the ring reads as already-correct and drops out
     * of the tally instead of becoming a cell she can never satisfy: a wet segment
     * is still a segment nothing walks across, and this is the shape that has
     * stalled every other never-ending job in this file.
     */
    private BlockState trenchState(BlockPos worldPos, BlockState current, List<BlockState> available) {
        int y = worldPos.getY();
        // Above grade the ring is felled exactly like the yard. Not cosmetic: sand
        // and gravel left leaning over an open trench pour into it, and a tally
        // that refills itself every pass is the snow trap with a longer fuse.
        if (y > floorY() && y <= roofY()) {
            return isYardObstruction(current) ? Blocks.AIR.defaultBlockState() : current;
        }
        // Checked before the void, which also covers floorY.
        if (isTrenchCauseway(worldPos)) return shellState(current, available);
        int ground = trenchGroundY(worldPos.getX(), worldPos.getZ());
        if (y == ground) {
            // THE SEAL. A four-deep ring will open caves, and an unsealed breach
            // turns the trench from a wall into a tunnel that delivers mobs inside
            // the perimeter - strictly worse than never having dug it.
            //
            // Only ever laid at the FINISHED depth. Sealing whatever rock the layer
            // gate is currently resting on would be laying a floor she is about to
            // dig back out on the next course.
            if (ground != trenchFinalGroundY(worldPos.getX(), worldPos.getZ())) return current;
            boolean hollow = current.isAir() || !current.getFluidState().isEmpty();
            return hollow ? shellState(current, available) : current;
        }
        if (y > ground && y <= floorY()) {
            return isYardObstruction(current) ? Blocks.AIR.defaultBlockState() : current;
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
        // an upgrade names exactly one block, so there is nothing to choose: the
        // spot holds the wrong thing and the answer is the target. offering her
        // "whatever stone is in the bag" here is what would put a renovation half
        // in cobble.
        if (shellUpgradeTarget != null) return shellUpgradeTarget.defaultBlockState();
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
