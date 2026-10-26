package com.smartcapture.app

import java.io.DataInputStream
import java.io.InputStream

/** PC から接続直後に届く配信設定。PC 側 protocol.ts の encodeSettings と一致させる。 */
data class StreamSettings(
    /** 映像の長辺ピクセル数。0 は端末の原寸。 */
    val longEdge: Int,
    val fps: Int,
    val bitRate: Int,
    val muteDevice: Boolean
) {
    companion object {
        // 設定が届かない場合 (旧クライアント等) は端末を消音しない
        val DEFAULT = StreamSettings(longEdge = 1920, fps = 60, bitRate = 8_000_000, muteDevice = false)

        private val MAGIC = byteArrayOf('M'.code.toByte(), 'R'.code.toByte(), 'C'.code.toByte(), 'F'.code.toByte())

        /** 不正値は許容範囲に丸める。読み取りに失敗した場合は null。 */
        fun read(stream: InputStream): StreamSettings? {
            val input = DataInputStream(stream)
            val magic = ByteArray(MAGIC.size)
            input.readFully(magic)
            if (!magic.contentEquals(MAGIC)) return null

            val longEdge = input.readUnsignedShort()
            val fps = input.readUnsignedByte()
            val flags = input.readUnsignedByte()
            val bitRate = input.readInt()
            return StreamSettings(
                longEdge = if (longEdge == 0) 0 else longEdge.coerceIn(240, 4096),
                fps = fps.coerceIn(15, 60),
                bitRate = bitRate.coerceIn(500_000, 20_000_000),
                muteDevice = flags and 1 != 0
            )
        }
    }
}
