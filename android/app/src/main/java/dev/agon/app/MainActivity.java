package dev.agon.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // In-repo plugins must be registered before the bridge starts.
        registerPlugin(NotificationPermissionPlugin.class); // MZY-281
        registerPlugin(SampleJournalPlugin.class); // MZY-294
        registerPlugin(RecordingPowerPlugin.class); // MZY-280
        super.onCreate(savedInstanceState);

        // Android Back navigates the site's history like a browser (MZY-274).
        // Capacitor core has no back handling (it lives in @capacitor/app),
        // so without this Back closed the app from any page. Only when there
        // is no history left does Back fall through to the default (leave).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
