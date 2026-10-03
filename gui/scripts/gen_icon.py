#!/usr/bin/env python3
"""Regenerate platform and sidebar icons from the approved app-icon.png master.

The master is artwork; this script only packages it with the Tauri icon CLI.
"""
from pathlib import Path
import shutil
import subprocess


def main():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["npm", "run", "tauri", "--", "icon", "app-icon.png"], cwd=root, check=True)
    (root / "public").mkdir(exist_ok=True)
    shutil.copy2(root / "src-tauri/icons/128x128@2x.png", root / "public/mole-icon.png")


if __name__ == "__main__":
    main()
