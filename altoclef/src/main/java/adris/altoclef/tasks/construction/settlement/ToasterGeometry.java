package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * THE FLOORPLAN.
 *
 * One ascii map decides where every fixture in a toaster lives. The controller's
 * node side parses byte-identical strings (core/settlements.js), so
 * the shell built in here and the gallery she is sent to fill can never drift
 * apart - which is exactly how the old layout went wrong, with a js grid and a
 * java grid that had quietly stopped agreeing about where appliance 18 goes.
 *
 * <pre>
 *   W = shell wall      T = wall torch      C = chest
 *   F = furnace         S = smoker          B = bed
 *   ' ' on the top row  = the walk-through
 * </pre>
 *
 * Every T/C/F/S is a COLUMN OF THREE - one on the ground, one above that, one
 * above that. Banks of appliances up the walls is what makes the inside read as
 * a toaster instead of a shed with a furnace in it.
 *
 * A settlement whose footprint does not match its map (a hand-typed
 * {@code @toaster_build} at some other size) falls back to the old parametric
 * geometry rather than refusing to build.
 */
public final class ToasterGeometry {
    private ToasterGeometry() { }

    /** One on the ground, one above that, one above that. */
    public static final int STACK_HEIGHT = 3;

    private static final String[] HOMESTEAD_PLAN = {
        "WWWWWW  WWWWWW",
        "WSFTCT  TCTFSW",
        "WT          TW",
        "WF          FW",
        "WT          TW",
        "WF   FBBF   FW",
        "WT   FBBF   TW",
        "WSTFFFFFFFFTSW",
        "WWWWWWWWWWWWWW"
    };

    /** The same idea at outpost scale. */
    private static final String[] OUTPOST_PLAN = {
        "WWWWW  WWWWW",
        "WSFTC  CTFSW",
        "WT        TW",
        "WF   BB   FW",
        "WT        TW",
        "WSTFFFFFFTSW",
        "WWWWWWWWWWWW"
    };

    /**
     * Install order rotates through the kinds, so the first three appliances she
     * ever fits are a chest, a furnace and a smoker rather than eighteen
     * furnaces and then, eventually, somewhere to put anything.
     */
    private static final List<Block> INSTALL_WAVE = List.of(Blocks.CHEST, Blocks.FURNACE, Blocks.SMOKER);

    /** One appliance block: where it goes, what it is, and which course it is on. */
    public static final class Slot {
        public final BlockPos pos;
        public final Block block;
        public final int level;

        Slot(BlockPos pos, Block block, int level) {
            this.pos = pos;
            this.block = block;
            this.level = level;
        }

        public String kind() {
            if (block == Blocks.CHEST) return "chest";
            if (block == Blocks.SMOKER) return "smoker";
            return "furnace";
        }
    }

    private static class Cell {
        final int dx;
        final int dz;
        Cell(int dx, int dz) { this.dx = dx; this.dz = dz; }
    }

    private static final class TorchCell extends Cell {
        final Direction facing;
        TorchCell(int dx, int dz, Direction facing) { super(dx, dz); this.facing = facing; }
    }

    private static final class FixtureCell extends Cell {
        final Block block;
        FixtureCell(int dx, int dz, Block block) { super(dx, dz); this.block = block; }
    }

    private static final class Plan {
        final int width;
        final int depth;
        final List<Cell> entrance;
        final List<TorchCell> torches;
        final List<FixtureCell> columns;
        final List<Cell> beds;

        Plan(int width, int depth, List<Cell> entrance, List<TorchCell> torches,
             List<FixtureCell> columns, List<Cell> beds) {
            this.width = width;
            this.depth = depth;
            this.entrance = entrance;
            this.torches = torches;
            this.columns = columns;
            this.beds = beds;
        }
    }

    private static final Plan HOMESTEAD = parse(HOMESTEAD_PLAN);
    private static final Plan OUTPOST = parse(OUTPOST_PLAN);

