package com.xinwithyu.dwell.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.xinwithyu.dwell.ui.theme.DwellAccent
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun DwellIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onBackground,
) {
    IconButton(onClick = onClick, modifier = modifier.size(48.dp)) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DwellSheet(
    visible: Boolean,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (!visible) return
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        modifier = modifier,
        shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 0.dp,
        scrimColor = Color.Black.copy(alpha = 0.34f),
        dragHandle = {
            Box(
                Modifier.padding(top = 10.dp, bottom = 8.dp).size(width = 54.dp, height = 5.dp)
                    .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.45f), CircleShape),
            )
        },
        contentWindowInsets = { WindowInsets.navigationBars },
    ) {
        Box(Modifier.fillMaxWidth().padding(bottom = 12.dp)) { content() }
    }
}

@Composable
fun ClaudeBurst(modifier: Modifier = Modifier, color: Color = DwellAccent) {
    Canvas(modifier.size(58.dp)) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val outer = size.minDimension * 0.43f
        val inner = size.minDimension * 0.10f
        repeat(12) { index ->
            val angle = index * (2f * PI.toFloat() / 12f) - PI.toFloat() / 2f
            val stagger = if (index % 3 == 0) inner * 0.52f else if (index % 2 == 0) inner * 1.34f else inner
            drawLine(
                color = color,
                start = Offset(center.x + cos(angle) * stagger, center.y + sin(angle) * stagger),
                end = Offset(center.x + cos(angle) * outer, center.y + sin(angle) * outer),
                strokeWidth = size.minDimension * 0.075f,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
fun GhostMark(modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onBackground) {
    Canvas(modifier.size(30.dp)) {
        val stroke = size.minDimension * 0.075f
        val body = Path().apply {
            moveTo(size.width * 0.18f, size.height * 0.82f)
            lineTo(size.width * 0.18f, size.height * 0.43f)
            cubicTo(size.width * 0.18f, size.height * 0.14f, size.width * 0.82f, size.height * 0.14f, size.width * 0.82f, size.height * 0.43f)
            lineTo(size.width * 0.82f, size.height * 0.82f)
            lineTo(size.width * 0.68f, size.height * 0.70f)
            lineTo(size.width * 0.55f, size.height * 0.82f)
            lineTo(size.width * 0.42f, size.height * 0.70f)
            lineTo(size.width * 0.29f, size.height * 0.82f)
        }
        drawPath(body, color, style = Stroke(width = stroke, cap = StrokeCap.Round))
        drawCircle(color, stroke * 0.65f, Offset(size.width * 0.39f, size.height * 0.43f))
        drawCircle(color, stroke * 0.65f, Offset(size.width * 0.62f, size.height * 0.43f))
    }
}

@Composable
fun ActionPill(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    androidx.compose.foundation.layout.Row(
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(999.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}
