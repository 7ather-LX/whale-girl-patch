# -*- coding: utf-8 -*-
"""把 B 站故事板拼图裁成单独画面。

由 whale-patch/link/bilibili.js 调用：
    python crop_frames.py <sprite.jpg> <out_dir> '<json crops>'

crops = [{"x":0,"y":0,"w":160,"h":90,"name":"frame-1.png"}, ...]
只写文件，不依赖 stdout（避免 Windows 管道权限问题）。
"""

import json
import os
import sys

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover - 运行环境缺 Pillow 时
    sys.stderr.write("PIL unavailable: %s\n" % exc)
    sys.exit(3)


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: crop_frames.py <sprite> <out_dir> <json>\n")
        return 2
    sprite, out_dir, spec = sys.argv[1], sys.argv[2], sys.argv[3]
    crops = json.loads(spec)
    if not isinstance(crops, list) or not crops:
        return 2
    os.makedirs(out_dir, exist_ok=True)
    image = Image.open(sprite).convert("RGB")
    for item in crops:
        x = int(item["x"])
        y = int(item["y"])
        w = int(item["w"])
        h = int(item["h"])
        name = os.path.basename(str(item["name"]))
        box = (x, y, x + w, y + h)
        frame = image.crop(box).resize((w * 2, h * 2), Image.LANCZOS)
        frame.save(os.path.join(out_dir, name), "PNG")
    return 0


if __name__ == "__main__":
    sys.exit(main())
