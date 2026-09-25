# Change Log

All notable changes to the "edulint" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.4.1]

- Drop the hard `ms-python.python` extension dependency: it made VS Code disable this
  extension entirely when the Python extension was absent, even though `edulint.pythonPath`
  makes it optional
- When no interpreter can be resolved, show a one-time prompt offering to install the Python
  extension or open the `edulint.pythonPath` setting

## [0.4.0]

- Attach edulint's explanation (why it matters plus examples) to every reported problem, and add an "EduLint: explain <code>" quick fix that opens it in an editor
- Report linting failures in the Problems panel instead of failing silently (crashed interpreter, unparseable output, deleted file)
- Detect a missing `edulint` package and offer to install it
- Add `EduLint: Check for Updates`, comparing the installed edulint against PyPI
- Add settings: `edulint.enable`, `edulint.pythonPath`, `edulint.lintOn`, `edulint.extraArgs`, `edulint.disableVersionCheck`, `edulint.showExplanations`
- Add a keybinding (`cmd/ctrl+alt+l`) and an editor title button; "EduLint: Run Linting" now refreshes results and opens the Problems view
- Log the per-file summary and the edulint configuration that was used
- Cancel superseded runs and debounce bursts so stale results can't overwrite newer ones

## [0.3.2]

- Raise the child process output limit: a large run produced 5.1 MB of JSON, far past the 1 MB default, and the truncated output previously threw during parsing
- Treat unparseable edulint output as a failure instead of an unhandled rejection
- Quote interpreter and file paths in the pip/CLI terminal command, which broke for paths containing spaces or quotes

## [0.3.1]

- Use `execFile` with an argument array instead of interpolating paths into a shell string
- Tolerate both the current and older shapes of the Python extension's `getExecutionDetails()` result
- Convert edulint's 1-based columns into VS Code's 0-based range offsets
- Return an empty problem list when no interpreter is available

## [Unreleased]

- Initial release
