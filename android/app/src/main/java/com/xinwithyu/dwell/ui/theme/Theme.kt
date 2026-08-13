package com.xinwithyu.dwell.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.xinwithyu.dwell.R
import com.xinwithyu.dwell.core.settings.ThemeMode

val DwellAccent = Color(0xFFC86443)
val DwellLightBackground = Color(0xFFFAF9F5)
val DwellDarkBackground = Color(0xFF242422)
val DwellLightCard = Color(0xFFF1EFE9)
val DwellDarkCard = Color(0xFF343431)

val DwellSerif = FontFamily(Font(R.font.cormorant_garamond, FontWeight.Normal))

private val lightColors = lightColorScheme(
    primary = DwellAccent,
    onPrimary = Color.White,
    background = DwellLightBackground,
    onBackground = Color(0xFF242421),
    surface = Color(0xFFFFFEFB),
    onSurface = Color(0xFF242421),
    surfaceVariant = DwellLightCard,
    onSurfaceVariant = Color(0xFF6F6D68),
    outline = Color(0xFFD8D5CE),
    error = Color(0xFFB3261E),
)

private val darkColors = darkColorScheme(
    primary = Color(0xFFD57958),
    onPrimary = Color(0xFF21100A),
    background = DwellDarkBackground,
    onBackground = Color(0xFFF1F0EB),
    surface = Color(0xFF292927),
    onSurface = Color(0xFFF1F0EB),
    surfaceVariant = DwellDarkCard,
    onSurfaceVariant = Color(0xFFAAA8A2),
    outline = Color(0xFF55534F),
    error = Color(0xFFFFB4AB),
)

private val dwellTypography = Typography(
    displayLarge = TextStyle(fontFamily = DwellSerif, fontWeight = FontWeight.Medium, fontSize = 48.sp, lineHeight = 52.sp),
    headlineLarge = TextStyle(fontFamily = DwellSerif, fontWeight = FontWeight.Medium, fontSize = 36.sp, lineHeight = 40.sp),
    headlineMedium = TextStyle(fontFamily = DwellSerif, fontWeight = FontWeight.Medium, fontSize = 30.sp, lineHeight = 34.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 25.sp, letterSpacing = 0.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 21.sp, letterSpacing = 0.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
)

@Composable
fun DwellTheme(mode: ThemeMode, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    MaterialTheme(
        colorScheme = if (dark) darkColors else lightColors,
        typography = dwellTypography,
        content = content,
    )
}
