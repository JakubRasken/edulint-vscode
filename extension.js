const vscode = require('vscode')
const { promisify } = require('util')
const execFile = promisify(require('child_process').execFile)

/** @type {vscode.LogOutputChannel} */
let log = null

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  log = vscode.window.createOutputChannel('edulint', {log: true})
  log.info('Activating EduLint extension')

  const pythonExtension = vscode.extensions.getExtension('ms-python.python')
  if (!pythonExtension) {
    vscode.window.showErrorMessage('Python extension not found. Please install it.')
    return
  }
  if (!pythonExtension.isActive) {
    await pythonExtension.activate()
  }
  const pythonPath = await getPythonInterpreter()
  let disposable = vscode.commands.registerCommand('edulint.lint', function () {
    if (!pythonPath) {
      vscode.window.showErrorMessage('Python interpreter not found. Please configure Python in your workspace.')
      return
    }
    // check for already existing terminals
    const terminalMatchIndex = vscode.window.terminals.findIndex(
      (terminal) => terminal.name === 'edulint terminal'
    )
    let terminal
    if (terminalMatchIndex === -1) {
      terminal = vscode.window.createTerminal('edulint terminal')
    } else {
      terminal = vscode.window.terminals[terminalMatchIndex]
    }
    terminal.show()
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor || activeEditor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Please run this command in a Python file (.py)')
      return
    }
    const filePath = activeEditor.document.uri.fsPath
    terminal.sendText(
      `${pythonPath} -m edulint check "${filePath}"`
    )
  })

  context.subscriptions.push(disposable)

  let diagnosticCollection = vscode.languages.createDiagnosticCollection('edulint')
  context.subscriptions.push(diagnosticCollection)

  // Listen to active text editor changes and update diagnostics
  if (vscode.window.activeTextEditor) {
		updateDiagnosticCollection(vscode.window.activeTextEditor.document, diagnosticCollection);
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				updateDiagnosticCollection(editor.document, diagnosticCollection);
			}
		})
	);

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    updateDiagnosticCollection(doc, diagnosticCollection)
  }))

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    updateDiagnosticCollection(doc, diagnosticCollection)
  }))

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnosticCollection.delete(doc.uri)
  }))
}

async function getPythonInterpreter() {
  const pythonExtension = vscode.extensions.getExtension('ms-python.python')
  if (pythonExtension && pythonExtension.exports) {
    const pythonAPI = pythonExtension.exports
    try {
      const details = await pythonAPI.settings.getExecutionDetails()
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
  }
  return null
}

/**
 * @param {vscode.TextDocument} doc 
 * @param {vscode.DiagnosticCollection} diagCollection 
 */
async function updateDiagnosticCollection(doc, diagCollection) {
  if (doc.languageId !== 'python') {
    return
  }

  const diagnostics = []

  log.info(`Linting ${doc.fileName}`)
  const outp = await getEdulintOutput(doc.fileName)
  log.info(`Finished linting ${doc.fileName}, found ${outp.problems.length} problems`)
  log.debug(outp)

  const problems = outp.problems
  
  for (const problem of problems) {
    const diagnostic = {
      code: problem.code + (problem.symbol? `:${problem.symbol}` : ''),
      message: problem.text,
      // edulint reports 1-based columns; VS Code ranges are 0-based
      range: new vscode.Range(
        problem.line - 1,
        (problem.column || 1) - 1,
        (problem.end_line || problem.line) - 1,
        (problem.end_column || problem.column || 1) - 1
      ),
      // ib111.toml reuses the enabled_by field to indicate the severity
      severity: problem.enabled_by === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      source: 'edulint',
    }
    diagnostics.push(diagnostic)
  }

  diagCollection.set(doc.uri, diagnostics)
}

/**
 * @param {string} filePath 
 * @returns edulint's parsed json output
 */
async function getEdulintOutput(filePath) {
  const pythonPath = await getPythonInterpreter()
  if (!pythonPath) {
    log.error('python interpreter not set')
    return { problems: [] }
  }

  let out = {}
  try {
    out = await execFile(pythonPath, ['-m', 'edulint', 'check', '--json', filePath])
  } catch (err) {
    out.stdout = err.stdout
    out.stderr = err.stderr
  }
  if (out.stderr) {
    log.error(out.stderr)
  }
  if (!out.stdout) {
    return { problems: [] }
  }

  return JSON.parse(out.stdout)
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
}
