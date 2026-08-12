package adris.altoclef.tasks.construction.settlement;

import adris.altoclef.tasks.construction.blueprint.BuildingPlan;
import adris.altoclef.tasks.construction.blueprint.Glyphs;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * ANY PROCEDURAL BLUEPRINT, BUILT BY THE TASK THAT ALREADY BUILDS THE TOASTER.
 *
 * ToasterBuildTask reads nothing toaster-specific: it hands Baritone a schematic
 * that calls {@link Settlement#desiredState}, and it surveys with the settlement's
 * own classifiers. So the whole of simple_shelter, wood_house, fancy_wood_house
 * and both outposts needs exactly one thing - a Settlement whose answers come
 * from a {@link BuildingPlan} instead of from a rectangular prism.
 *
 * this is the generic twin of what {@link ToasterHomestead} does for the
 * hand-drawn layered toaster. the toaster keeps its own class because its plan
 * is drawn rather than generated, and because a v1 save still has to reach the
 * old extruded geometry.
 */
public final class BlueprintSettlement extends Settlement {

    private final BuildingPlan plan;
    private final String role;

    /** fixture lists are walked by the survey every second; generating them is not free. */
    private final Map<ToasterTier.Stage, List<ToasterGeometry.Slot>> applianceCache =
        new EnumMap<>(ToasterTier.Stage.class);
    private final Map<ToasterTier.Stage, List<BlockPos>> torchCache =
        new EnumMap<>(ToasterTier.Stage.class);
    private final Map<ToasterTier.Stage, List<BlockPos>> bedCache =
        new EnumMap<>(ToasterTier.Stage.class);

    public BlueprintSettlement(String name, BlockPos anchor, BuildingPlan plan, String role, Block material) {
        super(name, anchor, plan.width(), plan.depth(), plan.height(), material);
        this.plan = plan;
        this.role = role == null || role.isBlank() ? "settlement" : role;
    }

    public BuildingPlan plan() { return plan; }

    @Override
    public String kind() { return plan.id(); }

    @Override
    public String role() { return role; }

    private char glyph(BlockPos pos) { return plan.glyphAt(this, pos); }

    // ---- classifiers, all glyph-driven -------------------------------------
    //
    // every fixture glyph (F C K B T t) deliberately falls through ALL of these.
    // that is what makes desiredState leave them alone and the survey count them
    // in nothing - they are driven entirely by applianceSlots/torchPositions/
    // bedPositions, exactly as the toaster's are.

    @Override
    public boolean isFloor(BlockPos pos) {
        char g = glyph(pos);
        // a porch deck is floor: same material, same course, and the corner posts
        // stand on it - see the build order in Glyphs.
        return (g == Glyphs.SHELL || g == Glyphs.PORCH) && pos.getY() == floorY();
    }

    @Override
    public boolean isRoof(BlockPos pos) {
        return glyph(pos) == Glyphs.SHELL && pos.getY() == roofY();
    }

    @Override
    public boolean isWall(BlockPos pos) {
        char g = glyph(pos);
        return (g == Glyphs.SHELL || g == Glyphs.PORCH)
            && pos.getY() > floorY() && pos.getY() < roofY();
    }

    @Override
    public boolean isInterior(BlockPos pos) {
        // the plan's own air, and only where the building actually encloses it.
        // the geometric guard matters for the same reason it does on the toaster:
        // a plan's apron rows carry '.' outside the walls, and clearing those
        // would have her excavate the ground beside her own front step.
        return glyph(pos) == Glyphs.AIR
            && pos.getY() > floorY()
            && pos.getX() > minX() && pos.getX() < maxX()
            && pos.getZ() > minZ() && pos.getZ() < maxZ();
    }

    @Override
    public boolean isEntrance(BlockPos pos) { return glyph(pos) == Glyphs.DOOR; }

    @Override
    public boolean isToastSlot(BlockPos pos) { return glyph(pos) == Glyphs.OPENING; }

    // ---- what the schematic wants ------------------------------------------

    /**
     * GLASS IS THE ONE THING THE CLASSIFIERS CANNOT CARRY.
     *
     * a window is not shell - isShellMaterial(glass pane) is false, so counting a
     * G cell as wall would leave it reading as wrong forever and the shell could
     * never complete. it is also not interior air. so it is answered here, where
     * the position is still in hand.
     *
     * consequence, stated plainly: Baritone places the panes because they are in
     * the schematic, but the survey does not tally them, so `complete()` can be
     * true with a window missing. that is a deliberate trade - the alternative is
     * a shell that can never finish - and it is why windows are a FULL-stage
     * cosmetic rather than part of the silhouette.
     */
    @Override
    public BlockState desiredState(BlockPos worldPos, BlockState current, List<BlockState> available) {
        if (inYard(worldPos)) {
            return isYardObstruction(current) ? Blocks.AIR.defaultBlockState() : current;
        }
        char g = glyph(worldPos);
        if (g == Glyphs.GLASS) {
            return current.getBlock() == Blocks.GLASS_PANE
                ? current
                : Blocks.GLASS_PANE.defaultBlockState();
        }
        return super.desiredState(worldPos, current, available);
    }

    // ---- fixtures ----------------------------------------------------------

    @Override
    public List<ToasterGeometry.Slot> applianceSlots() {
        return applianceCache.computeIfAbsent(stage(), st -> {
            List<ToasterGeometry.Slot> out = new ArrayList<>();
            for (Glyphs.Cell c : plan.cellsFor(this, st)) {
                Block b = switch (c.glyph) {
                    case Glyphs.FURNACE -> Blocks.FURNACE;
                    case Glyphs.CHEST -> Blocks.CHEST;
                    case Glyphs.BENCH -> Blocks.CRAFTING_TABLE;
                    default -> null;
                };
                if (b != null) out.add(new ToasterGeometry.Slot(c.pos, b, c.layer));
            }
            return List.copyOf(out);
        });
    }

    @Override
    public List<BlockPos> torchPositions() {
        return torchCache.computeIfAbsent(stage(), st -> {
            List<BlockPos> out = new ArrayList<>();
            for (Glyphs.Cell c : plan.cellsFor(this, st)) {
                if (c.glyph == Glyphs.TORCH || c.glyph == Glyphs.WALL_TORCH) out.add(c.pos);
            }
            return List.copyOf(out);
        });
    }

    /**
     * UP means "stand it on the block below"; anything else is a wall face.
     *
     * ToasterBuildTask's lighting step branches on exactly this, so a floor torch
     * answered with a wall facing is a cell that can never be satisfied and the
     * step rotates on it forever.
     */
    @Override
    public Direction torchFacing(BlockPos pos) {
        return glyph(pos) == Glyphs.TORCH ? Direction.UP : plan.wallTorchFacing(this, pos);
    }

    @Override
    public List<BlockPos> bedPositions() {
        return bedCache.computeIfAbsent(stage(), st -> {
            List<BlockPos> out = new ArrayList<>();
            for (Glyphs.Cell c : plan.cellsFor(this, st)) {
                if (c.glyph == Glyphs.BED) out.add(c.pos);
            }
            return List.copyOf(out);
        });
    }
}
