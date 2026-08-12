package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.List;

/**
 * READING THE TOASTER OFF ITS PLAN.
 *
 * {@link ToasterPlan#LAYERS} is generated from the hand-built schematic, one map
 * per layer. This turns a world position into "what does the plan want here",
 * and a settlement plus a {@link ToasterTier.Stage} into the ordered list of
 * blocks she still owes.
 *
 * WHY LAYERED. The old plan was a single 2D map extruded upward, which can
 * describe a shed and cannot describe a toaster: the slots are cut through the
 * roof, the divider deck sits mid-height, and the two chambers hold different
 * things. Everything that makes it read as a toaster lives in the differences
 * between layers.
 *
 * The plan is anchored so layer 0 is the FLOOR COURSE - {@code floorY()} - and
 * it grows +z from {@code minZ()}. The doorstep juts two rows past the back of
 * the map on purpose; it is part of the plan, not a mistake, and it is what the
 * two wall torches flank.
 */
public final class ToasterLayout {
    private ToasterLayout() { }

    public static final char SHELL = 'W';
    public static final char AIR = '.';
    public static final char FURNACE = 'F';
    public static final char CHEST = 'C';
    public static final char BENCH = 'K';
    public static final char BED = 'B';
    public static final char TORCH = 'T';
    public static final char WALL_TORCH = 't';
    public static final char DOOR = 'D';
    public static final char OPENING = 'S';
    /** Off the map entirely. */
    public static final char OUTSIDE = 0;

    public static int width() { return ToasterPlan.LAYERS[0][0].length(); }
    public static int depth() { return ToasterPlan.LAYERS[0].length; }
    public static int height() { return ToasterPlan.LAYERS.length; }

    /** True when this settlement is exactly the size the plan was drawn at. */
    public static boolean applies(Settlement s) {
        return s.width() == width() && s.depth() == depth() && s.height() == height();
    }

    /** What the plan wants at this world position, or {@link #OUTSIDE}. */
    public static char glyphAt(Settlement s, BlockPos pos) {
        int layer = pos.getY() - s.floorY();
        int dx = pos.getX() - s.minX();
        int dz = pos.getZ() - s.minZ();
        if (layer < 0 || layer >= height()) return OUTSIDE;
        if (dz < 0 || dz >= depth()) return OUTSIDE;
        String row = ToasterPlan.LAYERS[layer][dz];
        if (dx < 0 || dx >= row.length()) return OUTSIDE;
        return row.charAt(dx);
    }

    /** The world position of a plan cell. */
    public static BlockPos posOf(Settlement s, int layer, int dx, int dz) {
        return new BlockPos(s.minX() + dx, s.floorY() + layer, s.minZ() + dz);
    }

    /**
     * What block the plan wants standing here, or null when the answer is air.
     *
     * The shell's material is a parameter because it climbs with her means - see
     * {@link ToasterTier#materialLadder}. Everything else is what it is.
     */
    public static Block wantedBlock(char glyph, Block shellMaterial) {
        switch (glyph) {
            case SHELL: return shellMaterial;
            case FURNACE: return Blocks.FURNACE;
            case CHEST: return Blocks.CHEST;
            case BENCH: return Blocks.CRAFTING_TABLE;
            case BED: return Blocks.RED_BED;
            case TORCH: return Blocks.TORCH;
            case WALL_TORCH: return Blocks.WALL_TORCH;
            default: return null;                       // air, doorway, slot, outside
        }
    }

    /** Is this cell meant to be open air she must never fill in? */
    public static boolean isOpening(char glyph) {
        return glyph == DOOR || glyph == OPENING;
    }

    /** One block the plan asks for: where, what glyph, and which layer it is on. */
    public static final class Cell {
        public final BlockPos pos;
        public final char glyph;
        public final int layer;

        Cell(BlockPos pos, char glyph, int layer) {
            this.pos = pos;
            this.glyph = glyph;
            this.layer = layer;
        }

        public String kind() {
            switch (glyph) {
                case SHELL: return "shell";
                case FURNACE: return "furnace";
                case CHEST: return "chest";
                case BENCH: return "crafting_table";
                case BED: return "bed";
                case TORCH: return "torch";
                case WALL_TORCH: return "wall_torch";
                default: throw new IllegalStateException("cell glyph '" + glyph + "' places nothing");
            }
        }
    }

