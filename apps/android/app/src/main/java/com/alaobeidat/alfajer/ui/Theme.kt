package com.alaobeidat.alfajer.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Brand = Color(0xFF2563EB)
val BrandLight = Color(0xFF60A5FA)
val Emerald = Color(0xFF10B981)
val Amber = Color(0xFFF59E0B)
val Danger = Color(0xFFEF4444)
val Slate = Color(0xFF94A3B8)

private val Light = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    background = Color(0xFFF8FAFC),
    surface = Color.White,
    surfaceVariant = Color(0xFFE2E8F0),
    error = Danger,
)

private val Dark = darkColorScheme(
    primary = BrandLight,
    onPrimary = Color(0xFF0B1120),
    background = Color(0xFF0B1120),
    surface = Color(0xFF111827),
    surfaceVariant = Color(0xFF1E293B),
    error = Danger,
)

@Composable
fun AlfajerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
