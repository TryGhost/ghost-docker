const fs = require('fs');
const path = require('path');

// Hardcoded exclusions - add any default exclusions here
// Can be exact matches or prefixes (to exclude entire sections)
const HARDCODED_EXCLUSIONS = [
    // We don't want the database, server, logging, process or paths
    // entries since they're not relevant in Docker anymore
    'database',
    'server',
    'logging',
    'process',
    'paths',
    // We don't need URL or admin__url because the container owns them
    'url',
    'admin__url',
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    configFile: null,
    exclude: [],
    include: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude' && i + 1 < args.length) {
      options.exclude = args[i + 1].split(',').map(s => s.trim());
      i++; // Skip next argument
    } else if (args[i] === '--include' && i + 1 < args.length) {
      options.include = args[i + 1].split(',').map(s => s.trim());
      i++; // Skip next argument
    } else if (!args[i].startsWith('--')) {
      options.configFile = args[i];
    }
  }

  if (!options.configFile) {
    console.error('Usage: node config-to-env.js <config.json> [--exclude key1,key2] [--include key1,key2]');
    process.exit(1);
  }

  return options;
}

// Flatten nested JSON object to environment variable format
function flattenObject(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}__${key}` : key;

    if (value === null || value === undefined) {
      // Skip null/undefined values
      continue;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Recursively flatten nested objects
      Object.assign(result, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      // Convert arrays to JSON strings
      result[newKey] = JSON.stringify(value);
    } else if (typeof value === 'boolean') {
      // Convert booleans to lowercase strings
      result[newKey] = value.toString();
    } else {
      // Store primitive values as-is
      result[newKey] = value.toString();
    }
  }

  return result;
}

// Serialize a value for a Docker Compose env file.
//
// Compose interpolates dotenv values, including inside double quotes, so a
// literal `$` must be written `$$`. Values are always double quoted, which is
// the only encoding that can represent every value; see the encoding contract
// at the top of scripts/lib/env.sh.
function formatValue(value) {
  const text = String(value);
  let out = '';
  for (const c of text) {
    if (c === '\\') { out += '\\\\'; }
    else if (c === '"') { out += '\\"'; }
    else if (c === '$') { out += '$$'; }
    else if (c === '\n') { out += '\\n'; }
    else if (c === '\r') { out += '\\r'; }
    else if (c === '\t') { out += '\\t'; }
    else { out += c; }
  }
  return `"${out}"`;
}

// Main function
function main() {
  const options = parseArgs();

  // Read and parse config file
  let config;
  try {
    const configContent = fs.readFileSync(options.configFile, 'utf8');
    config = JSON.parse(configContent);
  } catch (error) {
    console.error(`Error reading config file: ${error.message}`);
    process.exit(1);
  }

  // Flatten the configuration
  const flattened = flattenObject(config);

  // Combine exclusions
  const allExclusions = new Set([...HARDCODED_EXCLUSIONS, ...options.exclude]);

  // Helper function to check if key matches any exclusion pattern
  function isExcluded(key, exclusions) {
    for (const exclusion of exclusions) {
      // Check for exact match
      if (key === exclusion) {
        return true;
      }
      // Check if key starts with exclusion pattern (prefix matching)
      // This allows excluding entire sections like 'database' or 'database__connection'
      if (key.startsWith(exclusion + '__')) {
        return true;
      }
    }
    return false;
  }

  // Filter and output environment variables
  for (const [key, value] of Object.entries(flattened)) {
    // If include list is specified, only include those keys
    if (options.include && !options.include.includes(key)) {
      continue;
    }

    // Skip excluded keys (with prefix matching)
    if (isExcluded(key, allExclusions)) {
      continue;
    }

    // Output in KEY="VALUE" format, ready for ghost.env
    console.log(`${key}=${formatValue(value)}`);
  }
}

// Run the script
if (require.main === module) {
  main();
}
