package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.construction.AcquireAndPlaceBlockTask;
import adris.altoclef.tasks.misc.PlaceBedAndSetSpawnTask;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

/**
 * burnt fork: place a block from the inventory somewhere nearby.
 * <p>
 * exists for the homestead loop - she collects heat appliances (furnaces,
 * smokers, campfires) and furniture (chests) and PLACES them at her home
 * instead of hoarding them in the inventory. "@place bed" is special: it runs
 * the real bed task so her spawn point moves home too.
 */
public class PlaceCommand extends Command {
    public PlaceCommand() throws CommandException {
        super("place", "Places a block from the inventory nearby (bed also sets spawn)", new Arg(String.class, "block"));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        String name = parser.get(String.class);
        if (name == null || name.trim().isEmpty()) {
            throw new CommandException("place needs a block name, e.g. @place campfire");
        }
        String cleaned = name.trim().toLowerCase().replace(' ', '_');

        // bed placement is its own task: it also sets the respawn point, which
        // is the entire point of putting a bed in the homestead
        if (cleaned.equals("bed") || cleaned.endsWith("_bed")) {
            mod.runUserTask(new PlaceBedAndSetSpawnTask(), this::finish);
            return;
        }

        Identifier id = Identifier.tryParse(cleaned.contains(":") ? cleaned : "minecraft:" + cleaned);
        Block block = id == null ? null : BuiltInRegistries.BLOCK.getValue(id);
        if (block == null || block == Blocks.AIR) {
            throw new CommandException("unknown block: " + cleaned);
        }
        // "she COLLECTS heat appliances and places them" (above) was only ever half
        // true - the collecting had no step. same hole as @place_at.
        mod.runUserTask(new AcquireAndPlaceBlockTask(block), this::finish);
    }
}
