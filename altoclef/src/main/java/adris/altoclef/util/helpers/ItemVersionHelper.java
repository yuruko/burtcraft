package adris.altoclef.util.helpers;

import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.item.equipment.Equippable;
import net.minecraft.world.level.block.state.BlockState;

import java.util.Locale;

/**
 * minecraft 26.1 deleted the concrete item subclasses altoclef used to reason about
 * gear - SwordItem, ToolItem, MiningToolItem, ArmorItem are all gone, and what used
 * to be `instanceof` + `getMaterial().getLevel()` now lives in data components.
 * <p>
 * this is the ONE place that knows the new shape. everything else keeps asking the
 * same questions it always did ("is this a sword", "which pickaxe is better").
 */
public class ItemVersionHelper {

    // wood and gold both sat at level 0 in the old ToolMaterial ladder, so gold is
    // deliberately NOT ranked above stone here - it never was.
    private static final String[] TIER_PREFIXES = {"wooden", "golden", "stone", "iron", "diamond", "netherite"};
    private static final int[] TIER_LEVELS = {0, 0, 1, 2, 3, 4};

    private static final String[] TOOL_KINDS = {"pickaxe", "axe", "shovel", "hoe", "sword"};

    private ItemVersionHelper() {
    }

    private static String path(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).getPath().toLowerCase(Locale.ROOT);
    }

    /**
     * has a TOOL component - pickaxes, axes, shovels, hoes, shears. (swords carry
     * WEAPON, not TOOL, so this is narrower than the old ToolItem which included them.)
     */
    public static boolean isTool(Item item) {
        return item.components().has(DataComponents.TOOL) || isSword(item);
    }

    public static boolean isTool(ItemStack stack) {
        return isTool(stack.getItem());
    }

    /**
     * a pickaxe/axe/shovel/hoe specifically - the old MiningToolItem.
     */
    public static boolean isMiningTool(Item item) {
        if (!item.components().has(DataComponents.TOOL)) return false;
        String p = path(item);
        return p.endsWith("_pickaxe") || p.endsWith("_axe") || p.endsWith("_shovel") || p.endsWith("_hoe");
    }

    /**
     * the old SwordItem. swords are the WEAPON-component items whose id ends in _sword -
     * axes and maces also carry WEAPON but were never SwordItem.
     */
    public static boolean isSword(Item item) {
        return item.components().has(DataComponents.WEAPON) && path(item).endsWith("_sword");
    }

    /**
     * the old ArmorItem: equippable into a real armor slot (not a saddle or a horse
     * blanket, and not a shield, which is EQUIPPABLE-to-offhand).
     */
    public static boolean isArmor(Item item) {
        EquipmentSlot slot = getArmorSlot(item);
        return slot != null && slot.isArmor();
    }

    /**
     * which slot this item equips into, or null if it isn't equippable at all.
     */
    public static EquipmentSlot getArmorSlot(Item item) {
        Equippable eq = item.components().get(DataComponents.EQUIPPABLE);
        return eq == null ? null : eq.slot();
    }

    /**
     * replacement for {@code getMaterial().getLevel()} - the material ladder read off
     * the item id, which is where the material actually lives in vanilla now.
     * returns -1 for anything that isn't a tiered tool.
     */
    public static int getMaterialLevel(Item item) {
        String p = path(item);
        for (int i = 0; i < TIER_PREFIXES.length; i++) {
            if (p.startsWith(TIER_PREFIXES[i] + "_")) return TIER_LEVELS[i];
        }
        return -1;
    }

    /**
     * replacement for grouping tools by {@code tool.getClass()} - every tool is a plain
     * Item now, so group by kind instead ("pickaxe", "sword", ...). null if not a tool.
     */
    public static String getToolKind(Item item) {
        String p = path(item);
        for (String kind : TOOL_KINDS) {
            if (p.endsWith("_" + kind)) return kind;
        }
        return null;
    }

    /**
     * replacement for {@code getMaterial().getAttackDamage()}: the item's own attack
     * damage contribution, summed off its default attribute modifiers.
     */
    public static float getAttackDamage(Item item) {
        ItemStack stack = new ItemStack(item);
        final float[] total = {0f};
        stack.forEachModifier(EquipmentSlot.MAINHAND, (attribute, modifier) -> {
            if (attribute.equals(Attributes.ATTACK_DAMAGE)) total[0] += (float) modifier.amount();
        });
        return total[0];
    }

    /**
     * armor points this piece grants, for ranking one chestplate against another.
     */
    public static double getArmorProtection(Item item) {
        EquipmentSlot slot = getArmorSlot(item);
        if (slot == null) return 0;
        ItemStack stack = new ItemStack(item);
        final double[] total = {0};
        stack.forEachModifier(slot, (attribute, modifier) -> {
            if (attribute.equals(Attributes.ARMOR)) total[0] += modifier.amount();
        });
        return total[0];
    }

    /**
     * mining speed against a block, straight off the TOOL component.
     */
    public static float getMiningSpeed(Item item, BlockState state) {
        Tool tool = item.components().get(DataComponents.TOOL);
        return tool == null ? 1f : tool.getMiningSpeed(state);
    }

    /**
     * the old {@code Item#isCorrectToolForDrops(BlockState)}, which now needs a stack.
     */
    public static boolean isCorrectToolForDrops(Item item, BlockState state) {
        Tool tool = item.components().get(DataComponents.TOOL);
        return tool != null && tool.isCorrectForDrops(state);
    }
}
