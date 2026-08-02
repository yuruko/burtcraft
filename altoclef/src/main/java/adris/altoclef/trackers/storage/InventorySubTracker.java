package adris.altoclef.trackers.storage;

import adris.altoclef.trackers.Tracker;
import adris.altoclef.trackers.TrackerManager;
import adris.altoclef.util.helpers.ItemHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.slots.CraftingTableSlot;
import adris.altoclef.util.slots.CursorSlot;
import adris.altoclef.util.slots.PlayerSlot;
import adris.altoclef.util.slots.Slot;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.inventory.AbstractContainerMenu;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import net.minecraft.core.component.DataComponents;

/**
 * Keeps track of the player's inventory items
 */
public class InventorySubTracker extends Tracker {

    private final HashMap<Item, List<Slot>> _itemToSlotPlayer = new HashMap<>();
    private final HashMap<Item, List<Slot>> _itemToSlotContainer = new HashMap<>();
    private final HashMap<Item, Integer> _itemCountsPlayer = new HashMap<>();
    private final HashMap<Item, Integer> _itemCountsContainer = new HashMap<>();

    // boots, leggings, chestplate, helmet - the old inv.armor index order (0..3)
    private static final EquipmentSlot[] ARMOR_SLOTS_LOW_TO_HIGH = {
            EquipmentSlot.FEET, EquipmentSlot.LEGS, EquipmentSlot.CHEST, EquipmentSlot.HEAD
    };

    private AbstractContainerMenu _prevScreenHandler;

    public InventorySubTracker(TrackerManager manager) {
        super(manager);
    }

    private static boolean shouldIgnoreSlotForContainer(Slot slot) {
        // IMPORTANT NOTE:!!!!
        // Ignore crafting table output when calculating container slots.
        //
        // Why?
        // Because we don't want the bot to think we "have" an item if it's in our output slot. Otherwise it will
        // softlock because it will assume we're all good (we got the item!) when in reality we need to grab that item.
        //
        // We also don't want our bot to think we "have" an item if it's in our armor/crafting/shield slots. That's annoying to work with.
        if (slot instanceof CraftingTableSlot && slot.equals(CraftingTableSlot.OUTPUT_SLOT))
            return true;
        if (slot instanceof PlayerSlot) {
            // Ignore non-normal inventory slots
            int window = slot.getWindowSlot();
            return window < 9 || window > 44;
        }
        return false;
    }

    public int getItemCount(boolean playerInventory, boolean containerInventory, Item... items) {
        ensureUpdated();
        int result = 0;
        ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
        for (Item item : items) {
            if (playerInventory && cursorStack.getItem().equals(item))
                result += cursorStack.getCount();
            if (playerInventory)
                result += _itemCountsPlayer.getOrDefault(item, 0);
            if (containerInventory)
                result += _itemCountsContainer.getOrDefault(item, 0);
        }
        return result;
    }

    public boolean hasItem(boolean playerInventoryOnly, Item... items) {
        ensureUpdated();
        ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
        for (Item item : items) {
            if (cursorStack.getItem().equals(item))
                return true;
            if (_itemCountsPlayer.containsKey(item))
                return true;
            if (!playerInventoryOnly && _itemCountsContainer.containsKey(item))
                return true;
        }
        return false;
    }

    public List<Slot> getSlotsWithItems(boolean playerInventory, boolean containerInventory, Item... items) {
        ensureUpdated();
        List<Slot> result = new ArrayList<>();
        ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
        for (Item item : items) {
            if (playerInventory && cursorStack.getItem().equals(item))
                result.add(CursorSlot.SLOT);
            if (playerInventory)
                result.addAll(_itemToSlotPlayer.getOrDefault(item, Collections.emptyList()));
            if (containerInventory)
                result.addAll(_itemToSlotContainer.getOrDefault(item, Collections.emptyList()));
        }
        return result;
    }

    public List<ItemStack> getInventoryStacks(boolean includeCursor) {
        LocalPlayer player = Minecraft.getInstance().player;
        if (player == null || player.getInventory() == null)
            return Collections.emptyList();
        Inventory inv = player.getInventory();
        // 36 player + 1 offhand + 4 armor
        List<ItemStack> result = new ArrayList<>(41 + (includeCursor ? 1 : 0));
        if (includeCursor) {
            result.add(StorageHelper.getItemStackInCursorSlot());
        }
        // 26.1: armor/offhand left Inventory for the entity equipment map, and the
        // main grid is behind getNonEquipmentItems(). same order as the old lists.
        result.addAll(inv.getNonEquipmentItems());
        for (EquipmentSlot armorSlot : ARMOR_SLOTS_LOW_TO_HIGH) {
            result.add(player.getItemBySlot(armorSlot));
        }
        result.add(player.getItemBySlot(EquipmentSlot.OFFHAND));
        return result;
    }

