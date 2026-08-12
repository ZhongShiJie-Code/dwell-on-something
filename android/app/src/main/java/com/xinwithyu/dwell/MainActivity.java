package com.xinwithyu.dwell;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.speech.RecognitionListener;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int VOICE_REQUEST = 1002;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1003;
    private static final int VOICE_PERMISSION_REQUEST = 1004;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Uri pendingCameraUri;
    private OnBackInvokedCallback backCallback;
    private TextToSpeech textToSpeech;
    private String speechKey = "";
    private SpeechRecognizer speechRecognizer;
    private Intent voiceIntent;
    private boolean voiceListening;
    private boolean voiceCancelled;
    private String pendingRoute = "";
    private boolean webReady;
    private Thread.UncaughtExceptionHandler previousCrashHandler;
    private Thread.UncaughtExceptionHandler crashHandler;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        boolean systemDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        setTheme(systemDark ? R.style.AppThemeDark : R.style.AppTheme);
        super.onCreate(savedInstanceState);
        previousCrashHandler = Thread.getDefaultUncaughtExceptionHandler();
        crashHandler = (thread, error) -> {
            recordDiagnostic("native_crash", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
            if (previousCrashHandler != null) previousCrashHandler.uncaughtException(thread, error);
        };
        Thread.setDefaultUncaughtExceptionHandler(crashHandler);
        applySystemBars(systemDark);
        captureRoute(getIntent());

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // The packaged UI is file://, while the optional Mac backend is on the LAN.
        // The backend still gates access with DWELL_AUTH_TOKEN when configured.
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(true);

        webView.setBackgroundColor(systemDark ? Color.rgb(38, 38, 36) : Color.rgb(250, 249, 245));
        if (Build.VERSION.SDK_INT >= 26) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        webView.addJavascriptInterface(new NativeBridge(), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalIfNeeded(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternalIfNeeded(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                webReady = true;
                flushPendingRoute();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                recordDiagnostic("webview_render_gone", "crashed=" + detail.didCrash() + ", priority=" + detail.rendererPriorityAtExit());
                webReady = false;
                if (view == webView) webView = null;
                try { view.removeJavascriptInterface("Android"); } catch (Exception ignored) {}
                try { view.destroy(); } catch (Exception ignored) {}
                runOnUiThread(MainActivity.this::recreate);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                finishPendingFileRequest(null);
                pendingFileCallback = filePathCallback;
                String[] accepts = fileChooserParams.getAcceptTypes();
                boolean imageOnly = accepts != null && accepts.length > 0;
                if (imageOnly) {
                    for (String type : accepts) {
                        if (type == null || type.isEmpty() || !type.startsWith("image/")) {
                            imageOnly = false;
                            break;
                        }
                    }
                }
                if (fileChooserParams.isCaptureEnabled() && imageOnly) return launchCamera();
                return launchDocumentPicker(accepts, fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                        || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    recordDiagnostic("web_console_" + message.messageLevel().name().toLowerCase(Locale.ROOT),
                            message.message() + " @ " + message.sourceId() + ":" + message.lineNumber());
                }
                return super.onConsoleMessage(message);
            }
        });

        setContentView(webView);
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleWebBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void applySystemBars(boolean dark) {
        Window window = getWindow();
        window.setStatusBarColor(dark ? Color.rgb(38, 38, 36) : Color.rgb(250, 249, 245));
        window.setNavigationBarColor(dark ? Color.rgb(38, 38, 36) : Color.rgb(250, 249, 245));
        window.getDecorView().setSystemUiVisibility(dark ? 0
                : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    private void captureRoute(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(DwellNotificationJobService.EXTRA_ROUTE);
        if (route != null && !route.trim().isEmpty()) pendingRoute = route.trim();
    }

    private void flushPendingRoute() {
        if (!webReady || pendingRoute.isEmpty()) return;
        String route = pendingRoute;
        pendingRoute = "";
        evaluate("window.onNativeOpenRoute&&window.onNativeOpenRoute(" + JSONObject.quote(route) + ")");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureRoute(intent);
        flushPendingRoute();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webReady) {
            String state = new NativeBridge().notificationState();
            if ("on".equals(state)) DwellNotificationJobService.schedule(this);
            notifyNotificationChanged(state, "");
        }
    }

    private boolean launchCamera() {
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, "dwell-" + System.currentTimeMillis() + ".jpg");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            pendingCameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (pendingCameraUri == null) throw new IllegalStateException("camera uri unavailable");
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            intent.setClipData(ClipData.newRawUri("dwell-camera", pendingCameraUri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(intent, FILE_CHOOSER_REQUEST);
            return true;
        } catch (Exception error) {
            discardCameraUri();
            finishPendingFileRequest(null);
            return false;
        }
    }

    private boolean launchDocumentPicker(String[] accepts, boolean multiple) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        String type = "*/*";
        ArrayList<String> cleanTypes = new ArrayList<>();
        if (accepts != null) {
            for (String accept : accepts) if (accept != null && !accept.trim().isEmpty()) cleanTypes.add(accept.trim());
        }
        if (cleanTypes.size() == 1) type = cleanTypes.get(0);
        else if (!cleanTypes.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, cleanTypes.toArray(new String[0]));
        intent.setType(type);
        try {
            startActivityForResult(intent, FILE_CHOOSER_REQUEST);
            return true;
        } catch (ActivityNotFoundException error) {
            finishPendingFileRequest(null);
            return false;
        }
    }

    private boolean openExternalIfNeeded(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null || "file".equalsIgnoreCase(scheme) || "about".equalsIgnoreCase(scheme)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // Keep the local app usable when a custom URL scheme has no Android handler.
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VOICE_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> matches = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (matches != null && !matches.isEmpty()) {
                    evaluate("window.onNativeSpeechResult&&window.onNativeSpeechResult(" + JSONObject.quote(matches.get(0)) + ")");
                    return;
                }
            }
            evaluate("window.onNativeSpeechCancelled&&window.onNativeSpeechCancelled()");
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || pendingFileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && pendingCameraUri != null) {
            result = new Uri[]{pendingCameraUri};
            pendingCameraUri = null;
        } else if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        if (resultCode != RESULT_OK) discardCameraUri();
        finishPendingFileRequest(result);
    }

    private void finishPendingFileRequest(Uri[] result) {
        if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(result);
        pendingFileCallback = null;
    }

    private void discardCameraUri() {
        if (pendingCameraUri == null) return;
        try { getContentResolver().delete(pendingCameraUri, null, null); } catch (Exception ignored) {}
        pendingCameraUri = null;
    }

    private void evaluate(String script) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private void recordDiagnostic(String kind, String detail) {
        String clean = detail == null ? "" : detail;
        if (clean.length() > 1600) clean = clean.substring(0, 1600);
        Log.w("dwell", kind + ": " + clean);
        getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE).edit()
                .putString("diagnostic-last-kind", kind)
                .putString("diagnostic-last-detail", clean)
                .putLong("diagnostic-last-at", System.currentTimeMillis())
                .apply();
    }

    private void fallbackBack() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    private void handleWebBack() {
        if (webView == null) {
            fallbackBack();
            return;
        }
        webView.evaluateJavascript("Boolean(window.dwellHandleBack&&window.dwellHandleBack())", value -> {
            if (!"true".equals(value)) fallbackBack();
        });
    }

    @Override
    public void onBackPressed() {
        handleWebBack();
    }

    @Override
    protected void onDestroy() {
        if (Thread.getDefaultUncaughtExceptionHandler() == crashHandler) {
            Thread.setDefaultUncaughtExceptionHandler(previousCrashHandler);
        }
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            backCallback = null;
        }
        finishPendingFileRequest(null);
        discardCameraUri();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        destroySpeechRecognizer();
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private final class NativeBridge {
        @JavascriptInterface
        public boolean isNativeApp() { return true; }

        @JavascriptInterface
        public void startVoiceInput() {
            runOnUiThread(MainActivity.this::beginVoiceRecognition);
        }

        @JavascriptInterface
        public void stopVoiceInput() {
            runOnUiThread(() -> {
                voiceCancelled = true;
                if (speechRecognizer != null) {
                    try { speechRecognizer.cancel(); } catch (Exception ignored) {}
                    destroySpeechRecognizer();
                }
                evaluate("window.onNativeSpeechCancelled&&window.onNativeSpeechCancelled()");
            });
        }

        @JavascriptInterface
        public void shareText(String title, String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                startActivity(Intent.createChooser(send, title == null || title.isEmpty() ? "分享" : title));
            });
        }

        @JavascriptInterface
        public void openExternalUrl(String url) {
            runOnUiThread(() -> {
                try { openExternalIfNeeded(Uri.parse(url == null ? "" : url)); } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void speak(String text, String key) {
            final String value = cleanSpeechText(text);
            final String utteranceKey = key == null ? "dwell-speech" : key;
            runOnUiThread(() -> {
                speechKey = utteranceKey;
                if (textToSpeech == null) {
                    textToSpeech = new TextToSpeech(MainActivity.this, status -> {
                        if (status == TextToSpeech.SUCCESS) speakNow(value, utteranceKey);
                        else evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(utteranceKey) + ",'error')");
                    });
                } else {
                    speakNow(value, utteranceKey);
                }
            });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(() -> {
                if (textToSpeech != null) textToSpeech.stop();
                String key = speechKey;
                speechKey = "";
                if (!key.isEmpty()) evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(key) + ",'stopped')");
            });
        }

        private void speakNow(String text, String key) {
            if (textToSpeech == null || text.isEmpty()) return;
            textToSpeech.stop();
            textToSpeech.setLanguage(Locale.SIMPLIFIED_CHINESE);
            textToSpeech.setSpeechRate(0.96f);
            textToSpeech.setPitch(1.0f);
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {
                    if (utteranceIndex(utteranceId) == 0) {
                        evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(utteranceBase(utteranceId)) + ",'started')");
                    }
                }
                @Override public void onDone(String utteranceId) {
                    if (!utteranceFinal(utteranceId)) return;
                    String base = utteranceBase(utteranceId);
                    if (base.equals(speechKey)) speechKey = "";
                    evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(base) + ",'done')");
                }
                @Override public void onError(String utteranceId) {
                    String base = utteranceBase(utteranceId);
                    if (base.equals(speechKey)) speechKey = "";
                    evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(base) + ",'error')");
                }
            });
            List<String> chunks = speechChunks(text);
            for (int i = 0; i < chunks.size(); i++) {
                Bundle params = new Bundle();
                String utteranceId = key + "::dwell::" + i + "::" + chunks.size();
                params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId);
                textToSpeech.speak(chunks.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, utteranceId);
            }
        }

        private String cleanSpeechText(String text) {
            return String.valueOf(text == null ? "" : text)
                    .replaceAll("(?s)```.*?```", "。代码内容已省略。")
                    .replaceAll("https?://\\S+", "链接")
                    .replaceAll("[*_~`#>|]", "")
                    .replaceAll("\\s*\\n+\\s*", "。")
                    .replaceAll("。{2,}", "。")
                    .trim();
        }

        private List<String> speechChunks(String text) {
            ArrayList<String> chunks = new ArrayList<>();
            int max = Math.min(1800, TextToSpeech.getMaxSpeechInputLength() - 32);
            String remaining = text;
            while (!remaining.isEmpty()) {
                if (remaining.length() <= max) { chunks.add(remaining); break; }
                int cut = -1;
                for (int i = Math.min(max, remaining.length() - 1); i > max / 2; i--) {
                    if ("。！？；，.!?;,".indexOf(remaining.charAt(i)) >= 0) { cut = i + 1; break; }
                }
                if (cut < 1) cut = max;
                chunks.add(remaining.substring(0, cut));
                remaining = remaining.substring(cut).trim();
            }
            if (chunks.isEmpty()) chunks.add(text);
            return chunks;
        }

        private String utteranceBase(String utteranceId) {
            int marker = utteranceId == null ? -1 : utteranceId.lastIndexOf("::dwell::");
            return marker < 0 ? String.valueOf(utteranceId) : utteranceId.substring(0, marker);
        }

        private int utteranceIndex(String utteranceId) {
            try {
                String suffix = utteranceId.substring(utteranceId.lastIndexOf("::dwell::") + 9);
                return Integer.parseInt(suffix.substring(0, suffix.indexOf("::")));
            } catch (Exception ignored) { return 0; }
        }

        private boolean utteranceFinal(String utteranceId) {
            try {
                String suffix = utteranceId.substring(utteranceId.lastIndexOf("::dwell::") + 9);
                int split = suffix.indexOf("::");
                return Integer.parseInt(suffix.substring(0, split)) + 1 == Integer.parseInt(suffix.substring(split + 2));
            } catch (Exception ignored) { return true; }
        }

        @JavascriptInterface
        public void configureBackend(String endpoint, String token) {
            saveBackend(endpoint, token, false);
        }

        @JavascriptInterface
        public String enableNotifications(String endpoint, String token) {
            try {
                if (!saveBackend(endpoint, token, true)) return "invalid_endpoint";
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                    } else {
                        DwellNotificationJobService.schedule(MainActivity.this);
                        notifyNotificationChanged("on", "手机通知已开启");
                    }
                });
                return notificationsAllowed() ? "on" : "pending";
            } catch (Exception error) {
                notifyNotificationChanged("error", error.getMessage() == null ? "通知初始化失败" : error.getMessage());
                return "error";
            }
        }

        @JavascriptInterface
        public void disableNotifications() {
            getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE)
                    .edit().putBoolean(DwellNotificationJobService.KEY_ENABLED, false).apply();
            DwellNotificationJobService.cancel(MainActivity.this);
            notifyNotificationChanged("off", "手机通知已关闭");
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                try { startActivity(intent); } catch (ActivityNotFoundException ignored) {}
            });
        }

        @JavascriptInterface
        public String notificationDiagnostics() {
            return DwellNotificationJobService.diagnostics(MainActivity.this).toString();
        }

        @JavascriptInterface
        public void testNotification() {
            runOnUiThread(() -> DwellNotificationJobService.show(MainActivity.this, "dwell 通知测试", "系统通知通道正常；正在继续检查 Mac 消息轮询。", System.currentTimeMillis(), ""));
        }

        @JavascriptInterface
        public void pollNotificationsNow() {
            DwellNotificationJobService.pollNow(MainActivity.this);
        }

        @JavascriptInterface
        public void logDiagnostic(String kind, String detail) {
            recordDiagnostic(kind == null ? "web" : kind, detail);
        }

        @JavascriptInterface
        public String appDiagnostics() {
            SharedPreferences prefs = getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE);
            JSONObject out = new JSONObject();
            try {
                out.put("kind", prefs.getString("diagnostic-last-kind", ""));
                out.put("detail", prefs.getString("diagnostic-last-detail", ""));
                out.put("at", prefs.getLong("diagnostic-last-at", 0L));
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface
        public void showNotification(String title, String body, String messageId) {
            if (!notificationsAllowed()) return;
            long seq = parseMessageId(messageId);
            markNotificationSeen(messageId);
            DwellNotificationJobService.show(MainActivity.this, title, body, seq > 0 ? seq : System.currentTimeMillis(), "");
        }

        @JavascriptInterface
        public void showNotificationWithRoute(String title, String body, String messageId, String route) {
            if (!notificationsAllowed()) return;
            long seq = parseMessageId(messageId);
            markNotificationSeen(messageId);
            DwellNotificationJobService.show(MainActivity.this, title, body, seq > 0 ? seq : System.currentTimeMillis(), route == null ? "" : route);
        }

        @JavascriptInterface
        public void setDarkMode(boolean dark) {
            runOnUiThread(() -> {
                applySystemBars(dark);
                if (webView != null) webView.setBackgroundColor(dark ? Color.rgb(38, 38, 36) : Color.rgb(250, 249, 245));
            });
        }

        @JavascriptInterface
        public void markNotificationSeen(String messageId) {
            long seq = parseMessageId(messageId);
            if (seq <= 0) return;
            SharedPreferences prefs = getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE);
            long previous = prefs.getLong(DwellNotificationJobService.KEY_LAST_SEQ, 0L);
            if (seq > previous) prefs.edit().putLong(DwellNotificationJobService.KEY_LAST_SEQ, seq).apply();
        }

        @JavascriptInterface
        public String notificationState() {
            SharedPreferences prefs = getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE);
            if (!prefs.getBoolean(DwellNotificationJobService.KEY_ENABLED, false)) return "off";
            if (prefs.getString(DwellNotificationJobService.KEY_ENDPOINT, "").isEmpty()) return "off";
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "blocked";
            return "on";
        }

        private boolean saveBackend(String endpoint, String token, boolean enable) {
            String clean = endpoint == null ? "" : endpoint.trim().replaceAll("/+$", "").replaceAll("/api$", "");
            Uri uri = Uri.parse(clean);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) clean = "";
            SharedPreferences prefs = getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE);
            String old = prefs.getString(DwellNotificationJobService.KEY_ENDPOINT, "");
            boolean enabled = enable
                    ? !clean.isEmpty()
                    : prefs.getBoolean(DwellNotificationJobService.KEY_ENABLED, false) && !clean.isEmpty();
            SharedPreferences.Editor editor = prefs.edit()
                    .putString(DwellNotificationJobService.KEY_ENDPOINT, clean)
                    .putString(DwellNotificationJobService.KEY_TOKEN, token == null ? "" : token)
                    .putBoolean(DwellNotificationJobService.KEY_ENABLED, enabled);
            if (!old.equals(clean)) editor.putLong(DwellNotificationJobService.KEY_LAST_SEQ, 0L);
            editor.apply();
            if (enabled && notificationsAllowed()) DwellNotificationJobService.schedule(MainActivity.this);
            else DwellNotificationJobService.cancel(MainActivity.this);
            return !clean.isEmpty();
        }

        private boolean notificationsAllowed() {
            return Build.VERSION.SDK_INT < 33
                    || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }

        private long parseMessageId(String value) {
            try { return Long.parseLong(value == null ? "0" : value); }
            catch (NumberFormatException ignored) { return 0L; }
        }
    }

    private void notifyNotificationChanged(String state, String message) {
        evaluate("window.onNativeNotificationChanged&&window.onNativeNotificationChanged(" + JSONObject.quote(state) + "," + JSONObject.quote(message == null ? "" : message) + ")");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == VOICE_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) beginVoiceRecognition();
            else evaluate("window.onNativeSpeechError&&window.onNativeSpeechError('需要麦克风权限才能语音输入')");
            return;
        }
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            DwellNotificationJobService.schedule(this);
            notifyNotificationChanged("on", "手机通知已开启");
        } else {
            notifyNotificationChanged("blocked", "请在系统设置中允许 dwell 发送通知");
        }
    }

    private void beginVoiceRecognition() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, VOICE_PERMISSION_REQUEST);
            return;
        }
        if (voiceListening && speechRecognizer != null) {
            speechRecognizer.stopListening();
            return;
        }
        voiceCancelled = false;
        voiceIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        voiceIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        voiceIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.SIMPLIFIED_CHINESE.toLanguageTag());
        voiceIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, Locale.SIMPLIFIED_CHINESE.toLanguageTag());
        voiceIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        voiceIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            try {
                startActivityForResult(voiceIntent, VOICE_REQUEST);
            } catch (ActivityNotFoundException error) {
                evaluate("window.onNativeSpeechError&&window.onNativeSpeechError('手机没有可用的语音识别服务')");
            }
            return;
        }
        destroySpeechRecognizer();
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                voiceListening = true;
                evaluate("window.onNativeSpeechReady&&window.onNativeSpeechReady()");
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {
                evaluate("window.onNativeSpeechProcessing&&window.onNativeSpeechProcessing()");
            }
            @Override public void onError(int error) {
                voiceListening = false;
                if (voiceCancelled) {
                    voiceCancelled = false;
                    destroySpeechRecognizer();
                    return;
                }
                String message;
                switch (error) {
                    case SpeechRecognizer.ERROR_AUDIO: message = "没有收到麦克风声音"; break;
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: message = "麦克风权限不可用"; break;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: message = "语音识别网络不可用"; break;
                    case SpeechRecognizer.ERROR_NO_MATCH: message = "没有听清，请再说一次"; break;
                    case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: message = "语音识别正在使用，请稍后再试"; break;
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: message = "没有听到说话"; break;
                    default: message = "语音识别没有成功";
                }
                evaluate("window.onNativeSpeechError&&window.onNativeSpeechError(" + JSONObject.quote(message) + ")");
                recordDiagnostic("speech_error", error + ":" + message);
                destroySpeechRecognizer();
            }
            @Override public void onResults(Bundle results) {
                voiceListening = false;
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    evaluate("window.onNativeSpeechResult&&window.onNativeSpeechResult(" + JSONObject.quote(matches.get(0)) + ")");
                } else {
                    evaluate("window.onNativeSpeechError&&window.onNativeSpeechError('没有听清，请再说一次')");
                }
                destroySpeechRecognizer();
            }
            @Override public void onPartialResults(Bundle partialResults) {
                ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    evaluate("window.onNativeSpeechPartial&&window.onNativeSpeechPartial(" + JSONObject.quote(matches.get(0)) + ")");
                }
            }
            @Override public void onEvent(int eventType, Bundle params) {}
        });
        try {
            speechRecognizer.startListening(voiceIntent);
        } catch (Exception error) {
            voiceListening = false;
            recordDiagnostic("speech_start_error", error.getClass().getSimpleName() + ":" + error.getMessage());
            destroySpeechRecognizer();
            evaluate("window.onNativeSpeechError&&window.onNativeSpeechError('语音识别启动失败')");
        }
    }

    private void destroySpeechRecognizer() {
        voiceListening = false;
        if (speechRecognizer == null) return;
        try { speechRecognizer.cancel(); } catch (Exception ignored) {}
        try { speechRecognizer.destroy(); } catch (Exception ignored) {}
        speechRecognizer = null;
    }
}
