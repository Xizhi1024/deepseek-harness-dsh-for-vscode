"""M0/M1 evidence: compare rc.1 and rc.2 @deepseek-ai trees file-by-file.

Usage: py -3.14 evidence/dsh020rc2/tools/compare-runtime-trees.py
Writes package-level diff summary and changed-file lists to evidence/dsh020rc2/.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone

RC1 = r"D:\Coding\.codex-staging\dsh-020rc1-runtime\node_modules\@deepseek-ai"
RC2 = r"C:\Users\MSI\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "m1-package-diff.json")


def walk(root: str) -> dict[str, str]:
    files: dict[str, str] = {}
    for base, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            with open(full, "rb") as handle:
                files[rel] = hashlib.sha256(handle.read()).hexdigest()
    return files


def main() -> None:
    rc1, rc2 = walk(RC1), walk(RC2)
    pk1: dict[str, dict[str, str]] = {}
    pk2: dict[str, dict[str, str]] = {}
    for tree, out in ((rc1, pk1), (rc2, pk2)):
        for rel, digest in tree.items():
            pkg, _, rest = rel.partition("/")
            out.setdefault(pkg, {})[rest] = digest
    names = sorted(set(pk1) | set(pk2))
    report = {"generated": datetime.now(timezone.utc).isoformat(), "rc1_root": RC1, "rc2_root": RC2, "packages": {}}
    summary = []
    for pkg in names:
        f1, f2 = pk1.get(pkg, {}), pk2.get(pkg, {})
        changed = sorted(k for k in set(f1) & set(f2) if f1[k] != f2[k])
        added = sorted(set(f2) - set(f1))
        removed = sorted(set(f1) - set(f2))
        same = len(set(f1) & set(f2)) - len(changed)
        if changed or added or removed:
            report["packages"][pkg] = {"changed": changed, "added_rc2": added, "removed_rc1": removed, "unchanged": same}
            summary.append((pkg, len(changed), len(added), len(removed), same))
    report["summary"] = [
        {"package": p, "changed": c, "added_rc2": a, "removed_rc1": r, "unchanged": s} for p, c, a, r, s in summary
    ]
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"{len(summary)} of {len(names)} packages differ; report: {OUT}")
    for row in sorted(summary, key=lambda x: -(x[1] + x[2] + x[3])):
        print(f"  {row[0]:45s} changed={row[1]:3d} added={row[2]:3d} removed={row[3]:3d} same={row[4]:3d}")


if __name__ == "__main__":
    main()
