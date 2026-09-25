"""核对 data/ETTm2.csv 的真实行数、日期范围与字段数（本轮数据划分的关键前提）"""
import csv
import io
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
path = os.path.join(ROOT, "data", "ETTm2.csv")

with io.open(path, encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
nonempty = [l for l in lines if l.strip()]
print("文件字节数：", os.path.getsize(path))
print("split('\\n') 行数：", len(lines))
print("非空行数：", len(nonempty))

rows = list(csv.reader(io.open(path, encoding="utf-8")))
print("csv.reader 行数：", len(rows))
print("csv.reader 数据行数：", len(rows) - 1)

field_counts = {}
for r in rows[1:]:
    field_counts[len(r)] = field_counts.get(len(r), 0) + 1
print("每行字段数分布：", field_counts)

print("表头：", rows[0])
print("第 1 行数据：", rows[1][:2], "…")
print("最后一行数据：", rows[-1][:2], "…")
print("第 34561 行（train 边界）：", rows[34561][:2])
print("第 46081 行（val 边界）：", rows[46081][:2])
print("第 57600 行：", rows[57600][:2] if len(rows) > 57600 else "（超出）")
print("第 57601 行：", rows[57601][:2] if len(rows) > 57601 else "（超出）")

# 与 train_ltsf.py 中 split_facts() 完全相同的算法，确认边界
n = len(rows) - 1
seq_len = 336
b1 = [0, 12 * 30 * 24 * 4 - seq_len, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4 - seq_len]
b2 = [12 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 8 * 30 * 24 * 4]
print()
print("n =", n)
print("b1 =", b1)
print("b2 =", b2)
for i, name in enumerate(["train", "val", "test"]):
    lo, hi = max(0, b1[i]), min(n, b2[i])
    print(f"  {name}: used=[{lo}, {hi}) len={hi - lo} 日期 {rows[lo + 1][0]} → {rows[hi][0]}")
print("评估起点（test.border1 + seq_len） =", b1[2] + seq_len, "日期", rows[b1[2] + seq_len + 1][0])
