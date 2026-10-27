package studio.kdp.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * KDP Studio — Offline Native Android Shell
 *
 * Serves bundled HTML, CSS, ES modules, vendored pdf-lib/fontkit, and OFL fonts
 * directly from APK assets over https://appassets.androidplatform.net with zero
 * network access, native MediaStore Downloads export, file chooser support, and
 * native clipboard integration.
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/index.html";
    private static final int REQ_OPEN_FILE = 1001;
    private static final int REQ_SAVE_FILE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private byte[] pendingSaveBytes;
    private String pendingSaveName;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.addJavascriptInterface(new KdpAndroidBridge(), "KdpAndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return blockedResponse();
                }
                String scheme = uri.getScheme();
                String host = uri.getHost();
                if (!"https".equalsIgnoreCase(scheme) || !ASSET_HOST.equalsIgnoreCase(host)) {
                    // Enforce strict offline zero-network execution
                    return blockedResponse();
                }

                String rawPath = uri.getPath();
                if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) {
                    rawPath = "/index.html";
                }
                while (rawPath.startsWith("/")) {
                    rawPath = rawPath.substring(1);
                }
                if (rawPath.contains("..")) {
                    return blockedResponse();
                }

                String assetPath = "www/" + rawPath;
                try {
                    InputStream stream = getAssets().open(assetPath);
                    String mime = resolveMimeType(rawPath);
                    String encoding = isTextMime(mime) ? "UTF-8" : null;
                    Map<String, String> headers = new HashMap<String, String>();
                    headers.put("Access-Control-Allow-Origin", "https://" + ASSET_HOST);
                    headers.put("Cache-Control", "public, max-age=31536000, immutable");
                    return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
                } catch (IOException e) {
                    Map<String, String> headers = new HashMap<String, String>();
                    headers.put("Access-Control-Allow-Origin", "https://" + ASSET_HOST);
                    return new WebResourceResponse(
                            "text/plain",
                            "UTF-8",
                            404,
                            "Not Found",
                            headers,
                            new ByteArrayInputStream(new byte[0]));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && ASSET_HOST.equalsIgnoreCase(uri.getHost())) {
                    return false;
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");

                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "Select File"),
                            REQ_OPEN_FILE);
                    return true;
                } catch (Exception e) {
                    fileUploadCallback = null;
                    return false;
                }
            }
        });

        root.addView(webView);
        setContentView(root);
        webView.loadUrl(START_URL);
    }

    private WebResourceResponse blockedResponse() {
        Map<String, String> headers = new HashMap<String, String>();
        return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                403,
                "Offline Mode",
                headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static boolean isTextMime(String mime) {
        return mime.startsWith("text/")
                || "application/json".equals(mime)
                || "application/manifest+json".equals(mime);
    }

    private static String resolveMimeType(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".webmanifest")) return "application/manifest+json";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_OPEN_FILE) {
            if (fileUploadCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    Uri uri = data.getData();
                    if (uri != null) {
                        results = new Uri[]{uri};
                    } else {
                        results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                    }
                }
                fileUploadCallback.onReceiveValue(results);
                fileUploadCallback = null;
            }
            return;
        }

        if (requestCode == REQ_SAVE_FILE) {
            if (resultCode == Activity.RESULT_OK && data != null && pendingSaveBytes != null) {
                Uri dest = data.getData();
                if (dest != null) {
                    OutputStream out = null;
                    try {
                        out = getContentResolver().openOutputStream(dest);
                        if (out != null) {
                            out.write(pendingSaveBytes);
                            out.flush();
                            Toast.makeText(
                                    this,
                                    "Saved: " + (pendingSaveName != null ? pendingSaveName : "file"),
                                    Toast.LENGTH_SHORT).show();
                        }
                    } catch (IOException e) {
                        Toast.makeText(this, "Could not save file", Toast.LENGTH_SHORT).show();
                    } finally {
                        if (out != null) {
                            try {
                                out.close();
                            } catch (IOException ignored) {
                            }
                        }
                    }
                }
            }
            pendingSaveBytes = null;
            pendingSaveName = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(window.__kdpHandleAndroidBack && window.__kdpHandleAndroidBack()) ? '1' : '0'",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"\"1\"".equals(value)) {
                            finish();
                        }
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class KdpAndroidBridge {

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("KDP Studio", text != null ? text : ""));
                    }
                }
            });
        }

        @JavascriptInterface
        public boolean saveBase64File(final String base64Data, final String filename, final String mimeType) {
            if (base64Data == null || filename == null) return false;
            final byte[] raw;
            try {
                raw = Base64.decode(base64Data, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return false;
            }

            final String safeMime = (mimeType != null && !mimeType.isEmpty())
                    ? mimeType
                    : "application/octet-stream";

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri itemUri = null;
                OutputStream out = null;
                try {
                    itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (itemUri != null) {
                        out = resolver.openOutputStream(itemUri);
                        if (out != null) {
                            out.write(raw);
                            out.flush();
                            out.close();
                            out = null;
                            ContentValues done = new ContentValues();
                            done.put(MediaStore.Downloads.IS_PENDING, 0);
                            resolver.update(itemUri, done, null, null);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(
                                            MainActivity.this,
                                            "Saved to Downloads: " + filename,
                                            Toast.LENGTH_SHORT).show();
                                }
                            });
                            return true;
                        }
                    }
                } catch (Exception e) {
                    if (itemUri != null) {
                        try {
                            resolver.delete(itemUri, null, null);
                        } catch (Exception ignored) {
                        }
                    }
                } finally {
                    if (out != null) {
                        try {
                            out.close();
                        } catch (IOException ignored) {
                        }
                    }
                }
            }

            // Fallback save dialog for Android 7-9 (API 24-28)
            pendingSaveBytes = raw;
            pendingSaveName = filename;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent createIntent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    createIntent.addCategory(Intent.CATEGORY_OPENABLE);
                    createIntent.setType(safeMime);
                    createIntent.putExtra(Intent.EXTRA_TITLE, filename);
                    try {
                        startActivityForResult(createIntent, REQ_SAVE_FILE);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Cannot open file saver", Toast.LENGTH_SHORT).show();
                    }
                }
            });
            return false;
        }
    }
}
