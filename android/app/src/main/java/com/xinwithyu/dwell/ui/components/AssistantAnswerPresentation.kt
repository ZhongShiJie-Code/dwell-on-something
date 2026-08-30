package com.xinwithyu.dwell.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.net.URI

private val sourceUrlPattern = Regex("""https?://[^\s<>\"'，。；：！？、）】》〉」』]+""", RegexOption.IGNORE_CASE)
private val trailingUrlPunctuation = ".,，。;；:：!！?？)]}」』〉》"
private val defaultFollowUps = listOf("请继续展开说明。", "请给出一个具体例子。")

data class AnswerSource(val url: String) {
    val domain: String
        get() = runCatching { URI(url).host?.removePrefix("www.").orEmpty() }
            .getOrDefault("")
            .ifBlank { url }
}

fun answerSources(text: String): List<AnswerSource> = sourceUrlPattern.findAll(text)
    .map { it.value.trimEnd { character -> character in trailingUrlPunctuation } }
    .filter { it.isNotBlank() }
    .distinct()
    .map(::AnswerSource)
    .toList()

fun answerFollowUps(text: String): List<String> = if (text.isBlank()) emptyList() else defaultFollowUps

@Composable
fun AssistantAnswerPresentation(
    answer: String,
    onOpenSource: (String) -> Unit,
    onFollowUp: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val sources = remember(answer) { answerSources(answer) }
    val followUps = remember(answer) { answerFollowUps(answer) }
    var sourcesOpen by remember(answer) { mutableStateOf(false) }

    Column(modifier.fillMaxWidth()) {
        if (sources.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clickable(role = Role.Button) { sourcesOpen = !sourcesOpen }
                    .padding(end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Link, null, Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(7.dp))
                Text("${sources.size} 个来源", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(3.dp))
                Icon(
                    if (sourcesOpen) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                    if (sourcesOpen) "收起来源" else "展开来源",
                    Modifier.size(19.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            AnimatedVisibility(sourcesOpen) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.52f), RoundedCornerShape(14.dp))
                        .padding(4.dp),
                ) {
                    sources.forEach { source ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .defaultMinSize(minHeight = 48.dp)
                                .clickable(role = Role.Button) { onOpenSource(source.url) }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Link, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(9.dp))
                            Text(
                                source.domain,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Icon(Icons.AutoMirrored.Outlined.OpenInNew, "在浏览器打开 ${source.domain}", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }

        if (followUps.isNotEmpty()) {
            Text(
                "继续追问",
                modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                followUps.forEach { followUp ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp)
                            .clickable(role = Role.Button) { onFollowUp(followUp) }
                            .padding(horizontal = 4.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("↳", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(9.dp))
                        Text(followUp, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}
