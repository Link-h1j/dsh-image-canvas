#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
角色设定图的「结构比例图」与「服装拆解图」合成器。

为什么不用扩散模型画这两张：标尺线要准、中文标注要能读，扩散模型两样都做不到。
所以这两张由代码合成 —— 素材仍来自 ComfyUI（同一角色、同一画风），只是线和字由 Pillow 精确绘制。

用法：
  python compose-sheet.py --dir "<角色设定图目录>" --name 橙发少女 [--head-count 7.5]

输入（由 gen-character-sheet.mjs 生成）：
  <name>_01_全身正面.png                     → 结构比例图底图
  <name>_16a..f_*.png                        → 服装分件素材
输出：
  <name>_15_结构比例图.png
  <name>_16_服装拆解图.png
（若目标文件已存在，自动加 -2 / -3 后缀，绝不覆盖）
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# 中文 Windows 的控制台默认 GBK，打印 emoji/中文会 UnicodeEncodeError 把脚本带走
# （2026-10-16 实测）。这里强制 stdout/stderr 走 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",      # 微软雅黑
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",    # 黑体
    r"C:\Windows\Fonts\simsun.ttc",
]
INK = (28, 28, 30)
ACCENT = (214, 96, 32)      # 橙
GUIDE = (90, 140, 220)      # 蓝
DIM = (120, 120, 124)
PANEL = (247, 247, 245)


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def unique_path(path):
    """不覆盖已有文件。"""
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    index = 2
    while os.path.exists(f"{stem}-{index}{ext}"):
        index += 1
    return f"{stem}-{index}{ext}"


def figure_bbox(image, threshold=246):
    """把接近纯白的背景去掉，得到人物外接框。"""
    gray = image.convert("L")
    mask = gray.point(lambda v: 255 if v < threshold else 0)
    box = mask.getbbox()
    return box if box is not None else (0, 0, image.width, image.height)


def compose_proportion(directory, character, head_count):
    source = os.path.join(directory, f"{character}_01_全身正面.png")
    if not os.path.exists(source):
        candidates = sorted(glob.glob(os.path.join(directory, f"{character}_01_*.png")))
        if not candidates:
            print(f"  ❌ 找不到全身正面图（{source}）")
            return None
        source = candidates[0]

    figure = Image.open(source).convert("RGB")
    left, top, right, bottom = figure_bbox(figure)
    # 留一点余量，别把头顶和脚切掉
    pad = int((bottom - top) * 0.02)
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(figure.width, right + pad)
    bottom = min(figure.height, bottom + pad)
    cropped = figure.crop((left, top, right, bottom))

    fig_h = cropped.height
    fig_w = cropped.width
    head_h = fig_h / head_count

    # 画布：左边人物 + 右边标尺与说明
    margin = 64
    scale = min(1.0, 1500 / fig_h)
    fig_draw_w = int(fig_w * scale)
    fig_draw_h = int(fig_h * scale)
    ruler_w = 420
    canvas_w = margin * 2 + fig_draw_w + ruler_w
    canvas_h = margin * 2 + fig_draw_h + 120
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    resized = cropped.resize((fig_draw_w, fig_draw_h), Image.LANCZOS)
    origin_x = margin
    origin_y = margin + 70
    canvas.paste(resized, (origin_x, origin_y))

    font_title = pick_font(40)
    font_label = pick_font(24)
    font_small = pick_font(20)

    draw.text((margin, margin - 8), f"{character} · 结构比例图", font=font_title, fill=INK)
    draw.text((margin, margin + 42), f"参考基准：参考图与全部 16 张视图共用同一角色设定", font=font_small, fill=DIM)

    # 头高辅助线与编号
    for index in range(int(head_count) + 1):
        y = origin_y + int(head_h * scale * index)
        draw.line([(origin_x - 26, y), (origin_x + fig_draw_w + 26, y)], fill=GUIDE, width=2)
        label = f"第{index}头" if index > 0 else "头顶"
        if index == int(head_count):
            label = f"脚底（{head_count:g} 头身）"
        draw.text((origin_x + fig_draw_w + 34, y - 14), label, font=font_label, fill=GUIDE)

    # 中线
    center_x = origin_x + fig_draw_w // 2
    draw.line([(center_x, origin_y - 26), (center_x, origin_y + fig_draw_h + 26)], fill=(210, 210, 214), width=2)

    # 关键对齐线（按标准 7.5 头身比例的经验位置，单位=头高）
    guides = [
        (0.0, "头顶"),
        (1.0, "下巴 / 颈根"),
        (1.5, "肩线"),
        (2.0, "胸线 / 领口下缘"),
        (2.8, "腰线（腰封上缘）"),
        (3.4, "胯线（腰封下缘）"),
        (4.6, "膝上（裙摆中段）"),
        (5.6, "膝盖"),
        (6.9, "脚踝"),
        (head_count, "脚底"),
    ]
    for unit, text in guides:
        y = origin_y + int(head_h * scale * unit)
        if y > origin_y + fig_draw_h:
            continue
        draw.line([(origin_x - 12, y), (origin_x + 8, y)], fill=ACCENT, width=3)
        draw.line([(origin_x + fig_draw_w - 8, y), (origin_x + fig_draw_w + 12, y)], fill=ACCENT, width=3)

    # 右侧说明面板
    panel_x = origin_x + fig_draw_w + 140
    panel_y = origin_y
    draw.rectangle([panel_x - 20, panel_y - 20, canvas_w - margin + 20, panel_y + 560], fill=PANEL)
    lines = [
        ("头身比", f"≈ {head_count:g} 头身"),
        ("总高", f"{fig_h} px（原图像素）"),
        ("单头高", f"≈ {head_h:.0f} px"),
        ("肩宽", f"≈ {head_h * 1.6:.0f} px（约 1.6 头宽）"),
        ("腰位", f"≈ {head_h * 2.8:.0f} px（2.8 头高处）"),
        ("膝位", f"≈ {head_h * 5.6:.0f} px（5.6 头高处）"),
        ("", ""),
        ("图例", ""),
        ("蓝线", "每一头高的水平分隔线"),
        ("橙线", "关键部位对齐线（两侧短标）"),
        ("灰线", "身体中轴"),
    ]
    text_y = panel_y
    for key, value in lines:
        if key == "" and value == "":
            text_y += 14
            continue
        if value == "":
            draw.text((panel_x, text_y), key, font=font_label, fill=INK)
        else:
            draw.text((panel_x, text_y), f"{key}：{value}", font=font_small, fill=INK if key != "图例" else ACCENT)
        text_y += 34

    out = unique_path(os.path.join(directory, f"{character}_15_结构比例图.png"))
    canvas.save(out)
    print(f"  ✅ {os.path.basename(out)}  ({canvas.width}×{canvas.height})")
    return out


