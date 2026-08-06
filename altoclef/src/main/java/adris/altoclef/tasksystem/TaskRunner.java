package adris.altoclef.tasksystem;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;

import java.util.ArrayList;

public class TaskRunner {

    private final ArrayList<TaskChain> _chains = new ArrayList<>();
    private final AltoClef _mod;
    private boolean _active;

    private TaskChain _cachedCurrentTaskChain = null;

    public TaskRunner(AltoClef mod) {
        _mod = mod;
        _active = false;
    }

    /**
     * While false, not even the survival chains get a turn.
     *
     * This is the F1 handoff: when the operator takes the keyboard, the bot must be inert,
     * not merely jobless - a defense chain that keeps fighting for the mouse is
     * worse than one that sleeps. Everything else that "stops" her is now just
     * an empty job queue, and reflexes survive it.
     */
    private static volatile boolean _reflexesAllowed = true;

    public static void setReflexesAllowed(boolean allowed) { _reflexesAllowed = allowed; }

    public static boolean reflexesAllowed() { return _reflexesAllowed; }

    /** The reflex chain currently holding her, tracked apart from the job. */
    private TaskChain _cachedIdleChain = null;

    public void tick() {
        if (!AltoClef.inGame()) return;
        if (!_active) {
            tickReflexes();
            return;
        }
        _cachedIdleChain = null;
        // Get highest priority chain and run
        TaskChain maxChain = null;
        float maxPriority = Float.NEGATIVE_INFINITY;
        for (TaskChain chain : _chains) {
            if (!chain.isActive()) continue;
            float priority = chain.getPriority(_mod);
            if (priority > maxPriority) {
                maxPriority = priority;
                maxChain = chain;
            }
        }
        if (_cachedCurrentTaskChain != null && maxChain != _cachedCurrentTaskChain) {
            _cachedCurrentTaskChain.onInterrupt(_mod, maxChain);
        }
        _cachedCurrentTaskChain = maxChain;
        if (maxChain != null) {
            maxChain.tick(_mod);
        }
    }

    /**
     * OFF DUTY IS NOT DEAD.
     *
     * A finished job used to switch the whole bot off - `disable()` stops every
     * chain and `tick()` then returned immediately, so between jobs nothing
     * defended her, nothing ate, nothing pressed respawn. She was a mannequin
     * from the moment a task ended until the next command arrived, however long
     * burnt-side took to think of one, and a spider only needs seven seconds.
     *
     * So the reflexes keep their turn. Only chains that say they survive idling
     * run here, and only the highest-priority one, exactly as when on duty -
     * this is not a second scheduler, it is the same one with the job removed.
     */
    private void tickReflexes() {
        if (!_reflexesAllowed) {
            _cachedIdleChain = null;
            return;
        }
        TaskChain maxChain = null;
        float maxPriority = Float.NEGATIVE_INFINITY;
        for (TaskChain chain : _chains) {
            if (!chain.runsWhileIdle() || !chain.isActive()) continue;
            float priority = chain.getPriority(_mod);
            if (priority > maxPriority) {
                maxPriority = priority;
                maxChain = chain;
            }
        }
        if (_cachedIdleChain != null && maxChain != _cachedIdleChain) {
            _cachedIdleChain.onInterrupt(_mod, maxChain);
        }
        _cachedIdleChain = maxChain;
        if (maxChain != null) maxChain.tick(_mod);
    }

    public void addTaskChain(TaskChain chain) {
        _chains.add(chain);
    }

    public void enable() {
        if (!_active) {
            _mod.getBehaviour().push();
            _mod.getBehaviour().setPauseOnLostFocus(false);
        }
        _active = true;
    }

    public void disable() {
        if (_active) {
            _mod.getBehaviour().pop();
        }
        for (TaskChain chain : _chains) {
            chain.stop(_mod);
        }
        _active = false;

        Debug.logMessage("Stopped");
    }

    /**
     * whether the chains are actually being ticked.
     * <p>
     * this matters far more than it reads: while this is false, tick() returns
     * immediately and NO chain gets a turn - not the food chain, not defense,
     * nothing. anything that pokes a chain from outside the tick (burnt's
     * external control server) has to know whether that poke will ever be read.
     */
    public boolean isActive() {
        return _active;
    }

    public TaskChain getCurrentTaskChain() {
        return _cachedCurrentTaskChain;
    }

    // Kinda jank ngl
    public AltoClef getMod() {
        return _mod;
    }
}
