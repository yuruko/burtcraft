package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.construction.FarmBuildTask;
import net.minecraft.core.BlockPos;

/** Make a wheat field, or grow one that is already there. */
public final class FarmCommand extends Command {
    public FarmCommand() throws CommandException {
        super("farm", "Builds a wheat field, or expands an existing one",
            new Arg(String.class, "create/expand"),
            // THE COORDINATES COME AS A SET. An arg uses its default when the
            // number supplied is at or below its threshold, so x/y/z fall back
            // to where she is standing on a bare `@farm create`, and radius
            // falls back on anything up to `@farm create x y z`.
            new Arg(Integer.class, "x", null, 1),
            new Arg(Integer.class, "y", null, 1),
            new Arg(Integer.class, "z", null, 1),
            new Arg(Integer.class, "radius", 4, 4));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        String role = parser.get(String.class).trim().toLowerCase();
        Integer x = parser.get(Integer.class);
        Integer y = parser.get(Integer.class);
        Integer z = parser.get(Integer.class);
        int radius = parser.get(Integer.class);
        if (mod.getPlayer() == null && (x == null || y == null || z == null)) {
            throw new CommandException("not in a world, so there is no 'here' to farm");
        }
        BlockPos here = mod.getPlayer() == null ? BlockPos.ZERO : mod.getPlayer().blockPosition();
        BlockPos center = new BlockPos(
            x == null ? here.getX() : x,
            y == null ? here.getY() : y,
            z == null ? here.getZ() : z);
        try {
            FarmBuildTask.Mode mode = switch (role) {
                case "create" -> FarmBuildTask.Mode.CREATE;
                case "expand" -> FarmBuildTask.Mode.EXPAND;
                default -> throw new IllegalArgumentException("mode must be create or expand");
            };
            mod.runUserTask(new FarmBuildTask(center, radius, mode), this::finish);
        } catch (IllegalArgumentException ex) {
            throw new CommandException(ex.getMessage());
        }
    }
}