ITEM_LAYERS = [
    ("16b", "上衣 · 连衣裙本体", "第 1 层（内层主体）"),
    ("16c", "下装 · 及地长裙", "第 1 层（与上衣连裁）"),
    ("16a", "外套 · 白色披肩", "第 2 层（罩在连衣裙外）"),
    ("16e", "配饰 · 头饰与腰饰", "第 3 层（穿戴附件）"),
    ("16d", "鞋履 · 白色系带靴", "基础层（足部）"),
    ("16f", "随身道具 · 皮革书", "携带物（手持）"),
]


def compose_costume(directory, character):
    cells = []
    for key, label, layer in ITEM_LAYERS:
        matches = sorted(glob.glob(os.path.join(directory, f"{character}_{key}_*.png")))
        if matches:
            cells.append((matches[0], label, layer))
    if not cells:
        print("  ❌ 找不到任何服装分件素材（16a..16f）")
        return None

    columns = 3
    rows = (len(cells) + columns - 1) // columns
    cell_w, cell_h = 620, 660
    image_h = 470
    margin = 56
    header = 130
    canvas_w = margin * 2 + cell_w * columns
    canvas_h = margin * 2 + header + cell_h * rows
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    font_title = pick_font(44)
    font_label = pick_font(28)
    font_layer = pick_font(22)

    draw.text((margin, margin - 6), f"{character} · 服装拆解图", font=font_title, fill=INK)
    draw.text((margin, margin + 52), "按穿戴层次排列：先内层主体，再罩层，最后配饰与随身道具", font=font_layer, fill=DIM)

    for index, (path, label, layer) in enumerate(cells):
        row, column = divmod(index, columns)
        x = margin + column * cell_w
        y = margin + header + row * cell_h

        draw.rectangle([x, y, x + cell_w - 24, y + cell_h - 24], outline=(226, 226, 228), width=2, fill=(252, 252, 250))

        image = Image.open(path).convert("RGB")
        box = figure_bbox(image)
        image = image.crop(box)
        ratio = min((cell_w - 96) / image.width, image_h / image.height)
        image = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.LANCZOS)
        canvas.paste(image, (x + (cell_w - 24 - image.width) // 2, y + 32 + (image_h - image.height) // 2))

        draw.text((x + 32, y + image_h + 56), label, font=font_label, fill=INK)
        draw.text((x + 32, y + image_h + 96), layer, font=font_layer, fill=ACCENT)
        draw.text((x + 32, y + image_h + 128), "来源：" + os.path.basename(path), font=pick_font(18), fill=DIM)

    out = unique_path(os.path.join(directory, f"{character}_16_服装拆解图.png"))
    canvas.save(out)
    print(f"  ✅ {os.path.basename(out)}  ({canvas.width}×{canvas.height})")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="角色设定图目录")
    parser.add_argument("--name", required=True, help="角色名（与文件名前缀一致）")
    parser.add_argument("--head-count", type=float, default=7.5, help="头身比，默认 7.5")
    args = parser.parse_args()

    directory = os.path.abspath(args.dir)
    if not os.path.isdir(directory):
        print("目录不存在: " + directory)
        sys.exit(2)

    print(f"合成目录: {directory}")
    made = []
    proportion = compose_proportion(directory, args.name, args.head_count)
    if proportion:
        made.append(proportion)
    costume = compose_costume(directory, args.name)
    if costume:
        made.append(costume)

    print(f"合计生成 {len(made)} 张")
    for path in made:
        print("  " + path)


if __name__ == "__main__":
    main()
