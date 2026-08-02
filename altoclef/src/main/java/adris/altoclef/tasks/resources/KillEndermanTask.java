package adris.altoclef.tasks.resources;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.ResourceTask;
import adris.altoclef.tasks.entity.KillEntitiesTask;
import adris.altoclef.tasks.entity.KillEntityTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.time.TimerGame;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.item.Items;

public class KillEndermanTask extends ResourceTask {

    private final int _count;

    private final TimerGame _lookDelay = new TimerGame(0.2);

    public KillEndermanTask(int count) {
        super(new ItemTarget(Items.ENDER_PEARL, count));
        _count = count;
    }

    @Override
    protected boolean shouldAvoidPickingUp(AltoClef mod) {
        return false;
    }

    @Override
    protected void onResourceStart(AltoClef mod) {

    }

    @Override
    protected Task onResourceTick(AltoClef mod) {
        // Dimension
        if (!mod.getEntityTracker().entityFound(EnderMan.class)) {
            return getToCorrectDimensionTask(mod);
        }

        // Kill the angry one
        for (EnderMan entity : mod.getEntityTracker().getTrackedEntities(EnderMan.class)) {
            final int TOO_FAR_AWAY = 256;

            if (entity.isAngry() && entity.position().closerThan(mod.getPlayer().position(), TOO_FAR_AWAY)) {
                return new KillEntityTask(entity);
            }
        }

        // Attack the closest one
        return new KillEntitiesTask(EnderMan.class);
    }

    @Override
    protected void onResourceStop(AltoClef mod, Task interruptTask) {

    }

    @Override
    protected boolean isEqualResource(ResourceTask other) {
        if (other instanceof KillEndermanTask task) {
            return task._count == _count;
        }
        return false;
    }

    @Override
    protected String toDebugStringName() {
        return "Hunting enderman for " + _count + " pearls.";
    }
}