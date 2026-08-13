package adris.altoclef.chains;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.TaskFinishedEvent;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.tasksystem.TaskRunner;
import adris.altoclef.util.time.Stopwatch;

// A task chain that runs a user defined task at the same priority.
// This basically replaces our old Task Runner.
@SuppressWarnings("ALL")
public class UserTaskChain extends SingleTaskChain {

    private final Stopwatch _taskStopwatch = new Stopwatch();
    private Runnable _currentOnFinish = null;

    /** set for the duration of a forced teardown, read once by onTaskFinish. */
    private String _abortReason = null;

    /**
     * WHAT was cancelled, captured before the teardown throws it away.
     *
     * `cancel()` calls `stop(mod)` first, and SingleTaskChain.onStop nulls
     * `_mainTask` - so by the time `onTaskFinish` reads it at the `oldTask` line it
     * is ALREADY null, and `TaskFinishedEvent.lastTaskRan` goes out as null on every
     * cancel path (cyclic tree, F1 takeover, bridge disconnect, ctrl-K, @stop).
     * host-side that is serialized with String.valueOf, so the wire carried the
     * literal string "null" as the task name - which is how 38 rows of one host's
     * journal came to be labelled "null". the abort REASON survived, so the
     * done-vs-gave-up half of the contract held; only the identity was lost.
     */
    private Task _cancelledTask = null;

    private boolean _runningIdleTask;
    private boolean _nextTaskIdleFlag;

    public UserTaskChain(TaskRunner runner) {
        super(runner);
    }

    private static String prettyPrintTimeDuration(double seconds) {
        int minutes = (int) (seconds / 60);
        int hours = minutes / 60;
        int days = hours / 24;

        String result = "";
        if (days != 0) {
            result += days + " days ";
        }
        if (hours != 0) {
            result += (hours % 24) + " hours ";
        }
        if (minutes != 0) {
            result += (minutes % 60) + " minutes ";
        }
        if (!result.equals("")) {
            result += "and ";
        }
        result += String.format("%.3f", (seconds % 60));
        return result;
    }

    @Override
    protected void onTick(AltoClef mod) {

        // Pause if we're not loaded into a world.
        if (!mod.inGame()) return;

        super.onTick(mod);
    }

    public void cancel(AltoClef mod) {
        if (_mainTask != null && _mainTask.isActive()) {
            // remember it before stop() clears it - see _cancelledTask.
            _cancelledTask = _mainTask;
            stop(mod);
            onTaskFinish(mod);
        }
    }

    /**
     * a cyclic tree owes host-side an answer, and "nothing further happened" is
     * the wrong one - she reads a silent teardown as a job well done and
     * re-issues the exact command that could not terminate.
     */
    @Override
    protected void onCycleDetected(AltoClef mod) {
        cancelWith(mod, "cyclic task tree");
    }

    /**
     * CANCEL AND SAY WHY, so the thing that reads the outcome can tell "done" from
     * "gave up".
     *
     * `onTaskFinish` runs the command's own `onFinish` callback BEFORE it publishes
     * `TaskFinishedEvent`, and the host-side bridge only ever reads that callback's
     * frame - so a cancellation reported a plain `finished`, i.e. SUCCESS. She closed
     * the goal, said she had done the job, and nothing retried. Three paths did this:
     * a cyclic task tree, an F1 takeover mid-task, and a bridge disconnect.
     *
     * Setting the reason before cancelling means the callback can see it. It is
     * cleared on the way out of `onTaskFinish` so it can never leak onto the next
     * task's completion.
     */
    public void cancelWith(AltoClef mod, String reason) {
        _abortReason = reason;
        cancel(mod);
        // cancel() no-ops when no task is active; don't let the reason sit around
        // waiting for whatever finishes next.
        _abortReason = null;
    }

    /**
     * Why the task that is finishing RIGHT NOW was cut short, or null if it simply
     * finished. Only meaningful from inside the finish callback.
     */
    public String getAbortReason() {
        return _abortReason;
    }

    @Override
    public float getPriority(AltoClef mod) {
        return 50;
    }

    @Override
    public String getName() {
        return "User Tasks";
    }

    public void runTask(AltoClef mod, Task task, Runnable onFinish) {
        _runningIdleTask = _nextTaskIdleFlag;
        _nextTaskIdleFlag = false;

        _currentOnFinish = onFinish;

        if (!_runningIdleTask) {
            Debug.logMessage("User Task Set: " + task.toString());
        }
        mod.getTaskRunner().enable();
        _taskStopwatch.begin();
        setTask(task);

        if (mod.getModSettings().failedToLoad()) {
            Debug.logWarning("Settings file failed to load at some point. Check logs for more info, or delete the" +
                    " file to re-load working settings.");
        }
    }

    @Override
    protected void onTaskFinish(AltoClef mod) {
        boolean shouldIdle = mod.getModSettings().shouldRunIdleCommandWhenNotActive();
        if (!shouldIdle) {
            // Stop.
            mod.getTaskRunner().disable();
            // Extra reset. Sometimes baritone is laggy and doesn't properly reset our press
            mod.getClientBaritone().getInputOverrideHandler().clearAllKeys();
        }
        double seconds = _taskStopwatch.time();
        // on a normal finish _mainTask is still set; on a cancel it was nulled by
        // stop() before we got here, so fall back to what cancel() put aside.
        Task oldTask = _mainTask != null ? _mainTask : _cancelledTask;
        _cancelledTask = null;
        _mainTask = null;
        if (_currentOnFinish != null) {
            //noinspection unchecked
            _currentOnFinish.run();
        }
        // our `onFinish` might have triggered more tasks.
        boolean actuallyDone = _mainTask == null;
        if (actuallyDone) {
            if (!_runningIdleTask) {
                Debug.logMessage("User task FINISHED. Took %s seconds.", prettyPrintTimeDuration(seconds));
                EventBus.publish(new TaskFinishedEvent(seconds, oldTask, _abortReason));
            }
            if (shouldIdle) {
                AltoClef.getCommandExecutor().executeWithPrefix(mod.getModSettings().getIdleCommand());
                signalNextTaskToBeIdleTask();
                _runningIdleTask = true;
            }
        }
    }

    public boolean isRunningIdleTask() {
        return isActive() && _runningIdleTask;
    }

    // The next task will be an idle task.
    public void signalNextTaskToBeIdleTask() {
        _nextTaskIdleFlag = true;
    }
}
