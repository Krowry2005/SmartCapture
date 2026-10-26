package com.smartcapture.app

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var root: LinearLayout
    private lateinit var indicator: TextView
    private lateinit var statusText: TextView
    private lateinit var detailText: TextView
    private lateinit var toggle: Button
    private var pulse: ObjectAnimator? = null

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) {
                ContextCompat.startForegroundService(
                    this,
                    MirrorService.createStartIntent(this, result.resultCode, data)
                )
            }
        }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            requestProjection()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        title = "Smart Capture"
        val appTitle = TextView(this).apply {
            text = "Smart Capture"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, 32)
        }
        indicator = TextView(this).apply {
            text = "●"
            textSize = 72f
            gravity = Gravity.CENTER
        }
        statusText = TextView(this).apply {
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
        }
        detailText = TextView(this).apply {
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setPadding(0, 16, 0, 48)
        }
        toggle = Button(this).apply {
            textSize = 18f
            setOnClickListener {
                if (MirrorService.isActive) {
                    startService(MirrorService.createStopIntent(this@MainActivity))
                } else {
                    ensurePermissionsAndStart()
                }
            }
        }

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            addView(appTitle)
            addView(indicator)
            addView(statusText)
            addView(detailText)
            addView(toggle)
        }
        setContentView(root)
        render(MirrorService.isActive)
    }

    override fun onStart() {
        super.onStart()
        // 開き直した時も実際のサービス状態を反映し、以降の変化を購読する
        MirrorService.stateListener = { active -> render(active) }
        render(MirrorService.isActive)
    }

    override fun onStop() {
        MirrorService.stateListener = null
        pulse?.cancel()
        pulse = null
        super.onStop()
    }

    private fun render(active: Boolean) {
        if (active) {
            root.setBackgroundColor(Color.parseColor("#15803D"))
            indicator.setTextColor(Color.parseColor("#BBF7D0"))
            statusText.text = "🟢 配信中（キャプチャ動作中）"
            detailText.text = "画面と音声をキャプチャしています"
            toggle.text = "⏹ ミラーリング停止"
            if (pulse == null) {
                pulse = ObjectAnimator.ofFloat(indicator, "alpha", 1f, 0.2f).apply {
                    duration = 700
                    repeatMode = ValueAnimator.REVERSE
                    repeatCount = ValueAnimator.INFINITE
                    start()
                }
            }
        } else {
            pulse?.cancel()
            pulse = null
            indicator.alpha = 1f
            root.setBackgroundColor(Color.parseColor("#374151"))
            indicator.setTextColor(Color.parseColor("#9CA3AF"))
            statusText.text = "🔴 未接続 / 停止中"
            detailText.text = "開始後、PCアプリが自動で接続します"
            toggle.text = "▶ ミラーリング開始"
        }
    }

    private fun ensurePermissionsAndStart() {
        val missing = buildList {
            if (!isGranted(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33 && !isGranted(Manifest.permission.POST_NOTIFICATIONS)) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (missing.isEmpty()) requestProjection() else permissionLauncher.launch(missing.toTypedArray())
    }

    private fun isGranted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestProjection() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(manager.createScreenCaptureIntent())
    }
}
