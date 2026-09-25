"""
用官方 LTSF-Linear 代码在 ETTm2 上训练 DLinear / Linear（CPU）
==================================================================
设计要点（对应本轮的硬性要求）：
- 模型代码来自官方仓库的**固定提交**，直接 import 官方文件，不改写模型定义；
- 数据与划分、标准化全部走官方 `data_provider.data_loader.Dataset_ETT_minute`；
- 固定轮数训练（默认小轮数），**不使用测试集做早停或选模**；
- 记录：配置、种子、代码版本与 SHA、数据哈希、每轮耗时、权重、测试预测、指标；
- 指标 MAE / MSE / RMSE 分别记录，并分别给出「标准化空间」与「原始单位」两套；
- 导出 Node 推理所需的权重与对照样本（仅前若干窗口，用于 JS 与 PyTorch 的数值一致性检查）。

用法：
  python scripts/paper-method/train_ltsf.py --model DLinear --epochs 3
  python scripts/paper-method/train_ltsf.py --model Linear   --epochs 3
"""
import argparse
import hashlib
import importlib.util
import json
import os
import platform
import sys
import time
from datetime import datetime

import numpy as np


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = os.path.join(ROOT, "third_party", "LTSF-Linear-0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6")
DATA_DIR = os.path.join(ROOT, "data")          # 内含 ETTm2.csv
OUT_ROOT = os.path.join(ROOT, "lab-models")
OFFICIAL_SHA = "0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6"
OFFICIAL_SCRIPT = "scripts/EXP-LongForecasting/Linear/ettm2.sh"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def split_facts():
    """写出与官方 DataLoader 完全一致的边界（含 -seq_len 的历史重叠），并附日期。"""
    import csv
    import io

    rows = list(csv.reader(io.open(os.path.join(DATA_DIR, "ETTm2.csv"), encoding="utf-8")))
    dates = [r[0] for r in rows[1:]]
    n = len(dates)
    seq_len = 336
    b1 = [0, 12 * 30 * 24 * 4 - seq_len, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4 - seq_len]
    b2 = [12 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 8 * 30 * 24 * 4]
    names = ["train", "val", "test"]
    out = {"total_rows": n, "official_borders": {}, "dates": {}}
    for i, name in enumerate(names):
        lo = max(0, b1[i])
        hi = min(n, b2[i])
        out["official_borders"][name] = {"border1": b1[i], "border2": b2[i], "used": [lo, hi], "used_len": hi - lo}
        out["dates"][name] = {"start": dates[lo] if lo < n else None, "end": dates[hi - 1] if hi <= n else dates[-1]}
    out["note"] = (
        "官方 borders 来自 data_provider/data_loader.py 的 Dataset_ETT_minute："
        "border1s=[0, 12*30*24*4-seq_len, 12*30*24*4+4*30*24*4-seq_len]，border2s=[34560, 46080, 80640]。"
        "test 的 border2=80640 超过实际行数，因此官方实际用到数据末尾（" + str(n) + " 行）。"
    )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="DLinear", choices=["DLinear", "Linear"])
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=0.001)
    ap.add_argument("--seq-len", type=int, default=336)
    ap.add_argument("--pred-len", type=int, default=96)
    ap.add_argument("--seed", type=int, default=2024)
    ap.add_argument("--features", default="M", choices=["M", "S", "MS"])
    ap.add_argument("--run-id", default=None)
    args = ap.parse_args()

    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))

    sys.path.insert(0, REPO)
    from data_provider.data_loader import Dataset_ETT_minute  # 官方数据与划分

    model_mod = load_module("official_" + args.model, os.path.join(REPO, "models", f"{args.model}.py"))

    csv_path = os.path.join(DATA_DIR, "ETTm2.csv")
    data_hash = sha256_file(csv_path)
    run_id = args.run_id or f"{args.model}_ETTm2_OT_s{args.seq_len}_p{args.pred_len}_e{args.epochs}_seed{args.seed}"
    out_dir = os.path.join(OUT_ROOT, run_id)
    os.makedirs(out_dir, exist_ok=True)

    log_lines = []

    def log(msg):
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        log_lines.append(line)

    log(f"torch {torch.__version__}｜线程 {torch.get_num_threads()}｜模型 {args.model}（官方实现 {OFFICIAL_SHA[:8]}）")
    log(f"数据 {csv_path}｜sha256 {data_hash[:16]}…")

    size = [args.seq_len, args.seq_len // 2, args.pred_len]
    ds_train = Dataset_ETT_minute(root_path=DATA_DIR + os.sep, flag="train", size=size, features=args.features, data_path="ETTm2.csv", target="OT", scale=True, timeenc=0, freq="t")
    ds_val = Dataset_ETT_minute(root_path=DATA_DIR + os.sep, flag="val", size=size, features=args.features, data_path="ETTm2.csv", target="OT", scale=True, timeenc=0, freq="t")
    ds_test = Dataset_ETT_minute(root_path=DATA_DIR + os.sep, flag="test", size=size, features=args.features, data_path="ETTm2.csv", target="OT", scale=True, timeenc=0, freq="t")
    log(f"窗口数：train {len(ds_train)}｜val {len(ds_val)}｜test {len(ds_test)}（seq_len={args.seq_len}, pred_len={args.pred_len}, features={args.features}）")

    enc_in = 7 if args.features in ("M", "MS") else 1
    # 官方模型期望属性式配置（run_longExp.py 传的是 argparse.Namespace），这里保持一致
    import argparse as _ap

    model_cfg = _ap.Namespace(
        task_name="long_term_forecast",
        enc_in=enc_in,
        dec_in=enc_in,
        c_out=enc_in,
        seq_len=args.seq_len,
        label_len=args.seq_len // 2,
        pred_len=args.pred_len,
        individual=False,
        embed="timeF",
        freq="t",
        d_model=512,
        n_heads=8,
        e_layers=2,
        d_layers=1,
        d_ff=2048,
        factor=1,
        moving_avg=25,
        dropout=0.05,
        activation="gelu",
        output_attention=False,
    )
    model = model_mod.Model(model_cfg)
    n_params = sum(p.numel() for p in model.parameters())
    log(f"参数量：{n_params}")

    dl_train = DataLoader(ds_train, batch_size=args.batch, shuffle=True, drop_last=True)
    dl_val = DataLoader(ds_val, batch_size=args.batch, shuffle=False)
    dl_test = DataLoader(ds_test, batch_size=args.batch, shuffle=False)

    criterion = nn.MSELoss()
    optim = torch.optim.Adam(model.parameters(), lr=args.lr)

    epoch_times = []
    model.train()
    for ep in range(args.epochs):
        t0 = time.time()
        total = 0.0
        for batch_x, batch_y, batch_x_mark, batch_y_mark in dl_train:
            batch_x = batch_x.float()  # 官方 exp_main.py 也会在送入模型前转 float32
            batch_y = batch_y.float()
            optim.zero_grad()
            dec_inp = torch.zeros_like(batch_y[:, -args.pred_len:, :])
            dec_inp = torch.cat([batch_y[:, : args.seq_len // 2, :], dec_inp], dim=1)
            out = model(batch_x)  # 官方 exp_main.py：'Linear' 家族只接收 batch_x
            f_dim = -1 if args.features == "MS" else 0
            out = out[:, -args.pred_len:, f_dim:]
            tgt = batch_y[:, -args.pred_len:, f_dim:]
            loss = criterion(out, tgt)
            loss.backward()
            optim.step()
            total += loss.item()
        dt = time.time() - t0
        epoch_times.append(dt)
        log(f"epoch {ep + 1}/{args.epochs} 训练 MSE={total / max(1, len(dl_train)):.6f}｜耗时 {dt:.1f}s")
    train_seconds = float(sum(epoch_times))

    # 反标准化：官方调用 pred_data.inverse_transform(preds)（3-D 输入）。
    # 新版 sklearn 已不接受 3-D，这里用**完全等价**的手工换算：x_raw = x_std * scale_ + mean_（逐通道）。
    def inv(arr, dataset):
        mean = np.asarray(dataset.scaler.mean_)
        scale = np.asarray(dataset.scaler.scale_)
        return arr * scale.reshape(1, 1, -1) + mean.reshape(1, 1, -1)

    def evaluate(loader, tag):
        model.eval()
        preds = []
        trues = []
        with torch.no_grad():
            for batch_x, batch_y, batch_x_mark, batch_y_mark in loader:
                batch_x = batch_x.float()
                batch_y = batch_y.float()
                dec_inp = torch.cat(
                    [batch_y[:, : args.seq_len // 2, :], torch.zeros_like(batch_y[:, -args.pred_len:, :])], dim=1
                )
                out = model(batch_x)  # 官方 exp_main.py：'Linear' 家族只接收 batch_x
                f_dim = -1 if args.features == "MS" else 0
                preds.append(out[:, -args.pred_len:, f_dim:].numpy())
                trues.append(batch_y[:, -args.pred_len:, f_dim:].numpy())
        preds = np.concatenate(preds, axis=0)
        trues = np.concatenate(trues, axis=0)
        ds = ds_test if tag == "test" else ds_val
        preds_raw = inv(preds, ds)
        trues_raw = inv(trues, ds)
        def m(p, t):
            p = np.asarray(p).reshape(-1)
            t = np.asarray(t).reshape(-1)
            e = p - t
            return {
                "mae": float(np.mean(np.abs(e))),
                "mse": float(np.mean(e ** 2)),
                "rmse": float(np.sqrt(np.mean(e ** 2))),
                "nSamples": int(p.size),
            }

        # 官方 features=M 时评估覆盖全部 7 个通道；这里另外单独给出目标列 OT 的口径
        ot_pred = preds_raw[:, :, -1:]
        ot_true = trues_raw[:, :, -1:]
        return {
            "standardized": m(preds, trues),
            "raw": m(preds_raw, trues_raw),
            "rawOT": m(ot_pred.reshape(-1), ot_true.reshape(-1)),
            "rawPerChannelMAE": [float(np.mean(np.abs(preds_raw[:, :, c] - trues_raw[:, :, c]))) for c in range(preds_raw.shape[2])],
            "channels": ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
            "pred_raw_head": preds_raw[:3, :5].round(4).tolist(),
            "true_raw_head": trues_raw[:3, :5].round(4).tolist(),
        }

    val_metrics = evaluate(dl_val, "val")
    log(f"val（标准化空间）MAE={val_metrics['standardized']['mae']:.4f} MSE={val_metrics['standardized']['mse']:.4f}")

    t0 = time.time()
    test_metrics = evaluate(dl_test, "test")
    infer_seconds = time.time() - t0
    log(
        f"test（原始单位）MAE={test_metrics['raw']['mae']:.4f} MSE={test_metrics['raw']['mse']:.4f} "
        f"RMSE={test_metrics['raw']['rmse']:.4f}｜样本 {test_metrics['raw']['nSamples']}｜推理 {infer_seconds:.1f}s"
    )

    # ---------- 导出 ----------
    sd = model.state_dict()
    weights = {k: v.detach().numpy().tolist() for k, v in sd.items()}
    with open(os.path.join(out_dir, "weights.json"), "w", encoding="utf-8") as f:
        json.dump({"state_dict": weights, "meta": {"model": args.model, "seq_len": args.seq_len, "pred_len": args.pred_len, "enc_in": enc_in, "individual": False}}, f)
    torch.save(sd, os.path.join(out_dir, "weights.pt"))

    # 一致性对照样本：用测试集前 12 个窗口，导出输入/目标/预测（原始单位）
    parity = {"windows": [], "pred_len": args.pred_len, "seq_len": args.seq_len}
    with torch.no_grad():
        for i in range(min(12, len(ds_test))):
            x, y, xm, ym = ds_test[i]
            x = torch.as_tensor(np.asarray(x))
            y = torch.as_tensor(np.asarray(y))
            xb = x.unsqueeze(0).float()
            yb = y.unsqueeze(0).float()
            dec = torch.cat([yb[:, : args.seq_len // 2, :], torch.zeros_like(yb[:, -args.pred_len:, :])], dim=1)
            out = model(xb)  # 官方：'Linear' 家族只接收 batch_x
            f_dim = -1 if args.features == "MS" else 0
            pred = out[:, -args.pred_len:, f_dim:].numpy()
            truth = yb[:, -args.pred_len:, f_dim:].numpy()
            pred_raw = inv(pred, ds_test)
            truth_raw = inv(truth, ds_test)
            parity["windows"].append(
                {
                    "index": i,
                    "input_std": x.numpy().tolist(),
                    "target_std": truth[0].tolist(),
                    "pred_std": pred[0].tolist(),
                    "target_raw": truth_raw[0, :, 0].round(6).tolist(),
                    "pred_raw": pred_raw[0, :, 0].round(6).tolist(),
                }
            )
    with open(os.path.join(out_dir, "parity.json"), "w", encoding="utf-8") as f:
        json.dump(parity, f)

    # 标准化参数（来自训练段，Node 侧推理必须用同一套）
    scaler = {
        "mean": np.asarray(ds_train.scaler.mean_).tolist(),
        "scale": np.asarray(ds_train.scaler.scale_).tolist(),
        "targetIndex": -1,
        "note": "官方 StandardScaler，fit 在训练段（Dataset_ETT_minute 内部），标准化空间→原始单位用 x*scale+mean。",
    }
    with open(os.path.join(out_dir, "scaler.json"), "w", encoding="utf-8") as f:
        json.dump(scaler, f, ensure_ascii=False, indent=2)

    config = {
        "runId": run_id,
        "createdAt": datetime.now().isoformat(),
        "method": args.model,
        "methodSource": "official",  # 官方实现（未改写模型定义）
        "officialRepo": "https://github.com/cure-lab/LTSF-Linear",
        "officialSha": OFFICIAL_SHA,
        "officialScript": OFFICIAL_SCRIPT,
        "license": "MIT (LTSF-Linear 仓库 LICENSE)",
        "task": {"dataset": "ETTm2", "target": "OT", "features": args.features, "seqLen": args.seq_len, "predLen": args.pred_len, "encIn": enc_in},
        "hyper": {"epochs": args.epochs, "batch": args.batch, "lr": args.lr, "optim": "Adam", "loss": "MSE", "individual": False, "seed": args.seed},
        "data": {"file": "data/ETTm2.csv", "sha256": data_hash, "split": split_facts()},
        "env": {"python": platform.python_version(), "torch": torch.__version__, "threads": torch.get_num_threads(), "machine": platform.machine(), "cpuCount": os.cpu_count()},
        "timing": {"trainSeconds": round(train_seconds, 1), "epochSeconds": [round(x, 1) for x in epoch_times], "inferSeconds": round(infer_seconds, 1)},
        "params": n_params,
        "metrics": {"val": val_metrics, "test": test_metrics},
        "notes": [
            "训练轮数为本轮 CPU 实测可承受的规模，**少于**原论文的训练设置，因此属于「调整设置下的运行」。",
            "没有使用测试集做早停或选模；保存的是固定轮数后的最后一个 epoch。",
            "标准化统计量来自训练段（官方 StandardScaler，fit 在 train 上）。",
        ],
    }
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "run.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))

    log(f"已导出到 {out_dir}")
    print(json.dumps({"runId": run_id, "test_raw": test_metrics["raw"], "trainSeconds": round(train_seconds, 1), "inferSeconds": round(infer_seconds, 1)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
