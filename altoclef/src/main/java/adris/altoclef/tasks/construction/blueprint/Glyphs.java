package adris.altoclef.tasks.construction.blueprint;

import net.minecraft.core.BlockPos;

/**
 * THE ALPHABET EVERY PLAN IS WRITTEN IN.
 *
 * {@link adris.altoclef.tasks.construction.settlement.ToasterLayout} already
 * carries its own copy of most of these characters, and a second private copy is
 * how the old js/java floorplan split apart - two grids that had quietly stopped
 * agreeing about where appliance 18 goes. so the letters live here, once, and
 * ToasterLayout can adopt them without changing a single map it already reads.
 *
 * <pre>
 *   W shell (material rises by tier)   . interior air
 *   P porch (deck and corner posts - shell material, laid outside the house,
 *     lettered apart from 'W' only so it sorts into its own build rank)
 *   F furnace   C chest   K crafting table   B bed
 *   T floor torch   t wall torch   G glass pane
 *   D door / walk-through   S intentional opening   (char 0) off the map
 * </pre>
 *
 * D and S are CUT, never placed - a stage that "contained" them would have her
 * trying to fill in her own doorway.
 */
public final class Glyphs {
    private Glyphs() { }

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
    public static final char GLASS = 'G';
    public static final char PORCH = 'P';
    /** off the map entirely. */
    public static final char OUTSIDE = 0;

    /**
     * BUILD ORDER BY GLYPH - the order that survives contact with a bot.
     *
     * lifted wholesale from {@link
     * adris.altoclef.tasks.construction.settlement.ToasterLayout}, with the two
     * new letters slotted where they belong:
     *
     *  1. the SHELL, bottom course upward - a block placed in mid-air has no face
     *     to click on, and the block below it is that face. then the PORCH, which
     *     is the same material and the same ground work, just outside the door.
     *  2. the WALL TORCHES, the moment the shell around them exists - the first
     *     light on the build and the first thing that reads as somebody living
     *     there. then the GLASS, which finishes the wall before any furniture
     *     goes near it.
     *  3. the BENCH, then the BED, then the CHESTS - the three that turn a
     *     structure into somewhere she can sleep, craft and put things down. in
     *     that order because the bench is what makes the rest craftable.
     *  4. the FURNACES - the elements, and the single biggest lump of work.
     *  5. the FLOOR TORCHES last, because they are the one job that is still
     *     correct after everything else has moved around them.
     *
     * within a rank it is bottom course first, then by row, so she works a floor
     * at a time instead of criss-crossing the building.
     */
    public static final char[] BUILD_ORDER = {
        SHELL, PORCH, WALL_TORCH, GLASS, BENCH, BED, CHEST, FURNACE, TORCH
    };

    /** is this a letter any plan is allowed to contain? */
    public static boolean known(char glyph) {
        switch (glyph) {
            case SHELL: case AIR: case FURNACE: case CHEST: case BENCH: case BED:
            case TORCH: case WALL_TORCH: case DOOR: case OPENING: case GLASS:
            case PORCH: case OUTSIDE:
                return true;
            default:
                return false;
        }
    }

    /** does this glyph actually put a block down? openings and air do not. */
    public static boolean places(char glyph) {
        switch (glyph) {
            case SHELL: case PORCH: case FURNACE: case CHEST: case BENCH:
            case BED: case TORCH: case WALL_TORCH: case GLASS:
                return true;
            default:
                return false;
        }
    }

    /** is this cell meant to be open air she must never fill in? */
    public static boolean isOpening(char glyph) {
        return glyph == DOOR || glyph == OPENING;
    }

    /**
     * what a builder should call this cell.
     *
     * A LOOKUP, NEVER A DEFAULT. {@link
     * adris.altoclef.tasks.construction.settlement.ToasterGeometry.Slot#kind()}
     * ends in a bare {@code return "furnace"}, so a forgotten case there is not a
     * compile error - it is a slot burnt is sent to fill with a furnace while the
     * survey judges it against the block the plan really wants, and the gallery
     * rotates on it forever. this one throws instead.
     *
     * the porch deck answers "shell": it is laid in the shell material and it is
     * the same job to a builder. the glyph is still 'P' for anyone who cares
     * where it is.
     */
    public static String kindOf(char glyph) {
        switch (glyph) {
            case SHELL: return "shell";
            case PORCH: return "shell";
            case FURNACE: return "furnace";
            case CHEST: return "chest";
            case BENCH: return "crafting_table";
            case BED: return "bed";
            case TORCH: return "torch";
            case WALL_TORCH: return "wall_torch";
            case GLASS: return "glass_pane";
            default: throw new IllegalStateException("cell glyph '" + glyph + "' places nothing");
        }
    }

    /** one block a plan asks for: where, what glyph, and which layer it is on. */
    public static final class Cell {
        public final BlockPos pos;
        public final char glyph;
        public final int layer;

        public Cell(BlockPos pos, char glyph, int layer) {
            this.pos = pos;
            this.glyph = glyph;
            this.layer = layer;
        }

        public String kind() { return kindOf(glyph); }

        @Override
        public String toString() {
            return glyph + "@" + pos.getX() + "," + pos.getY() + "," + pos.getZ();
        }
    }
}
