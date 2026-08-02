package adris.altoclef.tasks.misc;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import net.minecraft.client.player.LocalPlayer;

/**
 * eat what she is already carrying, right now.
 * <p>
 * this task deliberately does nothing on tick. the eating itself lives in
 * {@link adris.altoclef.chains.FoodChain#getPriority}, which the task runner
 * only calls while it is ENABLED - and the runner is disabled the moment no
 * user task is running. so asking the food chain to eat while burnt was idle
 * set a flag that nothing ever read: she announced a meal and starved in place
 * with "eat" on screen. being a user task is the whole point - it is what keeps
 * the runner on long enough for the food chain to get its ticks.
 * <p>
 * it always ends: on a full bar, on the bar moving, on the eat finishing, or on
 * a timeout. an eat with no exit condition would just be the same hang wearing
 * a different name.
 */
public class EatNowTask extends Task {
    private static final long TIMEOUT_MS = 12_000;

    private long _startedAt;
    private int _startFood = -1;
    private boolean _startedFull;
    private boolean _sawEating;
    private boolean _barMoved;

    @Override
    protected void onStart(AltoClef mod) {
        _startedAt = System.currentTimeMillis();
        _startFood = foodLevel(mod);
        _startedFull = _startFood >= 20;
        _sawEating = false;
        _barMoved = false;
        mod.getFoodChain().requestEat(mod);
        setDebugState("eating what i'm carrying");
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getFoodChain().isTryingToEat()) _sawEating = true;
        if (foodLevel(mod) > _startFood) _barMoved = true;
        return null;
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        if (_startedFull || _barMoved) return true;
        int food = foodLevel(mod);
        if (food >= 20 || food > _startFood) return true;
        // the eat started and then ended - either it landed or something took
        // the mouse away. either way this task has nothing left to wait for.
        if (_sawEating && !mod.getFoodChain().isTryingToEat()) return true;
        return System.currentTimeMillis() - _startedAt > TIMEOUT_MS;
    }

    /**
     * did food actually go down? the hunger bar moving is the only honest
     * answer - the eat animation playing is not, and reporting "ate" off the
     * animation is exactly the lie that hid the original bug.
     */
    public boolean ate() {
        return _barMoved || _startedFull;
    }

    private int foodLevel(AltoClef mod) {
        LocalPlayer player = mod.getPlayer();
        return player == null ? -1 : player.getFoodData().getFoodLevel();
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        // nothing to release: the food chain owns the click it is holding
    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof EatNowTask;
    }

    @Override
    protected String toDebugString() {
        return "eating";
    }
}
