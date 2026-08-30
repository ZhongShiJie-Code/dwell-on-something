package com.xinwithyu.dwell.ui.screens

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowBackIosNew
import androidx.compose.material.icons.automirrored.outlined.ArrowForwardIos
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material.icons.outlined.ThumbUp
import androidx.compose.material.icons.outlined.Waves
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.xinwithyu.dwell.core.model.MessageDto
import com.xinwithyu.dwell.core.model.ModelView
import com.xinwithyu.dwell.core.repository.PendingAttachment
import com.xinwithyu.dwell.ui.components.ActionPill
import com.xinwithyu.dwell.ui.components.AssistantAnswerPresentation
import com.xinwithyu.dwell.ui.components.AddToChatSheet
import com.xinwithyu.dwell.ui.components.ChatComposer
import com.xinwithyu.dwell.ui.components.ClaudeBurst
import com.xinwithyu.dwell.ui.components.DwellIconButton
import com.xinwithyu.dwell.ui.components.DwellSheet
import com.xinwithyu.dwell.ui.components.DwellSpeechPlayer
import com.xinwithyu.dwell.ui.components.NativeVoiceController
import com.xinwithyu.dwell.ui.components.ModelSheet
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private data class VariantGroup(val root: Long, val variants: List<MessageDto>, val position: Int)

