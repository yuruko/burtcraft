package adris.altoclef.tasks;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.movement.TimeoutWanderTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.WorldHelper;
import adris.altoclef.util.time.TimerGame;
import net.minecraft.world.phys.Vec3;

import java.util.HashMap;
import java.util.Optional;

/**
 * Use this whenever you want to travel to a target position that may change.
 * <p>
 * https://www.notion.so/Closest-threshold-ing-system-utility-c3816b880402494ba9209c9f9b62b8bf
 */
public abstract class AbstractDoToClosestObjectTask<T> extends Task {

    // How long a chosen pursuit is held before a rival candidate may take it.
    // Must exceed a baritone path calculation (~1s at fighting range) or the switch
    // happens before the previous plan ever produced a step. See onTick().
    private static final double PURSUIT_COMMIT_SECONDS = 2.5;
    // A rival this much closer (squared) is a real upgrade, not drift, and may take
    // the pursuit immediately. Mirrors the /4 the heuristic path already uses.
    private static final double PURSUIT_OVERRIDE_RATIO = 4.0;

    private final HashMap<T, CachedHeuristic> _heuristicMap = new HashMap<>();
    private T _currentlyPursuing = null;
    private boolean _wasWandering;
    private Task _goalTask = null;
    private final TimerGame _pursuitCommitment = new TimerGame(PURSUIT_COMMIT_SECONDS);

    protected abstract Vec3 getPos(AltoClef mod, T obj);

    protected abstract Optional<T> getClosestTo(AltoClef mod, Vec3 pos);

    protected abstract Vec3 getOriginPos(AltoClef mod);

    protected abstract Task getGoalTask(T obj);

    protected abstract boolean isValid(AltoClef mod, T obj);

    // Virtual
    protected Task getWanderTask(AltoClef mod) {
        return new TimeoutWanderTask(true);
    }

    public void resetSearch() {
        _currentlyPursuing = null;
        _heuristicMap.clear();
        _goalTask = null;
        _pursuitCommitment.reset();
    }

    public boolean wasWandering() {
        return _wasWandering;
    }

    private double getCurrentCalculatedHeuristic(AltoClef mod) {
        Optional<Double> ticksRemainingOp = mod.getClientBaritone().getPathingBehavior().ticksRemainingInSegment();
        return ticksRemainingOp.orElse(Double.POSITIVE_INFINITY);
    }

    private boolean isMovingToClosestPos(AltoClef mod) {
        return _goalTask != null;// && _goalTask.isActive() && !_goalTask.isFinished(mod);
    }

