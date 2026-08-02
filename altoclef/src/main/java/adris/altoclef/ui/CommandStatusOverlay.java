package adris.altoclef.ui;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.MultiBufferSource;
import com.mojang.blaze3d.vertex.PoseStack;
import org.joml.Matrix4f;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.List;

public class CommandStatusOverlay {

    //For the ingame timer
    private long _timeRunning;
    private long _lastTime = 0;
    private DateTimeFormatter DATE_TIME_FORMATTER = DateTimeFormatter.ofPattern("HH:mm:ss.SSS").withZone(ZoneId.from(ZoneOffset.of("+00:00"))); // The date formatter

    public void render(AltoClef mod, PoseStack matrixstack) {
        if (mod.getModSettings().shouldShowTaskChain()) {
            List<Task> tasks = Collections.emptyList();
            if (mod.getTaskRunner().getCurrentTaskChain() != null) {
                tasks = mod.getTaskRunner().getCurrentTaskChain().getTasks();
            }

            int color = 0xFFFFFFFF;
            // 26.1.2's OutlineBufferSource.getBuffer throws for font render types
            // ("can't render an outline for this rendertype!") - draw through the
            // normal buffer source instead
            drawTaskChain(Minecraft.getInstance().font, 0, 0, color, false,
                    matrixstack.last().pose(),
                    Minecraft.getInstance().renderBuffers().bufferSource(),
                    Font.DisplayMode.NORMAL, 0, 255, 10, tasks, mod);
        }
    }

    private void drawTaskChain(Font renderer, float x, float y, int color, boolean shadow, Matrix4f matrix, MultiBufferSource vertexConsumers, Font.DisplayMode layerType, int backgroundColor, int light, int maxLines, List<Task> tasks, AltoClef mod) {
        if (tasks.size() == 0) {
            renderer.drawInBatch(" (no task running) ", x, y, color, shadow, matrix, vertexConsumers, layerType, backgroundColor, light);
            if (_lastTime + 10000 < Instant.now().toEpochMilli() && mod.getModSettings().shouldShowTimer()) {//if it doesn't run any task in 10 secs
                _timeRunning = Instant.now().toEpochMilli();//reset the timer
            }
        } else {
            float fontHeight = renderer.lineHeight;
            if (mod.getModSettings().shouldShowTimer()) { //If it's enabled
                _lastTime = Instant.now().toEpochMilli(); //keep the last time for the timer reset
                String _realTime = DATE_TIME_FORMATTER.format(Instant.now().minusMillis(_timeRunning)); //Format the running time to string
                renderer.drawInBatch("<" + _realTime + ">", x, y, color, shadow, matrix, vertexConsumers, layerType, backgroundColor, light);
                x += 8;//Do the same thing to list the tasks
                y += fontHeight + 2;
            }
            if (tasks.size() > maxLines) {
                for (int i = 0; i < tasks.size(); ++i) {
                    // Skip over the next tasks
                    if (i == 0 || i > tasks.size() - maxLines) {
                        renderer.drawInBatch(tasks.get(i).toString(), x, y, color, shadow, matrix, vertexConsumers, layerType, backgroundColor, light);
                    } else if (i == 1) {
                        renderer.drawInBatch(" ... ", x, y, color, shadow, matrix, vertexConsumers, layerType, backgroundColor, light);
                    } else {
                        continue;
                    }
                    x += 8;
                    y += fontHeight + 2;
                }
            } else {
                if (!tasks.isEmpty()) {
                    for (Task task : tasks) {
                        renderer.drawInBatch(task.toString(), x, y, color, shadow, matrix, vertexConsumers, layerType, backgroundColor, light);
                        x += 8;
                        y += fontHeight + 2;
                    }
                }
            }

        }
    }
}
