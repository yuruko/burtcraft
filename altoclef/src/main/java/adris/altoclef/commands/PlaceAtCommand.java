package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.construction.AcquireAndPlaceBlockTask;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

/** Exact-position placement used by settlement appliance galleries. */
public final class PlaceAtCommand extends Command {
    public PlaceAtCommand() throws CommandException {
        super("place_at", "Places an inventory block at exact coordinates",
            new Arg(Integer.class, "x"), new Arg(Integer.class, "y"), new Arg(Integer.class, "z"),
            new Arg(String.class, "block"));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        BlockPos pos = new BlockPos(parser.get(Integer.class), parser.get(Integer.class), parser.get(Integer.class));
        String name = parser.get(String.class).trim().toLowerCase().replace(' ', '_');
        Identifier id = Identifier.tryParse(name.contains(":") ? name : "minecraft:" + name);
        Block block = id == null ? null : BuiltInRegistries.BLOCK.getValue(id);
        if (block == null || block == Blocks.AIR) throw new CommandException("unknown block: " + name);
        // ...AcquireAndPlace, not PlaceBlockTask: the appliance gallery is fed by a
        // survey that reports which SQUARE is empty, and nothing in that pipeline
        // ever checks she is carrying the thing that goes in it.
        mod.runUserTask(new AcquireAndPlaceBlockTask(block, pos), this::finish);
    }
}
