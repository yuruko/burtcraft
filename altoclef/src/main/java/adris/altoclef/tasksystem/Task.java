package adris.altoclef.tasksystem;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasks.movement.TimeoutWanderTask;

import java.util.List;
import java.util.function.Predicate;

public abstract class Task {

    /**
     * THE TASK TREE HAS A CEILING.
     * <p>
     * a task returns a sub-task and tick() descends straight into it, so ONE
     * tick walks the entire tree and the java stack IS the tree depth. nothing
     * bounded that depth, and `isEqual` does not detect a cycle - it only stops
     * a task re-assigning its OWN sub. so an a -> b -> a loop allocates a fresh
     * instance at every level (each with a null `_sub`, so each one recurses
     * again) and descends until the stack runs out, inside a single tick.
     * <p>
     * on 2026-08-06 that crashed the client five times in three hours:
     * `collecting 5 iron` -> `smelt in blast_furnace` -> the furnace is
     * unreachable so craft one -> a blast furnace costs 5 iron ->
     * `collecting 5 iron`. that particular cycle is fixed in
     * {@link adris.altoclef.tasks.resources.CollectIronIngotTask}, but any
     * future one would take the whole game down mid-stream, so the ceiling is
     * the net rather than the fix. real chains run well under 100 deep - a
     * speedrun's deepest tree is ~40 - so 256 cannot fire on legitimate work.
     * <p>
     * ⚠ it is a DEPTH cap, not an equality check, deliberately: a cycle that
     * runs a -> b -> c -> a is invisible to any ancestor-equality test whose
     * `isEqual` is sloppy (plenty here answer true for any instance of the
     * class), and a depth cap cannot false-positive on one.
     */
    public static final int MAX_DEPTH = 256;

    /**
     * how many task frames deep the current tick is. every tick() decrements in
     * a finally, so it unwinds correctly even when the cycle exception is thrown.
     * <p>
     * ticking is single-threaded (client tick -> TaskRunner -> TaskChain -> Task),
     * so a plain int is enough - but a counter that could ever drift UPWARD would
     * eventually refuse legitimate work, and silently. {@link #resetDepth} makes
     * that unrecoverable state impossible rather than merely unlikely.
     */
    private static int _depth = 0;

    /**
     * called at the top of every chain tick, where the depth is known to be zero.
     * a leak would otherwise accumulate forever and start aborting real chains.
     */
    static void resetDepth() {
        _depth = 0;
    }

    private String _oldDebugState = "";
    private String _debugState = "";

    private Task _sub = null;

    private boolean _first = true;

    private boolean _stopped = false;

    private boolean _active = false;

    public void tick(AltoClef mod, TaskChain parentChain) {
        if (_depth >= MAX_DEPTH) {
            // build the diagnostic BEFORE unwinding - once the exception is
            // thrown the chain list is the only record of what looped, and the
            // tail of it is the cycle repeated over and over.
            throw new TaskCycleException(describeCycle(parentChain, this));
        }
        _depth++;
        try {
            tickInternal(mod, parentChain);
        } finally {
            _depth--;
        }
    }

    /**
     * the deepest slice of the chain, which for a cycle is that cycle written
     * out several times - enough to read the loop straight off the log.
     */
    private static String describeCycle(TaskChain parentChain, Task deepest) {
        StringBuilder sb = new StringBuilder("task tree exceeded ").append(MAX_DEPTH)
                .append(" deep - cyclic. deepest frames:");
        List<Task> chain = parentChain.getTasks();
        int from = Math.max(0, chain.size() - 24);
        for (int i = from; i < chain.size(); i++) {
            sb.append("\n  [").append(i).append("] ").append(chain.get(i));
        }
        sb.append("\n  [about to recurse into] ").append(deepest);
        return sb.toString();
    }

