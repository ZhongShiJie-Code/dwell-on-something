package com.xinwithyu.dwell;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
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
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int VOICE_REQUEST = 1002;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1003;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Uri pendingCameraUri;
    private OnBackInvokedCallback backCallback;
    private TextToSpeech textToSpeech;
    private String speechKey = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(250, 249, 245));
        window.setNavigationBarColor(Color.rgb(250, 249, 245));
        window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

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

        webView.setBackgroundColor(Color.rgb(250, 249, 245));
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
        });

        setContentView(webView);
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleWebBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        webView.loadUrl("file:///android_asset/index.html");
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
            runOnUiThread(() -> {
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.SIMPLIFIED_CHINESE.toLanguageTag());
                intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "说点什么…");
                try {
                    startActivityForResult(intent, VOICE_REQUEST);
                } catch (ActivityNotFoundException error) {
                    evaluate("window.onNativeSpeechCancelled&&window.onNativeSpeechCancelled()");
                }
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
            final String value = text == null ? "" : text.trim();
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
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {
                    evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(utteranceId) + ",'started')");
                }
                @Override public void onDone(String utteranceId) {
                    if (utteranceId.equals(speechKey)) speechKey = "";
                    evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(utteranceId) + ",'done')");
                }
                @Override public void onError(String utteranceId) {
                    if (utteranceId.equals(speechKey)) speechKey = "";
                    evaluate("window.onNativeSpeechState&&window.onNativeSpeechState(" + JSONObject.quote(utteranceId) + ",'error')");
                }
            });
            Bundle params = new Bundle();
            params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, key);
            textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, params, key);
        }

        @JavascriptInterface
        public void configureBackend(String endpoint, String token) {
            saveBackend(endpoint, token, false);
        }

        @JavascriptInterface
        public void enableNotifications(String endpoint, String token) {
            saveBackend(endpoint, token, true);
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                } else {
                    DwellNotificationJobService.schedule(MainActivity.this);
                }
            });
        }

        @JavascriptInterface
        public void disableNotifications() {
            getSharedPreferences(DwellNotificationJobService.PREFS, MODE_PRIVATE)
                    .edit().putBoolean(DwellNotificationJobService.KEY_ENABLED, false).apply();
            DwellNotificationJobService.cancel(MainActivity.this);
        }

        @JavascriptInterface
        public void showNotification(String title, String body, String messageId) {
            if (!notificationsAllowed()) return;
            long seq = parseMessageId(messageId);
            markNotificationSeen(messageId);
            DwellNotificationJobService.show(MainActivity.this, title, body, seq > 0 ? seq : System.currentTimeMillis());
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

        private void saveBackend(String endpoint, String token, boolean enable) {
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            DwellNotificationJobService.schedule(this);
        }
        evaluate("window.onNativeNotificationChanged&&window.onNativeNotificationChanged()");
    }
}
