package adris.altoclef.tasks.construction.settlement;

import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.List;

/**
 * HOW MUCH TOASTER, AND WHAT IT IS MADE OF.
 *
 * The finished blueprint is 1589 placed blocks and its shell alone is 1126 iron
 * blocks - ten thousand ingots. Asked for in one go that is not a house, it is a
 * job she never finishes, and until she finishes it she has nowhere to sleep.
 *
 * So the build grows on TWO INDEPENDENT AXES:
 *
 *   CONTENT ({@link Stage}) - how much of the plan is claimed. Every stage is a
 *   superset of the one before, so growing never moves or removes anything she
 *   already placed. Stage 1 is the whole SILHOUETTE - floor, walls, roof, both
 *   toast slots, the door and its two torches - because a toast girl living in a
 *   box is not the bit. She is living in a toaster from the first night; what
 *   arrives later is the furniture, not the shape.
 *
 *   MATERIAL ({@link #materialLadder}) - what the shell is made of. Cobblestone
 *   the first night, and it climbs only when she can afford it. Iron is the top
 *   of the ladder and is deliberately gated behind actually being rich, because
 *   at ten thousand ingots it is an aspiration, not a plan.
 *
 * Both axes are read off the WORLD and her inventory, never stored - the same
 * rule the rest of this package follows. A remembered tier would be a second
 * copy of state to drift, and it would also mean a house she demolished still
 * counted as finished.
 */
public final class ToasterTier {
    private ToasterTier() { }

    /**
     * How much of the plan is in scope. Ordinal order is build order; each stage
     * includes every glyph of the stages before it.
     */
    public enum Stage {
        /**
         * The toaster itself: floor, walls, roof, both slots, the doorway and the
         * two torches beside it. Nothing inside yet. This is the first night's
         * work and it is already recognisably her house.
         */
        SHELL,
        /** Somewhere to sleep, something to craft on, somewhere to put things, and light. */
        LIVED_IN,
        /** The elements: the furnace banks that line the toast slots, and the rest of the chests. */
        KITCHEN,
        /** Every last glyph on the plan - the upper deck's banks included. */
        FULL;

        public Stage next() {
            return this == FULL ? FULL : values()[ordinal() + 1];
        }
    }

    /**
     * Which glyphs belong to a stage. Openings ('D', 'S') are air on every stage
     * and appear in none of these: they are cut, not placed, and a stage that
     * "contained" them would have her trying to fill in her own toast slots.
     */
    public static boolean inStage(char glyph, Stage stage) {
        switch (glyph) {
            case 'W': return true;                       // the shell is in every stage
            case 't': return true;                       // the two torches by the door go up with it
            case 'B': case 'K': return stage.ordinal() >= Stage.LIVED_IN.ordinal();
            case 'T': return stage.ordinal() >= Stage.LIVED_IN.ordinal();
            case 'C': return stage.ordinal() >= Stage.LIVED_IN.ordinal();
            case 'F': return stage.ordinal() >= Stage.KITCHEN.ordinal();
            default: return false;
        }
    }

    /**
     * How many of a fixture this stage actually wants, in plan order.
     *
     * LIVED_IN is deliberately a HANDFUL, not the full set: one bed, one bench,
     * two chests and enough torches to stop things spawning indoors. The plan
     * holds 32 chests and 106 torches, and hauling all of that before she has a
     * kitchen is the same mistake as demanding the iron up front.
     */
    public static int budgetFor(char glyph, Stage stage) {
        if (stage == Stage.FULL) return Integer.MAX_VALUE;
        switch (glyph) {
            case 'B': return stage.ordinal() >= Stage.LIVED_IN.ordinal() ? 2 : 0;   // one bed is two blocks
            case 'K': return stage.ordinal() >= Stage.LIVED_IN.ordinal() ? 1 : 0;
            case 'C': return stage == Stage.LIVED_IN ? 2 : Integer.MAX_VALUE;
            case 'T': return stage == Stage.LIVED_IN ? 12 : Integer.MAX_VALUE;
            case 'F': return stage.ordinal() >= Stage.KITCHEN.ordinal() ? Integer.MAX_VALUE : 0;
            default: return Integer.MAX_VALUE;
        }
    }

    /**
     * THE MATERIAL LADDER, worst to best.
     *
     * Cobblestone is what she has on night one. Smooth stone costs a furnace and
     * fuel per block. Stone brick costs four smooth. Iron is 9 ingots a block and
     * 1126 blocks of shell, so it sits at the top and is not seriously expected -
     * it is what the house becomes if she ever genuinely arrives.
     */
    public static List<Block> materialLadder() {
        return List.of(Blocks.COBBLESTONE, Blocks.SMOOTH_STONE, Blocks.STONE_BRICKS, Blocks.IRON_BLOCK);
    }

    /** Where a block sits on the ladder; -1 for anything that is not shell material. */
    public static int rungOf(Block block) {
        return materialLadder().indexOf(block);
    }

    /**
     * The best material she should be BUILDING with right now.
     *
     * Deliberately conservative: it only climbs when she is holding a real
     * surplus of the better block, because a shell half in cobble and half in
     * brick looks like a bug rather than a renovation, and because starting a
     * course she cannot finish strands her mid-wall.
     *
     * @param carried how many of each ladder block she can actually lay hands on
     * @param rich    true when she is established enough for the top rung - full
     *                chests and diamond gear, not merely holding some iron
     */
    public static Block buildingMaterial(int[] carried, boolean rich) {
        List<Block> ladder = materialLadder();
        Block best = ladder.get(0);
        for (int rung = 0; rung < ladder.size(); rung++) {
            if (rung == ladder.size() - 1 && !rich) break;      // iron needs more than a stack
            if (carried[rung] >= MATERIAL_SWITCH_STOCK) best = ladder.get(rung);
        }
        return best;
    }

    /**
     * How much of a better block she must be holding before the shell changes to
     * it. One stack: enough that the upgrade visibly progresses rather than
     * flickering between two materials every time a furnace finishes.
     */
    public static final int MATERIAL_SWITCH_STOCK = 64;
}