    @Override
    protected Task onTick(AltoClef mod) {

        _wasWandering = false;

        // Reset our pursuit if our pursuing object no longer is pursuable.
        if (_currentlyPursuing != null && !isValid(mod, _currentlyPursuing)) {
            // This is probably a good idea, no?
            _heuristicMap.remove(_currentlyPursuing);
            _currentlyPursuing = null;
        }

        // Get closest object
        Optional<T> checkNewClosest = getClosestTo(mod, getOriginPos(mod));

        // Receive closest object and position
        if (checkNewClosest.isPresent() && !checkNewClosest.get().equals(_currentlyPursuing)) {
            T newClosest = checkNewClosest.get();
            // Different closest object
            if (_currentlyPursuing == null) {
                // We don't have a closest object
                _currentlyPursuing = newClosest;
                _pursuitCommitment.reset();
            } else {
                if (isMovingToClosestPos(mod)) {
                    setDebugState("Moving towards closest...");
                    double currentHeuristic = getCurrentCalculatedHeuristic(mod);
                    double closestDistanceSqr = getPos(mod, _currentlyPursuing).distanceToSqr(mod.getPlayer().position());
                    int lastTick = WorldHelper.getTicks();

                    if (!_heuristicMap.containsKey(_currentlyPursuing)) {
                        _heuristicMap.put(_currentlyPursuing, new CachedHeuristic());
                    }
                    CachedHeuristic h = _heuristicMap.get(_currentlyPursuing);
                    h.updateHeuristic(currentHeuristic);
                    h.updateDistance(closestDistanceSqr);
                    h.setTickAttempted(lastTick);
                    // COMMIT TO A TARGET. every switch below replaces _goalTask, which
                    // tears the sub-task tree down and restarts baritone pathing (~1s),
                    // so switching faster than that means no plan ever produces a step.
                    // in a SWARM that is fatal: a different mob is "closest" on almost
                    // every tick, so she re-planned continuously, never swung, and was
                    // beaten to death standing still (2026-08-01, slain by Zombie 49s
                    // after joining - the log is `killing entity.minecraft.zombie`
                    // interrupted by `killing entity.minecraft.zombie` on repeat).
                    // one mob has nothing to switch to, which is why the single-zombie
                    // fight looked fine and only the swarm case died.
                    boolean mayRelease = _pursuitCommitment.elapsed();
                    double newDistSqr = getPos(mod, newClosest).distanceToSqr(mod.getPlayer().position());
                    // something dramatically closer is a real upgrade, not drift - the
                    // mob actually on top of her outranks the one she started walking at.
                    boolean muchCloser = newDistSqr * PURSUIT_OVERRIDE_RATIO < closestDistanceSqr;
                    if (_heuristicMap.containsKey(newClosest)) {
                        // Our new object has a past potential heuristic calculated, if it's better try it out.
                        CachedHeuristic maybeReAttempt = _heuristicMap.get(newClosest);
                        double maybeClosestDistance = newDistSqr;
                        // Get considerably closer (divide distance by 2)
                        if ((mayRelease || muchCloser)
                                && (maybeReAttempt.getHeuristicValue() < h.getHeuristicValue() || maybeClosestDistance < maybeReAttempt.getClosestDistanceSqr() / 4)) {
                            setDebugState("Retrying old heuristic!");
                            // The currently closest previously calculated heuristic is better, move towards it!
                            _currentlyPursuing = newClosest;
                            _pursuitCommitment.reset();
                            // In theory, this next line shouldn't need to be run,
                            // but it's CRITICAL to making this work for some reason
                            maybeReAttempt.updateDistance(maybeClosestDistance);
                        } else {
                            setDebugState("Sticking with current pursuit");
                        }
                    } else if (mayRelease || muchCloser) {
                        setDebugState("Trying out NEW pursuit");
                        // Our new object does not have a heuristic, TRY IT OUT!
                        _currentlyPursuing = newClosest;
                        _pursuitCommitment.reset();
                    } else {
                        // "I have never tried this one" is NOT a reason to abandon a
                        // target she is already committed to. this branch used to switch
                        // unconditionally, and in a crowd every tick offers a fresh
                        // never-tried candidate, so it never converged on anything.
                        setDebugState("Sticking with current pursuit");
                    }
                } else {
                    setDebugState("Waiting for move task to kick in...");
                    // We should keep moving towards our object until we get some new info.
                }
            }
        }

        if (_currentlyPursuing != null) {
            _goalTask = getGoalTask(_currentlyPursuing);
            return _goalTask;
        } else {
            _goalTask = null;
        }

        //noinspection ConstantConditions
        if (checkNewClosest.isEmpty() && _currentlyPursuing == null) {
            setDebugState("Waiting for calculations I think (wandering)");
            _wasWandering = true;
            return getWanderTask(mod);
        }

        setDebugState("Waiting for calculations I think (NOT wandering)");
        return null;
    }

    private static class CachedHeuristic {

        private double _closestDistanceSqr;
        private int _tickAttempted;
        private double _heuristicValue;

        public CachedHeuristic() {
            _closestDistanceSqr = Double.POSITIVE_INFINITY;
            _heuristicValue = Double.POSITIVE_INFINITY;
        }

        public CachedHeuristic(double closestDistanceSqr, int tickAttempted, double heuristicValue) {
            _closestDistanceSqr = closestDistanceSqr;
            _tickAttempted = tickAttempted;
            _heuristicValue = heuristicValue;
        }

        public double getHeuristicValue() {
            return _heuristicValue;
        }

        public void updateHeuristic(double heuristicValue) {
            _heuristicValue = Math.min(_heuristicValue, heuristicValue);
        }

        public double getClosestDistanceSqr() {
            return _closestDistanceSqr;
        }

        public void updateDistance(double closestDistanceSqr) {
            _closestDistanceSqr = Math.min(_closestDistanceSqr, closestDistanceSqr);
        }

        public int getTickAttempted() {
            return _tickAttempted;
        }

        public void setTickAttempted(int tickAttempted) {
            _tickAttempted = tickAttempted;
        }
    }
}
