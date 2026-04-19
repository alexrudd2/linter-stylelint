'use strict';

// This script runs in a plain Node.js child process (not Electron's renderer),
// so dynamic import() works fine for ESM packages like stylelint v17.

const path = require('node:path');

// Cache of loaded stylelint instances keyed by resolved path
const stylelintCache = new Map();

async function getStylelint(stylelintPath) {
  if (stylelintCache.has(stylelintPath)) {
    return stylelintCache.get(stylelintPath);
  }
  // stylelint v16+ is ESM - use dynamic import()
  // For older CJS versions, import() still works (returns the module)
  const mod = await import(stylelintPath);
  const instance = mod.default ?? mod;
  stylelintCache.set(stylelintPath, instance);
  return instance;
}

function setModulesDir(modulesDir) {
  if (modulesDir) {
    process.env.NODE_PATH = modulesDir;
    // eslint-disable-next-line no-underscore-dangle
    require('node:module').Module._initPaths();
  }
}

async function handleResolve(job) {
  const { stylelintPath, stylelintOptions, checkIgnored } = job;
  setModulesDir(job.modulesDir);

  const stylelint = await getStylelint(stylelintPath);

  // Resolve config
  let foundConfig = null;
  if (stylelintOptions.codeFilename) {
    try {
      const config = await stylelint.resolveConfig(stylelintOptions.codeFilename);
      if (config) {
        foundConfig = { config, filepath: null };
      }
    } catch (e) {
      if (!/No configuration provided for .+/.test(e.message)) {
        return { type: 'config-error', message: e.message };
      }
      // No config found - foundConfig stays null
    }
  }

  // Check if file is ignored
  if (checkIgnored && stylelintOptions.codeFilename) {
    let fileIsIgnored = false;
    try {
      fileIsIgnored = await stylelint.isPathIgnored(stylelintOptions.codeFilename);
    } catch (e) {
      // ignore
    }
    if (fileIsIgnored) {
      return { type: 'ignored' };
    }
  }

  if (foundConfig) {
    return { type: 'config', config: foundConfig };
  }

  return { type: 'no-config' };
}

async function handleLint(job) {
  const { stylelintPath, stylelintOptions } = job;
  setModulesDir(job.modulesDir);

  const stylelint = await getStylelint(stylelintPath);

  let data;
  try {
    data = await stylelint.lint(stylelintOptions);
  } catch (error) {
    if (error.line) {
      return {
        type: 'lint-error',
        reason: error.reason || error.message,
        line: error.line,
        column: error.column
      };
    }
    return {
      type: 'error',
      message: error.reason || error.message
    };
  }

  const raw = data.results.shift();

  // Extract only plain serializable data from the PostCSS result object.
  const warnings = typeof raw.warnings === 'function' ? raw.warnings() : (raw.warnings || []);

  const result = {
    warnings: warnings.map((w) => ({
      rule: w.rule,
      text: w.text,
      severity: w.severity,
      line: w.line,
      column: w.column,
      endLine: w.endLine,
      endColumn: w.endColumn
    })),
    invalidOptionWarnings: raw.invalidOptionWarnings || [],
    deprecations: raw.deprecations || [],
    ignored: raw.ignored || false
  };

  // v17 API: fixed code is returned as data.code
  const fixedText = stylelintOptions.fix ? (data.code ?? null) : null;

  return {
    type: 'lint-result',
    result,
    fixedText
  };
}

// Read newline-delimited JSON messages from stdin
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  // eslint-disable-next-line no-cond-assign
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ id: null, type: 'error', message: `Invalid JSON: ${e.message}` })}\n`);
      continue;
    }

    const { id, action } = msg;
    const handler = action === 'lint' ? handleLint : handleResolve;
    handler(msg).then((result) => {
      process.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
    }).catch((err) => {
      process.stdout.write(`${JSON.stringify({ id, type: 'error', message: err.message })}\n`);
    });
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

// Signal readiness
process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
