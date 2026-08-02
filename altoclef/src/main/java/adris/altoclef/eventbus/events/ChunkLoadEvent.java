package adris.altoclef.eventbus.events;

import net.minecraft.world.level.chunk.LevelChunk;

public class ChunkLoadEvent {
    public LevelChunk chunk;

    public ChunkLoadEvent(LevelChunk chunk) {
        this.chunk = chunk;
    }
}
