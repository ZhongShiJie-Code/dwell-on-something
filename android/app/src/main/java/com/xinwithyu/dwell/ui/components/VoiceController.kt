package com.xinwithyu.dwell.ui.components

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import java.util.Locale

class NativeVoiceController(
    context: Context,
    private val onPartial: (String) -> Unit,
    private val onResult: (String) -> Unit,
    private val onState: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
) : RecognitionListener {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null

    fun start(): Boolean {
        if (!SpeechRecognizer.isRecognitionAvailable(appContext)) {
            onError("这台手机没有可用的系统语音识别服务")
            return false
        }
        recognizer?.destroy()
        recognizer = if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        } else SpeechRecognizer.createSpeechRecognizer(appContext)
        recognizer?.setRecognitionListener(this)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 900L)
        }
        recognizer?.startListening(intent)
        onState(true)
        return true
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        onState(false)
    }

    override fun onReadyForSpeech(params: Bundle?) = onState(true)
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = onState(false)
    override fun onEvent(eventType: Int, params: Bundle?) = Unit

    override fun onError(error: Int) {
        onState(false)
        onError(
            when (error) {
                SpeechRecognizer.ERROR_AUDIO -> "麦克风音频读取失败"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "请允许 Dwell 使用麦克风"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别网络不可用"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "语音识别正在忙，请稍后再试"
                SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，请再说一次"
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有听到声音，请再试一次"
                SpeechRecognizer.ERROR_CLIENT -> "语音识别刚刚中断，请再点一次"
                else -> "语音识别失败（$error）"
            },
        )
    }

    override fun onResults(results: Bundle?) {
        onState(false)
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
            ?.takeIf { it.isNotEmpty() }?.let(onResult)
    }

    override fun onPartialResults(partialResults: Bundle?) {
        partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
            ?.takeIf { it.isNotEmpty() }?.let(onPartial)
    }
}

class DwellSpeechPlayer(context: Context, private val onReady: (Boolean) -> Unit = {}) : TextToSpeech.OnInitListener {
    private val tts = TextToSpeech(context.applicationContext, this)
    private var ready = false

    override fun onInit(status: Int) {
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            val result = tts.setLanguage(Locale.SIMPLIFIED_CHINESE)
            ready = result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED
            tts.setSpeechRate(0.96f)
            tts.setPitch(1.0f)
        }
        onReady(ready)
    }

    fun speak(markdown: String) {
        if (!ready) return
        val clean = sanitizeForSpeech(markdown)
        if (clean.isNotBlank()) tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "dwell-${System.nanoTime()}")
    }

    fun stop() = tts.stop()
    fun destroy() { tts.stop(); tts.shutdown() }
}

fun sanitizeForSpeech(markdown: String): String = markdown
    .replace(Regex("```[\\s\\S]*?```"), " 代码段。 ")
    .replace(Regex("`([^`]+)`"), "$1")
    .replace(Regex("!\\[[^]]*]\\([^)]*\\)"), " 图片。 ")
    .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
    .replace(Regex("https?://\\S+"), " 链接。 ")
    .replace(Regex("[*_~>#]+"), "")
    .replace(Regex("^\\s*[-+]\\s+", RegexOption.MULTILINE), "")
    .replace(Regex("^\\s*\\d+[.)]\\s+", RegexOption.MULTILINE), "")
    .replace(Regex("\\s+"), " ")
    .trim()
