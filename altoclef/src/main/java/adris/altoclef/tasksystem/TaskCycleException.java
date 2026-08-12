package adris.altoclef.tasksystem;

/**
 * thrown when the task tree gets deeper than {@link Task#MAX_DEPTH}.
 *
 * this is never a "task failed" - it means the tree is cyclic and would have
 * descended forever. it unwinds to {@link TaskChain#tick} which kills the chain
 * rather than letting the stack run out and take the client with it.
 */
public class TaskCycleException extends RuntimeException {
    public TaskCycleException(String message) {
        // no stack trace: the trace of a cycle is 256 identical frames and
        // writing it is what actually blew the stack last time.
        super(message, null, false, false);
    }
}
