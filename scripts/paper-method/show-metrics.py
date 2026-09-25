"""打印我们训练结果的四种口径指标（用于与官方表格做同口径对照）"""
import io
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
for m in ["DLinear", "Linear"]:
    p = os.path.join(ROOT, "lab-models", f"{m}_ETTm2_official_p96_e10", "config.json")
    with io.open(p, encoding="utf-8") as f:
        c = json.load(f)
    t = c["metrics"]["test"]
    print(f"{m}: 标准化空间(全7通道) MAE={t['standardized']['mae']:.4f} MSE={t['standardized']['mse']:.4f}")
    print(f"      原始单位(全7通道) MAE={t['raw']['mae']:.4f} MSE={t['raw']['mse']:.4f}")
    print(f"      原始单位(仅OT)     MAE={t['rawOT']['mae']:.4f} MSE={t['rawOT']['mse']:.4f}")
    print(f"      各通道MAE={[round(x, 4) for x in t['rawPerChannelMAE']]}")
    print(f"      nSamples={t['standardized']['nSamples']}｜轮数={c['hyper']['epochs']}｜seqLen={c['task']['seqLen']}｜predLen={c['task']['predLen']}｜features={c['task']['features']}")
