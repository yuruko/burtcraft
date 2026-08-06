package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.baritone.GoalRunAwayFromEntities;
import adris.altoclef.util.helpers.BaritoneHelper;
import adris.altoclef.util.time.TimerGame;
import baritone.api.pathing.goals.Goal;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.skeleton.AbstractSkeleton;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class RunAwayFromHostilesTask extends CustomBaritoneGoalTask {

    // the goal must stay satisfied for this long before the escape counts as over.
    private static final double ESCAPE_SETTLE_SECONDS = 0.75;
    // EntityTracker.getHostiles() can disappear between attack animations. Keep the
    // last real snapshot in the goal too, so baritone keeps moving during that flicker.
    private static final long HOSTILE_GRACE_NANOS = 3_000_000_000L;

    /**
     * STATIC ON PURPOSE - this ledger has to outlive the task that fills it.
     * <p>
     * It was an instance field, and that quietly cost burnt her life on 2026-08-04
     * (slain by a zombie at 15:44:47 after 47 seconds of standing still). The loop:
     * MobDefenseChain's engagement latch holds the chain while a threat is near, but
     * the settle debounce below eventually reports the escape FINISHED anyway - because
     * this goal calls itself satisfied whenever its entity list comes back empty, and
     * that list is built from the flickering getHostiles(). The chain then does
     * setTask(null); setTask(freshFleeTask) to install a live answer... and a FRESH
     * INSTANCE STARTS WITH AN EMPTY GRACE MAP, so it is blind to the very flicker this
     * map exists to survive, declares itself satisfied again 0.75s later, and gets
     * rebuilt again. Forever.
     * <p>
     * Each rebuild force-cancels baritone THREE times (CustomBaritoneGoalTask.onStop,
     * .onStart, and newGoal below), so at ~1.3 rebuilds/second baritone never survives
     * long enough to finish a path calculation - which at these ranges takes 1-6s. She
     * had a goal, a live task and a chain that was defending her correctly, and she
     * could not take a single step.
     * <p>
     * Keeping the ledger static means a replacement task inherits what its predecessor
     * saw, so the goal stops lying, isFinished() stops flickering true, and the chain
     * stops rebuilding it. Entries self-expire (dead or older than the grace window),
     * so there is nothing here to leak.
     */
    private static final Map<Entity, Long> _recentHostiles = new HashMap<>();

    /**
     * The settle state stays PER-INSTANCE, unlike the sighting ledger above, and the
     * difference is load-bearing in both directions.
     * <p>
     * A fresh instance returning false on its first satisfied evaluation is not an
     * accident, it is a SAFETY INVARIANT: SingleTaskChain.onTick asks isFinished()
     * BEFORE it ever calls tick(), so a task that reports finished on arrival is never
     * ticked, never runs onStart, and is immediately handed to onTaskFinish. The chain
     * then re-installs another one next tick and burnt stands still at priority 70 with
     * nothing running at all - no goal, no path, no user task. Sharing this state
     * class-wide breaks that invariant, because a previous escape (possibly HeroTask's
     * or CollectBlazeRodsTask's, which build their own) leaves it latched satisfied and
     * the next flee inherits "already clear" before it has drawn a breath.
     * <p>
     * What the ledger fixes is amnesia about the WORLD; what this must not lose is
     * caution about ITSELF. So: sightings are shared, settle is not.
     * <p>
     * This is only safe because the chain no longer mints a replacement task on every
     * tick - see MobDefenseChain.beginOrAdoptFlee(). If per-tick minting ever comes
     * back, this state stops accumulating and isFinished() pins false forever.
     */
    private final TimerGame _clearFor = new TimerGame(ESCAPE_SETTLE_SECONDS);
    private boolean _wasClear = false;

    private final double _distanceToRun;
    private final boolean _includeSkeletons;

    public RunAwayFromHostilesTask(double distance, boolean includeSkeletons) {
        _distanceToRun = distance;
        _includeSkeletons = includeSkeletons;
    }

    public RunAwayFromHostilesTask(double distance) {
        this(distance, false);
    }


    /**
     * NO forceCancel() HERE. A QUERY MUST NEVER GRAB THE CONTROLS.
     * <p>
     * This used to cancel baritone's pathing "because we want to run away NOW", which
     * reads as harmless until you follow who calls it. {@link CustomBaritoneGoalTask}
     * builds the goal LAZILY, and the lazy build sits inside {@code isFinished()} as
     * much as inside {@code onTick()} - so simply ASKING an unstarted flee task whether
     * the escape is over threw away whatever path baritone had in flight.
     * <p>
     * And MobDefenseChain asks constantly, of tasks it never installed: commitTo()
     * returns true the moment the mode already matches, so a FLEE-committed tick mints a
     * fresh RunAwayFromHostilesTask, SingleTaskChain.setTask() then refuses it (isEqual
     * matches any two runs of the same distance), and the chain is left holding an orphan
     * it still calls isFinished() on every tick. One boolean read, one dead A* calc, at
     * roughly 1Hz against calculations that take 1-6 seconds. She could not take a step.
     * <p>
     * The cancel is not lost: CustomBaritoneGoalTask.onStart() already does it, on the
     * path where the task is REALLY starting and the intent actually applies.
     */
    @Override
    protected Goal newGoal(AltoClef mod) {
        return new GoalRunAwayFromHostiles(mod, _distanceToRun);
    }

    /**
     * An escape is not over because it looked over for ONE TICK.
     * <p>
     * The inherited answer is {@code goal.isInGoal(playerPos)}, and this goal
     * ({@link GoalRunAwayFromEntities}) reports "in goal" whenever its entity list comes
     * back EMPTY - a list built from {@code EntityTracker.getHostiles()}, which is rebuilt
     * every tick through {@code EntityHelper.isAngryAtPlayer()}: a line-of-sight raycast
     * plus {@code Mob.isAggressive()}, a data flag that blinks between swings. So a run
     * that was going perfectly declared itself FINISHED about once a second, every time
     * the thing chasing her stepped behind a tree.
     * <p>
     * That is not a cosmetic lie. MobDefenseChain was left holding a finished task, and
     * SingleTaskChain neither clears nor ticks one - it just calls onTaskFinish and does
     * nothing, forever, while the chain keeps winning ticks on priority. Burnt standing
     * completely still with a mob eating her IS this, more often than anything else.
     * <p>
     * So: require the goal to hold for ESCAPE_SETTLE_SECONDS before believing it. A
     * flicker can no longer end an escape, and a genuine escape still ends promptly.
     */
    @Override
    public boolean isFinished(AltoClef mod) {
        if (!super.isFinished(mod)) {
            _wasClear = false;
            return false;
        }
        if (!_wasClear) {
            _wasClear = true;
            _clearFor.reset();
            return false;
        }
        return _clearFor.elapsed();
    }

    @Override
    protected void onStart(AltoClef mod) {
        _wasClear = false;
        super.onStart(mod);
    }

    /**
     * Drop the shared sighting ledger. Called from MobDefenseChain.onStop alongside the
     * cleanup it already does for its own entity-keyed maps.
     * <p>
     * Pruning otherwise only ever happens inside getEntities(), so once no flee task is
     * running these entries are never visited again - and each is a strong reference to
     * an Entity, which holds its Level, which holds that world's chunk cache. The
     * 3-second expiry makes stale entries harmless to READ; it does not make them
     * collectable.
     * <p>
     * Note this is NOT a world-change hook: onStop reaches us only via
     * TaskRunner.disable() (an @stop, or a user task finishing with idle disabled), so a
     * plain disconnect still leaves the ledger populated until the next flee ages it out.
     * That is a bounded leak rather than a behaviour bug - the entries cannot survive
     * into a new world's decisions, because every read prunes anything older than the
     * grace window first.
     */
    public static void forget() {
        synchronized (BaritoneHelper.MINECRAFT_LOCK) {
            _recentHostiles.clear();
        }
    }

    /**
     * Would a flee task actually have something to run from?
     * <p>
     * Answered in the goal's OWN terms - the entity tracker plus the grace ledger - not
     * the loose species scan the defence chain latches on. When those two disagree the
     * chain installs an escape whose goal is already satisfied where she stands, which
     * moves her nowhere and reports finished a moment later, forever. Callers use this to
     * decline instead.
     */
    public static boolean hasSomethingToFleeFrom(AltoClef mod) {
        // getHostiles() OUTSIDE the lock: EntityTracker.updateState() is synchronized on
        // the tracker and THEN takes MINECRAFT_LOCK, so acquiring them in the other order
        // deadlocks the render thread against the pathing thread.
        if (!mod.getEntityTracker().getHostiles().isEmpty()) return true;
        synchronized (BaritoneHelper.MINECRAFT_LOCK) {
            long now = System.nanoTime();
            _recentHostiles.entrySet().removeIf(entry -> !entry.getKey().isAlive()
                    || now - entry.getValue() > HOSTILE_GRACE_NANOS);
            return !_recentHostiles.isEmpty();
        }
    }

    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof RunAwayFromHostilesTask task) {
            return Math.abs(task._distanceToRun - _distanceToRun) < 1;
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        return "NIGERUNDAYOO, SUMOOKEYY!";
    }

    private class GoalRunAwayFromHostiles extends GoalRunAwayFromEntities {

        public GoalRunAwayFromHostiles(AltoClef mod, double distance) {
            super(mod, distance, false, 0.8);
        }

        @Override
        protected List<Entity> getEntities(AltoClef mod) {
            // EntityTracker updates while holding its own monitor and then
            // MINECRAFT_LOCK. Never call it while holding MINECRAFT_LOCK or the
            // pathing thread can deadlock the render thread in the opposite order.
            List<Entity> hostiles = mod.getEntityTracker().getHostiles();
            synchronized (BaritoneHelper.MINECRAFT_LOCK) {
                long now = System.nanoTime();
                for (Entity hostile : hostiles) {
                    // stored UNFILTERED, filtered on the way out. the ledger is shared by
                    // every flee task now, and they do not agree about skeletons - letting
                    // an _includeSkeletons=false run decide what a later true run is
                    // allowed to remember would hide an archer from the task that cares.
                    if (hostile != null && hostile.isAlive()) {
                        _recentHostiles.put(hostile, now);
                    }
                }
                // no clock-went-backwards arm here: System.nanoTime() is monotonic, so
                // unlike the tick-stamped maps in MobDefenseChain (whose counter restarts
                // at zero on a new connection) plain age is always meaningful. what a
                // world change needs is forget(), below.
                _recentHostiles.entrySet().removeIf(entry -> !entry.getKey().isAlive()
                        || now - entry.getValue() > HOSTILE_GRACE_NANOS);
                List<Entity> out = new ArrayList<>();
                for (Entity hostile : _recentHostiles.keySet()) {
                    if (!_includeSkeletons && hostile instanceof AbstractSkeleton) continue;
                    out.add(hostile);
                }
                return out;
            }
        }
    }
}
