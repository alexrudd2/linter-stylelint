'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { generateRange } = require('atom-linter');
const requireResolve = require('resolve');

// Internal variables
let packagePath;
const resolvedPathsCache = new Map();

// Worker process state
let workerProcess = null;
let workerReady = false;
let pendingJobs = new Map(); // id -> { resolve, reject }
let jobIdCounter = 0;
let workerBuffer = '';

function startMeasure(baseName) {
  const markName = `${baseName}-start`;
  // Clear any similar start mark from previous runs
  if (performance.getEntriesByName(markName).length) {
    performance.clearMarks(markName);
  }
  performance.mark(markName);
}

function endMeasure(baseName) {
  if (atom.inDevMode()) {
    performance.mark(`${baseName}-end`);
    performance.measure(baseName, `${baseName}-start`, `${baseName}-end`);
    const duration = Math.round(performance.getEntriesByName(baseName)[0].duration * 10000) / 10000;
    // eslint-disable-next-line no-console
    console.log(`${baseName} took ${duration} ms`);
    performance.clearMarks(`${baseName}-end`);
    performance.clearMeasures(baseName);
  }
  performance.clearMarks(`${baseName}-start`);
}

function createRange(editor, data) {
  if (!data
    || (!Object.hasOwnProperty.call(data, 'line') && !Object.hasOwnProperty.call(data, 'column'))
  ) {
    // data.line & data.column might be undefined for non-fatal invalid rules,
    // e.g.: "block-no-empty": "foo"
    // Return a range encompassing the first line of the file
    return generateRange(editor);
  }

  return generateRange(editor, data.line - 1, data.column - 1);
}

