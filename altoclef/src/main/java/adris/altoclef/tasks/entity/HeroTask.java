package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.movement.GetToEntityTask;
import adris.altoclef.tasks.movement.PickupDroppedItemTask;
import adris.altoclef.tasks.movement.TimeoutWanderTask;
import adris.altoclef.tasks.resources.KillAndLootTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.helpers.ItemHelper;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.monster.Slime;

import java.util.Optional;

public class HeroTask extends Task {
    @Override
    protected void onStart(AltoClef mod) {

    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getFoodChain().needsToEat()) {
            setDebugState("Eat first.");
            return null;
        }
        Optional<Entity> experienceOrb = mod.getEntityTracker().getClosestEntity(ExperienceOrb.class);
        if (experienceOrb.isPresent()) {
            setDebugState("Getting experience.");
            return new GetToEntityTask(experienceOrb.get());
        }
        assert Minecraft.getInstance().level != null;
        Iterable<Entity> hostiles = Minecraft.getInstance().level.entitiesForRendering();
        if (hostiles != null) {
            for (Entity hostile : hostiles) {
                if (hostile instanceof Monster || hostile instanceof Slime) {
                    Optional<Entity> closestHostile = mod.getEntityTracker().getClosestEntity(hostile.getClass());
                    if (closestHostile.isPresent()) {
                        setDebugState("Killing hostiles or picking hostile drops.");
                        return new KillAndLootTask(hostile.getClass(), new ItemTarget(ItemHelper.HOSTILE_MOB_DROPS));
                    }
                }
            }
        }
        if (mod.getEntityTracker().itemDropped(ItemHelper.HOSTILE_MOB_DROPS)) {
            setDebugState("Picking hostile drops.");
            return new PickupDroppedItemTask(new ItemTarget(ItemHelper.HOSTILE_MOB_DROPS), true);
        }
        setDebugState("Searching for hostile mobs.");
        return new TimeoutWanderTask();
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {

    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof HeroTask;
    }

    @Override
    protected String toDebugString() {
        return "Killing all hostile mobs.";
    }
}
