package com.umpat.communication;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * UMPAT Communication — Android app na nagbubukas ng online na UMPAT
 * (BuildConfig.APP_URL) sa loob ng WebView, may suporta sa camera/mic
 * para sa video call at sa pagpili ng larawan para sa profile.
 */
public class MainActivity extends Activity {

    private static final int REQ_MEDIA_PERMISSIONS = 1001;
    private static final int REQ_FILE_CHOOSER = 1002;

    private WebView webView;
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#060B19"));
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new UmpatWebViewClient());
        webView.setWebChromeClient(new UmpatChromeClient());

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(BuildConfig.APP_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    // ---------- Pag-navigate at offline na page ----------

    private class UmpatWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            Uri home = Uri.parse(BuildConfig.APP_URL);
            if (url.getHost() != null && url.getHost().equals(home.getHost())) {
                return false; // nasa loob pa rin ng UMPAT
            }
            // Ibang site: buksan sa browser
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
                    + "justify-content:center;background:radial-gradient(circle at top,#172554 0%,#050914 70%);"
                    + "color:#e2e8f0;font-family:sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
                    + "h2{color:#fff;margin:0 0 8px}p{color:#94a3b8;font-size:14px;margin:0 0 22px}"
                    + "a{background:#00f5d4;color:#060b19;font-weight:700;padding:12px 28px;border-radius:14px;"
                    + "text-decoration:none;box-shadow:0 0 20px rgba(0,245,212,.35)}</style></head><body>"
                    + "<h2>Walang koneksyon</h2>"
                    + "<p>Hindi maabot ang UMPAT server. Siguraduhing may internet ka, tapos subukan ulit."
                    + " (Kapag matagal walang gumagamit, mga 1 minuto bago magising ang server.)</p>"
                    + "<a href='" + BuildConfig.APP_URL + "'>Subukan ulit</a></body></html>";
            view.loadDataWithBaseURL(BuildConfig.APP_URL, html, "text/html", "UTF-8", null);
        }
    }

    // ---------- Camera / Mic at File Chooser ----------

    private class UmpatChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                List<String> needed = new ArrayList<>();
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                            && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        needed.add(Manifest.permission.CAMERA);
                    }
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        needed.add(Manifest.permission.RECORD_AUDIO);
                    }
                }
                if (needed.isEmpty()) {
                    request.grant(request.getResources());
                } else {
                    if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
                    pendingPermissionRequest = request;
                    requestPermissions(needed.toArray(new String[0]), REQ_MEDIA_PERMISSIONS);
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
            } catch (ActivityNotFoundException e) {
                pendingFileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MEDIA_PERMISSIONS || pendingPermissionRequest == null) return;

        List<String> granted = new ArrayList<>();
        for (String res : pendingPermissionRequest.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                granted.add(res);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                granted.add(res);
            }
        }
        if (granted.isEmpty()) {
            pendingPermissionRequest.deny();
        } else {
            pendingPermissionRequest.grant(granted.toArray(new String[0]));
        }
        pendingPermissionRequest = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER || pendingFileCallback == null) return;
        pendingFileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFileCallback = null;
    }
}