@Composable
fun ChatScreen(
    messages: List<MessageDto>,
    activeChatId: String,
    activeChatName: String,
    busy: Boolean,
    streamingText: String,
    streamingThought: String,
    model: ModelView,
    webSearch: Boolean,
    error: String,
    onMenu: () -> Unit,
    onNewChat: () -> Unit,
    onOpenChats: () -> Unit,
    onSettings: () -> Unit,
    onRename: (String) -> Unit,
    onSend: (String, List<PendingAttachment>) -> Unit,
    onStop: () -> Unit,
    onRegenerate: (Long) -> Unit,
    onFeedback: (Long, String) -> Unit,
    onSelectModel: (String, String) -> Unit,
    onWebSearch: (Boolean) -> Unit,
    onDraftChanged: (String) -> Unit,
    initialDraft: String,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var draft by remember(activeChatId) { mutableStateOf(initialDraft) }
    var addVisible by remember { mutableStateOf(false) }
    var modelVisible by remember { mutableStateOf(false) }
    var moreVisible by remember { mutableStateOf(false) }
    var renameVisible by remember { mutableStateOf(false) }
    var renameText by remember(activeChatId, activeChatName) { mutableStateOf(activeChatName) }
    var detailSheet by remember { mutableStateOf<Pair<String, String>?>(null) }
    var listening by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf("") }
    var attachments by remember(activeChatId) { mutableStateOf<List<PendingAttachment>>(emptyList()) }
    val variantSelection = remember { mutableStateMapOf<Long, Int>() }
    val speechPlayer = remember { DwellSpeechPlayer(context) }
    val voice = remember {
        NativeVoiceController(
            context,
            onPartial = { draft = mergeVoice(draft, it) },
            onResult = { draft = mergeVoice(draft, it); onDraftChanged(draft) },
            onState = { listening = it },
            onError = { localError = it },
        )
    }
    DisposableEffect(Unit) { onDispose { voice.destroy(); speechPlayer.destroy() } }

    val fallbackVoice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
            ?.takeIf { it.isNotEmpty() }?.let {
                draft = mergeVoice(draft, it)
                onDraftChanged(draft)
            }
    }
    val launchVoiceFallback = {
        runCatching {
            fallbackVoice.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话")
            })
        }.onFailure { localError = "系统语音输入也不可用，请检查三星语音或 Google 语音服务" }
        Unit
    }

    val microphonePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && !voice.start()) launchVoiceFallback() else if (!granted) localError = "请在系统设置中允许 Claude Cli 使用麦克风"
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap != null) attachments = attachments + bitmapAttachment(bitmap)
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        scope.launch {
            attachments = attachments + uris.take(6).mapNotNull { uri ->
                val result = readAttachment(context, uri)
                result.exceptionOrNull()?.let { localError = it.message.orEmpty() }
                result.getOrNull()
            }
        }
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        scope.launch {
            attachments = attachments + uris.take(6).mapNotNull { uri ->
                val result = readAttachment(context, uri)
                result.exceptionOrNull()?.let { localError = it.message.orEmpty() }
                result.getOrNull()
            }
        }
    }

    val grouped = remember(messages, variantSelection.toMap()) { displayMessages(messages, variantSelection) }
    LaunchedEffect(grouped.size, streamingText.length) {
        if (grouped.isNotEmpty() || streamingText.isNotBlank()) listState.animateScrollToItem(grouped.size + if (streamingText.isNotBlank()) 1 else 0)
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxSize().imePadding()) {
            ChatTopBar(onMenu, onNewChat, { moreVisible = true })

            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(top = 18.dp, start = 22.dp, end = 22.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                if (grouped.isEmpty() && streamingText.isBlank()) {
                    item(key = "empty") { EmptyConversation(Modifier.fillParentMaxHeight(0.66f)) }
                }
                items(grouped, key = { "${it.first.seq}:${it.second?.root ?: 0}" }) { (message, group) ->
                    when (message.kind) {
                        "me" -> UserMessage(message)
                        "gu" -> AssistantMessage(
                            message = message,
                            group = group,
                            onPrevious = {
                                group ?: return@AssistantMessage
                                val current = variantSelection[group.root] ?: (group.variants.size - 1)
                                variantSelection[group.root] = (current - 1).coerceAtLeast(0)
                            },
                            onNext = {
                                group ?: return@AssistantMessage
                                val current = variantSelection[group.root] ?: (group.variants.size - 1)
                                variantSelection[group.root] = (current + 1).coerceAtMost(group.variants.size - 1)
                            },
                            onSpeak = { speechPlayer.speak(message.text) },
                            onRegenerate = { onRegenerate(message.seq) },
                            onFeedback = { value -> onFeedback(message.seq, value) },
                            onDetail = { title, body -> detailSheet = title to body },
                            onFollowUp = { followUp -> onSend(followUp, emptyList()) },
                        )
                        "think" -> ThoughtCard(message.text) { detailSheet = "Thought process" to message.text }
                        "tool" -> ToolCard(message)
                    }
                }
                if (streamingThought.isNotBlank()) item(key = "stream-thinking") { ThoughtCard(streamingThought) { detailSheet = "Thought process" to streamingThought } }
                if (streamingText.isNotBlank()) item(key = "stream-text") { StreamingMessage(streamingText) }
            }

            ChatComposer(
                text = draft,
                modelName = model.items.find { it.id == model.model }?.name ?: model.model.ifBlank { "Mac 默认模型" },
                busy = busy,
                listening = listening,
                attachmentNames = attachments.map { it.name },
                onTextChange = { draft = it; onDraftChanged(it) },
                onAdd = { addVisible = true },
                onModel = { modelVisible = true },
                onVoice = {
                    if (listening) voice.stop()
                    else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        if (!voice.start()) launchVoiceFallback()
                    }
                    else microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
                },
                onSend = {
                    onSend(draft, attachments)
                    draft = ""
                    attachments = emptyList()
                    onDraftChanged("")
                },
                onStop = onStop,
                onRemoveAttachment = { index -> attachments = attachments.filterIndexed { itemIndex, _ -> itemIndex != index } },
                modifier = Modifier.navigationBarsPadding(),
            )
        }

        val visibleError = localError.ifBlank { error }
        AnimatedVisibility(visible = visibleError.isNotBlank(), modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 64.dp, start = 18.dp, end = 18.dp)) {
            Text(
                visibleError,
                modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(18.dp))
                    .clickable(role = Role.Button) { localError = "" }.padding(horizontal = 14.dp, vertical = 11.dp),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }

    AddToChatSheet(
        visible = addVisible,
        webSearch = webSearch,
        onWebSearch = onWebSearch,
        onCamera = { addVisible = false; camera.launch(null) },
        onPhotos = { addVisible = false; photos.launch("image/*") },
        onFiles = { addVisible = false; files.launch(arrayOf("text/*", "application/json", "image/*")) },
        onProject = { detailSheet = "Add to project" to "当前会话使用 Mac 上已连接的工作目录。" },
        onToolAccess = { detailSheet = "Tool access" to "Auto：由 Mac 后端按当前安全配置调用 Claude Code 工具。" },
        onConnectors = { detailSheet = "Connectors" to "连接器由 Mac 上的 Claude Code 配置提供；手机不会保存连接器凭据。" },
        onDismiss = { addVisible = false },
    )
    ModelSheet(modelVisible, model, onSelectModel) { modelVisible = false }
    DwellSheet(moreVisible, { moreVisible = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 8.dp)) {
            Text("会话", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp))
            MoreOption("查看所有会话") { moreVisible = false; onOpenChats() }
            if (activeChatId.isNotBlank() && activeChatId != "__new__") {
                MoreOption("重命名当前会话") { moreVisible = false; renameVisible = true }
            }
            MoreOption("设置") { moreVisible = false; onSettings() }
        }
    }
    if (renameVisible) {
        AlertDialog(
            onDismissRequest = { renameVisible = false },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(renameText, { renameText = it.take(80) }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                TextButton(onClick = {
                    val name = renameText.trim()
                    if (name.isNotEmpty()) onRename(name)
                    renameVisible = false
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameVisible = false }) { Text("取消") } },
        )
    }
    detailSheet?.let { (title, body) ->
        DwellSheet(true, { detailSheet = null }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(20.dp))
                Text(markdown(body), style = MaterialTheme.typography.bodyLarge)
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}

