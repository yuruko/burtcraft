package adris.altoclef.tasks.construction.settlement;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.List;

/**
 * Burnt's primary toaster.
 *
 * THE PLAN IS LAYERED NOW. Every classifier below is answered by the glyph
 * {@link ToasterPlan} holds at that position - a solid base, two slots cut clean
 * through the roof, furnace banks lining them as the elements, and the lever
 * slot up the front face. A single 2D map extruded upward can describe a shed
 * and cannot describe any of that.
 *
 * A house that is NOT the size the layered plan was drawn at falls through to
 * {@link ToasterGeometry}, unchanged. That is not a courtesy, it is the
 * migration: an already-standing 14x9x8 homestead keeps the geometry it was
 * built with, so nothing she already lives in is re-classified, re-laid or
 * demolished underneath her.
 *
 * FIXTURE GLYPHS FALL THROUGH EVERY CLASSIFIER ON PURPOSE (F C K B T t). Being
 * neither shell nor interior nor opening, they reach the trailing
 * {@code return current} in {@link Settlement#desiredState} and are left alone,
 * {@code Survey.scan} counts them in nothing, and they are driven entirely by
 * {@link #applianceSlots()} / {@link #torchPositions()} / {@link #bedPositions()}.
 * {@link Settlement#preserveInterior} already names all of them, so a stray
 * clearing pass cannot take one out either.
 */
public final class ToasterHomestead extends Homestead {
    public ToasterHomestead(String name, BlockPos anchor, int width, int depth, int height) {
        super(name, anchor, width, depth, height, Blocks.SMOOTH_STONE);
    }

    @Override
    public String kind() { return "toaster_homestead"; }

    /** Is this house the one the layered plan was drawn for? */
    private boolean layered() { return ToasterLayout.applies(this); }

    private char glyph(BlockPos pos) { return ToasterLayout.glyphAt(this, pos); }

    /** 0 is the floor course. Out-of-range values can never match a glyph. */
    private int layer(BlockPos pos) { return pos.getY() - floorY(); }

    @Override
    public boolean isFloor(BlockPos pos) {
        if (!layered()) return super.isFloor(pos);
        return glyph(pos) == ToasterLayout.SHELL && layer(pos) == 0;
    }

    @Override
    public boolean isRoof(BlockPos pos) {
        if (!layered()) return super.isRoof(pos);
        return glyph(pos) == ToasterLayout.SHELL && layer(pos) == ToasterLayout.height() - 1;
    }

    @Override
    public boolean isWall(BlockPos pos) {
        if (!layered()) return super.isWall(pos);
        int layer = layer(pos);
        return glyph(pos) == ToasterLayout.SHELL && layer > 0 && layer < ToasterLayout.height() - 1;
    }

    /**
     * Air she is meant to sweep out, as opposed to air that is simply not hers.
     *
     * THE GEOMETRIC GUARD IS LOAD-BEARING, and dropping it would have her dig up
     * her own front garden. The doorstep juts two rows past the back of the map
     * (layer 0's last rows are {@code .....WWW.....}), so the '.' cells beside it
     * are OUTSIDE the building - ground, not floor. Interior is therefore '.'
     * that is also above the floor course and strictly inside all four walls,
     * which is the only reading of the glyph that describes a room.
     */
    @Override
    public boolean isInterior(BlockPos pos) {
        if (!layered()) return super.isInterior(pos);
        return glyph(pos) == ToasterLayout.AIR
            && layer(pos) >= 1
            && pos.getX() > minX() && pos.getX() < maxX()
            && pos.getZ() > minZ() && pos.getZ() < maxZ();
    }

    @Override
    public boolean isEntrance(BlockPos pos) {
        if (!layered()) return ToasterGeometry.isEntrance(this, pos);
        return glyph(pos) == ToasterLayout.DOOR;
    }

    @Override
    public boolean isToastSlot(BlockPos pos) {
        if (!layered()) return ToasterGeometry.isToastSlot(this, pos);
        return glyph(pos) == ToasterLayout.OPENING;
    }