    private void tickInternal(AltoClef mod, TaskChain parentChain) {
        parentChain.addTaskToChain(this);
        if (_first) {
            Debug.logInternal("Task START: " + this);
            _active = true;
            onStart(mod);
            _first = false;
            _stopped = false;
        }
        if (_stopped) return;

        Task newSub = onTick(mod);
        // Debug state print
        if (!_oldDebugState.equals(_debugState)) {
            Debug.logInternal(toString());
            _oldDebugState = _debugState;
        }
        // We have a sub task
        if (newSub != null) {
            if (!newSub.isEqual(_sub)) {
                if (canBeInterrupted(mod, _sub, newSub)) {
                    // Our sub task is new
                    if (_sub != null) {
                        // Our previous sub must be interrupted.
                        _sub.stop(mod, newSub);
                    }

                    _sub = newSub;
                }
            }

            // Run our child
            _sub.tick(mod, parentChain);
        } else {
            // We are null
            if (_sub != null && canBeInterrupted(mod, _sub, null)) {
                // Our previous sub must be interrupted.
                _sub.stop(mod);
                _sub = null;
            }
        }
    }

    public void reset() {
        _first = true;
        _active = false;
        _stopped = false;
    }

    public void stop(AltoClef mod) {
        stop(mod, null);
    }

    /**
     * Stops the task. Next time it's run it will run `onStart`
     */
    public void stop(AltoClef mod, Task interruptTask) {
        if (!_active) return;
        Debug.logInternal("Task STOP: " + this + ", interrupted by " + interruptTask);
        if (!_first) {
            onStop(mod, interruptTask);
        }

        if (_sub != null && !_sub.stopped()) {
            _sub.stop(mod, interruptTask);
        }

        _first = true;
        _active = false;
        _stopped = true;
    }

    /**
     * Lets the task know it's execution has been "suspended"
     * <p>
     * STILL RUNS `onStop`
     * <p>
     * Doesn't stop it all-together (meaning `isActive` still returns true)
     */
    public void interrupt(AltoClef mod, Task interruptTask) {
        if (!_active) return;
        if (!_first) {
            onStop(mod, interruptTask);
        }

        if (_sub != null && !_sub.stopped()) {
            _sub.interrupt(mod, interruptTask);
        }

        _first = true;
    }

    protected void setDebugState(String state) {
        if (state == null) {
            state = "";
        }
        _debugState = state;
    }

    // Virtual
    public boolean isFinished(AltoClef mod) {
        return false;
    }

    public boolean isActive() {
        return _active;
    }

    public boolean stopped() {
        return _stopped;
    }

    protected abstract void onStart(AltoClef mod);

    protected abstract Task onTick(AltoClef mod);

    // interruptTask = null if the task stopped cleanly
    protected abstract void onStop(AltoClef mod, Task interruptTask);

    protected abstract boolean isEqual(Task other);

    protected abstract String toDebugString();

    @Override
    public String toString() {
        return toDebugString().toLowerCase() + ": " + _debugState.toLowerCase();
    }

    @Override
    public boolean equals(Object obj) {
        if (obj instanceof Task task) {
            return isEqual(task);
        }
        return false;
    }

    public boolean thisOrChildSatisfies(Predicate<Task> pred) {
        Task t = this;
        while (t != null) {
            if (pred.test(t)) return true;
            t = t._sub;
        }
        return false;
    }

    public boolean thisOrChildAreTimedOut() {
        return thisOrChildSatisfies(task -> task instanceof TimeoutWanderTask);
    }

    /**
     * Sometimes a task just can NOT be bothered to be interrupted right now.
     * For instance, if we're in mid air and MUST complete the parkour movement.
     */
    private boolean canBeInterrupted(AltoClef mod, Task subTask, Task toInterruptWith) {
        if (subTask == null) return true;
        // Our task can declare that is FORCES itself to be active NOW.
        return (subTask.thisOrChildSatisfies(task -> {
            if (task instanceof ITaskCanForce canForce) {
                return !canForce.shouldForce(mod, toInterruptWith);
            }
            return true;
        }));
    }
}
