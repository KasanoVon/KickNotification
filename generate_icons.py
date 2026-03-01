#!/usr/bin/env python3
"""Kick Stream Notifier のアイコンを生成するスクリプト"""

import os
import struct
import zlib


def create_png(size: int, output_path: str) -> None:
    """指定サイズの PNG アイコンを生成する（外部ライブラリ不要）"""

    def write_chunk(chunk_type: bytes, data: bytes) -> bytes:
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)

    # Kick グリーン (#53fc18) と背景 (#0e0e10)
    BG = (14, 14, 16)         # #0e0e10
    GREEN = (83, 252, 24)     # #53fc18
    WHITE = (255, 255, 255)

    cx = size // 2
    cy = size // 2
    r_outer = int(size * 0.46)
    r_inner = int(size * 0.30)

    def dist(x: int, y: int, cx: int, cy: int) -> float:
        return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5

    # ピクセルデータを生成（RGBA）
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            d = dist(x, y, cx, cy)
            if d <= r_outer:
                if d <= r_inner:
                    # 内側: 白い "K" のような図形（簡略化: 内円をグリーンに）
                    row += bytes(GREEN + (255,))
                else:
                    # 外側リング: グリーン
                    row += bytes(GREEN + (255,))
            else:
                # 背景: ダーク
                row += bytes(BG + (255,))
        rows.append(row)

    # "K" の文字をピクセルに描画（サイズに応じてスケール）
    scale = size / 128
    stroke = max(1, int(3 * scale))

    def set_pixel(px_rows, px: int, py: int, color: tuple) -> None:
        if 0 <= px < size and 0 <= py < size:
            idx = px * 4
            row = px_rows[py]
            row[idx:idx + 4] = bytes(color + (255,))

    def draw_line(px_rows, x0: int, y0: int, x1: int, y1: int, color: tuple, w: int) -> None:
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        steps = max(dx, dy, 1)
        for i in range(steps + 1):
            t = i / steps
            fx = round(x0 + t * (x1 - x0))
            fy = round(y0 + t * (y1 - y0))
            for ox in range(-w, w + 1):
                for oy in range(-w, w + 1):
                    set_pixel(px_rows, fx + ox, fy + oy, color)

    # "K" 文字の描画
    kx = int(cx)
    ky = int(cy)
    arm = int(r_inner * 0.70)

    # 縦棒
    draw_line(rows, kx - int(arm * 0.4), ky - arm, kx - int(arm * 0.4), ky + arm, WHITE, stroke)
    # 上斜め棒
    draw_line(rows, kx - int(arm * 0.4), ky, kx + int(arm * 0.6), ky - arm, WHITE, stroke)
    # 下斜め棒
    draw_line(rows, kx - int(arm * 0.4), ky, kx + int(arm * 0.6), ky + arm, WHITE, stroke)

    # PNG フォーマットに変換
    raw_data = b''
    for row in rows:
        raw_data += b'\x00' + bytes(row)  # フィルタバイト（None）

    compressed = zlib.compress(raw_data, 9)

    png_data = b'\x89PNG\r\n\x1a\n'
    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png_data += write_chunk(b'IHDR', ihdr_data)
    # IDAT
    png_data += write_chunk(b'IDAT', compressed)
    # IEND
    png_data += write_chunk(b'IEND', b'')

    with open(output_path, 'wb') as f:
        f.write(png_data)

    print(f'Generated: {output_path} ({size}x{size})')


if __name__ == '__main__':
    icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in [16, 48, 128]:
        create_png(size, os.path.join(icons_dir, f'icon{size}.png'))

    print('All icons generated successfully!')
