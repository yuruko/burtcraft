package adris.altoclef.eventbus.events;

import net.minecraft.world.phys.BlockHitResult;

public class BlockInteractEvent {
    public BlockHitResult hitResult;

    public BlockInteractEvent(BlockHitResult hitResult) {
        this.hitResult = hitResult;
    }
}
