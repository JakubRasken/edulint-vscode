const vscode = require('vscode')
const path = require('path')
const https = require('https')
const { promisify } = require('util')
const execFile = promisify(require('child_process').execFile)

// edulint's JSON output can get large, so don't rely on execFile's 1 MB default.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

// Coalesce bursts of open/save/editor-change events into one run.
const LINT_DEBOUNCE_MS = 150

// Reported when linting itself fails, mirroring the Thonny plug-in's placeholder.
const FAILURE_CODE = 'X000'

const PYTHON_EXTENSION_ID = 'ms-python.python'
const EDULINT_COMPAT_RANGE = 'edulint~=4.0'
const EXPLANATIONS_SNIPPET = 'import json, edulint; print(json.dumps(edulint.get_explanations()))'
const EDULINT_VERSION_SNIPPET = 'import importlib.metadata as m; print(m.version("edulint"))'

/** @type {vscode.LogOutputChannel} */
let log = null
/** @type {vscode.DiagnosticCollection} */
let diagnosticCollection = null

let runSeq = 0
/** @type {Map<string, {id: number, child: any}>} */
let inFlight = new Map()
/** @type {Map<string, NodeJS.Timeout>} */
let debounceTimers = new Map()

/** @type {Object<string, {summary: string}>} */
let explanations = null
let explanationsAttempted = false
let installPromptShown = false
let interpreterPromptShown = false

function config() {
  return vscode.workspace.getConfiguration('edulint')
}

/** Quote a value for safe use in a shell command line. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  log = vscode.window.createOutputChannel('EduLint', { log: true })
  log.info('Activating EduLint extension')

  diagnosticCollection = vscode.languages.createDiagnosticCollection('edulint')
  context.subscriptions.push(diagnosticCollection)

  context.subscriptions.push(
    vscode.commands.registerCommand('edulint.lint', lintCommand),
    vscode.commands.registerCommand('edulint.explain', showExplanation),
    vscode.commands.registerCommand('edulint.checkForUpdates', () => checkForUpdates(true)),
    vscode.commands.registerCommand('edulint.installEdulint', () => installEdulint()),
    vscode.languages.registerCodeActionsProvider('python', new ExplanationCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    })
  )

  if (vscode.window.activeTextEditor) {
    scheduleLint(vscode.window.activeTextEditor.document, 0)
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && shouldLintOn('active')) {
        scheduleLint(editor.document, LINT_DEBOUNCE_MS)
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (shouldLintOn('save')) {
        scheduleLint(doc, LINT_DEBOUNCE_MS)
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (shouldLintOn('open')) {
        scheduleLint(doc, LINT_DEBOUNCE_MS)
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearTimer(doc.uri.fsPath)
      cancelRun(doc.uri.fsPath)
      diagnosticCollection.delete(doc.uri)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('edulint')) {
        return
      }
      // settings may have changed the interpreter or explanations source
      explanations = null
      explanationsAttempted = false
      if (vscode.window.activeTextEditor) {
        scheduleLint(vscode.window.activeTextEditor.document, 0)
      }
    })
  )
}

function deactivate() {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  for (const filePath of Array.from(inFlight.keys())) {
    cancelRun(filePath)
  }
}

/** @param {'open'|'save'|'active'} trigger */
function shouldLintOn(trigger) {
  const mode = config().get('lintOn', 'all')
  if (mode === 'all') {
    return true
  }
  if (mode === 'openAndSave') {
    return trigger !== 'active'
  }
  return trigger === 'save'
}

function clearTimer(filePath) {
  const timer = debounceTimers.get(filePath)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(filePath)
  }
}

function scheduleLint(doc, delay) {
  if (!config().get('enable', true)) {
    return
  }
  const filePath = doc.uri.fsPath
  clearTimer(filePath)
  debounceTimers.set(
    filePath,
    setTimeout(() => {
      debounceTimers.delete(filePath)
      lintDocument(doc)
    }, delay)
  )
}

/** Cancel any in-flight edulint process for this file. */
function cancelRun(filePath) {
  const run = inFlight.get(filePath)
  if (run && run.child) {
    try {
      run.child.kill()
    } catch (err) {
      log.debug(`Could not kill previous edulint process: ${err}`)
    }
  }
  inFlight.delete(filePath)
}

