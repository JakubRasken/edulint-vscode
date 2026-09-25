# EduLint for VS Code

Integrates [EduLint](https://github.com/GiraffeReversed/edulint) into VS Code.

This is a modified fork of [matousekm/edulint-vscode](https://github.com/matousekm/edulint-vscode).
See [License and attribution](#license-and-attribution) and [CHANGELOG.md](CHANGELOG.md).

## Usage

Whenever you open, save, or switch to a Python file, EduLint problems appear as squiggles and
in the Problems panel. Each problem carries edulint's explanation (why it matters, plus
examples) as related information, and an **EduLint: explain `<code>`** quick fix opens it in full.

You can also lint the current file explicitly:

- `EduLint: Run Linting` from the Command Palette
- `Cmd+Alt+L` / `Ctrl+Alt+L`
- the editor title button

## Requirements

- Microsoft Python Extension
- **Python 3.10 or newer** (see the note below)
- EduLint v4.x installed as a Python package

> **Python version:** edulint 4.3.1 declares `Requires-Python: >=3.8`, but on Python 3.9 it
> fails internally (`isinstance` with a `typing.Union`) and exits successfully with **no
> findings at all**. Use Python 3.10+.

Install edulint into the interpreter you use:

```sh
python3 -m pip install "edulint~=4.0"
```

If your project interpreter should not carry the linter, install edulint into a dedicated
environment and point the extension at it:

```sh
python3.12 -m venv ~/.venvs/edulint
~/.venvs/edulint/bin/python -m pip install "edulint~=4.0"
```

then set `edulint.pythonPath` to `~/.venvs/edulint/bin/python`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `edulint.enable` | `true` | Run EduLint analysis on Python files. |
| `edulint.pythonPath` | `""` | Interpreter used to run edulint. Empty means the interpreter selected by the Python extension. |
| `edulint.lintOn` | `"all"` | `save`, `openAndSave`, or `all` (open, save, and active editor change). |
| `edulint.extraArgs` | `[]` | Extra arguments appended to `edulint check`. |
| `edulint.disableVersionCheck` | `true` | Pass `--disable-version-check` so edulint does not query PyPI while linting. |
| `edulint.showExplanations` | `true` | Attach edulint's explanation to each problem. |

## Commands

- `EduLint: Run Linting` — analyse the current file and open the Problems view
- `EduLint: Check for Updates` — compare the installed edulint with PyPI
- `EduLint: Install edulint Package` — install edulint into the selected interpreter
- `EduLint: Show Explanation` — shown as a quick fix on an EduLint problem, not in the palette

## License and attribution

This repository is a **modified fork** of
[matousekm/edulint-vscode](https://github.com/matousekm/edulint-vscode), forked and modified on
2026-09-25. Details of what changed are in [CHANGELOG.md](CHANGELOG.md) and [NOTICE](NOTICE).

- The original code is copyright its authors (Martin Matoušek and contributors) and is
  licensed under the GNU General Public License v3.0.
- Modifications in this fork are copyright their author and are released under the same
  GNU General Public License v3.0, as required by section 5 of that licence.
- The icon (`assets/icon.png`) is the fork author's own artwork; it does not come from the
  upstream project.
- `EduLint` is the name of the upstream project (GiraffeReversed/edulint). This fork is not
  affiliated with or endorsed by the upstream authors or Masaryk University.

Because this is a derivative work of GPL-3.0 code, it can only be distributed under the
GPL-3.0; it cannot be relicensed.

## Resources

- [EduLint GitHub Repository](https://github.com/GiraffeReversed/edulint)
- [Microsoft Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python)
- [Python Releases](https://www.python.org/downloads/)
