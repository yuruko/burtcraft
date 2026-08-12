package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasksystem.Task;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;

import java.util.Objects;

/**
 * GET THE THING, THEN PUT THE THING DOWN.
 * <p>
 * {@code @place} and {@code @place_at} both went straight to a placement task, and
 * neither of them - nor anything upstream of them - ever checked that she owned the
 * block. PlaceBlockTask's own material step only ever collects dirt and cobblestone
 * (see getMaterialTask), and ToasterBuildTask acquires the shell's stone and the
 * torches but deliberately does not install appliances at all: it only SURVEYS the
 * gallery and publishes nextApplianceKind/Pos, and the node side turns that into
 * "@place_at x y z furnace". So the appliances were the one class of block in the
 * homestead that nobody was responsible for obtaining.
 * <p>
 * With an empty bag the failure is silent and eternal. Baritone's builder says
 * "missing materials for at least: 1x Block{minecraft:furnace}[facing=north]" and
 * pauses, PlaceBlockTask's progress checker times out and wanders 5 blocks, then it
 * restarts the builder, which says the same thing. Live on 2026-08-06 that ran for
 * about a hundred seconds against one furnace slot - 8 builder pauses, 9 wanders,
 * 115 "letting baritone place a block" - and looked exactly like being stuck on the
 * terrain, which is why it reads as a placement bug rather than an empty inventory.
 * <p>
 * Note the failure is NOT about orientation. canSupply() falls back to
 * samePlacementItem(), which compares asItem(), so any furnace in any slot would
 * have satisfied a schematic asking for any facing. "Missing materials" here means
 * what it says.
 */
public class AcquireAndPlaceBlockTask extends Task {

    private final Block _block;
    /** null = anywhere nearby; otherwise the exact square from the floorplan. */
    private final BlockPos _exact;
    /**
     * Built ONCE and returned every tick. These carry real internal state - a
     * progress checker, a wander timer, an event subscription - and minting a fresh
     * one per tick would reset all of it, which is the same stutter every other task
     * in this package has had to learn about.
     */
    private final Task _place;

    public AcquireAndPlaceBlockTask(Block block, BlockPos exact) {
        _block = block;
        _exact = exact;
        _place = exact != null ? new PlaceBlockTask(exact, block) : new PlaceBlockNearbyTask(block);
    }

    public AcquireAndPlaceBlockTask(Block block) {
        this(block, null);
    }

    @Override
    protected void onStart(AltoClef mod) {
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (isFinished(mod)) return null;
        Item item = _block.asItem();
        if (item != Items.AIR && !hasOne(mod, item) && TaskCatalogue.taskExists(item)) {
            setDebugState("Getting a " + _block.getName().getString().toLowerCase() + " to place");
            // ONE. getItemTask's count is a stock level to END UP HOLDING, not a
            // batch to make, so asking for more than the single block this task
            // places would send her on a mining trip per appliance.
            return TaskCatalogue.getItemTask(item, 1);
        }
        // No item and no recipe for it is not something waiting will fix: fall
        // through and let the placement task fail honestly, the way it would have
        // before this class existed.
        setDebugState("Placing");
        return _place;
    }

    /**
     * INVENTORY ONLY. getItemCount() also counts whatever container screen happens
     * to be open, so standing at the home chest with a stack of furnaces in it would
     * read as "she has one" - and she would then try to place a block that is not in
     * her hand, forever. (Same trap as the furnace-GUI count flip: the remedy for
     * the shortage is exactly what falsifies the shortage.)
     */
    private static boolean hasOne(AltoClef mod, Item item) {
        return mod.getItemStorage().getItemCountInventoryOnly(item) > 0;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        if (_exact != null) {
            return mod.getWorld().getBlockState(_exact).getBlock() == _block;
        }
        // "placed one somewhere" is only knowable by the task that placed it, and
        // asking before it has ever run gets an answer about nothing.
        return _place.isActive() && _place.isFinished(mod);
    }

    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof AcquireAndPlaceBlockTask task) {
            return task._block == _block && Objects.equals(task._exact, _exact);
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        String what = _block.getName().getString().toLowerCase();
        return _exact != null ? "installing " + what + " at " + _exact.toShortString()
                : "placing " + what + " nearby";
    }
}
