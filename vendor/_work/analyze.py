"""分析截图里模型区域（非背景、非 HUD、非网格）的亮度分布，判断是否发灰/过曝。"""
import sys
from PIL import Image
import colorsys

def analyze(path, bg=(0x14, 0x16, 0x1a), hud=(0, 0, 300, 270)):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    vals = []
    grid_like = 0
    for y in range(h):
        for x in range(w):
            if hud[0] <= x < hud[2] and hud[1] <= y < hud[3]:
                continue  # HUD 文字框
            r, g, b = px[x, y]
            if abs(r-bg[0]) <= 7 and abs(g-bg[1]) <= 7 and abs(b-bg[2]) <= 7:
                continue  # 背景
            lum = 0.2126*r + 0.7152*g + 0.0722*b
            ident = lum / 255.0
            if ident < 1e-6:
                continue
            sat = (max(r, g, b) - min(r, g, b)) / max(1, max(r, g, b))
            if lum < 60 and sat < 0.25:
                grid_like += 1
                continue  # 网格线（低亮度低饱和）
            vals.append(lum)
    vals.sort()
    n = len(vals)
    if not n:
        return {'error': 'no subject pixels'}
    def pct(p):
        return vals[min(n-1, int(n*p/100))]
    return {
        'file': path.split('\\')[-1],
        'subject_px': n,
        'grid_px': grid_like,
        'mean': round(sum(vals)/n, 1),
        'p10': round(pct(10), 1),
        'p50': round(pct(50), 1),
        'p90': round(pct(90), 1),
        'p99': round(pct(99), 1),
        'max': round(vals[-1], 1),
        'pct_ge_250': round(100*sum(1 for v in vals if v >= 250)/n, 2),
        'pct_ge_240': round(100*sum(1 for v in vals if v >= 240)/n, 2),
        'pct_lt_30': round(100*sum(1 for v in vals if v < 30)/n, 2),
        'pct_lt_60': round(100*sum(1 for v in vals if v < 60)/n, 2),
    }

for p in sys.argv[1:]:
    print(analyze(p))
