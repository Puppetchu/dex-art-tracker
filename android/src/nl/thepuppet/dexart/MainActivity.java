package nl.thepuppet.dexart;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Shows <server>/view/ full screen. The server does everything: login, ticks, pictures and card scanning.
 * Only pages under /view/ on that server open inside the app; other links (Cardmarket, TCGplayer ...) open
 * in the phone's browser. The camera is only handed to pages from your server.
 */
public class MainActivity extends Activity {
    private static final int REQ_CAMERA = 1, REQ_FILE = 2;
    private WebView web;
    private String base;
    private PermissionRequest pendingCamera;
    private ValueCallback<Uri[]> fileCallback;
    private boolean dialogOpen;

    private String home() { return base + "/view/"; }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        base = SetupActivity.savedServer(this);
        if (base == null) { startActivity(new Intent(this, SetupActivity.class)); finish(); return; }

        web = new WebView(this);
        setContentView(web);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false); // the camera preview starts by itself
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setSupportMultipleWindows(false); // links with target=_blank come through shouldOverrideUrlLoading
        ws.setUserAgentString(ws.getUserAgentString() + " DexArtApp/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(home());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getBooleanExtra("reload", false)) {
            base = SetupActivity.savedServer(this);
            if (base != null && web != null) web.loadUrl(home());
        }
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }
    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }

    /** Same server (scheme, host, port) and a path under /view/. */
    private boolean inApp(Uri u) {
        if (u == null || base == null) return false;
        Uri b = Uri.parse(base);
        String path = u.getPath() == null ? "/" : u.getPath();
        return b.getScheme() != null && b.getScheme().equalsIgnoreCase(u.getScheme())
                && b.getHost() != null && b.getHost().equalsIgnoreCase(u.getHost())
                && b.getPort() == u.getPort()
                && (path.equals("/view") || path.startsWith("/view/"));
    }
    private boolean sameServer(Uri u) {
        Uri b = Uri.parse(base);
        return u != null && b.getHost() != null && b.getHost().equalsIgnoreCase(u.getHost());
    }

    private void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
        catch (ActivityNotFoundException e) { /* nothing can open it */ }
    }

    private void problem(String text) {
        if (dialogOpen || isFinishing()) return;
        dialogOpen = true;
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Dex Art")
            .setMessage(text)
            .setPositiveButton("Try again", new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int w) { web.loadUrl(home()); }
            })
            .setNeutralButton("Change server", new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int w) { startActivity(new Intent(MainActivity.this, SetupActivity.class)); }
            })
            .setNegativeButton("Close", null)
            .setOnDismissListener(new DialogInterface.OnDismissListener() {
                @Override public void onDismiss(DialogInterface d) { dialogOpen = false; }
            })
            .show();
    }

    private class Client extends WebViewClient {
        // Android 7+ calls this one (it is not in the API 23 library this is built against, so no @Override)
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (inApp(u)) return false;
            if (req.isForMainFrame() && !req.hasGesture() && !sameServer(u)) {
                // the server (or the proxy in front of it) sent the app to another site: usually a login page
                problem("The server sent the app to " + u.getHost() + ", probably a login page of your reverse proxy. "
                        + "Let /view and /view/* through without login (for example a Pangolin \"Bypass Auth\" rule), then try again.");
                return true;
            }
            openOutside(u);
            return true;
        }
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) { // older Android
            Uri u = Uri.parse(url);
            if (inApp(u)) return false;
            openOutside(u);
            return true;
        }
        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) problem("Could not reach " + base + " (" + err.getDescription() + "). Check the connection and the server address.");
        }
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse res) {
            if (!req.isForMainFrame()) return;
            int code = res.getStatusCode();
            if (code == 401 || code == 403) problem("The server refused the page (HTTP " + code + "). If a reverse proxy with login is in front of it, let /view and /view/* through without login.");
            else if (code >= 500) problem("The server is not answering properly (HTTP " + code + "). Is it running?");
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest req) {
            boolean camera = false;
            for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) camera = true;
            if (!camera || !inApp(Uri.parse(req.getOrigin().toString() + "view/"))) { req.deny(); return; }
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                req.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            } else {
                if (pendingCamera != null) pendingCamera.deny();
                pendingCamera = req;
                requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAMERA);
            }
        }
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            try { startActivityForResult(params.createIntent(), REQ_FILE); }
            catch (ActivityNotFoundException e) { fileCallback = null; cb.onReceiveValue(null); }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_CAMERA || pendingCamera == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pendingCamera.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        else pendingCamera.deny();
        pendingCamera = null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Dex Art")
            .setItems(new CharSequence[] { "Reload", "Change server", "Close the app" }, new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int which) {
                    if (which == 0) web.loadUrl(home());
                    else if (which == 1) startActivity(new Intent(MainActivity.this, SetupActivity.class));
                    else finish();
                }
            })
            .show();
    }
}
