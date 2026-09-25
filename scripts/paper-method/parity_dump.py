"""
导出「官方 PyTorch 输出」的对照样本，供 Node 推理做数值一致性检查。
==================================================================
覆盖：无扰动 / 输入噪声 / 输入缺失 / 切片边界样本（第一个与最后一个窗口）。
扰动算法与 Node 侧（server/paperMethods.mjs）**逐行对应**：
   噪声：对每个 (t, c)，若 rand() < strength → x += gauss(rand) * 0.5 * strength
   缺失：对每个 (t, c)，若 rand() < strength → x = 0（标准化空间即训练均值）
随机数发生器为 mulberry32(seed * 7919 + round(strength*1000))，与 JS 实现一致。

用法： python scripts/paper-method/parity_dump.py --run-id <runId>
"""
import argparse
import importlib.util
import io
import json
import math
import os
import sys

import numpy as np
import torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = os.path.join(ROOT, "third_party", "LTSF-Linear-0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6")
DATA_DIR = os.path.join(ROOT, "data")
MODELS_DIR = os.path.join(ROOT, "lab-models")


def mulberry32(seed):
    state = [seed & 0xFFFFFFFF]

    def nxt():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = t ^ (t >> 14)
        return (t & 0xFFFFFFFF) / 4294967296.0

    return nxt


def gauss(rand):
    u = 0.0
    v = 0.0
    while u == 0.0:
        u = rand()
    while v == 0.0:
        v = rand()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def perturb(input_std, kind, strength, seed):
    x = np.array(input_std, dtype=np.float64, copy=True)
    if not kind or strength == 0:
        return x
    rand = mulberry32((seed * 7919 + round(strength * 1000)) & 0xFFFFFFFF)
    if kind == "noise":
        for t in range(x.shape[0]):
            for c in range(x.shape[1]):
                if rand() < strength:
                    x[t, c] += gauss(rand) * 0.5 * strength
    else:
        for t in range(x.shape[0]):
            for c in range(x.shape[1]):
                if rand() < strength:
                    x[t, c] = 0.0
    return x


def load_official(model_name):
    spec = importlib.util.spec_from_file_location(f"official_{model_name}", os.path.join(REPO, "models", f"{model_name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--strength", type=float, default=0.1)
    args = ap.parse_args()

    run_dir = os.path.join(MODELS_DIR, args.run_id)
    with io.open(os.path.join(run_dir, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    with io.open(os.path.join(run_dir, "weights.json"), encoding="utf-8") as f:
        wj = json.load(f)

    model_name = cfg["method"]
    seq_len, pred_len, enc_in = cfg["task"]["seqLen"], cfg["task"]["predLen"], cfg["task"]["encIn"]
    mod = load_official(model_name)
    ns = argparse.Namespace(seq_len=seq_len, pred_len=pred_len, enc_in=enc_in, individual=False, label_len=seq_len // 2)
    model = mod.Model(ns)
    sd = {k: torch.tensor(v, dtype=torch.float32) for k, v in wj["state_dict"].items()}
    model.load_state_dict(sd)
    model.eval()

    # 取窗口：切片首、次、尾（边界样本）+ 中间若干
    with io.open(os.path.join(run_dir, "parity.json"), encoding="utf-8") as f:
        par = json.load(f)
    inputs = [np.array(w["input_std"], dtype=np.float64) for w in par["windows"]]
    idx = sorted(set([0, 1, 2, len(inputs) - 2, len(inputs) - 1]))

    cases = [("none", 0.0), ("noise", args.strength), ("missing", 0.2)]
    out = {"runId": args.run_id, "method": model_name, "seqLen": seq_len, "predLen": pred_len, "cases": []}
    for kind, strength in cases:
        for i in idx:
            x = perturb(inputs[i], kind, strength, 11)
            with torch.no_grad():
                y = model(torch.tensor(x[None, :, :], dtype=torch.float32)).numpy()[0]
            out["cases"].append(
                {
                    "window": i,
                    "kind": kind,
                    "strength": strength,
                    "seed": 11,
                    "inputPerturbed": x.tolist(),
                    "predStd": np.round(y, 6).tolist(),
                }
            )
    dst = os.path.join(run_dir, "parity_ext.json")
    with io.open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"已写出 {dst}：{len(out['cases'])} 个对照用例（窗口 {idx}，扰动 none/noise/missing）")


if __name__ == "__main__":
    main()
