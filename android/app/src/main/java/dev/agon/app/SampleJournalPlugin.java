package dev.agon.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Durable per-recording sample journal (MZY-294). About a minute after
 * screen-off the WebView pauses the hidden page and IndexedDB writes queue in
 * memory, so a process death loses every sample since (MZY-273). Calls INTO a
 * plugin still run promptly from a plugin callback (MZY-294 spike), so
 * lib/liveRecordingDb.ts writes each sample here, synchronously, as well:
 * one JSON line {"s": store, "d": sample} appended to an app-private file per
 * recording. lib/sampleJournal.ts replays the lines IndexedDB is missing and
 * clears the file once the recording is flushed or discarded.
 *
 * The pattern (each sample persisted inside the app process as it arrives) is
 * OpenTracks' (Apache-2.0, TrackRecordingManager.insertTrackPoint) and
 * FitoTrack's (GPL-3.0, idea only); no code is copied — see CREDITS.md.
 *
 * write() without fsync: a force-stop or OS kill keeps what is in the page
 * cache; only a kernel crash or power loss could lose the last lines.
 */
@CapacitorPlugin(name = "AgonJournal")
public class SampleJournalPlugin extends Plugin {

    /** Recording ids are client UUIDs; anything else could escape the dir. */
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9-]{1,64}");
    /** One read() returns at most this much, cut at a line end. */
    private static final int CHUNK_BYTES = 512 * 1024;

    private File dir() {
        File d = new File(getContext().getFilesDir(), "recording-journal");
        d.mkdirs();
        return d;
    }

    private File fileOf(PluginCall call) {
        String id = call.getString("recordingId");
        if (id == null || !ID.matcher(id).matches()) {
            call.reject("invalid recordingId");
            return null;
        }
        return new File(dir(), id + ".jsonl");
    }

    @PluginMethod
    public synchronized void append(PluginCall call) {
        File f = fileOf(call);
        if (f == null) return;
        String store = call.getString("store");
        JSObject sample = call.getObject("sample");
        if (store == null || sample == null) {
            call.reject("store and sample are required");
            return;
        }
        String line = "{\"s\":" + JSONObject.quote(store) + ",\"d\":" + sample + "}\n";
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            call.reject("journal append failed", e);
            return;
        }
        call.resolve();
    }

    /** Up to CHUNK_BYTES of whole lines from byte `offset`; `next` = -1 at the end. */
    @PluginMethod
    public synchronized void read(PluginCall call) {
        File f = fileOf(call);
        if (f == null) return;
        Integer offset = call.getInt("offset", 0);
        JSObject result = new JSObject();
        if (!f.exists() || offset == null || offset >= f.length()) {
            result.put("text", "");
            result.put("next", -1);
            call.resolve(result);
            return;
        }
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long remaining = raf.length() - offset;
            byte[] buf = new byte[(int) Math.min(CHUNK_BYTES, remaining)];
            raf.seek(offset);
            raf.readFully(buf);
            int end = buf.length;
            boolean last = remaining <= CHUNK_BYTES;
            if (!last) {
                // Stop after the last complete line; the rest comes next call.
                while (end > 0 && buf[end - 1] != '\n') end--;
                if (end == 0) end = buf.length; // one giant line: pass it on
            }
            result.put("text", new String(buf, 0, end, StandardCharsets.UTF_8));
            result.put("next", last ? -1 : offset + end);
        } catch (Exception e) {
            call.reject("journal read failed", e);
            return;
        }
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void clear(PluginCall call) {
        File f = fileOf(call);
        if (f == null) return;
        if (f.exists() && !f.delete()) {
            call.reject("journal clear failed");
            return;
        }
        call.resolve();
    }

    /** Recording ids that still have a journal (e.g. a header IndexedDB lost). */
    @PluginMethod
    public synchronized void list(PluginCall call) {
        JSArray ids = new JSArray();
        File[] files = dir().listFiles();
        if (files != null) {
            for (File f : files) {
                String name = f.getName();
                if (name.endsWith(".jsonl")) ids.put(name.substring(0, name.length() - 6));
            }
        }
        JSObject result = new JSObject();
        result.put("recordingIds", ids);
        call.resolve(result);
    }
}
