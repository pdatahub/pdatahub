package com.pdatahub.hub.pairing

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * QR code renderer backed by ZXing.
 *
 * Generates a square [Bitmap] from a string payload. Used in pairing flow —
 * laptop's pdatahub-mcp scans the QR containing `pdatahub://pair?hub=...&relay=...&token=...`
 * and connects via Cloudflare relay.
 *
 * Error correction: M (15% recoverable). Margin: 1 module. Character set: UTF-8
 * (token is base64url so always ASCII in practice).
 */
object QrRenderer {
    private const val DEFAULT_SIZE = 512

    fun render(payload: String, size: Int = DEFAULT_SIZE): Bitmap {
        require(size > 0) { "size must be positive" }
        val hints = mapOf<EncodeHintType, Any>(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1,
            EncodeHintType.CHARACTER_SET to "UTF-8",
        )
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, hints)
        val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
        for (x in 0 until matrix.width) {
            for (y in 0 until matrix.height) {
                bitmap.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        return bitmap
    }
}