    /**
     * A wall torch's facing points AWAY from the block holding it up, so the
     * value is decided by which wall the column hugs. Getting this wrong is not
     * cosmetic: PlaceBlockTask compares the whole blockstate, so a torch asked
     * for with the wrong facing can never be satisfied and the lighting step
     * rotates on it forever.
     */
    private static Direction torchFacing(int dx, int dz, int width, int depth) {
        if (dx == 1) return Direction.EAST;
        if (dx == width - 2) return Direction.WEST;
        if (dz == 1) return Direction.SOUTH;
        if (dz == depth - 2) return Direction.NORTH;
        return null;
    }

    private static Plan parse(String[] rows) {
        int depth = rows.length;
        int width = rows[0].length();
        List<Cell> entrance = new ArrayList<>();
        List<TorchCell> torches = new ArrayList<>();
        List<FixtureCell> columns = new ArrayList<>();
        List<Cell> beds = new ArrayList<>();
        for (int dz = 0; dz < depth; dz++) {
            String row = rows[dz];
            if (row.length() != width) {
                throw new IllegalStateException("toaster plan row " + dz + " is " + row.length() + " wide, expected " + width);
            }
            for (int dx = 0; dx < width; dx++) {
                char cell = row.charAt(dx);
                boolean edge = dx == 0 || dz == 0 || dx == width - 1 || dz == depth - 1;
                if (edge) {
                    if (cell == ' ') entrance.add(new Cell(dx, dz));
                    else if (cell != 'W') throw new IllegalStateException("toaster plan has '" + cell + "' on the shell at " + dx + "," + dz);
                    continue;
                }
                switch (cell) {
                    case ' ' -> { }
                    case 'B' -> beds.add(new Cell(dx, dz));
                    case 'T' -> {
                        Direction facing = torchFacing(dx, dz, width, depth);
                        if (facing == null) throw new IllegalStateException("toaster plan torch at " + dx + "," + dz + " is not against a wall");
                        torches.add(new TorchCell(dx, dz, facing));
                    }
                    case 'C' -> columns.add(new FixtureCell(dx, dz, Blocks.CHEST));
                    case 'F' -> columns.add(new FixtureCell(dx, dz, Blocks.FURNACE));
                    case 'S' -> columns.add(new FixtureCell(dx, dz, Blocks.SMOKER));
                    default -> throw new IllegalStateException("toaster plan has unknown fixture '" + cell + "' at " + dx + "," + dz);
                }
            }
        }
        if (entrance.isEmpty()) throw new IllegalStateException("toaster plan has no walk-through");
        return new Plan(width, depth, entrance, torches, waveOrder(columns), beds);
    }

    private static List<FixtureCell> waveOrder(List<FixtureCell> columns) {
        Map<Block, List<FixtureCell>> pools = new LinkedHashMap<>();
        for (Block kind : INSTALL_WAVE) pools.put(kind, new ArrayList<>());
        for (FixtureCell cell : columns) pools.computeIfAbsent(cell.block, key -> new ArrayList<>()).add(cell);
        List<FixtureCell> ordered = new ArrayList<>(columns.size());
        while (ordered.size() < columns.size()) {
            boolean moved = false;
            for (List<FixtureCell> pool : pools.values()) {
                if (pool.isEmpty()) continue;
                ordered.add(pool.remove(0));
                moved = true;
            }
            if (!moved) break;
        }
        return ordered;
    }

    /** The map for this settlement, or null when its footprint is a different size. */
    private static Plan planFor(Settlement s) {
        Plan plan = "outpost".equals(s.role()) ? OUTPOST : HOMESTEAD;
        return plan.width == s.width() && plan.depth == s.depth() ? plan : null;
    }

    /** True when the settlement is exactly the size its floorplan was drawn at. */
    public static boolean planApplies(Settlement s) {
        return planFor(s) != null;
    }