async function lintCommand() {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'python') {
    vscode.window.showErrorMessage('Please run this command in a Python file (.py)')
    return
  }
  await lintDocument(editor.document)
  try {
    // Thonny shows a results panel; the closest equivalent is the Problems view
    await vscode.commands.executeCommand('workbench.actions.view.problems')
  } catch (err) {
    log.debug(`Could not open the Problems view: ${err}`)
  }
}

async function lintDocument(doc) {
  if (!config().get('enable', true) || doc.languageId !== 'python') {
    return
  }
  if (doc.uri.scheme !== 'file' || !doc.uri.fsPath) {
    log.info(`Skipping non-file document ${doc.uri.toString()}`)
    return
  }

  const filePath = doc.uri.fsPath
  const pythonPath = await resolveInterpreter(doc)
  if (!pythonPath) {
    log.error('No Python interpreter available')
    promptNoInterpreter()
    return
  }

  cancelRun(filePath)
  const id = ++runSeq
  const run = { id, child: null }
  inFlight.set(filePath, run)

  let childResolver = null
  const childReady = new Promise((resolve) => (childResolver = resolve))

  const args = buildArgs(filePath)
  log.debug(`Running: ${pythonPath} ${args.join(' ')}`)
  const result = await execCapture(pythonPath, args, (child) => {
    run.child = child
    childResolver()
  })
  await childReady

  // a newer run for this file superseded us
  const current = inFlight.get(filePath)
  if (!current || current.id !== id) {
    log.debug(`Discarding stale lint result for ${filePath}`)
    return
  }
  inFlight.delete(filePath)

  const stderr = (result.stderr || '').trim()
  if (stderr) {
    log.error(stderr)
  }

  if (!config().get('enable', true)) {
    return
  }

  if (/No module named ['"]?edulint/i.test(stderr)) {
    applyFailureDiagnostic(
      doc,
      'EduLint is not installed for the selected Python interpreter. Install it with: ' +
        `python -m pip install "${EDULINT_COMPAT_RANGE}"`
    )
    promptInstall(pythonPath)
    return
  }

  // edulint always prints JSON on a successful run, so empty stdout means it failed
  // (crashed interpreter, file deleted, unsupported Python version, ...).
  if (!result.stdout) {
    applyFailureDiagnostic(
      doc,
      'Linting failed. Try running EduLint again, or check the "EduLint" output channel.'
    )
    return
  }

  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (err) {
    log.error(`Could not parse edulint output: ${err}`)
    applyFailureDiagnostic(
      doc,
      'Linting failed. Try running EduLint again, or check the "EduLint" output channel.'
    )
    return
  }

  applyDiagnostics(doc, parsed)
  maybeLoadExplanations(pythonPath, doc)
}

function buildArgs(filePath) {
  const args = ['-m', 'edulint', 'check', '--json']
  if (config().get('disableVersionCheck', true)) {
    args.push('--disable-version-check')
  }
  const extra = config().get('extraArgs', [])
  if (Array.isArray(extra)) {
    args.push(...extra)
  }
  args.push(filePath)
  return args
}

/**
 * Run a command, resolving with stdout/stderr instead of rejecting, and hand the
 * child process to `onStart` so the caller can cancel it.
 */
function execCapture(command, args, onStart) {
  let child
  const promise = new Promise((resolve) => {
    child = execFile(command, args, { maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    )
  })
  if (onStart) {
    onStart(child)
  }
  return promise
}

function rangeFrom(problem) {
  // edulint reports 1-based columns; VS Code ranges are 0-based
  return new vscode.Range(
    problem.line - 1,
    (problem.column || 1) - 1,
    (problem.end_line || problem.line) - 1,
    (problem.end_column || problem.column || 1) - 1
  )
}

function severityFrom(problem) {
  // ib111.toml reuses the enabled_by field to indicate the severity
  return problem.enabled_by === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
}

function applyDiagnostics(doc, parsed) {
  const problems = (parsed && parsed.problems) || []
  const withExplanations = config().get('showExplanations', true)

  const diagnostics = problems.map((problem) => {
    const code = problem.code + (problem.symbol ? `:${problem.symbol}` : '')
    const diagnostic = new vscode.Diagnostic(rangeFrom(problem), problem.text || code, severityFrom(problem))
    diagnostic.code = code
    diagnostic.source = 'edulint'

    const explanation = withExplanations && explanations ? explanations[problem.code] : null
    if (explanation && explanation.summary) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(doc.uri, rangeFrom(problem)),
          explanation.summary
        ),
      ]
    }
    return diagnostic
  })

  diagnosticCollection.set(doc.uri, diagnostics)
  logSummary(doc, parsed, problems)
}

