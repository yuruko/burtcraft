package adris.altoclef.tasks.construction.blueprint;

import adris.altoclef.tasks.construction.blueprint.Glyphs.Cell;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterTier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A SPEC, EXPANDED INTO LAYERED GLYPH ROWS.
 *
 * same answers as {@link
 * adris.altoclef.tasks.construction.settlement.ToasterLayout}, off a description
 * instead of a hand-drawn map. layer 0 is the FLOOR COURSE ({@code floorY()}),
 * the map grows +z from {@code minZ()}, and the entrance wall is the {@code dz=0}
 * face because {@link Settlement#entranceFacing()} is NORTH.
 *
 * DETERMINISM IS THE WHOLE CONTRACT. a survey compares the world against this
 * plan and then hands her the difference; a plan that answered differently on
 * the second call would report the house it just finished as half-demolished,
 * and she would spend the night re-laying a wall that was already there. so:
 * every position is a pure function of the spec, the maps are generated exactly
 * once and cached, ties break to the lowest index, and nothing anywhere consults
 * a clock, an inventory or a random.
 *
 * WHAT REACHES PAST THE PRISM, and nothing else does:
 *
 *   the PORCH deck and its two corner posts, which is the point of a porch, and
 *   the two EXTERIOR WALL TORCHES, which hang on the outside face of the
 *   entrance wall directly beside the door. both live in the plan's own APRON -
 *   the strip of grid in front of the entrance the plan owns - and
 *   {@link Blueprints#selfCheck()} refuses any plan that puts anything else out
 *   there. the toaster's own map does the same thing: its doorstep juts two rows
 *   past the back of the plan on purpose.
 */
public final class ProceduralPlan implements BuildingPlan {

    /** eye level. windows and wall torches both live here. */
    private static final int TORCH_LAYER = 2;
    private static final int WINDOW_LAYER = 2;

    /**
     * one window every third wall block, offset so a run of wall reads as wall
     * with windows in it rather than as a colonnade.
     */
    private static final int WINDOW_SPACING = 3;

    /**
     * how many courses a gable roof steps in over.
     *
     * two. each course insets one block on the X axis, so the ridge runs along Z
     * and the silhouette breaks - which is the entire difference between a house
     * and a crate. more than two eats the head room of anything short enough to
     * build in a night, and the cap is re-derived per spec anyway
     * ({@link #roofLayers}) so a low or narrow building degrades to flat rather
     * than to a roof with no walls under it.
     */
    private static final int GABLE_LAYERS = 2;

    private final BlueprintSpec spec;

    /**
     * generated once, on first use. volatile rather than synchronized: the
     * generation is deterministic and side-effect free, so the worst a race can
     * do is compute the identical grid twice and keep one of them.
     */
    private volatile Grid cached;

    public ProceduralPlan(BlueprintSpec spec) {
        if (spec == null) throw new IllegalArgumentException("procedural plan needs a spec");
        this.spec = spec;
    }

    public BlueprintSpec spec() { return spec; }

    @Override public String id() { return spec.id(); }
    public String role() { return spec.role(); }
    @Override public int width() { return spec.width(); }
    @Override public int depth() { return spec.depth(); }
    @Override public int height() { return spec.height(); }

    /** how far in front of the entrance wall the plan's own map reaches. */
    public int apronDepth() { return grid().apron; }

    @Override
    public boolean applies(Settlement s) {
        return s.width() == width() && s.depth() == depth() && s.height() == height();
    }

    /** the world position of a plan cell. {@code dz} may be negative - that is the apron. */
    public BlockPos posOf(Settlement s, int layer, int dx, int dz) {
        return new BlockPos(s.minX() + dx, s.floorY() + layer, s.minZ() + dz);
    }

    @Override
    public char glyphAt(Settlement s, BlockPos pos) {
        Grid g = grid();
        int layer = pos.getY() - s.floorY();
        int dx = pos.getX() - s.minX();
        int dz = pos.getZ() - s.minZ();
        if (layer < 0 || layer >= height()) return Glyphs.OUTSIDE;
        if (dx < 0 || dx >= width()) return Glyphs.OUTSIDE;
        int gz = dz + g.apron;
        if (gz < 0 || gz >= g.map[layer].length) return Glyphs.OUTSIDE;
        return g.map[layer][gz][dx];
    }

    /**
     * the same answer in PLAN space, with no settlement in the world yet.
     *
     * {@code dz} may be negative - that is the apron in front of the entrance.
     * anything off the map is {@link Glyphs#OUTSIDE}, exactly as the world-space
     * form answers.
     */
    public char glyphAt(int layer, int dx, int dz) {
        Grid g = grid();
        if (layer < 0 || layer >= height()) return Glyphs.OUTSIDE;
        if (dx < 0 || dx >= width()) return Glyphs.OUTSIDE;
        int gz = dz + g.apron;
        if (gz < 0 || gz >= g.map[layer].length) return Glyphs.OUTSIDE;
        return g.map[layer][gz][dx];
    }

    @Override
    public Block wantedBlock(char glyph, Block shellMaterial) {
        switch (glyph) {
            // the porch deck is the shell material laid flat outside the door -
            // a house with a plank porch bolted onto a stone wall is two houses.
            case Glyphs.SHELL:
            case Glyphs.PORCH:
                return shellMaterial != null ? shellMaterial : Palette.shellMaterial(spec.palette(), null);
            case Glyphs.FURNACE: return Blocks.FURNACE;
            case Glyphs.CHEST: return Blocks.CHEST;
            case Glyphs.BENCH: return Blocks.CRAFTING_TABLE;
            case Glyphs.BED: return Blocks.RED_BED;
            case Glyphs.TORCH: return Blocks.TORCH;
            case Glyphs.WALL_TORCH: return Blocks.WALL_TORCH;
            case Glyphs.GLASS: return Blocks.GLASS_PANE;
            default: return null;                       // air, doorway, opening, outside
        }
    }

    @Override
    public boolean isOpening(char glyph) { return Glyphs.isOpening(glyph); }

    @Override
    public List<Cell> cellsFor(Settlement s, ToasterTier.Stage stage) {
        Grid g = grid();
        List<Cell> out = new ArrayList<>();
        for (char rank : Glyphs.BUILD_ORDER) {
            for (Slot slot : g.slots) {
                if (slot.glyph != rank) continue;
                if (!spec.inStage(slot.feature, stage)) continue;
                out.add(new Cell(posOf(s, slot.layer, slot.dx, slot.dz), slot.glyph, slot.layer));
            }
        }
        return out;
    }

    @Override
    public Map<Character, Integer> tally() {
        return new LinkedHashMap<>(grid().tally);
    }

    @Override
    public Direction wallTorchFacing(Settlement s, BlockPos pos) {
        for (Direction dir : Direction.Plane.HORIZONTAL) {
            if (glyphAt(s, pos.relative(dir.getOpposite())) == Glyphs.SHELL) return dir;
        }
        // unreachable for a registered plan - selfCheck() refuses any plan that
        // hangs a torch on something that is not shell. kept because
        // ToasterLayout has the same fallback and the two must read alike.
        return Direction.NORTH;
    }

    /** every placed cell in plan space, with the feature that asked for it. */
    public List<Slot> slots() { return Collections.unmodifiableList(grid().slots); }

    /**
     * the maps as printable rows, one array per layer, apron rows first.
     * {@link Glyphs#OUTSIDE} renders as a space. for logs and probes only.
     */
    public String[][] renderLayers() {
        Grid g = grid();
        String[][] out = new String[height()][];
        for (int layer = 0; layer < height(); layer++) {
            out[layer] = new String[g.map[layer].length];
            for (int gz = 0; gz < g.map[layer].length; gz++) {
                StringBuilder row = new StringBuilder(width());
                for (int dx = 0; dx < width(); dx++) {
                    char glyph = g.map[layer][gz][dx];
                    row.append(glyph == Glyphs.OUTSIDE ? ' ' : glyph);
                }
                out[layer][gz] = row.toString();
            }
        }
        return out;
    }

    /** one placed cell in PLAN space. {@code dz < 0} means the apron. */
    public static final class Slot {
        public final int layer;
        public final int dx;
        public final int dz;
        public final char glyph;
        public final BlueprintSpec.Feature feature;

        Slot(int layer, int dx, int dz, char glyph, BlueprintSpec.Feature feature) {
            this.layer = layer;
            this.dx = dx;
            this.dz = dz;
            this.glyph = glyph;
            this.feature = feature;
        }

        @Override
        public String toString() { return glyph + "@" + dx + "," + layer + "," + dz + " (" + feature + ")"; }
    }

    // ---------------------------------------------------------------- generation

    private Grid grid() {
        Grid g = cached;
        if (g == null) {
            g = generate(spec);
            cached = g;
        }
        return g;
    }

    /** the generated maps plus everything derived from them. immutable once built. */
    private static final class Grid {
        final char[][][] map;                       // [layer][gz][dx], gz = dz + apron
        final int apron;
        final List<Slot> slots;
        final Map<Character, Integer> tally;

        Grid(char[][][] map, int apron, List<Slot> slots, Map<Character, Integer> tally) {
            this.map = map;
            this.apron = apron;
            this.slots = slots;
            this.tally = tally;
        }
    }

    /** writing surface for the generator. everything starts off the map. */
    private static final class Canvas {
        final int w;
        final int d;
        final int h;
        final int apron;
        final char[][][] map;
        final BlueprintSpec.Feature[][][] owner;

        Canvas(int w, int d, int h, int apron) {
            this.w = w;
            this.d = d;
            this.h = h;
            this.apron = apron;
            this.map = new char[h][d + apron][w];
            this.owner = new BlueprintSpec.Feature[h][d + apron][w];
            for (char[][] layer : map) {
                for (char[] row : layer) Arrays.fill(row, Glyphs.OUTSIDE);
            }
        }

        boolean on(int layer, int dx, int dz) {
            int gz = dz + apron;
            return layer >= 0 && layer < h && dx >= 0 && dx < w && gz >= 0 && gz < d + apron;
        }

        char get(int layer, int dx, int dz) {
            return on(layer, dx, dz) ? map[layer][dz + apron][dx] : Glyphs.OUTSIDE;
        }

        void set(int layer, int dx, int dz, char glyph, BlueprintSpec.Feature feature) {
            if (!on(layer, dx, dz)) {
                throw new IllegalStateException("plan wrote '" + glyph + "' off its own map at " + dx + "," + layer + "," + dz);
            }
            map[layer][dz + apron][dx] = glyph;
            owner[layer][dz + apron][dx] = feature;
        }
    }

    /**
     * how deep the plan's own strip in front of the entrance is.
     *
     * the porch needs all of it; a lone pair of exterior torches needs exactly
     * one row. nothing else is allowed out there at all.
     */
    private static int apronOf(BlueprintSpec spec) {
        int fromPorch = spec.porchDepth();
        int fromTorches = spec.count(BlueprintSpec.Feature.TORCHES_OUTSIDE) > 0 ? 1 : 0;
        return Math.max(fromPorch, fromTorches);
    }

    /**
     * how many courses the roof occupies.
     *
     * capped by BOTH the height left over above the walls and the width there is
     * to inset into, so a short or narrow spec that asked for a gable quietly
     * gets a flat roof instead of a roof that starts below its own eaves.
     */
    private static int roofLayers(BlueprintSpec spec) {
        if (!spec.gableRoof()) return 1;
        int byHeight = spec.height() - 3;                  // floor + at least one wall course + the roof
        int byWidth = (spec.width() - 1) / 2;
        return Math.max(1, Math.min(GABLE_LAYERS, Math.min(byHeight, byWidth)));
    }

    private static Grid generate(BlueprintSpec spec) {
        final int w = spec.width();
        final int d = spec.depth();
        final int h = spec.height();
        final int apron = apronOf(spec);
        final int roofLayers = roofLayers(spec);
        final int wallTop = h - 1 - roofLayers;            // last course that is still wall
        final int doorX = w / 2;

        if (wallTop < 1) {
            throw new IllegalStateException(spec.id() + ": no room for a wall between the floor and the roof");
        }

        Canvas c = new Canvas(w, d, h, apron);

        // the prism is air until something is painted into it. the apron stays
        // off the map except where the porch and the exterior torches claim it.
        for (int layer = 0; layer < h; layer++) {
            for (int dz = 0; dz < d; dz++) {
                for (int dx = 0; dx < w; dx++) c.set(layer, dx, dz, Glyphs.AIR, null);
            }
        }

        // 1. THE FLOOR. she stands on it to build everything above it.
        if (spec.enabled(BlueprintSpec.Feature.FLOOR)) {
            for (int dz = 0; dz < d; dz++) {
                for (int dx = 0; dx < w; dx++) c.set(0, dx, dz, Glyphs.SHELL, BlueprintSpec.Feature.FLOOR);
            }
        }

        // 2. THE WALLS - the perimeter of every course between floor and roof.
        if (spec.enabled(BlueprintSpec.Feature.WALLS)) {
            for (int layer = 1; layer <= wallTop; layer++) {
                for (int dz = 0; dz < d; dz++) {
                    for (int dx = 0; dx < w; dx++) {
                        boolean perimeter = dx == 0 || dx == w - 1 || dz == 0 || dz == d - 1;
                        if (perimeter) c.set(layer, dx, dz, Glyphs.SHELL, BlueprintSpec.Feature.WALLS);
                    }
                }
            }
        }

        // 3. THE ROOF. flat is one solid course. a gable steps in one block per
        //    course on the X axis, so the ridge runs along Z. each course is
        //    SOLID across its own inset rectangle - a skin with a hollow under it
        //    is a roof with a hole in it, which is a spawn platform with a view.
        if (spec.enabled(BlueprintSpec.Feature.ROOF)) {
            for (int r = 0; r < roofLayers; r++) {
                int layer = h - roofLayers + r;
                int inset = r;
                if (w - 2 * inset < 1) break;
                for (int dz = 0; dz < d; dz++) {
                    for (int dx = inset; dx <= w - 1 - inset; dx++) {
                        c.set(layer, dx, dz, Glyphs.SHELL, BlueprintSpec.Feature.ROOF);
                    }
                }
            }
        }

        // 4. THE DOOR - two courses cut out of the entrance wall, centred.
        //    CUT, NEVER PLACED: a stage that owed it would have her filling in
        //    her own doorway.
        if (spec.enabled(BlueprintSpec.Feature.DOOR)) {
            for (int layer = 1; layer <= Math.min(2, wallTop); layer++) {
                c.set(layer, doorX, 0, Glyphs.DOOR, BlueprintSpec.Feature.DOOR);
            }
        }

        // 5. WINDOWS at eye level. the two columns either side of the door are
        //    skipped on the entrance wall - that is where the outside torches
        //    hang, and a torch needs shell behind it or it can never be placed.
        if (spec.enabled(BlueprintSpec.Feature.WINDOWS) && wallTop >= WINDOW_LAYER) {
            for (int dx = 1; dx <= w - 2; dx++) {
                if ((dx - 1) % WINDOW_SPACING != WINDOW_SPACING / 2) continue;
                if (Math.abs(dx - doorX) > 1) c.set(WINDOW_LAYER, dx, 0, Glyphs.GLASS, BlueprintSpec.Feature.WINDOWS);
                c.set(WINDOW_LAYER, dx, d - 1, Glyphs.GLASS, BlueprintSpec.Feature.WINDOWS);
            }
            for (int dz = 1; dz <= d - 2; dz++) {
                if ((dz - 1) % WINDOW_SPACING != WINDOW_SPACING / 2) continue;
                c.set(WINDOW_LAYER, 0, dz, Glyphs.GLASS, BlueprintSpec.Feature.WINDOWS);
                c.set(WINDOW_LAYER, w - 1, dz, Glyphs.GLASS, BlueprintSpec.Feature.WINDOWS);
            }
        }

        // 6. THE PORCH - a deck out from the entrance wall with a post at each
        //    outer corner.
        //
        //    the posts are shell material rather than fence because a fence's
        //    blockstate is decided by its NEIGHBOURS, and PlaceBlockTask compares
        //    the whole blockstate: a post asked for with the wrong connections is
        //    a cell that can never be satisfied.
        //
        //    they carry the 'P' glyph, not 'W', even though they are the same
        //    block. 'W' would sort them into the SHELL rank, which is laid before
        //    the PORCH rank - so a post on layer 1 would be placed before the
        //    deck square underneath it, which is the exact mid-air placement the
        //    build order exists to prevent. same letter as the deck, same rank,
        //    bottom course first.
        int porchDepth = spec.porchDepth();
        if (porchDepth > 0) {
            for (int back = 1; back <= porchDepth; back++) {
                for (int dx = 0; dx < w; dx++) c.set(0, dx, -back, Glyphs.PORCH, BlueprintSpec.Feature.PORCH);
            }
            for (int layer = 1; layer <= wallTop; layer++) {
                c.set(layer, 0, -porchDepth, Glyphs.PORCH, BlueprintSpec.Feature.PORCH);
                c.set(layer, w - 1, -porchDepth, Glyphs.PORCH, BlueprintSpec.Feature.PORCH);
            }
        }

        // 7. THE BED, head against the back wall, on the centre line. two cells,
        //    because one bed is two blocks.
        if (spec.enabled(BlueprintSpec.Feature.BED)) {
            c.set(1, doorX, d - 2, Glyphs.BED, BlueprintSpec.Feature.BED);
            c.set(1, doorX, d - 3, Glyphs.BED, BlueprintSpec.Feature.BED);
        }

        // 8-10. THE FURNITURE, handed out from a fixed ring of interior cells
        //       that hug a wall. back wall first, then the sides, then the front:
        //       the useful stuff ends up facing the door and the walk in from the
        //       doorway stays clear.
        List<int[]> ring = interiorRing(w, d);
        ring.removeIf(cell -> c.get(1, cell[0], cell[1]) != Glyphs.AIR);       // the bed already took its two
        ring.removeIf(cell -> cell[0] == doorX && cell[1] == 1);               // never block the threshold

        int cursor = 0;
        if (spec.enabled(BlueprintSpec.Feature.CRAFTING_TABLE)) {
            cursor = place(spec, c, ring, cursor, 1, Glyphs.BENCH, BlueprintSpec.Feature.CRAFTING_TABLE);
        }
        for (int i = 0; i < spec.count(BlueprintSpec.Feature.CHESTS); i++) {
            cursor = place(spec, c, ring, cursor, 1, Glyphs.CHEST, BlueprintSpec.Feature.CHESTS);
        }
        for (int i = 0; i < spec.count(BlueprintSpec.Feature.FURNACES); i++) {
            cursor = place(spec, c, ring, cursor, 1, Glyphs.FURNACE, BlueprintSpec.Feature.FURNACES);
        }

        // 11. WALL TORCHES INSIDE, at eye level on the same ring. two passes so a
        //     bare stretch of wall is lit before a torch gets hung over her own
        //     workbench, and every candidate is checked for SHELL behind it -
        //     a torch on glass or on a doorway can never be placed and the
        //     lighting step would rotate on it forever.
        placeTorches(spec, c, ring, spec.count(BlueprintSpec.Feature.TORCHES_INSIDE),
            BlueprintSpec.Feature.TORCHES_INSIDE);

        // 12. WALL TORCHES OUTSIDE, flanking the door and working outward. same
        //     shell check, on the far side of the same wall.
        int needOutside = spec.count(BlueprintSpec.Feature.TORCHES_OUTSIDE);
        if (needOutside > 0) {
            int placed = 0;
            for (int step = 1; step <= w && placed < needOutside; step++) {
                for (int side = -1; side <= 1 && placed < needOutside; side += 2) {
                    int dx = doorX + side * step;
                    if (dx < 0 || dx >= w) continue;
                    char here = c.get(TORCH_LAYER, dx, -1);
                    if (here != Glyphs.OUTSIDE && here != Glyphs.AIR) continue;
                    if (c.get(TORCH_LAYER, dx, 0) != Glyphs.SHELL) continue;
                    c.set(TORCH_LAYER, dx, -1, Glyphs.WALL_TORCH, BlueprintSpec.Feature.TORCHES_OUTSIDE);
                    placed++;
                }
            }
            if (placed < needOutside) {
                throw new IllegalStateException(spec.id() + ": only " + placed + " of " + needOutside
                    + " outside torches have shell behind them");
            }
        }

        return harvest(spec, c);
    }

    /** take the next free ring cell for a fixture, or say loudly that the house is full. */
    private static int place(BlueprintSpec spec, Canvas c, List<int[]> ring, int cursor,
                             int layer, char glyph, BlueprintSpec.Feature feature) {
        if (cursor >= ring.size()) {
            throw new IllegalStateException(spec.id() + ": ran out of wall to stand a " + Glyphs.kindOf(glyph)
                + " against - " + ring.size() + " interior wall cells for the furniture it asked for");
        }
        int[] cell = ring.get(cursor);
        c.set(layer, cell[0], cell[1], glyph, feature);
        return cursor + 1;
    }

    private static void placeTorches(BlueprintSpec spec, Canvas c, List<int[]> ring, int need,
                                     BlueprintSpec.Feature feature) {
        if (need <= 0) return;
        int placed = 0;
        for (int pass = 0; pass < 2 && placed < need; pass++) {
            for (int[] cell : ring) {
                if (placed >= need) break;
                int dx = cell[0];
                int dz = cell[1];
                if (c.get(TORCH_LAYER, dx, dz) != Glyphs.AIR) continue;             // already lit
                if (pass == 0 && c.get(1, dx, dz) != Glyphs.AIR) continue;          // something stands here
                if (!hasShellNeighbour(c, TORCH_LAYER, dx, dz)) continue;
                c.set(TORCH_LAYER, dx, dz, Glyphs.WALL_TORCH, feature);
                placed++;
            }
        }
        if (placed < need) {
            throw new IllegalStateException(spec.id() + ": only " + placed + " of " + need
                + " inside torches have shell behind them");
        }
    }

    private static boolean hasShellNeighbour(Canvas c, int layer, int dx, int dz) {
        return c.get(layer, dx, dz - 1) == Glyphs.SHELL
            || c.get(layer, dx, dz + 1) == Glyphs.SHELL
            || c.get(layer, dx - 1, dz) == Glyphs.SHELL
            || c.get(layer, dx + 1, dz) == Glyphs.SHELL;
    }

    /**
     * the interior cells that hug a wall, in the order fixtures are handed out.
     *
     * back row left to right, then both side columns back to front, then the
     * front row between them. no cell appears twice - the side columns start one
     * row in front of the back row and the front row stops one short of each
     * column.
     */
    private static List<int[]> interiorRing(int w, int d) {
        List<int[]> ring = new ArrayList<>();
        for (int dx = 1; dx <= w - 2; dx++) ring.add(new int[] { dx, d - 2 });
        for (int dz = d - 3; dz >= 1; dz--) ring.add(new int[] { 1, dz });
        for (int dz = d - 3; dz >= 1; dz--) ring.add(new int[] { w - 2, dz });
        for (int dx = 2; dx <= w - 3; dx++) ring.add(new int[] { dx, 1 });
        return ring;
    }

    /**
     * read the finished canvas back out as slots and a tally, and CHECK IT.
     *
     * the scan order is layer, then row, then column, which is what makes
     * {@link #cellsFor} come out bottom course first within every rank - a block
     * placed in mid-air has no face to click on, and the block below it is that
     * face.
     *
     * the counts at the bottom are NOT DECORATION. every fixture here was painted
     * onto a shared canvas and a later feature can overwrite an earlier one; a
     * silently-eaten bed is a house that surveys as finished and has nowhere to
     * sleep.
     */
    private static Grid harvest(BlueprintSpec spec, Canvas c) {
        List<Slot> slots = new ArrayList<>();
        Map<Character, Integer> tally = new LinkedHashMap<>();
        for (int layer = 0; layer < c.h; layer++) {
            for (int gz = 0; gz < c.map[layer].length; gz++) {
                for (int dx = 0; dx < c.w; dx++) {
                    char glyph = c.map[layer][gz][dx];
                    if (glyph == Glyphs.OUTSIDE) continue;
                    if (!Glyphs.known(glyph)) {
                        throw new IllegalStateException(spec.id() + ": unknown glyph '" + glyph + "' in the generated map");
                    }
                    tally.merge(glyph, 1, Integer::sum);
                    if (!Glyphs.places(glyph)) continue;
                    BlueprintSpec.Feature feature = c.owner[layer][gz][dx];
                    if (feature == null) {
                        throw new IllegalStateException(spec.id() + ": placed '" + glyph + "' with no feature behind it");
                    }
                    slots.add(new Slot(layer, dx, gz - c.apron, glyph, feature));
                }
            }
        }

        expect(spec, tally, Glyphs.DOOR, spec.enabled(BlueprintSpec.Feature.DOOR) ? 2 : 0, "door courses");
        expect(spec, tally, Glyphs.BED, spec.enabled(BlueprintSpec.Feature.BED) ? 2 : 0, "bed halves");
        expect(spec, tally, Glyphs.BENCH, spec.enabled(BlueprintSpec.Feature.CRAFTING_TABLE) ? 1 : 0, "crafting tables");
        expect(spec, tally, Glyphs.CHEST, spec.count(BlueprintSpec.Feature.CHESTS), "chests");
        expect(spec, tally, Glyphs.FURNACE, spec.count(BlueprintSpec.Feature.FURNACES), "furnaces");
        expect(spec, tally, Glyphs.WALL_TORCH,
            spec.count(BlueprintSpec.Feature.TORCHES_INSIDE) + spec.count(BlueprintSpec.Feature.TORCHES_OUTSIDE),
            "wall torches");

        return new Grid(c.map, c.apron, slots, tally);
    }

    private static void expect(BlueprintSpec spec, Map<Character, Integer> tally, char glyph, int wanted, String english) {
        int got = tally.getOrDefault(glyph, 0);
        if (got != wanted) {
            throw new IllegalStateException(spec.id() + ": asked for " + wanted + " " + english + ", generated " + got);
        }
    }
}
