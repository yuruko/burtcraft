package adris.altoclef.tasksystem;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;

import java.util.ArrayList;
import java.util.List;

public abstract class TaskChain {

    /**
     * Does this chain still get a turn while the runner is OFF DUTY?
     *
     * When a user task finishes, {@link TaskRunner#disable()} used to end every
     * chain's turn until the next command arrived - so between jobs she had no
     * defense, no eating, no MLG, and no death screen handler. On 2026-08-05 a
     * task finished at 10:45:37, a spider killed her at 10:45:44, and she lay on
     * the death screen until 10:46:12 because nothing was ticking to press
     * respawn. Thirty-five seconds of a motionless bot on stream, and none of it
     * was a decision.
     *
     * Reflexes are not a job. Anything that keeps her ALIVE returns true here;
     * anything that decides what to DO stays false, so an idle bot still does
     * nothing on purpose - it just does not die of it.
     */
    public boolean runsWhileIdle() { return false; }

    private final List<Task> _cachedTaskChain = new ArrayList<>();

    public TaskChain(TaskRunner runner) {
        runner.addTaskChain(this);
    }

    public void tick(AltoClef mod) {
        _cachedTaskChain.clear();
        // the tree starts here, so the frame counter starts at zero here too.
        Task.resetDepth();
        try {
            onTick(mod);
        } catch (TaskCycleException e) {
            // a cyclic task tree is not a task that failed, it is a job that can
            // never terminate. log the loop and drop the whole chain - host-side
            // hears the abort and picks something else, which is strictly better
            // than the client dying on stream.
            Debug.logError("[cycle] chain '" + getName() + "': " + e.getMessage());
            onCycleDetected(mod);
        }
    }

    /**
     * how this chain gets out of a cyclic tree. the default drops the work.
     * a chain that owes somebody an answer (see UserTaskChain) overrides this
     * so the abort is REPORTED rather than just happening.
     */
    protected void onCycleDetected(AltoClef mod) {
        stop(mod);
    }

    public void stop(AltoClef mod) {
        _cachedTaskChain.clear();
        onStop(mod);
    }

    protected abstract void onStop(AltoClef mod);

    public abstract void onInterrupt(AltoClef mod, TaskChain other);

    protected abstract void onTick(AltoClef mod);

    public abstract float getPriority(AltoClef mod);

    public abstract boolean isActive();

    public abstract String getName();

    public List<Task> getTasks() {
        return _cachedTaskChain;
    }

    void addTaskToChain(Task task) {
        _cachedTaskChain.add(task);
    }

    public String toString() {
        return getName();
    }

}
