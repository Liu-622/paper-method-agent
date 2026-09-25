"""打印论文第 5 页 Table 2 中 ETTm2 一段的原始文本，用于抄录 DLinear/Linear 在 pred=96 的报告值"""
import io
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
data = json.load(io.open(os.path.join(ROOT, "papers", "DLinear-pages.json"), encoding="utf-8"))
page = next(p for p in data["pages"] if p["page"] == 5)
text = page["text"]
i = text.find("ETTm2")
while i != -1:
    print(f"--- offset {i} ---")
    print(text[max(0, i - 120) : i + 700])
    print()
    i = text.find("ETTm2", i + 1)
    if i > 60000:
        break
