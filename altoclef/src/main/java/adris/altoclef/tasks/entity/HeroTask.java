package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.movement.GetToEntityTask;
import adris.altoclef.tasks.movement.PickupDroppedItemTask;
import adris.altoclef.tasks.movement.RunAwayFromHostilesTask;
import adris.altoclef.tasks.movement.TimeoutWanderTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import adris.altoclef.util.helpers.EntityHelper;
import adris.altoclef.util.helpers.ItemHelper;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.monster.Slime;

import java.util.Optional;

public class HeroTask extends Task {
    // Hero is allowed to defend Burnt, not drag her across the loaded world into another
    // fight. Mob defense handles ranged threats before they enter this pursuit radius.
    private static final double MAX_PURSUIT_DISTANCE = 8;

    private Entity _combatTarget;
    private Task _combatTask;
    private final Task _retreatTask = new RunAwayFromHostilesTask(30, true);

    @Override
    protected void onStart(AltoClef mod) {
        _combatTarget = null;
        _combatTask = null;
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getFoodChain().needsToEat()) {
            setDebugState("Eat first.");
            return null;
        }
        if (mod.getMobDefenseChain().shouldRetreatFromCombat(mod)) {
            _combatTarget = null;
            _combatTask = null;
            setDebugState("Retreating from an unsafe fight.");
            return _retreatTask;
        }
        assert Minecraft.getInstance().level != null;
        Iterable<Entity> hostiles = Minecraft.getInstance().level.entitiesForRendering();
        Entity closest = null;
        double closestDistance = Double.POSITIVE_INFINITY;
        if (hostiles != null) {
            for (Entity hostile : hostiles) {
                if (!(hostile instanceof Monster || hostile instanceof Slime)) continue;
                if (!hostile.isAlive() || !mod.getEntityTracker().isEntityReachable(hostile)) continue;
                // Do not start fights with passive spiders, endermen, piglins, or anything
                // else that happens to inherit Monster but is not attacking Burnt.
                if (!EntityHelper.isGenerallyHostileToPlayer(mod, hostile)) continue;
                if (!hostile.closerThan(mod.getPlayer(), MAX_PURSUIT_DISTANCE)) continue;
                if (!mod.getMobDefenseChain().isSafeToStartFight(mod, hostile)) continue;
                if (hostile == _combatTarget) {
                    closest = hostile;
                    break;
                }
                double distance = hostile.distanceToSqr(mod.getPlayer());
                if (distance < closestDistance) {
                    closest = hostile;
                    closestDistance = distance;
                }
            }
        }
        if (closest != null) {
            if (closest != _combatTarget || _combatTask == null) {
                _combatTarget = closest;
                _combatTask = new KillEntityTask(closest);
            }
            setDebugState("Finishing current hostile.");
            return _combatTask;
        }
        _combatTarget = null;
        _combatTask = null;

        Optional<Entity> experienceOrb = mod.getEntityTracker().getClosestEntity(ExperienceOrb.class);
        if (experienceOrb.isPresent()) {
            setDebugState("Getting experience.");
            return new GetToEntityTask(experienceOrb.get());
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
        _combatTarget = null;
        _combatTask = null;
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