function applyFailureDiagnostic(doc, message) {
  const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Warning)
  diagnostic.code = FAILURE_CODE
  diagnostic.source = 'edulint'
  diagnosticCollection.set(doc.uri, [diagnostic])
}

function logSummary(doc, parsed, problems) {
  const counts = {}
  for (const problem of problems) {
    const enabler = problem.enabled_by || 'undetermined origin'
    counts[enabler] = (counts[enabler] || 0) + 1
  }
  const summary = Object.keys(counts).length
    ? Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')
    : 'no problems detected'

  const configs = (parsed && parsed.configs) || []
  let configName = 'unknown'
  if (configs.length === 1) {
    configName = configs[0]['config-file'] || 'unknown'
  } else if (configs.length > 1) {
    configName = `${configs.length} configurations`
  }

  log.info(`Summary: ${summary} (configuration: ${configName}) [${path.basename(doc.fileName)}]`)
}

async function resolveInterpreter(doc) {
  const configured = (config().get('pythonPath', '') || '').trim()
  if (configured) {
    return configured
  }

  const pythonExtension = vscode.extensions.getExtension(PYTHON_EXTENSION_ID)
  if (!pythonExtension) {
    return null
  }
  if (!pythonExtension.isActive) {
    await pythonExtension.activate()
  }
  const pythonAPI = pythonExtension.exports
  if (!pythonAPI) {
    return null
  }

  try {
    const details = await pythonAPI.settings.getExecutionDetails(doc ? doc.uri : undefined)
    // Newer Python extensions return { execCommand: [...] }, older ones expose the path directly.
    if (details) {
      if (Array.isArray(details.execCommand) && details.execCommand.length > 0) {
        return details.execCommand[0]
      }
      if (details.path) {
        return details.path
      }
    }
  } catch (err) {
    log.error(`Could not determine Python interpreter: ${err}`)
  }
  return null
}

/** Lazily fetch edulint's explanation database (code -> why + examples). */
function maybeLoadExplanations(pythonPath, doc) {
  if (!config().get('showExplanations', true) || explanations || explanationsAttempted) {
    return
  }
  explanationsAttempted = true

  execCapture(pythonPath, ['-c', EXPLANATIONS_SNIPPET]).then((result) => {
    try {
      const raw = JSON.parse(result.stdout)
      explanations = {}
      for (const [code, entry] of Object.entries(raw)) {
        const summary = plainExplanation(entry)
        if (summary) {
          explanations[code] = { summary }
        }
      }
      log.info(`Loaded ${Object.keys(explanations).length} EduLint explanations`)
      // re-run so the explanations show up on the results we just produced
      if (doc) {
        scheduleLint(doc, 0)
      }
    } catch (err) {
      log.error(`Could not load EduLint explanations: ${err}`)
      explanations = null
    }
  })
}