    @Override
    public List<BlockPos> torchPositions() {
        if (!layered()) return ToasterGeometry.torchPositions(this);
        refreshFixtures();
        return torches;
    }

    /**
     * TWO KINDS OF TORCH, AND THEY ARE PLACED DIFFERENTLY.
     *
     * The plan holds 104 FLOOR torches ('T', standing on whatever is beneath
     * them) and 2 WALL torches ('t', the pair either side of the door). A wall
     * torch points AWAY from the block holding it up; a standing torch points
     * UP, and UP is also how the build task knows to click the block BELOW the
     * spot rather than a neighbouring wall.
     *
     * Getting this wrong is not cosmetic: PlaceBlockTask compares the whole
     * blockstate, so a torch asked for with the wrong facing is a cell that can
     * never be satisfied and the lighting step rotates on it forever.
     */
    @Override
    public Direction torchFacing(BlockPos pos) {
        if (!layered()) return ToasterGeometry.torchFacing(this, pos);
        return glyph(pos) == ToasterLayout.WALL_TORCH
            ? ToasterLayout.wallTorchFacing(this, pos)
            : Direction.UP;
    }

    @Override
    public List<ToasterGeometry.Slot> applianceSlots() {
        if (!layered()) return ToasterGeometry.applianceSlots(this);
        refreshFixtures();
        return appliances;
    }

    @Override
    public List<BlockPos> bedPositions() {
        if (!layered()) return ToasterGeometry.bedPositions(this);
        refreshFixtures();
        return beds;
    }

    /** What {@link #refreshFixtures()} last read the plan for; null until it has. */
    private ToasterTier.Stage fixtureStage;
    private List<ToasterGeometry.Slot> appliances = List.of();
    private List<BlockPos> torches = List.of();
    private List<BlockPos> beds = List.of();

    /**
     * Read the three fixture lists off the plan, once per stage.
     *
     * {@link ToasterLayout#cellsFor} walks all eleven layers for each of the
     * seven build ranks and hands back a Cell per placed block - 1589 of them at
     * FULL. The three accessors above are called several times per survey, about
     * once a second, on the client thread, and the answer only ever changes when
     * the stage does. So it is worked out once and kept.
     *
     * THE ORDER IS cellsFor's ORDER, which is the order she should lay things:
     * bench, then bed, then chests, then furnaces - and the two door torches
     * before any of the floor ones. Filtering preserves it; nothing re-sorts.
     */
    private void refreshFixtures() {
        ToasterTier.Stage want = stage();
        if (fixtureStage == want) return;
        List<ToasterGeometry.Slot> nextAppliances = new ArrayList<>();
        List<BlockPos> nextTorches = new ArrayList<>();
        List<BlockPos> nextBeds = new ArrayList<>();
        for (ToasterLayout.Cell cell : ToasterLayout.cellsFor(this, want)) {
            switch (cell.glyph) {
                case ToasterLayout.FURNACE ->
                    nextAppliances.add(new ToasterGeometry.Slot(cell.pos, Blocks.FURNACE, cell.layer));
                case ToasterLayout.CHEST ->
                    nextAppliances.add(new ToasterGeometry.Slot(cell.pos, Blocks.CHEST, cell.layer));
                case ToasterLayout.BENCH ->
                    nextAppliances.add(new ToasterGeometry.Slot(cell.pos, Blocks.CRAFTING_TABLE, cell.layer));
                case ToasterLayout.TORCH, ToasterLayout.WALL_TORCH -> nextTorches.add(cell.pos);
                case ToasterLayout.BED -> nextBeds.add(cell.pos);
                // the shell is BUILT, not installed, and it is the bulk of the
                // list - everything else here is a fixture somebody fits.
                default -> { }
            }
        }
        appliances = List.copyOf(nextAppliances);
        torches = List.copyOf(nextTorches);
        beds = List.copyOf(nextBeds);
        fixtureStage = want;
    }
}
