package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.construction.ToasterBuildTask;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterHomestead;
import adris.altoclef.tasks.construction.settlement.ToasterOutpost;
import net.minecraft.core.BlockPos;

/** Build/repair a Burnt-style toaster settlement at a durable anchor. */
public final class ToasterBuildCommand extends Command {
    public ToasterBuildCommand() throws CommandException {
        super("toaster_build", "Builds a smooth-stone toaster homestead or outpost",
            new Arg(String.class, "homestead/outpost"),
            new Arg(Integer.class, "x"), new Arg(Integer.class, "y"), new Arg(Integer.class, "z"),
            new Arg(Integer.class, "width"), new Arg(Integer.class, "depth"), new Arg(Integer.class, "height"));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        String role = parser.get(String.class).trim().toLowerCase();
        BlockPos anchor = new BlockPos(parser.get(Integer.class), parser.get(Integer.class), parser.get(Integer.class));
        int width = parser.get(Integer.class);
        int depth = parser.get(Integer.class);
        int height = parser.get(Integer.class);
        try {
            Settlement settlement = switch (role) {
                case "homestead" -> new ToasterHomestead("the homestead", anchor, width, depth, height);
                case "outpost" -> new ToasterOutpost("toaster outpost", anchor, width, depth, height);
                default -> throw new IllegalArgumentException("role must be homestead or outpost");
            };
            mod.runUserTask(new ToasterBuildTask(settlement), this::finish);
        } catch (IllegalArgumentException ex) {
            throw new CommandException(ex.getMessage());
        }
    }
}
