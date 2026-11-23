package com.mykiwi.vault.util

import android.content.Context
import android.content.Intent

object KiwiLauncher {
    private val KIWI_PACKAGES = listOf(
        "com.kiwibrowser.browser.dev",
        "com.kiwibrowser.browser"
    )

    fun launchKiwiForCapture(context: Context): Boolean {
        val pm = context.packageManager
        for (pkg in KIWI_PACKAGES) {
            val launchIntent = pm.getLaunchIntentForPackage(pkg)
            if (launchIntent != null) {
                return try {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(launchIntent)
                    true
                } catch (_: Exception) {
                    false
                }
            }
        }
        return false
    }
}
