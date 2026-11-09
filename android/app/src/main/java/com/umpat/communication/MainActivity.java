package com.umpat.communication;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * UMPAT Communication — Android app.
 *
 * Unang screen: launcher (assets/launcher.html) kung saan pipili ng server:
 *  - LAN: awtomatikong hinahanap ang UMPAT server (Termux) sa parehong
 *    Wi-Fi/hotspot, o i-type ang IP. Gumagana kahit walang internet.
 *  - Internet: ang online na UMPAT (BuildConfig.APP_URL).
 */
public class MainActivity extends Activity {

    private static final String LAUNCHER_URL = "file:///android_asset/launcher.html";
    private static final int DEFAULT_PORT = 3000;
    private static final int REQ_MEDIA_PERMISSIONS = 1001;
    private static final int REQ_FILE_CHOOSER = 1002;

    private WebView webView;
    private SharedPreferences prefs;
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> pendingFileCallback;
    private volatile String currentServerHost = null;
    private final AtomicBoolean scanning = new AtomicBoolean(false);

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("umpat", MODE_PRIVATE);

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
        s.setAllowFileAccess(true); // para sa launcher.html sa assets
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new UmpatWebViewClient());
        webView.setWebChromeClient(new UmpatChromeClient());
        webView.addJavascriptInterface(new Bridge(), "UmpatBridge");

        if (savedInstanceState != null) {
            currentServerHost = savedInstanceState.getString("host");
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(LAUNCHER_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString("host", currentServerHost);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else if (!isOnLauncher()) {
            webView.loadUrl(LAUNCHER_URL);
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private boolean isOnLauncher() {
        String u = webView.getUrl();
        return u != null && u.startsWith(LAUNCHER_URL);
    }

    /** Patakbuhin ang JS sa launcher lang (hindi sa page ng server). */
    private void callLauncher(final String js) {
        runOnUiThread(() -> {
            if (isOnLauncher()) webView.evaluateJavascript(js, null);
        });
    }

    private void openServer(String url) {
        Uri u = Uri.parse(url);
        currentServerHost = u.getHost();
        webView.loadUrl(url);
    }

    // ---------- JavaScript bridge para sa launcher ----------

    private class Bridge {
        @JavascriptInterface
        public String getOnlineUrl() {
            return BuildConfig.APP_URL;
        }

        @JavascriptInterface
        public String getLastServer() {
            try {
                JSONObject o = new JSONObject();
                o.put("url", prefs.getString("last_url", ""));
                o.put("name", prefs.getString("last_name", ""));
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String getNetworkInfo() {
            try {
                JSONObject o = new JSONObject();
                JSONArray ips = new JSONArray();
                JSONArray subnets = new JSONArray();
                for (String ip : getLanIps()) {
                    ips.put(ip);
                    subnets.put(ip.substring(0, ip.lastIndexOf('.')) + ".0/24");
                }
                o.put("ips", ips);
                o.put("subnets", subnets);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void open(final String url, final String name) {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
            prefs.edit().putString("last_url", url).putString("last_name", name == null ? "" : name).apply();
            runOnUiThread(() -> openServer(url));
        }

        @JavascriptInterface
        public void showLauncher() {
            runOnUiThread(() -> webView.loadUrl(LAUNCHER_URL));
        }

        @JavascriptInterface
        public void retry(final String url) {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
            runOnUiThread(() -> openServer(url));
        }

        @JavascriptInterface
        public void startScan(final int port) {
            if (!scanning.compareAndSet(false, true)) return;
            new Thread(() -> {
                try {
                    scanLan(port > 0 ? port : DEFAULT_PORT);
                } finally {
                    scanning.set(false);
                    callLauncher("onScanDone()");
                }
            }).start();
        }

        @JavascriptInterface
        public void probe(final String input) {
            new Thread(() -> {
                JSONObject found = probeInput(input);
                callLauncher("onProbeResult(" + (found == null ? "null" : found.toString()) + ")");
            }).start();
        }
    }

    // ---------- LAN discovery ----------

    /** IPv4 address ng phone sa Wi-Fi / hotspot / USB tethering (hindi mobile data). */
    private static List<String> getLanIps() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName().toLowerCase();
                if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("pdp")
                        || n.startsWith("v4-") || n.startsWith("tun") || n.startsWith("dummy")) {
                    continue;
                }
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        out.add(a.getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void scanLan(final int port) {
        Set<String> hosts = new LinkedHashSet<>();
        hosts.add("127.0.0.1"); // Termux sa parehong phone
        for (String ip : getLanIps()) {
            String prefix = ip.substring(0, ip.lastIndexOf('.') + 1);
            for (int i = 1; i <= 254; i++) hosts.add(prefix + i);
        }
        final int total = hosts.size();
        final AtomicInteger done = new AtomicInteger();
        final Set<String> reported = Collections.synchronizedSet(new LinkedHashSet<>());
        final List<String> myIps = getLanIps();

        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (final String host : hosts) {
            pool.execute(() -> {
                JSONObject s = probeServer(host, port, null);
                if (s != null) {
                    // Iisang server lang kahit makita sa 127.0.0.1 at sa sariling IP
                    String key = (host.equals("127.0.0.1") || myIps.contains(host)) ? "self" : host;
                    if (reported.add(key)) {
                        callLauncher("onServerFound(" + s + ")");
                    }
                }
                int d = done.incrementAndGet();
                if (d % 16 == 0 || d == total) {
                    callLauncher("onScanProgress(" + d + "," + total + ")");
                }
            });
        }
        pool.shutdown();
        try {
            pool.awaitTermination(60, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
    }

    /** Tanggapin ang typed na address: "192.168.1.5", "192.168.1.5:3000", o buong URL. */
    private JSONObject probeInput(String input) {
        if (input == null) return null;
        String v = input.trim();
        String scheme = null;
        if (v.startsWith("http://")) { scheme = "http"; v = v.substring(7); }
        else if (v.startsWith("https://")) { scheme = "https"; v = v.substring(8); }
        int slash = v.indexOf('/');
        if (slash >= 0) v = v.substring(0, slash);
        if (v.isEmpty()) return null;

        String host = v;
        int port = -1;
        int colon = v.lastIndexOf(':');
        if (colon > 0) {
            host = v.substring(0, colon);
            try { port = Integer.parseInt(v.substring(colon + 1)); } catch (NumberFormatException e) { return null; }
        }
        if (port < 0) {
            // LAN IP: default 3000. Domain (hal. onrender.com): default HTTPS port.
            port = isPrivateHost(host) ? DEFAULT_PORT : (scheme == null || scheme.equals("https") ? 443 : 80);
        }
        return probeServer(host, port, scheme);
    }

    /** Tingnan kung UMPAT server ang nasa host:port (gamit ang /api/mode). */
    private JSONObject probeServer(String host, int port, String onlyScheme) {
        String[] schemes = onlyScheme != null ? new String[]{onlyScheme} : new String[]{"https", "http"};
        for (String scheme : schemes) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(scheme + "://" + host + ":" + port + "/api/mode");
                c = (HttpURLConnection) u.openConnection();
                if (c instanceof HttpsURLConnection && isPrivateHost(host)) {
                    // Self-signed ang cert ng Termux server (generate-cert.sh)
                    ((HttpsURLConnection) c).setSSLSocketFactory(trustAllFactory());
                    ((HttpsURLConnection) c).setHostnameVerifier((h, sess) -> true);
                }
                c.setConnectTimeout(host.equals("127.0.0.1") ? 300 : 700);
                c.setReadTimeout(2000);
                if (c.getResponseCode() != 200) continue;
                StringBuilder sb = new StringBuilder();
                try (BufferedReader r = new BufferedReader(
                        new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null && sb.length() < 4096) sb.append(line);
                }
                JSONObject o = new JSONObject(sb.toString());
                if (!"umpat".equals(o.optString("app")) && !o.has("hasDatabase")) continue;
                boolean defaultPort = (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
                String base = scheme + "://" + host + (defaultPort ? "" : ":" + port);
                JSONObject s = new JSONObject();
                s.put("url", base);
                s.put("ip", host);
                s.put("port", port);
                s.put("https", scheme.equals("https"));
                s.put("name", o.optString("name", "UMPAT Server"));
                return s;
            } catch (SSLException e) {
                // HTTP server ito, hindi HTTPS — subukan ang susunod na scheme
            } catch (Exception e) {
                // Sarado ang port / walang device — huwag nang subukan ang HTTP
                return null;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }

    private static boolean isPrivateHost(String host) {
        if (host == null) return false;
        if (host.equals("localhost") || host.startsWith("127.")) return true;
        if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
        if (host.startsWith("172.")) {
            String[] p = host.split("\\.");
            if (p.length == 4) {
                try {
                    int b = Integer.parseInt(p[1]);
                    return b >= 16 && b <= 31;
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return false;
    }

    private static SSLSocketFactory trustAllSocketFactory;

    private static synchronized SSLSocketFactory trustAllFactory() throws Exception {
        if (trustAllSocketFactory == null) {
            TrustManager[] tm = {new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] c, String a) { }
                public void checkServerTrusted(X509Certificate[] c, String a) { }
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            }};
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tm, null);
            trustAllSocketFactory = ctx.getSocketFactory();
        }
        return trustAllSocketFactory;
    }

    // ---------- Pag-navigate, SSL, at offline na page ----------

    private class UmpatWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();
            if ("file".equals(url.getScheme())) return false;
            if (host != null && host.equals(currentServerHost)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Self-signed cert ng LAN server (Termux) — tanggapin lang kung LAN IP
            String host = Uri.parse(error.getUrl()).getHost();
            if (isPrivateHost(host) && host.equals(currentServerHost)) {
                handler.proceed();
            } else {
                handler.cancel();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            String failed = request.getUrl().toString();
            if (failed.startsWith("file:")) return;
            String safe = failed.replace("\\", "").replace("'", "").replace("<", "").replace("\"", "");
            String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
                    + "justify-content:center;background:radial-gradient(circle at top,#172554 0%,#050914 70%);"
                    + "color:#e2e8f0;font-family:sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
                    + "h2{color:#fff;margin:0 0 8px}p{color:#94a3b8;font-size:14px;margin:0 0 22px;line-height:1.5}"
                    + "code{color:#34d399}button{border:none;font:inherit;font-weight:700;padding:12px 26px;"
                    + "border-radius:14px;margin:6px;cursor:pointer}"
                    + ".a{background:#00f5d4;color:#060b19;box-shadow:0 0 20px rgba(0,245,212,.35)}"
                    + ".b{background:rgba(30,41,59,.9);color:#e2e8f0;border:1px solid #334155}</style></head><body>"
                    + "<h2>Hindi maabot ang server</h2>"
                    + "<p><code>" + safe + "</code><br>Kung LAN: tingnan kung tumatakbo ang server sa Termux"
                    + " at parehong Wi-Fi kayo. Kung Online: kailangan ng internet (mga 1 minuto bago"
                    + " magising ang server kapag matagal walang gumamit).</p>"
                    + "<div><button class='a' onclick=\"UmpatBridge.retry('" + safe + "')\">Subukan ulit</button>"
                    + "<button class='b' onclick='UmpatBridge.showLauncher()'>Pumili ng server</button></div>"
                    + "</body></html>";
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", failed);
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
