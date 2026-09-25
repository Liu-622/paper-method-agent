"""查看已训练方法版本的指标摘要（避免在 shell 里拼长命令）"""
import io
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(ROOT, "lab-models")

for run in sorted(os.listdir(MODELS)) if os.path.isdir(MODELS) else []:
    cfg_path = os.path.join(MODELS, run, "config.json")
    if not os.path.exists(cfg_path):
        continue
    with io.open(cfg_path, encoding="utf-8") as f:
        c = json.load(f)
    m = c["metrics"]
    print(f"\n### {run}")
    print(f"  方法={c['method']}  来源={c['methodSource']}  官方SHA={c['officialSha'][:8]}")
    print(f"  任务={c['task']}  超参={c['hyper']}")
    print(f"  耗时={c['timing']}  参数量={c['params']}")
    print(f"  val(标准化)={m['val']['standardized']}")
    print(f"  test(全部7通道, 原始单位)={m['test']['raw']}")
    print(f"  test(仅OT, 原始单位)={m['test']['rawOT']}")
    print(f"  各通道MAE={[round(x, 4) for x in m['test']['rawPerChannelMAE']]}  ({m['test']['channels']})")
    print(f"  数据划分={c['data']['split']['official_borders']}")
    print(f"  评估区间={c['data']['split']['dates']['test']}")
