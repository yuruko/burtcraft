package adris.altoclef.trackers.storage;

import adris.altoclef.util.Dimension;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.FurnaceMenu;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.core.BlockPos;

import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

public class ContainerCache {

    private final BlockPos _blockPos;
    private final Dimension _dimension;
    private final ContainerType _containerType;

    private final HashMap<Item, Integer> _itemCounts = new HashMap<>();
    private int _emptySlots;
    /**
     * WHEN THESE TALLIES WERE LAST TRUE.
     * <p>
     * a cache is only refreshed while its screen is OPEN, and
     * ContainerSubTracker.isContainerCacheValid deliberately answers true
     * for an UNLOADED chunk - so a chest read three hours ago keeps reporting its
     * old contents forever with nothing whatsoever marking it stale. that is
     * survivable while the numbers stay inside the bot's own planning, and it is
     * NOT survivable now that they leave the game: burnt says these out loud and
     * acts on them. anyone reading a count must be able to ask how old it is.
     */
    private long _lastUpdated = 0L;

    public ContainerCache(Dimension dimension, BlockPos blockPos, ContainerType containerType) {
        _dimension = dimension;
        _blockPos = blockPos;
        _containerType = containerType;
    }

    public void update(AbstractContainerMenu screenHandler, Consumer<ItemStack> onStack) {
        _itemCounts.clear();
        _emptySlots = 0;
        int start = 0;
        int end = screenHandler.slots.size() - (4 * 9); // subtract by player inventory
        // do NOT count the furnace output slot as an empty slot, it cannot be used.
        boolean isFurnace = (screenHandler instanceof FurnaceMenu);

        // Iterate through all STORAGE slots
        for (int i = start; i < end; ++i) {
            ItemStack stack = screenHandler.slots.get(i).getItem().copy();

            if (stack.isEmpty()) {
                // Ignore furnace output slot
                if (!(isFurnace && i == 2)) {
                    _emptySlots++;
                }
            } else {
                Item item = stack.getItem();
                int count = stack.getCount();
                _itemCounts.put(item, _itemCounts.getOrDefault(item, 0) + count);
                onStack.accept(stack);
            }
        }
        // stamped AFTER the tallies, so the timestamp can never be newer than
        // the numbers it vouches for.
        _lastUpdated = System.currentTimeMillis();
    }

    /**
     * every tally in this container, as a snapshot copy.
     * <p>
     * this exists so a reader does not have to walk BuiltInRegistries.ITEM
     * calling {@link #getItemCount} - that is ~1500 lookups per container, and
     * the telemetry poll would pay it every 2 seconds per chest.
     */
    public Map<Item, Integer> getItemCounts() {
        return Collections.unmodifiableMap(new LinkedHashMap<>(_itemCounts));
    }

    /**
     * epoch millis of the last {@link #update}, or 0 if never read.
     * see {@link #_lastUpdated} - an old number here is the only warning a
     * consumer gets that the chest may have been emptied since.
     */
    public long lastUpdated() {
        return _lastUpdated;
    }

    public int getItemCount(Item... items) {
        int result = 0;
        for (Item item : items) {
            result += _itemCounts.getOrDefault(item, 0);
        }
        return result;
    }

    public boolean hasItem(Item... items) {
        for (Item item : items) {
            if (_itemCounts.containsKey(item) && _itemCounts.get(item) > 0)
                return true;
        }
        return false;
    }

    public int getEmptySlotCount() {
        return _emptySlots;
    }

    public boolean isFull() {
        return _emptySlots == 0;
    }

    public BlockPos getBlockPos() {
        return _blockPos;
    }

    public ContainerType getContainerType() {
        return _containerType;
    }

    public Dimension getDimension() {
        return _dimension;
    }
}