function plainExplanation(entry) {
  if (!entry) {
    return ''
  }
  const parts = []
  if (entry.why) {
    parts.push(String(entry.why).trim())
  }
  if (entry.examples) {
    // keep the example code, drop the markdown fences
    parts.push(String(entry.examples).trim().replace(/```[a-zA-Z]*\n?/g, ''))
  }
  return parts.join('\n\n')
}

async function showExplanation(code) {
  const explanation = explanations && explanations[code]
  const body = explanation && explanation.summary ? explanation.summary : `No explanation available for ${code}.`
  const markdown = ['# EduLint: ' + code, '', body, ''].join('\n')
  const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' })
  await vscode.window.showTextDocument(doc, { preview: true })
}

class ExplanationCodeActionProvider {
  provideCodeActions(document, range, context) {
    const actions = []
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'edulint') {
        continue
      }
      const raw = typeof diagnostic.code === 'string' ? diagnostic.code : diagnostic.code && diagnostic.code.value
      const code = String(raw || '').split(':')[0]
      if (!code || !explanations || !explanations[code]) {
        continue
      }
      const action = new vscode.CodeAction(`EduLint: explain ${code}`, vscode.CodeActionKind.QuickFix)
      action.diagnostics = [diagnostic]
      action.command = { command: 'edulint.explain', title: 'Show explanation', arguments: [code] }
      actions.push(action)
    }
    return actions
  }
}

function promptNoInterpreter() {
  if (interpreterPromptShown) {
    return
  }
  interpreterPromptShown = true
  vscode.window
    .showWarningMessage(
      'EduLint: no Python interpreter. Install the Python extension, or set "edulint.pythonPath" to an interpreter that has edulint installed.',
      'Install Python extension',
      'Open Settings'
    )
    .then((choice) => {
      interpreterPromptShown = false
      if (choice === 'Install Python extension') {
        vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-python.python')
      } else if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'edulint.pythonPath')
      }
    })
}

function promptInstall(pythonPath) {
  if (installPromptShown) {
    return
  }
  installPromptShown = true
  vscode.window
    .showWarningMessage('EduLint is not installed for the selected Python interpreter.', 'Install edulint', 'Show interpreter')
    .then((choice) => {
      installPromptShown = false
      if (choice === 'Install edulint') {
        installEdulint(pythonPath)
      } else if (choice === 'Show interpreter') {
        log.show()
      }
    })
}

function installEdulint(pythonPath) {
  return pipInTerminal(pythonPath, [`${EDULINT_COMPAT_RANGE}`])
}

async function upgradeEdulint(pythonPath) {
  return pipInTerminal(pythonPath, [`${EDULINT_COMPAT_RANGE}`])
}

async function pipInTerminal(pythonPath, packages) {
  let interpreter = pythonPath
  if (!interpreter) {
    interpreter = await resolveInterpreter()
  }
  if (!interpreter) {
    vscode.window.showErrorMessage('EduLint: no Python interpreter available.')
    return
  }
  const terminal =
    vscode.window.terminals.find((t) => t.name === 'EduLint') || vscode.window.createTerminal('EduLint')
  terminal.show()
  terminal.sendText(
    `${shellQuote(interpreter)} -m pip install --upgrade ${packages.map(shellQuote).join(' ')}`
  )
}

async function checkForUpdates(interactive) {
  const pythonPath = await resolveInterpreter()
  if (!pythonPath) {
    if (interactive) {
      vscode.window.showWarningMessage('EduLint: no Python interpreter available.')
    }
    return
  }

  const versionResult = await execCapture(pythonPath, ['-c', EDULINT_VERSION_SNIPPET])
  const installed = (versionResult.stdout || '').trim()

  if (!installed) {
    vscode.window
      .showWarningMessage('EduLint is not installed for the selected Python interpreter.', 'Install edulint')
      .then((choice) => {
        if (choice === 'Install edulint') {
          installEdulint(pythonPath)
        }
      })
    return
  }

  let latest
  try {
    const data = await httpsGetJson('https://pypi.org/pypi/edulint/json')
    latest = data.info.version
  } catch (err) {
    if (interactive) {
      vscode.window.showWarningMessage(`EduLint: could not reach PyPI (${err.message})`)
    }
    return
  }

  if (isNewer(latest, installed)) {
    vscode.window
      .showInformationMessage(`EduLint ${latest} is available (you have ${installed}).`, 'Upgrade')
      .then((choice) => {
        if (choice === 'Upgrade') {
          upgradeEdulint(pythonPath)
        }
      })
  } else if (interactive) {
    vscode.window.showInformationMessage(`EduLint ${installed} is up to date.`)
  }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'edulint-vscode' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })
    request.on('error', reject)
  })
}

function isNewer(candidate, current) {
  const a = String(candidate).split('.').map((n) => parseInt(n, 10) || 0)
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] || 0
    const right = b[i] || 0
    if (left !== right) {
      return left > right
    }
  }
  return false
}

module.exports = {
  activate,
  deactivate,
}
