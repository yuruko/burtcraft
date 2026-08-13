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
import adris.altoclef.util.time.TimerGame;
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
    /**
     * THIS TASK HAS TO BE ABLE TO END.
     * <p>
     * It had no isFinished() at all, so it inherited Task's permanent false, and
     * its idle branch returned an UNBOUNDED TimeoutWanderTask. "@hero" therefore
     * meant "wander the world killing things until something else replaces this
     * task" - and host-side, `defend` and `attack` both map to it, including from
     * _executeLastResort, which fires whenever nothing else wanted the tick. On
     * 2026-08-08 that put "killing all hostile mobs." in the user-task slot twice
     * inside ninety seconds and produced 28 "wander for infinity blocks" starts in
     * under ten minutes. It is what "she just runs around with no aim" looks like
     * from inside the log.
     * <p>
     * So the job is "clear what is on me", and it is DONE when nothing is on her.
     * The grace period exists because mobs arrive in waves and a kill drops loot a
     * moment later; ending on the first empty tick would just re-dispatch.
     */
    private static final double NOTHING_LEFT_SECONDS = 8;
    /**
     * Searching is bounded too. An unbounded wander is how a defensive job turned
     * into an expedition; a hero that cannot find a target near her is finished,
     * not obliged to go looking for one across the world.
     */
    private static final float SEARCH_WANDER_DISTANCE = 10;

    private Entity _combatTarget;
    private Task _combatTask;
    private final Task _retreatTask = new RunAwayFromHostilesTask(30, true);
    private final TimerGame _nothingLeft = new TimerGame(NOTHING_LEFT_SECONDS);
    private boolean _allClear;

    @Override
    protected void onStart(AltoClef mod) {
        _combatTarget = null;
        _combatTask = null;
        _allClear = false;
        _nothingLeft.reset();
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
                // BOW OR BLADE, decided ONCE per target - same question, same answer, and
                // deliberately the defense chain's own predicate rather than a second copy
                // of it here. `@hero` is what burnt's `attack`/`defend` verbs and every
                // viewer "kill that skeleton" run, so without this she could shoot
                // reflexively but never because she or anyone else chose to.
                //
                // ⚠ latched with the target, not re-asked per tick: the inputs (distance,
                // arrows, line of sight) all move constantly, and this assignment tears
                // down and rebuilds the sub-task.
                _combatTask = mod.getMobDefenseChain().shouldFightAtRange(mod, closest)
                        ? new BowCombatTask(closest)
                        : new KillEntityTask(closest);
            }
            // a ranged engagement that ran dry or could not line the shot up must fall
            // back to the blade rather than sit here finished - the same one-way door the
            // chain uses. Without it, HeroTask keeps returning a task that reports itself
            // done and nothing ever kills the mob.
            if (_combatTask instanceof BowCombatTask bow && bow.gaveUp()) {
                _combatTask = new KillEntityTask(closest);
            }
            setDebugState("Finishing current hostile.");
            _nothingLeft.reset();
            return _combatTask;
        }
        _combatTarget = null;
        _combatTask = null;

        Optional<Entity> experienceOrb = mod.getEntityTracker().getClosestEntity(ExperienceOrb.class);
        if (experienceOrb.isPresent()) {
            setDebugState("Getting experience.");
            _nothingLeft.reset();
            return new GetToEntityTask(experienceOrb.get());
        }
        if (mod.getEntityTracker().itemDropped(ItemHelper.HOSTILE_MOB_DROPS)) {
            setDebugState("Picking hostile drops.");
            _nothingLeft.reset();
            return new PickupDroppedItemTask(new ItemTarget(ItemHelper.HOSTILE_MOB_DROPS), true);
        }
        // Nothing hostile, no loot, no xp. Give the wave a moment to arrive, then
        // report the job done instead of wandering forever looking for one.
        if (_nothingLeft.elapsed()) {
            _allClear = true;
            setDebugState("All clear.");
            return null;
        }
        setDebugState("Searching for hostile mobs.");
        return new TimeoutWanderTask(SEARCH_WANDER_DISTANCE);
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return _allClear;
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