    public static boolean isEntrance(Settlement s, BlockPos pos) {
        if (pos.getY() < s.floorY() + 1 || pos.getY() > s.floorY() + 2) return false;
        Plan plan = planFor(s);
        if (plan == null) {
            int centre = s.minX() + s.width() / 2;
            return pos.getZ() == s.minZ() && pos.getX() >= centre - 1 && pos.getX() <= centre + 1;
        }
        int dx = pos.getX() - s.minX();
        int dz = pos.getZ() - s.minZ();
        for (Cell gap : plan.entrance) {
            if (gap.dx == dx && gap.dz == dz) return true;
        }
        return false;
    }

    public static boolean isToastSlot(Settlement s, BlockPos pos) {
        if (pos.getY() != s.roofY()) return false;
        int centreZ = s.minZ() + s.depth() / 2;
        int firstZ = Math.max(s.minZ() + 2, centreZ - 2);
        int secondZ = Math.min(s.maxZ() - 2, centreZ + 2);
        return (pos.getZ() == firstZ || pos.getZ() == secondZ)
            && pos.getX() >= s.minX() + 3 && pos.getX() <= s.maxX() - 3;
    }

    /** Three torches up each wall column, low to high. */
    public static List<BlockPos> torchPositions(Settlement s) {
        Plan plan = planFor(s);
        List<BlockPos> result = new ArrayList<>();
        if (plan == null) {
            int y = Math.min(s.roofY() - 2, s.floorY() + 3);
            for (int z = s.minZ() + 2; z <= s.maxZ() - 2; z += 4) {
                result.add(new BlockPos(s.minX() - 1, y, z));
                result.add(new BlockPos(s.maxX() + 1, y, z));
            }
            return result;
        }
        for (int level = 0; level < STACK_HEIGHT; level++) {
            for (TorchCell torch : plan.torches) {
                result.add(new BlockPos(s.minX() + torch.dx, s.floorY() + 1 + level, s.minZ() + torch.dz));
            }
        }
        return result;
    }

    /**
     * Which way the torch at this spot must point. Derived from the wall that
     * actually holds it, never from a default - the fallback layout hangs its
     * torches on the OUTSIDE faces, where the answer is the other way round.
     */
    public static Direction torchFacing(Settlement s, BlockPos pos) {
        Plan plan = planFor(s);
        if (plan == null) return pos.getX() < s.minX() ? Direction.WEST : Direction.EAST;
        Direction facing = torchFacing(pos.getX() - s.minX(), pos.getZ() - s.minZ(), plan.width, plan.depth);
        return facing == null ? Direction.EAST : facing;
    }

    /**
     * Every appliance block in the finished toaster, in the order she installs
     * them: the whole ground course first, then the one above it, then the top.
     * Bottom-up is not merely tidier - a block placed in mid-air has no face to
     * click on, and the one below it is that face.
     */
    public static List<Slot> applianceSlots(Settlement s) {
        Plan plan = planFor(s);
        List<Slot> slots = new ArrayList<>();
        if (plan == null) return slots;
        for (int level = 0; level < STACK_HEIGHT; level++) {
            for (FixtureCell column : plan.columns) {
                slots.add(new Slot(
                    new BlockPos(s.minX() + column.dx, s.floorY() + 1 + level, s.minZ() + column.dz),
                    column.block, level));
            }
        }
        return slots;
    }

    public static List<BlockPos> bedPositions(Settlement s) {
        Plan plan = planFor(s);
        List<BlockPos> beds = new ArrayList<>();
        if (plan == null) return beds;
        for (Cell bed : plan.beds) {
            beds.add(new BlockPos(s.minX() + bed.dx, s.floorY() + 1, s.minZ() + bed.dz));
        }
        return beds;
    }

    /** The footprint each role's map was drawn at: {width, depth}. */
    public static int[] footprint(String role) {
        Plan plan = "outpost".equals(role) ? OUTPOST : HOMESTEAD;
        return new int[] { plan.width, plan.depth };
    }

    /** The map itself, for logs and tests. */
    public static List<String> planRows(String role) {
        return Arrays.asList("outpost".equals(role) ? OUTPOST_PLAN : HOMESTEAD_PLAN);
    }
}
