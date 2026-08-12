package adris.altoclef.eventbus.events;

import adris.altoclef.tasksystem.Task;

public class TaskFinishedEvent {
    public double durationSeconds;
    public Task lastTaskRan;

    /**
     * null when the task really finished; a reason string when it was torn down.
     * <p>
     * a task killed from outside still publishes this event, so without a reason
     * an abort is indistinguishable from a success and host-side re-issues the
     * exact command that just failed to terminate.
     */
    public String abortReason;

    public TaskFinishedEvent(double durationSeconds, Task lastTaskRan) {
        this(durationSeconds, lastTaskRan, null);
    }

    public TaskFinishedEvent(double durationSeconds, Task lastTaskRan, String abortReason) {
        this.durationSeconds = durationSeconds;
        this.lastTaskRan = lastTaskRan;
        this.abortReason = abortReason;
    }
}
