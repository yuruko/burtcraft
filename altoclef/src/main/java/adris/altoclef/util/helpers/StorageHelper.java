package adris.altoclef.util.helpers;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.mixins.AbstractFurnaceScreenHandlerAccessor;
import adris.altoclef.tasks.CraftInInventoryTask;
import adris.altoclef.util.CraftingRecipe;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.MiningRequirement;
import adris.altoclef.util.RecipeTarget;
import adris.altoclef.util.slots.CraftingTableSlot;
import adris.altoclef.util.slots.CursorSlot;
import adris.altoclef.util.slots.PlayerSlot;
import adris.altoclef.util.slots.Slot;
import baritone.utils.ToolSet;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.options.OptionsSubScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.*;
import net.minecraft.world.item.*;
import net.minecraft.world.item.context.*;
import net.minecraft.world.level.*;
import net.minecraft.network.chat.*;
import net.minecraft.world.*;
import net.minecraft.world.inventory.*;
import org.apache.commons.lang3.ArrayUtils;

import java.util.*;
import java.util.function.Predicate;
import java.util.stream.Stream;
import net.minecraft.core.component.DataComponents;

/**
 * Helper functions for interpreting containers/slots/windows/inventory
 */
@SuppressWarnings({"ConstantConditions", "rawtypes"})
public class StorageHelper {

    public static List<PlayerSlot> INACCESSIBLE_PLAYER_SLOTS = Stream.concat(Stream.of(PlayerSlot.CRAFT_INPUT_SLOTS), Stream.of(PlayerSlot.ARMOR_SLOTS)).toList();

    // ---- container showcase ---------------------------------------------------
    // she does her container work in a handful of ticks, so on stream the crafting
    // table / furnace / inventory was a single-frame flicker and it read as "she is
    // standing still doing nothing". hold the GUI open for a beat after the work is
    // done so the audience can actually see her using it.
    //
    // bounded and self-clearing on purpose: an open screen blocks movement, so this
    // may only ever DELAY a close, never prevent one. tickScreenShowcase() force-
    // closes on expiry so a task that calls closeScreen() exactly once (onStop) can
    // never strand her staring into a chest.
    private static final long SHOWCASE_MS = showcaseMillis();
    private static Screen showcaseScreen = null;
    private static long showcaseUntil = 0L;

    // DEFAULT OFF. this shipped at 1400ms and froze her for five minutes with a
    // crafting table open (2026-08-01 23:31:53 -> 23:37 shutdown).
    //
    // the hole: closeScreen() ARMS the linger and returns WITHOUT closing, and the
    // only thing that then closes it is tickScreenShowcase(). when a task is
    // INTERRUPTED mid-container (every task died "interrupted by null" at once that
    // night), its onStop calls closeScreen() exactly one final time - arming a linger
    // that nobody will ever call again - and the tick disowns the screen the moment
    // mc.screen stops matching the armed reference. an open screen blocks movement,
    // so she sat there.
    //
    // the tick CANNOT simply close whatever container is open instead: it has no way
    // to tell an orphaned screen from one a task is actively using, and closing a
    // crafting table mid-craft breaks the task. a cosmetic "you can see her working"
    // feature does not get to risk that, so it is opt-in until it can distinguish the
    // two. set BURTCRAFT_CONTAINER_SHOWCASE_MS=1400 to try it again.
    private static long showcaseMillis() {
        try {
            String raw = System.getenv("BURTCRAFT_CONTAINER_SHOWCASE_MS");
            if (raw != null && !raw.isBlank()) return Math.max(0L, Long.parseLong(raw.trim()));
        } catch (Throwable ignored) { }
        return 0L;
    }

