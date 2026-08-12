package adris.altoclef.tasks.resources;

import adris.altoclef.AltoClef;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasks.ResourceTask;
import adris.altoclef.tasks.container.SmeltInBlastFurnaceTask;
import adris.altoclef.tasks.container.SmeltInFurnaceTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.SmeltTarget;
import adris.altoclef.util.helpers.WorldHelper;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.item.Items;
import net.minecraft.core.BlockPos;

import java.util.Optional;

public class CollectIronIngotTask extends ResourceTask {

    private final int _count;

    public CollectIronIngotTask(int count) {
        super(Items.IRON_INGOT, count);
        _count = count;
    }

    @Override
    protected boolean shouldAvoidPickingUp(AltoClef mod) {
        return false;
    }

    @Override
    protected void onResourceStart(AltoClef mod) {
        mod.getBehaviour().push();
        mod.getBlockTracker().trackBlock(Blocks.FURNACE, Blocks.BLAST_FURNACE);
    }

    /**
     * a blast furnace this task could actually USE, by the same test the
     * container task applies - placed, tracked, and reachable from here.
     * <p>
     * ⚠ THE CHOICE MUST BE MADE ON THE TEST THAT DECIDES WHETHER THE CHOICE
     * WORKS. this used to ask `anyFound(BLAST_FURNACE)`, true for any blast
     * furnace the tracker has ever seen - including one in a stranger's base
     * 300 blocks off behind a claim. {@link adris.altoclef.tasks.container.DoStuffInContainerTask}
     * then applied the stricter `getNearestTracking(pos, canReach, ...)`, found
     * nothing, and went to CRAFT one - and a blast furnace costs 5 iron ingots,
     * which is exactly what we are standing here collecting. that closed a
     * cycle (collect iron -> smelt in blast furnace -> craft blast furnace ->
     * collect iron) which allocates a fresh task at every level and descends
     * until the stack dies. it crashed the client five times on 2026-08-06.
     */
    private static Optional<BlockPos> usableBlastFurnace(AltoClef mod) {
        return mod.getBlockTracker().getNearestTracking(
                mod.getPlayer().position(),
                blockPos -> WorldHelper.canReach(mod, blockPos),
                Blocks.BLAST_FURNACE);
    }

    @Override
    protected Task onResourceTick(AltoClef mod) {
        if (mod.getModSettings().shouldUseBlastFurnace()) {
            if (mod.getItemStorage().hasItem(Items.BLAST_FURNACE) ||
                    usableBlastFurnace(mod).isPresent() ||
                    mod.getEntityTracker().itemDropped(Items.BLAST_FURNACE)) {
                return new SmeltInBlastFurnaceTask(new SmeltTarget(new ItemTarget(Items.IRON_INGOT, _count), new ItemTarget(Items.RAW_IRON, _count)));
            }
            if (_count < 5) {
                return new SmeltInFurnaceTask(new SmeltTarget(new ItemTarget(Items.IRON_INGOT, _count), new ItemTarget(Items.RAW_IRON, _count)));
            }
            Optional<BlockPos> furnacePos = mod.getBlockTracker().getNearestTracking(Blocks.FURNACE);
            furnacePos.ifPresent(blockPos -> mod.getBehaviour().avoidBlockBreaking(blockPos));
            if (mod.getItemStorage().getItemCount(Items.IRON_INGOT) >= 5) {
                return TaskCatalogue.getItemTask(Items.BLAST_FURNACE, 1);
            }
            return new SmeltInFurnaceTask(new SmeltTarget(new ItemTarget(Items.IRON_INGOT, 5), new ItemTarget(Items.RAW_IRON, 5)));
        }
        return new SmeltInFurnaceTask(new SmeltTarget(new ItemTarget(Items.IRON_INGOT, _count), new ItemTarget(Items.RAW_IRON, _count)));
    }

    @Override
    protected void onResourceStop(AltoClef mod, Task interruptTask) {
        mod.getBehaviour().pop();
        mod.getBlockTracker().stopTracking(Blocks.FURNACE, Blocks.BLAST_FURNACE);
    }

    @Override
    protected boolean isEqualResource(ResourceTask other) {
        return other instanceof CollectIronIngotTask && ((CollectIronIngotTask) other)._count == _count;
    }

    @Override
    protected String toDebugStringName() {
        return "Collecting " + _count + " iron.";
    }
}