    private List<Slot> getSlotsThatCanFit(HashMap<Item, List<Slot>> list, ItemStack item, boolean acceptPartial) {
        List<Slot> result = new ArrayList<>();
        // First add fillable slots
        for (Slot toCheckStackable : list.getOrDefault(item.getItem(), Collections.emptyList())) {
            // Ignore cursor slot.
            if (Slot.isCursor(toCheckStackable))
                continue;
            ItemStack stackToAddTo = StorageHelper.getItemStackInSlot(toCheckStackable);
            // We must have SOME room left, then we decide whether we care about having ENOUGH
            if (!stackToAddTo.isEmpty() && ItemHelper.canStackTogether(item, stackToAddTo)) {
                int roomLeft = stackToAddTo.getOrDefault(DataComponents.MAX_STACK_SIZE, 1) - stackToAddTo.getCount();
                if (acceptPartial || roomLeft > item.getCount()) {
                    result.add(toCheckStackable);
                }
            }
        }
        // Then add air slots that can insert our item
        if (Minecraft.getInstance().player != null) {
            AbstractContainerMenu handler = Minecraft.getInstance().player.containerMenu;
            for (Slot airSlot : list.getOrDefault(Items.AIR, Collections.emptyList())) {
                // Ignore cursor slot
                if (airSlot.equals(CursorSlot.SLOT))
                    continue;
                int windowCheck = airSlot.getWindowSlot();
                // Special case: Armor/shield, we wish to ignore these if our inventory is not open.
                if (windowCheck < handler.slots.size() && handler.getSlot(windowCheck).mayPlace(item)) {
                    result.add(airSlot);
                }
            }
        }
        return result;
    }

    public List<Slot> getSlotsThatCanFit(boolean includePlayer, boolean includeContainer, ItemStack item, boolean acceptPartial) {
        ensureUpdated();
        final List<Slot> result = new ArrayList<>();
        if (includePlayer)
            result.addAll(getSlotsThatCanFit(_itemToSlotPlayer, item, acceptPartial));
        if (includeContainer)
            result.addAll(getSlotsThatCanFit(_itemToSlotContainer, item, acceptPartial));
        return result;
    }

    public boolean hasEmptySlot(boolean playerInventoryOnly) {
        return hasItem(playerInventoryOnly, Items.AIR);
    }

    private void registerItem(ItemStack stack, Slot slot, boolean isSlotPlayerInventory) {
        Item item = stack.getItem();
        int count = stack.getCount();
        if (stack.isEmpty()) {
            // If our cursor slot is empty, IGNORE IT as we don't want to treat it as a valid slot.
            item = Items.AIR;
            count = 0;
        }

        if (isSlotPlayerInventory) {
            _itemCountsPlayer.put(item, _itemCountsPlayer.getOrDefault(item, 0) + count);
        } else {
            _itemCountsContainer.put(item, _itemCountsContainer.getOrDefault(item, 0) + count);
        }

        if (slot != null) {
            HashMap<Item, List<Slot>> toAdd = isSlotPlayerInventory ? _itemToSlotPlayer : _itemToSlotContainer;
            if (!toAdd.containsKey(item))
                toAdd.put(item, new ArrayList<>());
            toAdd.get(item).add(slot);
        }
    }

    @Override
    protected void updateState() {
        _prevScreenHandler = Minecraft.getInstance().player != null ? Minecraft.getInstance().player.containerMenu : null;

        _itemToSlotPlayer.clear();
        _itemToSlotContainer.clear();
        _itemCountsPlayer.clear();
        _itemCountsContainer.clear();
        if (Minecraft.getInstance().player == null)
            return;
        AbstractContainerMenu handler = Minecraft.getInstance().player.containerMenu;
        if (handler == null)
            return;
        for (Slot slot : Slot.getCurrentScreenSlots()) {
            // Ignore cursor slot, that's handled separately.
            if (slot.equals(CursorSlot.SLOT))
                continue;
            ItemStack stack = StorageHelper.getItemStackInSlot(slot);
            // Add separately if we're in a container vs player inventory.

            if (!shouldIgnoreSlotForContainer(slot)) {
                registerItem(stack, slot, slot.isSlotInPlayerInventory());
            }
        }
    }

    @Override
    protected void reset() {
        _itemToSlotPlayer.clear();
        _itemToSlotContainer.clear();
        _itemCountsPlayer.clear();
        _itemCountsContainer.clear();
    }

    @Override
    protected boolean isDirty() {
        AbstractContainerMenu handler = Minecraft.getInstance().player != null ? Minecraft.getInstance().player.containerMenu : null;
        return super.isDirty() || handler != _prevScreenHandler;
    }
}
