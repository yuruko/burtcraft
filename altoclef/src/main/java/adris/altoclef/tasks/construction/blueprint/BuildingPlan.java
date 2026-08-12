package adris.altoclef.tasks.construction.blueprint;

import adris.altoclef.tasks.construction.blueprint.Glyphs.Cell;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterTier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;

/**
 * WHAT A BUILDABLE PLAN HAS TO ANSWER.
 *
 * two kinds of plan implement this and they must be interchangeable: the
 * hand-drawn toaster (see {@link
 * adris.altoclef.tasks.construction.settlement.ToasterLayout}, whose static
 * methods are this interface's shape already) and {@link ProceduralPlan}, which
 * expands a {@link BlueprintSpec} into the same layered glyph rows at runtime.
 *
 * the contract is deliberately the toaster's, method for method, because the
 * survey/build loop that consumes it is written against the toaster and must not
 * learn a second dialect. anything a procedural plan does differently - a porch
 * that reaches past the walls, a roof that steps in - has to come out of these
 * same nine answers.
 *
 * EVERY ANSWER IS A PURE FUNCTION OF THE SPEC AND THE SETTLEMENT. nothing is
 * remembered between calls, because a re-survey compares the world against the
 * plan and a plan that answered differently the second time would report the
 * house half-demolished.
 */
public interface BuildingPlan {

    /** stable registry id, e.g. {@code "wood_house"}. */
    String id();

    /** outer prism of the BUILDING. a porch reaches past this; nothing else does. */
    int width();
    int depth();
    int height();

    /** true when this settlement is exactly the size the plan was drawn at. */
    boolean applies(Settlement s);

    /** what the plan wants at this world position, or {@link Glyphs#OUTSIDE}. */
    char glyphAt(Settlement s, BlockPos pos);

    /**
     * what block the plan wants standing here, or null when the answer is air.
     *
     * the shell's material is a parameter because it climbs with her means - see
     * {@link ToasterTier#materialLadder}. everything else is what it is.
     */
    Block wantedBlock(char glyph, Block shellMaterial);

    /** is this cell meant to be open air she must never fill in? */
    boolean isOpening(char glyph);

    /** every block the stage owes, in the order she should lay it. */
    java.util.List<Cell> cellsFor(Settlement s, ToasterTier.Stage stage);

    /** everything the plan wants, ignoring stages - for manifests and probes. */
    java.util.Map<Character, Integer> tally();

    /**
     * which way the wall torch at this spot points.
     *
     * the torch hangs off a wall and points AWAY from it, so the answer is
     * whichever neighbouring cell is shell. getting this wrong is not cosmetic:
     * PlaceBlockTask compares the whole blockstate, so a torch asked for with the
     * wrong facing can never be satisfied and the lighting step rotates on it
     * forever.
     */
    Direction wallTorchFacing(Settlement s, BlockPos pos);
}
