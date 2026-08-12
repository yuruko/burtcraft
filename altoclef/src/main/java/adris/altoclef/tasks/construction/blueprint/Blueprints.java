package adris.altoclef.tasks.construction.blueprint;

import adris.altoclef.tasks.construction.blueprint.BlueprintSpec.Feature;
import adris.altoclef.tasks.construction.blueprint.Glyphs.Cell;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterGeometry;
import adris.altoclef.tasks.construction.settlement.ToasterTier;
import adris.altoclef.tasks.construction.settlement.ToasterTier.Stage;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * EVERY BUILDING SHE KNOWS HOW TO PUT UP.
 *
 * five entries, all of them procedural, all of them interchangeable with the
 * hand-drawn toaster through {@link BuildingPlan}. the registry is the only
 * place a plan is named, so "build me a wood house" resolves here and nowhere
 * else.
 *
 * {@link #selfCheck()} is the loud validation, modelled on
 * {@link ToasterGeometry}'s {@code parse()}: a malformed entry throws, with the
 * id and the reason in the message, rather than becoming a house she stands next
 * to at 3am. everything a plan is REQUIRED to have - a floor, a bed, a crafting
 * table, a reachable door - is asserted there against the generated maps, not
 * against the spec that asked for them.
 */
public final class Blueprints {
    private Blueprints() { }

    /** how far the fancy house's porch reaches out. "expand porch" raises this. */
    public static final int FANCY_PORCH_DEPTH = 3;

    private static final Map<String, ProceduralPlan> REGISTRY = buildRegistry();

    private static Map<String, ProceduralPlan> buildRegistry() {
        Map<String, ProceduralPlan> out = new LinkedHashMap<>();

        // NIGHT ONE. five by five, three courses of wall, a roof. whatever she is
        // carrying builds it - the logs she chopped for her first pickaxe or the
        // stone she dug getting to them - because a shelter she cannot afford is
        // a night spent in a hole.
        register(out, BlueprintSpec.of("simple_shelter", "shelter", 5, 5, 5, Palette.Kind.STONE_OR_WOOD)
            .shell(Stage.SHELL)
            .craftingTable(Stage.LIVED_IN)
            .bed(Stage.LIVED_IN)
            .torchesInside(1, Stage.FULL)
            .torchesOutside(1, Stage.FULL)
            .furnaces(1, Stage.FULL)
            .build());

        // SOMEWHERE TO LIVE. light and a bed arrive with the furniture rather
        // than at the end, because the stage that has her sleeping indoors is
        // the stage that has to be safe to sleep in.
        register(out, BlueprintSpec.of("wood_house", "homestead", 9, 7, 5, Palette.Kind.WOOD)
            .shell(Stage.SHELL)
            .craftingTable(Stage.LIVED_IN)
            .bed(Stage.LIVED_IN)
            .torchesInside(2, Stage.LIVED_IN)
            .torchesOutside(1, Stage.LIVED_IN)
            .furnaces(1, Stage.KITCHEN)
            .windows(Stage.FULL)
            .chests(2, Stage.FULL)
            .build());

        // THE SAME HOUSE, ARRIVED AT. every feature wood_house has, at the same
        // stages, plus the two that are purely somebody living well: a roof with
        // a break in its silhouette, and a porch.
        register(out, BlueprintSpec.of("fancy_wood_house", "homestead", 13, 9, 6, Palette.Kind.WOOD)
            .shell(Stage.SHELL)
            .gableRoof()
            .craftingTable(Stage.LIVED_IN)
            .bed(Stage.LIVED_IN)
            .torchesInside(4, Stage.LIVED_IN)
            .torchesOutside(2, Stage.LIVED_IN)
            .furnaces(2, Stage.KITCHEN)
            .windows(Stage.FULL)
            .chests(3, Stage.FULL)
            .porch(FANCY_PORCH_DEPTH, Stage.FULL)
            .build());

        // OUTPOSTS. a bed and a bench first because the point of an outpost is
        // that she does not have to walk home; the furnace and the chest are
        // what make it worth stopping at twice.
        register(out, outpost("stone_outpost", Palette.Kind.STONE));
        register(out, outpost("wood_outpost", Palette.Kind.WOOD));

        return Collections.unmodifiableMap(out);
    }

    /** same shape, same stages, different material. */
    private static BlueprintSpec outpost(String id, Palette.Kind palette) {
        return BlueprintSpec.of(id, "outpost", 7, 6, 5, palette)
            .shell(Stage.SHELL)
            .bed(Stage.LIVED_IN)
            .craftingTable(Stage.LIVED_IN)
            .furnaces(1, Stage.KITCHEN)
            .chests(1, Stage.KITCHEN)
            .torchesInside(1, Stage.FULL)
            .torchesOutside(1, Stage.FULL)
            .build();
    }

    private static void register(Map<String, ProceduralPlan> out, BlueprintSpec spec) {
        if (out.containsKey(spec.id())) {
            throw new IllegalStateException("two blueprints registered as '" + spec.id() + "'");
        }
        out.put(spec.id(), new ProceduralPlan(spec));
    }

    /** the plan with this id, or null. */
    public static BuildingPlan byId(String id) {
        return id == null ? null : REGISTRY.get(id);
    }

    /** every plan, registration order. */
    public static List<BuildingPlan> all() {
        return new ArrayList<>(REGISTRY.values());
    }

    /** every plan built for this role ("shelter", "homestead", "outpost"). */
    public static List<BuildingPlan> forRole(String role) {
        List<BuildingPlan> out = new ArrayList<>();
        if (role == null) return out;
        for (ProceduralPlan plan : REGISTRY.values()) {
            if (role.equals(plan.role())) out.add(plan);
        }
        return out;
    }

    /** every registered id, registration order. */
    public static List<String> ids() {
        return new ArrayList<>(REGISTRY.keySet());
    }

    // ------------------------------------------------------------- self check

    /**
     * FORCE EVERY PLAN AND PROVE IT IS BUILDABLE.
     *
     * plans generate lazily, so a spec that cannot be laid out is otherwise a
     * throw at whatever call site happens to touch it first - which on this side
     * of the codebase means she walks to a site with a stack of planks and then
     * stands there. this drags every failure forward to one call.
     *
     * throws {@link IllegalStateException} on anything malformed, and returns a
     * one-line report per plan. EVERY PLAN GETS EVERY CHECK - there is no
     * degraded path that quietly verifies half of one, because a plan reported
     * as checked when it was not is worse than no check at all.
     */
    public static String selfCheck() {
        if (REGISTRY.isEmpty()) throw new IllegalStateException("blueprint registry is empty");
        List<String> report = new ArrayList<>();
        for (ProceduralPlan plan : REGISTRY.values()) {
            report.add(checkPlan(plan));
        }
        return String.join("\n", report);
    }

    private static String checkPlan(ProceduralPlan plan) {
        BlueprintSpec spec = plan.spec();
        String id = spec.id();
        int w = plan.width();
        int d = plan.depth();
        int h = plan.height();

        // forces generation. everything downstream reads the GENERATED maps, not
        // the spec - a spec that asked for a bed proves nothing about a map that
        // dropped it.
        List<ProceduralPlan.Slot> slots = plan.slots();
        Map<Character, Integer> tally = plan.tally();

        // THE FOUR THINGS THAT MAKE IT A HOUSE, re-asserted against the map.
        require(id, tally.getOrDefault(Glyphs.SHELL, 0) > 0, "no shell blocks at all");
        require(id, floorIsSolid(plan), "the floor course has a hole in it");
        require(id, tally.getOrDefault(Glyphs.BED, 0) == 2, "a bed is two blocks and this plan has "
            + tally.getOrDefault(Glyphs.BED, 0));
        require(id, tally.getOrDefault(Glyphs.BENCH, 0) == 1, "exactly one crafting table, found "
            + tally.getOrDefault(Glyphs.BENCH, 0));

        // A REACHABLE DOOR: two courses cut out of the entrance wall, air on the
        // inside of it, and nothing placed on the step outside. a doorway with a
        // chest in front of it surveys as finished and cannot be walked through.
        int doorX = w / 2;
        require(id, plan.glyphAt(1, doorX, 0) == Glyphs.DOOR && plan.glyphAt(2, doorX, 0) == Glyphs.DOOR,
            "the door is not two courses of 'D' on the entrance wall at dx=" + doorX);
        require(id, tally.getOrDefault(Glyphs.DOOR, 0) == 2, "more than one doorway was cut");
        require(id, plan.glyphAt(1, doorX, 1) == Glyphs.AIR && plan.glyphAt(2, doorX, 1) == Glyphs.AIR,
            "something stands in the doorway on the inside");
        require(id, !Glyphs.places(plan.glyphAt(1, doorX, -1)) && !Glyphs.places(plan.glyphAt(2, doorX, -1)),
            "something stands in the doorway on the outside");

        // EVERY GLYPH IS ONE THE ALPHABET KNOWS, and every placeable one names a
        // block. a glyph nothing can be placed for is a cell she circles forever.
        for (Map.Entry<Character, Integer> entry : tally.entrySet()) {
            char glyph = entry.getKey();
            require(id, Glyphs.known(glyph), "unknown glyph '" + glyph + "' in the map");
            if (Glyphs.places(glyph)) {
                require(id, plan.wantedBlock(glyph, Blocks.COBBLESTONE) != null,
                    "glyph '" + glyph + "' places nothing");
                Glyphs.kindOf(glyph);                       // throws if a kind was forgotten
            } else {
                require(id, plan.wantedBlock(glyph, Blocks.COBBLESTONE) == null,
                    "glyph '" + glyph + "' is not placed but names a block");
            }
        }
        require(id, plan.isOpening(Glyphs.DOOR) && !plan.isOpening(Glyphs.GLASS),
            "openings and glass are not being told apart");

        // NOTHING LEAVES THE PRISM except the porch and the two torches beside
        // the door, and those only into the apron the plan declared.
        int apron = plan.apronDepth();
        int escaped = 0;
        for (ProceduralPlan.Slot slot : slots) {
            boolean inside = slot.dz >= 0 && slot.dz < d;
            if (inside) continue;
            escaped++;
            require(id, slot.feature == Feature.PORCH || slot.feature == Feature.TORCHES_OUTSIDE,
                slot.feature + " put a '" + slot.glyph + "' outside the prism at dz=" + slot.dz);
            require(id, slot.dz >= -apron, "a cell at dz=" + slot.dz + " is outside the plan's own apron");
            if (slot.feature == Feature.TORCHES_OUTSIDE) {
                require(id, slot.dz == -1, "an outside torch at dz=" + slot.dz + " is not against the wall");
            }
        }
        require(id, apron > 0 || escaped == 0, "cells outside the prism with no apron declared");

        // NOTHING STRUCTURAL IS LAID BEFORE THE BLOCK IT STANDS ON. a block
        // placed in mid-air has no face to click on and the block below it is
        // that face, which is the whole reason the build order exists - but rank
        // order alone does not enforce it ACROSS ranks. the porch's corner posts
        // were 'W' once, which sorted them into the SHELL rank, ahead of the
        // deck squares underneath them in the PORCH rank: correct-looking order,
        // two blocks placed over nothing. wall torches are deliberately exempt -
        // they hang off the wall BESIDE them and never need a floor.
        List<ProceduralPlan.Slot> order = planOrder(plan);
        Map<String, Integer> laidAt = new LinkedHashMap<>();
        for (int i = 0; i < order.size(); i++) {
            ProceduralPlan.Slot slot = order.get(i);
            laidAt.put(slot.layer + "," + slot.dx + "," + slot.dz, i);
        }
        for (int i = 0; i < order.size(); i++) {
            ProceduralPlan.Slot slot = order.get(i);
            if (!isStructural(slot.glyph) || slot.layer == 0) continue;
            // only a structural block below is a FACE. anything else - the world's
            // own ground, a doorway, or a wall torch under the roof course - is
            // not something this cell is standing on, and demanding an order
            // between them fails the roof over every lit wall.
            if (!isStructural(plan.glyphAt(slot.layer - 1, slot.dx, slot.dz))) continue;
            Integer below = laidAt.get((slot.layer - 1) + "," + slot.dx + "," + slot.dz);
            require(id, below != null && below < i, "'" + slot.glyph + "' at "
                + slot.dx + "," + slot.layer + "," + slot.dz + " is laid before the block underneath it");
        }

        // EVERY WALL TORCH HAS SHELL BEHIND IT. getting this wrong is not
        // cosmetic: PlaceBlockTask compares the whole blockstate, so a torch
        // asked for with the wrong facing can never be satisfied and the
        // lighting step rotates on it forever.
        int torches = 0;
        for (ProceduralPlan.Slot slot : slots) {
            if (slot.glyph != Glyphs.WALL_TORCH) continue;
            torches++;
            Direction facing = planTorchFacing(plan, slot);
            require(id, facing != null,
                "a wall torch at " + slot.dx + "," + slot.layer + "," + slot.dz + " has no shell to hang on");
        }
        require(id, torches == spec.count(Feature.TORCHES_INSIDE) + spec.count(Feature.TORCHES_OUTSIDE),
            "wall torch count drifted from the spec");

        // and the world-space half, on a real Settlement, for EVERY plan.
        checkAgainstSettlement(plan, probeFor(plan));

        return id + ": " + w + "x" + d + "x" + h + " " + spec.palette()
            + " role=" + spec.role()
            + " cells=" + slots.size()
            + " tally=" + renderTally(tally)
            + (apron > 0 ? " apron=" + apron : "");
    }

    /**
     * the world-space contract: cells land where the plan says, the stages nest,
     * and the build order is the one that survives contact with a bot.
     */
    private static void checkAgainstSettlement(ProceduralPlan plan, Settlement probe) {
        String id = plan.id();

        require(id, probe.entranceFacing() == Direction.NORTH,
            "Settlement.entranceFacing() is " + probe.entranceFacing()
                + " but every procedural plan puts its door on the dz=0 face");
        require(id, plan.applies(probe), "applies() says no to a settlement of its own size");

        List<Cell> full = plan.cellsFor(probe, Stage.FULL);
        require(id, full.size() == plan.slots().size(), "cellsFor(FULL) dropped cells the map holds");

        // the plan-space order the support check reasoned about has to be the
        // order she is actually handed, or that check was about nothing.
        List<ProceduralPlan.Slot> order = planOrder(plan);
        require(id, order.size() == full.size(), "planOrder and cellsFor disagree about how many cells there are");
        for (int i = 0; i < full.size(); i++) {
            ProceduralPlan.Slot slot = order.get(i);
            Cell cell = full.get(i);
            require(id, cell.glyph == slot.glyph
                    && cell.pos.equals(plan.posOf(probe, slot.layer, slot.dx, slot.dz)),
                "planOrder and cellsFor disagree at index " + i);
        }

        // every cell agrees with glyphAt, and its kind resolves.
        for (Cell cell : full) {
            require(id, plan.glyphAt(probe, cell.pos) == cell.glyph,
                "a cell disagrees with glyphAt at " + cell.pos);
            cell.kind();
            require(id, plan.wantedBlock(cell.glyph, Blocks.COBBLESTONE) != null,
                "a cell was emitted for a glyph that places nothing");
            if (cell.glyph == Glyphs.WALL_TORCH) {
                Direction facing = plan.wallTorchFacing(probe, cell.pos);
                require(id, plan.glyphAt(probe, cell.pos.relative(facing.getOpposite())) == Glyphs.SHELL,
                    "wallTorchFacing points away from something that is not shell at " + cell.pos);
            }
        }

        // BUILD ORDER: ranks in Glyphs.BUILD_ORDER order, and bottom course first
        // within a rank - a block placed in mid-air has no face to click on.
        int lastRank = -1;
        int lastLayer = -1;
        for (Cell cell : full) {
            int rank = rankOf(cell.glyph);
            require(id, rank >= 0, "glyph '" + cell.glyph + "' is not in Glyphs.BUILD_ORDER");
            require(id, rank >= lastRank, "build order went backwards at " + cell.pos);
            if (rank != lastRank) {
                lastRank = rank;
                lastLayer = -1;
            }
            require(id, cell.layer >= lastLayer, "a rank was not laid bottom course first at " + cell.pos);
            lastLayer = cell.layer;
        }

        // STAGES NEST. growing must never move or remove something already
        // placed, so every stage has to be a superset of the one before it.
        List<Cell> previous = null;
        for (Stage stage : Stage.values()) {
            List<Cell> cells = plan.cellsFor(probe, stage);
            if (previous != null) {
                require(id, cells.size() >= previous.size(), "stage " + stage + " owes fewer cells than the one before it");
                for (Cell earlier : previous) {
                    require(id, contains(cells, earlier), "stage " + stage + " dropped a cell from an earlier stage");
                }
            }
            previous = cells;
        }
        require(id, previous != null && previous.size() == full.size(), "FULL is not the whole plan");

        // DETERMINISM. same question twice, same answer - a re-survey compares the
        // world against this and a plan that wandered would report the house it
        // just finished as half-demolished.
        List<Cell> again = plan.cellsFor(probe, Stage.FULL);
        require(id, again.size() == full.size(), "cellsFor is not deterministic");
        for (int i = 0; i < again.size(); i++) {
            require(id, again.get(i).glyph == full.get(i).glyph && again.get(i).pos.equals(full.get(i).pos),
                "cellsFor is not deterministic at index " + i);
        }
    }

    private static boolean contains(List<Cell> cells, Cell wanted) {
        for (Cell cell : cells) {
            if (cell.glyph == wanted.glyph && cell.pos.equals(wanted.pos)) return true;
        }
        return false;
    }

    /**
     * the plan's cells in emission order, without a settlement in the world.
     *
     * same two loops {@link BuildingPlan#cellsFor} runs, minus the stage filter -
     * and {@link #checkAgainstSettlement} asserts the two agree, so this cannot
     * quietly become a second opinion about build order.
     */
    private static List<ProceduralPlan.Slot> planOrder(ProceduralPlan plan) {
        List<ProceduralPlan.Slot> out = new ArrayList<>();
        for (char rank : Glyphs.BUILD_ORDER) {
            for (ProceduralPlan.Slot slot : plan.slots()) {
                if (slot.glyph == rank) out.add(slot);
            }
        }
        return out;
    }

    /** blocks that stand on the one below them. a wall torch hangs off the side and does not. */
    private static boolean isStructural(char glyph) {
        return glyph == Glyphs.SHELL || glyph == Glyphs.PORCH;
    }

    private static int rankOf(char glyph) {
        for (int i = 0; i < Glyphs.BUILD_ORDER.length; i++) {
            if (Glyphs.BUILD_ORDER[i] == glyph) return i;
        }
        return -1;
    }

    /** plan-space twin of {@link BuildingPlan#wallTorchFacing}, or null when nothing holds it. */
    private static Direction planTorchFacing(ProceduralPlan plan, ProceduralPlan.Slot slot) {
        for (Direction dir : Direction.Plane.HORIZONTAL) {
            Direction back = dir.getOpposite();
            char behind = plan.glyphAt(slot.layer, slot.dx + back.getStepX(), slot.dz + back.getStepZ());
            if (behind == Glyphs.SHELL) return dir;
        }
        return null;
    }

    private static boolean floorIsSolid(ProceduralPlan plan) {
        for (int dz = 0; dz < plan.depth(); dz++) {
            for (int dx = 0; dx < plan.width(); dx++) {
                if (plan.glyphAt(0, dx, dz) != Glyphs.SHELL) return false;
            }
        }
        return true;
    }

    private static String renderTally(Map<Character, Integer> tally) {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<Character, Integer> entry : tally.entrySet()) {
            if (out.length() > 0) out.append(' ');
            out.append(entry.getKey()).append(':').append(entry.getValue());
        }
        return out.toString();
    }

    private static void require(String id, boolean ok, String complaint) {
        if (!ok) throw new IllegalStateException("blueprint '" + id + "': " + complaint);
    }

    /**
     * a settlement of exactly this plan's size, to check the world-space half on.
     *
     * THROWS RATHER THAN SKIPPING. this used to hand back null for a plan
     * Settlement would not accept, and checkPlan degraded to a warning - which
     * meant three of five entries were reported as checked while only their
     * grid-space half had been. Settlement's five-block floor is not negotiable
     * downstream, so a plan under it is a plan that can never be built, and
     * {@link BlueprintSpec.Builder} already refuses one. reaching here means the
     * two guards have drifted apart, which is worth stopping for.
     */
    private static Settlement probeFor(ProceduralPlan plan) {
        if (plan.width() < 5 || plan.depth() < 5 || plan.height() < 5) {
            throw new IllegalStateException("blueprint '" + plan.id() + "': "
                + plan.width() + "x" + plan.depth() + "x" + plan.height()
                + " is smaller than Settlement will carry (5 in every dimension), so it can never be built");
        }
        return new ProbeSettlement(plan, new BlockPos(0, 65, 0));
    }

    /**
     * a settlement that exists only to be measured.
     *
     * every abstract answer is empty on purpose: the plan under test is the
     * thing being asked, and a probe that had opinions about torches or
     * appliances would be testing itself.
     */
    private static final class ProbeSettlement extends Settlement {
        private final String role;

        ProbeSettlement(ProceduralPlan plan, BlockPos anchor) {
            super("probe:" + plan.id(), anchor, plan.width(), plan.depth(), plan.height(), Blocks.COBBLESTONE);
            this.role = plan.role();
        }

        @Override public String kind() { return "probe"; }
        @Override public String role() { return role; }
        @Override public boolean isEntrance(BlockPos pos) { return false; }
        @Override public boolean isToastSlot(BlockPos pos) { return false; }
        @Override public List<BlockPos> torchPositions() { return List.of(); }
        @Override public Direction torchFacing(BlockPos pos) { return Direction.NORTH; }
        @Override public List<ToasterGeometry.Slot> applianceSlots() { return List.of(); }
        @Override public List<BlockPos> bedPositions() { return List.of(); }
    }

    /**
     * the material a plan should be surveyed against right now.
     *
     * here rather than on the plan because it is the one answer that is NOT a
     * pure function of the spec - it depends on what she is carrying - and
     * keeping it off {@link BuildingPlan} is what keeps the plan deterministic.
     *
     * @param plankCountsByType indexed by {@link Palette#woods()}; null is legal
     */
    public static Block shellMaterialFor(BuildingPlan plan, int[] plankCountsByType) {
        if (!(plan instanceof ProceduralPlan)) return ToasterTier.materialLadder().get(0);
        return Palette.shellMaterial(((ProceduralPlan) plan).spec().palette(), plankCountsByType);
    }
}
