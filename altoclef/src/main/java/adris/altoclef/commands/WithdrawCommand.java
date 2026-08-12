package adris.altoclef.commands;

import adris.altoclef.AltoClef;
import adris.altoclef.commandsystem.Arg;
import adris.altoclef.commandsystem.ArgParser;
import adris.altoclef.commandsystem.Command;
import adris.altoclef.commandsystem.CommandException;
import adris.altoclef.tasks.container.PickupFromContainerTask;
import adris.altoclef.trackers.storage.ContainerCache;
import adris.altoclef.util.ItemTarget;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

import java.util.Optional;

/**
 * Takes items back OUT of a container. The pantry used to be a one-way door:
 * `@deposit` and `@stash` put things in, and nothing anywhere in altoclef, the
 * bridge or the companion took anything back out on request - which is exactly
 * why stored food was unreachable and she kept farming past a full chest.
 * <p>
 * this is deliberately NOT `@get`. ResourceTask does already check containers
 * (see its getContainersWithItem branch), but it may equally decide to mine,
 * craft or hunt instead - and "get me my bread out of the chest" is a different
 * request from "obtain bread by any means". when no container we know of holds
 * the item, this fails loudly rather than quietly turning into an expedition.
 */
public final class WithdrawCommand extends Command {

    public WithdrawCommand() throws CommandException {
        super("withdraw", "Takes <count> MORE of an item out of the nearest known container that has it",
            new Arg(String.class, "item"), new Arg(Integer.class, "count", 1, 1));
    }

    @Override
    protected void call(AltoClef mod, ArgParser parser) throws CommandException {
        String name = parser.get(String.class).trim().toLowerCase().replace(' ', '_');
        int count = parser.get(Integer.class);
        if (count <= 0) throw new CommandException("withdraw count must be at least 1, got " + count);

        // resolved straight off the item registry rather than through
        // TaskCatalogue: the catalogue only holds OBTAINABLE resources, and a
        // chest can hold anything at all. asking it about rooted_dirt throws.
        Identifier id = Identifier.tryParse(name.contains(":") ? name : "minecraft:" + name);
        Item item = id == null ? null : BuiltInRegistries.ITEM.getValue(id);
        if (item == null || item == Items.AIR) throw new CommandException("unknown item: " + name);

        if (mod.getPlayer() == null) throw new CommandException("not in a world");
        Vec3 origin = mod.getPlayer().position();
        Optional<ContainerCache> found = mod.getItemStorage().getClosestContainerWithItem(origin, item);
        if (found.isEmpty()) {
            // FAIL HONESTLY. no silent fallback to mining or crafting - if she
            // says "i'll grab it from the chest" and there is no such chest, the
            // answer is no, not a twenty minute expedition.
            throw new CommandException("no container i know of has " + name + " in it"
                + " (i only know what i've had open - try @peek x y z on the chest first)");
        }
        ContainerCache cache = found.get();

        // ⚠ PickupFromContainerTask's isFinished is a HOLD TARGET (do i now carry
        // N?), not a batch. "withdraw 20" means take twenty MORE, so the target
        // it gets is what she carries now PLUS what she asked for - otherwise
        // asking for fewer than she already holds finishes instantly having done
        // nothing, which is the exact shape of the bread treadmill.
        int held = mod.getItemStorage().getItemCountInventoryOnly(item);
        // ⚠ AND CLAMPED TO WHAT THE CHEST ACTUALLY HAS. the pickup task has no
        // give-up: ask for more than is in there and it empties the chest, then
        // loops on "No valid items detected" forever. the cache can still be
        // STALE (it is only refreshed while the screen is open), so @peek the
        // chest first when the numbers matter.
        int available = cache.getItemCount(item);
        int take = Math.min(count, available);
        if (take <= 0) throw new CommandException("the container at "
            + cache.getBlockPos().toShortString() + " has no " + name + " in it anymore");

        mod.log("Withdrawing " + take + " " + name + " from " + cache.getBlockPos().toShortString()
            + " (it has " + available + ")");
        mod.runUserTask(new PickupFromContainerTask(cache.getBlockPos(), new ItemTarget(item, held + take)), this::finish);
    }
}
