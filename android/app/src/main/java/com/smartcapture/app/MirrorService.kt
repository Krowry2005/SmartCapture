package com.smartcapture.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Surface
import androidx.core.app.NotificationCompat
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.max

/**
 * 画面(H.264)と内部音声(AAC-LC)をキャプチャし、localhost の TCP で配信するサービス。
 * PC側は `adb forward tcp:PORT tcp:PORT` 後に 127.0.0.1:PORT へ接続し、
 * 最初に [StreamSettings] (12バイト) を送る。端末はそれを受けてエンコードを開始する。
 *
 * 配信パケット形式 (ビッグエンディアン):
 *   type: u8 | ptsUs: i64 | size: u32 | payload
 */
class MirrorService : Service() {

    private data class VideoSize(val width: Int, val height: Int, val dpi: Int)

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    // 接続ごとのパイプライン操作 (開始・停止・回転対応) はこの単一スレッドで直列化する
    private val executor = Executors.newSingleThreadExecutor()
    private var pipeline: Pipeline? = null

    private val clientLock = Any()
    private var client: Socket? = null
    private var clientOut: DataOutputStream? = null
    private var videoConfig: ByteArray? = null
    private var audioConfig: ByteArray? = null

    private var savedVolume = -1

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) {
            Log.i(TAG, "onDisplayChanged $displayId")
            if (displayId == Display.DEFAULT_DISPLAY) submit { pipeline?.onDisplayChanged() }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopStreaming()
                stopSelf()
            }
            ACTION_START -> {
                // getMediaProjection より前に foreground 化が必要 (Android 14+)
                startForegroundWithNotification()
                if (!running) {
                    val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                    val data = intent.getParcelableExtraCompat<Intent>(EXTRA_DATA)
                    if (data == null || !startStreaming(resultCode, data)) {
                        stopStreaming()
                        stopSelf()
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopStreaming()
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Mirroring", NotificationManager.IMPORTANCE_LOW)
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("画面をミラーリング中")
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    }

    private fun startStreaming(resultCode: Int, data: Intent): Boolean {
        return try {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val mp = manager.getMediaProjection(resultCode, data)
            projection = mp
            // Android 14+ では createVirtualDisplay の前にコールバック登録が必須
            mp.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    stopStreaming()
                    stopSelf()
                }
            }, Handler(Looper.getMainLooper()))

            // Android 14+ では MediaProjection から VirtualDisplay を作れるのは1回だけ。
            // 以降は接続ごとに surface と解像度だけを差し替える。
            val size = computeSize(0)
            virtualDisplay = mp.createVirtualDisplay(
                "MirrorDisplay", size.width, size.height, size.dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, null
            )

            running = true
            publishState(true)
            startServer()
            (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager)
                .registerDisplayListener(displayListener, Handler(Looper.getMainLooper()))
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start streaming", e)
            false
        }
    }

    private fun startServer() {
        val server = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 1)
        }
        serverSocket = server
        thread(name = "accept") {
            while (running) {
                val socket = try {
                    server.accept()
                } catch (e: Exception) {
                    break
                }
                submit { onClient(socket) }
            }
        }
    }

    private fun submit(task: () -> Unit) {
        try {
            executor.execute {
                try {
                    task()
                } catch (e: Exception) {
                    Log.e(TAG, "Pipeline task failed", e)
                }
            }
        } catch (e: RejectedExecutionException) {
            // 停止処理中
        }
    }

    // 新しい接続が来たら、前の配信を止めて受け取った設定でやり直す
    private fun onClient(socket: Socket) {
        val mp = projection
        if (!running || mp == null) {
            runCatching { socket.close() }
            return
        }
        stopPipeline()

        socket.tcpNoDelay = true
        val settings = readSettings(socket)
        Log.i(TAG, "Client connected: $settings")
        val out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 64 * 1024))
        synchronized(clientLock) {
            closeClientLocked()
            client = socket
            clientOut = out
            videoConfig = null
            audioConfig = null
        }

        val next = Pipeline(settings)
        pipeline = next
        try {
            next.start(mp)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start pipeline", e)
            stopPipeline()
            synchronized(clientLock) { closeClientLocked() }
        }
    }

    private fun readSettings(socket: Socket): StreamSettings = try {
        socket.soTimeout = SETTINGS_TIMEOUT_MS
        StreamSettings.read(socket.getInputStream()) ?: StreamSettings.DEFAULT
    } catch (e: Exception) {
        Log.w(TAG, "No settings received, using defaults")
        StreamSettings.DEFAULT
    } finally {
        runCatching { socket.soTimeout = 0 }
    }

    private fun stopPipeline() {
        pipeline?.stop()
        pipeline = null
        restoreVolume()
    }

    private fun stopPipelineIfNoClient() {
        val hasClient = synchronized(clientLock) { clientOut != null }
        if (!hasClient) stopPipeline()
    }

    // 内部音声のキャプチャは端末のスピーカー出力を止めないため、メディア音量を 0 にして消音する
    private fun applyMute() {
        val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        runCatching {
            if (savedVolume < 0) savedVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0)
        }.onFailure { Log.w(TAG, "Failed to mute device", it) }
    }

    private fun restoreVolume() {
        if (savedVolume < 0) return
        val volume = savedVolume
        savedVolume = -1
        val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        runCatching { audio.setStreamVolume(AudioManager.STREAM_MUSIC, volume, 0) }
            .onFailure { Log.w(TAG, "Failed to restore volume", it) }
    }

    @Suppress("DEPRECATION")
    private fun computeSize(longEdge: Int): VideoSize {
        val metrics = DisplayMetrics()
        val display = (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
        display.getRealMetrics(metrics)

        val longest = max(metrics.widthPixels, metrics.heightPixels)
        val scale = if (longEdge > 0 && longest > longEdge) longEdge.toFloat() / longest else 1f
        // H.264 エンコーダは偶数サイズを要求する
        val width = max((metrics.widthPixels * scale).toInt() and 1.inv(), 2)
        val height = max((metrics.heightPixels * scale).toInt() and 1.inv(), 2)
        return VideoSize(width, height, max((metrics.densityDpi * scale).toInt(), 72))
    }

    // クライアント未接続時は破棄し、書き込み失敗時は切断して配信を止める
    private fun writePacketLocked(type: Int, ptsUs: Long, payload: ByteArray) {
        val out = clientOut ?: return
        try {
            out.writeByte(type)
            out.writeLong(ptsUs)
            out.writeInt(payload.size)
            out.write(payload)
            out.flush()
        } catch (e: Exception) {
            closeClientLocked()
            submit { stopPipelineIfNoClient() }
        }
    }

    private fun closeClientLocked() {
        runCatching { clientOut?.close() }
        runCatching { client?.close() }
        clientOut = null
        client = null
    }

    private fun stopStreaming() {
        publishState(false)
        val mp = projection
        if (!running && mp == null) return
        running = false
        projection = null

        runCatching {
            (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(displayListener)
        }
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { executor.submit { stopPipeline() }.get(5, TimeUnit.SECONDS) }
        executor.shutdown()

        synchronized(clientLock) {
            closeClientLocked()
            videoConfig = null
            audioConfig = null
        }
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        runCatching { mp?.stop() }
    }

    @Suppress("DEPRECATION")
    private inline fun <reified T : android.os.Parcelable> Intent.getParcelableExtraCompat(name: String): T? =
        if (android.os.Build.VERSION.SDK_INT >= 33) getParcelableExtra(name, T::class.java) else getParcelableExtra(name)

    /** 1つの接続に対するエンコード一式。映像・音声とも同じ基準時刻 (baseUs) からの相対 PTS を送る。 */
    private inner class Pipeline(private val settings: StreamSettings) {

        private inner class VideoRun(val codec: MediaCodec, val surface: Surface, val width: Int, val height: Int) {
            @Volatile var alive = true
            var thread: Thread? = null
        }

        private inner class AudioRun(val record: AudioRecord, val codec: MediaCodec) {
            @Volatile var alive = true
            val threads = mutableListOf<Thread>()
        }

        @Volatile private var active = true
        private val baseUs = System.nanoTime() / 1000
        private var effectiveLongEdge = settings.longEdge
        private var video: VideoRun? = null
        private var audio: AudioRun? = null

        fun start(mp: MediaProjection) {
            if (settings.muteDevice) applyMute()
            startVideoWithFallback()
            try {
                startAudio(mp)
            } catch (e: Exception) {
                // 音声が使えなくても映像は配信する
                Log.e(TAG, "Audio capture unavailable", e)
            }
        }

        fun stop() {
            active = false
            stopAudio()
            stopVideo()
        }

        // 画面回転などでサイズが変わったら、新しいサイズでエンコーダーを作り直す
        fun onDisplayChanged() {
            val run = video ?: return
            val size = computeSize(effectiveLongEdge)
            Log.i(TAG, "Display changed: now ${size.width}x${size.height}, current ${run.width}x${run.height}")
            if (size.width == run.width && size.height == run.height) return
            stopVideo()
            if (active) startVideoWithFallback()
        }

        private fun startVideoWithFallback() {
            try {
                startVideo(settings.longEdge)
            } catch (e: Exception) {
                // 原寸が端末のエンコーダーの上限を超える場合は 1080p 相当に落とす
                if (settings.longEdge != 0) throw e
                Log.w(TAG, "Native resolution is not supported, falling back to 1920", e)
                startVideo(1920)
            }
        }

        private fun startVideo(longEdge: Int) {
            val size = computeSize(longEdge)
            Log.i(TAG, "Start video ${size.width}x${size.height} dpi=${size.dpi} fps=${settings.fps} bitRate=${settings.bitRate}")
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.width, size.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, settings.bitRate)
                setInteger(MediaFormat.KEY_FRAME_RATE, settings.fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(MediaFormat.KEY_LATENCY, 1)
            }
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            } catch (e: Exception) {
                codec.release()
                throw e
            }
            val surface = codec.createInputSurface()
            codec.start()
            effectiveLongEdge = longEdge

            val run = VideoRun(codec, surface, size.width, size.height)
            video = run
            virtualDisplay?.let {
                it.resize(size.width, size.height, size.dpi)
                it.surface = surface
            }
            run.thread = thread(name = "video-drain") { drain(codec, true) { run.alive && active } }
        }

        private fun stopVideo() {
            val run = video ?: return
            video = null
            run.alive = false
            runCatching { virtualDisplay?.surface = null }
            runCatching { run.thread?.join(1000) }
            runCatching { run.codec.stop() }
            runCatching { run.codec.release() }
            runCatching { run.surface.release() }
        }

        private fun startAudio(mp: MediaProjection) {
            val captureConfig = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val pcmFormat = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT
            )
            val record = AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(captureConfig)
                .setAudioFormat(pcmFormat)
                .setBufferSizeInBytes(max(minBuffer, 16 * 1024) * 2)
                .build()

            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 2).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, AUDIO_BIT_RATE)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
            }
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            } catch (e: Exception) {
                record.release()
                codec.release()
                throw e
            }
            codec.start()

            val run = AudioRun(record, codec)
            audio = run
            record.startRecording()
            run.threads += thread(name = "audio-feed") { feedAudio(run) }
            run.threads += thread(name = "audio-drain") { drain(codec, false) { run.alive && active } }
        }

        private fun stopAudio() {
            val run = audio ?: return
            audio = null
            run.alive = false
            runCatching { run.record.stop() }
            run.threads.forEach { runCatching { it.join(1000) } }
            runCatching { run.codec.stop() }
            runCatching { run.codec.release() }
            runCatching { run.record.release() }
        }

        private fun feedAudio(run: AudioRun) {
            val chunk = ByteArray(4096)
            try {
                while (run.alive && active) {
                    val read = run.record.read(chunk, 0, chunk.size)
                    if (read <= 0) continue
                    val index = run.codec.dequeueInputBuffer(10_000)
                    if (index < 0) continue
                    val buffer = run.codec.getInputBuffer(index) ?: continue
                    buffer.clear()
                    buffer.put(chunk, 0, read)
                    val ptsUs = System.nanoTime() / 1000 - baseUs
                    run.codec.queueInputBuffer(index, 0, read, ptsUs, 0)
                }
            } catch (e: Exception) {
                if (run.alive && active) Log.e(TAG, "Audio feed stopped", e)
            }
        }

        private fun drain(codec: MediaCodec, isVideo: Boolean, alive: () -> Boolean) {
            val info = MediaCodec.BufferInfo()
            val configType = if (isVideo) TYPE_VIDEO_CONFIG else TYPE_AUDIO_CONFIG
            try {
                while (alive()) {
                    val index = codec.dequeueOutputBuffer(info, 10_000)
                    if (index < 0) continue
                    val buffer = codec.getOutputBuffer(index)
                    if (buffer != null && info.size > 0) {
                        val bytes = ByteArray(info.size)
                        buffer.position(info.offset)
                        buffer.get(bytes)
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            synchronized(clientLock) {
                                if (isVideo) videoConfig = bytes else audioConfig = bytes
                                writePacketLocked(configType, 0, bytes)
                            }
                        } else {
                            val type = when {
                                !isVideo -> TYPE_AUDIO_FRAME
                                info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> TYPE_VIDEO_KEY_FRAME
                                else -> TYPE_VIDEO_FRAME
                            }
                            // 映像の PTS は surface 経由で nanoTime 基準、音声は feedAudio で相対化済み
                            val ptsUs = if (isVideo) info.presentationTimeUs - baseUs else info.presentationTimeUs
                            synchronized(clientLock) { writePacketLocked(type, max(ptsUs, 0), bytes) }
                        }
                    }
                    codec.releaseOutputBuffer(index, false)
                }
            } catch (e: Exception) {
                if (alive()) Log.e(TAG, "Drain stopped", e)
            }
        }
    }

    companion object {
        const val PORT = 27183

        // サービスと Activity は同一プロセスなので、状態は静的に保持して Activity が購読する
        @Volatile var isActive = false
            private set
        @Volatile var stateListener: ((Boolean) -> Unit)? = null

        private fun publishState(active: Boolean) {
            if (isActive == active) return
            isActive = active
            Handler(Looper.getMainLooper()).post { stateListener?.invoke(active) }
        }

        private const val TAG = "MirrorService"
        private const val CHANNEL_ID = "mirroring"
        private const val NOTIFICATION_ID = 1
        private const val SETTINGS_TIMEOUT_MS = 3000

        private const val ACTION_START = "com.smartcapture.app.START"
        private const val ACTION_STOP = "com.smartcapture.app.STOP"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_DATA = "data"

        const val TYPE_VIDEO_CONFIG = 0
        const val TYPE_VIDEO_FRAME = 1
        const val TYPE_VIDEO_KEY_FRAME = 2
        const val TYPE_AUDIO_CONFIG = 3
        const val TYPE_AUDIO_FRAME = 4

        private const val SAMPLE_RATE = 48_000
        private const val AUDIO_BIT_RATE = 128_000

        fun createStartIntent(context: Context, resultCode: Int, data: Intent) =
            Intent(context, MirrorService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_DATA, data)
            }

        fun createStopIntent(context: Context) =
            Intent(context, MirrorService::class.java).apply { action = ACTION_STOP }
    }
}