@Composable
private fun MoreOption(label: String, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.bodyLarge,
        modifier = Modifier.fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 16.dp),
    )
}

@Composable
private fun ChatTopBar(onMenu: () -> Unit, onNewChat: () -> Unit, onMore: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().statusBarsPadding().defaultMinSize(minHeight = 68.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DwellIconButton(Icons.Outlined.Menu, "菜单", onMenu)
        Spacer(Modifier.weight(1f))
        Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.onBackground, CircleShape).clickable(role = Role.Button, onClick = onNewChat), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Add, "新会话", tint = MaterialTheme.colorScheme.background, modifier = Modifier.size(22.dp))
        }
        DwellIconButton(Icons.Outlined.MoreVert, "更多", onMore)
    }
}

@Composable
private fun EmptyConversation(modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        ClaudeBurst()
        Spacer(Modifier.height(16.dp))
        Text("What’s cooking, ShiJie?", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
    }
}

@Composable
private fun UserMessage(message: MessageDto) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(horizontalAlignment = Alignment.End) {
            Text(
                message.text,
                modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(21.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
                style = MaterialTheme.typography.bodyLarge,
            )
            MessageTime(message.at)
        }
    }
}

@Composable
private fun AssistantMessage(
    message: MessageDto,
    group: VariantGroup?,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onSpeak: () -> Unit,
    onRegenerate: () -> Unit,
    onFeedback: (String) -> Unit,
    onDetail: (String, String) -> Unit,
    onFollowUp: (String) -> Unit,
) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth()) {
        Text(markdown(message.text), style = MaterialTheme.typography.bodyLarge)
        if (message.text.length > 420) {
            Row(Modifier.padding(top = 12.dp)) {
                ActionPill({ onDetail("Summary", summaryOf(message.text)) }) {
                    Icon(Icons.Outlined.Waves, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Summary")
                }
            }
        }
        if (group != null && group.variants.size > 1) {
            Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevious, enabled = group.position > 0, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.ArrowBackIosNew, "上一个版本", Modifier.size(15.dp)) }
                Text("${group.position + 1} / ${group.variants.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                IconButton(onClick = onNext, enabled = group.position < group.variants.lastIndex, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Outlined.ArrowForwardIos, "下一个版本", Modifier.size(15.dp)) }
            }
        }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            MessageAction(Icons.Outlined.ContentCopy, "复制") {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Claude", message.text))
            }
            MessageAction(Icons.Outlined.Share, "转发") {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, message.text) }, "转发回答"))
            }
            MessageAction(Icons.Outlined.PlayArrow, "播放", onClick = onSpeak)
            MessageAction(Icons.Outlined.ThumbUp, "有帮助", selected = message.feedback == "up") { onFeedback(if (message.feedback == "up") "" else "up") }
            MessageAction(Icons.Outlined.ThumbDown, "没帮助", selected = message.feedback == "down") { onFeedback(if (message.feedback == "down") "" else "down") }
            MessageAction(Icons.Outlined.Refresh, "重新生成", onClick = onRegenerate)
        }
        AssistantAnswerPresentation(
            answer = message.text,
            onOpenSource = { url ->
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                    .onFailure { onDetail("来源链接", url) }
            },
            onFollowUp = onFollowUp,
            modifier = Modifier.padding(top = 2.dp),
        )
        MessageTime(message.at)
    }
}

