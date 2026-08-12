package adris.altoclef.tasks.construction.blueprint;

import adris.altoclef.tasks.construction.settlement.Settlement;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import java.util.ArrayList;
import java.util.List;

/**
 * WHAT A HOUSE IS MADE OF.
 *
 * three families, and they are not symmetrical:
 *
 *   STONE - anything she can already dig out of the ground, in the order she
 *   should spend it. this is {@link Settlement#shellStoneByPreference()} and
 *   nothing else: one list, one truth. a second copy here would be a shell built
 *   half in cobble and half in andesite the first time the two drifted.
 *
 *   WOOD - a family, and UNIFORM WOOD IS A HARD REQUIREMENT. a wall that is
 *   three quarters spruce and one quarter jungle does not read as a renovation,
 *   it reads as a bug, and on stream it reads as a bug she built on purpose. so
 *   the wood palette resolves to exactly ONE plank type - whichever she has most
 *   of - and every accessory (door, stairs, slab, fence) comes from that same
 *   family or the whole thing was pointless.
 *
 *   IRON - one block, and an aspiration. it sits here so a spec can name it;
 *   {@link adris.altoclef.tasks.construction.settlement.ToasterTier} is where
 *   the "can she actually afford it" judgement lives.
 */
public final class Palette {
    private Palette() { }

    /** which family a spec wants its shell built from. */
    public enum Kind {
        STONE,
        WOOD,
        IRON,
        /** either, whichever she can lay hands on. night-one shelters. */
        STONE_OR_WOOD
    }

    /**
     * ONE WOOD FAMILY, WHOLE.
     *
     * the accessories are carried together because the point of the family is
     * that they match. a caller that reaches for {@code stairs} without going
     * through a Wood has already lost the guarantee.
     */
    public static final class Wood {
        /** registry-style name, e.g. {@code "spruce"}. */
        public final String id;
        public final Block planks;
        public final Block door;
        public final Block stairs;
        public final Block slab;
        public final Block fence;

        private Wood(String id, Block planks, Block door, Block stairs, Block slab, Block fence) {
            this.id = id;
            this.planks = planks;
            this.door = door;
            this.stairs = stairs;
            this.slab = slab;
            this.fence = fence;
        }

        @Override
        public String toString() { return id; }
    }

    /**
     * EVERY WOOD FAMILY THE VERSION HAS, in a FIXED order.
     *
     * the order is the contract: {@link #resolveWood(int[])} is handed an array
     * indexed the same way, so re-ordering this list silently re-labels every
     * caller's inventory count. append, never insert.
     *
     * verified against net.minecraft.world.level.block.Blocks in the 26.1.2 jar -
     * all twelve families have planks, door, stairs, slab and fence. the two
     * nether families are included because they are real plank families with the
     * full set; nothing forces her to build a house out of them, but if warped
     * planks are genuinely all she has, a warped house beats standing still.
     */
    private static final List<Wood> WOODS = List.of(
        new Wood("oak", Blocks.OAK_PLANKS, Blocks.OAK_DOOR, Blocks.OAK_STAIRS, Blocks.OAK_SLAB, Blocks.OAK_FENCE),
        new Wood("spruce", Blocks.SPRUCE_PLANKS, Blocks.SPRUCE_DOOR, Blocks.SPRUCE_STAIRS, Blocks.SPRUCE_SLAB, Blocks.SPRUCE_FENCE),
        new Wood("birch", Blocks.BIRCH_PLANKS, Blocks.BIRCH_DOOR, Blocks.BIRCH_STAIRS, Blocks.BIRCH_SLAB, Blocks.BIRCH_FENCE),
        new Wood("jungle", Blocks.JUNGLE_PLANKS, Blocks.JUNGLE_DOOR, Blocks.JUNGLE_STAIRS, Blocks.JUNGLE_SLAB, Blocks.JUNGLE_FENCE),
        new Wood("acacia", Blocks.ACACIA_PLANKS, Blocks.ACACIA_DOOR, Blocks.ACACIA_STAIRS, Blocks.ACACIA_SLAB, Blocks.ACACIA_FENCE),
        new Wood("dark_oak", Blocks.DARK_OAK_PLANKS, Blocks.DARK_OAK_DOOR, Blocks.DARK_OAK_STAIRS, Blocks.DARK_OAK_SLAB, Blocks.DARK_OAK_FENCE),
        new Wood("mangrove", Blocks.MANGROVE_PLANKS, Blocks.MANGROVE_DOOR, Blocks.MANGROVE_STAIRS, Blocks.MANGROVE_SLAB, Blocks.MANGROVE_FENCE),
        new Wood("cherry", Blocks.CHERRY_PLANKS, Blocks.CHERRY_DOOR, Blocks.CHERRY_STAIRS, Blocks.CHERRY_SLAB, Blocks.CHERRY_FENCE),
        new Wood("bamboo", Blocks.BAMBOO_PLANKS, Blocks.BAMBOO_DOOR, Blocks.BAMBOO_STAIRS, Blocks.BAMBOO_SLAB, Blocks.BAMBOO_FENCE),
        new Wood("pale_oak", Blocks.PALE_OAK_PLANKS, Blocks.PALE_OAK_DOOR, Blocks.PALE_OAK_STAIRS, Blocks.PALE_OAK_SLAB, Blocks.PALE_OAK_FENCE),
        new Wood("crimson", Blocks.CRIMSON_PLANKS, Blocks.CRIMSON_DOOR, Blocks.CRIMSON_STAIRS, Blocks.CRIMSON_SLAB, Blocks.CRIMSON_FENCE),
        new Wood("warped", Blocks.WARPED_PLANKS, Blocks.WARPED_DOOR, Blocks.WARPED_STAIRS, Blocks.WARPED_SLAB, Blocks.WARPED_FENCE));

