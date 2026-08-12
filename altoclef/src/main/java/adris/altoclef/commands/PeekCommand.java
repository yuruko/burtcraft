package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.container.PeekContainerTask;
import net.minecraft.core.BlockPos;

/**
 * Re-reads one container. The only way to seed or refresh what the bot knows
 * about a chest's contents - see {@link PeekContainerTask}.
 */
public final class PeekCommand extends Command {
    public PeekCommand() throws CommandException {
        super("peek", "Opens a container just to read what's inside it, taking nothing",
            new Arg(Integer.class, "x"), new Arg(Integer.class, "y"), new Arg(Integer.class, "z"));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        try {
            BlockPos pos = new BlockPos(parser.get(Integer.class), parser.get(Integer.class), parser.get(Integer.class));
            mod.runUserTask(new PeekContainerTask(pos), this::finish);
        } catch (IllegalArgumentException ex) {
            // an out-of-range coordinate throws unchecked; the caller only ever
            // sees CommandException, so a raw one would surface as a crash
            // rather than as "you gave me a bad number".
            throw new CommandException("bad peek coordinates: " + ex.getMessage());
        }
    }
}
