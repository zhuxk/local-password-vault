#!/usr/bin/env python3
"""生成扩展图标与商店图标。

用法：
    python3 tools/make_icons.py

产物：
    icons/icon16.png                 浏览器工具栏 16x16
    icons/icon48.png                 扩展管理页 48x48
    icons/icon128.png                商店图标的 128x128（96x96 主体 + 16px 透明边距）
    store/edge-logo-300.png          Edge 商店 300x300

图标主体是一枚白色挂锁，绿色圆角方形底，延续扩展界面的绿色主题。
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与扩展界面一致的绿色主题
GREEN_LIGHT = (58, 143, 97)
GREEN_DARK = (24, 79, 51)
WHITE = (255, 255, 255)
GREEN_DEEP = (18, 62, 40)

SUPERSAMPLE = 8


def mix(first, second, ratio):
    return tuple(int(round(first[i] + (second[i] - first[i]) * ratio)) for i in range(3))


def diagonal_gradient(size, start, end):
    """左上到右下的对角渐变。"""
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            ratio = (x / size * 0.55) + (y / size * 0.45)
            pixels[x, y] = mix(start, end, min(1.0, ratio))
    return image


def rounded_mask(size, radius_ratio=0.235):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    return mask


def draw_padlock(canvas, box):
    """在给定方形区域画一枚白色挂锁。"""
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = box
    width = right - left
    height = bottom - top
    unit = width / 100.0

    # 锁梁：上半圆环
    shackle_radius = unit * 21
    shackle_center_x = (left + right) / 2
    shackle_center_y = top + unit * 34
    shackle_width = int(unit * 10)
    draw.arc(
        (
            shackle_center_x - shackle_radius,
            shackle_center_y - shackle_radius,
            shackle_center_x + shackle_radius,
            shackle_center_y + shackle_radius,
        ),
        start=180,
        end=360,
        fill=WHITE,
        width=shackle_width,
    )

    # 锁体
    body_left = left + unit * 13
    body_right = right - unit * 13
    body_top = top + unit * 38
    body_bottom = bottom - unit * 4
    draw.rounded_rectangle(
        (body_left, body_top, body_right, body_bottom),
        radius=int(unit * 9),
        fill=WHITE,
    )

    # 锁孔：挖成深绿色
    hole_center_x = (body_left + body_right) / 2
    hole_center_y = body_top + (body_bottom - body_top) * 0.42
    hole_radius = unit * 7
    draw.ellipse(
        (
            hole_center_x - hole_radius,
            hole_center_y - hole_radius,
            hole_center_x + hole_radius,
            hole_center_y + hole_radius,
        ),
        fill=GREEN_DEEP,
    )
    slot_half = unit * 4.2
    slot_top = hole_center_y + unit * 1
    slot_bottom = body_top + (body_bottom - body_top) * 0.78
    draw.polygon(
        [
            (hole_center_x - slot_half * 0.55, slot_top),
            (hole_center_x + slot_half * 0.55, slot_top),
            (hole_center_x + slot_half, slot_bottom),
            (hole_center_x - slot_half, slot_bottom),
        ],
        fill=GREEN_DEEP,
    )


def render_lock(size):
    """渲染 size x size 的挂锁图标（圆角方形铺满画布）。"""
    canvas_size = size * SUPERSAMPLE
    gradient = diagonal_gradient(canvas_size, GREEN_LIGHT, GREEN_DARK)
    mask = rounded_mask(canvas_size)

    icon = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw_padlock(icon, (canvas_size * 0.08, canvas_size * 0.08, canvas_size * 0.92, canvas_size * 0.92))

    return icon.resize((size, size), Image.LANCZOS)


def render_store_icon(size, artwork_ratio=0.75):
    """Chrome 商店图标：实际主体占 96/128，四周留透明边距。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    artwork_size = int(round(size * artwork_ratio))
    artwork = render_lock(artwork_size)
    offset = (size - artwork_size) // 2
    canvas.paste(artwork, (offset, offset), artwork)
    return canvas


def save(image, relative_path):
    target = os.path.join(ROOT, relative_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    image.save(target, "PNG", optimize=True)
    print(f"  {relative_path}  {image.size[0]}x{image.size[1]}")


def main():
    print("生成扩展图标：")
    save(render_lock(16), "icons/icon16.png")
    save(render_lock(48), "icons/icon48.png")
    # Chrome 要求 128x128 图标主体为 96x96，四周各留 16px 透明边距
    save(render_store_icon(128), "icons/icon128.png")

    print("生成商店素材：")
    save(render_store_icon(300, artwork_ratio=1.0), "store/edge-logo-300.png")
    save(render_lock(300), "store/icon-300.png")


if __name__ == "__main__":
    main()
