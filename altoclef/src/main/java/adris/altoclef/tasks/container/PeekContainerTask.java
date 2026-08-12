package adris.altoclef.tasks.container;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.trackers.storage.ContainerCache;
import adris.altoclef.trackers.storage.ContainerType;
import adris.altoclef.util.helpers.StorageHelper;
import net.minecraft.core.BlockPos;

import java.util.Objects;
import java.util.Optional;

/**
 * Walks to a container, opens it, and takes NOTHING.
 * <p>
 * every other opener in this package transfers items, so there was no way to
 * merely LOOK at a chest - and looking is the only thing that refreshes
 * {@link adris.altoclef.trackers.storage.ContainerSubTracker}'s cache, because
 * it snapshots the open menu on the client tick and has no other source. so a
 * chest she has never opened is invisible, and one she opened this morning
 * reports this morning's contents. this is the seed and the refresh.
 * <p>
 * opening IS the whole job: ContainerSubTracker.onServerTick writes the tallies
 * while the screen is up, before this task's subtask ever runs.
 */
public class PeekContainerTask extends AbstractDoToStorageContainerTask {

    private final BlockPos _target;
    private boolean _peeked = false;
    private boolean _notAContainer = false;

    public PeekContainerTask(BlockPos target) {
        _target = target;
    }

    @Override
    protected Optional<BlockPos> getContainerTarget() {
        return Optional.of(_target);
    }

    @Override
    protected Task onTick(AltoClef mod) {
        // FAIL HONESTLY INSTEAD OF CLICKING A ROCK FOREVER. the parent walks back
        // to the target and re-clicks it every tick until a container screen
        // opens, and the caller may hand us any coordinate at all. only judge the
        // block once its chunk is actually loaded - an unloaded chunk means
        // "cannot tell yet", never "not a container".
        if (!_peeked && !_notAContainer && mod.getChunkTracker().isChunkLoaded(_target)) {
            ContainerType actual = ContainerType.getFromBlock(mod.getWorld().getBlockState(_target).getBlock());
            if (actual == ContainerType.EMPTY) {
                mod.logWarning("Nothing to peek into at " + _target.toShortString() + " - that isn't a container.");
                _notAContainer = true;
                setDebugState("Not a container");
                return null;
            }
        }
        return super.onTick(mod);
    }

    @Override
    protected Task onContainerOpenSubtask(AltoClef mod, ContainerCache containerCache) {
        // read-only by construction: no slot clicks, no subtask.
        _peeked = true;
        setDebugState("Read " + containerCache.getItemCounts().size() + " item types");
        return null;
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return _peeked || _notAContainer;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        super.onStop(mod, interruptTask);
        // AN OPEN SCREEN BLOCKS MOVEMENT. we opened it purely to read it, so
        // nobody else is holding the responsibility to shut it again.
        StorageHelper.closeScreen();
    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof PeekContainerTask task && Objects.equals(_target, task._target);
    }

    @Override
    protected String toDebugString() {
        return "Peeking into container at " + _target.toShortString();
    }
}
