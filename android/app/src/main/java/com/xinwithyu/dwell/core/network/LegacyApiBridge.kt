package com.xinwithyu.dwell.core.network

import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Keeps the paired-device token on the native side of the Legacy WebView boundary. */
class LegacyApiBridge(
    webView: WebView,
    private val endpoint: String,
    private val deviceToken: String,
) {
    private val view = WeakReference(webView)
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    @JavascriptInterface
    fun request(id: String, methodValue: String, pathValue: String, body: String?, headersValue: String?) {
        if (id.length !in 1..120) return
        val method = methodValue.uppercase().takeIf { it in setOf("GET", "POST", "PUT", "PATCH", "DELETE") }
            ?: return complete(id, 400, "{\"ok\":false,\"error\":\"invalid_method\"}")
        val path = pathValue.takeIf { it.startsWith("/api/") && !it.contains("\\") && !it.contains("\u0000") }
            ?: return complete(id, 400, "{\"ok\":false,\"error\":\"invalid_path\"}")
        if (endpoint.isBlank() || deviceToken.isBlank()) return complete(id, 503, "{\"ok\":false,\"error\":\"not_connected\"}")

        Thread {
            try {
                val headers = runCatching { JSONObject(headersValue.orEmpty()) }.getOrDefault(JSONObject())
                val contentType = headers.optString("content-type", "application/json; charset=utf-8")
                val requestBody = if (method in setOf("POST", "PUT", "PATCH")) {
                    body.orEmpty().take(1_500_000).toRequestBody(contentType.toMediaTypeOrNull())
                } else null
                val request = Request.Builder()
                    .url(endpoint.trimEnd('/') + path)
                    .header("Accept", headers.optString("accept", "application/json"))
                    .header("Authorization", "DwellDevice $deviceToken")
                    .method(method, requestBody)
                    .build()
                client.newCall(request).execute().use { response ->
                    complete(id, response.code, response.body?.string().orEmpty().take(4_000_000))
                }
            } catch (error: Throwable) {
                val bodyValue = JSONObject().put("ok", false).put("error", "native_bridge_failed").put("detail", error.javaClass.simpleName).toString()
                complete(id, 599, bodyValue)
            }
        }.apply { name = "dwell-legacy-api"; isDaemon = true }.start()
    }

    private fun complete(id: String, status: Int, body: String) {
        val webView = view.get() ?: return
        webView.post {
            if (!webView.isAttachedToWindow) return@post
            webView.evaluateJavascript(
                "window.__dwellNativeResolve&&window.__dwellNativeResolve(${JSONObject.quote(id)},$status,${JSONObject.quote(body)})",
                null,
            )
        }
    }

    companion object {
        const val NAME = "DwellNativeApi"
        const val VIRTUAL_ORIGIN = "https://dwell-native.invalid"
        val bootstrapScript = """
            <script>
            (function(){
              const origin=${JSONObject.quote(VIRTUAL_ORIGIN)};
              const pending=new Map();
              let sequence=0;
              window.DWELL_API_BASE=origin;
              window.DWELL_LAN_BASE=origin;
              window.DWELL_REMOTE_BASE='';
              window.DWELL_API_TOKEN='';
              window.DWELL_DEMO=false;
              window.__dwellNativeResolve=function(id,status,body){
                const entry=pending.get(id); if(!entry)return; pending.delete(id);
                entry.resolve(new Response(String(body||''),{status:Number(status)||500,headers:{'Content-Type':'application/json; charset=utf-8'}}));
              };
              const browserFetch=window.fetch.bind(window);
              window.fetch=function(input,init){
                const raw=String(typeof input==='string'?input:(input&&input.url)||'');
                if(!raw.startsWith(origin)) return browserFetch(input,init);
                const id='legacy-'+Date.now()+'-'+(++sequence);
                const url=new URL(raw);
                const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
                const headers={}; new Headers((input&&input.headers)||(init&&init.headers)||{}).forEach((value,key)=>headers[key]=value);
                const body=init&&typeof init.body==='string'?init.body:'';
                return new Promise((resolve,reject)=>{
                  pending.set(id,{resolve,reject});
                  try{ window.${NAME}.request(id,method,url.pathname+url.search,body,JSON.stringify(headers)); }
                  catch(error){ pending.delete(id); reject(error); }
                });
              };
            })();
            </script>
        """.trimIndent()
    }
}
