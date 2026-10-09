package dev.agon.app;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Asks for POST_NOTIFICATIONS (Android 13+) before a recording starts
 * (MZY-281). @capacitor-community/background-geolocation runs its foreground
 * service with a persistent notification but never requests this permission,
 * and without it Android hides that notification. Called from
 * lib/gps/nativeGeolocation.ts as `AgonNotifications.request()`. The manifest
 * entry itself comes from the geolocation plugin's merged manifest.
 */
@CapacitorPlugin(
    name = "AgonNotifications",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class NotificationPermissionPlugin extends Plugin {

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED) {
            resolve(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "onResult");
    }

    @PermissionCallback
    private void onResult(PluginCall call) {
        resolve(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }

    private static void resolve(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }
}
