#!/usr/bin/env python3
"""生成商店宣传图：小宣传图块 440x280、滚动宣传图 1400x560。

用法：
    python3 tools/make_promo.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "store")
SCREENSHOTS = os.path.join(STORE, "screenshots")

GREEN_DARK = (23, 62, 43)
GREEN_MID = (40, 107, 73)
WHITE = (255, 255, 255)
MIST = (203, 229, 212)
SOFT = (154, 205, 176)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]


def load_font(size: int, index: int = 0):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", (1, size[1]))
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        ratio = y / max(1, size[1] - 1)
        draw.point(
            (0, y),
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3)),
        )
    return image.resize(size, Image.LANCZOS)


def draw_glow(base, center, radius, color, strength=80):
    """柔和光晕：画在独立图层后做 alpha 合成，避免直接覆盖像素。"""
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    x, y = center
    for step in range(radius, 0, -5):
        ratio = step / radius
        alpha = int(strength * (1 - ratio) ** 2)
        draw.ellipse((x - step, y - step, x + step, y + step), fill=color + (alpha,))
    return Image.alpha_composite(base.convert("RGBA"), overlay)


def rounded(image, radius):
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, image.size[0], image.size[1]), radius=radius, fill=255
    )
    result = Image.new("RGBA", image.size, (0, 0, 0, 0))
    result.paste(image.convert("RGBA"), (0, 0), mask)
    return result


def draw_lock(base, cx, cy, scale=1.0, color=WHITE, hole=GREEN_DARK):
    """在独立图层绘制挂锁，再 alpha 合成到背景上。"""
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    shackle_radius = 22 * scale
    shackle_width = max(3, int(9 * scale))
    draw.arc(
        (
            cx - shackle_radius,
            cy - 34 * scale,
            cx + shackle_radius,
            cy + 10 * scale,
        ),
        start=180,
        end=360,
        fill=color + (255,),
        width=shackle_width,
    )
    draw.rounded_rectangle(
        (cx - 27 * scale, cy - 14 * scale, cx + 27 * scale, cy + 32 * scale),
        radius=max(2, int(8 * scale)),
        fill=color + (255,),
    )
    hole_radius = 6 * scale
    draw.ellipse(
        (cx - hole_radius, cy - 2 * scale, cx + hole_radius, cy + 10 * scale),
        fill=hole + (255,),
    )
    return Image.alpha_composite(base.convert("RGBA"), overlay)


def make_small_tile() -> Image.Image:
    width, height = 440, 280
    base = vertical_gradient((width, height), GREEN_MID, GREEN_DARK).convert("RGBA")
    base = draw_glow(base, (340, 30), 250, MIST, strength=85)

    draw = ImageDraw.Draw(base)
    title_font = load_font(36)
    sub_font = load_font(17)
    tag_font = load_font(13)

    draw.text((34, 58), "本地密码匣", font=title_font, fill=WHITE + (255,))
    draw.text((34, 112), "密码只留在你自己的浏览器里", font=sub_font, fill=MIST + (255,))
    draw.text((34, 142), "AES-256-GCM 加密 · 无服务器", font=tag_font, fill=SOFT + (255,))
    draw.text((34, 164), "自动填充 · 密码历史 · 加密备份", font=tag_font, fill=SOFT + (255,))

    base = draw_lock(base, 350, 196, scale=1.15)

    return base.convert("RGB")


def make_marquee() -> Image.Image:
    width, height = 1400, 560
    base = vertical_gradient((width, height), GREEN_MID, GREEN_DARK).convert("RGBA")
    base = draw_glow(base, (1100, 110), 500, MIST, strength=75)

    draw = ImageDraw.Draw(base)
    title_font = load_font(78)
    sub_font = load_font(28)
    bullet_font = load_font(23)

    draw.text((86, 104), "本地密码匣", font=title_font, fill=WHITE + (255,))
    draw.text((86, 208), "一个不上传任何数据的离线密码管理器", font=sub_font, fill=MIST + (255,))

    bullets = [
        "AES-256-GCM 本地加密，主密码从不被保存",
        "登录页自动填充，但绝不替你提交",
        "每个网站可单独设为自动 / 点击 / 禁用",
    ]
    y = 288
    for item in bullets:
        draw.ellipse((90, y + 9, 102, y + 21), fill=SOFT + (255,))
        draw.text((122, y), item, font=bullet_font, fill=(219, 238, 224, 255))
        y += 46

    base = draw_lock(base, 130, 452, scale=0.75)

    # 右侧展示真实界面截图
    shot_path = os.path.join(SCREENSHOTS, "01-manager-list.png")
    if os.path.exists(shot_path):
        shot = Image.open(shot_path).convert("RGBA")
        target_h = 396
        ratio = target_h / shot.height
        shot = shot.resize((int(shot.width * ratio), target_h), Image.LANCZOS)
        shot = rounded(shot, 14)
        frame = Image.new("RGBA", (shot.width + 16, shot.height + 16), (0, 0, 0, 0))
        ImageDraw.Draw(frame).rounded_rectangle(
            (0, 0, frame.width, frame.height), radius=18, fill=(255, 255, 255, 45)
        )
        frame.alpha_composite(shot, (8, 8))
        base.alpha_composite(frame, (width - frame.width - 76, 82))

    return base.convert("RGB")


def save(image, name):
    path = os.path.join(STORE, name)
    image.save(path, "PNG", optimize=True)
    print(f"  store/{name}  {image.size[0]}x{image.size[1]}")


def main():
    print("生成商店宣传图：")
    save(make_small_tile(), "promo-tile-440x280.png")
    save(make_marquee(), "marquee-1400x560.png")

    # Chrome 商店列表图：128x128（主体 96x96 + 透明边距）
    icon = Image.open(os.path.join(ROOT, "icons", "icon128.png")).convert("RGBA")
    canvas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    canvas.alpha_composite(icon, (0, 0))
    save(canvas, "icon-128.png")


if __name__ == "__main__":
    main()
