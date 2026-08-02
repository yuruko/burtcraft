package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.ChunkLoadEvent;
import adris.altoclef.eventbus.events.ChunkUnloadEvent;
import net.minecraft.client.multiplayer.ClientChunkCache;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.game.ClientboundLevelChunkPacketData;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.function.Consumer;

@Mixin(ClientChunkCache.class)
public class LoadChunkMixin {

    /**
     * Loads a chunk from a packet and executes necessary actions.
     *
     * @param x        The x-coordinate of the chunk.
     * @param z        The z-coordinate of the chunk.
     * @param buf      The packet containing the chunk data.
     * @param heightmaps The chunk's packed heightmaps.
     * @param consumer A consumer for visiting block entities in the chunk.
     * @param ci       The callback info returnable object.
     */
    @Inject(
            method = "replaceWithPacketData",
            at = @At("RETURN")
    )
    private void onLoadChunk(int x, int z, FriendlyByteBuf buf, java.util.Map<Heightmap.Types, long[]> heightmaps, Consumer<ClientboundLevelChunkPacketData.BlockEntityTagOutput> consumer, CallbackInfoReturnable<LevelChunk> ci) {
        // Publish a ChunkLoadEvent with the return value of the method as the argument
        EventBus.publish(new ChunkLoadEvent(ci.getReturnValue()));
    }

    /**
     * Publishes a ChunkUnloadEvent when a chunk is unloaded.
     *
     * @param pos The position of the unloaded chunk.
     * @param ci  The callback info object.
     */
    @Inject(
            method = "drop",
            at = @At("TAIL")
    )
    private void onChunkUnload(ChunkPos pos, CallbackInfo ci) {
        EventBus.publish(new ChunkUnloadEvent(pos));
    }
}
