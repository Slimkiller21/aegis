# Aegis app icon: an emerald Greek-style shield on a deep slate rounded square.
# Draws at high resolution, then exports:
#   assets/icon.ico  (multi-size, for the Windows exe/installer/taskbar)
#   assets/icon.png  (512px, for the landing page / README)
#
#   pip install pillow
#   python scripts/make_icon.py

import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "assets")
S = 2048  # supersample; downscaled for anti-aliasing


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def shield_path(cx, cy, w, h, steps=200):
    # classic kite/heater shield: gently curved top, sides tapering to a point
    pts = []
    top = cy - h / 2
    bot = cy + h / 2
    for i in range(steps // 4 + 1):  # top edge, slight dip
        t = i / (steps // 4)
        x = cx - w / 2 + w * t
        y = top + (w * 0.06) * (4 * t * (1 - t))
        pts.append((x, y))
    for i in range(1, steps + 1):  # right side down to the tip
        t = i / steps
        x = cx + (w / 2) * (1 - t * t * 0.96)
        y = top + (bot - top) * t
        pts.append((x, y))
    for i in range(steps, 0, -1):  # left side back up (mirror)
        t = i / steps
        x = cx - (w / 2) * (1 - t * t * 0.96)
        y = top + (bot - top) * t
        pts.append((x, y))
    return pts


def main():
    os.makedirs(OUT, exist_ok=True)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- rounded-square background (deep green-tinted slate) -------------
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=int(S * 0.225), fill=255)
    bg = Image.new("RGBA", (S, S))
    bgd = ImageDraw.Draw(bg)
    for y in range(S):
        bgd.line([(0, y), (S, y)], fill=lerp((16, 26, 24), (10, 16, 15), y / S))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)

    cx, cy = S / 2, S * 0.505
    w, h = S * 0.56, S * 0.64

    # --- shield body: emerald vertical gradient ---------------------------
    shield = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shield).polygon(shield_path(cx, cy, w, h), fill=255)
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp((28, 178, 138), (9, 104, 80), y / S))
    img.paste(grad, (0, 0), shield)

    # --- inner rim: pale outline echoing the shield shape -----------------
    rim_outer = Image.new("L", (S, S), 0)
    ImageDraw.Draw(rim_outer).polygon(shield_path(cx, cy, w * 0.86, h * 0.86), fill=255)
    rim_inner = Image.new("L", (S, S), 0)
    ImageDraw.Draw(rim_inner).polygon(shield_path(cx, cy, w * 0.80, h * 0.80), fill=255)
    ring = rim_outer.copy()
    ring.paste(0, (0, 0), rim_inner)
    img.paste(Image.new("RGBA", (S, S), (214, 245, 233, 255)), (0, 0), ring)

    # --- checkmark: protection confirmed ----------------------------------
    t = S * 0.052
    p1 = (cx - w * 0.20, cy + h * 0.015)
    p2 = (cx - w * 0.045, cy + h * 0.145)
    p3 = (cx + w * 0.235, cy - h * 0.140)
    d.line([p1, p2, p3], fill=(240, 253, 248, 255), width=int(t), joint="curve")
    r = t / 2
    for p in (p1, p3):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(240, 253, 248, 255))

    # --- export ------------------------------------------------------------
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"))
    img.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, "icon.ico"),
        sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
    )
    print("wrote assets/icon.ico + assets/icon.png")


if __name__ == "__main__":
    main()
