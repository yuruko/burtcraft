package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.chains.MobDefenseChain;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.baritone.GoalRunAwayFromEntities;
import baritone.api.pathing.goals.Goal;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

public class RunAwayFromCreepersTask extends CustomBaritoneGoalTask {

    private final double _distanceToRun;

    public RunAwayFromCreepersTask(double distance) {
        _distanceToRun = distance;
    }

    @SuppressWarnings("RedundantIfStatement")
    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof RunAwayFromCreepersTask task) {
            //if (task._mob.getPos().distanceToSqr(_mob.getPos()) > 0.5) return false;
            if (Math.abs(task._distanceToRun - _distanceToRun) > 1) return false;
            return true;
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        return "Run " + _distanceToRun + " blocks away from creepers";
    }

    /**
     * No forceCancel() here - a QUERY MUST NEVER GRAB THE CONTROLS. Same reasoning as
     * RunAwayFromHostilesTask.newGoal(): CustomBaritoneGoalTask builds this goal lazily,
     * and the lazy build happens inside isFinished() as well as onTick(), so asking an
     * unstarted creeper-flee "are we clear yet" would throw away baritone's in-flight
     * path calculation. MobDefenseChain assigns _runAwayTask a fresh RunAwayFromCreepersTask
     * on every tick a creeper is fusing while setTask() refuses the twin, so those queries
     * land on orphans - during the one situation where being able to move matters most.
     * CustomBaritoneGoalTask.onStart() still cancels on the real start path.
     */
    @Override
    protected Goal newGoal(AltoClef mod) {
        return new GoalRunAwayFromCreepers(mod, _distanceToRun);
    }

    private static class GoalRunAwayFromCreepers extends GoalRunAwayFromEntities {

        public GoalRunAwayFromCreepers(AltoClef mod, double distance) {
            super(mod, distance, false, 10);
        }

        @Override
        protected List<Entity> getEntities(AltoClef mod) {
            return new ArrayList<>(mod.getEntityTracker().getTrackedEntities(Creeper.class));
        }

        @Override
        protected double getCostOfEntity(Entity entity, int x, int y, int z) {
            if (entity instanceof Creeper) {
                return MobDefenseChain.getCreeperSafety(new Vec3(x + 0.5, y + 0.5, z + 0.5), (Creeper) entity);
            }
            return super.getCostOfEntity(entity, x, y, z);
        }
    }
}
