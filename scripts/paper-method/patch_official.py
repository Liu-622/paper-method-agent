"""
对官方 LTSF-Linear 仓库做**最小兼容修改**（pandas 3.x）
==================================================================
官方代码的 timeenc==0 分支使用了 pandas 2 之前的写法：
    df_stamp.date.apply(lambda row: row.month, 1)   # 第二个参数旧语义是 convert_dtype
在 pandas 3.x 中它会变成传给 lambda 的位置参数 → TypeError。
本脚本只做两处等价改写（不改变语义）：
    1) .apply(lambda row: row.X, 1)      ->  .apply(lambda row: row.X)
    2) .drop(['date'], 1)                ->  .drop(['date'], axis=1)
并留下 .orig 备份与 unified diff 记录，供审计。

用法： python scripts/paper-method/patch_official.py [--check]
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = os.path.join(ROOT, "third_party", "LTSF-Linear-0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6")
TARGET = os.path.join(REPO, "data_provider", "data_loader.py")
ORIG = TARGET + ".orig"
PATCH = os.path.join(ROOT, "third_party", "LTSF-Linear-compat.patch")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查是否仍有旧写法")
    args = ap.parse_args()

    with open(TARGET, encoding="utf-8") as f:
        src = f.read()

    remaining = re.findall(r"\.apply\(lambda row: .*, 1\)", src)
    if args.check:
        print(f"仍存在的旧写法：{len(remaining)}")
        for r in remaining[:5]:
            print("  ", r)
        return 0 if not remaining else 1

    if not os.path.exists(ORIG):
        with open(ORIG, "w", encoding="utf-8") as f:
            f.write(src)

    patched, n1 = re.subn(r"\.apply\(lambda row: (row\.[a-z]+\(\)|row\.[a-z]+), 1\)", r".apply(lambda row: \1)", src)
    patched, n2 = re.subn(r"\.drop\(\['date'\], 1\)", ".drop(['date'], axis=1)", patched)

    with open(TARGET, "w", encoding="utf-8") as f:
        f.write(patched)

    with open(PATCH, "w", encoding="utf-8") as f:
        f.write(
            subprocess.run(
                ["git", "diff", "--no-index", ORIG, TARGET], capture_output=True, text=True, cwd=REPO
            ).stdout
            or f"--- {ORIG}\n+++ {TARGET}\n(无差异)\n"
        )
    left = len(re.findall(r"\.apply\(lambda row: .*, 1\)", patched))
    print(f"兼容修改完成：apply 改写 {n1} 处，drop 改写 {n2} 处，剩余旧写法 {left} 处")
    print(f"备份：{ORIG}")
    print(f"补丁记录：{PATCH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