    /**
     * EVERY BLOCK THE STAGE OWES, IN THE ORDER SHE SHOULD LAY IT.
     *
     * The order is the one that survives contact with a bot:
     *
     *  1. the SHELL, bottom course upward - a block placed in mid-air has no face
     *     to click on, and the block below it is that face. The floor first of
     *     all, because she stands on it to build everything above.
     *  2. the two TORCHES BY THE DOOR, the moment the shell around them exists -
     *     they are the first light on the build and the first thing that reads as
     *     somebody living there.
     *  3. the BENCH, then the BED, then the CHESTS - the three that turn a
     *     structure into somewhere she can sleep, craft and put things down. In
     *     that order because the bench is what makes the rest craftable.
     *  4. the FURNACES - the elements, and the single biggest lump of work.
     *  5. the FLOOR TORCHES last, because they are the one job that is still
     *     correct after everything else has moved around them.
     *
     * Within a rank it is bottom course first, then by row, so she works a floor
     * at a time instead of criss-crossing the building.
     */
    public static List<Cell> cellsFor(Settlement s, ToasterTier.Stage stage) {
        List<Cell> out = new ArrayList<>();
        // what this stage has actually claimed so far, in plan coordinates. ORDER
        // puts every placeable rank ahead of the floor torches, so by the time a
        // torch is considered this set is complete for everything under it.
        java.util.Set<Integer> claimed = new java.util.HashSet<>();
        for (char rank : ORDER) {
            int budget = ToasterTier.budgetFor(rank, stage);
            if (budget <= 0 || !ToasterTier.inStage(rank, stage)) continue;
            int taken = 0;
            for (int layer = 0; layer < height() && taken < budget; layer++) {
                for (int dz = 0; dz < depth() && taken < budget; dz++) {
                    String row = ToasterPlan.LAYERS[layer][dz];
                    for (int dx = 0; dx < row.length() && taken < budget; dx++) {
                        if (row.charAt(dx) != rank) continue;
                        // A TORCH NEEDS SOMETHING TO STAND ON, AND THE STAGE
                        // DECIDES WHETHER IT EXISTS YET.
                        //
                        // 104 of the plan's 106 torches stand on the furnace
                        // banks - layer 4 sits on layer 3's F, layer 9 on layer
                        // 8's. LIVED_IN builds no furnaces, so asking for the 12
                        // lowest torches bottom-up asks for 12 torches hanging in
                        // mid-air over blocks that this stage never places. the
                        // house then can never satisfy the stage and the lighting
                        // step rotates on impossible cells forever, ~12s each.
                        //
                        // this is a PLAN question, not a world question: the cell
                        // below is either shell (always there) or a fixture whose
                        // rank has already been decided above. so an unsupported
                        // torch is skipped WITHOUT spending budget, and the tally
                        // never learns to ignore outstanding work - the cell is
                        // simply not part of this stage, and it comes back the
                        // moment the stage that builds its support arrives.
                        if (rank == TORCH && !supported(layer, dx, dz, claimed)) continue;
                        out.add(new Cell(posOf(s, layer, dx, dz), rank, layer));
                        claimed.add(key(layer, dx, dz));
                        taken++;
                    }
                }
            }
        }
        return out;
    }

    private static int key(int layer, int dx, int dz) {
        return (layer * depth() + dz) * width() + dx;
    }

    /** is the block a floor torch would stand on part of this stage's work? */
    private static boolean supported(int layer, int dx, int dz, java.util.Set<Integer> claimed) {
        if (layer == 0) return true;
        char below = ToasterPlan.LAYERS[layer - 1][dz].charAt(dx);
        if (below == SHELL) return true;
        return claimed.contains(key(layer - 1, dx, dz));
    }

    /** Build order by glyph. See {@link #cellsFor}. */
    private static final char[] ORDER = { SHELL, WALL_TORCH, BENCH, BED, CHEST, FURNACE, TORCH };

    /**
     * Which way a wall torch points.
     *
     * The torch hangs off a wall and points AWAY from it, so the answer is
     * whichever neighbouring cell is shell. Getting this wrong is not cosmetic:
     * PlaceBlockTask compares the whole blockstate, so a torch asked for with the
     * wrong facing can never be satisfied and the lighting step rotates on it
     * forever.
     */
    public static Direction wallTorchFacing(Settlement s, BlockPos pos) {
        for (Direction d : Direction.Plane.HORIZONTAL) {
            if (glyphAt(s, pos.relative(d.getOpposite())) == SHELL) return d;
        }
        return Direction.NORTH;
    }

    /** Everything the plan wants, ignoring stages - for manifests and probes. */
    public static java.util.Map<Character, Integer> tally() {
        java.util.Map<Character, Integer> counts = new java.util.LinkedHashMap<>();
        for (String[] layer : ToasterPlan.LAYERS) {
            for (String row : layer) {
                for (char c : row.toCharArray()) counts.merge(c, 1, Integer::sum);
            }
        }
        return counts;
    }
}
