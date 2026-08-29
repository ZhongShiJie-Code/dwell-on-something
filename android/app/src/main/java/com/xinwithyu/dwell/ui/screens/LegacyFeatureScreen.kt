package com.xinwithyu.dwell.ui.screens

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.webkit.WebViewAssetLoader
import com.xinwithyu.dwell.core.network.LegacyApiBridge
import com.xinwithyu.dwell.ui.components.DwellIconButton
import java.io.ByteArrayInputStream
import org.json.JSONObject

@Composable
fun LegacyFeatureScreen(feature: String, endpoint: String, deviceToken: String, safeMode: Boolean, dark: Boolean, onBack: () -> Unit) {
    val context = LocalContext.current
    var generation by remember { mutableIntStateOf(0) }
    var currentView by remember { mutableStateOf<WebView?>(null) }
    var renderError by remember { mutableStateOf("") }
    val title = legacyFeatures[feature]?.first ?: "Claude Cli"
    val navId = legacyFeatures[feature]?.second ?: ""

    fun handleBack() {
        val view = currentView
        if (view == null) return onBack()
        view.evaluateJavascript("Boolean(window.dwellHandleBack&&window.dwellHandleBack())") { handled ->
            if (handled != "true") onBack()
        }
    }
    BackHandler(onBack = ::handleBack)

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 64.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            DwellIconButton(Icons.AutoMirrored.Outlined.ArrowBack, "返回", ::handleBack)
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 8.dp))
        }
        if (safeMode) {
            Text("Claude Cli 检测到短时间连续崩溃，已暂时停用旧页面。聊天、会话和定时任务仍可正常使用；稳定运行两分钟后会自动解除。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
            return@Column
        }
        if (renderError.isNotBlank()) {
            Text(renderError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
        }
        key(generation, dark) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    val loader = legacyAssetLoader(context, dark)
                    WebView(context).apply {
                        currentView = this
                        setBackgroundColor(if (dark) android.graphics.Color.rgb(36, 36, 34) else android.graphics.Color.rgb(250, 249, 245))
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.setSupportZoom(false)
                        settings.builtInZoomControls = false
                        settings.displayZoomControls = false
                        settings.mediaPlaybackRequiresUserGesture = true
                        addJavascriptInterface(LegacyApiBridge(this, endpoint, deviceToken), LegacyApiBridge.NAME)
                        if (android.os.Build.VERSION.SDK_INT >= 26) setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true)
                        webViewClient = object : WebViewClient() {
                            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                if (request.url.host == "appassets.androidplatform.net") return false
                                return try { context.startActivity(Intent(Intent.ACTION_VIEW, request.url)); true } catch (_: ActivityNotFoundException) { true }
                            }
                            override fun onPageFinished(view: WebView, url: String) {
                                renderError = ""
                                if (navId.isNotBlank()) view.evaluateJavascript("document.getElementById(${JSONObject.quote(navId)})?.click()", null)
                            }
                            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                                renderError = "这个旧页面刚刚停止了，正在单独恢复；聊天不会退出。"
                                currentView = null
                                view.destroy()
                                generation++
                                return true
                            }
                        }
                        loadUrl("https://appassets.androidplatform.net/legacy/index.html")
                    }
                },
                update = { currentView = it },
                onRelease = { view ->
                    if (currentView == view) currentView = null
                    view.stopLoading()
                    view.destroy()
                },
            )
        }
    }
}

private fun legacyAssetLoader(context: android.content.Context, dark: Boolean): WebViewAssetLoader {
    val handler = WebViewAssetLoader.PathHandler { path ->
        try {
            val assetPath = path.ifBlank { "index.html" }
            val raw = context.assets.open(assetPath).use { it.readBytes() }
            val extension = MimeTypeMap.getFileExtensionFromUrl(assetPath)
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: when (extension) {
                "js" -> "text/javascript"
                "css" -> "text/css"
                "html" -> "text/html"
                else -> "application/octet-stream"
            }
            val bytes = if (assetPath == "index.html") {
                val theme = if (dark) "dark" else "light"
                val themeScript = """
                    <script>
                    (function () {
                      const nativeTheme = '$theme';
                      const themeKeys = new Set(['homeTheme', 'theme', 'themeMode']);
                      const root = document.documentElement;
                      const originalGetItem = Storage.prototype.getItem;
                      const originalSetItem = Storage.prototype.setItem;
                      const originalRemoveItem = Storage.prototype.removeItem;
                      const originalClear = Storage.prototype.clear;
                      const isThemeKey = function (key) { return themeKeys.has(String(key)); };
                      const writeNativeTheme = function (storage) {
                        themeKeys.forEach(function (key) {
                          try { originalSetItem.call(storage, key, nativeTheme); } catch (e) {}
                        });
                      };
                      try {
                        Storage.prototype.getItem = function (key) {
                          return isThemeKey(key) ? nativeTheme : originalGetItem.call(this, key);
                        };
                        Storage.prototype.setItem = function (key, value) {
                          return originalSetItem.call(this, key, isThemeKey(key) ? nativeTheme : value);
                        };
                        Storage.prototype.removeItem = function (key) {
                          return isThemeKey(key) ? originalSetItem.call(this, key, nativeTheme) : originalRemoveItem.call(this, key);
                        };
                        Storage.prototype.clear = function () {
                          originalClear.call(this);
                          writeNativeTheme(this);
                        };
                        originalSetItem.call(localStorage, 'themeAutoMigration046', '1');
                        writeNativeTheme(localStorage);
                        themeKeys.forEach(function (key) {
                          try {
                            Object.defineProperty(localStorage, key, {
                              configurable: false,
                              enumerable: true,
                              get: function () { return nativeTheme; },
                              set: function () { writeNativeTheme(localStorage); },
                            });
                          } catch (e) {}
                        });
                      } catch (e) {}
                      const applyNativeTheme = function () {
                        root.dataset.theme = nativeTheme;
                      };
                      applyNativeTheme();
                      new MutationObserver(applyNativeTheme).observe(root, {
                        attributes: true,
                        attributeFilter: ['data-theme'],
                      });
                    })();
                    </script>
                """.trimIndent()
                String(raw, Charsets.UTF_8)
                    .replace("<script>\n/* API 连接层", "$themeScript<script>\n/* API 连接层")
                    .replace("</head>", "${LegacyApiBridge.bootstrapScript}</head>")
                    .toByteArray(Charsets.UTF_8)
            } else raw
            WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("javascript")) "utf-8" else null, ByteArrayInputStream(bytes))
        } catch (_: Throwable) { null }
    }
    return WebViewAssetLoader.Builder().addPathHandler("/legacy/", handler).build()
}

private val legacyFeatures = mapOf(
    "todo" to ("待办" to "navTodo"),
    "calendar" to ("日历" to "navCal"),
    "diary" to ("日记" to "navWall"),
    "nook" to ("共读" to "navNook"),
    "news" to ("日报" to "navNews"),
    "health" to ("健康" to "navHealth"),
    "repo" to ("仓库" to "navRepo"),
)