@Composable
private fun ThoughtCard(text: String, onClick: () -> Unit) {
    ActionPill(onClick) { Text("◷  Thought process  ›", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun ToolCard(message: MessageDto) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.62f), RoundedCornerShape(16.dp)).padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Waves, null, Modifier.size(19.dp))
        Spacer(Modifier.width(10.dp))
        Column { Text(message.text, style = MaterialTheme.typography.labelLarge); if (!message.extra.isNullOrBlank()) Text(message.extra.take(160), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun StreamingMessage(text: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(markdown(text), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) { ClaudeBurst(Modifier.size(24.dp)); Spacer(Modifier.width(8.dp)); Text("Claude 正在回复", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun MessageAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, selected: Boolean = false, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp).semantics { this.selected = selected }) {
        Icon(icon, label, Modifier.size(19.dp), tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MessageTime(at: Long) {
    if (at <= 0) return
    val value = remember(at) {
        DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(at))
    }
    Text(value, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 5.dp))
}

private fun displayMessages(messages: List<MessageDto>, selection: Map<Long, Int>): List<Pair<MessageDto, VariantGroup?>> {
    val assistants = messages.filter { it.kind == "gu" }
    val roots = assistants.groupBy { it.variantOf ?: it.seq }
        .mapValues { (_, values) -> values.sortedWith(compareBy<MessageDto> { it.version ?: if (it.variantOf == null) 1 else 2 }.thenBy { it.seq }) }
    val out = mutableListOf<Pair<MessageDto, VariantGroup?>>()
    for (message in messages) {
        if (!isMobileVisibleMessageKind(message.kind)) continue
        if (message.kind != "gu") { out += message to null; continue }
        if (message.variantOf != null) continue
        val variants = roots[message.seq].orEmpty()
        val position = (selection[message.seq] ?: variants.lastIndex).coerceIn(0, variants.lastIndex.coerceAtLeast(0))
        val selected = variants.getOrElse(position) { message }
        out += selected to VariantGroup(message.seq, variants, position)
    }
    return out
}

private fun markdown(raw: String): AnnotatedString = buildAnnotatedString {
    val text = raw.replace(Regex("(?m)^#{1,6}\\s+"), "").replace(Regex("(?m)^\\s*[-*]\\s+"), "• ")
    var cursor = 0
    val pattern = Regex("(\\*\\*[^*]+\\*\\*|`[^`]+`)")
    for (match in pattern.findAll(text)) {
        append(text.substring(cursor, match.range.first))
        val value = match.value
        if (value.startsWith("**")) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(value.removePrefix("**").removeSuffix("**")) }
        else withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color.Gray.copy(alpha = 0.13f))) { append(value.removePrefix("`").removeSuffix("`")) }
        cursor = match.range.last + 1
    }
    append(text.substring(cursor).replace("**", "").replace("__", ""))
}

private fun summaryOf(text: String): String = text.split(Regex("""\n\s*\n""")).filter { it.isNotBlank() }.take(3).joinToString("\n\n").take(700)
private fun mergeVoice(current: String, recognized: String): String = if (current.isBlank()) recognized else if (current.endsWith(recognized)) current else "$current $recognized"

private fun bitmapAttachment(bitmap: Bitmap): PendingAttachment {
    val bytes = ByteArrayOutputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output); output.toByteArray() }
    return PendingAttachment("相机照片.jpg", buildJsonObject {
        put("kind", "image"); put("name", "相机照片.jpg"); put("media_type", "image/jpeg"); put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    })
}

private suspend fun readAttachment(context: Context, uri: Uri): Result<PendingAttachment> = withContext(Dispatchers.IO) { runCatching {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri).orEmpty()
    var name = "附件"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) name = cursor.getString(0) ?: name
    }
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("无法读取 $name")
    require(bytes.size <= 12 * 1024 * 1024) { "$name 超过 12 MB" }
    when {
        mime.startsWith("image/") -> PendingAttachment(name, buildJsonObject {
            put("kind", "image"); put("name", name); put("media_type", mime.ifBlank { "image/jpeg" }); put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
        })
        bytes.size <= 1_500_000 -> PendingAttachment(name, buildJsonObject {
            put("kind", "text"); put("name", name); put("text", bytes.toString(Charsets.UTF_8))
        })
        else -> error("当前支持图片和 1.5 MB 以内的文本文件")
    }
} }
