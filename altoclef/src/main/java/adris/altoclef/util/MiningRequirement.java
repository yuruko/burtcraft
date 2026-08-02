package adris.altoclef.util;

import adris.altoclef.Debug;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import adris.altoclef.util.helpers.ItemVersionHelper;

public enum MiningRequirement implements Comparable<MiningRequirement> {
    HAND(Items.AIR), WOOD(Items.WOODEN_PICKAXE), STONE(Items.STONE_PICKAXE), IRON(Items.IRON_PICKAXE), DIAMOND(Items.DIAMOND_PICKAXE);

    private final Item _minPickaxe;

    MiningRequirement(Item minPickaxe) {
        _minPickaxe = minPickaxe;
    }

    public static MiningRequirement getMinimumRequirementForBlock(Block block) {
        if (block.defaultBlockState().requiresCorrectToolForDrops()) {
            for (MiningRequirement req : MiningRequirement.values()) {
                if (req == MiningRequirement.HAND) continue;
                Item pick = req.getMinimumPickaxe();
                if (ItemVersionHelper.isCorrectToolForDrops(pick, block.defaultBlockState())) {
                    return req;
                }
            }
            Debug.logWarning("Failed to find ANY effective tool against: " + block + ". I assume netherite is not required anywhere, so something else probably went wrong.");
            return MiningRequirement.DIAMOND;
        }
        return MiningRequirement.HAND;
    }

    public Item getMinimumPickaxe() {
        return _minPickaxe;
    }

}