    /** every wood family, in the order {@link #resolveWood(int[])} expects its counts. */
    public static List<Wood> woods() { return WOODS; }

    /** how long a {@code plankCountsByType} array has to be to describe everything. */
    public static int woodFamilyCount() { return WOODS.size(); }

    /** the family she falls back to when the question cannot be answered. */
    public static Wood defaultWood() { return WOODS.get(0); }

    /**
     * THE ONE WOOD THIS HOUSE IS BUILT FROM.
     *
     * @param plankCountsByType how many planks of each family she can lay hands
     *                          on, indexed by {@link #woods()} order. a short,
     *                          null or all-zero array is legal and answers oak -
     *                          she has to build out of SOMETHING, and a plan
     *                          that refuses to name a material is a plan she
     *                          stands next to.
     *
     * ties break to the lowest index, never to a coin: the same inventory must
     * always resolve the same family, or a restock mid-build swaps the wood
     * halfway up the wall.
     */
    public static Wood resolveWood(int[] plankCountsByType) {
        if (plankCountsByType == null) return defaultWood();
        int bestIndex = -1;
        int bestCount = 0;
        int limit = Math.min(plankCountsByType.length, WOODS.size());
        for (int i = 0; i < limit; i++) {
            if (plankCountsByType[i] > bestCount) {
                bestCount = plankCountsByType[i];
                bestIndex = i;
            }
        }
        return bestIndex < 0 ? defaultWood() : WOODS.get(bestIndex);
    }

    /** which family a plank block belongs to, or null when it is not a plank. */
    public static Wood woodOfPlanks(Block planks) {
        for (Wood wood : WOODS) {
            if (wood.planks == planks) return wood;
        }
        return null;
    }

    /** shell stone in spend-first order. one list, one truth - Settlement owns it. */
    public static List<Block> stoneByPreference() { return Settlement.shellStoneByPreference(); }

    /** the top of the ladder, and not seriously expected. */
    public static Block iron() { return Blocks.IRON_BLOCK; }

    /**
     * WHAT TO BUILD THIS SHELL OUT OF, best first.
     *
     * every entry is a fallback for the one before it, so a caller walks the list
     * until it finds something she is actually holding. iron falls back to stone
     * rather than to nothing for the same reason the toaster's shell accepts any
     * stone at all: a material she cannot afford is a house she never starts.
     *
     * {@link Kind#STONE_OR_WOOD} puts wood first on purpose. that palette is for
     * night-one shelters, and on night one she is already carrying the logs she
     * chopped for her first pickaxe.
     */
    public static List<Block> shellPreference(Kind kind, int[] plankCountsByType) {
        List<Block> out = new ArrayList<>();
        switch (kind) {
            case STONE:
                out.addAll(stoneByPreference());
                break;
            case WOOD:
                out.add(resolveWood(plankCountsByType).planks);
                break;
            case IRON:
                out.add(iron());
                out.addAll(stoneByPreference());
                break;
            case STONE_OR_WOOD:
            default:
                out.add(resolveWood(plankCountsByType).planks);
                out.addAll(stoneByPreference());
                break;
        }
        return out;
    }

    /**
     * the single block a plan should be surveyed against right now.
     *
     * never null - {@link #shellPreference} always has at least one entry.
     */
    public static Block shellMaterial(Kind kind, int[] plankCountsByType) {
        return shellPreference(kind, plankCountsByType).get(0);
    }
}
