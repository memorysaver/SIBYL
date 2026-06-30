#!/usr/bin/env python3
"""Inner worker for apply_forge.sh. Not called directly by the user.

Reads the full forge-prompt output from stdin, extracts and parses the
`## Structured summary` YAML block, and applies the consolidations,
new_skills, and prunings to the host project's skill target directory.

Argv: <root> <target_dir> <journal_file> <dry_run "0"|"1">
"""

from __future__ import annotations

import datetime
import hashlib
import os
import re
import shutil
import sys

try:
    import yaml
except ImportError:
    sys.exit("apply_forge requires python3 with PyYAML (pip install pyyaml).")


def main() -> int:
    if len(sys.argv) != 5:
        sys.exit("usage: _apply_forge_inner.py <root> <target_dir> <journal_file> <dry_run>")
    root, target_dir, journal_file, dry_run_str = sys.argv[1:5]
    dry_run = dry_run_str == "1"

    raw = sys.stdin.read()

    m = re.search(r"^##\s+Structured\s+summary\s*$", raw, re.M)
    if not m:
        sys.exit("No '## Structured summary' heading in input.")
    after = raw[m.end():]
    fence = re.search(r"^```ya?ml\s*$([\s\S]*?)^```\s*$", after, re.M)
    if not fence:
        sys.exit("No fenced ```yaml ... ``` block under '## Structured summary'.")
    data = yaml.safe_load(fence.group(1)) or {}

    now_iso = datetime.datetime.now().isoformat(timespec="seconds")

    def journal_line(action: str, *paths: str) -> None:
        line = "\t".join([action, *paths])
        print("  " + line)
        if not dry_run:
            with open(journal_file, "a") as f:
                f.write(line + "\n")

    def write_file(path: str, content: str) -> None:
        if dry_run:
            print(f"  [dry-run] would write {path}")
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)

    def sha256_body(text: str) -> str:
        parts = text.split("---", 2)
        body = parts[2] if len(parts) >= 3 else text
        return hashlib.sha256(body.encode()).hexdigest()

    # --- 1) consolidations ---
    for c in (data.get("consolidations") or []):
        target_skill = c["target_skill"]
        skill_root = os.path.join(target_dir, target_skill)
        if not os.path.isdir(skill_root):
            print(f"SKIP consolidation: target skill {target_skill!r} not found at {skill_root}")
            continue
        ref_path = os.path.join(skill_root, "references", c["references_filename"])
        if os.path.exists(ref_path):
            print(f"SKIP consolidation: references file already exists at {ref_path}")
            continue
        fm = {
            "type": "lesson-distillation",
            "source_lessons": c["source_lessons"],
            "forged_at": now_iso,
            "summary": c["summary"],
        }
        body = "---\n" + yaml.safe_dump(fm, sort_keys=False) + "---\n\n"
        body += f"# {c['summary']}\n\n"
        body += c.get("rationale", "") + "\n\n"
        body += "## Source lessons\n\n"
        for sl in c["source_lessons"]:
            body += f"- `{sl}`\n"
        write_file(ref_path, body)
        journal_line("APPEND_REF", ref_path)

    # --- 2) new_skills ---
    for n in (data.get("new_skills") or []):
        name = n["name"]
        new_root = os.path.join(target_dir, name)
        if os.path.exists(new_root):
            print(f"SKIP new_skill: directory already exists at {new_root}")
            continue
        fm = {
            "name": name,
            "description": n["description"].strip(),
            "license": "Apache-2.0",
            "version": "0.1.0",
            "metadata": {
                "origin": "memory-forge",
                "origin_hash": "PLACEHOLDER",
                "source_lessons": n["source_lessons"],
                "forged_at": now_iso,
                "decay_after_days": 90,
                "pinned": False,
            },
        }
        skill_md_text = (
            "---\n"
            + yaml.safe_dump(fm, sort_keys=False)
            + "---\n\n"
            + n["skill_body"].strip()
            + "\n"
        )
        final_hash = sha256_body(skill_md_text)
        skill_md_text = skill_md_text.replace(
            "origin_hash: PLACEHOLDER", f"origin_hash: {final_hash}", 1
        )

        skill_md_path = os.path.join(new_root, "SKILL.md")
        write_file(skill_md_path, skill_md_text)
        journal_line("CREATE_SKILL", new_root)

        for r in (n.get("initial_references") or []):
            ref_path = os.path.join(new_root, "references", r["filename"])
            if os.path.exists(ref_path):
                continue
            fm_r = {
                "type": "lesson-distillation",
                "source_lessons": r["source_lessons"],
                "forged_at": now_iso,
                "summary": r["summary"],
            }
            body = "---\n" + yaml.safe_dump(fm_r, sort_keys=False) + "---\n\n"
            body += f"# {r['summary']}\n\n"
            body += "## Source lessons\n\n"
            for sl in r["source_lessons"]:
                body += f"- `{sl}`\n"
            write_file(ref_path, body)

    # --- 3) prunings ---
    for p in (data.get("prunings") or []):
        src = os.path.join(target_dir, p["source_skill"])
        if not os.path.isdir(src):
            print(f"SKIP prune: source skill {src} does not exist")
            continue
        src_skill_md = os.path.join(src, "SKILL.md")
        if not os.path.isfile(src_skill_md):
            print(f"SKIP prune: {src_skill_md} missing")
            continue
        with open(src_skill_md) as f:
            text = f.read()
        parts = text.split("---", 2)
        if len(parts) < 3:
            print(f"SKIP prune: {src_skill_md} has no frontmatter")
            continue
        fm = yaml.safe_load(parts[1]) or {}
        meta = fm.get("metadata") or {}
        if meta.get("origin") != "memory-forge":
            print(f"SKIP prune: {src} is not memory-forge-origin (origin={meta.get('origin')!r})")
            continue
        if meta.get("pinned"):
            print(f"SKIP prune: {src} is pinned")
            continue
        body = parts[2]
        current_hash = hashlib.sha256(body.encode()).hexdigest()
        if meta.get("origin_hash") and meta["origin_hash"] != current_hash:
            print(f"SKIP prune: {src} has been human-edited (origin_hash mismatch)")
            continue
        umbrella = os.path.join(target_dir, p["into_umbrella"])
        if not os.path.isdir(umbrella):
            print(f"SKIP prune: umbrella {umbrella} does not exist")
            continue
        dest = os.path.join(umbrella, "references", p["references_filename"])
        fm_r = {
            "type": "demoted-skill",
            "source_skill": p["source_skill"],
            "demoted_at": now_iso,
            "rationale": p.get("rationale", ""),
        }
        new_body = "---\n" + yaml.safe_dump(fm_r, sort_keys=False) + "---\n\n" + body.lstrip()
        write_file(dest, new_body)
        if not dry_run:
            shutil.rmtree(src)
        journal_line("PRUNE", src, dest)

    print(f"\nDone. Journal: {journal_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