    public static void closeScreen() {
        if (Minecraft.getInstance().player == null)
            return;
        Screen screen = Minecraft.getInstance().screen;
        if (
                screen != null &&
                        !(screen instanceof PauseScreen) &&
                        !(screen instanceof OptionsSubScreen) &&
                        !(screen instanceof ChatScreen)) {
            // a container screen is the interesting one to watch - give it its beat
            // before closing. AbstractContainerScreen covers the crafting table,
            // furnace family, chests AND her own inventory.
            if (SHOWCASE_MS > 0 && screen instanceof AbstractContainerScreen) {
                long now = System.currentTimeMillis();
                if (showcaseScreen != screen) {
                    showcaseScreen = screen;
                    showcaseUntil = now + SHOWCASE_MS;
                    return;
                }
                if (now < showcaseUntil) return;
            }
            clearShowcase();
            // Close the screen if we're in-game
            Minecraft.getInstance().player.closeContainer();
        } else {
            clearShowcase();
        }
    }

    // drive the showcase from the client tick as well, so an expired linger always
    // ends even when nothing calls closeScreen() again.
    public static void tickScreenShowcase() {
        if (SHOWCASE_MS <= 0 || showcaseScreen == null) return;
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) { clearShowcase(); return; }
        if (System.currentTimeMillis() < showcaseUntil) return;
        // DEADLINE REACHED. close whatever container is still open, not only the exact
        // instance we armed. the old identity check bailed out via clearShowcase() the
        // moment the reference stopped matching, which is precisely what happens when
        // the owning task is interrupted - and it left the screen open forever with
        // nobody holding the responsibility to shut it. we only ever get here because
        // WE deferred a close that was already asked for, so closing it is honouring
        // that request late, not cancelling somebody else's work.
        clearShowcase();
        if (mc.screen instanceof AbstractContainerScreen) mc.player.closeContainer();
    }

    private static void clearShowcase() {
        showcaseScreen = null;
        showcaseUntil = 0L;
    }

    public static ItemStack getItemStackInSlot(Slot slot) {
        LocalPlayer player = Minecraft.getInstance().player;
        if (player == null)
            return ItemStack.EMPTY;
        // Cursor slot
        if (Slot.isCursor(slot)) {
            return StorageHelper.getItemStackInCursorSlot();
        }
        // Inventory slot when inventory is NOT open
        Inventory inv = player.getInventory();
        if (inv != null) {
            // 26.1: offhand + armor moved off Inventory onto the entity equipment map
            if (slot.equals(PlayerSlot.OFFHAND_SLOT))
                return player.getItemBySlot(EquipmentSlot.OFFHAND);
            if (slot.equals(PlayerSlot.ARMOR_HELMET_SLOT))
                return player.getItemBySlot(EquipmentSlot.HEAD);
            if (slot.equals(PlayerSlot.ARMOR_CHESTPLATE_SLOT))
                return player.getItemBySlot(EquipmentSlot.CHEST);
            if (slot.equals(PlayerSlot.ARMOR_LEGGINGS_SLOT))
                return player.getItemBySlot(EquipmentSlot.LEGS);
            if (slot.equals(PlayerSlot.ARMOR_BOOTS_SLOT))
                return player.getItemBySlot(EquipmentSlot.FEET);
        }
        try {
            // We might have messed up and opened the wrong slot.
            net.minecraft.world.inventory.Slot mcSlot = player.containerMenu.getSlot(slot.getWindowSlot());
            return (mcSlot != null) ? mcSlot.getItem() : ItemStack.EMPTY;
        } catch (Exception e) {
            Debug.logWarning("Screen Slot Error (ignored)");
            e.printStackTrace();
            return ItemStack.EMPTY;
        }
    }

    public static MiningRequirement getCurrentMiningRequirement(AltoClef mod) {
        MiningRequirement[] order = new MiningRequirement[]{
                MiningRequirement.DIAMOND, MiningRequirement.IRON, MiningRequirement.STONE, MiningRequirement.WOOD
        };
        for (MiningRequirement check : order) {
            if (miningRequirementMet(mod, check)) {
                return check;
            }
        }
        return MiningRequirement.HAND;
    }

    private static boolean h(AltoClef mod, boolean inventoryOnly, Item... items) {
        if (inventoryOnly) {
            return mod.getItemStorage().hasItemInventoryOnly(items);
        }
        return mod.getItemStorage().hasItem(items);
    }

    private static boolean miningRequirementMetInner(AltoClef mod, boolean inventoryOnly, MiningRequirement requirement) {
        switch (requirement) {
            case HAND:
                return true;
            case WOOD:
                return h(mod, inventoryOnly, Items.WOODEN_PICKAXE) || h(mod, inventoryOnly, Items.STONE_PICKAXE) || h(mod, inventoryOnly, Items.IRON_PICKAXE) || h(mod, inventoryOnly, Items.GOLDEN_PICKAXE) || h(mod, inventoryOnly, Items.DIAMOND_PICKAXE) || h(mod, inventoryOnly, Items.NETHERITE_PICKAXE);
            case STONE:
                return h(mod, inventoryOnly, Items.STONE_PICKAXE) || h(mod, inventoryOnly, Items.IRON_PICKAXE) || h(mod, inventoryOnly, Items.GOLDEN_PICKAXE) || h(mod, inventoryOnly, Items.DIAMOND_PICKAXE) || h(mod, inventoryOnly, Items.NETHERITE_PICKAXE);
            case IRON:
                return h(mod, inventoryOnly, Items.IRON_PICKAXE) || h(mod, inventoryOnly, Items.GOLDEN_PICKAXE) || h(mod, inventoryOnly, Items.DIAMOND_PICKAXE) || h(mod, inventoryOnly, Items.NETHERITE_PICKAXE);
            case DIAMOND:
                return h(mod, inventoryOnly, Items.DIAMOND_PICKAXE) || h(mod, inventoryOnly, Items.NETHERITE_PICKAXE);
            default:
                Debug.logError("You missed a spot");
                return false;
        }
    }

    public static boolean miningRequirementMet(AltoClef mod, MiningRequirement requirement) {
        return miningRequirementMetInner(mod, false, requirement);
    }

    public static boolean miningRequirementMetInventory(AltoClef mod, MiningRequirement requirement) {
        return miningRequirementMetInner(mod, true, requirement);
    }

    public static Optional<Slot> getBestToolSlot(AltoClef mod, BlockState state) {
        // TODO: mod.configState.silkTouchOverrideMode {
        //      DONT_CARE (Default)
        //      PREFER (Always use silk touch if we have)
        //      AVOID  (Don't use silk touch if we can)
        //  }
        Slot bestToolSlot = null;
        double highestSpeed = Double.NEGATIVE_INFINITY;
        if (Slot.getCurrentScreenSlots() != null) {
            for (Slot slot : Slot.getCurrentScreenSlots()) {
                if (!slot.isSlotInPlayerInventory())
                    continue;
                ItemStack stack = getItemStackInSlot(slot);
                if (ItemVersionHelper.isTool(stack.getItem())) {
                    if (stack.isCorrectToolForDrops(state)) {
                        double speed = ToolSet.calculateSpeedVsBlock(stack, state);
                        if (speed > highestSpeed) {
                            highestSpeed = speed;
                            bestToolSlot = slot;
                        }
                    }
                }
                if (stack.getItem() == Items.SHEARS) {
                    // Shears take priority over leaf blocks.
                    if (ItemHelper.areShearsEffective(state.getBlock())) {
                        bestToolSlot = slot;
                        break;
                    }
                }
            }
        }
        return Optional.ofNullable(bestToolSlot);
    }

    // Gets a slot with an item we can throw away
    public static Optional<Slot> getGarbageSlot(AltoClef mod) {
        // Throwaway items, but keep a few for building.
        final List<Slot> throwawayBlockItems = new ArrayList<>();
        int totalBlockThrowaways = 0;
        if (!mod.getItemStorage().getSlotsWithItemPlayerInventory(false, mod.getModSettings().getThrowawayItems(mod)).isEmpty()) {
            for (Slot slot : mod.getItemStorage().getSlotsWithItemPlayerInventory(false, mod.getModSettings().getThrowawayItems(mod))) {
                // Our cursor slot is NOT a garbage slot
                if (Slot.isCursor(slot))
                    continue;
                ItemStack stack = StorageHelper.getItemStackInSlot(slot);
                if (!ItemHelper.canThrowAwayStack(mod, stack))
                    continue;
                if (stack.getItem() instanceof BlockItem) {
                    totalBlockThrowaways += stack.getCount();
                    throwawayBlockItems.add(slot);
                } else {
                    // Throw away this non-block immediately.
                    return Optional.of(slot);
                }
            }
        }
        if (!throwawayBlockItems.isEmpty() && totalBlockThrowaways > mod.getModSettings().getReservedBuildingBlockCount()) {
            for (Slot throwawayBlockItem : throwawayBlockItems) {
                return Optional.ofNullable(throwawayBlockItem);
            }
        }

        // Try throwing away lower tier tools
        // 26.1: every tool is a plain Item, so group by tool KIND ("pickaxe", "axe", ...)
        // instead of by concrete class.
        final HashMap<String, Integer> bestMaterials = new HashMap<>();
        final HashMap<String, Slot> bestTool = new HashMap<>();
        if (PlayerSlot.getCurrentScreenSlots() != null) {
            for (Slot slot : PlayerSlot.getCurrentScreenSlots()) {
                ItemStack stack = StorageHelper.getItemStackInSlot(slot);
                if (!ItemHelper.canThrowAwayStack(mod, stack))
                    continue;
                Item item = stack.getItem();
                String c = ItemVersionHelper.getToolKind(item);
                if (c != null && ItemVersionHelper.isTool(item)) {
                    int level = ItemVersionHelper.getMaterialLevel(item);
                    int prevBest = bestMaterials.getOrDefault(c, 0);
                    if (level > prevBest) {
                        // We had a WORSE tool before.
                        if (bestTool.containsKey(c)) {
                            return Optional.of(bestTool.get(c));
                        }
                        bestMaterials.put(c, level);
                        bestTool.put(c, slot);
                    } else if (level < prevBest) {
                        // We found something WORSE!
                        return Optional.of(slot);
                    }
                }
            }
        }

        // Now we're getting desparate
        if (mod.getModSettings().shouldThrowawayUnusedItems()) {

            // Also uh calculate how much food we have.
            int calcTotalFoodScore = 0;

            // Get all non-important items. For now there is no measure of value.
            final List<Slot> possibleSlots = new ArrayList<>();
            if (PlayerSlot.getCurrentScreenSlots() != null) {
                for (Slot slot : PlayerSlot.getCurrentScreenSlots()) {
                    ItemStack stack = StorageHelper.getItemStackInSlot(slot);
                    // If we're an armor slot, don't count us.
                    if (slot instanceof PlayerSlot playerSlot) {
                        if (ArrayUtils.contains(PlayerSlot.ARMOR_SLOTS, playerSlot) ||
                                playerSlot.getWindowSlot() == PlayerSlot.OFFHAND_SLOT.getWindowSlot()) {
                            continue;
                        }
                    }
                    // Throw away-able slots are good!
                    if (ItemHelper.canThrowAwayStack(mod, stack)) {
                        possibleSlots.add(slot);
                    }
                    if (stack.has(DataComponents.FOOD)) {
                        calcTotalFoodScore += Objects.requireNonNull(stack.get(DataComponents.FOOD)).nutrition();
                    }
                }
            }

            final int totalFoodScore = calcTotalFoodScore;

            if (!possibleSlots.isEmpty()) {
                return possibleSlots.stream().min((leftSlot, rightSlot) -> {
                    ItemStack left = StorageHelper.getItemStackInSlot(leftSlot),
                            right = StorageHelper.getItemStackInSlot(rightSlot);
                    boolean leftIsTool = ItemVersionHelper.isTool(left.getItem());
                    boolean rightIsTool = ItemVersionHelper.isTool(right.getItem());
                    // Prioritize tools over materials.
                    if (rightIsTool && !leftIsTool) {
                        return -1;
                    } else if (leftIsTool && !rightIsTool) {
                        return 1;
                    }
                    if (rightIsTool && leftIsTool) {
                        // Prioritize material type, then durability.
                        int leftLevel = ItemVersionHelper.getMaterialLevel(left.getItem());
                        int rightLevel = ItemVersionHelper.getMaterialLevel(right.getItem());
                        if (leftLevel != rightLevel) {
                            return leftLevel - rightLevel;
                        }
                        // We want less damage.
                        return left.getDamageValue() - right.getDamageValue();
                    }

                    // Prioritize food over other things if we lack food.
                    boolean lacksFood = totalFoodScore < 8;
                    boolean leftIsFood = left.has(DataComponents.FOOD) && left.getItem() != Items.SPIDER_EYE;
                    boolean rightIsFood = right.has(DataComponents.FOOD) && right.getItem() != Items.SPIDER_EYE;
                    if (lacksFood) {
                        if (rightIsFood && !leftIsFood) {
                            return -1;
                        } else if (leftIsFood && !rightIsFood) {
                            return 1;
                        }
                    }
                    // If both are food, pick the better cost.
                    if (leftIsFood && rightIsFood) {
                        assert left.get(DataComponents.FOOD) != null;
                        assert right.get(DataComponents.FOOD) != null;
                        int leftCost = left.get(DataComponents.FOOD).nutrition() * left.getCount(),
                                rightCost = right.get(DataComponents.FOOD).nutrition() * right.getCount();
                        return -1 * (leftCost - rightCost);
                    }

                    // Just discard the one with the smallest quantity, but this doesn't really matter.
                    return left.getCount() - right.getCount();
                });
            }
        }
        return Optional.empty();
    }

    /**
     * @return whether EVERY item target in {@code targetsToMeet} is met in our inventory or conversion slots.
     */
    public static boolean itemTargetsMet(AltoClef mod, ItemTarget... targetsToMeet) {
        return Arrays.stream(targetsToMeet).allMatch(target -> mod.getItemStorage().getItemCount(target.getMatches()) >= target.getTargetCount());
    }

    /**
     * AVOID using this unless it's the end goal to keep an item in our inventory.
     *
     * @return whether EVERY item target in {@code targetsToMeet} is strictly in our inventory.
     */
    public static boolean itemTargetsMetInventory(AltoClef mod, ItemTarget... targetsToMeet) {
        return Arrays.stream(targetsToMeet).allMatch(target -> mod.getItemStorage().getItemCountInventoryOnly(target.getMatches()) >= target.getTargetCount());
    }

    /**
     * Same as {@code itemTargetsMetInventory} but it ignores the cursor slot.
     */
    public static boolean itemTargetsMetInventoryNoCursor(AltoClef mod, ItemTarget... targetsToMeet) {
        ItemStack cursorStack = getItemStackInCursorSlot();
        return Arrays.stream(targetsToMeet).allMatch(target -> {
            int count = mod.getItemStorage().getItemCountInventoryOnly(target.getMatches());
            if (target.matches(cursorStack.getItem()))
                count -= cursorStack.getCount();
            return count >= target.getTargetCount();
        });
    }

    public static boolean isArmorEquipped(AltoClef mod, Item... any) {
        for (Item item : any) {
            EquipmentSlot armorSlot = ItemVersionHelper.getArmorSlot(item);
            if (armorSlot != null && armorSlot.isArmor()) {
                ItemStack equippedStack = mod.getPlayer().getItemBySlot(armorSlot);
                if (equippedStack.getItem().equals(item))
                    return true;
            }
            if (item instanceof ShieldItem shield) {
                ItemStack equippedStack = mod.getPlayer().getInventory().getItem(Inventory.SLOT_OFFHAND);
                if (equippedStack.getItem().equals(shield))
                    return true;
            }
        }
        return false;
    }

    public static int getBuildingMaterialCount(AltoClef mod) {
        return mod.getItemStorage().getItemCount(Arrays.stream(mod.getModSettings().getThrowawayItems(mod, true)).filter(item -> item instanceof BlockItem && !item.equals(Items.GRAVEL) && !item.equals(Items.SAND)).toArray(Item[]::new));
    }

    private static boolean isScreenOpenInner(Predicate<AbstractContainerMenu> pNotNull) {
        LocalPlayer player = Minecraft.getInstance().player;
        if (player != null)
            return pNotNull.test(player.containerMenu);
        return false;
    }

    public static boolean isBigCraftingOpen() {
        return isScreenOpenInner(screen -> screen instanceof CraftingMenu);
    }

    public static boolean isPlayerInventoryOpen() {
        return isScreenOpenInner(screen -> screen instanceof InventoryMenu);
    }

    public static boolean isFurnaceOpen() {
        return isScreenOpenInner(screen -> screen instanceof FurnaceMenu);
    }

    public static boolean isSmokerOpen() {
        return isScreenOpenInner(screen -> screen instanceof SmokerMenu);
    }

    public static boolean isBlastFurnaceOpen() {
        return isScreenOpenInner(screen -> screen instanceof BlastFurnaceMenu);
    }

    public static boolean isArmorEquippedAll(AltoClef mod, Item... items) {
        return Arrays.stream(items).allMatch(item -> isArmorEquipped(mod, item));
    }

    public static boolean isEquipped(AltoClef mod, Item... items) {
        return ArrayUtils.contains(items, StorageHelper.getItemStackInSlot(PlayerSlot.getEquipSlot()).getItem());
    }

    public static int calculateInventoryFoodScore(AltoClef mod) {
        int result = 0;
        if (!mod.getItemStorage().getItemStacksPlayerInventory(true).isEmpty()) {
            for (ItemStack stack : mod.getItemStorage().getItemStacksPlayerInventory(true)) {
                if (stack.has(DataComponents.FOOD))
                    result += Objects.requireNonNull(stack.get(DataComponents.FOOD)).nutrition() * stack.getCount();
            }
        }
        return result;
    }

    public static double calculateInventoryFuelCount(AltoClef mod) {
        double result = 0;
        if (!mod.getItemStorage().getItemStacksPlayerInventory(true).isEmpty()) {
            for (ItemStack stack : mod.getItemStorage().getItemStacksPlayerInventory(true)) {
                if (mod.getModSettings().isSupportedFuel(stack.getItem())) {
                    result += ItemHelper.getFuelAmount(stack.getItem()) * stack.getCount();
                }
            }
        }
        return result;
    }

    /**
     * Returns whether we have the items in our inventory (or currently crafting)
     */
    @SuppressWarnings("BooleanMethodIsAlwaysInverted")
    public static boolean hasRecipeMaterialsOrTarget(AltoClef mod, RecipeTarget... targets) {
        HashMap<Integer, Integer> slotUsedCounts = new HashMap<>();
        for (RecipeTarget target : targets) {
            CraftingRecipe recipe = target.getRecipe();
            int need = 0;
            if (target.getOutputItem() != null) {
                need = target.getTargetCount();
                need -= mod.getItemStorage().getItemCount(target.getOutputItem());
            }
            // need holds how many items we need to CRAFT
            // However, a crafting recipe can output more than 1 of an item.
            int materialsPerSlotNeeded = (int) Math.ceil((float) need / target.getRecipe().outputCount());
            for (int i = 0; i < materialsPerSlotNeeded; ++i) {
                for (int slot = 0; slot < recipe.getSlotCount(); ++slot) {
                    ItemTarget needs = recipe.getSlot(slot);

                    // Satisfied by default.
                    if (needs == null || needs.isEmpty()) continue;

                    // do NOT include craft or armor slots. This would include the OUTPUT (which we DO NOT want)
                    List<Slot> slotsWithItem = mod.getItemStorage().getSlotsWithItemPlayerInventory(false, needs.getMatches());

                    // Other slots may have our crafting supplies.
                    AbstractContainerMenu screen = mod.getPlayer().containerMenu;
                    if (screen instanceof InventoryMenu || screen instanceof CraftingMenu) {
                        // Check crafting slots
                        boolean bigCrafting = (screen instanceof CraftingMenu);
                        boolean bigRecipe = recipe.isBig();
                        for (int craftSlotIndex = 0; craftSlotIndex < (bigCrafting ? 9 : 4); ++craftSlotIndex) {
                            Slot craftSlot = bigCrafting ? CraftingTableSlot.getInputSlot(craftSlotIndex, bigRecipe) : PlayerSlot.getCraftInputSlot(craftSlotIndex);
                            ItemStack stack = StorageHelper.getItemStackInSlot(craftSlot);
                            if (needs.matches(stack.getItem())) {
                                slotsWithItem.add(craftSlot);
                            }
                        }
                    }

                    // Try to satisfy THIS slot.
                    boolean satisfied = false;
                    if (!slotsWithItem.isEmpty()) {
                        for (Slot checkSlot : slotsWithItem) {
                            int windowSlot = checkSlot.getWindowSlot();
                            if (!slotUsedCounts.containsKey(windowSlot)) {
                                slotUsedCounts.put(windowSlot, 0);
                            }
                            int usedFromSlot = slotUsedCounts.get(windowSlot);
                            ItemStack stack = StorageHelper.getItemStackInSlot(checkSlot);

                            if (usedFromSlot < stack.getCount()) {
                                slotUsedCounts.put(windowSlot, slotUsedCounts.get(windowSlot) + 1);
                                //Debug.logMessage("Satisfied " + slot + " with " + checkInvSlot);
                                satisfied = true;
                                break;
                            }
                        }
                    }

                    if (!satisfied) {
                        //Debug.logMessage("FAILED TO SATISFY " + slot + " : needs " + needs);
                        // We couldn't satisfy this slot in either the inventory or crafting output.
                        return false;
                    }
                }
            }
        }
        return true;
    }

    public static boolean hasCataloguedItem(AltoClef mod, String cataloguedName) {
        return mod.getItemStorage().hasItem(TaskCatalogue.getItemMatches(cataloguedName));
    }

    /**
     * There are slots in our inventory that can't be accessed by containers
     * <p>
     * Mainly the crafting + armor + shield slot.
     *
     * @return A slot of {@code withItem} that is inaccessible to open containers, or {@code Optional.empty} if there
     * are none.
     */
    public static Optional<Slot> getFilledInventorySlotInaccessibleToContainer(AltoClef mod, ItemTarget withItem) {
        // First check if we have anything within our regular inventory.
        if (!StorageHelper.isPlayerInventoryOpen() || withItem.isEmpty() || itemTargetsMetInventory(mod, withItem)) {
            return Optional.empty();
        }
        // Then check our "invalid" slots for our item.
        for (Slot slot : INACCESSIBLE_PLAYER_SLOTS) {
            if (withItem.matches(getItemStackInSlot(slot).getItem())) {
                return Optional.of(slot);
            }
        }
        // Consider Cursor slot only if we have our player inventory open AND we're not crafting it...
        if (StorageHelper.isPlayerInventoryOpen() && withItem.matches(getItemStackInCursorSlot().getItem())) {
            if (!mod.getUserTaskChain().getCurrentTask().thisOrChildSatisfies(task -> {
                if (task instanceof CraftInInventoryTask invCraft) {
                    return withItem.matches(invCraft.getRecipeTarget().getOutputItem());
                }
                return false;
            })) {
                return Optional.of(CursorSlot.SLOT);
            }
        }
        return Optional.empty();
    }

    public static boolean isItemInaccessibleToContainer(AltoClef mod, ItemTarget item) {
        return getFilledInventorySlotInaccessibleToContainer(mod, item).isPresent();
    }

    public static ItemStack getItemStackInCursorSlot() {
        if (Minecraft.getInstance().player != null) {
            if (Minecraft.getInstance().player.containerMenu != null) {
                return Minecraft.getInstance().player.containerMenu.getCarried();
            }
        }
        return ItemStack.EMPTY;
    }

    public static int getBrewingStandFuel() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof BrewingStandMenu stand)
            return getBrewingStandFuel(stand);
        return -1;
    }

    public static int getBrewingStandFuel(BrewingStandMenu handler) {
        return handler.getFuel();
    }

    public static double getFurnaceFuel(AbstractFurnaceMenu handler) {
        ContainerData d = ((AbstractFurnaceScreenHandlerAccessor) handler).getPropertyDelegate();
        return (double) d.get(0) / 200.0;
    }

    public static double getSmokerFuel(AbstractFurnaceMenu handler) {
        ContainerData d = ((AbstractFurnaceScreenHandlerAccessor) handler).getPropertyDelegate();
        return (double) d.get(0) / 200.0;
    }

    public static double getBlastFurnaceFuel(AbstractFurnaceMenu handler) {
        ContainerData d = ((AbstractFurnaceScreenHandlerAccessor) handler).getPropertyDelegate();
        return (double) d.get(0) / 200.0;
    }

    public static double getFurnaceFuel() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu furnace)
            return getFurnaceFuel(furnace);
        return -1;
    }

    public static double getSmokerFuel() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu smoker)
            return getSmokerFuel(smoker);
        return -1;
    }

    public static double getBlastFurnaceFuel() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu blastFurnace)
            return getBlastFurnaceFuel(blastFurnace);
        return -1;
    }

    public static double getFurnaceCookPercent(AbstractFurnaceMenu handler) {
        return (double) handler.getBurnProgress() / 24.0;
    }

    public static double getSmokerCookPercent(AbstractFurnaceMenu handler) {
        return (double) handler.getBurnProgress() / 24.0;
    }

    public static double getBlastFurnaceCookPercent(AbstractFurnaceMenu handler) {
        return (double) handler.getBurnProgress() / 24.0;
    }

    public static double getFurnaceCookPercent() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu furnace)
            return getFurnaceCookPercent(furnace);
        return -1;
    }

    public static double getSmokerCookPercent() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu smoker)
            return getSmokerCookPercent(smoker);
        return -1;
    }

    public static double getBlastFurnaceCookPercent() {
        if (Minecraft.getInstance().player != null && Minecraft.getInstance().player.containerMenu instanceof AbstractFurnaceMenu blastFurnace)
            return getBlastFurnaceCookPercent(blastFurnace);
        return -1;
    }

    public static ItemTarget[] getAllInventoryItemsAsTargets(Predicate<Slot> accept) {
        HashMap<Item, Integer> counts = new HashMap<>();
        if (Slot.getCurrentScreenSlots() != null) {
            for (Slot slot : Slot.getCurrentScreenSlots()) {
                if (slot.isSlotInPlayerInventory() && accept.test(slot)) {
                    ItemStack stack = getItemStackInSlot(slot);
                    if (!stack.isEmpty()) {
                        counts.put(stack.getItem(), counts.getOrDefault(stack.getItem(), 0) + stack.getCount());
                    }
                }
            }
        }
        ItemTarget[] results = new ItemTarget[counts.size()];
        int i = 0;
        if (!counts.keySet().isEmpty()) {
            for (Item item : counts.keySet()) {
                results[i++] = new ItemTarget(item, counts.get(item));
            }
        }
        return results;
    }
}