function resolveAsync(request, options) {
  return new Promise((resolve, reject) => {
    requireResolve(request, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function getStylelintPath(projectDir) {
  if (resolvedPathsCache.has(projectDir)) {
    return resolvedPathsCache.get(projectDir);
  }
  let stylelintPath;
  try {
    stylelintPath = await resolveAsync('stylelint', { basedir: projectDir });
  } catch {
    // Fall back to bundled stylelint
    stylelintPath = require.resolve('stylelint');
  }
  resolvedPathsCache.set(projectDir, stylelintPath);
  return stylelintPath;
}

function getProjectDir(filePath) {
  if (!filePath) return null;
  const projectDir = atom.project.relativizePath(filePath)[0];
  return projectDir !== null ? projectDir : path.dirname(filePath);
}

function getModulesDir(stylelintPath) {
  return path.dirname(path.dirname(path.dirname(stylelintPath)));
}

// --- Worker process management ---

function handleWorkerMessage(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('linter-stylelint: invalid worker message:', line);
    return;
  }

  if (msg.type === 'ready') {
    workerReady = true;
    return;
  }

  const { id } = msg;
  if (id == null) return;

  const job = pendingJobs.get(id);
  if (!job) return;
  pendingJobs.delete(id);
  job.resolve(msg);
}

function ensureWorker() {
  if (workerProcess && !workerProcess.killed) {
    return workerProcess;
  }

  workerReady = false;
  workerBuffer = '';
  pendingJobs.clear();

  const nodeBin = atom.config.get('linter-stylelint.nodeBin') || 'node';
  const workerScript = path.join(__dirname, 'worker.cjs');

  workerProcess = spawn(nodeBin, [workerScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  workerProcess.stdout.setEncoding('utf8');
  workerProcess.stdout.on('data', (chunk) => {
    workerBuffer += chunk;
    let newlineIndex;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = workerBuffer.indexOf('\n')) !== -1) {
      const line = workerBuffer.slice(0, newlineIndex);
      workerBuffer = workerBuffer.slice(newlineIndex + 1);
      handleWorkerMessage(line);
    }
  });

  workerProcess.stderr.setEncoding('utf8');
  workerProcess.stderr.on('data', (data) => {
    // eslint-disable-next-line no-console
    console.error('linter-stylelint worker stderr:', data);
  });

  workerProcess.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.warn(`linter-stylelint: worker exited with code ${code}`);
    for (const [, job] of pendingJobs) {
      job.reject(new Error(`Worker exited with code ${code}`));
    }
    pendingJobs.clear();
    workerProcess = null;
    workerReady = false;
  });

  return workerProcess;
}

function sendToWorker(msg) {
  return new Promise((resolve, reject) => {
    const worker = ensureWorker();
    const id = jobIdCounter++;
    pendingJobs.set(id, { resolve, reject });

    const send = () => {
      try {
        worker.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
      } catch (e) {
        pendingJobs.delete(id);
        reject(e);
      }
    };

    if (workerReady) {
      send();
    } else {
      const deadline = Date.now() + 5000;
      const poll = setInterval(() => {
        if (workerReady) {
          clearInterval(poll);
          send();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          pendingJobs.delete(id);
          reject(new Error('linter-stylelint: worker failed to start within 5s'));
        }
      }, 20);
    }
  });
}

function killWorker() {
  if (workerProcess) {
    workerProcess.kill();
    workerProcess = null;
    workerReady = false;
  }
}

// --- Lint result parsing ---

const parseResults = (editor, results, filePath, showIgnored) => {
  startMeasure('linter-stylelint: Parsing results');
  if (!results) {
    endMeasure('linter-stylelint: Parsing results');
    endMeasure('linter-stylelint: Lint');
    return [];
  }

  const invalidOptions = results.invalidOptionWarnings.map((msg) => ({
    severity: 'error',
    excerpt: msg.text,
    location: {
      file: filePath,
      position: createRange(editor)
    }
  }));

  const warnings = results.warnings.map((warning) => {
    // Stylelint only allows 'error' and 'warning' as severity values
    const severity = !warning.severity || warning.severity === 'error' ? 'Error' : 'Warning';
    const message = {
      severity: severity.toLowerCase(),
      excerpt: warning.text,
      location: {
        file: filePath,
        position: createRange(editor, warning)
      }
    };

    const ruleParts = warning.rule.split('/');
    if (ruleParts.length === 1) {
      // Core rule
      message.url = `http://stylelint.io/user-guide/rules/${ruleParts[0]}`;
    } else {
      // Plugin rule
      const pluginName = ruleParts[0];
      const ruleName = ruleParts[1];

      const linterStylelintURL = 'https://github.com/AtomLinter/linter-stylelint/tree/master/docs';
      switch (pluginName) {
        case 'plugin':
          message.url = `${linterStylelintURL}/noRuleNamespace.md`;
          break;
        case 'scss':
          message.url = `https://github.com/kristerkari/stylelint-scss/blob/master/src/rules/${ruleName}/README.md`;
          break;
        case 'csstools':
          message.url = `https://github.com/csstools/stylelint-${ruleName}/blob/master/README.md`;
          break;
        case 'color-format':
          message.url = 'https://github.com/filipekiss/stylelint-color-format/blob/master/README.md';
          break;
        case 'scale-unlimited':
          message.url = 'https://github.com/AndyOGo/stylelint-declaration-strict-value/blob/master/README.md';
          break;
        default:
          message.url = `${linterStylelintURL}/linkingNewRule.md`;
      }
    }

    return message;
  });

  const deprecations = results.deprecations.map((deprecation) => ({
    severity: 'warning',
    excerpt: deprecation.text,
    url: deprecation.reference,
    location: {
      file: filePath,
      position: createRange(editor)
    }
  }));

  const ignored = [];
  if (showIgnored && results.ignored) {
    ignored.push({
      severity: 'warning',
      excerpt: 'This file is ignored',
      location: {
        file: filePath,
        position: createRange(editor)
      }
    });
  }

  const toReturn = []
    .concat(invalidOptions)
    .concat(warnings)
    .concat(deprecations)
    .concat(ignored);

  endMeasure('linter-stylelint: Parsing results');
  endMeasure('linter-stylelint: Lint');
  return toReturn;
};

async function resolveStylelintConfig(filePath, checkIgnored) {
  const stylelintPath = await getStylelintPath(getProjectDir(filePath));
  const modulesDir = getModulesDir(stylelintPath);

  return sendToWorker({
    action: 'resolve',
    stylelintPath,
    modulesDir,
    stylelintOptions: { codeFilename: filePath },
    checkIgnored
  });
}

const applyFixedStyles = async (editor, fixedText) => {
  if (fixedText !== null && fixedText !== editor.getText()) {
    // Save the cursor positions so that we can restore them after the `setText`,
    // which consolodates all cursors together into one at the end of the file.
    const bufferPositions = editor.getCursorBufferPositions();
    editor.setText(fixedText);
    bufferPositions.forEach((position, index) => {
      // Buffer positions are returned in order they were created, so we
      // want to restore them in order as well.
      if (index === 0) {
        // We'll have one cursor in the editor after the `setText`, so the first
        // one can just be a move
        editor.setCursorBufferPosition(position, { autoscroll: false });
      } else {
        // After that, we need to create new cursors
        editor.addCursorAtBufferPosition(position);
      }
    });
  }
};

const runStylelint = async (editor, stylelintOptions, filePath, settings) => {
  startMeasure('linter-stylelint: Stylelint');

  const stylelintPath = await getStylelintPath(getProjectDir(filePath));
  const modulesDir = getModulesDir(stylelintPath);

  let response;
  try {
    response = await sendToWorker({
      action: 'lint',
      stylelintPath,
      modulesDir,
      stylelintOptions
    });
  } catch (error) {
    endMeasure('linter-stylelint: Stylelint');
    atom.notifications.addError('Unable to run stylelint', {
      detail: error.message,
      dismissable: true
    });
    endMeasure('linter-stylelint: Lint');
    return [];
  }

  endMeasure('linter-stylelint: Stylelint');

  if (response.type === 'lint-error') {
    endMeasure('linter-stylelint: Lint');
    return [{
      severity: 'error',
      excerpt: response.reason,
      location: {
        file: filePath,
        position: createRange(editor, response)
      }
    }];
  }

  if (response.type === 'error') {
    // If we got here, stylelint found something really wrong with the
    // configuration, such as extending an invalid configuration
    atom.notifications.addError('Unable to run stylelint', {
      detail: response.message,
      dismissable: true
    });
    endMeasure('linter-stylelint: Lint');
    return [];
  }

  if (stylelintOptions.code !== editor.getText()) {
    // The editor contents have changed since the lint was requested, tell
    //   Linter not to update the results
    endMeasure('linter-stylelint: Lint');
    return null;
  }

  if (stylelintOptions.fix && response.fixedText != null) {
    await applyFixedStyles(editor, response.fixedText);
  }

  return parseResults(editor, response.result, filePath, settings.showIgnored);
};

function getDefaultConfig(customSyntax) {
  // stylelint-config-standard v40+ is ESM and resolved inside the worker.
  // Here we just return the extends reference and configBasedir so the
  // worker can resolve it relative to the package.
  if (!packagePath) {
    packagePath = atom.packages.resolvePackagePath('linter-stylelint');
  }
  const config = {
    extends: ['stylelint-config-standard'],
    configBasedir: packagePath
  };

  // SugarSS is not fully compatible with stylelint-config-standard
  if (customSyntax === 'sugarss') {
    config.rules = {
      'block-closing-brace-empty-line-before': null,
      'block-closing-brace-newline-after': null,
      'block-closing-brace-newline-before': null,
      'block-closing-brace-space-before': null,
      'block-opening-brace-newline-after': null,
      'block-opening-brace-space-after': null,
      'block-opening-brace-space-before': null,
      'declaration-block-semicolon-newline-after': null,
      'declaration-block-semicolon-space-after': null,
      'declaration-block-semicolon-space-before': null,
      'declaration-block-trailing-semicolon': null
    };
  }

  return config;
}

module.exports = {
  startMeasure,
  endMeasure,
  createRange,
  getStylelintPath,
  getProjectDir,
  resolveStylelintConfig,
  applyFixedStyles,
  runStylelint,
  getDefaultConfig,
  killWorker
};
