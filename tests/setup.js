const fs = require('fs');
const os = require('os');
const path = require('path');

// Every test run gets its own throwaway data dir so tests never write into the real ./data/*.json.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-monitor-test-'));
