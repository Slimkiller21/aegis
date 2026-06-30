# Generates assets/icon.png (32x32 RGBA shield dot). Stdlib only — no Pillow.
import os, struct, zlib

W = H = 32
# teal shield-ish filled circle on transparent bg
cx, cy, r = 15.5, 15.5, 14.0
px = bytearray()
for y in range(H):
    px.append(0)  # PNG filter byte per row
    for x in range(W):
        dx, dy = x - cx, y - cy
        d = (dx * dx + dy * dy) ** 0.5
        if d <= r:
            # solid teal, soft edge
            a = 255 if d <= r - 1.5 else int(max(0, (r - d) / 1.5) * 255)
            px += bytes((42, 196, 168, a))
        else:
            px += bytes((0, 0, 0, 0))

def chunk(tag, data):
    c = tag + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(px), 9))
png += chunk(b"IEND", b"")

out = os.path.join(os.path.dirname(__file__), "..", "assets", "icon.png")
with open(out, "wb") as f:
    f.write(png)
print("wrote", os.path.abspath(out))
