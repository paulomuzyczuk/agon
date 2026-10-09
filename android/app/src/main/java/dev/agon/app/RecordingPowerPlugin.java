package dev.agon.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps a recording's CPU awake with the screen off (MZY-280), called from
 * lib/recordingPower.ts:
 *  - a PARTIAL_WAKE_LOCK held from Start to Stop, as OpenTracks does for the
 *    whole recording (Apache-2.0, util/SystemUtils.java; pattern only, no
 *    code copied), with a timeout cap so a lost Stop can't drain the
 *    battery — FitoTrack's idea (GPL-3.0, idea only) of acquire(4 h),
 *    raised here to 8 h for long rides;
 *  - the one-time battery-optimisation exemption request, as OsmAnd asks
 *    for it (BatteryOptimizationController, GPL-3.0, idea only).
 * See CREDITS.md. The process dying releases the lock with it.
 */
@CapacitorPlugin(name = "AgonRecordingPower")
public class RecordingPowerPlugin extends Plugin {

    private static final long MAX_HOLD_MS = 8L * 60 * 60 * 1000;
    private PowerManager.WakeLock wakeLock;

    private PowerManager power() {
        return (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    }

    @PluginMethod
    public synchronized void acquireWakeLock(PluginCall call) {
        if (wakeLock == null) {
            wakeLock = power().newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agon:recording");
            wakeLock.setReferenceCounted(false);
        }
        // Re-acquiring restarts the cap; non-counted, so one release frees it.
        wakeLock.acquire(MAX_HOLD_MS);
        call.resolve();
    }

    @PluginMethod
    public synchronized void releaseWakeLock(PluginCall call) {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        call.resolve();
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ignoring", power().isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(result);
    }

    /** Shows Android's own "Let Agon always run in background?" dialog. */
    @SuppressLint("BatteryLife") // sideloaded APK — Play's policy on this permission doesn't apply
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        String pkg = getContext().getPackageName();
        if (power().isIgnoringBatteryOptimizations(pkg)) {
            isIgnoringBatteryOptimizations(call);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + pkg));
        startActivityForResult(call, intent, "onBatteryResult");
    }

    @ActivityCallback
    private void onBatteryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        isIgnoringBatteryOptimizations(call);
    }
}
